// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry, type Environment, type EnvironmentStatus, type Link } from "../lib/connection";
import type { ServerPush, SessionMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { groupWorkspaceSessions } from "../lib/workspaceSessions";
import { mountProbe } from "../test/renderProbe";
import { ProjectRail } from "./ProjectRail";
import { ThreadList } from "./WorkspaceSessions";

/**
 * One workspace linked across this Mac and the box: the rail shows one row
 * for it under one "Workspaces" header, the sidebar one list of both hosts'
 * threads by recency, the row's status counts both copies' threads, and a
 * host whose link is down dims its own rows.
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

const ws = (id: string, path: string, environmentId: string, linkId: string | null): WorkspaceMeta =>
  ({ id, name: id, path, git: true, githubRepo: null, createdAt: 1, environmentId, linkId }) as WorkspaceMeta;
const WORKSPACES: WorkspaceMeta[] = [
  ws("w-mac", MAC_PATH, "local", "wl_tc"),
  ws("w-box", BOX_PATH, "env_box", "wl_tc"),
  ws("w-only", ONLY_BOX, "env_box", null),
];

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
  meta("mac-new", "local", "w-mac", 300, { status: "waiting" }),
  meta("box-old", "env_box", "w-box", 200, { status: "waiting" }),
];

class FakeLink implements Link {
  profile = "local" as const;
  connected = true;
  constructor(readonly environmentId: string) {}
  request<T>(method: string): Promise<T> {
    if (method === "workspace.list") return Promise.resolve(WORKSPACES.filter((w) => w.environmentId === this.environmentId) as T);
    if (method === "project.list") return Promise.resolve([] as T);
    if (method === "session.list") return Promise.resolve(METAS.filter((m) => m.environmentId === this.environmentId) as T);
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

describe("the linked workspace's thread rows", () => {
  const rows = () => groupWorkspaceSessions(METAS, [], WORKSPACES, ["w-mac", "w-box"], {}).chats;

  it("interleaves both hosts newest first", () => {
    pairHosts([LOCAL, BOX]);
    expect(rows().map((t) => t.id)).toEqual(["box-new", "mac-new", "box-old", "mac-old"]);
    probe = mountProbe(<ThreadList threads={rows()} actions={actions} className="" />);
    expect(probe.container.querySelectorAll("[data-host-offline]")).toHaveLength(0);
  });

  it("dims the down host's rows and leaves the others", () => {
    pairHosts([LOCAL, BOX], { env_box: status("offline") });
    probe = mountProbe(<ThreadList threads={rows()} actions={actions} className="" />);
    const dim = [...probe.container.querySelectorAll("[data-host-offline]")];
    expect(dim.map((row) => row.textContent?.match(/box-(new|old)/)?.[0])).toEqual(["box-new", "box-old"]);
    expect(dim.every((row) => row.className.includes("opacity-50"))).toBe(true);
  });

  it("never dims with one host", () => {
    pairHosts([LOCAL], { env_box: status("offline") });
    probe = mountProbe(<ThreadList threads={rows()} actions={actions} className="" />);
    expect(probe.container.querySelectorAll("[data-host-offline]")).toHaveLength(0);
  });
});

describe("the rail", () => {
  const RECENTS = [{ path: BOX_PATH, openedAt: 3 }, { path: MAC_PATH, openedAt: 2 }, { path: ONLY_BOX, openedAt: 1 }];
  async function mountRail(
    environments: Environment[],
    statuses: Record<string, EnvironmentStatus> = {},
    onSelectProject = (_: string) => {},
    { recents = RECENTS, onOpenProject = (_?: string) => {} }: { recents?: typeof RECENTS; onOpenProject?: (environmentId?: string) => void } = {},
  ) {
    pairHosts(environments, statuses);
    for (const e of environments) {
      workspaceStore.attach(new FakeLink(e.id));
      sessionStore.attach(new FakeLink(e.id));
    }
    await flush();
    probe = mountProbe(
      <ProjectRail
        cwd="~"
        recents={recents}
        onSelectProject={onSelectProject}
        onOpenProject={onOpenProject}
        onOpenChats={() => {}}
      />,
    );
    await probe.act(flush);
    return probe.container;
  }
  const workspaceRows = (root: HTMLElement) => [...root.querySelectorAll('nav[aria-label="Workspaces"] [data-rail-path]')];
  const rowNames = (root: HTMLElement) => workspaceRows(root).map((row) => row.querySelector("button")?.textContent ?? "");
  const headers = (root: HTMLElement) => [...root.querySelectorAll("nav [data-rail-heading]")].map((s) => s.textContent?.trim());

  it("shows one row for the linked workspace, led by this machine's copy, under one Workspaces header", async () => {
    const root = await mountRail([LOCAL, BOX]);
    expect(rowNames(root)).toEqual(["temp-code", "only-box"]);
    expect(headers(root)).toContain("Workspaces");
    expect(headers(root)).not.toContain("tempcode-box");
    expect(headers(root)).not.toContain("This Mac");
    // The lead row is this machine's folder.
    expect(workspaceRows(root)[0].getAttribute("data-rail-path")).toBe(MAC_PATH);
  });

  it("opens with Chats as the list's first row, with no Accounts heading", async () => {
    const root = await mountRail([LOCAL, BOX]);
    const list = root.querySelector('nav[aria-label="Workspaces"] .overflow-y-auto')!;
    expect(list.querySelector("button")?.textContent).toBe("Chats");
    expect(headers(root)).not.toContain("Accounts");
    // The rows themselves carry no title= (the word at the end is the status mark).
    expect(list.querySelector("[data-rail-row] > button[title]")).toBeNull();
  });

  it("selects a workspace from a click on its row, which the drag's pointer capture sends to the wrapper", async () => {
    const onSelect = vi.fn();
    const root = await mountRail([LOCAL, BOX], {}, onSelect);
    const [lead, other] = workspaceRows(root);
    fireEvent.click(lead);
    expect(onSelect).toHaveBeenCalledWith(MAC_PATH);
    fireEvent.click(other.querySelector("button")!);
    expect(onSelect).toHaveBeenLastCalledWith(ONLY_BOX);
    fireEvent.click(other.querySelector('[aria-label="Workspace options"]')!);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("counts both copies' threads on the row's status", async () => {
    const root = await mountRail([LOCAL, BOX]);
    const marks = [...root.querySelectorAll('[aria-label^="Needs you, "]')];
    expect(marks.map((c) => c.getAttribute("aria-label"))).toEqual(["Needs you, 2 threads"]);
  });

  it("gives the name the room: in a rail under 15rem the word goes and the glyph stays", async () => {
    const root = await mountRail([LOCAL, BOX]);
    const row = workspaceRows(root)[0] as HTMLElement;
    expect(row.className).toContain("@container/railrow");
    const word = row.querySelector('[aria-label^="Needs you, "] [data-slot="status-word"]')!;
    expect(word.className).toContain("@max-[15rem]/railrow:hidden");
    expect(word.previousElementSibling?.querySelector("svg")).toBeTruthy();
  });

  it("dims a row whose only host is down, not the linked one", async () => {
    const root = await mountRail([LOCAL, BOX], { env_box: status("offline") });
    const dim = [...root.querySelectorAll('nav[aria-label="Workspaces"] [data-host-offline]')];
    expect(dim.map((row) => row.querySelector("button")?.textContent)).toEqual(["only-box"]);
  });

  const addRow = (root: HTMLElement) =>
    [...root.querySelectorAll("nav [data-rail-row] button")].filter((b) => b.textContent === "Add workspace…");
  const headingAdd = (root: HTMLElement) => root.querySelector('nav button[aria-label="Add workspace"]');

  it("with no workspace, stands one Add workspace… row under a heading with no +", async () => {
    const onOpenProject = vi.fn();
    const root = await mountRail([LOCAL], {}, undefined, { recents: [], onOpenProject });
    expect(addRow(root)).toHaveLength(1);
    expect(headingAdd(root)).toBeNull();
    expect(root.textContent).not.toContain("No workspaces yet");
    fireEvent.click(addRow(root)[0]);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onOpenProject.mock.calls[0]).toEqual([undefined, "Add workspace"]);
  });

  it("with a workspace, the heading keeps its + and the row is gone", async () => {
    const root = await mountRail([LOCAL]);
    expect(addRow(root)).toHaveLength(0);
    expect(headingAdd(root)).not.toBeNull();
  });

  it("with every workspace pinned, the same, and no empty line", async () => {
    localStorage.setItem("monocode.projectRailPinned", JSON.stringify([MAC_PATH]));
    const root = await mountRail([LOCAL], {}, undefined, { recents: [{ path: MAC_PATH, openedAt: 2 }] });
    expect(headers(root)).toContain("Pinned");
    expect(addRow(root)).toHaveLength(0);
    expect(headingAdd(root)).not.toBeNull();
    expect(root.textContent).not.toContain("No workspaces yet");
  });
});
