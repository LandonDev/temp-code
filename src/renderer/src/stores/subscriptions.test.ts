import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaf, newFileTab, newTab, newTerminalFile, type WorkspaceTab } from "../lib/layout";
import { loadSelectedProject, saveLastSession, saveSelectedProject } from "../lib/projectContext";
import { newSession, type Session } from "../lib/session";
import { markSessionSeen, pruneLastSeen } from "../lib/sessionSeen";
import { listSessionsByProject, saveWorkspaceSnapshot } from "../lib/sessionStore";
import { withDockOpen } from "../lib/projectTerminal";
import { environment, environmentStore } from "./environment";
import { focus, focusStore, initialFocusState } from "./focus";
import { initialShellState, shell, shellStore } from "./shell";
import { createWorkspace } from "../lib/tcserver/projects";
import { sessionStore } from "../lib/tcserver/store";
import type { ProjectMeta, SessionMeta, WorkspaceCatalog } from "../lib/tcserver/types";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { PARK_MS } from "../lib/warmTabs";
import { migrateWorkspaces } from "../lib/workspaceMigration";
import { forgetHarnessSession, refreshHarnessCatalogs } from "../lib/harness";
import { nativeModelId, resetHarnessModelOverlays, setHarnessModels } from "../lib/models";
import { pickerModelId } from "../lib/tcserver/store";
import { agentModelsFor } from "../lib/tcserver/catalog";
import { CATALOG } from "../../../shared/catalog";
import { lastProjectPath } from "../lib/recents";
import { registry } from "../lib/connection";
import { invoke } from "../lib/native";
import { initialProjectState, project, projectStore } from "./project";
import {
  installActiveSessionSync,
  installAutosave,
  installBootTasks,
  installHistoryRefresh,
  installLayoutSync,
  installIdleSweep,
  installWarmSet,
  installSubscriptions,
  installTerminalIsolation,
  installVisitSettling,
  skipForgetSessionIds,
} from "./subscriptions";
import { initialTerminalsState, terminals, terminalsStore } from "./terminals";
import { initialWorkspaceTabsState, workspace, workspaceTabsStore } from "./workspace";
import { workspaceActions } from "./workspaceActions";
import { rebaseToWorkspace } from "../lib/projectContext";
import { copiesOf } from "../lib/projectHostChoice";
import { filterTabsForProjectId, workspaceTabCwd } from "../lib/workspaceTabGroups";
import { looksLikeProject, normalizeProjectPath } from "../lib/recents";

vi.mock("../lib/harness", () => ({
  forgetHarnessSession: vi.fn(() => Promise.resolve()),
  isLiveHarness: (harness: string) => harness === "claude",
  probeHarnessAvailability: vi.fn(() => Promise.resolve()),
  refreshHarnessCatalogs: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/models")>();
  // The bare stand-ins model the shape: "old" normalizes to "new" (same
  // native model), "unknown" is not in the catalog, so it falls back to the
  // default. Every other id goes through the real resolver.
  const standIns = new Set(["old", "new", "unknown", "default", "kept"]);
  const isReal = (id: string) => !standIns.has(id);
  return {
    ...actual,
    resolveModel: (harness: string, model: string) =>
      isReal(model)
        ? actual.resolveModel(harness as "claude", model)
        : { id: model === "old" ? "new" : model === "unknown" ? "default" : model },
    nativeModelId: (model: { id: string } | string) => {
      const id = typeof model === "string" ? model : model.id;
      if (isReal(id)) return actual.nativeModelId(model as never);
      return id === "old" || id === "new" ? "native" : id;
    },
    mergeModelSettings: (_resolved: unknown, settings?: Record<string, string>) => settings ?? {},
  };
});
vi.mock("../lib/native", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/appLifecycle", () => ({ isAppQuitting: () => false }));
vi.mock("../lib/sessionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessionStore")>()),
  saveWorkspaceSnapshot: vi.fn(() => Promise.resolve()),
  listSessionsByProject: vi.fn(() => Promise.resolve([])),
  subscribeSessionHistory: vi.fn(() => () => {}),
}));
vi.mock("../lib/sessionSeen", () => ({ markSessionSeen: vi.fn(), pruneLastSeen: vi.fn() }));
vi.mock("../lib/workspaceMigration", () => ({ migrateWorkspaces: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/tcserver/projects", () => ({
  createWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../lib/projectContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/projectContext")>()),
  loadSelectedProject: vi.fn(() => null),
  saveSelectedProject: vi.fn(),
  saveLastSession: vi.fn(),
}));
vi.mock("../lib/recents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/recents")>()),
  loadArchivedProjects: vi.fn(() => []),
  rememberProject: vi.fn(() => []),
  lastProjectPath: vi.fn((): string | null => "/repo"),
}));

function tab(id: string, over: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return { ...newTab(`s-${id}`), id, ...over };
}

function session(id: string, over: Partial<Session> = {}): Session {
  return { ...newSession("local", "claude", "/repo"), id, ...over };
}

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local",
    id: "s-a",
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: null,
    planPath: null,
    provider: "claude",
    model: "claude-sonnet-5-5",
    reasoning: "medium",
    agentType: "implementer",
    title: "claude",
    cwd: "/repo",
    status: "idle",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
    ultrafast: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 7,
    ...over,
  } as SessionMeta;
}

function projectMeta(id: string, over: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    environmentId: "local",
    id,
    workspaceId: "w1",
    name: id,
    cwd: "/repo",
    mode: "root",
    archived: false,
    ...over,
  } as ProjectMeta;
}

function catalog(over: Partial<WorkspaceCatalog> = {}): WorkspaceCatalog {
  return {
    workspaces: [],
    projects: [],
    icons: new Map(),
    defaults: new Map(),
    loaded: true,
    ...over,
  } as WorkspaceCatalog;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const microtasks = () => Promise.resolve().then(() => Promise.resolve());

function setTabs(tabs: WorkspaceTab[], activeTabId = tabs[0]?.id ?? "") {
  workspaceTabsStore.setState(initialWorkspaceTabsState(tabs, activeTabId), true);
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  sessionStore.reset();
  workspaceStore.reset();
  projectStore.setState(initialProjectState({ projectCwd: "/repo" }), true);
  terminalsStore.setState(initialTerminalsState(), true);
  focusStore.setState(initialFocusState(), true);
  shellStore.setState(initialShellState(), true);
  environment.reset();
  setTabs([]);
  skipForgetSessionIds.clear();
  vi.clearAllMocks();
  vi.mocked(loadSelectedProject).mockImplementation(() => null);
  vi.spyOn(registry, "primary").mockReturnValue({
    environmentId: "local", connected: true, profile: "local",
    request: () => Promise.resolve(null),
    onPush: () => () => {}, onOpen: () => () => {}, onClose: () => () => {},
  } as unknown as ReturnType<typeof registry.primary>);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const visits = () => workspaceTabsStore.getState().visits;

describe("installVisitSettling", () => {
  it("records visits once the callback's writes have settled", async () => {
    setTabs([tab("a"), tab("b"), tab("c")], "a");
    teardown = installVisitSettling();
    expect(workspaceTabsStore.getState().visits.current).toBe("a");
    workspace.setActiveTabId("b");
    expect(workspaceTabsStore.getState().visits.current).toBe("a");
    await microtasks();
    expect(visits()).toEqual({ back: ["a"], forward: [], current: "b" });
  });

  it("treats a close and the activation that follows as one step", async () => {
    setTabs([tab("a"), tab("b"), tab("c")], "a");
    teardown = installVisitSettling();
    workspace.setActiveTabId("c");
    await microtasks();
    workspace.setTabs((tabs) => tabs.filter((t) => t.id !== "c"));
    workspace.setActiveTabId("b");
    await microtasks();
    expect(visits()).toEqual({ back: ["a"], forward: [], current: "b" });
  });

  it("does not record a step taken from the trail", async () => {
    setTabs([tab("a"), tab("b")], "a");
    teardown = installVisitSettling();
    workspace.setActiveTabId("b");
    await microtasks();
    expect(workspace.visitBack()).toBe("a");
    workspace.setActiveTabId("a");
    await microtasks();
    expect(visits()).toEqual({ back: [], forward: ["b"], current: "a" });
    expect(workspaceTabsStore.getState().visitFromHistory).toBe(false);
  });
});

describe("installTerminalIsolation", () => {
  it("moves terminals out of file panes at install and after a write", async () => {
    const file = newFileTab("/repo/a.ts");
    const terminal = newTerminalFile("/repo", "zsh");
    const mixed = (id: string) =>
      tab(id, { editorPanes: [{ id: `e-${id}`, files: [file, terminal], activeFileId: file.id }] });
    setTabs([mixed("a")]);
    teardown = installTerminalIsolation();
    expect(workspaceTabsStore.getState().tabs[0].editorPanes[0].files).toEqual([file]);
    workspace.setTabs((tabs) => [...tabs, mixed("b")]);
    await microtasks();
    const b = workspaceTabsStore.getState().tabs[1];
    expect(b.editorPanes[0].files).toEqual([file]);
    expect(b.terminalPanes.flatMap((pane) => pane.files)).toEqual([terminal]);
  });

  it("leaves a clean tab list alone", async () => {
    setTabs([tab("a")]);
    teardown = installTerminalIsolation();
    const before = workspaceTabsStore.getState();
    workspace.setTabs((tabs) => tabs);
    await microtasks();
    expect(workspaceTabsStore.getState()).toBe(before);
  });
});

describe("installWarmSet", () => {
  it("mounts the active tab on activation and unmounts parked tabs outside the warm set after PARK_MS", () => {
    vi.useFakeTimers();
    setTabs([tab("a"), tab("b"), tab("c"), tab("d")]);
    teardown = installWarmSet();
    expect(workspaceTabsStore.getState().mountedTabIds).toEqual(["a"]);
    for (const id of ["b", "c", "d"]) {
      workspace.setActiveTabId(id);
      workspace.settleVisits();
    }
    expect(workspaceTabsStore.getState().mountedTabIds).toEqual(["a", "b", "c", "d"]);
    vi.advanceTimersByTime(PARK_MS - 1);
    expect(workspaceTabsStore.getState().mountedTabIds).toEqual(["a", "b", "c", "d"]);
    vi.advanceTimersByTime(1);
    expect(workspaceTabsStore.getState().mountedTabIds).toEqual(["b", "c", "d"]);
    vi.useRealTimers();
  });

  it("drops a closed tab from the mounted set and tears down its timer", () => {
    vi.useFakeTimers();
    setTabs([tab("a"), tab("b")]);
    teardown = installWarmSet();
    workspace.setActiveTabId("b");
    workspace.settleVisits();
    workspace.setTabs((tabs) => tabs.filter((t) => t.id !== "a"));
    expect(workspaceTabsStore.getState().mountedTabIds).toEqual(["b"]);
    teardown();
    teardown = null;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("installIdleSweep", () => {
  it("drops hidden idle sessions one task later, never inside the store's notification", async () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a"), session("s-hidden")]);
    teardown = installIdleSweep();
    expect(sessionStore.getSnapshot()).toHaveLength(2);
    await microtasks();
    expect(sessionStore.getSnapshot()).toHaveLength(2);
    await flush();
    expect(sessionStore.getSnapshot().map((s) => s.id)).toEqual(["s-a"]);
    expect(forgetHarnessSession).toHaveBeenCalledWith("claude", "s-hidden");
  });

  it("keeps busy and shielded sessions, and sweeps again when the tabs change", async () => {
    setTabs([tab("a"), tab("b")]);
    sessionStore.mutate([
      session("s-a"),
      session("s-b"),
      session("s-busy", { busy: true }),
      session("s-held"),
    ]);
    skipForgetSessionIds.add("s-held");
    teardown = installIdleSweep();
    await flush();
    expect(sessionStore.getSnapshot().map((s) => s.id)).toEqual(["s-a", "s-b", "s-busy", "s-held"]);
    expect(forgetHarnessSession).not.toHaveBeenCalled();
    skipForgetSessionIds.clear();
    workspace.setTabs((tabs) => tabs.filter((t) => t.id !== "b"));
    await flush();
    expect(sessionStore.getSnapshot().map((s) => s.id)).toEqual(["s-a", "s-busy"]);
  });

  it("keeps a hidden thread that finished unseen, with no setting to ask", async () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a"), session("s-done", { busy: true })]);
    teardown = installIdleSweep();
    await flush();
    sessionStore.mutate((prev) => prev.map((s) => (s.id === "s-done" ? { ...s, busy: false } : s)));
    await flush();
    expect(sessionStore.getSnapshot().map((s) => s.id)).toEqual(["s-a", "s-done"]);
    expect(forgetHarnessSession).not.toHaveBeenCalledWith("claude", "s-done");
  });

  it("stops sweeping after teardown", async () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a")]);
    teardown = installIdleSweep();
    await flush();
    teardown();
    teardown = null;
    sessionStore.mutate((prev) => [...prev, session("s-late")]);
    await flush();
    expect(sessionStore.getSnapshot()).toHaveLength(2);
  });
});

describe("installActiveSessionSync", () => {
  it("selects the active pane's project and marks it seen", () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a", { projectId: "p1" })]);
    sessionStore.adopt(meta({ id: "s-a", projectId: "p1", updatedAt: 7 }));
    vi.spyOn(workspaceStore, "getSnapshot").mockReturnValue(
      catalog({ projects: [projectMeta("p1")] }),
    );
    teardown = installActiveSessionSync();
    expect(projectStore.getState().selectedProjectId).toBe("p1");
    expect(markSessionSeen).toHaveBeenCalledWith("s-a", 7);
    expect(saveLastSession).toHaveBeenCalledWith({ projectId: "p1" }, "s-a");
    expect(migrateWorkspaces).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledWith("local", "/repo");
  });

  it("never makes a local workspace for a window on another host", async () => {
    vi.spyOn(workspaceStore, "getSnapshot").mockReturnValue(catalog());
    environmentStore.setState({ currentId: "env_box" });
    projectStore.setState({ projectCwd: "/srv/agents/work/repo" });
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a", { cwd: "/srv/agents/work/repo" })]);
    teardown = installActiveSessionSync();
    expect(createWorkspace).not.toHaveBeenCalled();
    // Back on this machine, the window's own folder gets its workspace.
    environmentStore.setState({ currentId: "local" });
    projectStore.setState({ projectCwd: "/repo" });
    await flush();
    expect(createWorkspace).toHaveBeenCalledWith("local", "/repo");
  });

  it("a switch before the throttle flushes marks the thread leaving at its latest update", async () => {
    vi.useFakeTimers();
    setTabs([tab("a"), tab("b")], "a");
    sessionStore.mutate([session("s-a"), session("s-b")]);
    sessionStore.adopt(meta({ id: "s-a", updatedAt: 7 }));
    sessionStore.adopt(meta({ id: "s-b", updatedAt: 1 }));
    teardown = installActiveSessionSync();
    expect(markSessionSeen).toHaveBeenLastCalledWith("s-a", 7);
    sessionStore.adopt(meta({ id: "s-a", updatedAt: 9, status: "idle" }));
    await microtasks();
    workspace.setActiveTabId("b");
    await microtasks();
    expect(markSessionSeen).toHaveBeenCalledWith("s-a", 9);
    expect(markSessionSeen).toHaveBeenLastCalledWith("s-b", 1);
    // The pending timer never marks again, and never the thread that left.
    vi.mocked(markSessionSeen).mockClear();
    sessionStore.adopt(meta({ id: "s-a", updatedAt: 11 }));
    vi.advanceTimersByTime(1000);
    expect(markSessionSeen).not.toHaveBeenCalledWith("s-a", 11);
    vi.useRealTimers();
  });

  it("re-marks the streaming active thread at most once a second, and only when it moved", () => {
    vi.useFakeTimers();
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a")]);
    sessionStore.adopt(meta({ id: "s-a", updatedAt: 7 }));
    teardown = installActiveSessionSync();
    expect(markSessionSeen).toHaveBeenCalledTimes(1);
    sessionStore.adopt(meta({ id: "s-a", updatedAt: 8 }));
    sessionStore.adopt(meta({ id: "s-a", updatedAt: 9 }));
    expect(markSessionSeen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(markSessionSeen).toHaveBeenCalledTimes(2);
    expect(markSessionSeen).toHaveBeenLastCalledWith("s-a", 9);
    sessionStore.adopt(meta({ id: "s-a", updatedAt: 9, title: "renamed" }));
    vi.advanceTimersByTime(1000);
    expect(markSessionSeen).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("leaves a fresh loose draft's selection alone", () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a")]);
    projectStore.setState(
      initialProjectState({ projectCwd: "/repo", selectedProjectId: "p1" }),
      true,
    );
    teardown = installActiveSessionSync();
    expect(projectStore.getState().selectedProjectId).toBe("p1");
  });

  it("follows the active tab after the writes settle", async () => {
    setTabs([tab("a"), tab("b")], "a");
    sessionStore.mutate([session("s-a", { projectId: "p1" }), session("s-b", { projectId: "p2" })]);
    teardown = installActiveSessionSync();
    expect(projectStore.getState().selectedProjectId).toBe("p1");
    workspace.setActiveTabId("b");
    expect(projectStore.getState().selectedProjectId).toBe("p1");
    await microtasks();
    expect(projectStore.getState().selectedProjectId).toBe("p2");
  });

  it("a folder move that lands on another project's thread selects that thread's project", async () => {
    setTabs([tab("a"), tab("b")], "a");
    sessionStore.mutate([session("s-a", { projectId: "p1" }), session("s-b", { projectId: "p2" })]);
    teardown = installActiveSessionSync();
    project.enterWorkspace("/other");
    workspace.setActiveTabId("b");
    await microtasks();
    expect(projectStore.getState().projectCwd).toBe("/other");
    expect(projectStore.getState().selectedProjectId).toBe("p2");
    // Remembered for the folder the window is on now.
    expect(saveSelectedProject).toHaveBeenLastCalledWith("/other", "p2", expect.anything());
  });

  it("a folder move with the same thread on screen keeps the folder's remembered project", async () => {
    vi.mocked(loadSelectedProject).mockImplementation((cwd) => (cwd === "/other" ? "p9" : null));
    setTabs([tab("a")], "a");
    sessionStore.mutate([session("s-a", { projectId: "p1" })]);
    teardown = installActiveSessionSync();
    expect(projectStore.getState().selectedProjectId).toBe("p1");
    project.enterWorkspace("/other");
    await microtasks();
    expect(projectStore.getState().selectedProjectId).toBe("p9");
  });

  it("a thread of a linked copy on another path selects its own project after the move", async () => {
    vi.mocked(loadSelectedProject).mockImplementation((cwd) =>
      cwd === "/srv/agents/work/repo" ? "p-box-other" : null,
    );
    setTabs([tab("a"), tab("b")], "a");
    sessionStore.mutate([
      session("s-a", { projectId: "p-mac", cwd: "/repo" }),
      session("s-b", { projectId: "p-box", cwd: "/srv/agents/work/repo" }),
    ]);
    teardown = installActiveSessionSync();
    expect(projectStore.getState().selectedProjectId).toBe("p-mac");
    workspace.setActiveTabId("b");
    project.enterWorkspace("/srv/agents/work/repo");
    await microtasks();
    expect(projectStore.getState().selectedProjectId).toBe("p-box");
    workspace.setActiveTabId("a");
    project.enterWorkspace("/repo");
    await microtasks();
    expect(projectStore.getState().selectedProjectId).toBe("p-mac");
  });

  it("activating a box-copy tab of a linked project keeps the folder and the strip", async () => {
    const MAC = "/Users/l/IdeaProjects/temp-code";
    const BOX = "/srv/agents/work/temp-code";
    const actual = await vi.importActual<typeof import("../lib/projectContext")>("../lib/projectContext");
    vi.mocked(loadSelectedProject).mockImplementation(actual.loadSelectedProject);
    vi.mocked(saveSelectedProject).mockImplementation(actual.saveSelectedProject);
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    });
    try {
      const ws = (id: string, environmentId: string, path: string) =>
        ({ id, environmentId, path, name: "temp-code", git: true, linkId: "wl_1", createdAt: 1 });
      const linked = catalog({
        workspaces: [ws("wM", "local", MAC), ws("wB", "env_box", BOX)] as never,
        projects: [
          projectMeta("pM", { workspaceId: "wM", cwd: MAC, linkId: "pl_1" }),
          projectMeta("pB", { environmentId: "env_box", workspaceId: "wB", cwd: BOX, linkId: "pl_1" }),
          projectMeta("pWt", { environmentId: "env_box", workspaceId: "wB", cwd: `${BOX}/.claude/worktrees/auth` }),
        ],
      });
      vi.spyOn(workspaceStore, "getSnapshot").mockReturnValue(linked);
      // What each folder remembered before the link: the box path a worktree project.
      data.set("monocode.tc.selectedProject", JSON.stringify({ [MAC]: "pM", [BOX]: "pWt" }));
      sessionStore.mutate([
        session("sM", { projectId: "pM", cwd: MAC }),
        session("sB", { environmentId: "env_box", projectId: "pB", cwd: BOX }),
      ]);
      setTabs([{ ...newTab("sM"), id: "a" }, { ...newTab("sB"), id: "b" }], "a");
      projectStore.setState(initialProjectState({ projectCwd: MAC, selectedProjectId: "pM" }), true);
      teardown = installActiveSessionSync();
      // App.tsx activateTab in the deck layout.
      const activateTab = (id: string) => {
        workspaceActions.activateTab(id);
        const t = workspaceTabsStore.getState().tabs.find((entry) => entry.id === id)!;
        const cwd = workspaceTabCwd(t, rebaseToWorkspace(sessionStore.getSnapshot(), linked));
        if (cwd && looksLikeProject(cwd)) project.followWorkspace(normalizeProjectPath(cwd));
      };
      const deck = () => {
        const selected = linked.projects.find((p) => p.id === projectStore.getState().selectedProjectId)!;
        const scope = new Set([selected.id, ...copiesOf(linked.projects, selected.linkId).map((p) => p.id)]);
        return filterTabsForProjectId(workspaceTabsStore.getState().tabs, sessionStore.getSnapshot(), scope).map((t) => t.id);
      };
      const recents = projectStore.getState().recents;

      activateTab("b");
      await microtasks();
      expect(projectStore.getState().projectCwd).toBe(MAC);
      expect(projectStore.getState().recents).toBe(recents);
      expect(projectStore.getState().selectedProjectId).toBe("pB");
      expect(deck()).toEqual(["a", "b"]);
      // The box path's own entry was never read into the window or rewritten.
      expect(JSON.parse(data.get("monocode.tc.selectedProject")!)).toEqual({ [MAC]: "pB", [BOX]: "pWt" });

      activateTab("a");
      await microtasks();
      expect(projectStore.getState().projectCwd).toBe(MAC);
      expect(projectStore.getState().selectedProjectId).toBe("pM");
      expect(deck()).toEqual(["a", "b"]);
    } finally {
      vi.mocked(saveSelectedProject).mockImplementation(() => {});
    }
  });

  it("drops a selection whose project was archived", async () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a", { projectId: "p1" })]);
    const snapshot = vi.spyOn(workspaceStore, "getSnapshot");
    snapshot.mockReturnValue(catalog({ projects: [projectMeta("p1")] }));
    teardown = installActiveSessionSync();
    expect(projectStore.getState().selectedProjectId).toBe("p1");
    snapshot.mockReturnValue(catalog({ projects: [projectMeta("p1", { archived: true })] }));
    projectStore.setState((s) => ({ ...s, recents: [] }));
    await microtasks();
    expect(projectStore.getState().selectedProjectId).toBeNull();
  });

  it("stops following after teardown", async () => {
    setTabs([tab("a"), tab("b")], "a");
    sessionStore.mutate([session("s-a", { projectId: "p1" }), session("s-b", { projectId: "p2" })]);
    teardown = installActiveSessionSync();
    teardown();
    teardown = null;
    workspace.setActiveTabId("b");
    await microtasks();
    expect(projectStore.getState().selectedProjectId).toBe("p1");
  });
});

describe("installBootTasks", () => {
  it("prunes the seen map to the threads every settled host has (listed, or mirrored), and not while a host has neither or the list is empty", async () => {
    const listed = vi.spyOn(sessionStore, "settledEnvironments").mockResolvedValue(new Set(["local"]));
    const environments = vi.spyOn(registry, "environments").mockReturnValue([{ id: "local" }, { id: "env_box" }] as never);
    sessionStore.adopt(meta({ id: "s-a" }));
    sessionStore.adopt(meta({ id: "s-b", environmentId: "env_box" }));
    teardown = installBootTasks();
    await flush();
    // the box has neither listed nor a mirror: its threads are not known, so nothing is pruned
    expect(pruneLastSeen).not.toHaveBeenCalled();
    teardown();
    // the box is settled (its list landed, or the mirror painted it): every host's ids are known
    listed.mockResolvedValue(new Set(["local", "env_box"]));
    teardown = installBootTasks();
    await flush();
    expect(pruneLastSeen).toHaveBeenCalledWith(new Set(["s-a", "s-b"]));
    teardown();
    vi.spyOn(sessionStore, "metas").mockReturnValue([]);
    vi.mocked(pruneLastSeen).mockClear();
    teardown = installBootTasks();
    await flush();
    expect(pruneLastSeen).not.toHaveBeenCalled();
    environments.mockRestore();
  });

  it("starts a first launch empty, wherever it was launched from, and re-resolves live models", async () => {
    vi.mocked(lastProjectPath).mockReturnValue(null);
    vi.mocked(invoke).mockResolvedValue("/home/me/code");
    vi.mocked(createWorkspace).mockClear();
    const before = projectStore.getState().projectCwd;
    sessionStore.mutate([
      session("s-a", { cwd: "~", model: "old" }),
      session("s-b", { model: "kept" }),
      session("s-c", { model: "unknown" }),
    ]);
    teardown = installBootTasks();
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("default_cwd");
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(projectStore.getState().projectCwd).toBe(before);
    expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["claude"]);
    const [a, b, c] = sessionStore.getSnapshot();
    expect(a.cwd).toBe("~");
    expect(a.model).toBe("new");
    expect(b.cwd).toBe("/repo");
    expect(b.model).toBe("kept");
    // A model the catalog does not list is never swapped for the default.
    expect(c.model).toBe("unknown");
  });

  it("moves a thread hydrated before the live catalog onto the live id, and leaves an absent model alone", async () => {
    vi.mocked(invoke).mockResolvedValue("/home/me/code");
    // Hydrated before the catalog landed: the built-in picker id.
    resetHarnessModelOverlays();
    const stale = pickerModelId("claude", "claude-fable-5-1");
    expect(stale).toBe("claude:fable-5.1");
    sessionStore.mutate([
      session("s-a", { model: stale }),
      session("s-b", { model: "claude:claude-opus-4-1" }),
    ]);
    // The catalog lands (refreshHarnessCatalogs is mocked, so overlay it here).
    setHarnessModels("claude", agentModelsFor(CATALOG.claude), CATALOG.claude.defaultModel);
    try {
      teardown = installBootTasks();
      await flush();
      const [a, b] = sessionStore.getSnapshot();
      expect(a.model).toBe("claude:claude-fable-5-1");
      expect(nativeModelId(a.model)).toBe("claude-fable-5-1");
      // Not in the live catalog: never swapped for the default.
      expect(b.model).toBe("claude:claude-opus-4-1");
    } finally {
      resetHarnessModelOverlays();
    }
  });

  it("leaves a remembered folder alone and ignores late answers after teardown", async () => {
    vi.mocked(invoke).mockResolvedValue("/home/me/code");
    sessionStore.mutate([session("s-a", { cwd: "~", model: "old" })]);
    teardown = installBootTasks();
    teardown();
    teardown = null;
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("default_cwd");
    expect(projectStore.getState().projectCwd).toBe("/repo");
    expect(sessionStore.getSnapshot()[0].model).toBe("old");
  });
});

describe("installSubscriptions", () => {
  it("wires every reaction and its teardown detaches them all", async () => {
    setTabs([tab("a"), tab("b")], "a");
    sessionStore.mutate([session("s-a", { projectId: "p1" }), session("s-b", { projectId: "p2" })]);
    teardown = installSubscriptions();
    expect(projectStore.getState().selectedProjectId).toBe("p1");
    workspace.setActiveTabId("b");
    await flush();
    expect(projectStore.getState().selectedProjectId).toBe("p2");
    expect(workspaceTabsStore.getState().visits.current).toBe("b");
    teardown();
    teardown = null;
    workspace.setActiveTabId("a");
    sessionStore.mutate((prev) => [...prev, session("s-stray")]);
    await flush();
    expect(projectStore.getState().selectedProjectId).toBe("p2");
    expect(workspaceTabsStore.getState().visits.current).toBe("b");
    expect(sessionStore.getSnapshot()).toHaveLength(3);
  });
});

describe("installAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves the layout a beat after the stores change, once per burst", () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a")]);
    teardown = installAutosave();
    vi.advanceTimersByTime(300);
    expect(saveWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    workspace.setTabs((tabs) => [...tabs, tab("b")]);
    workspace.setActiveTabId("b");
    terminals.openTerminal("/repo", newTerminalFile("/repo", "zsh"));
    vi.advanceTimersByTime(300);
    expect(saveWorkspaceSnapshot).toHaveBeenCalledTimes(2);
    const snapshot = vi.mocked(saveWorkspaceSnapshot).mock.calls[1][0] as {
      activeTabId: string;
      projectTerminals?: unknown[];
    };
    expect(snapshot.activeTabId).toBe("b");
    expect(snapshot.projectTerminals).toHaveLength(1);
  });

  it("ignores a streamed turn and stops after teardown", () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a")]);
    teardown = installAutosave();
    vi.advanceTimersByTime(300);
    sessionStore.mutate((prev) => prev.map((s) => ({ ...s, blocks: [...s.blocks] })));
    vi.advanceTimersByTime(300);
    expect(saveWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    teardown();
    teardown = null;
    workspace.setTabs((tabs) => [...tabs, tab("b")]);
    vi.advanceTimersByTime(300);
    expect(saveWorkspaceSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe("installHistoryRefresh", () => {
  it("loads the sidebar folder's history when the folder changes", async () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a", { cwd: "/repo" })]);
    teardown = installHistoryRefresh();
    expect(listSessionsByProject).toHaveBeenCalledWith("/repo");
    workspace.setTabs((tabs) => tabs);
    await microtasks();
    expect(listSessionsByProject).toHaveBeenCalledTimes(1);
    sessionStore.mutate([session("s-a", { cwd: "/other" })]);
    await microtasks();
    expect(listSessionsByProject).toHaveBeenLastCalledWith("/other");
    // The file index walks the whole tree; a folder change alone never asks for it.
    expect(invoke).not.toHaveBeenCalledWith("list_project_files", expect.anything());
  });
});

describe("installLayoutSync", () => {
  it("drops the dock's focus once its dock is not on screen", async () => {
    terminals.openTerminal("/repo", newTerminalFile("/repo", "zsh"));
    focus.enterProjectTerminal();
    teardown = installLayoutSync();
    expect(focusStore.getState().projectTerminalFocused).toBe(true);
    terminals.updateDock("/repo", (dock) => withDockOpen(dock, false));
    await microtasks();
    expect(focusStore.getState().projectTerminalFocused).toBe(false);
  });

  it("a dock that is closed never holds focus", () => {
    terminals.openTerminal("/repo", newTerminalFile("/repo", "zsh"));
    terminals.updateDock("/repo", (dock) => withDockOpen(dock, false));
    focus.enterProjectTerminal();
    teardown = installLayoutSync();
    expect(focusStore.getState().projectTerminalFocused).toBe(false);
  });
});
