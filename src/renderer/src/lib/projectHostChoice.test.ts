// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMeta } from "./tcserver/types";

const h = vi.hoisted(() => ({ open: new Set<string>(["local", "box"]), primary: "local" }));
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
  loadLinkHosts,
  newThreadContext,
  probeOf,
  rememberLinkHost,
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
  const base = { copies: [mac, box], remembered: undefined, primary: "local", connected: (id: string) => h.open.has(id) };

  it("the active pane's thread's host first, when that thread is in the project", () => {
    expect(chooseCopy({ ...base, active: { environmentId: "box", projectId: "p-box" }, remembered: "local" })?.id).toBe("p-box");
    // A thread elsewhere does not decide.
    expect(chooseCopy({ ...base, active: { environmentId: "box", projectId: "unrelated" } })?.id).toBe("p-mac");
  });

  it("else the host last used for the link, while it has a copy", () => {
    expect(chooseCopy({ ...base, remembered: "box" })?.id).toBe("p-box");
    expect(chooseCopy({ ...base, remembered: "gone" })?.id).toBe("p-mac");
  });

  it("else this machine with a copy, else the first connected host with one", () => {
    expect(chooseCopy(base)?.id).toBe("p-mac");
    expect(chooseCopy({ ...base, copies: [mini, box] })?.id).toBe("p-box");
    expect(chooseCopy({ ...base, copies: [mini] })).toBeUndefined();
  });
});

describe("the remembered hosts", () => {
  it("round-trip per link id and survive a broken store", () => {
    expect(loadLinkHosts()).toEqual({});
    rememberLinkHost("pl_a", "box");
    rememberLinkHost("pl_b", "local");
    expect(loadLinkHosts()).toEqual({ pl_a: "box", pl_b: "local" });
    localStorage.setItem("monocode.linkHosts", "{nope");
    expect(loadLinkHosts()).toEqual({});
  });
});

describe("newThreadContext", () => {
  const ctx = { projectId: "p-mac", workspaceId: "w", cwd: "/Users/me/temp-code" };

  it("moves a new thread onto the chosen copy", () => {
    expect(newThreadContext(ctx, [mac, box], { environmentId: "box", projectId: "p-box" })).toEqual({
      projectId: "p-box",
      workspaceId: "w-box",
      cwd: "/srv/agents/work/temp-code",
    });
    rememberLinkHost("pl_a", "box");
    expect(newThreadContext(ctx, [mac, box], null).projectId).toBe("p-box");
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
