import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaf, newFileTab, newTab, newTerminalFile, type WorkspaceTab } from "../lib/layout";
import { saveLastSession } from "../lib/projectContext";
import { newSession, type Session } from "../lib/session";
import { markSessionSeen, pruneLastSeen } from "../lib/sessionSeen";
import { listSessionsByProject, saveWorkspaceSnapshot } from "../lib/sessionStore";
import { loadSidebarLayout } from "../lib/appearance";
import { loadNotesEnabled } from "../lib/settings";
import { withDockOpen } from "../lib/projectTerminal";
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
import { invoke } from "../lib/native";
import { initialProjectState, project, projectStore } from "./project";
import {
  installActiveSessionSync,
  installAutosave,
  installBootTasks,
  installHistoryRefresh,
  installLayoutSync,
  installNotesGate,
  installIdleSweep,
  installWarmSet,
  installSubscriptions,
  installTerminalIsolation,
  installVisitSettling,
  skipForgetSessionIds,
} from "./subscriptions";
import { initialTerminalsState, terminals, terminalsStore } from "./terminals";
import { initialWorkspaceTabsState, workspace, workspaceTabsStore } from "./workspace";

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
vi.mock("../lib/checkpointBridge", () => ({ installCheckpointBridge: () => () => {} }));
vi.mock("../lib/native", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/appLifecycle", () => ({ isAppQuitting: () => false }));
vi.mock("../lib/sessionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessionStore")>()),
  saveWorkspaceSnapshot: vi.fn(() => Promise.resolve()),
  listSessionsByProject: vi.fn(() => Promise.resolve([])),
  subscribeSessionHistory: vi.fn(() => () => {}),
}));
vi.mock("../lib/appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/appearance")>()),
  loadSidebarLayout: vi.fn((): "classic" | "deck" => "classic"),
}));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  loadNotesEnabled: vi.fn(() => true),
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
  return { ...newSession("claude", "/repo"), id, ...over };
}

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s-a",
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: null,
    planPath: null,
    provider: "claude",
    model: "claude-sonnet-5",
    reasoning: "medium",
    agentType: "implementer",
    title: "claude",
    cwd: "/repo",
    status: "idle",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
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
  setTabs([]);
  skipForgetSessionIds.clear();
  vi.clearAllMocks();
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
    expect(createWorkspace).toHaveBeenCalledWith("/repo");
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

  it("keeps the selection a workspace move just loaded from the landing thread", async () => {
    setTabs([tab("a"), tab("b")], "a");
    sessionStore.mutate([session("s-a", { projectId: "p1" }), session("s-b", { projectId: "p2" })]);
    teardown = installActiveSessionSync();
    project.enterWorkspace("/other");
    workspace.setActiveTabId("b");
    await microtasks();
    expect(projectStore.getState().projectCwd).toBe("/other");
    expect(projectStore.getState().selectedProjectId).toBeNull();
    workspace.setActiveTabId("a");
    await microtasks();
    expect(projectStore.getState().selectedProjectId).toBe("p1");
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
  it("prunes the seen map to the threads the server lists, and not when the list is empty", () => {
    teardown = installBootTasks();
    expect(pruneLastSeen).not.toHaveBeenCalled();
    teardown();
    sessionStore.adopt(meta({ id: "s-a" }));
    sessionStore.adopt(meta({ id: "s-b" }));
    teardown = installBootTasks();
    expect(pruneLastSeen).toHaveBeenCalledWith(new Set(["s-a", "s-b"]));
  });

  it("adopts the default folder on a first launch and re-resolves live models", async () => {
    vi.mocked(lastProjectPath).mockReturnValue(null);
    vi.mocked(invoke).mockResolvedValue("/home/me/code");
    sessionStore.mutate([
      session("s-a", { cwd: "~", model: "old" }),
      session("s-b", { model: "kept" }),
      session("s-c", { model: "unknown" }),
    ]);
    teardown = installBootTasks();
    await flush();
    expect(projectStore.getState().projectCwd).toBe("/home/me/code");
    expect(createWorkspace).toHaveBeenCalledWith("/home/me/code");
    expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["claude"]);
    const [a, b, c] = sessionStore.getSnapshot();
    expect(a.cwd).toBe("/home/me/code");
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

describe("installNotesGate", () => {
  it("closes the notes view when notes are off", () => {
    shell.openNotes();
    teardown = installNotesGate();
    expect(shellStore.getState().notesViewOpen).toBe(true);
    teardown();
    vi.mocked(loadNotesEnabled).mockReturnValue(false);
    teardown = installNotesGate();
    expect(shellStore.getState().notesViewOpen).toBe(false);
  });
});

describe("installLayoutSync", () => {
  it("drops the dock's focus once its dock is not on screen", async () => {
    vi.mocked(loadSidebarLayout).mockReturnValue("deck");
    terminals.openTerminal("/repo", newTerminalFile("/repo", "zsh"));
    focus.enterProjectTerminal();
    teardown = installLayoutSync();
    expect(focusStore.getState().projectTerminalFocused).toBe(true);
    terminals.updateDock("/repo", (dock) => withDockOpen(dock, false));
    await microtasks();
    expect(focusStore.getState().projectTerminalFocused).toBe(false);
  });

  it("a dock in classic never holds focus", () => {
    terminals.openTerminal("/repo", newTerminalFile("/repo", "zsh"));
    focus.enterProjectTerminal();
    teardown = installLayoutSync();
    expect(focusStore.getState().projectTerminalFocused).toBe(false);
  });
});
