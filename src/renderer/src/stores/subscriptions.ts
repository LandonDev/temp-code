import { LAYOUT_CHANGE_EVENT, loadSidebarLayout, type SidebarLayout } from "../lib/appearance";
import { isAppQuitting } from "../lib/appLifecycle";
import { installCheckpointBridge } from "../lib/checkpointBridge";
import { syncDockBadge } from "../lib/dockBadge";
import { sessionChildHarnesses } from "../lib/handoff";
import {
  forgetHarnessSession,
  isLiveHarness,
  probeHarnessAvailability,
  refreshHarnessCatalogs,
} from "../lib/harness";
import { historyStore } from "../lib/historyStore";
import { liveAgentTracker } from "../lib/liveAgentTracker";
import { mergeModelSettings, resolveModel } from "../lib/models";
import { invoke } from "../lib/native";
import { saveLastSession, workspacePathOfSession } from "../lib/projectContext";
import { lastProjectPath, looksLikeProject } from "../lib/recents";
import { replaceProjectHistory } from "../lib/sessionHistory";
import { markSessionSeen } from "../lib/sessionSeen";
import {
  listSessionsByProject,
  saveWorkspaceSnapshot,
  subscribeSessionHistory,
} from "../lib/sessionStore";
import {
  loadLiveAgentsEnabled,
  loadNotesEnabled,
  subscribeLiveAgentsEnabled,
  subscribeNotesEnabled,
} from "../lib/settings";
import { createWorkspace } from "../lib/tcserver/projects";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceByPath, workspaceStore } from "../lib/tcserver/workspaces";
import { createWorkspaceAutosave } from "../lib/workspaceAutosave";
import { PARK_MS } from "../lib/warmTabs";
import { migrateWorkspaces } from "../lib/workspaceMigration";
import { collectWorkspaceSnapshot, workspaceSnapshotKey } from "../lib/workspaceSnapshot";
import { focus } from "./focus";
import { currentDockCwd, currentSidebarCwd, project, projectStore } from "./project";
import { shell, shellStore } from "./shell";
import { currentDock, terminalsStore } from "./terminals";
import { activeSessionOf, workspace, workspaceTabsStore } from "./workspace";
import { openSessionIds, workspaceActions } from "./workspaceActions";

/**
 * The effects App used to run off its renders, wired to the stores instead.
 * `installSubscriptions()` runs once from `main.tsx`, after the boot fills
 * the stores and before the first render. Each installer returns its
 * teardown so tests can install one at a time.
 *
 * A store notifies synchronously inside `setState`, mid-way through a
 * callback's writes. A subscriber that wrote back from there would hand the
 * later subscribers a stale state, and a check that read there would see
 * half a move. So every reaction that writes or decides waits for the
 * current microtask to end: all the writes of one callback settle as one,
 * the way one React commit did. The idle sweep waits a whole task, as it
 * always has; the mount budget only books an idle slice, so it runs inline.
 */

type Teardown = () => void;

/** One run per microtask no matter how many stores wrote. */
function afterWrites(run: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      run();
    });
  };
}

function teardownAll(offs: Teardown[]): Teardown {
  return () => {
    for (const off of offs) off();
  };
}

/** The session on screen, off the stores. */
export function currentActiveSession() {
  const { tabs, activeTabId } = workspaceTabsStore.getState();
  return activeSessionOf(tabs, activeTabId, sessionStore.getSnapshot()).active;
}

/** The visit trail follows the active tab; closed tabs fall out of it. */
export function installVisitSettling(): Teardown {
  const settle = afterWrites(() => workspace.settleVisits());
  workspace.settleVisits();
  return workspaceTabsStore.subscribe(
    (s) => [s.tabs, s.activeTabId] as const,
    settle,
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
}

/** Terminal tabs never share a strip with files. */
export function installTerminalIsolation(): Teardown {
  const isolate = afterWrites(() => workspaceActions.isolateTerminals());
  workspaceActions.isolateTerminals();
  return workspaceTabsStore.subscribe((s) => s.tabs, isolate);
}

/**
 * Only the warm set keeps its panes mounted (`lib/warmTabs`): the active
 * tab mounts on activation, and a tab that leaves the warm set unmounts
 * once it has been parked for `PARK_MS`, so a quick switch back finds it
 * still laid out while a workspace of a hundred tabs mounts three.
 */
export function installWarmSet(): Teardown {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    workspace.mountActiveTab();
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      workspace.trimMountedTabs();
    }, PARK_MS);
  };
  settle();
  const off = workspaceTabsStore.subscribe(
    (s) => [s.activeTabId, s.tabs] as const,
    settle,
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  return () => {
    off();
    if (timer != null) clearTimeout(timer);
  };
}

/**
 * Sessions the sweep must leave alone for a moment: a thread restored ahead
 * of the tab that will show it, or one being handed to another window.
 */
export const skipForgetSessionIds = new Set<string>();

/**
 * Tabs are views. Hidden idle sessions drop their child. A visible session
 * keeps its child for a few minutes after a turn so follow-ups stay instant,
 * then parks it and resumes on the next prompt. A store bump for a new
 * session lands before the write that opens its tab, so the sweep waits a
 * task and reads the tabs then.
 */
export function installIdleSweep(): Teardown {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const sweep = () => {
    pending = null;
    const keepUnseen = loadLiveAgentsEnabled();
    const visibleIds = openSessionIds(workspaceTabsStore.getState().tabs);
    const unseen = liveAgentTracker.unseenIds();
    const idleDetached = sessionStore.getSnapshot().filter(
      (session) =>
        !visibleIds.has(session.id) &&
        !session.busy &&
        !(keepUnseen && unseen.has(session.id)),
    );
    if (idleDetached.length === 0) return;
    for (const session of idleDetached) {
      if (skipForgetSessionIds.has(session.id)) continue;
      for (const harness of sessionChildHarnesses(session)) {
        void forgetHarnessSession(harness, session.id);
      }
    }
    sessionStore.mutate((prev) => {
      const next = prev.filter(
        (session) =>
          visibleIds.has(session.id) ||
          session.busy ||
          (keepUnseen && unseen.has(session.id)) ||
          skipForgetSessionIds.has(session.id),
      );
      // The store bumps on any new array; a no-op sweep must not re-notify
      // (and re-run this) while a shielded session waits for its tab.
      return next.length === prev.length ? prev : next;
    });
  };
  const sweepAfterCommit = () => {
    if (pending == null) pending = setTimeout(sweep, 0);
  };
  sweepAfterCommit();
  const offs = [
    sessionStore.subscribe(sweepAfterCommit),
    workspaceTabsStore.subscribe((s) => s.tabs, sweepAfterCommit),
    subscribeLiveAgentsEnabled(sweepAfterCommit),
  ];
  return () => {
    teardownAll(offs)();
    if (pending != null) clearTimeout(pending);
  };
}

/**
 * What follows the session on screen: the rail's focus, the read mark, the
 * project selection, and where its project and workspace land next time.
 */
export function installActiveSessionSync(): Teardown {
  // The active pane picks the project. A move to another workspace already
  // loaded that folder's remembered selection, so the pass that moved does
  // not let the landing thread overwrite it.
  let selectionCwd = projectStore.getState().projectCwd;
  let selectionKey: string | undefined;
  const syncSelection = () => {
    const { projectCwd } = projectStore.getState();
    const active = currentActiveSession();
    const key = `${active?.id ?? ""}\n${active?.projectId ?? ""}`;
    const moved = selectionCwd !== projectCwd;
    if (!moved && key === selectionKey) return;
    selectionCwd = projectCwd;
    selectionKey = key;
    if (moved || !active) return;
    if (!active.projectId && sessionStore.isDraft(active.id)) return;
    project.selectProject(active.projectId ?? null);
  };

  // The focused thread is where its project, and its workspace, land next
  // time they are picked. A draft has no meta until its first send, so this
  // follows the meta, not the pane; a subagent lands nowhere; and the
  // workspace key waits for the catalog, else it would name the worktree.
  let landingKey: string | undefined;
  const syncLanding = () => {
    const active = currentActiveSession();
    const meta = active ? sessionStore.metaOf(active.id) : null;
    const catalog = workspaceStore.getSnapshot();
    const key = [meta?.id, meta?.projectId, meta?.archived, catalog.loaded].join("\n");
    if (key === landingKey) return;
    landingKey = key;
    if (!meta || meta.archived || meta.parentId || !catalog.loaded) return;
    if (meta.projectId) saveLastSession({ projectId: meta.projectId }, meta.id);
    saveLastSession({ workspacePath: workspacePathOfSession(meta, catalog) }, meta.id);
  };

  // A project that was archived or deleted drops out of the selection.
  const dropStaleSelection = () => {
    const catalog = workspaceStore.getSnapshot();
    const { selectedProjectId } = projectStore.getState();
    if (!catalog.loaded || !selectedProjectId) return;
    const meta = catalog.projects.find((p) => p.id === selectedProjectId);
    if (!meta || meta.archived) project.selectProject(null);
  };

  // First boot after the upgrade: remembered folders become workspaces.
  // Every launch: the current folder is one too (workspace.create is idempotent).
  let workspacesKey: readonly [boolean, string, unknown] | undefined;
  const ensureWorkspace = () => {
    const catalog = workspaceStore.getSnapshot();
    const { projectCwd } = projectStore.getState();
    const key = [catalog.loaded, projectCwd, catalog.workspaces] as const;
    if (workspacesKey && key.every((part, i) => part === workspacesKey![i])) return;
    workspacesKey = key;
    if (!catalog.loaded) return;
    void migrateWorkspaces();
    if (looksLikeProject(projectCwd) && !workspaceByPath(catalog.workspaces, projectCwd)) {
      void createWorkspace(projectCwd).catch(() => undefined);
    }
  };

  // What is on screen counts as read, and the rail knows what is on screen.
  let focusedId: string | undefined;
  const mark = () => {
    const id = currentActiveSession()?.id;
    const meta = id ? sessionStore.metaOf(id) : null;
    if (id && meta) markSessionSeen(id, meta.updatedAt);
  };
  const syncFocus = () => {
    const id = currentActiveSession()?.id;
    if (id === focusedId) return;
    focusedId = id;
    liveAgentTracker.setFocused(id);
    mark();
  };

  const sync = () => {
    syncFocus();
    syncSelection();
    syncLanding();
    dropStaleSelection();
    ensureWorkspace();
  };
  sync();
  const scheduled = afterWrites(sync);
  return teardownAll([
    workspaceTabsStore.subscribe(scheduled),
    sessionStore.subscribe(scheduled),
    sessionStore.onMetaChange(scheduled),
    sessionStore.onMetaChange(mark),
    projectStore.subscribe(scheduled),
    workspaceStore.subscribe(scheduled),
  ]);
}

/**
 * The workspace layout saves itself a beat after it changes: the tabs, the
 * open sessions' shells, the folder and the docks. A burst of changes costs
 * one JSON pass; a touch that changes nothing never drops a pending save.
 */
export function installAutosave(): Teardown {
  const autosave = createWorkspaceAutosave({
    collect: () =>
      collectWorkspaceSnapshot(
        workspaceTabsStore.getState().tabs,
        sessionStore.getSnapshot(),
        workspaceTabsStore.getState().activeTabId,
        projectStore.getState().projectCwd,
        terminalsStore.getState().docks,
      ),
    key: workspaceSnapshotKey,
    // A window on its way out has persisted already; a late auto-save
    // would land after main dropped its slot.
    skip: isAppQuitting,
    save: (snapshot) => {
      void saveWorkspaceSnapshot(snapshot).catch((err) => {
        console.error("[workspace] snapshot save failed:", err);
      });
    },
  });
  // Shells, not sessions: a streamed turn changes no layout.
  let shells = sessionStore.getShells();
  const onSessions = () => {
    const next = sessionStore.getShells();
    if (next === shells) return;
    shells = next;
    autosave.touch();
  };
  autosave.touch();
  const offs = [
    workspaceTabsStore.subscribe(
      (s) => [s.tabs, s.activeTabId] as const,
      () => autosave.touch(),
      { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
    ),
    projectStore.subscribe((s) => s.projectCwd, () => autosave.touch()),
    terminalsStore.subscribe((s) => s.docks, () => autosave.touch()),
    sessionStore.subscribe(onSessions),
  ];
  return () => {
    teardownAll(offs)();
    autosave.cancel();
  };
}

/**
 * Refresh a project's history rows. `history` holds every visited project's
 * rows and the sidebar filters it by cwd, so a project loaded once paints from
 * cache on the way back and revalidates quietly under the cards on screen.
 * A failed revalidate keeps the cached cards.
 */
export async function refreshHistory(cwd: string): Promise<void> {
  if (!cwd || cwd === "~") return;
  try {
    const rows = await listSessionsByProject(cwd);
    if (cwd !== currentSidebarCwd()) return;
    historyStore.set((current) => replaceProjectHistory(current, cwd, rows));
  } catch {
    // A failed revalidate keeps the cached cards.
  }
}

/** The sidebar's folder loads its history when it changes. The file index waits for a picker. */
export function installHistoryRefresh(): Teardown {
  let cwd: string | undefined;
  const sync = () => {
    const next = currentSidebarCwd();
    if (next === cwd) return;
    cwd = next;
    void refreshHistory(next);
  };
  sync();
  const scheduled = afterWrites(sync);
  return teardownAll([
    workspaceTabsStore.subscribe(scheduled),
    sessionStore.subscribe(scheduled),
    projectStore.subscribe(scheduled),
    workspaceStore.subscribe(scheduled),
    subscribeSessionHistory(() => void refreshHistory(currentSidebarCwd())),
  ]);
}

/** Notes turned off closes the notes view. */
export function installNotesGate(): Teardown {
  const check = () => {
    if (!loadNotesEnabled()) shell.closeNotes();
  };
  check();
  return subscribeNotesEnabled(check);
}

/**
 * The sidebar layout: a switch closes every diff and drops the terminal
 * focus when the dock leaves with classic; the sidebar tab settles to one
 * the layout has; a dock that is not on screen cannot hold focus.
 */
export function installLayoutSync(): Teardown {
  // The event carries the layout; storage is only the fallback at install,
  // since a failed write still dispatches and the React tree follows the event.
  let layout: SidebarLayout = loadSidebarLayout();
  const onLayoutChange = (event: Event) => {
    layout = (event as CustomEvent<SidebarLayout>).detail === "deck" ? "deck" : "classic";
    workspace.setTabs((prev) =>
      prev.some((tab) => tab.diffOpen || tab.diffFocused)
        ? prev.map((tab) => ({ ...tab, diffOpen: false, diffFocused: false }))
        : prev,
    );
    shell.applyLayoutChange(layout);
    if (layout === "classic") focus.projectTerminal(false);
  };
  const settleTab = afterWrites(() => shell.settleSidebarTab(layout));
  const dockVisible = () => layout === "deck" && !!currentDock(currentDockCwd())?.open;
  const guardDock = afterWrites(() => {
    if (!dockVisible()) focus.projectTerminal(false);
  });
  shell.settleSidebarTab(layout);
  if (!dockVisible()) focus.projectTerminal(false);
  const offs = [
    shellStore.subscribe((s) => s.sidebarTab, settleTab),
    terminalsStore.subscribe(guardDock),
    projectStore.subscribe(guardDock),
    workspaceStore.subscribe(guardDock),
  ];
  if (typeof window !== "undefined") {
    const onLayout = (event: Event) => {
      onLayoutChange(event);
      guardDock();
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, onLayout);
    offs.push(() => window.removeEventListener(LAYOUT_CHANGE_EVENT, onLayout));
  }
  return teardownAll(offs);
}

/** Once per window: the dock badge, checkpoints, the default folder and the harness catalogs. */
export function installBootTasks(): Teardown {
  let live = true;
  syncDockBadge();
  const offs = [
    sessionStore.subscribe(syncDockBadge),
    sessionStore.onMetaChange(syncDockBadge),
    installCheckpointBridge(),
    () => {
      live = false;
    },
  ];

  if (!lastProjectPath()) {
    void invoke<string>("default_cwd")
      .then((cwd) => {
        if (!live || !looksLikeProject(cwd)) return;
        project.adoptDefaultCwd(cwd);
        void createWorkspace(cwd).catch(() => undefined);
        sessionStore.mutate((prev) => prev.map((s) => (s.cwd === "~" ? { ...s, cwd } : s)));
      })
      .catch(() => {});
  }

  void probeHarnessAvailability();
  // Only the harnesses already in this window. Probing every installed CLI
  // at boot left unused agents (especially Pi) running in the background.
  const harnesses = [...new Set(sessionStore.getSnapshot().map((session) => session.harness))];
  void refreshHarnessCatalogs(harnesses).then(() => {
    if (!live) return;
    sessionStore.mutate((prev) =>
      prev.map((session) => {
        if (!isLiveHarness(session.harness)) return session;
        const resolved = resolveModel(session.harness, session.model);
        const modelSettings = mergeModelSettings(resolved, session.modelSettings);
        if (resolved.id === session.model && sameSettings(modelSettings, session.modelSettings)) {
          return session;
        }
        return { ...session, model: resolved.id, modelSettings };
      }),
    );
  });
  return teardownAll(offs);
}

function sameSettings(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/** Everything above, once, after the boot fills the stores. */
export function installSubscriptions(): Teardown {
  return teardownAll([
    installVisitSettling(),
    installTerminalIsolation(),
    installWarmSet(),
    installIdleSweep(),
    installActiveSessionSync(),
    installAutosave(),
    installHistoryRefresh(),
    installNotesGate(),
    installLayoutSync(),
    installBootTasks(),
  ]);
}
