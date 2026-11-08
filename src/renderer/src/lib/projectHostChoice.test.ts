// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMeta } from "./tcserver/types";

const h = vi.hoisted(() => ({
  open: new Set<string>(["local", "box"]),
  primary: "local",
  platforms: { local: "darwin", mini: "darwin", box: "linux" } as Record<string, string>,
  globalStartOn: undefined as "box" | "mac" | undefined,
}));
vi.mock("./hostPlatform", () => ({ platformOf: (id: string) => h.platforms[id] }));
vi.mock("./tcserver/workspaces", () => ({
  workspaceStore: {
    defaultsAt: (env: string, ws: string | null) =>
      env === h.primary && ws === null && h.globalStartOn
        ? { defaults: { provider: "claude", model: "", reasoning: "medium", permission: "edits", startOn: h.globalStartOn }, overridden: true }
        : undefined,
  },
}));
vi.mock("./connection/registry", () => ({
  registry: {
    get primaryEnvironmentId() {
      return h.primary;
    },
    statusOf: (id: string) => ({ transport: h.open.has(id) ? "open" : "offline" }),
    linkOf: () => ({ request: vi.fn() }),
  },
}));

import {
  chooseCopy,
  copiesOf,
  ensureLinkedArgs,
  newThreadContext,
  preferredHost,
  probeOf,
  startOnOf,
} from "./projectHostChoice";

const project = (over: Partial<ProjectMeta>): ProjectMeta => ({
  id: "p",
  environmentId: "local",
  workspaceId: "w",
  name: "temp-code",
  mode: "local",
  branch: null,
  cwd: "/Users/me/temp-code",
  archived: false,
  linkId: "pl_a",
  createdAt: 1,
  ...over,
});

const mac = project({ id: "p-mac" });
const box = project({ id: "p-box", environmentId: "box", workspaceId: "w-box", cwd: "/srv/agents/work/temp-code" });
const mini = project({ id: "p-mini", environmentId: "mini", workspaceId: "w-mini", cwd: "/work/temp-code" });

beforeEach(() => {
  localStorage.clear();
  h.open = new Set(["local", "box"]);
  h.primary = "local";
  h.globalStartOn = undefined;
});

describe("copiesOf", () => {
  it("every live copy of a link, none for an unlinked project", () => {
    const archived = project({ id: "old", environmentId: "mini", archived: true });
    const other = project({ id: "x", linkId: "pl_b" });
    expect(copiesOf([mac, box, archived, other], "pl_a").map((p) => p.id)).toEqual(["p-mac", "p-box"]);
    expect(copiesOf([mac, box], null)).toEqual([]);
  });
});

describe("chooseCopy", () => {
  const base = {
    copies: [mac, box],
    startOn: "box" as const,
    platformOf: (id: string) => h.platforms[id],
    connected: (id: string) => h.open.has(id),
  };

  it("the active pane's thread's host first, when that thread is in the project", () => {
    expect(chooseCopy({ ...base, active: { environmentId: "local", projectId: "p-mac" } })?.id).toBe("p-mac");
    expect(chooseCopy({ ...base, startOn: "mac", active: { environmentId: "box", projectId: "p-box" } })?.id).toBe("p-box");
    // A thread elsewhere does not decide.
    expect(chooseCopy({ ...base, active: { environmentId: "local", projectId: "unrelated" } })?.id).toBe("p-box");
  });

  it("else the host the setting names: the box is a host that is not a Mac, the Mac one that is", () => {
    expect(chooseCopy(base)?.id).toBe("p-box");
    expect(chooseCopy({ ...base, startOn: "mac" })?.id).toBe("p-mac");
    // Order of the copies does not matter.
    expect(chooseCopy({ ...base, copies: [box, mac], startOn: "mac" })?.id).toBe("p-mac");
  });

  it("else the other host with a copy, when the named host has none", () => {
    expect(chooseCopy({ ...base, copies: [mac, mini] })?.id).toBe("p-mac");
    expect(chooseCopy({ ...base, copies: [box], startOn: "mac" })?.id).toBe("p-box");
  });

  it("a host without a copy is never picked; an offline named host yields to a connected copy", () => {
    expect(chooseCopy({ ...base, copies: [mini] })).toBeUndefined();
    h.open = new Set(["local"]);
    expect(chooseCopy(base)?.id).toBe("p-mac");
    // With no other copy reachable, the named one stays the pick.
    h.open = new Set();
    expect(chooseCopy(base)?.id).toBe("p-box");
  });
});

describe("startOnOf", () => {
  it("the project's own value, else the global one, else the box", () => {
    expect(startOnOf([mac, box], undefined)).toBe("box");
    expect(startOnOf([mac, box], "mac")).toBe("mac");
    expect(startOnOf([{ ...mac, startOn: "mac", settingsUpdatedAt: 5 }, box], "box")).toBe("mac");
    expect(startOnOf([{ ...mac, startOn: null }, box], "mac")).toBe("mac");
  });

  it("the copy stamped last speaks for the link", () => {
    const follower = { ...mac, startOn: "mac" as const, settingsUpdatedAt: 1 };
    const home = { ...box, startOn: null, settingsUpdatedAt: 9 };
    expect(startOnOf([follower, home], "box")).toBe("box");
    expect(startOnOf([{ ...follower, settingsUpdatedAt: 10 }, home], "box")).toBe("mac");
  });
});

describe("newThreadContext", () => {
  const ctx = { projectId: "p-mac", workspaceId: "w", cwd: "/Users/me/temp-code" };

  it("starts a new thread on the box by default, on the thread on screen's host when it is in the project", () => {
    expect(newThreadContext(ctx, [mac, box], null)).toEqual({
      projectId: "p-box",
      workspaceId: "w-box",
      cwd: "/srv/agents/work/temp-code",
    });
    expect(newThreadContext(ctx, [mac, box], { environmentId: "local", projectId: "p-mac" })).toEqual(ctx);
  });

  it("follows Thread defaults, and a project's own setting over it", () => {
    h.globalStartOn = "mac";
    expect(newThreadContext(ctx, [mac, box], null).projectId).toBe("p-mac");
    expect(newThreadContext(ctx, [mac, { ...box, startOn: "box", settingsUpdatedAt: 3 }], null).projectId).toBe("p-box");
    expect(preferredHost([mac, box])).toBe("local");
  });

  it("leaves a project with one copy, an unlinked one and a loose chat alone", () => {
    expect(newThreadContext(ctx, [mac], { environmentId: "box", projectId: "p-box" })).toBe(ctx);
    expect(newThreadContext(ctx, [project({ id: "p-mac", linkId: null }), box], null)).toBe(ctx);
    const loose = { projectId: null, workspaceId: null, cwd: "~" };
    expect(newThreadContext(loose, [mac, box], null)).toBe(loose);
  });
});

describe("ensureLinkedArgs and probeOf", () => {
  it("builds the call from the caller's copy, and nothing before the linker stamped both rows", () => {
    expect(ensureLinkedArgs(mac, { linkId: "wl_a", path: "/Users/me/temp-code" })).toEqual({
      projectLinkId: "pl_a",
      workspaceLinkId: "wl_a",
      name: "temp-code",
      branch: null,
      mode: "local",
      callerWorkspacePath: "/Users/me/temp-code",
      callerProjectCwd: "/Users/me/temp-code",
    });
    expect(ensureLinkedArgs(mac, { linkId: null, path: "/x" })).toBeNull();
    expect(ensureLinkedArgs(project({ linkId: null }), { linkId: "wl_a", path: "/x" })).toBeNull();
  });

  it("a host with a copy or a checkout can take the thread; one with neither cannot, and says why", () => {
    expect(probeOf({ cwd: "/srv/x", exists: true, project: box, note: null })).toEqual({ state: "ready" });
    expect(probeOf({ cwd: "/srv/x", exists: false, project: null, note: null })).toEqual({ state: "ready" });
    expect(probeOf({ cwd: null, exists: false, project: null, note: "no checkout of temp-code under /srv/agents/work" })).toEqual({
      state: "none",
      note: "no checkout of temp-code under /srv/agents/work",
    });
  });
});
