// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry, type Environment, type EnvironmentStatus, type Link } from "../lib/connection";
import type { ServerPush } from "../lib/tcserver/types";
import type { SessionMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { groupWorkspaceSessions } from "../lib/workspaceSessions";
import { mountProbe } from "../test/renderProbe";
import { ProjectRail } from "./ProjectRail";
import { ThreadList } from "./WorkspaceSessions";

/**
 * One project checked out on this Mac and on the box: the rail shows one
 * row for it, the sidebar one list of both hosts' threads, and only the
 * box's rows carry the quiet host mark.
 */

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });
const LOCAL = env("local", "This Mac");
const BOX = env("env_box", "tempcode-box");

const status = (transport: EnvironmentStatus["transport"]): EnvironmentStatus => ({
  transport,
  fresh: transport === "open",
  lastHello: null,
  lastError: null,
  nextRetryAt: null,
  route: null,
  attempts: 0,
});

const MAC_PATH = "/Users/landon/IdeaProjects/temp-code";
const BOX_PATH = "/srv/agents/work/temp-code";
const ONLY_BOX = "/srv/agents/work/only-box";

const ws = (id: string, path: string, environmentId: string): WorkspaceMeta =>
  ({ id, name: id, path, git: true, githubRepo: null, createdAt: 1, environmentId }) as WorkspaceMeta;
const WORKSPACES: WorkspaceMeta[] = [ws("w-mac", MAC_PATH, "local"), ws("w-box", BOX_PATH, "env_box"), ws("w-only", ONLY_BOX, "env_box")];

const meta = (id: string, environmentId: string, workspaceId: string, updatedAt: number, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId,
    id,
    parentId: null,
    projectId: null,
    workspaceId,
    threadType: "chat",
    title: id,
    cwd: WORKSPACES.find((w) => w.id === workspaceId)!.path,
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt,
    ...extra,
  }) as SessionMeta;

const METAS = [
  meta("mac-old", "local", "w-mac", 100),
  meta("box-new", "env_box", "w-box", 400),
  meta("mac-new", "local", "w-mac", 300),
  meta("box-old", "env_box", "w-box", 200),
];

class FakeLink implements Link {
  profile = "local" as const;
  connected = true;
  constructor(readonly environmentId: string) {}
  request<T>(method: string): Promise<T> {
    if (method === "workspace.list") return Promise.resolve(WORKSPACES.filter((w) => w.environmentId === this.environmentId) as T);
    if (method === "project.list") return Promise.resolve([] as T);
    return Promise.resolve(null as T);
  }
  onPush(_listener: (push: ServerPush) => void): () => void {
    return () => {};
  }
  onOpen(): () => void {
    return () => {};
  }
  onClose(): () => void {
    return () => {};
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function pairHosts(environments: Environment[], statuses: Record<string, EnvironmentStatus> = {}) {
  vi.spyOn(registry, "environmentsSnapshot").mockReturnValue(environments);
  const map = new Map(environments.map((e) => [e.id, statuses[e.id] ?? status("open")] as const));
  vi.spyOn(registry, "statuses").mockReturnValue(map);
  vi.spyOn(registry, "statusOf").mockImplementation((id) => map.get(id) ?? status("offline"));
}

const actions = { activeSessionId: undefined, onOpen: () => {}, onRename: () => {}, onDelete: () => {}, openMenu: () => {} };

let probe: ReturnType<typeof mountProbe> | null = null;
afterEach(() => {
  probe?.unmount();
  probe = null;
  sessionStore.reset();
  workspaceStore.reset();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the merged project's thread rows", () => {
  const rows = () => groupWorkspaceSessions(METAS, [], WORKSPACES, ["w-mac", "w-box"], {}).chats;

  it("interleaves both hosts newest first and marks only the box's rows, named on hover", () => {
    pairHosts([LOCAL, BOX]);
    const threads = rows();
    expect(threads.map((t) => t.id)).toEqual(["box-new", "mac-new", "box-old", "mac-old"]);
    probe = mountProbe(<ThreadList threads={threads} actions={actions} className="" />);
    const marks = [...probe.container.querySelectorAll("[data-host-mark]")];
    expect(marks.map((m) => m.getAttribute("data-host-mark"))).toEqual(["env_box", "env_box"]);
    expect(marks.every((m) => m.getAttribute("title") === "On tempcode-box")).toBe(true);
    expect(marks.every((m) => m.textContent === "")).toBe(true);
    expect(probe.container.querySelectorAll("[data-host-trouble]")).toHaveLength(0);
    const marked = marks.map((m) => m.closest('[role="button"]')?.textContent ?? "");
    expect(marked.every((text) => text.startsWith("box-"))).toBe(true);
  });

  it("tints the mark and says so when that host is offline", () => {
    pairHosts([LOCAL, BOX], { env_box: status("offline") });
    probe = mountProbe(<ThreadList threads={rows()} actions={actions} className="" />);
    const marks = [...probe.container.querySelectorAll("[data-host-mark]")];
    expect(marks).toHaveLength(2);
    expect(marks.every((m) => m.getAttribute("data-host-trouble") === "offline")).toBe(true);
    expect(marks[0].getAttribute("title")).toBe("tempcode-box: offline");
  });

  it("shows no mark at all with one host paired", () => {
    pairHosts([LOCAL]);
    probe = mountProbe(<ThreadList threads={rows()} actions={actions} className="" />);
    expect(probe.container.querySelectorAll("[data-host-mark]")).toHaveLength(0);
  });
});

describe("the rail", () => {
  async function mountRail(environments: Environment[], statuses: Record<string, EnvironmentStatus> = {}) {
    pairHosts(environments, statuses);
    for (const e of environments) workspaceStore.attach(new FakeLink(e.id));
    await flush();
    probe = mountProbe(
      <ProjectRail
        cwd="~"
        recents={[{ path: MAC_PATH, openedAt: 2 }, { path: BOX_PATH, openedAt: 3 }, { path: ONLY_BOX, openedAt: 1 }]}
        onSelectProject={() => {}}
        onOpenProject={() => {}}
      />,
    );
    await probe.act(flush);
    return probe.container;
  }
  const rowNames = (root: HTMLElement) =>
    [...root.querySelectorAll('nav[aria-label="Workspaces"] button[aria-current], nav[aria-label="Workspaces"] [title="Workspace options"]')]
      .map((b) => b.parentElement?.querySelector("button")?.textContent ?? "");

  it("shows one row for the project on both hosts and one for the box-only workspace, nothing about hosts", async () => {
    const root = await mountRail([LOCAL, BOX]);
    expect(rowNames(root)).toEqual(["temp-code", "only-box"]);
    expect(root.querySelectorAll("[data-host-trouble]")).toHaveLength(0);
    // One list, not one section per host.
    const headers = [...root.querySelectorAll("nav span.uppercase")].map((s) => s.textContent?.trim());
    expect(headers).toContain("Workspaces");
    expect(headers).not.toContain("tempcode-box");
  });

  it("marks the row when one of its hosts is offline", async () => {
    const root = await mountRail([LOCAL, BOX], { env_box: status("offline") });
    const dots = [...root.querySelectorAll("[data-host-trouble]")];
    expect(dots.map((d) => d.getAttribute("title"))).toEqual(["tempcode-box: offline", "tempcode-box: offline"]);
  });

  it("splits the rows by host again with Group by Host on", async () => {
    localStorage.setItem("monocode.railGroupByHost", "1");
    const root = await mountRail([LOCAL, BOX]);
    expect(rowNames(root)).toEqual(["temp-code", "temp-code", "only-box"]);
    const headers = [...root.querySelectorAll("nav span.uppercase")].map((s) => s.textContent?.trim());
    expect(headers).toContain("This Mac");
    expect(headers).toContain("tempcode-box");
  });
});
