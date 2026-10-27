// @vitest-environment jsdom
/**
 * The composer's draft host picker: shown for an unsent draft of a linked
 * project, it lists every connected host; a host with a copy retargets the
 * draft at once, one without is asked with a dry run and gets its copy made
 * on pick, and one with no checkout is disabled with the host's note
 * under its name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";

type Draft = { id: string; environmentId: string; projectId: string | null; workspaceId: string | null; cwd: string; blocks: unknown[]; branch?: string };

const h = vi.hoisted(() => ({
  sessions: [] as Draft[],
  meta: null as unknown,
  projects: [] as ProjectMeta[],
  workspaces: [] as WorkspaceMeta[],
  environments: [] as { id: string; name: string }[],
  statuses: new Map<string, { transport: string }>(),
  ensure: vi.fn(),
}));

vi.mock("../lib/connection/status", () => ({
  useEnvironments: () => h.environments,
  useEnvironmentStatuses: () => h.statuses,
}));
vi.mock("../lib/tcserver/store", () => ({
  useSession: (id: string) => h.sessions.find((s) => s.id === id),
  useSessionMeta: () => h.meta,
  sessionStore: {
    mutate: (fn: (prev: Draft[]) => Draft[]) => {
      h.sessions = fn(h.sessions);
    },
  },
}));
vi.mock("../lib/tcserver/workspaces", () => ({
  useWorkspaceCatalog: () => ({ projects: h.projects, workspaces: h.workspaces }),
}));
vi.mock("../lib/projectHostChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/projectHostChoice")>()),
  ensureLinkedOn: (...args: unknown[]) => h.ensure(...args),
}));

import { DraftHostPicker } from "./DraftHostPicker";
import { loadLinkHosts } from "../lib/projectHostChoice";

const ws = (over: Partial<WorkspaceMeta>): WorkspaceMeta =>
  ({ id: "w", environmentId: "local", name: "temp-code", path: "/Users/me/temp-code", git: true, linkId: "wl_a", createdAt: 1, ...over }) as WorkspaceMeta;
const proj = (over: Partial<ProjectMeta>): ProjectMeta => ({
  id: "p-mac",
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
const boxCopy = proj({ id: "p-box", environmentId: "box", workspaceId: "w-box", cwd: "/srv/agents/work/temp-code" });

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  h.sessions = [{ id: "d", environmentId: "local", projectId: "p-mac", workspaceId: "w", cwd: "/Users/me/temp-code", blocks: [] }];
  h.meta = null;
  h.projects = [proj({}), boxCopy];
  h.workspaces = [ws({}), ws({ id: "w-box", environmentId: "box", path: "/srv/agents/work/temp-code" })];
  h.environments = [
    { id: "local", name: "This Mac" },
    { id: "box", name: "The box" },
    { id: "mini", name: "Mini" },
  ];
  h.statuses = new Map([
    ["local", { transport: "open" }],
    ["box", { transport: "open" }],
    ["mini", { transport: "open" }],
  ]);
  h.ensure.mockReset();
});
afterEach(cleanup);

const options = () => screen.getAllByRole("menuitemradio");
const option = (id: string) => document.querySelector(`[data-draft-host-option="${id}"]`) as HTMLElement;
const disabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

describe("DraftHostPicker", () => {
  it("shows only for an unsent draft of a linked project with two or more hosts", () => {
    const { container, rerender } = render(<DraftHostPicker sessionId="d" />);
    expect(container.querySelector("[data-draft-host-picker]")?.getAttribute("data-draft-host-picker")).toBe("local");
    h.sessions[0].blocks = [{}];
    rerender(<DraftHostPicker sessionId="d" />);
    expect(container.querySelector("[data-draft-host-picker]")).toBeNull();
    h.sessions[0].blocks = [];
    h.projects = [proj({ linkId: null }), boxCopy];
    rerender(<DraftHostPicker sessionId="d" />);
    expect(container.querySelector("[data-draft-host-picker]")).toBeNull();
    h.projects = [proj({}), boxCopy];
    h.environments = [h.environments[0]];
    rerender(<DraftHostPicker sessionId="d" />);
    expect(container.querySelector("[data-draft-host-picker]")).toBeNull();
  });

  it("lists every connected host, the draft's checked; a host with a copy takes the draft and is remembered", async () => {
    h.ensure.mockResolvedValue({ cwd: null, exists: false, project: null, note: "no checkout of temp-code" });
    h.statuses.set("mini", { transport: "offline" });
    render(<DraftHostPicker sessionId="d" />);
    fireEvent.click(screen.getByRole("button", { name: "Start on This Mac" }));
    await flush();
    expect(options().map((o) => o.getAttribute("data-draft-host-option"))).toEqual(["local", "box"]);
    expect(option("local").getAttribute("aria-checked")).toBe("true");
    // The box has a copy: no dry run asked of it.
    expect(h.ensure).not.toHaveBeenCalled();
    fireEvent.click(option("box"));
    expect(h.sessions[0]).toMatchObject({ environmentId: "box", projectId: "p-box", workspaceId: "w-box", cwd: "/srv/agents/work/temp-code" });
    expect(loadLinkHosts()).toEqual({ pl_a: "box" });
  });

  it("a host with no checkout is disabled with its note", async () => {
    h.ensure.mockResolvedValue({ cwd: null, exists: false, project: null, note: "no checkout of temp-code" });
    render(<DraftHostPicker sessionId="d" />);
    fireEvent.click(screen.getByRole("button", { name: "Start on This Mac" }));
    await flush();
    const [env, args, dryRun] = h.ensure.mock.calls[0];
    expect(env).toBe("mini");
    expect(args).toMatchObject({ projectLinkId: "pl_a", workspaceLinkId: "wl_a", name: "temp-code", callerProjectCwd: "/Users/me/temp-code" });
    expect(dryRun).toBe(true);
    expect(disabled(option("mini"))).toBe(true);
    expect(option("mini").querySelector("[data-draft-host-note]")?.textContent).toBe("no checkout of temp-code");
  });

  it("a host with a checkout but no copy gets one made on pick, and the draft moves into it", async () => {
    const made = proj({ id: "p-mini", environmentId: "mini", workspaceId: "w-mini", cwd: "/work/temp-code" });
    h.ensure.mockImplementation((_env: string, _args: unknown, dryRun?: boolean) =>
      Promise.resolve(dryRun ? { cwd: "/work/temp-code", exists: false, project: null, note: null } : { cwd: "/work/temp-code", exists: false, project: made, note: null }),
    );
    render(<DraftHostPicker sessionId="d" />);
    fireEvent.click(screen.getByRole("button", { name: "Start on This Mac" }));
    await flush();
    expect(disabled(option("mini"))).toBe(false);
    expect(option("mini").textContent).toContain("New copy");
    fireEvent.click(option("mini"));
    await flush();
    expect(h.ensure).toHaveBeenLastCalledWith("mini", expect.objectContaining({ projectLinkId: "pl_a" }));
    expect(h.sessions[0]).toMatchObject({ environmentId: "mini", projectId: "p-mini", workspaceId: "w-mini", cwd: "/work/temp-code" });
    expect(loadLinkHosts()).toEqual({ pl_a: "mini" });
  });
});
