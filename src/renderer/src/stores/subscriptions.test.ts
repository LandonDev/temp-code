import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaf, newFileTab, newTab, newTerminalFile, type WorkspaceTab } from "../lib/layout";
import { saveLastSession } from "../lib/projectContext";
import { newSession, type Session } from "../lib/session";
import { markSessionSeen } from "../lib/sessionSeen";
import { listSessionsByProject, saveWorkspaceSnapshot } from "../lib/sessionStore";
import { prefetchProjectFiles } from "../lib/fileIndex";
import { loadSidebarLayout } from "../lib/appearance";
import { loadNotesEnabled } from "../lib/settings";
import { withDockOpen } from "../lib/projectTerminal";
import { focus, focusStore, initialFocusState } from "./focus";
import { initialShellState, shell, shellStore } from "./shell";
import { createWorkspace } from "../lib/tcserver/projects";
import { sessionStore } from "../lib/tcserver/store";
import type { ProjectMeta, SessionMeta, WorkspaceCatalog } from "../lib/tcserver/types";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { migrateWorkspaces } from "../lib/workspaceMigration";
import { forgetHarnessSession, refreshHarnessCatalogs } from "../lib/harness";
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
  installMountBudget,
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
vi.mock("../lib/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/models")>()),
  resolveModel: (_harness: string, model: string) => ({ id: model === "old" ? "new" : model }),
  mergeModelSettings: (_resolved: unknown, settings?: Record<string, string>) => settings ?? {},
}));
vi.mock("../lib/checkpointBridge", () => ({ installCheckpointBridge: () => () => {} }));
vi.mock("../lib/native", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/appLifecycle", () => ({ isAppQuitting: () => false }));
vi.mock("../lib/sessionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessionStore")>()),
  saveWorkspaceSnapshot: vi.fn(() => Promise.resolve()),
  listSessionsByProject: vi.fn(() => Promise.resolve([])),
  subscribeSessionHistory: vi.fn(() => () => {}),
}));
vi.mock("../lib/fileIndex", () => ({ prefetchProjectFiles: vi.fn() }));
vi.mock("../lib/appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/appearance")>()),
  loadSidebarLayout: vi.fn((): "classic" | "deck" => "classic"),
}));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  loadNotesEnabled: vi.fn(() => true),
}));
vi.mock("../lib/sessionSeen", () => ({ markSessionSeen: vi.fn() }));
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

describe("installMountBudget", () => {
  it("grows the budget one idle slice at a time until every hidden tab may mount", () => {
    const idle: (() => void)[] = [];
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("window", {
      requestIdleCallback: (cb: () => void) => {
        idle.push(cb);
        return idle.length;
      },
      cancelIdleCallback,
    });
    setTabs([tab("a"), tab("b"), tab("c")]);
    teardown = installMountBudget();
    expect(idle).toHaveLength(1);
    idle.shift()!();
    expect(workspaceTabsStore.getState().hiddenMountBudget).toBe(1);
    expect(idle).toHaveLength(1);
    idle.shift()!();
    idle.shift()!();
    expect(workspaceTabsStore.getState().hiddenMountBudget).toBe(3);
    expect(idle).toHaveLength(0);
    expect(cancelIdleCallback).not.toHaveBeenCalled();
  });

  it("cancels a pending slice when the tabs fall within budget, and tears down cleanly", () => {
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("window", { requestIdleCallback: () => 42, cancelIdleCallback });
    setTabs([tab("a"), tab("b")]);
    teardown = installMountBudget();
    workspace.setTabs([]);
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
    setTabs([tab("a"), tab("b")]);
    teardown();
    teardown = null;
    expect(cancelIdleCallback).toHaveBeenCalledTimes(2);
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
  it("adopts the default folder on a first launch and re-resolves live models", async () => {
    vi.mocked(lastProjectPath).mockReturnValue(null);
    vi.mocked(invoke).mockResolvedValue("/home/me/code");
    sessionStore.mutate([
      session("s-a", { cwd: "~", model: "old" }),
      session("s-b", { model: "kept" }),
    ]);
    teardown = installBootTasks();
    await flush();
    expect(projectStore.getState().projectCwd).toBe("/home/me/code");
    expect(createWorkspace).toHaveBeenCalledWith("/home/me/code");
    expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["claude"]);
    const [a, b] = sessionStore.getSnapshot();
    expect(a.cwd).toBe("/home/me/code");
    expect(a.model).toBe("new");
    expect(b.cwd).toBe("/repo");
    expect(b.model).toBe("kept");
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
  it("loads the sidebar folder's history and warms its files when the folder changes", async () => {
    setTabs([tab("a")]);
    sessionStore.mutate([session("s-a", { cwd: "/repo" })]);
    teardown = installHistoryRefresh();
    expect(listSessionsByProject).toHaveBeenCalledWith("/repo");
    expect(prefetchProjectFiles).toHaveBeenCalledWith("/repo");
    workspace.setTabs((tabs) => tabs);
    await microtasks();
    expect(listSessionsByProject).toHaveBeenCalledTimes(1);
    sessionStore.mutate([session("s-a", { cwd: "/other" })]);
    await microtasks();
    expect(listSessionsByProject).toHaveBeenLastCalledWith("/other");
    expect(prefetchProjectFiles).toHaveBeenLastCalledWith("/other");
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
