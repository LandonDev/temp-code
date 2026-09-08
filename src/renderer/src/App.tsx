import { invoke, listen, getCurrentWindow, message } from "./lib/native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Sidebar } from "./chrome/Sidebar";
import { HiddenApprovalToasts } from "./chrome/ApprovalToasts";
import { WhatsNewDialog } from "./chrome/WhatsNewDialog";
import { NewWorkspaceDialog } from "./chrome/ProjectDialogs";
import { ShellTitleBar, type HeaderEvents } from "./chrome/ShellTitleBar";
import { MenuBar } from "./chrome/MenuBar";
import { FilePicker } from "./chrome/FilePicker";
import { SymbolPicker } from "./chrome/SymbolPicker";
import { closeLightbox, isLightboxOpen, stepLightbox } from "./chrome/Lightbox";
import { UsageFooter } from "./chrome/UsageFooter";
import { useSidebarLayout } from "./hooks/useSidebarLayout";
import {
  LAYOUT_CHANGE_EVENT,
  loadSidebarOpen,
  loadProjectRailOpen,
  loadSidebarTabOrder,
  saveSidebarOpen,
  saveProjectRailOpen,
  toggleTranscriptZen,
  type SidebarLayout,
  type SidebarTabId,
} from "./lib/appearance";
import { IS_MAC } from "./lib/platform";
import { updateStore } from "./lib/updateStore";
import { displayAttachments, prepareAttachments } from "./lib/attachments";
import { basename, notifyGitChanged, pickFolder, restoreSessionCheckout } from "./lib/fs";
import {
  invalidateProjectFiles,
  prefetchProjectFiles,
  rememberOpenedFile,
  resolveOpenablePath,
} from "./lib/fileIndex";
import {
  closeLeaf,
  findSurfacePane,
  firstLeafId,
  focusedFileTab,
  isolateTerminalPanes,
  isFilesystemTab,
  leaf,
  leafIds,
  movePane,
  neighborLeafId,
  newDebugFile,
  newFileTab,
  newTab,
  newTerminalFile,
  newTerminalWorkspaceTab,
  nextTerminalTitle,
  openDebugTab,
  openEditorTab,
  openTerminalTab,
  removePane,
  replaceLeafId,
  setSplitRatio,
  siblingLeafId,
  splitPane,
  surfacePanes,
  updateTerminalTab,
  withSurfacePanes,
  type EditorPane,
  type FilePaneTab,
  type FocusDir,
  type PaneEdge,
  type SplitDir,
  type WorkspaceTab,
} from "./lib/layout";
import {
  releaseNotesForVersion,
} from "./lib/releaseNotes";
import { orderByIds } from "./lib/reorder";
import {
  addTerminalToDock,
  applyDockGridStyle,
  closeTerminalInDock,
  createProjectTerminal,
  findProjectTerminal,
  mapProjectTerminal,
  nextDockTerminalTitle,
  patchProjectTerminals,
  reorderDockTerminals,
  selectDockTerminal,
  splitProjectTerminalsForMove,
  withDockOpen,
  withDockSide,
  withDockSize,
  type DockSide,
  type ProjectTerminalDock as ProjectTerminal,
} from "./lib/projectTerminal";
import {
  addTabsToNewGroup,
  addTabToGroup,
  applyGroupedReorder,
  insertTabBesideActive,
  insertTabInGroup,
  joinTabOnto,
  newTabGroupId,
  notifyTabGroupLabelsChanged,
  removeTabFromGroup,
  saveTabGroupLabel,
  tabGroupProject,
  ungroupTabs,
} from "./lib/tabGroups";
import {
  collectWindowTransfer,
  type WindowTransferPayload,
} from "./lib/windowTransfer";
import {
  confirmCloseTerminal,
  confirmCloseTerminals,
} from "./lib/terminalClose";
import {
  listRunningTerminals,
  type TerminalMetaPatch,
} from "./lib/terminalTab";
import {
  cancelHarnessTurn,
  forgetHarnessSession,
  isLiveHarness,
  probeHarnessAvailability,
  refreshHarnessCatalogs,
  registerBuiltinHarnesses,
  respondHarnessApproval,
  stopStreaming,
  pickTextHarness,
  type ApprovalDecision,
} from "./lib/harness";
import {
  appendPreparingHandoff,
  buildDeterministicHandoff,
  buildHandoffComposerCard,
  completeHandoff,
  consumeHandoff,
  HANDOFF_TITLE,
  handoffTurnCard,
  isPreparingHandoff,
  planComposerSwitch,
  sessionChildHarnesses,
  sessionThroughTurn,
  wrapHandoffPrompt,
} from "./lib/handoff";
import { isEditTool } from "./lib/harness/preview";
import type { ComposerIntent } from "./lib/composerAction";
import { installCheckpointBridge } from "./lib/checkpointBridge";
import { ThreadBanners } from "./chrome/ThreadBanners";
import {
  keepSessionChanges,
  notifyReviewChanged,
} from "./lib/checkpoint";
import { notifyDirsChanged } from "./lib/fileTree";
import { nudgeWatchedFiles } from "./lib/fileWatch";
import { type EditorNavigationTarget, type OpenFileFn } from "./lib/search";
import { editorForPath } from "./surfaces/monaco/route";
import { flushAllEditors, flushEditor } from "./lib/editorFlush";
import { loadAutoSave } from "./lib/settings";
import { OPEN_DEBUG_EVENT, OPEN_SETTINGS_EVENT } from "./lib/monaco/debugTab";
import {
  mergeModelSettings,
  preferredModelSettings,
  resolveModel,
  saveLastModelSettings,
} from "./lib/models";
import {
  displayPath,
  isEqualOrInside,
  projectName,
  rebasePath,
  resolveWorkspacePath,
} from "./lib/paths";
import { removeProjectData } from "./lib/projectData";
import {
  contextForCwd,
  contextOfSession,
  loadSelectedProject,
  rebaseToWorkspace,
  resolveSessionContext,
  type ResolvedContext,
  saveSelectedProject,
  workspacePathOfSession,
} from "./lib/projectContext";
import { createWorkspace, deleteWorkspace, projectForCwd } from "./lib/tcserver/projects";
import type { ProjectMeta } from "./lib/tcserver/types";
import { useWorkspaceCatalog, workspaceByPath, workspaceStore } from "./lib/tcserver/workspaces";
import { draftFromDefaults } from "./lib/tcserver/defaults";
import type { ThreadType } from "./lib/tcserver/types";
import { markSessionSeen } from "./lib/sessionSeen";
import { historyStore } from "./lib/historyStore";
import { applyZoom, loadZoom, zoomIn, zoomOut, zoomReset } from "./lib/zoom";
import { migrateWorkspaces } from "./lib/workspaceMigration";
import {
  archiveProject,
  forgetProject,
  lastProjectPath,
  loadArchivedProjects,
  loadRecents,
  looksLikeProject,
  normalizeProjectPath,
  rememberProject,
  sameProjectPath,
} from "./lib/recents";
import {
  applyDeletedSessionToWorkspace,
  filterTabsForProject,
  filterTabsForProjectId,
  findTabForProject,
  planWorkspaceTabClose,
  tabProjectKey,
  workspaceTabCwd,
} from "./lib/workspaceTabGroups";
import {
  HARNESS_LABEL,
  canReplaceSessionTitle,
  formatSessionTitle,
  newDefaultSession,
  newSession,
  HARNESSES,
  sessionDisplayTitle,
  sessionWorkCwd,
  titleFromPrompt,
  type Attachment,
  type Block,
  type HarnessId,
  type RuntimeMode,
  type SecondOpinionMeta,
  type Session,
} from "./lib/session";
import { dropContextWindow } from "./lib/contextUsage";
import {
  deleteSession,
  getSession,
  listSessionsByProject,
  saveWorkspaceSnapshot,
  setSessionArchived,
  subscribeSessionHistory,
  type SessionSummary,
} from "./lib/sessionStore";
import { sessionStore, useSessionShells, type SessionShell } from "./lib/tcserver/store";
import { toggleRightRail, useRightRailOpen } from "./lib/rightRail";
import { ProjectRail } from "./chrome/rail/ProjectRail";
import {
  headerNeighbour,
  type HeaderModel,
} from "./lib/threadHeaderModel";
import type { ThreadAction } from "./chrome/ThreadHeader";
import type { ChipThread } from "./chrome/ThreadHeaderStrip";
import type { ThreadRules } from "@server/shared/rules";
import type { TabThreadAction } from "./chrome/TitleBar";
import * as serverCommands from "./lib/tcserver/commands";
import { syncDockBadge } from "./lib/dockBadge";
import { liveAgentTracker } from "./lib/liveAgentTracker";
import { requestTranscriptJump } from "./lib/transcriptJump";
import { installAppFacade } from "./lib/appFacade";
import { playCue } from "./lib/sounds";
import {
  APP_COMMANDS,
  createKeyResolver,
  dialogOpen,
  isAppCommandId,
  menuCommandAllowed,
  type AppCommand,
} from "./lib/appCommands";
import {
  canTabVisitBack,
  canTabVisitForward,
  emptyTabVisitHistory,
  pruneTabVisitHistory,
  recordTabVisit,
  tabVisitBack,
  tabVisitForward,
  type TabVisitHistory,
} from "./lib/tabVisitHistory";
import { preparePrompt } from "./lib/promptPreparation";
import { deriveMentionAttachments } from "./lib/mentionAttachments";
import {
  ADD_NOTE_TO_CHAT_EVENT,
  composeNoteMessage,
  noteCardMeta,
  type NoteComposerCard,
} from "./lib/notes";
import {
  SECOND_OPINION_TITLE,
  buildSecondOpinionCard,
  buildSecondOpinionPrompt,
  harnessForTurn,
  turnEditedFiles,
  turnReport,
  turnUserRequest,
} from "./lib/secondOpinion";
import { PaneTree } from "./surfaces/PaneTree";
import { ProjectTerminalDock } from "./surfaces/ProjectTerminalDock";
import { DiffPane } from "./surfaces/DiffPane";
import { SearchView } from "./surfaces/SearchView";
import { SettingsView } from "./surfaces/SettingsView";
import { InboxView, InboxDetailPane } from "./surfaces/InboxView";
import { NotesView } from "./surfaces/NotesView";
import { inboxComposerCard, type InboxItem } from "./lib/githubTasks";
import {
  linearIssueDetails,
  peekLinearIssueDetails,
} from "./lib/linear";
import {
  loadLiveAgentsEnabled,
  loadNotesEnabled,
  loadSettingsSection,
  isSettingsSectionId,
  saveSettingsSection,
  subscribeLiveAgentsEnabled,
  subscribeNotesEnabled,
  type SettingsSectionId,
} from "./lib/settings";
import {
  handleEditorFindKey,
  openFindInActiveEditor,
} from "./surfaces/editorSearch";

import {
  mergeHistorySummary,
  replaceProjectHistory,
  summaryFromSession,
} from "./lib/sessionHistory";
import {
  CONTINUE_PROMPT,
  canAutoContinue,
} from "./lib/inFlight";
import {
  collectWorkspaceSnapshot,
  workspaceSnapshotKey,
} from "./lib/workspaceSnapshot";
import type { InstalledUpdate } from "./lib/updateNotice";
import {
  hasInFlightSessions,
  hideCurrentWindow,
  persistAndCloseWindow,
  isAppQuitting,
  persistQuitState,
  reapWindowRuntime,
  setQuitWorkspace,
  type ResumedWorkspace,
} from "./lib/appLifecycle";

function userTurnCards(
  noteCard: NoteComposerCard | undefined,
  secondOpinion?: SecondOpinionMeta,
) {
  if (!noteCard && !secondOpinion) return undefined;
  return {
    ...(secondOpinion ? { secondOpinion } : {}),
    ...(noteCard ? { noteCard: noteCardMeta(noteCard) } : {}),
  };
}

function withHarnessChoice(
  session: Session,
  harness: HarnessId,
  model: string,
  modelSettings: Record<string, string>,
): Session {
  return {
    ...session,
    harness,
    model,
    modelSettings,
    title:
      session.blocks.length === 0
        ? HARNESS_LABEL[harness]
        : formatSessionTitle(
            harness,
            sessionDisplayTitle(session.title, session.harness),
          ),
    ...(session.model === model
      ? {}
      : { context: dropContextWindow(session.context) }),
    ...(session.harness === harness ? {} : { providerSessionId: undefined }),
  };
}

function openSessionIds(tabs: WorkspaceTab[]): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    for (const id of leafIds(tab.layout)) ids.add(id);
  }
  return ids;
}


export default function App({
  windowTransfer = null,
  resumed = null,
  installedUpdate = null,
  history: bootHistory = [],
  historyCwd: bootHistoryCwd = null,
}: {
  windowTransfer?: WindowTransferPayload | null;
  resumed?: ResumedWorkspace | null;
  installedUpdate?: InstalledUpdate | null;
  history?: SessionSummary[];
  historyCwd?: string | null;
}) {
  const [projectCwd, setProjectCwd] = useState(
    () =>
      windowTransfer?.projectCwd ??
      resumed?.projectCwd ??
      lastProjectPath() ??
      "~",
  );
  const [recents, setRecents] = useState(() =>
    resumed?.projectCwd && looksLikeProject(resumed.projectCwd)
      ? rememberProject(resumed.projectCwd)
      : loadRecents(),
  );
  const catalog = useWorkspaceCatalog();
  const { workspaces, projects } = catalog;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => loadSelectedProject(projectCwd),
  );
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId && !p.archived)
    : undefined;
  /** Where a project terminal opens and which dock it lands in: the
   *  selected project's checkout (its worktree), else the workspace root. */
  const dockCwd = selectedProject?.cwd ?? projectCwd;
  const dockCwdRef = useRef(dockCwd);
  dockCwdRef.current = dockCwd;
  const selectedWorkspace = workspaceByPath(workspaces, projectCwd);
  /** Rail rows: every server workspace, opened-at from the local recents. */
  const railRecents = useMemo(() => {
    if (!catalog.loaded) return recents;
    const hidden = new Set(loadArchivedProjects().map((item) => item.path));
    return workspaces
      .map((w) => ({
        path: normalizeProjectPath(w.path),
        openedAt:
          recents.find((r) => sameProjectPath(r.path, w.path))?.openedAt ??
          w.createdAt,
      }))
      .filter((item) => looksLikeProject(item.path) && !hidden.has(item.path));
  }, [catalog.loaded, recents, workspaces]);
  const [seed] = useState(() => {
    const cwd = lastProjectPath() ?? "~";
    const session = newDefaultSession(cwd);
    const tab = newTab(session.id);
    return { session, tab };
  });
  useState(() => {
    if (sessionStore.getSnapshot().length === 0) {
      sessionStore.mutate(
        windowTransfer?.sessions ?? resumed?.sessions ?? [seed.session],
      );
    }
    return true;
  });
  /** The open sessions' shells: layout-relevant fields only, so a streamed
   *  turn or a busy flip never re-renders App. Callbacks read the full
   *  sessions from `sessionStore.getSnapshot()`. */
  const sessions = useSessionShells();
  const setSessions = sessionStore.mutate;
  const [tabs, setTabs] = useState<WorkspaceTab[]>(
    () => windowTransfer?.tabs ?? resumed?.tabs ?? [seed.tab],
  );
  const [projectTerminals, setProjectTerminals] = useState<
    ProjectTerminal[]
  >(
    () =>
      windowTransfer?.projectTerminals ?? resumed?.projectTerminals ?? [],
  );
  const [projectTerminalFocused, setProjectTerminalFocused] = useState(false);
  const [activeTabId, setActiveTabId] = useState(
    () => windowTransfer?.activeTabId ?? resumed?.activeTabId ?? seed.tab.id,
  );
  const [composerFocused, setComposerFocused] = useState(() => {
    if (windowTransfer) return true;
    if (!resumed) return false;
    const tab =
      resumed.tabs.find((entry) => entry.id === resumed.activeTabId) ??
      resumed.tabs[0];
    return (
      !!tab && resumed.sessions.some((session) => session.id === tab.focusedId)
    );
  });
  /** Tab id -> project name, kept in sync with the rendered title tabs. */
  const tabProjectsRef = useRef(new Map<string, string>());
  /** Deck tab ids in strip order: the chips' tabs (live row, then shelf), then tabs with no chip. */
  const stripTabsRef = useRef<string[]>([]);
  const headerModelRef = useRef<HeaderModel<ChipThread>>({ live: [], dormant: [], activeId: null });
  const chipThreadsRef = useRef<ChipThread[]>([]);
  const projectOfTab = useCallback(
    (id: string) => tabProjectsRef.current.get(id),
    [],
  );
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [projectRailOpen, setProjectRailOpen] = useState(loadProjectRailOpen);
  const sidebarLayout = useSidebarLayout();
  const deckLayout = sidebarLayout === "deck";
  const tabCloseScope = deckLayout ? "project" : "workspace";
  const currentProjectDock = deckLayout
    ? findProjectTerminal(projectTerminals, dockCwd)
    : undefined;
  const dockVisible = !!currentProjectDock?.open;
  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>(
    () => loadSidebarTabOrder()[0] ?? "sessions",
  );
  const classicInbox = !deckLayout && sidebarTab === "inbox";
  const [filesSearchOpen, setFilesSearchOpen] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [searchViewOpen, setSearchViewOpen] = useState(false);
  const [searchViewFocusToken, setSearchViewFocusToken] = useState(0);
  const [inboxViewOpen, setInboxViewOpen] = useState(false);
  const [notesViewOpen, setNotesViewOpen] = useState(false);
  const notesEnabled = useSyncExternalStore(
    subscribeNotesEnabled,
    loadNotesEnabled,
    () => true,
  );
  const liveAgentsEnabled = useSyncExternalStore(
    subscribeLiveAgentsEnabled,
    loadLiveAgentsEnabled,
    () => true,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateNotice, setUpdateNotice] = useState(installedUpdate);
  const [whatsNew, setWhatsNew] = useState<{
    version: string;
    markdown?: string;
  } | null>(null);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>(loadSettingsSection);
  const [editorNavigation, setEditorNavigation] =
    useState<EditorNavigationTarget | null>(null);
  const editorNavigationToken = useRef(0);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(
    () => new Set(windowTransfer?.dirtyFileIds ?? []),
  );
  // Not carried across a window transfer the way dirty state is: the editor
  // re-lints whatever it mounts, so the counts rebuild themselves.
  const [fileErrorCounts, setFileErrorCounts] = useState<Map<string, number>>(
    () => new Map(),
  );
  // History lives in historyStore so its per-turn refreshes skip App.
  useState(() => {
    if (historyStore.get().length === 0 && bootHistory.length > 0) historyStore.set(bootHistory);
    return true;
  });
  const setHistory = historyStore.set;
  /**
   * Projects whose rows are already in `history`. This has to be state, not a
   * ref: `sidebarCwd` is derived during render, so the frame that first shows
   * a new project must already know the listing has not arrived yet.
   */
  const [loadedProjects, setLoadedProjects] = useState<ReadonlySet<string>>(
    () =>
      bootHistoryCwd
        ? new Set([normalizeProjectPath(bootHistoryCwd)])
        : new Set(),
  );
  const loadedProjectsRef = useRef(loadedProjects);
  loadedProjectsRef.current = loadedProjects;

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const projectTerminalsRef = useRef(projectTerminals);
  projectTerminalsRef.current = projectTerminals;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const projectCwdRef = useRef(projectCwd);
  projectCwdRef.current = projectCwd;
  const searchViewOpenRef = useRef(searchViewOpen);
  searchViewOpenRef.current = searchViewOpen;
  const inboxViewOpenRef = useRef(inboxViewOpen);
  inboxViewOpenRef.current = inboxViewOpen;
  const notesViewOpenRef = useRef(notesViewOpen);
  notesViewOpenRef.current = notesViewOpen;

  useEffect(() => {
    if (!notesEnabled) setNotesViewOpen(false);
  }, [notesEnabled]);

  const deckLayoutRef = useRef(deckLayout);
  deckLayoutRef.current = deckLayout;
  const tabVisitRef = useRef(emptyTabVisitHistory(activeTabId));
  const tabVisitFromHistoryRef = useRef(false);
  const [tabVisitNav, setTabVisitNav] = useState({
    canBack: false,
    canForward: false,
  });
  const turnGen = useRef(new Map<string, number>());
  const workspaceSyncKey = useRef<string | null>(null);
  const skipForgetSessionIds = useRef(new Set<string>());
  const noteSystem = useCallback((sessionId: string, text: string) => {
    sessionStore.mutate((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              busy: false,
              blocks: [...s.blocks, { id: crypto.randomUUID(), role: "system" as const, text }],
            }
          : s,
      ),
    );
  }, []);

  useEffect(() => {
    registerBuiltinHarnesses();
    const reap = () => {
      if (isAppQuitting()) return;
      void persistQuitState(
        sessionStore.getSnapshot(),
        tabsRef.current,
        activeTabIdRef.current,
        projectCwdRef.current,
        projectTerminalsRef.current,
      ).finally(() => {
        void reapWindowRuntime(tabsRef.current, projectTerminalsRef.current);
      });
    };
    window.addEventListener("pagehide", reap);
    window.addEventListener("beforeunload", reap);
    return () => {
      window.removeEventListener("pagehide", reap);
      window.removeEventListener("beforeunload", reap);
    };
  }, [resumed]);

  // Tool results refresh open editors, as the local adapters' tool.updated
  // events did. Checkpoints follow the server's turn events instead.
  useEffect(
    () =>
      sessionStore.onEvent((_sessionId, row, session) => {
        if (row.event.type !== "tool-result") return;
        const callId = row.event.callId;
        const block = session.blocks.find((b) => b.tool?.callId === callId);
        if (!block) return;
        nudgeOpenEditors(block, sessionWorkCwd(session));
      }),
    [],
  );
  useEffect(() => installCheckpointBridge(), []);

  useEffect(() => {
    void probeHarnessAvailability();
    // Only the harnesses already in this window. Probing every installed CLI
    // at boot left unused agents (especially Pi) running in the background.
    const harnesses = [
      ...new Set(sessionStore.getSnapshot().map((session) => session.harness)),
    ];
    void refreshHarnessCatalogs(harnesses).then(() => {
      setSessions((prev) =>
        prev.map((session) => {
          if (!isLiveHarness(session.harness)) return session;
          const resolved = resolveModel(session.harness, session.model);
          const modelSettings = mergeModelSettings(
            resolved,
            session.modelSettings,
          );
          if (
            resolved.id === session.model &&
            sameSettings(modelSettings, session.modelSettings)
          ) {
            return session;
          }
          return { ...session, model: resolved.id, modelSettings };
        }),
      );
    });
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const active =
    sessions.find((session) => session.id === activeTab?.focusedId) ??
    sessions.find(
      (session) => activeTab && leafIds(activeTab.layout).includes(session.id),
    );
  const sessionDefaults = active ?? sessions[0];
  const sessionDefaultsRef = useRef(sessionDefaults);
  sessionDefaultsRef.current = sessionDefaults;
  /** Ids and cwd for a new session: the given (else selected) project, else a loose chat here. */
  const sessionContext = useCallback(
    (projectId?: string | null) =>
      resolveSessionContext({
        ...catalogRef.current,
        projectId: projectId === undefined ? selectedProjectIdRef.current : projectId,
        workspacePath: projectCwdRef.current,
      }),
    [],
  );
  const cwdContext = useCallback(
    (cwd: string) =>
      contextForCwd({
        ...catalogRef.current,
        cwd,
        preferProjectId: selectedProjectIdRef.current,
      }),
    [],
  );
  /** A draft for a resolved context, seeded from the workspace's thread
   *  defaults when it has them (so the pickers show what the server would
   *  use anyway), else from `fallback`. */
  const seededSession = useCallback(
    (
      ctx: ResolvedContext,
      cwd: string,
      fallback: Pick<Session, "harness" | "model" | "runtimeMode" | "modelSettings"> | undefined,
      threadType: ThreadType = "chat",
      threadRules: ThreadRules | null = null,
    ) => {
      const context = { ...ctx, threadType, threadRules };
      const defaults = workspaceStore.defaultsFor(ctx.workspaceId);
      const seed =
        defaults && (HARNESSES as string[]).includes(defaults.provider)
          ? draftFromDefaults(defaults)
          : fallback;
      return seed
        ? newSession(seed.harness, cwd, seed.model, seed.runtimeMode, seed.modelSettings, context)
        : newDefaultSession(cwd, sessionDefaultsRef.current?.runtimeMode, context);
    },
    [],
  );
  const createSessionHere = useCallback(
    (
      opts: {
        projectId?: string | null;
        runtimeMode?: RuntimeMode;
        threadType?: ThreadType;
        threadRules?: ThreadRules | null;
      } = {},
    ) => {
      const ctx = sessionContext(opts.projectId);
      const session = seededSession(ctx, ctx.cwd, undefined, opts.threadType, opts.threadRules);
      return opts.runtimeMode ? { ...session, runtimeMode: opts.runtimeMode } : session;
    },
    [seededSession, sessionContext],
  );
  const sidebarCwd =
    active?.cwd ??
    (activeTab ? focusedFileTab(activeTab)?.cwd : undefined) ??
    selectedProject?.cwd ??
    projectCwd;
  const sidebarCwdRef = useRef(sidebarCwd);
  sidebarCwdRef.current = sidebarCwd;
  const gitCwd = active ? sessionWorkCwd(active) : sidebarCwd;
  const gitCwdRef = useRef(gitCwd);
  gitCwdRef.current = gitCwd;

  const usageProviders = useMemo(() => {
    if (active?.harness === "claude" || active?.harness === "codex") {
      return [active.harness];
    }
    return [];
  }, [active?.harness]);
  const usageSession = useMemo(() => {
    if (!active) return undefined;
    return { harness: active.harness };
  }, [active?.harness]);
  const runningTerminals = useMemo(() => {
    const files: FilePaneTab[] = [];
    const dock = findProjectTerminal(projectTerminals, dockCwd);
    if (dock) files.push(...dock.pane.files);
    for (const tab of tabs) {
      for (const pane of tab.terminalPanes ?? []) {
        files.push(...pane.files);
      }
    }
    return listRunningTerminals(files);
  }, [dockCwd, projectTerminals, tabs]);
  const runningTerminalOpen = useMemo(() => {
    const ids = new Set(runningTerminals.map((terminal) => terminal.id));
    if (
      currentProjectDock?.open &&
      currentProjectDock.pane.files.some((file) => ids.has(file.id))
    ) {
      return true;
    }
    const focused = activeTab ? focusedFileTab(activeTab) : undefined;
    return !!focused && ids.has(focused.id);
  }, [activeTab, currentProjectDock, runningTerminals]);

  const activeSessionId = active?.id;
  // The rail's live cards and the "finished while unfocused" set live in
  // liveAgentTracker; it only needs to know which session is on screen.
  useEffect(() => {
    liveAgentTracker.setFocused(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    syncDockBadge();
    const offSnapshot = sessionStore.subscribe(syncDockBadge);
    const offMeta = sessionStore.onMetaChange(syncDockBadge);
    return () => {
      offSnapshot();
      offMeta();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenClose: (() => void) | undefined;
    const releaseQuit = setQuitWorkspace(
      () => sessionStore.getSnapshot(),
      () => tabsRef.current,
      () => activeTabIdRef.current,
      () => projectCwdRef.current,
      () => projectTerminalsRef.current,
    );
    void getCurrentWindow()
      .onCloseRequested((event) => {
        // Listening here makes close our job. Letting the default path run
        // calls JS `window.destroy`, which Tauri denies without a permission.
        event.preventDefault();
        if (hasInFlightSessions(sessionStore.getSnapshot())) {
          void hideCurrentWindow();
          return;
        }
        void persistAndCloseWindow(
          sessionStore.getSnapshot(),
          tabsRef.current,
          activeTabIdRef.current,
          projectCwdRef.current,
          projectTerminalsRef.current,
        );
      })
      .then((fn) => {
        // The subscription resolves after the effect may already have been
        // torn down (StrictMode remounts); a listener left behind would close
        // the window twice and persist a snapshot main has already dropped.
        if (cancelled) fn();
        else unlistenClose = fn;
      });
    return () => {
      cancelled = true;
      releaseQuit();
      unlistenClose?.();
    };
  }, []);

  const refreshHistory = useCallback(async (cwd: string) => {
    if (!cwd || cwd === "~") return;
    // `history` holds every visited project's rows and the sidebar filters it
    // by cwd, so a project loaded once paints from cache on the way back and
    // revalidates quietly underneath the cards already on screen. Whether the
    // first load is still pending is derived from `loadedProjects`, not
    // tracked here — a status set from this effect lands a render too late to
    // suppress the empty state.
    const key = normalizeProjectPath(cwd);
    try {
      const rows = await listSessionsByProject(cwd);
      if (cwd !== sidebarCwdRef.current) return;
      setHistory((current) => replaceProjectHistory(current, cwd, rows));
      setLoadedProjects((prev) =>
        prev.has(key) ? prev : new Set(prev).add(key),
      );
    } catch {
      // A failed revalidate keeps the cached cards.
    }
  }, []);

  useEffect(() => {
    void refreshHistory(sidebarCwd);
  }, [sidebarCwd, refreshHistory]);

  useEffect(
    () =>
      subscribeSessionHistory(() => {
        void refreshHistory(sidebarCwdRef.current);
      }),
    [refreshHistory],
  );

  useEffect(() => {
    prefetchProjectFiles(sidebarCwd);
  }, [sidebarCwd]);

  // Every window saves under its own slot, a transferred one included: the
  // donor skipped this for transfer windows because it had one snapshot for
  // the whole app, and the moved tab would have overwritten the source's.
  useEffect(() => {
    const snapshot = collectWorkspaceSnapshot(
      tabs,
      sessions,
      activeTabId,
      projectCwd,
      projectTerminals,
    );
    const key = workspaceSnapshotKey(snapshot);
    if (workspaceSyncKey.current === key) return;
    workspaceSyncKey.current = key;
    const timer = window.setTimeout(() => {
      // A window on its way out has persisted already; a late auto-save
      // would land after main dropped its slot.
      if (isAppQuitting()) return;
      void saveWorkspaceSnapshot(snapshot).catch((err) => {
        console.error("[workspace] snapshot save failed:", err);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [tabs, sessions, activeTabId, projectCwd, projectTerminals]);

  useEffect(() => {
    if (lastProjectPath()) return;
    void invoke<string>("default_cwd")
      .then((cwd) => {
        if (!looksLikeProject(cwd)) return;
        setProjectCwd(cwd);
        setRecents((prev) => (prev.length > 0 ? prev : rememberProject(cwd)));
        void createWorkspace(cwd).catch(() => undefined);
        setSessions((prev) =>
          prev.map((s) => (s.cwd === "~" ? { ...s, cwd } : s)),
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        const isolated = isolateTerminalPanes(tab);
        if (isolated !== tab) changed = true;
        return isolated;
      });
      return changed ? next : prev;
    });
  }, [tabs]);

  // Tabs are views. Hidden idle sessions drop their child. A visible session
  // keeps its child for a few minutes after a turn so follow-ups stay instant,
  // then parks it and resumes on the next prompt. Runs off the store, not a
  // render, so a busy flip sweeps without re-rendering App.
  useEffect(() => {
    const keepUnseen = liveAgentsEnabled;
    let pending: number | null = null;
    const sweep = () => {
      pending = null;
      // Read the tabs at sweep time: a store bump for a new session lands
      // before the React state that opens its tab, so a sweep off the bump
      // itself would drop every fresh draft as hidden.
      const visibleIds = openSessionIds(tabsRef.current);
      const unseen = liveAgentTracker.unseenIds();
      const idleDetached = sessionStore.getSnapshot().filter(
        (session) =>
          !visibleIds.has(session.id) &&
          !session.busy &&
          !(keepUnseen && unseen.has(session.id)),
      );
      if (idleDetached.length === 0) return;
      for (const session of idleDetached) {
        if (skipForgetSessionIds.current.has(session.id)) continue;
        for (const harness of sessionChildHarnesses(session)) {
          void forgetHarnessSession(harness, session.id);
        }
      }
      setSessions((prev) => {
        const next = prev.filter(
          (session) =>
            visibleIds.has(session.id) ||
            session.busy ||
            (keepUnseen && unseen.has(session.id)) ||
            skipForgetSessionIds.current.has(session.id),
        );
        // The store bumps on any new array; a no-op sweep must not re-notify
        // (and re-run this) while a shielded session waits for its tab.
        return next.length === prev.length ? prev : next;
      });
    };
    const sweepAfterCommit = () => {
      if (pending == null) pending = window.setTimeout(sweep, 0);
    };
    sweep();
    const unsubscribe = sessionStore.subscribe(sweepAfterCommit);
    return () => {
      unsubscribe();
      if (pending != null) window.clearTimeout(pending);
    };
  }, [tabs, liveAgentsEnabled]);

  // Hidden tabs mount their panes after first paint, one per idle slice, so
  // launch-to-session-list does not scale with how many heavy tabs restore.
  const [hiddenMountBudget, setHiddenMountBudget] = useState(0);
  useEffect(() => {
    if (hiddenMountBudget >= tabs.length) return;
    const handle = window.requestIdleCallback(
      () => setHiddenMountBudget((n) => n + 1),
      { timeout: 500 },
    );
    return () => window.cancelIdleCallback(handle);
  }, [hiddenMountBudget, tabs.length]);
  const mountedTabIds = useMemo(() => {
    const ids = new Set<string>();
    let hidden = 0;
    for (const tab of tabs) {
      if (tab.id === activeTabId || hidden++ < hiddenMountBudget) ids.add(tab.id);
    }
    return ids;
  }, [tabs, activeTabId, hiddenMountBudget]);

  const activateTab = useCallback((id: string) => {
    setActiveTabId(id);
    const tab = tabsRef.current.find((entry) => entry.id === id);
    if (deckLayout && tab) {
      const cwd = workspaceTabCwd(
        tab,
        rebaseToWorkspace(sessionStore.getSnapshot(), catalogRef.current),
      );
      if (cwd && looksLikeProject(cwd)) {
        const normalized = normalizeProjectPath(cwd);
        if (!sameProjectPath(normalized, projectCwdRef.current)) {
          setProjectCwd(normalized);
          setRecents(rememberProject(normalized));
        }
      }
    }
    setComposerFocused(
      !!tab &&
        sessionStore.getSnapshot().some((session) => session.id === tab.focusedId),
    );
  }, [deckLayout]);


  // The active tab names the selected project; a fresh loose draft says nothing.
  useEffect(() => {
    if (!active) return;
    if (!active.projectId && sessionStore.isDraft(active.id)) return;
    setSelectedProjectId(active.projectId ?? null);
  }, [active?.id, active?.projectId]);

  // Selection is remembered per workspace folder.
  const selectionCwdRef = useRef(projectCwd);
  useEffect(() => {
    if (selectionCwdRef.current === projectCwd) {
      saveSelectedProject(projectCwd, selectedProjectId);
      return;
    }
    selectionCwdRef.current = projectCwd;
    setSelectedProjectId(loadSelectedProject(projectCwd));
  }, [projectCwd, selectedProjectId]);

  // A project that was archived or deleted drops out of the selection.
  useEffect(() => {
    if (!catalog.loaded || !selectedProjectId) return;
    const project = projects.find((p) => p.id === selectedProjectId);
    if (!project || project.archived) setSelectedProjectId(null);
  }, [catalog.loaded, projects, selectedProjectId]);

  // First boot after the upgrade: remembered folders become workspaces.
  // Every launch: the current folder is one too (workspace.create is idempotent).
  useEffect(() => {
    if (!catalog.loaded) return;
    void migrateWorkspaces();
    if (looksLikeProject(projectCwd) && !workspaceByPath(workspaces, projectCwd)) {
      void createWorkspace(projectCwd).catch(() => undefined);
    }
  }, [catalog.loaded, projectCwd, workspaces]);

  // What is on screen counts as read.
  const activeIdRef = useRef(active?.id);
  activeIdRef.current = active?.id;
  useEffect(() => {
    const mark = () => {
      const id = activeIdRef.current;
      const meta = id ? sessionStore.metaOf(id) : null;
      if (id && meta) markSessionSeen(id, meta.updatedAt);
    };
    mark();
    return sessionStore.onMetaChange(mark);
  }, [active?.id]);

  const commitTabVisit = useCallback((history: TabVisitHistory) => {
    tabVisitRef.current = history;
    const canBack = canTabVisitBack(history);
    const canForward = canTabVisitForward(history);
    setTabVisitNav((prev) =>
      prev.canBack === canBack && prev.canForward === canForward
        ? prev
        : { canBack, canForward },
    );
  }, []);

  useEffect(() => {
    const openIds = new Set(tabs.map((tab) => tab.id));
    let next = pruneTabVisitHistory(tabVisitRef.current, openIds, activeTabId);
    if (tabVisitFromHistoryRef.current) {
      tabVisitFromHistoryRef.current = false;
    } else if (next.current !== activeTabId) {
      next = recordTabVisit(next, activeTabId);
    }
    commitTabVisit(pruneTabVisitHistory(next, openIds, activeTabId));
  }, [activeTabId, commitTabVisit, tabs]);

  /** `cwd` scopes group inheritance: a tab from another project starts alone. */
  const appendTab = useCallback(
    (tab: WorkspaceTab, cwd?: string) => {
      setTabs((prev) =>
        insertTabBesideActive(prev, tab, activeTabIdRef.current, (id) =>
          id === tab.id
            ? cwd
              ? projectName(cwd)
              : undefined
            : projectOfTab(id),
        ),
      );
    },
    [projectOfTab],
  );

  const onOpenWhatsNew = useCallback((version: string, markdown?: string) => {
    if (markdown) {
      setWhatsNew({ version, markdown });
      return;
    }
    const document = releaseNotesForVersion(version);
    if (!document) {
      void message(
        "Release notes for this version are not available in this build.",
        { title: "TempCode" },
      );
      return;
    }
    setWhatsNew({ version: document.source.version });
  }, []);

  const onNew = useCallback(() => {
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    const session = createSessionHere();
    const tab = newTab(session.id);
    setSessions((prev) => [...prev, session]);
    appendTab(tab, session.cwd);
    setActiveTabId(tab.id);
    setComposerFocused(true);
    return session.id;
  }, [appendTab, createSessionHere]);

  /** Sidebar: a chat in the given project (null = loose chat in this workspace). */
  const onNewChat = useCallback(
    (projectId: string | null) => {
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setSelectedProjectId(projectId);
      const session = createSessionHere({ projectId });
      const tab = newTab(session.id);
      setSessions((prev) => [...prev, session]);
      appendTab(tab, session.cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
    },
    [appendTab, createSessionHere],
  );

  /** Card click: select the project and bring its latest open tab forward. */
  const onSelectProjectCard = useCallback(
    (projectId: string | null) => {
      setSelectedProjectId(projectId);
      if (!projectId) return;
      // A full-screen view (inbox, notes, search) would otherwise stay on top
      // of the pane, most visibly when that project's tab is already active.
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      const tabs = tabsRef.current;
      const sessions = sessionStore.getSnapshot();
      const inProject = (tab: WorkspaceTab) =>
        sessions.find((s) => s.id === tab.focusedId)?.projectId === projectId;
      const current = tabs.find((tab) => tab.id === activeTabIdRef.current);
      if (current && inProject(current)) return;
      const visits = tabVisitRef.current;
      const recent = [...visits.back]
        .reverse()
        .map((id) => tabs.find((tab) => tab.id === id))
        .find((tab) => tab && inProject(tab));
      const target = recent ?? tabs.find(inProject);
      // No pane of that project is open: start one, so the body never keeps
      // showing another project's thread under this project's header.
      if (target) activateTab(target.id);
      else onNewChat(projectId);
    },
    [activateTab, onNewChat],
  );

  const onProjectCreated = useCallback(
    (project: ProjectMeta) => {
      // A worktree gets its own tab group; label it with the project name
      // so the tab bar shows "Auth rewrite", not the worktree slug.
      if (project.mode === "worktree") {
        saveTabGroupLabel(projectName(project.cwd), project.name);
        notifyTabGroupLabelsChanged();
      }
      onNewChat(project.id);
    },
    [onNewChat],
  );

  const onStartInboxItem = useCallback(
    async (item: InboxItem, body?: string) => {
      const start = (description?: string) => {
        setInboxViewOpen(false);
        setNotesViewOpen(false);
        setSidebarTab("sessions");
        const ctx = item.projectPath
          ? cwdContext(item.projectPath)
          : sessionContext();
        const cwd = ctx.cwd;
        const ref =
          item.provider === "linear"
            ? item.identifier?.trim() || `#${item.number}`
            : `#${item.number}`;
        const session = {
          ...newDefaultSession(cwd, sessionDefaults?.runtimeMode, ctx),
          title: `${ref} ${item.title}`,
          inboxCard: inboxComposerCard(item, description),
        };
        const tab = newTab(session.id);
        setSessions((prev) => [...prev, session]);
        appendTab(tab, cwd);
        setActiveTabId(tab.id);
        setComposerFocused(true);
      };

      if (item.provider !== "linear") {
        start();
        return;
      }
      if (!item.id) {
        throw new Error("Missing Linear issue");
      }
      if (body !== undefined) {
        start(body);
        return;
      }
      const cached = peekLinearIssueDetails(item.id);
      if (cached) {
        start(cached.body);
        return;
      }
      const details = await linearIssueDetails(item.id);
      start(details.body);
    },
    [
      active?.cwd,
      appendTab,
      sessionDefaults?.cwd,
      sessionDefaults?.runtimeMode,
      projectCwd,
    ],
  );

  const onAddNoteToChat = useCallback(
    (card: NoteComposerCard) => {
      if (!card.id) return;
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setSidebarTab("sessions");
      const ctx =
        card.sourceCwd && looksLikeProject(card.sourceCwd)
          ? cwdContext(card.sourceCwd)
          : sessionContext();
      const cwd = ctx.cwd;
      const title = card.title.trim();
      const session = {
        ...newDefaultSession(cwd, sessionDefaults?.runtimeMode, ctx),
        ...(title ? { title } : {}),
        noteCard: card,
      };
      const tab = newTab(session.id);
      setSessions((prev) => [...prev, session]);
      appendTab(tab, cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
    },
    [
      active?.cwd,
      appendTab,
      sessionDefaults?.cwd,
      sessionDefaults?.runtimeMode,
      projectCwd,
    ],
  );

  useEffect(() => {
    const onAdd = (event: Event) => {
      const card = (event as CustomEvent<NoteComposerCard>).detail;
      if (!card?.id) return;
      onAddNoteToChat(card);
    };
    window.addEventListener(ADD_NOTE_TO_CHAT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_NOTE_TO_CHAT_EVENT, onAdd);
  }, [onAddNoteToChat]);

  const onInboxCardDismiss = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId && session.inboxCard
          ? { ...session, inboxCard: undefined }
          : session,
      ),
    );
  }, []);

  const onNoteCardDismiss = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId && session.noteCard
          ? { ...session, noteCard: undefined }
          : session,
      ),
    );
  }, []);

  const onHandoffCardDismiss = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId && session.handoffCard
          ? { ...session, handoffCard: undefined }
          : session,
      ),
    );
  }, []);

  const onSplit = useCallback(
    (dir: SplitDir) => {
      if (!activeTab) return;
      const session = createSessionHere();
      setSessions((prev) => [...prev, session]);
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== activeTab.id) return t;
          return {
            ...t,
            layout: splitPane(t.layout, t.focusedId, dir, session.id),
            focusedId: session.id,
          };
        }),
      );
      setComposerFocused(true);
    },
    [
      activeTab,
      projectCwd,
      sessionDefaults?.cwd,
      sessionDefaults?.runtimeMode,
    ],
  );

  const focusProjectTerminal = useCallback(() => {
    setProjectTerminalFocused(true);
    setComposerFocused(false);
  }, []);

  const openProjectTerminal = useCallback(
    (cwd: string) => {
      const workdir = cwd || dockCwdRef.current;
      const projectPath = dockCwdRef.current;
      if (!looksLikeProject(projectPath)) return false;
      setProjectTerminals((prev) => {
        const existing = findProjectTerminal(prev, projectPath);
        const file = newTerminalFile(
          workdir,
          existing
            ? nextDockTerminalTitle(existing, workdir)
            : undefined,
        );
        if (!existing) {
          return [...prev, createProjectTerminal(projectPath, file)];
        }
        return mapProjectTerminal(prev, projectPath, (dock) =>
          addTerminalToDock(dock, file),
        );
      });
      focusProjectTerminal();
      return true;
    },
    [focusProjectTerminal],
  );

  const onOpenTerminal = useCallback(
    (cwd: string, asWorkspaceTab = false, occupySessionId?: string) => {
      const workdir = cwd || active?.cwd || dockCwd;
      if (deckLayout && openProjectTerminal(workdir)) return;

      if (asWorkspaceTab || !activeTab) {
        const file = newTerminalFile(workdir);
        const tab = newTerminalWorkspaceTab(file);
        appendTab(tab, workdir);
        setActiveTabId(tab.id);
        setComposerFocused(false);
        return;
      }

      const occupying = sessionStore.getSnapshot().find(
        (session) => session.id === (occupySessionId ?? activeTab.focusedId),
      );
      const occupyPaneId =
        occupying && isBlankSession(occupying) ? occupying.id : undefined;
      if (occupyPaneId && occupying) {
        void forgetHarnessSession(occupying.harness, occupyPaneId);
        setSessions((prev) =>
          prev.filter((session) => session.id !== occupyPaneId),
        );
      }

      const file = newTerminalFile(
        workdir,
        nextTerminalTitle(activeTab, workdir),
      );
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTab.id
            ? openTerminalTab(tab, file, occupyPaneId)
            : tab,
        ),
      );
      setComposerFocused(false);
    },
    [
      active?.cwd,
      activeTab,
      appendTab,
      deckLayout,
      openProjectTerminal,
      dockCwd,
    ],
  );

  const onNewTerminal = useCallback(() => {
    onOpenTerminal(active?.cwd ?? dockCwd);
  }, [active?.cwd, onOpenTerminal, dockCwd]);

  const onShowProjectTerminal = useCallback(() => {
    if (!deckLayout) {
      onOpenTerminal(active?.cwd ?? dockCwd);
      return;
    }
    const dock = findProjectTerminal(projectTerminalsRef.current, dockCwd);
    if (dock && dock.pane.files.length > 0) {
      if (!dock.open) {
        setProjectTerminals((prev) =>
          mapProjectTerminal(prev, dockCwd, (entry) =>
            withDockOpen(entry, true),
          ),
        );
      }
      focusProjectTerminal();
      return;
    }
    onOpenTerminal(active?.cwd ?? dockCwd);
  }, [
    active?.cwd,
    deckLayout,
    focusProjectTerminal,
    onOpenTerminal,
    dockCwd,
  ]);

  const onNewTerminalInSession = useCallback(
    (sessionId: string) => {
      const session = sessionStore.getSnapshot().find(
        (entry) => entry.id === sessionId,
      );
      onOpenTerminal(
        session ? sessionWorkCwd(session) : dockCwd,
        false,
        sessionId,
      );
    },
    [onOpenTerminal, dockCwd],
  );

  const onToggleProjectTerminal = useCallback(() => {
    if (!deckLayout || !looksLikeProject(dockCwd)) return;
    const dock = findProjectTerminal(projectTerminalsRef.current, dockCwd);
    if (!dock) {
      openProjectTerminal(active?.cwd ?? dockCwd);
      return;
    }
    const nextOpen = !dock.open;
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, dockCwd, (entry) =>
        withDockOpen(entry, nextOpen),
      ),
    );
    if (nextOpen) focusProjectTerminal();
    else setProjectTerminalFocused(false);
  }, [
    active?.cwd,
    deckLayout,
    focusProjectTerminal,
    openProjectTerminal,
    dockCwd,
  ]);

  const onHideProjectTerminal = useCallback(() => {
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, dockCwdRef.current, (dock) =>
        withDockOpen(dock, false),
      ),
    );
    setProjectTerminalFocused(false);
  }, []);

  const onProjectTerminalSide = useCallback((side: DockSide) => {
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, dockCwdRef.current, (dock) =>
        withDockSide(dock, side, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      ),
    );
  }, []);

  const onProjectTerminalSize = useCallback((size: number) => {
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, dockCwdRef.current, (dock) =>
        withDockSize(dock, size, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      ),
    );
  }, []);

  const onSelectProjectTerminal = useCallback((fileId: string) => {
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, dockCwdRef.current, (dock) =>
        selectDockTerminal(dock, fileId),
      ),
    );
    focusProjectTerminal();
  }, [focusProjectTerminal]);

  const onReorderProjectTerminals = useCallback((ids: string[]) => {
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, dockCwdRef.current, (dock) =>
        reorderDockTerminals(dock, orderByIds(dock.pane.files, ids)),
      ),
    );
  }, []);

  const onCloseProjectTerminal = useCallback((fileId: string) => {
    const dock = findProjectTerminal(projectTerminalsRef.current, dockCwdRef.current);
    const file = dock?.pane.files.find((entry) => entry.id === fileId);
    if (!file) return;
    const finishClose = () => {
      setProjectTerminals((prev) =>
        mapProjectTerminal(prev, dockCwdRef.current, (entry) =>
          closeTerminalInDock(entry, fileId),
        ),
      );
    };
    void confirmCloseTerminal(file).then((ok) => ok && finishClose());
  }, []);

  const onTerminalMetaChange = useCallback(
    (fileId: string, patch: TerminalMetaPatch) => {
      setProjectTerminals((prev) =>
        patchProjectTerminals(prev, fileId, patch),
      );
      setTabs((prev) =>
        prev.map((tab) => updateTerminalTab(tab, fileId, patch)),
      );
    },
    [],
  );

  const onToggleRunningTerminal = useCallback(
    (fileId: string) => {
      const dock = projectTerminalsRef.current.find((entry) =>
        entry.pane.files.some((file) => file.id === fileId),
      );
      if (dock) {
        if (dock.open) {
          setProjectTerminals((prev) =>
            mapProjectTerminal(prev, dock.projectPath, (entry) =>
              withDockOpen(entry, false),
            ),
          );
          setProjectTerminalFocused(false);
          return;
        }
        setProjectTerminals((prev) =>
          mapProjectTerminal(prev, dock.projectPath, (entry) =>
            withDockOpen(selectDockTerminal(entry, fileId), true),
          ),
        );
        focusProjectTerminal();
        return;
      }
      for (const tab of tabsRef.current) {
        for (const pane of tab.terminalPanes ?? []) {
          if (!pane.files.some((file) => file.id === fileId)) continue;
          const showing =
            activeTabIdRef.current === tab.id &&
            tab.focusedId === pane.id &&
            pane.activeFileId === fileId;
          if (showing) {
            setComposerFocused(true);
            setProjectTerminalFocused(false);
            return;
          }
          setActiveTabId(tab.id);
          setTabs((prev) =>
            prev.map((entry) => {
              if (entry.id !== tab.id) return entry;
              return withSurfacePanes(
                { ...entry, focusedId: pane.id },
                "terminal",
                (entry.terminalPanes ?? []).map((item) =>
                  item.id === pane.id
                    ? { ...item, activeFileId: fileId }
                    : item,
                ),
              );
            }),
          );
          setProjectTerminalFocused(false);
          setComposerFocused(false);
          return;
        }
      }
    },
    [focusProjectTerminal],
  );

  const onNewTerminalTab = useCallback(() => {
    onOpenTerminal(active?.cwd ?? projectCwd, true);
  }, [active?.cwd, onOpenTerminal, projectCwd]);

  const onCloseTab = useCallback(
    (id: string, opts?: { confirmedTerminalIds?: string[] }) => {
      const current = tabsRef.current;
      const index = current.findIndex((t) => t.id === id);
      if (index < 0) return;
      const closePlan = planWorkspaceTabClose({
        tabs: current,
        sessions: sessionStore.getSnapshot(),
        closingTabId: id,
        scope: tabCloseScope,
      });
      const closing = current[index];
      // Deck mode: a thread chip never closes; archive hides it instead.
      if (
        tabCloseScope === "project" &&
        tabProjectKey(closing, sessionStore.getSnapshot()) !== null
      ) {
        return;
      }
      if (closePlan.action === "keep") return;
      const closingFiles = [
        ...closing.editorPanes.flatMap((pane) => pane.files),
        ...(closing.terminalPanes ?? []).flatMap((pane) => pane.files),
      ];
      const unsaved = closingFiles.filter(
        (file) => isFilesystemTab(file) && dirtyFiles.has(file.id),
      );
      if (
        unsaved.length > 0 &&
        !window.confirm("Close this tab with unsaved files?")
      ) {
        return;
      }

      const finishClose = () => {
        const nextActiveTabId =
          closePlan.action === "close" ? closePlan.nextActiveTabId : undefined;
        setDirtyFiles((prev) => {
          const updated = new Set(prev);
          for (const file of closingFiles) updated.delete(file.id);
          return updated;
        });
        setTabs(current.filter((t) => t.id !== id));
        if (id === activeTabIdRef.current && nextActiveTabId) {
          activateTab(nextActiveTabId);
        }
        void refreshHistory(sidebarCwd);
      };

      const confirmed = new Set(opts?.confirmedTerminalIds ?? []);
      const terminals = closingFiles.filter(
        (file) => file.terminal && !confirmed.has(file.id),
      );
      if (terminals.length > 0) {
        void confirmCloseTerminals(terminals).then((ok) => ok && finishClose());
        return;
      }
      finishClose();
    },
    [dirtyFiles, activateTab, refreshHistory, sidebarCwd, tabCloseScope],
  );

  const onGroupNewTab = useCallback(
    (groupId: string, threadType?: ThreadType) => {
      const groupTab = tabsRef.current.find((tab) => tab.groupId === groupId);
      const sessionInTab = groupTab
        ? sessionStore.getSnapshot().find((session) =>
            leafIds(groupTab.layout).includes(session.id),
          )
        : undefined;
      const ctx = sessionInTab
        ? contextOfSession(sessionInTab, catalogRef.current)
        : sessionContext();
      const session = ctx.projectId
        ? createSessionHere({ projectId: ctx.projectId, threadType })
        : newDefaultSession(ctx.cwd, sessionDefaults?.runtimeMode, { ...ctx, threadType });
      const tab = newTab(session.id);
      setSessions((prev) => [...prev, session]);
      if (threadType) void serverCommands.ensureCreated(session).catch(() => undefined);
      setTabs((prev) => insertTabInGroup(prev, tab, groupId));
      setActiveTabId(tab.id);
      setComposerFocused(true);
    },
    [
      active?.cwd,
      createSessionHere,
      projectCwd,
      sessionDefaults?.runtimeMode,
    ],
  );

  const onGroupCloseTabs = useCallback(
    (tabIds: string[]) => {
      for (const id of tabIds) onCloseTab(id);
    },
    [onCloseTab],
  );

  const onGroupMoveToNewWindow = useCallback(
    async (tabIds: string[]) => {
      const remainingAtMove = tabsRef.current.filter(
        (tab) => !tabIds.includes(tab.id),
      );
      const movingTabs = tabsRef.current.filter((tab) =>
        tabIds.includes(tab.id),
      );
      const splitDocks = splitProjectTerminalsForMove(
        projectTerminalsRef.current,
        movingTabs,
        remainingAtMove,
        sessionStore.getSnapshot(),
      );
      const payload = collectWindowTransfer(
        tabsRef.current,
        sessionStore.getSnapshot(),
        tabIds,
        activeTabIdRef.current,
        dirtyFiles,
        projectCwd,
        splitDocks.moving,
      );
      if (!payload) return;

      const sessionIds = new Set(payload.sessions.map((session) => session.id));
      for (const id of sessionIds) skipForgetSessionIds.current.add(id);

      try {
        await invoke("stage_window_transfer", {
          payload: JSON.stringify(payload),
        });
        await invoke("open_new_window");
      } catch {
        for (const id of sessionIds) skipForgetSessionIds.current.delete(id);
        return;
      }

      setProjectTerminals(splitDocks.remaining);
      const remainingTabs = tabsRef.current.filter(
        (tab) => !tabIds.includes(tab.id),
      );
      if (remainingTabs.length === 0) {
        const seedSession = sessionStore.getSnapshot().find((session) =>
          sessionIds.has(session.id),
        );
        const ctx = seedSession
          ? contextOfSession(seedSession, catalogRef.current)
          : sessionContext();
        const session = newSession(
          seedSession?.harness ?? "claude",
          ctx.cwd,
          seedSession?.model,
          seedSession?.runtimeMode,
          seedSession?.modelSettings,
          ctx,
        );
        const tab = newTab(session.id);
        setSessions((prev) => [
          ...prev.filter((entry) => !sessionIds.has(entry.id)),
          session,
        ]);
        setTabs([tab]);
        setActiveTabId(tab.id);
      } else {
        setTabs(remainingTabs);
        setSessions((prev) =>
          prev.filter((session) => !sessionIds.has(session.id)),
        );
        if (tabIds.includes(activeTabIdRef.current)) {
          activateTab(remainingTabs[0]?.id ?? activeTabIdRef.current);
        }
      }

      setDirtyFiles((prev) => {
        const next = new Set(prev);
        for (const id of payload.dirtyFileIds) next.delete(id);
        return next;
      });

      for (const id of sessionIds) skipForgetSessionIds.current.delete(id);
    },
    [activateTab, dirtyFiles, projectCwd],
  );

  const onCloseFile = useCallback(
    (paneId: string, fileId: string) => {
      const tab = tabsRef.current.find((entry) =>
        findSurfacePane(entry, paneId),
      );
      if (!tab) return;
      const found = findSurfacePane(tab, paneId);
      if (!found) return;
      const { kind, pane } = found;
      const index = pane.files.findIndex((file) => file.id === fileId);
      if (index < 0) return;
      const file = pane.files[index];
      const confirmDiscard = () =>
        window.confirm(`Close ${basename(file.path)} without saving?`);

      const finishClose = () => {
        const files = pane.files.filter((entry) => entry.id !== fileId);
        let nextFocus = tab.focusedId;
        let nextLayout = tab.layout;
        let nextPanes = surfacePanes(tab, kind);
        if (files.length > 0) {
          nextFocus = paneId;
          const activeFileId =
            pane.activeFileId === fileId
              ? files[Math.min(index, files.length - 1)].id
              : pane.activeFileId;
          nextPanes = nextPanes.map((entry) =>
            entry.id === paneId ? { ...entry, files, activeFileId } : entry,
          );
        } else {
          const sibling = siblingLeafId(tab.layout, paneId);
          const withoutPane = removePane(tab.layout, paneId);
          if (!withoutPane) {
            setDirtyFiles((prev) => {
              const next = new Set(prev);
              next.delete(fileId);
              return next;
            });
            const closePlan = planWorkspaceTabClose({
              tabs: tabsRef.current,
              sessions: sessionStore.getSnapshot(),
              closingTabId: tab.id,
              scope: tabCloseScope,
            });
            if (closePlan.action === "close") {
              onCloseTab(
                tab.id,
                file.terminal ? { confirmedTerminalIds: [fileId] } : undefined,
              );
              return;
            }
            const seed = sessionStore.getSnapshot()[0];
            const ctx = cwdContext(file.cwd || projectCwd);
            const session = newSession(
              seed?.harness ?? "claude",
              ctx.cwd,
              seed?.model,
              seed?.runtimeMode,
              seed?.modelSettings,
              ctx,
            );
            setSessions((prev) => [...prev, session]);
            setTabs((prev) =>
              prev.map((entry) =>
                entry.id === tab.id
                  ? {
                      ...entry,
                      layout: leaf(session.id),
                      focusedId: session.id,
                      editorPanes: [],
                      terminalPanes: [],
                      diffOpen: false,
                      diffFocused: false,
                    }
                  : entry,
              ),
            );
            setComposerFocused(true);
            return;
          }
          nextLayout = withoutPane;
          nextFocus =
            tab.focusedId === paneId
              ? (sibling ?? firstLeafId(withoutPane))
              : tab.focusedId;
          nextPanes = nextPanes.filter((entry) => entry.id !== paneId);
        }

        setTabs((prev) =>
          prev.map((entry) =>
            entry.id === tab.id
              ? withSurfacePanes(
                  {
                    ...entry,
                    layout: nextLayout,
                    focusedId: nextFocus,
                  },
                  kind,
                  nextPanes,
                )
              : entry,
          ),
        );
        setDirtyFiles((prev) => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
        if (tab.id === activeTabId && files.length === 0) {
          setComposerFocused(
            sessionStore.getSnapshot().some((session) => session.id === nextFocus),
          );
        }
      };

      if (file.terminal) {
        void confirmCloseTerminal(file).then((ok) => ok && finishClose());
        return;
      }
      if (isFilesystemTab(file) && dirtyFiles.has(fileId)) {
        // Autosave on: write now and close quietly; only a failed write asks.
        void (loadAutoSave() ? flushEditor(file.path) : Promise.resolve(false)).then(
          (saved) => {
            if (saved || confirmDiscard()) finishClose();
          },
        );
        return;
      }
      finishClose();
    },
    [activeTabId, dirtyFiles, onCloseTab, projectCwd, tabCloseScope],
  );

  const onClearTabSession = useCallback(
    (id: string) => {
      const tab = tabs.find((entry) => entry.id === id);
      if (!tab || isBlankWorkspaceTab(tab, sessionStore.getSnapshot())) return;

      const closingFiles = [
        ...tab.editorPanes.flatMap((pane) => pane.files),
        ...(tab.terminalPanes ?? []).flatMap((pane) => pane.files),
      ];
      const unsaved = closingFiles.filter(
        (file) => isFilesystemTab(file) && dirtyFiles.has(file.id),
      );
      if (
        unsaved.length > 0 &&
        !window.confirm("Close this conversation with unsaved files?")
      ) {
        return;
      }

      const oldSessionId = leafIds(tab.layout).find((paneId) =>
        sessionStore.getSnapshot().some((session) => session.id === paneId),
      );
      const oldSession = sessionStore.getSnapshot().find(
        (session) => session.id === oldSessionId,
      );
      if (!oldSession) return;

      const session = newSession(
        oldSession.harness,
        oldSession.cwd,
        oldSession.model,
        oldSession.runtimeMode,
        oldSession.modelSettings,
        contextOfSession(oldSession, catalogRef.current),
      );

      setSessions((prev) => [...prev, session]);
      setDirtyFiles((prev) => {
        const updated = new Set(prev);
        for (const file of closingFiles) updated.delete(file.id);
        return updated;
      });
      setTabs((prev) =>
        prev.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                layout: leaf(session.id),
                focusedId: session.id,
                editorPanes: [],
                terminalPanes: [],
                diffOpen: false,
                diffFocused: false,
              }
            : entry,
        ),
      );
      setComposerFocused(true);
      void refreshHistory(sidebarCwd);
    },
    [tabs, dirtyFiles, refreshHistory, sidebarCwd],
  );

  const onClosePane = useCallback(
    (sessionId?: string) => {
      if (
        sessionId === undefined &&
        deckLayout &&
        projectTerminalFocused
      ) {
        const dock = findProjectTerminal(projectTerminalsRef.current, dockCwdRef.current);
        if (dock) {
          onCloseProjectTerminal(dock.pane.activeFileId);
          return;
        }
      }
      if (!activeTab) return;
      if (
        !deckLayout &&
        sessionId === undefined &&
        activeTab.diffOpen &&
        activeTab.diffFocused
      ) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === activeTab.id
              ? {
                  ...tab,
                  diffOpen: false,
                  diffFocused: false,
                }
              : tab,
          ),
        );
        return;
      }
      const focusedSurface = findSurfacePane(activeTab, activeTab.focusedId);
      if (sessionId === undefined && focusedSurface) {
        onCloseFile(focusedSurface.pane.id, focusedSurface.pane.activeFileId);
        return;
      }
      const closingId = sessionId ?? activeTab.focusedId;
      const ids = leafIds(activeTab.layout);
      const sessionIds = ids.filter((paneId) =>
        sessionStore.getSnapshot().some((session) => session.id === paneId),
      );
      if (!sessionIds.includes(closingId)) return;
      const nextTab = closeLeaf(activeTab, closingId);
      if (!nextTab) {
        // Deck mode: ⌘W never removes a thread from the strip.
        if (deckLayout) return;
        const closePlan = planWorkspaceTabClose({
          tabs: tabsRef.current,
          sessions: sessionStore.getSnapshot(),
          closingTabId: activeTab.id,
          scope: tabCloseScope,
        });
        if (closePlan.action === "keep") onClearTabSession(activeTab.id);
        else onCloseTab(activeTab.id);
        return;
      }
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? { ...t, layout: nextTab.layout, focusedId: nextTab.focusedId }
            : t,
        ),
      );
      if (closingId === activeTab.focusedId) {
        setComposerFocused(
          nextTab &&
            sessionStore.getSnapshot().some(
              (session) => session.id === nextTab.focusedId,
            ),
        );
      }
      void refreshHistory(sidebarCwd);
    },
    [
      activeTab,
      deckLayout,
      onCloseFile,
      onCloseProjectTerminal,
      onCloseTab,
      onClearTabSession,
      projectTerminalFocused,
      refreshHistory,
      sidebarCwd,
      tabCloseScope,
    ],
  );

  // Deck mode shows the selected project's tabs, keyed by server project id.
  // Loose chats and projectless drafts only show while no project is selected.
  const deckProjectTabs = useMemo(() => {
    if (!deckLayout) return tabs;
    return filterTabsForProjectId(tabs, sessions, selectedProjectId).filter(
      (tab) => !tabArchived(tab, sessions),
    );
  }, [deckLayout, tabs, sessions, selectedProjectId]);

  /** Tabs in strip order: the live row, then the dormant shelf. */
  const cycleScope = useCallback(() => {
    if (!deckLayout) return tabs;
    const byId = new Map(deckProjectTabs.map((tab) => [tab.id, tab]));
    return stripTabsRef.current
      .map((id) => byId.get(id))
      .filter((tab): tab is WorkspaceTab => tab != null);
  }, [deckLayout, deckProjectTabs, tabs]);

  const onNext = useCallback(() => {
    const scope = cycleScope();
    const index = scope.findIndex((t) => t.id === activeTabId);
    if (index >= 0) activateTab(scope[(index + 1) % scope.length].id);
  }, [activateTab, activeTabId, cycleScope]);

  const onPrev = useCallback(() => {
    const scope = cycleScope();
    const index = scope.findIndex((t) => t.id === activeTabId);
    if (index >= 0) {
      activateTab(scope[(index - 1 + scope.length) % scope.length].id);
    }
  }, [activateTab, activeTabId, cycleScope]);

  const onVisitBack = useCallback(() => {
    const openIds = new Set(tabsRef.current.map((tab) => tab.id));
    const pruned = pruneTabVisitHistory(
      tabVisitRef.current,
      openIds,
      activeTabIdRef.current,
    );
    const next = tabVisitBack(pruned);
    if (!next || !openIds.has(next.current)) return;
    tabVisitFromHistoryRef.current = true;
    commitTabVisit(next);
    activateTab(next.current);
  }, [activateTab, commitTabVisit]);

  const onVisitForward = useCallback(() => {
    const openIds = new Set(tabsRef.current.map((tab) => tab.id));
    const pruned = pruneTabVisitHistory(
      tabVisitRef.current,
      openIds,
      activeTabIdRef.current,
    );
    const next = tabVisitForward(pruned);
    if (!next || !openIds.has(next.current)) return;
    tabVisitFromHistoryRef.current = true;
    commitTabVisit(next);
    activateTab(next.current);
  }, [activateTab, commitTabVisit]);

  const onActivate = useCallback(
    (slot: number) => {
      const scope = cycleScope();
      const tab = slot < 0 ? scope[scope.length - 1] : scope[slot];
      if (tab) activateTab(tab.id);
    },
    [activateTab, cycleScope],
  );

  const onFocusPane = useCallback(
    (paneId: string) => {
      setProjectTerminalFocused(false);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? { ...t, focusedId: paneId, diffFocused: false }
            : t,
        ),
      );
      setComposerFocused(
        sessionStore.getSnapshot().some((session) => session.id === paneId),
      );
    },
    [activeTabId],
  );

  const onOpenDiff = useCallback(
    (path?: string) => {
      void (async () => {
        const resolved = path
          ? ((await resolveOpenablePath(gitCwdRef.current, path)) ?? path)
          : undefined;
        if (resolved) rememberOpenedFile(sidebarCwdRef.current, resolved);
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== activeTabIdRef.current) return tab;
            const opened = resolved
              ? openEditorTab(
                  tab,
                  newFileTab(
                    resolved,
                    sidebarCwdRef.current,
                    true,
                    editorForPath(resolved) === "monaco" ? "monaco" : undefined,
                  ),
                )
              : tab;
            if (deckLayoutRef.current) return opened;
            return {
              ...opened,
              diffOpen: true,
              diffFocused: !resolved,
            };
          }),
        );
        if (deckLayoutRef.current) {
          setSidebarOpen(true);
          saveSidebarOpen(true);
          setSidebarTab("changes");
        }
        setComposerFocused(false);
      })();
    },
    [],
  );

  const onToggleDiff = useCallback(() => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === activeTabId
          ? {
              ...tab,
              diffOpen: !tab.diffOpen,
              diffFocused: !tab.diffOpen,
            }
          : tab,
      ),
    );
    setComposerFocused(false);
  }, [activeTabId]);

  const onFocusDiff = useCallback(() => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === activeTabId ? { ...tab, diffFocused: true } : tab,
      ),
    );
    setComposerFocused(false);
  }, [activeTabId]);

  const onShowSourceControl = useCallback(() => {
    setSidebarOpen(true);
    saveSidebarOpen(true);
    setSidebarTab("changes");
  }, []);

  const onToggleChanges = useCallback(() => {
    if (deckLayout) onShowSourceControl();
    else onToggleDiff();
  }, [deckLayout, onShowSourceControl, onToggleDiff]);

  const onReorderTabs = useCallback(
    (ids: string[], movedId?: string) => {
      setTabs((prev) => {
        if (movedId) {
          return applyGroupedReorder(prev, ids, movedId, projectOfTab) ?? prev;
        }
        return orderByIds(prev, ids);
      });
    },
    [projectOfTab],
  );

  const onJoinTab = useCallback(
    (draggedId: string, targetId: string) => {
      if (deckLayout) return;
      setTabs(
        (prev) =>
          joinTabOnto(prev, draggedId, targetId, undefined, projectOfTab)
            ?.tabs ?? prev,
      );
    },
    [deckLayout, projectOfTab],
  );

  const onJoinTabToGroup = useCallback(
    (tabId: string, groupId: string) => {
      if (deckLayout) return;
      setTabs((prev) => addTabToGroup(prev, tabId, groupId, projectOfTab));
    },
    [deckLayout, projectOfTab],
  );

  const onAddToNewGroup = useCallback(
    (tabId: string) => {
      if (deckLayout) return;
      const groupId = newTabGroupId();
      setTabs((prev) => addTabsToNewGroup(prev, [tabId], groupId));
    },
    [deckLayout],
  );

  const onAddToGroup = useCallback(
    (tabId: string, groupId: string) => {
      if (deckLayout) return;
      setTabs((prev) => addTabToGroup(prev, tabId, groupId, projectOfTab));
    },
    [deckLayout, projectOfTab],
  );

  const onRemoveFromGroup = useCallback((tabId: string) => {
    setTabs((prev) => removeTabFromGroup(prev, tabId));
  }, []);

  const onUngroup = useCallback((groupId: string) => {
    setTabs((prev) => ungroupTabs(prev, groupId));
  }, []);

  const onReorderFiles = useCallback((paneId: string, ids: string[]) => {
    setTabs((prev) =>
      prev.map((tab) => {
        const found = findSurfacePane(tab, paneId);
        if (!found) return tab;
        return withSurfacePanes(
          tab,
          found.kind,
          surfacePanes(tab, found.kind).map((pane) =>
            pane.id === paneId
              ? { ...pane, files: orderByIds(pane.files, ids) }
              : pane,
          ),
        );
      }),
    );
  }, []);

  const onMovePane = useCallback(
    (fromId: string, toId: string, edge: PaneEdge) => {
      setTabs((prev) =>
        prev.map((tab) => {
          return leafIds(tab.layout).includes(fromId)
            ? {
                ...tab,
                layout: movePane(tab.layout, fromId, toId, edge),
                focusedId: fromId,
              }
            : tab;
        }),
      );
    },
    [],
  );

  const focusOpenSession = useCallback((sessionId: string) => {
    const tab = tabsRef.current.find((entry) =>
      leafIds(entry.layout).includes(sessionId),
    );
    if (!tab) return false;
    // activateTab brings the tab's workspace forward too (deck filter).
    activateTab(tab.id);
    setTabs((prev) =>
      prev.map((entry) =>
        entry.id === tab.id ? { ...entry, focusedId: sessionId } : entry,
      ),
    );
    setComposerFocused(true);
    return true;
  }, [activateTab]);

  const replaceBlankPaneWithSession = useCallback((session: Session) => {
    const tab =
      tabsRef.current.find((entry) => entry.id === activeTabIdRef.current) ??
      tabsRef.current[0];
    if (!tab) return false;

    const paneId = isBlankSession(
      sessionStore.getSnapshot().find((entry) => entry.id === tab.focusedId),
    )
      ? tab.focusedId
      : leafIds(tab.layout).find((id) =>
          isBlankSession(sessionStore.getSnapshot().find((entry) => entry.id === id)),
        );
    if (!paneId || paneId === session.id) return false;

    {
      const blank = sessionStore.getSnapshot().find((entry) => entry.id === paneId);
      if (blank) void forgetHarnessSession(blank.harness, paneId);
    }
    setSessions((prev) => {
      const next = prev.filter((entry) => entry.id !== paneId);
      return next.some((entry) => entry.id === session.id)
        ? next
        : [...next, session];
    });
    setTabs((prev) =>
      prev.map((entry) =>
        entry.id === tab.id
          ? {
              ...entry,
              layout: replaceLeafId(entry.layout, paneId, session.id),
              focusedId: session.id,
            }
          : entry,
      ),
    );
    setActiveTabId(tab.id);
    setComposerFocused(true);
    return true;
  }, []);

  const ensureOpenSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      const open = sessionStore.getSnapshot().find(
        (session) => session.id === sessionId,
      );
      if (open) return open;

      const loaded = await getSession(sessionId).catch(() => null);
      if (!loaded) {
        void refreshHistory(sidebarCwd);
        return null;
      }
      const restored = await restoreSessionCheckout(loaded);
      if (!sessionStore.getSnapshot().some((session) => session.id === restored.id)) {
        // The store update re-renders before the caller's tab lands, and the
        // hidden-session sweep would drop the session in that gap. Shield it
        // until the caller's synchronous continuation has run.
        skipForgetSessionIds.current.add(restored.id);
        setTimeout(() => skipForgetSessionIds.current.delete(restored.id), 0);
        setSessions([...sessionStore.getSnapshot(), restored]);
      }
      return restored;
    },
    [refreshHistory, sidebarCwd],
  );

  /** A view's jump to another thread (the plan's handoff chip). */
  const onOpenSessionById = useCallback(
    (sessionId: string) => {
      void onSelectHistorySession(sessionId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const openSessionBesideRef = useRef<
    ((sourceId: string, session: Session, cwd: string, focusComposer?: boolean) => void) | null
  >(null);
  // A thread from another workspace (a search hit, a server-created thread)
  // brings its workspace forward, or the deck filter would hide the tab we
  // are about to open and the rail and sessions list would disagree.
  const selectWorkspaceOfSession = useCallback(
    (session: Pick<Session, "cwd" | "projectId" | "workspaceId">) => {
      const path = normalizeProjectPath(workspacePathOfSession(session, catalogRef.current));
      if (looksLikeProject(path) && !sameProjectPath(projectCwdRef.current, path)) {
        setProjectCwd(path);
        setRecents(rememberProject(path));
      }
    },
    [],
  );

  const onSelectHistorySession = useCallback(
    async (sessionId: string, seq?: number) => {
      // A search hit's row: the transcript picks the request up once its
      // history holds that seq (lib/transcriptJump.ts), whether the thread is
      // already on screen or opens below.
      if (seq !== undefined) requestTranscriptJump(sessionId, seq);
      if (focusOpenSession(sessionId)) return;
      const session = await ensureOpenSession(sessionId);
      if (!session) return;
      selectWorkspaceOfSession(session);
      // A subagent splits beside its parent and never gets a tab of its own.
      if (session.parentId) {
        const parentId = session.parentId;
        if (!tabsRef.current.some((tab) => leafIds(tab.layout).includes(parentId))) {
          const parent = await ensureOpenSession(parentId);
          if (!parent) return;
          const tab = newTab(parent.id);
          appendTab(tab, parent.cwd);
          setActiveTabId(tab.id);
        }
        openSessionBesideRef.current?.(parentId, session, session.cwd, true);
        return;
      }
      if (replaceBlankPaneWithSession(session)) return;
      const tab = newTab(session.id);
      appendTab(tab, session.cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
    },
    [
      appendTab,
      ensureOpenSession,
      focusOpenSession,
      replaceBlankPaneWithSession,
      selectWorkspaceOfSession,
    ],
  );

  // A thread the server created whole after boot — a plan's Start button or
  // a model's app_start_thread — opens as a tab in its project's group.
  useEffect(
    () =>
      sessionStore.onSessionAdded((meta) => {
        void onSelectHistorySession(meta.id);
      }),
    [onSelectHistorySession],
  );

  const onRenameHistorySession = useCallback(
    async (sessionId: string, displayTitle: string) => {
      const trimmed = displayTitle.trim();
      if (!trimmed) return;

      const open = sessionStore.getSnapshot().find(
        (session) => session.id === sessionId,
      );
      if (open) {
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionId ? { ...session, title: trimmed } : session,
          ),
        );
      }
      await serverCommands.rename(sessionId, trimmed).catch(() => undefined);
      void refreshHistory(sidebarCwd);
    },
    [refreshHistory, sidebarCwd],
  );

  const onArchiveHistorySession = useCallback(
    async (sessionId: string, archived: boolean) => {
      const open = sessionStore.getSnapshot().find(
        (session) => session.id === sessionId,
      );
      if (open) {
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionId ? { ...session, archived } : session,
          ),
        );
      }
      if (archived) {
        // The chip leaves the strip; its same-slot neighbour takes selection.
        const model = headerModelRef.current;
        if (model.activeId === sessionId) {
          const next = headerNeighbour(model, sessionId);
          if (next?.tabId) activateTab(next.tabId);
          else if (next) void onSelectHistorySession(next.id);
        }
      }
      await setSessionArchived(sessionId, archived).catch(() => undefined);
      setHistory((current) => {
        const existing = current.find((entry) => entry.id === sessionId);
        if (existing) {
          return current.map((entry) =>
            entry.id === sessionId ? { ...entry, archived } : entry,
          );
        }
        if (!open) return current;
        return mergeHistorySummary(current, {
          ...summaryFromSession(open),
          archived,
        });
      });
    },
    [activateTab, onSelectHistorySession],
  );

  const onRestoreThread = useCallback(
    async (sessionId: string) => {
      await onArchiveHistorySession(sessionId, false);
      void onSelectHistorySession(sessionId);
    },
    [onArchiveHistorySession, onSelectHistorySession],
  );

  const onDeleteHistorySession = useCallback(
    async (sessionId: string, options?: { confirmed?: boolean }) => {
      const open = sessionStore.getSnapshot().find(
        (session) => session.id === sessionId,
      );
      const summary =
        historyStore.get().find((entry) => entry.id === sessionId) ?? open ?? null;
      const label = summary
        ? sessionDisplayTitle(summary.title, summary.harness)
        : "this session";

      if (!options?.confirmed && !window.confirm(`Delete “${label}”?`)) return;

      if (open?.busy) {
        turnGen.current.set(
          sessionId,
          (turnGen.current.get(sessionId) ?? 0) + 1,
        );
        for (const id of sessionChildHarnesses(open)) {
          void cancelHarnessTurn(id, sessionId);
        }
      }

      const harness = open?.harness ?? summary?.harness ?? "cursor";
      if (open) {
        for (const id of sessionChildHarnesses(open)) {
          void forgetHarnessSession(id, sessionId);
        }
      } else {
        void forgetHarnessSession(harness, sessionId);
      }
      await deleteSession(sessionId).catch(() => undefined);

      if (
        !tabsRef.current.some((tab) => leafIds(tab.layout).includes(sessionId))
      ) {
        setSessions((prev) =>
          prev.filter((session) => session.id !== sessionId),
        );
        void refreshHistory(sidebarCwd);
        return;
      }

      const {
        tabs: nextTabs,
        sessions: nextSessions,
        activeTabId: nextActiveTabId,
      } = applyDeletedSessionToWorkspace({
        tabs: tabsRef.current,
        sessions: sessionStore.getSnapshot(),
        sessionId,
        activeTabId: activeTabIdRef.current,
        scope: tabCloseScope,
        createReplacement: (seed) =>
          newSession(
            seed?.harness ?? harness,
            seed?.cwd ?? summary?.cwd ?? sidebarCwd,
            seed?.model ?? summary?.model,
            seed?.runtimeMode ?? summary?.runtimeMode,
            seed?.modelSettings,
            seed
              ? contextOfSession(seed, catalogRef.current)
              : cwdContext(summary?.cwd ?? sidebarCwd),
          ),
      });

      setSessions(nextSessions);
      setTabs(nextTabs);
      if (nextActiveTabId !== activeTabIdRef.current) {
        activateTab(nextActiveTabId);
      }
      setComposerFocused(
        nextSessions.some((session) => {
          const tab = nextTabs.find((entry) => entry.id === nextActiveTabId);
          return !!tab && session.id === tab.focusedId;
        }),
      );
      void refreshHistory(sidebarCwd);
    },
    [activateTab, refreshHistory, sidebarCwd, tabCloseScope],
  );

  const onFocusDir = useCallback(
    (dir: FocusDir) => {
      if (!activeTab) return;
      const next = neighborLeafId(activeTab.layout, activeTab.focusedId, dir);
      if (next) onFocusPane(next);
    },
    [activeTab, onFocusPane],
  );

  const onRatio = useCallback(
    (tabId: string, splitId: string, index: number, ratio: number) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, layout: setSplitRatio(t.layout, splitId, index, ratio) }
            : t,
        ),
      );
    },
    [],
  );

  const onCwdChange = useCallback(
    (sessionId: string, cwd: string) => {
      const normalized = normalizeProjectPath(cwd);
      const current = sessionStore.getSnapshot().find((s) => s.id === sessionId);
      const previous = current?.cwd;
      // Threads stay bound to their project. Switching from the composer opens a
      // new tab instead of retargeting the conversation.
      if (
        current &&
        previous &&
        looksLikeProject(previous) &&
        !sameProjectPath(previous, normalized) &&
        !isBlankSession(current)
      ) {
        setProjectCwd(normalized);
        setRecents(rememberProject(normalized));
        const session = newSession(
          current.harness,
          normalized,
          current.model,
          current.runtimeMode,
          current.modelSettings,
          cwdContext(normalized),
        );
        const tab = newTab(session.id);
        setSessions((prev) => [...prev, session]);
        appendTab(tab, normalized);
        setActiveTabId(tab.id);
        setComposerFocused(true);
        return;
      }
      if (
        previous &&
        !sameProjectPath(previous, normalized) &&
        previous !== "~"
      ) {
        void keepSessionChanges(sessionId, previous).catch(() => undefined);
      }
      setProjectCwd(normalized);
      setRecents(rememberProject(normalized));
      const moved = cwdContext(normalized);
      // A blank draft moving between workspaces takes the new one's defaults.
      const fresh = current && isBlankSession(current) ? seededSession(moved, normalized, current) : null;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                ...(fresh
                  ? {
                      harness: fresh.harness,
                      model: fresh.model,
                      runtimeMode: fresh.runtimeMode,
                      modelSettings: fresh.modelSettings,
                    }
                  : {}),
                cwd: normalized,
                projectId: moved.projectId,
                workspaceId: moved.workspaceId,
                branch: undefined,
                worktreeCwd: undefined,
              }
            : s,
        ),
      );
      // The session's project just moved in place; a group only holds tabs that
      // share one project, so drop this tab out if it no longer matches.
      setTabs((prev) => {
        const tab = prev.find((t) => leafIds(t.layout).includes(sessionId));
        // The tab's visible project follows its focused pane; a background
        // pane changing project doesn't change what the group check should see.
        if (!tab?.groupId || tab.focusedId !== sessionId) return prev;
        const newProject = projectName(normalized);
        const othersProject = tabGroupProject(
          prev.filter((t) => t.id !== tab.id),
          tab.groupId,
          projectOfTab,
        );
        if (othersProject && newProject && othersProject !== newProject) {
          return removeTabFromGroup(prev, tab.id);
        }
        return prev;
      });
      notifyReviewChanged(sessionId);
    },
    [appendTab, cwdContext, projectOfTab, seededSession],
  );

  const onBranchChange = useCallback(
    (sessionId: string) => {
      notifyGitChanged();
      const current = sessionStore.getSnapshot().find((s) => s.id === sessionId);
      if (!current || (!current.branch && !current.worktreeCwd)) return;
      if (current.worktreeCwd && current.providerSessionId) {
        void forgetHarnessSession(current.harness, sessionId);
      }
      const next = {
        ...current,
        branch: undefined,
        worktreeCwd: undefined,
        ...(current.worktreeCwd ? { providerSessionId: undefined } : {}),
      };
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? next : s)),
      );
      notifyReviewChanged(sessionId);
    },
    [],
  );

  const onSelectProject = useCallback(
    (path: string) => {
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      const normalized = normalizeProjectPath(path);
      if (!looksLikeProject(normalized)) return;

      const activeWorkspace = tabsRef.current.find(
        (entry) => entry.id === activeTabIdRef.current,
      );
      const current = activeWorkspace
        ? sessionStore.getSnapshot().find(
            (session) => session.id === activeWorkspace.focusedId,
          )
        : undefined;
      const currentCwd =
        current?.cwd ??
        (activeWorkspace ? focusedFileTab(activeWorkspace)?.cwd : undefined);
      if (currentCwd && sameProjectPath(currentCwd, normalized)) return;

      if (current && isBlankSession(current)) {
        onCwdChange(current.id, normalized);
        return;
      }

      const match = findTabForProject(
        tabsRef.current,
        rebaseToWorkspace(sessionStore.getSnapshot(), catalogRef.current),
        normalized,
      );
      if (match) {
        setProjectCwd(normalized);
        setRecents(rememberProject(normalized));
        activateTab(match.id);
        return;
      }

      const seed = current ?? sessionStore.getSnapshot()[0];
      const session = seededSession(cwdContext(normalized), normalized, seed);
      const tab = newTab(session.id);
      setProjectCwd(normalized);
      setRecents(rememberProject(normalized));
      setSessions((prev) => [...prev, session]);
      appendTab(tab, normalized);
      setActiveTabId(tab.id);
      setComposerFocused(true);
    },
    [activateTab, appendTab, cwdContext, onCwdChange, seededSession],
  );

  const [newWorkspacePath, setNewWorkspacePath] = useState<string | null>(null);
  const pickProject = useCallback(async () => {
    const path = await pickFolder();
    if (!path) return;
    // A folder the catalog knows just comes forward; a new one gets the
    // New Workspace dialog (turn pass) before it joins.
    if (workspaceByPath(workspaceStore.workspaces, path)) onSelectProject(path);
    else setNewWorkspacePath(path);
  }, [onSelectProject]);

  const onRemoveProject = useCallback(
    (path: string, options: { purgeData: boolean }) => {
      const normalized = normalizeProjectPath(path);
      const wasCurrent = sameProjectPath(projectCwdRef.current, normalized);
      const remaining = options.purgeData
        ? forgetProject(normalized)
        : archiveProject(normalized);
      setRecents(remaining);

      const tabs = tabsRef.current;
      const sessions = sessionStore.getSnapshot();
      const rebased = rebaseToWorkspace(sessions, catalogRef.current);
      const projectTabs = filterTabsForProject(tabs, rebased, normalized);
      const projectTabIds = new Set(projectTabs.map((tab) => tab.id));
      const projectSessions = sessions.filter((_, index) =>
        sameProjectPath(rebased[index].cwd, normalized),
      );
      if (options.purgeData) {
        const workspace = workspaceByPath(catalogRef.current.workspaces, normalized);
        if (workspace) void deleteWorkspace(workspace.id).catch(() => undefined);
      }
      const projectSessionIds = new Set(
        projectSessions.map((session) => session.id),
      );

      if (options.purgeData) {
        for (const session of projectSessions) {
          if (session.busy) {
            turnGen.current.set(
              session.id,
              (turnGen.current.get(session.id) ?? 0) + 1,
            );
            for (const id of sessionChildHarnesses(session)) {
              void cancelHarnessTurn(id, session.id);
            }
          }
          for (const id of sessionChildHarnesses(session)) {
            void forgetHarnessSession(id, session.id);
          }
        }
        void removeProjectData(normalized);
      } else {
        for (const session of projectSessions) {
          if (session.busy) continue;
          for (const id of sessionChildHarnesses(session)) {
            void forgetHarnessSession(id, session.id);
          }
        }
      }

      let nextTabs = tabs.filter((tab) => !projectTabIds.has(tab.id));
      let nextSessions = sessions.filter((session) => {
        if (!projectSessionIds.has(session.id)) return true;
        return !options.purgeData && session.busy;
      });
      let nextActiveTabId = activeTabIdRef.current;

      if (nextTabs.length === 0) {
        const fallback = nextSessions[0];
        const session = newDefaultSession("~", fallback?.runtimeMode);
        const tab = newTab(session.id);
        nextSessions = [...nextSessions, session];
        nextTabs = [tab];
        nextActiveTabId = tab.id;
      } else if (projectTabIds.has(nextActiveTabId)) {
        nextActiveTabId = nextTabs[0]?.id ?? nextActiveTabId;
      }

      tabsRef.current = nextTabs;
      activeTabIdRef.current = nextActiveTabId;
      setSessions(nextSessions);
      setTabs(nextTabs);
      if (nextActiveTabId !== activeTabId) {
        setActiveTabId(nextActiveTabId);
      }
      setDirtyFiles((prev) => {
        const updated = new Set(prev);
        for (const tab of projectTabs) {
          for (const file of [
            ...tab.editorPanes.flatMap((pane) => pane.files),
            ...(tab.terminalPanes ?? []).flatMap((pane) => pane.files),
          ]) {
            updated.delete(file.id);
          }
        }
        return updated;
      });
      setProjectTerminals((prev) =>
        prev.filter((dock) => !sameProjectPath(dock.projectPath, normalized)),
      );

      if (wasCurrent) {
        const next = remaining.find((item) => looksLikeProject(item.path));
        if (next) {
          onSelectProject(next.path);
          setProjectCwd(next.path);
        } else {
          setProjectCwd("~");
          setComposerFocused(true);
        }
      }
    },
    [activeTabId, onSelectProject],
  );

  const onRestoreProject = useCallback(
    (path: string) => {
      setRecents(rememberProject(path));
      onSelectProject(path);
    },
    [onSelectProject],
  );

  const onFileMoved = useCallback((from: string, to: string) => {
    invalidateProjectFiles();
    setTabs((prev) =>
      prev.map((tab) => {
        return {
          ...tab,
          editorPanes: tab.editorPanes.map((pane) => ({
            ...pane,
            files: pane.files.map((file) =>
              isFilesystemTab(file)
                ? { ...file, path: rebasePath(file.path, from, to) }
                : file,
            ),
          })),
        };
      }),
    );
  }, []);

  const onFileDeleted = useCallback((path: string) => {
    invalidateProjectFiles();
    const dropped = new Set<string>();
    for (const tab of tabsRef.current) {
      for (const pane of tab.editorPanes) {
        for (const file of pane.files) {
          if (isFilesystemTab(file) && isEqualOrInside(file.path, path)) {
            dropped.add(file.id);
          }
        }
      }
    }
    setTabs((prev) =>
      prev.map((tab) =>
        dropOpenFiles(tab, (filePath) => isEqualOrInside(filePath, path)),
      ),
    );
    if (dropped.size === 0) return;
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      for (const id of dropped) next.delete(id);
      return next;
    });
  }, []);

  const onOpenFile = useCallback<OpenFileFn>(
    (path, navigation, options) => {
      void (async () => {
        const resolved =
          (await resolveOpenablePath(gitCwdRef.current, path)) ?? path;
        rememberOpenedFile(sidebarCwdRef.current, resolved);
        const tab = tabsRef.current.find((entry) => entry.id === activeTabIdRef.current);
        if (!tab) return;
        const editor = options?.editor ?? editorForPath(resolved);
        const file = newFileTab(
          resolved,
          sidebarCwdRef.current,
          false,
          editor === "monaco" ? "monaco" : undefined,
        );
        setTabs((prev) =>
          prev.map((entry) =>
            entry.id === tab.id ? openEditorTab(entry, file) : entry,
          ),
        );
        if (navigation) {
          editorNavigationToken.current += 1;
          setEditorNavigation({
            path: resolved,
            ...navigation,
            token: editorNavigationToken.current,
          });
        }
        setComposerFocused(false);
      })();
    },
    // Reads the active tab through its ref: the identity stays put across
    // tab switches, so the memoised transcripts under it do too.
    [],
  );

  const onFileDirtyChange = useCallback((fileId: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      if (prev.has(fileId) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(fileId);
      else next.delete(fileId);
      return next;
    });
  }, []);

  /** The editor reports 0 as it unmounts, so closed tabs drop out on their own. */
  const onFileErrorCountChange = useCallback(
    (fileId: string, count: number) => {
      setFileErrorCounts((prev) => {
        if ((prev.get(fileId) ?? 0) === count) return prev;
        const next = new Map(prev);
        if (count > 0) next.set(fileId, count);
        else next.delete(fileId);
        return next;
      });
    },
    [],
  );

  const onSelectFileSurface = useCallback((paneId: string, fileId: string) => {
    setTabs((prev) =>
      prev.map((tab) => {
        const found = findSurfacePane(tab, paneId);
        if (!found) return tab;
        return withSurfacePanes(
          { ...tab, focusedId: paneId },
          found.kind,
          surfacePanes(tab, found.kind).map((pane) =>
            pane.id === paneId ? { ...pane, activeFileId: fileId } : pane,
          ),
        );
      }),
    );
    setComposerFocused(false);
  }, []);

  const onModelChange = useCallback(
    (sessionId: string, harness: HarnessId, model: string) => {
      const current = sessionStore.getSnapshot().find((s) => s.id === sessionId);
      if (!current) return;
      if (isPreparingHandoff(current)) return;
      const resolved = resolveModel(harness, model);
      if (current.modelSettings) {
        saveLastModelSettings(current.modelSettings, "fill");
      }
      const modelSettings = preferredModelSettings(
        resolved,
        current.modelSettings,
      );
      const plan = planComposerSwitch(current, harness);
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const next = withHarnessChoice(
            s,
            harness,
            resolved.id,
            modelSettings,
          );
          if (plan.kind === "arm") {
            return { ...next, pendingSwitch: plan.pending };
          }
          if (plan.kind === "revert") {
            return {
              ...next,
              pendingSwitch: undefined,
              ...(plan.restoreProviderSessionId
                ? { providerSessionId: plan.restoreProviderSessionId }
                : { providerSessionId: undefined }),
            };
          }
          if (plan.kind === "empty") {
            return { ...next, pendingSwitch: undefined };
          }
          return next;
        }),
      );
    },
    [],
  );

  const onModelSettingsChange = useCallback(
    (sessionId: string, modelSettings: Record<string, string>) => {
      saveLastModelSettings(modelSettings);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, modelSettings } : s)),
      );
    },
    [],
  );

  const onRuntimeModeChange = useCallback(
    (sessionId: string, runtimeMode: RuntimeMode) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, runtimeMode } : s)),
      );
      void serverCommands.permission(sessionId, runtimeMode).catch(() => undefined);
    },
    [],
  );

  /** Pause / Continue / Stop from a tab's context menu, on its focused thread. */
  const onTabThreadAction = useCallback((tabId: string, action: TabThreadAction) => {
    const tab = tabsRef.current.find((entry) => entry.id === tabId);
    if (!tab) return;
    const ids = leafIds(tab.layout);
    const session =
      sessionStore.getSnapshot().find((s) => s.id === tab.focusedId) ??
      sessionStore.getSnapshot().find((s) => ids.includes(s.id));
    if (!session) return;
    const run =
      action === "pause"
        ? serverCommands.pause(session.id)
        : action === "resume"
          ? serverCommands.resume(session.id)
          : serverCommands.interrupt(session.id);
    void run.catch(() => undefined);
  }, []);

  /** The empty session's type picker. A draft becomes a real thread of that
   *  type at once, so its rules and tune have somewhere to live. */
  const onThreadTypeChange = useCallback((sessionId: string, threadType: ThreadType) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, threadType } : s)),
    );
    const session = sessionStore.getSnapshot().find((s) => s.id === sessionId);
    if (!session) return;
    const run = sessionStore.metaOf(sessionId)
      ? serverCommands.retype(sessionId, threadType)
      : serverCommands.ensureCreated({ ...session, threadType });
    void run.catch(() => undefined);
  }, []);

  const onSubmit = useCallback(
    (
      sessionId: string,
      text: string,
      attachments: Attachment[] = [],
      options?: {
        secondOpinion?: SecondOpinionMeta;
        newPass?: boolean;
        intent?: ComposerIntent;
      },
    ) => {
      const current = sessionStore.getSnapshot().find((s) => s.id === sessionId);
      if (!current) return;
      if (options?.intent === "pause") {
        void serverCommands.pause(sessionId).catch(() => undefined);
        return;
      }
      const noteCard = current.noteCard;
      const handoffCard = current.handoffCard;
      if (
        !text.trim() &&
        attachments.length === 0 &&
        !noteCard &&
        !handoffCard
      ) {
        return;
      }
      if (isPreparingHandoff(current)) return;
      const workCwd = sessionWorkCwd(current);
      const harnessText = composeNoteMessage(noteCard, text);

      const pendingSwitch =
        current.pendingSwitch && current.pendingSwitch.from !== current.harness
          ? current.pendingSwitch
          : null;

      // Mid-turn (or paused): the composer said whether this waits its turn
      // or goes into the running one. Programmatic callers steer, as before.
      const paused = current.status === "paused";
      const midTurn = (current.busy || paused) && !pendingSwitch;
      if (midTurn && (options?.intent === "queue" || paused)) {
        void (async () => {
          try {
            const prepared = await prepareAttachments(attachments);
            const prompt = await preparePrompt(harnessText);
            const derived = await deriveMentionAttachments(text, workCwd);
            await serverCommands.queueAdd(
              sessionId,
              prompt,
              [...(await serverCommands.toServerAttachments(prepared)), ...derived],
              serverCommands.runSettingsFor(current),
            );
          } catch (error: unknown) {
            noteSystem(
              sessionId,
              error instanceof Error ? error.message : "Could not queue the message",
            );
          }
        })();
        return;
      }
      if (midTurn) {
        const visible = displayAttachments(attachments);
        const cards = userTurnCards(noteCard);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  inboxCard: undefined,
                  noteCard: undefined,
                  handoffCard: undefined,
                }
              : s,
          ),
        );
        void (async () => {
          try {
            const prepared = await prepareAttachments(attachments);
            const prompt = await preparePrompt(harnessText);
            const derived = await deriveMentionAttachments(text, workCwd);
            await serverCommands.steer(
              sessionStore.get(sessionId) ?? current,
              prompt,
              prepared,
              { ...cards, attachments: derived },
              { text, attachments: visible },
            );
          } catch (error: unknown) {
            noteSystem(
              sessionId,
              error instanceof Error
                ? error.message
                : `${current.harness} could not steer the active turn`,
            );
          }
        })();
        return;
      }

      const gen = (turnGen.current.get(sessionId) ?? 0) + 1;
      turnGen.current.set(sessionId, gen);
      const isFirstTurn = current.blocks.length === 0;
      const placeholderTitle = canReplaceSessionTitle(
        current.title,
        current.harness,
        HARNESS_LABEL[current.harness],
      );
      const titleSeed =
        isFirstTurn && !current.inboxCard && !current.noteCard && placeholderTitle
          ? titleFromPrompt(text, current.harness, attachments)
          : current.title;
      const visible = displayAttachments(attachments);
      const card =
        options?.secondOpinion ??
        (handoffCard ? handoffTurnCard(handoffCard) : undefined);
      const visibleText =
        card?.kind === "handoff" ? text : card ? SECOND_OPINION_TITLE : text;
      const cards = options?.newPass
        ? { ...userTurnCards(noteCard, card), newPass: true }
        : userTurnCards(noteCard, card);
      const live = isLiveHarness(current.harness);

      if (pendingSwitch && current.busy) {
        void cancelHarnessTurn(pendingSwitch.from, sessionId);
      }

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const titled = isFirstTurn ? titleSeed : s.title;
          const next = {
            ...s,
            inboxCard: undefined,
            noteCard: undefined,
            handoffCard: undefined,
          };
          if (!live) {
            return {
              ...next,
              title: titled,
              pendingSwitch: undefined,
              busy: false,
              blocks: [
                ...next.blocks,
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  text: visibleText,
                  ...(visible.length > 0 ? { attachments: visible } : {}),
                  ...cards,
                },
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  text: `${next.harness} is not connected yet — install and sign in to that provider, then retry.`,
                },
              ],
            };
          }
          if (pendingSwitch) {
            const sealed = stopStreaming({
              ...next,
              title: titled,
              pendingSwitch: undefined,
            });
            return appendPreparingHandoff(sealed, pendingSwitch.from, next.harness);
          }
          return { ...next, title: titled };
        }),
      );

      if (!live) return;

      void (async () => {
        // A split-pane handoff brings its brief along; a harness switch is
        // the server's own transcript handoff — the send carries the new
        // provider and only the divider shows here.
        const wrap = handoffCard
          ? { from: handoffCard.from, text: handoffCard.brief }
          : null;
        if (pendingSwitch) {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId && isPreparingHandoff(s)
                ? completeHandoff(s, buildDeterministicHandoff(s, text))
                : s,
            ),
          );
        }

        try {
          const prepared = await prepareAttachments(attachments);
          const prompt = await preparePrompt(harnessText);
          const derived = await deriveMentionAttachments(text, workCwd);
          await serverCommands.send(
            sessionStore.get(sessionId) ?? current,
            wrap
              ? wrapHandoffPrompt(wrap.text, wrap.from, prompt.trim() || CONTINUE_PROMPT)
              : prompt,
            prepared,
            { ...cards, attachments: derived },
            { text: visibleText, attachments: visible },
          );
          if (turnGen.current.get(sessionId) !== gen) return;
          if (wrap) {
            setSessions((prev) =>
              prev.map((s) => (s.id === sessionId ? consumeHandoff(s) : s)),
            );
          }
        } catch (error: unknown) {
          if (turnGen.current.get(sessionId) !== gen) return;
          noteSystem(
            sessionId,
            error instanceof Error ? error.message : `${current.harness} adapter failed`,
          );
        } finally {
          if (turnGen.current.get(sessionId) !== gen) return;
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionId ? stopStreaming(s) : s)),
          );
          playCue("turnFinished");
          notifyGitChanged();
          nudgeWorkspace(workCwd);
          nudgeWatchedFiles();
          window.setTimeout(() => nudgeWatchedFiles(), 150);
        }
      })();
    },
    [noteSystem],
  );

  const openSessionBeside = useCallback(
    (sourceId: string, session: Session, cwd: string, focusComposer = false) => {
      const current = sessionStore.getSnapshot();
      if (!current.some((entry) => entry.id === session.id)) {
        setSessions([...current, session]);
      }

      const tab = tabsRef.current.find((entry) =>
        leafIds(entry.layout).includes(sourceId),
      );
      if (tab) {
        const nextTabs = tabsRef.current.map((entry) =>
          entry.id === tab.id
            ? {
                ...entry,
                layout: splitPane(entry.layout, sourceId, "right", session.id),
                focusedId: session.id,
                diffFocused: false,
              }
            : entry,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        if (tab.id !== activeTabIdRef.current) setActiveTabId(tab.id);
      } else {
        const nextTab = newTab(session.id);
        appendTab(nextTab, cwd);
        setActiveTabId(nextTab.id);
      }

      setProjectTerminalFocused(false);
      setComposerFocused(focusComposer);
    },
    [appendTab],
  );
  openSessionBesideRef.current = openSessionBeside;

  const onSecondOpinion = useCallback(
    (sourceId: string, harness: HarnessId, turn: Block[], model: string) => {
      const source = sessionStore.getSnapshot().find(
        (session) => session.id === sourceId,
      );
      if (!source) return;
      const cwd = sessionWorkCwd(source);
      const from = harnessForTurn(source.blocks, turn, source.harness);
      const userRequest = turnUserRequest(turn);
      const files = turnEditedFiles(turn, cwd);
      const prompt = buildSecondOpinionPrompt({
        from,
        userRequest,
        report: turnReport(turn),
        files,
      });
      const session = {
        ...newSession(
          harness,
          cwd,
          model,
          source.runtimeMode,
          undefined,
          contextOfSession(source, catalogRef.current),
        ),
        title: formatSessionTitle(harness, SECOND_OPINION_TITLE),
      };
      openSessionBeside(sourceId, session, cwd);
      onSubmit(session.id, prompt, [], {
        secondOpinion: buildSecondOpinionCard({
          from,
          to: harness,
          userRequest,
          files,
        }),
      });
    },
    [onSubmit, openSessionBeside],
  );

  const onHandoff = useCallback(
    (sourceId: string, harness: HarnessId, turn: Block[], model: string) => {
      const source = sessionStore.getSnapshot().find(
        (session) => session.id === sourceId,
      );
      if (!source) return;
      const cwd = sessionWorkCwd(source);
      const from = harnessForTurn(source.blocks, turn, source.harness);
      const sliced = sessionThroughTurn(source, turn);
      const userRequest = turnUserRequest(turn);
      const files = turnEditedFiles(sliced.blocks, cwd);
      const display = sessionDisplayTitle(source.title, source.harness);
      const session = {
        ...newSession(
          harness,
          cwd,
          model,
          source.runtimeMode,
          undefined,
          contextOfSession(source, catalogRef.current),
        ),
        title: formatSessionTitle(
          harness,
          display === "New session" ? HANDOFF_TITLE : display,
        ),
        handoffCard: buildHandoffComposerCard({
          from,
          to: harness,
          brief: buildDeterministicHandoff(sliced),
          userRequest,
          files,
        }),
      };
      openSessionBeside(sourceId, session, cwd, true);
    },
    [openSessionBeside],
  );

  // Sessions whose last turn was interrupted resume on their own once the
  // harness is back. Keyed off the store so App does not render per push.
  useEffect(() => {
    let lastKey = "";
    let timer: number | undefined;
    const check = () => {
      const key = sessionStore
        .getSnapshot()
        .filter((session) => canAutoContinue(session) && isLiveHarness(session.harness))
        .map((session) => session.id)
        .join("\n");
      if (key === lastKey) return;
      lastKey = key;
      window.clearTimeout(timer);
      if (!key) return;
      const ids = key.split("\n");
      // Delay past React StrictMode's dev remount so Continue is not claimed
      // against a discarded tree (sessionStorage also survives Vite reloads).
      timer = window.setTimeout(() => {
        for (const id of ids) {
          const session = sessionStore.get(id);
          if (!session || !canAutoContinue(session) || !isLiveHarness(session.harness)) continue;
          onSubmit(id, CONTINUE_PROMPT);
        }
      }, 0);
    };
    check();
    const off = sessionStore.subscribe(check);
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [onSubmit]);

  const onStop = useCallback(
    (sessionId: string) => {
      const session = sessionStore.getSnapshot().find((s) => s.id === sessionId);
      turnGen.current.set(sessionId, (turnGen.current.get(sessionId) ?? 0) + 1);
      if (session) {
        for (const id of sessionChildHarnesses(session)) {
          void cancelHarnessTurn(id, sessionId);
        }
      }
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const stopped = stopStreaming(s);
          return isPreparingHandoff(stopped)
            ? completeHandoff(stopped, buildDeterministicHandoff(stopped))
            : stopped;
        }),
      );
      if (session) {
        nudgeWorkspace(sessionWorkCwd(session));
        notifyGitChanged();
        nudgeWatchedFiles();
        window.setTimeout(() => nudgeWatchedFiles(), 150);
      }
    },
    [],
  );

  const onApproval = useCallback(
    (sessionId: string, requestId: string | number, decision: ApprovalDecision) => {
      const session = sessionStore.getSnapshot().find((s) => s.id === sessionId);
      if (!session) return;
      respondHarnessApproval(session.harness, sessionId, requestId, decision);
    },
    [],
  );

  const onOpenApprovalSession = useCallback(
    (sessionId: string) => {
      if (!focusOpenSession(sessionId)) {
        void onSelectHistorySession(sessionId);
      }
    },
    [focusOpenSession, onSelectHistorySession],
  );

  const onSelectLiveAgent = useCallback(
    (sessionId: string) => {
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      onOpenApprovalSession(sessionId);
    },
    [onOpenApprovalSession],
  );

  const railOpen = useRightRailOpen();
  const onHeaderNew = useCallback(
    (threadType: ThreadType, threadRules: ThreadRules | null) => {
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      const session = createSessionHere({
        projectId: selectedProjectIdRef.current,
        threadType,
        threadRules,
      });
      const tab = newTab(session.id);
      setSessions((prev) => [...prev, session]);
      // Real on the server from the first click: the thread's rules travel
      // with the create, and a later tune has somewhere to land.
      void serverCommands.ensureCreated(session).catch(() => undefined);
      appendTab(tab, session.cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
    },
    [appendTab, createSessionHere],
  );
  const onHeaderAction = useCallback((sessionId: string, action: ThreadAction) => {
    const run =
      action === "pause"
        ? serverCommands.pause(sessionId)
        : action === "resume"
          ? serverCommands.resume(sessionId)
          : serverCommands.interrupt(sessionId);
    void run.catch(() => undefined);
  }, []);
  const onHeaderSetRules = useCallback((sessionId: string, threadRules: ThreadRules | null) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, threadRules } : s)));
    void serverCommands.setThreadRules(sessionId, threadRules).catch(() => undefined);
  }, []);
  const onHeaderDelete = useCallback(
    (sessionId: string) => void onDeleteHistorySession(sessionId, { confirmed: true }),
    [onDeleteHistorySession],
  );
  // A draft has nothing on the server to keep: archiving it discards the tab.
  const onHeaderArchive = useCallback(
    (sessionId: string) => {
      const draft = chipThreadsRef.current.find((t) => t.id === sessionId)?.draft;
      if (draft) onHeaderDelete(sessionId);
      else void onArchiveHistorySession(sessionId, true);
    },
    [onArchiveHistorySession, onHeaderDelete],
  );
  const headerEvents = useMemo<HeaderEvents | undefined>(
    () =>
      deckLayout
        ? {
            onSelect: onSelectHistorySession,
            onRename: onRenameHistorySession,
            onArchive: onHeaderArchive,
            onDelete: onHeaderDelete,
            onAction: onHeaderAction,
            onSetRules: onHeaderSetRules,
            onRestore: onRestoreThread,
            onNew: onHeaderNew,
            onPauseAll: () => serverCommands.pauseAllRunning(),
            onToggleRail: toggleRightRail,
          }
        : undefined,
    [
      deckLayout,
      onSelectHistorySession,
      onRenameHistorySession,
      onHeaderArchive,
      onHeaderDelete,
      onHeaderAction,
      onHeaderSetRules,
      onRestoreThread,
      onHeaderNew,
    ],
  );
  const headerWorkspaceId = deckLayout
    ? sessionContext(selectedProjectId).workspaceId ?? null
    : null;

  const onToggleSidebar = useCallback(() => {
    if (deckLayout) {
      setProjectRailOpen((open) => {
        const next = !open;
        saveProjectRailOpen(next);
        return next;
      });
      return;
    }
    setSidebarOpen((open) => {
      const next = !open;
      saveSidebarOpen(next);
      return next;
    });
  }, [deckLayout]);

  const onToggleProjectRail = useCallback(() => {
    setProjectRailOpen((open) => {
      const next = !open;
      saveProjectRailOpen(next);
      return next;
    });
  }, []);

  const onGoToFile = useCallback(() => {
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setFilePickerOpen(true);
  }, []);

  const onGoToSymbol = useCallback(() => {
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setFilePickerOpen(false);
    setSymbolPickerOpen(true);
  }, []);

  // ⌘T: the type hierarchy at the caret of a focused Monaco editor; with no
  // editor focused it falls back to the symbol picker.
  const onShowHierarchy = useCallback(() => {
    if (!document.activeElement?.closest(".monaco-editor")) {
      onGoToSymbol();
      return;
    }
    void (async () => {
      const { focusedEditor } = await import("./surfaces/monaco/keys");
      const editor = focusedEditor();
      if (!editor) return onGoToSymbol();
      const { showHierarchy } = await import("./surfaces/monaco/lsp/providers");
      await showHierarchy(editor, "types");
    })();
  }, [onGoToSymbol]);

  const onSaveAll = useCallback(() => {
    void flushAllEditors();
  }, []);

  const onFindInProject = useCallback(() => {
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setSidebarOpen(true);
    saveSidebarOpen(true);
    setSidebarTab("files");
    setFilesSearchOpen(true);
    setSearchFocusToken((token) => token + 1);
  }, []);

  const onOpenSearch = useCallback(() => {
    setFilePickerOpen(false);
    setSettingsOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setSearchViewOpen(true);
    setSearchViewFocusToken((token) => token + 1);
  }, []);

  const onLeaveSearch = useCallback(() => {
    setSearchViewOpen(false);
  }, []);

  const onOpenInbox = useCallback(() => {
    setFilePickerOpen(false);
    setSettingsOpen(false);
    setSearchViewOpen(false);
    setNotesViewOpen(false);
    if (deckLayout) {
      setInboxViewOpen(true);
      return;
    }
    setInboxViewOpen(false);
    setSidebarOpen(true);
    saveSidebarOpen(true);
    setSidebarTab("inbox");
  }, [deckLayout]);

  const onLeaveInbox = useCallback(() => {
    setInboxViewOpen(false);
  }, []);

  const onOpenNotes = useCallback(() => {
    if (!loadNotesEnabled()) return;
    setFilePickerOpen(false);
    setSettingsOpen(false);
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(true);
  }, []);

  const onLeaveNotes = useCallback(() => {
    setNotesViewOpen(false);
  }, []);

  const openSettings = useCallback((section?: SettingsSectionId) => {
    setFilePickerOpen(false);
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    if (section) {
      setSettingsSection(section);
      saveSettingsSection(section);
    }
    setSettingsOpen(true);
  }, []);

  const onOpenSettings = useCallback(() => openSettings(), [openSettings]);

  // The editor chunk asks for a docked debug pane (⌃D) and for the
  // Settings Editor section (the EULA gate) through window events.
  useEffect(() => {
    const onDebug = (event: Event) => {
      const { cwd, path } = (event as CustomEvent<{ cwd: string; path: string }>).detail;
      const tabId = activeTabIdRef.current;
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId ? openDebugTab(tab, newDebugFile(cwd, path)) : tab,
        ),
      );
    };
    const onSettings = (event: Event) => {
      const section = (event as CustomEvent<string>).detail;
      openSettings(isSettingsSectionId(section) ? section : undefined);
    };
    window.addEventListener(OPEN_DEBUG_EVENT, onDebug);
    window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
    return () => {
      window.removeEventListener(OPEN_DEBUG_EVENT, onDebug);
      window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
    };
  }, [openSettings]);

  const onCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const onSelectSettingsSection = useCallback((section: SettingsSectionId) => {
    setSettingsSection(section);
    saveSettingsSection(section);
  }, []);

  const onOpenArchivedSession = useCallback(
    (sessionId: string) => {
      setSettingsOpen(false);
      void onSelectHistorySession(sessionId);
    },
    [onSelectHistorySession],
  );

  const onRailBack = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (searchViewOpen) {
      setSearchViewOpen(false);
      return;
    }
    if (inboxViewOpen) {
      setInboxViewOpen(false);
      return;
    }
    if (notesViewOpen) {
      setNotesViewOpen(false);
      return;
    }
    onVisitBack();
  }, [onVisitBack, searchViewOpen, settingsOpen, inboxViewOpen, notesViewOpen]);

  const onRailForward = useCallback(() => {
    setSearchViewOpen(false);
    setSettingsOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    onVisitForward();
  }, [onVisitForward]);

  useEffect(() => {
    const onLayoutChange = (event: Event) => {
      const layout = (event as CustomEvent<SidebarLayout>).detail;
      setTabs((prev) =>
        prev.map((tab) => ({ ...tab, diffOpen: false, diffFocused: false })),
      );
      if (layout === "classic") {
        setSidebarTab((tab) =>
          inboxViewOpenRef.current
            ? "inbox"
            : tab === "changes"
              ? "sessions"
              : tab,
        );
        if (inboxViewOpenRef.current) {
          setInboxViewOpen(false);
          setSidebarOpen(true);
          saveSidebarOpen(true);
        }
        setProjectTerminalFocused(false);
      } else {
        setSidebarTab((tab) => (tab === "inbox" ? "sessions" : tab));
      }
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    return () => window.removeEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
  }, []);

  useEffect(() => {
    if (!deckLayout && sidebarTab === "changes") {
      setSidebarTab("sessions");
    }
    if (deckLayout && sidebarTab === "inbox") {
      setSidebarTab("sessions");
    }
  }, [deckLayout, sidebarTab]);

  useEffect(() => {
    if (!dockVisible) setProjectTerminalFocused(false);
  }, [dockVisible]);

  const openFilePaths = useMemo(() => {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const tab of tabs) {
      for (const pane of tab.editorPanes) {
        for (const file of pane.files) {
          if (!isFilesystemTab(file) || seen.has(file.path)) continue;
          seen.add(file.path);
          paths.push(file.path);
        }
      }
    }
    return paths;
  }, [tabs]);

  useEffect(() => {
    void invoke("set_traffic_lights_visible", { visible: true }).catch(
      (err) => console.error("[window] traffic lights:", err),
    );
  }, []);

  const actions = useRef({
    onNew,
    onClosePane,
    onNext,
    onPrev,
    onVisitBack,
    onVisitForward,
    onActivate,
    onSplit,
    onFocusDir,
    onToggleSidebar,
    onGoToFile,
    onGoToSymbol,
    onShowHierarchy,
    onSaveAll,
    onFindInProject,
    onOpenSearch,
    onOpenInbox,
    onOpenNotes,
    pickProject,
    onNewTerminal,
    onNewTerminalTab,
    onToggleProjectTerminal,
    openSettings,
  });
  actions.current = {
    onNew,
    onClosePane,
    onNext,
    onPrev,
    onVisitBack,
    onVisitForward,
    onActivate,
    onSplit,
    onFocusDir,
    onToggleSidebar,
    onGoToFile,
    onGoToSymbol,
    onShowHierarchy,
    onSaveAll,
    onFindInProject,
    onOpenSearch,
    onOpenInbox,
    onOpenNotes,
    pickProject,
    onNewTerminal,
    onNewTerminalTab,
    onToggleProjectTerminal,
    openSettings,
  };

  const debounce = useRef({ name: "", at: 0 });
  const run = useCallback((name: string, fn: () => void) => {
    const now = performance.now();
    if (name === debounce.current.name && now - debounce.current.at < 80)
      return;
    debounce.current = { name, at: now };
    fn();
  }, []);

  // Both routes into the command map (lib/appCommands.ts) end here.
  const execute = useCallback(
    (cmd: AppCommand) => {
      const a = actions.current;
      const go = (fn: () => void) =>
        run(cmd.id === "activate_tab" ? `activate_tab_${cmd.index}` : cmd.id, fn);
      switch (cmd.id) {
        case "new_tab": return go(a.onNew);
        case "close_tab": return go(a.onClosePane);
        case "next_tab": return go(a.onNext);
        case "prev_tab": return go(a.onPrev);
        case "back_tab": return go(a.onVisitBack);
        case "forward_tab": return go(a.onVisitForward);
        case "activate_tab": return go(() => a.onActivate(cmd.index ?? 0));
        case "split_right": return go(() => a.onSplit("right"));
        case "split_down": return go(() => a.onSplit("down"));
        case "new_terminal": return go(a.onNewTerminal);
        case "new_terminal_tab": return go(a.onNewTerminalTab);
        case "toggle_terminal": return go(a.onToggleProjectTerminal);
        case "focus_left": return go(() => a.onFocusDir("left"));
        case "focus_right": return go(() => a.onFocusDir("right"));
        case "focus_up": return go(() => a.onFocusDir("up"));
        case "focus_down": return go(() => a.onFocusDir("down"));
        case "toggle_sidebar": return go(a.onToggleSidebar);
        case "toggle_zen": return go(() => toggleTranscriptZen());
        case "open_project": return go(() => void a.pickProject());
        case "go_to_file": return go(a.onGoToFile);
        case "go_to_symbol": return go(a.onGoToSymbol);
        case "show_hierarchy": return go(a.onShowHierarchy);
        case "save_all": return go(a.onSaveAll);
        case "open_search": return go(a.onOpenSearch);
        case "open_inbox": return go(a.onOpenInbox);
        case "open_notes": return go(a.onOpenNotes);
        case "open_settings": return go(() => a.openSettings());
        case "check_for_updates": return go(() => void updateStore.check(true));
        case "sidebar_opacity": return go(() => a.openSettings("appearance"));
        case "find_in_project": return go(a.onFindInProject);
        case "new_window": return go(() => void invoke("open_new_window").catch(() => {}));
        case "find": return go(() => openFindInActiveEditor());
        case "open_model_picker":
          return go(() => window.dispatchEvent(new Event("open_model_picker")));
        // Main already sends menu commands to the focused window only (or
        // the CDP debug target), so no focus check here: it kept menu zoom
        // from working under CDP.
        case "zoom_in": return go(() => void zoomIn().catch(() => {}));
        case "zoom_out": return go(() => void zoomOut().catch(() => {}));
        case "zoom_reset": return go(() => void zoomReset().catch(() => {}));
        case "lightbox_close": return go(closeLightbox);
        case "lightbox_prev": return go(() => stepLightbox(-1));
        case "lightbox_next": return go(() => stepLightbox(1));
      }
    },
    [run],
  );

  // Dev-only `window.__app` (lib/appFacade.ts): CDP scripts drive the app
  // through the same command map and actions the UI uses.
  useEffect(() => {
    installAppFacade({
      execute,
      newSession: () => actions.current.onNew(),
      openSession: (id, seq) => onSelectHistorySession(id, seq),
      send: (id, text) => onSubmit(id, text),
    });
  }, [execute, onSelectHistorySession, onSubmit]);

  useEffect(() => {
    const keyCommand = createKeyResolver();
    const onKey = (e: KeyboardEvent) => {
      const lightboxOpen = isLightboxOpen();
      if (
        !lightboxOpen &&
        !searchViewOpenRef.current &&
        !inboxViewOpenRef.current &&
        !notesViewOpenRef.current &&
        handleEditorFindKey(e)
      ) {
        e.stopPropagation();
        return;
      }
      const cmd = keyCommand(e, { lightboxOpen, terminalToggle: deckLayoutRef.current });
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      execute(cmd);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [execute]);

  useEffect(() => {
    const unlisten = APP_COMMANDS.map((id) =>
      listen(id, () => {
        if (!menuCommandAllowed(id, { dialogOpen: dialogOpen(), lightboxOpen: isLightboxOpen() })) {
          return;
        }
        execute({ id });
      }),
    );
    return () => {
      void Promise.all(unlisten).then((fns) => fns.forEach((fn) => fn()));
    };
  }, [execute]);

  // Every window applies the saved zoom level on boot.
  useEffect(() => {
    const level = loadZoom();
    if (level !== 1) void applyZoom(level).catch(() => {});
  }, []);

  const dockGridRef = useRef<HTMLDivElement>(null);
  const dockDragSize = useRef<number | null>(null);
  const paintDockSize = useCallback((size: number) => {
    const dock = findProjectTerminal(projectTerminalsRef.current, dockCwdRef.current);
    const el = dockGridRef.current;
    if (!dock || !el) return;
    dockDragSize.current = size;
    applyDockGridStyle(el, dock.side, size);
  }, []);
  const commitDockSize = useCallback((size: number) => {
    dockDragSize.current = null;
    onProjectTerminalSize(size);
  }, [onProjectTerminalSize]);
  useLayoutEffect(() => {
    if (dockDragSize.current != null) return;
    const el = dockGridRef.current;
    if (!el) return;
    applyDockGridStyle(
      el,
      dockVisible && currentProjectDock ? currentProjectDock.side : null,
      currentProjectDock?.size ?? 0,
    );
  }, [currentProjectDock, dockVisible]);

  return (
    <div
      className={`flex h-full text-content ${
        IS_MAC ? "bg-background-base/40" : "bg-background-base"
      }`}
    >
      <Sidebar
        cwd={sidebarCwd}
        gitCwd={gitCwd}
        open={deckLayout || sidebarOpen || settingsOpen}
        layout={sidebarLayout}
        tab={sidebarTab}
        onTabChange={setSidebarTab}
        filesSearchOpen={filesSearchOpen}
        onFilesSearchOpenChange={setFilesSearchOpen}
        onOpenFilesSearch={onFindInProject}
        searchFocusToken={searchFocusToken}
        activeSessionId={active?.id}
        onSelectSession={onSelectHistorySession}
        onRenameSession={onRenameHistorySession}
        onDeleteSession={onDeleteHistorySession}
        onOpenFile={onOpenFile}
        onOpenTerminal={(cwd) => onOpenTerminal(cwd)}
        onFileMoved={onFileMoved}
        onFileDeleted={onFileDeleted}
        canGoBack={tabVisitNav.canBack || searchViewOpen || settingsOpen || inboxViewOpen || notesViewOpen}
        canGoForward={tabVisitNav.canForward}
        onGoBack={onRailBack}
        onGoForward={onRailForward}
        onOpenDiff={onOpenDiff}
        onShowSourceControl={onToggleChanges}
        selectedDiffPath={
          activeTab ? selectedChangePath(activeTab, gitCwd) : undefined
        }
        textHarness={pickTextHarness(active?.harness)}
        recents={railRecents}
        workspaceId={selectedWorkspace?.id ?? null}
        selectedProjectId={selectedProjectId}
        onSelectProjectCard={onSelectProjectCard}
        onNewChat={onNewChat}
        onProjectCreated={onProjectCreated}
        onSelectAgent={onSelectLiveAgent}
        onSelectProject={deckLayout ? onSelectProject : undefined}
        onOpenProject={deckLayout ? pickProject : undefined}
        onRemoveProject={deckLayout ? onRemoveProject : undefined}
        onNew={onNew}
        onNewTerminal={deckLayout ? onNewTerminal : undefined}
        onSearch={onOpenSearch}
        onOpenInbox={onOpenInbox}
        onOpenNotes={notesEnabled ? onOpenNotes : undefined}
        onGoToFile={deckLayout ? onGoToFile : undefined}
        searchActive={searchViewOpen}
        inboxActive={inboxViewOpen}
        notesActive={notesViewOpen}
        notesEnabled={notesEnabled}
        projectRailOpen={projectRailOpen}
        onToggleProjectRail={onToggleProjectRail}
        settingsOpen={settingsOpen}
        settingsSection={settingsSection}
        onOpenSettings={onOpenSettings}
        onSelectSettingsSection={onSelectSettingsSection}
        onCloseSettings={onCloseSettings}
        updateNotice={updateNotice}
        onOpenWhatsNew={onOpenWhatsNew}
        onDismissUpdate={() => setUpdateNotice(null)}
      />

      <div className="body-glass flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={
            searchViewOpen || settingsOpen || inboxViewOpen || notesViewOpen
              ? "hidden"
              : "flex min-h-0 min-w-0 flex-1 flex-col"
          }
          aria-hidden={searchViewOpen || settingsOpen || inboxViewOpen || notesViewOpen}
          inert={searchViewOpen || settingsOpen || inboxViewOpen || notesViewOpen || undefined}
        >
        {!IS_MAC ? (
          <MenuBar
            onNew={onNew}
            onNewTerminal={onNewTerminal}
            onToggleTerminal={onToggleProjectTerminal}
            onGoToFile={onGoToFile}
            onCommand={(id) => {
              if (isAppCommandId(id)) execute({ id });
            }}
            onToggleSidebar={onToggleSidebar}
            onShowSourceControl={onToggleChanges}
            onCloseCurrentTab={
              activeTabId ? () => onCloseTab(activeTabId) : undefined
            }
            onPickProject={pickProject}
            onFindInProject={onFindInProject}
            onSearch={onOpenSearch}
            onOpenInbox={onOpenInbox}
            onOpenNotes={notesEnabled ? onOpenNotes : undefined}
          />
        ) : null}
        <ShellTitleBar
          deckTabs={deckProjectTabs}
          dirtyFiles={dirtyFiles}
          selectedProjectId={selectedProjectId}
          activeSessionId={activeSessionId}
          headerWorkspaceId={headerWorkspaceId}
          railOpen={railOpen}
          headerEvents={headerEvents}
          tabProjectsRef={tabProjectsRef}
          stripTabsRef={stripTabsRef}
          headerModelRef={headerModelRef}
          chipThreadsRef={chipThreadsRef}
          activeId={activeTabId}
          cwd={sidebarCwd}
          gitCwd={gitCwd}
          sidebarOpen={deckLayout || sidebarOpen}
          deckLayout={deckLayout}
          projectRailOpen={projectRailOpen}
          sourceControlActive={
            deckLayout
              ? sidebarOpen && sidebarTab === "changes"
              : !!activeTab?.diffOpen
          }
          onToggleSidebar={onToggleSidebar}
          onShowSourceControl={onToggleChanges}
          onSelect={activateTab}
          canGoBack={tabVisitNav.canBack}
          canGoForward={tabVisitNav.canForward}
          onGoBack={onVisitBack}
          onGoForward={onVisitForward}
          onNew={onNew}
          onNewTerminal={onNewTerminal}
          onShowTerminal={onShowProjectTerminal}
          projectTerminalActive={
            !!currentProjectDock && currentProjectDock.pane.files.length > 0
          }
          onOpenSettings={onOpenSettings}
          onOpenInbox={onOpenInbox}
          onOpenNotes={notesEnabled ? onOpenNotes : undefined}
          onClose={onCloseTab}
          onReorder={onReorderTabs}
          onGoToFile={onGoToFile}
          onJoinTab={onJoinTab}
          onJoinTabToGroup={onJoinTabToGroup}
          onAddToNewGroup={onAddToNewGroup}
          onAddToGroup={onAddToGroup}
          onRemoveFromGroup={onRemoveFromGroup}
          onUngroup={onUngroup}
          onGroupNewTab={onGroupNewTab}
          onTabThreadAction={onTabThreadAction}
          onGroupClose={onGroupCloseTabs}
          onGroupMoveToNewWindow={onGroupMoveToNewWindow}
          recents={recents}
          onSelectProject={deckLayout ? onSelectProject : undefined}
        />
        <ThreadBanners
          projectId={selectedProjectId}
          activeSessionId={activeTab?.focusedId}
          onOpen={onOpenApprovalSession}
        />

        <main className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={dockGridRef}
            className="absolute inset-0 grid h-full min-h-0 min-w-0"
          >
            {projectTerminals.map((dock) => {
              const show =
                deckLayout &&
                dock.open &&
                sameProjectPath(dock.projectPath, projectCwd);
              return (
                <div
                  key={dock.projectPath}
                  className={
                    show
                      ? "h-full min-h-0 min-w-0 w-full overflow-hidden"
                      : "hidden"
                  }
                  style={show ? { gridArea: "dock" } : undefined}
                  aria-hidden={!show}
                >
                  <ProjectTerminalDock
                    dock={dock}
                    focused={show && projectTerminalFocused}
                    onFocus={focusProjectTerminal}
                    onHide={onHideProjectTerminal}
                    onSideChange={onProjectTerminalSide}
                    onSizePaint={paintDockSize}
                    onSizeCommit={commitDockSize}
                    onAddTerminal={() =>
                      onOpenTerminal(active?.cwd ?? projectCwd)
                    }
                    onSelectTerminal={onSelectProjectTerminal}
                    onCloseTerminal={onCloseProjectTerminal}
                    onReorderTerminals={onReorderProjectTerminals}
                    onTerminalMetaChange={onTerminalMetaChange}
                  />
                </div>
              );
            })}
            <div
              className="relative flex min-h-0 min-w-0 flex-row"
              style={{ gridArea: "main" }}
            >
              {classicInbox ? (
                <InboxDetailPane
                  cwd={sidebarCwd}
                  recents={recents}
                  onStart={onStartInboxItem}
                />
              ) : (
                <div className="relative min-h-0 min-w-0 flex-1">
              {tabs.map((tab) => mountedTabIds.has(tab.id) && (
                <div
                  key={tab.id}
                  aria-hidden={tab.id !== activeTabId}
                  className={
                    tab.id === activeTabId
                      ? "absolute inset-0 flex h-full min-h-0 flex-col"
                      : "hidden"
                  }
                >
                  <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
                    <PaneTree
                      visible={tab.id === activeTabId}
                      layout={tab.layout}
                      editorPanes={[
                        ...tab.editorPanes,
                        ...(tab.terminalPanes ?? []),
                      ]}
                      dirtyFileIds={dirtyFiles}
                      fileErrorCounts={fileErrorCounts}
                      focusedId={
                        tab.id === activeTabId &&
                        !tab.diffFocused &&
                        !projectTerminalFocused
                          ? tab.focusedId
                          : ""
                      }
                      composerFocused={
                        composerFocused && !projectTerminalFocused
                      }
                      recents={recents}
                      hideProjectPicker={deckLayout}
                      onFocus={onFocusPane}
                      onClose={onClosePane}
                      onSelectFile={onSelectFileSurface}
                      onCloseFile={onCloseFile}
                      onReorderFiles={onReorderFiles}
                      onFileDirtyChange={onFileDirtyChange}
                      onFileErrorCountChange={onFileErrorCountChange}
                      onRatio={(splitId, index, ratio) =>
                        onRatio(tab.id, splitId, index, ratio)
                      }
                      onCwdChange={onCwdChange}
                      onBranchChange={onBranchChange}
                      onModelChange={onModelChange}
                      onModelSettingsChange={onModelSettingsChange}
                      onRuntimeModeChange={onRuntimeModeChange}
                      onThreadTypeChange={onThreadTypeChange}
                      onSubmit={onSubmit}
                      onStop={onStop}
                      onInboxCardDismiss={onInboxCardDismiss}
                      onNoteCardDismiss={onNoteCardDismiss}
                      onHandoffCardDismiss={onHandoffCardDismiss}
                      onApproval={onApproval}
                      onOpenFile={onOpenFile}
                      editorNavigation={editorNavigation}
                      onOpenDiff={onOpenDiff}
                      onShowSourceControl={onToggleChanges}
                      onOpenSession={onOpenSessionById}
                      onSecondOpinion={onSecondOpinion}
                      onHandoff={onHandoff}
                      onMovePane={onMovePane}
                      onNewTerminal={onNewTerminalInSession}
                      onTerminalMetaChange={onTerminalMetaChange}
                    />
                  </div>
                </div>
              ))}
                </div>
              )}
            {!deckLayout && !classicInbox && activeTab?.diffOpen ? (
              <DiffPane
                key={gitCwd ?? ""}
                cwd={gitCwd}
                textHarness={pickTextHarness(active?.harness)}
                selectedPath={selectedChangePath(activeTab, gitCwd)}
                focused={!!activeTab.diffFocused}
                onFocus={onFocusDiff}
                onOpenFile={onOpenDiff}
              />
            ) : null}
            <ProjectRail projectId={selectedProjectId} cwd={gitCwd} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
            </div>
          </div>
        </main>
        </div>
        {searchViewOpen ? (
          <SearchView
            open
            cwd={sidebarCwd}
            recents={railRecents}
            focusToken={searchViewFocusToken}
            besideRail={deckLayout && projectRailOpen}
            onClose={onLeaveSearch}
            onToggleSidebar={deckLayout ? onToggleSidebar : undefined}
            onOpenFile={onOpenFile}
            onOpenSession={onSelectHistorySession}
            onOpenProject={onSelectProject}
          />
        ) : null}
        {inboxViewOpen ? (
          <InboxView
            cwd={sidebarCwd}
            recents={railRecents}
            besideRail={deckLayout && projectRailOpen}
            onClose={onLeaveInbox}
            onToggleSidebar={deckLayout ? onToggleSidebar : undefined}
            onStart={onStartInboxItem}
          />
        ) : null}
        {notesViewOpen ? (
          <NotesView
            besideRail={deckLayout && projectRailOpen}
            cwd={projectCwd}
            onClose={onLeaveNotes}
            onToggleSidebar={deckLayout ? onToggleSidebar : undefined}
          />
        ) : null}
        {settingsOpen ? (
          <SettingsView
            section={settingsSection}
            cwd={sidebarCwd}
            besideRail={deckLayout || sidebarOpen || settingsOpen}
            onClose={onCloseSettings}
            onOpenSession={onOpenArchivedSession}
            onArchiveSession={onArchiveHistorySession}
            onDeleteSession={onDeleteHistorySession}
            onRestoreProject={onRestoreProject}
            onDeleteProject={(path) =>
              onRemoveProject(path, { purgeData: true })
            }
            onOpenWhatsNew={onOpenWhatsNew}
          />
        ) : null}
        {searchViewOpen || inboxViewOpen || notesViewOpen || settingsOpen ? null : (
          <UsageFooter
            providers={usageProviders}
            session={usageSession}
            terminals={runningTerminals}
            terminalOpen={runningTerminalOpen}
            onToggleTerminal={onToggleRunningTerminal}
          />
        )}
      </div>

      {filePickerOpen ? (
        <FilePicker
          open
          cwd={gitCwd}
          openPaths={openFilePaths}
          onOpenFile={onOpenFile}
          onClose={() => setFilePickerOpen(false)}
        />
      ) : null}

      {symbolPickerOpen ? (
        <SymbolPicker
          projectId={projectForCwd(gitCwd, projects)?.id ?? selectedProjectId ?? null}
          onOpen={(path, navigation) => onOpenFile(path, navigation, { editor: "monaco" })}
          onClose={() => setSymbolPickerOpen(false)}
        />
      ) : null}

      <HiddenApprovalToasts
        tabs={tabs}
        activeTabId={activeTabId}
        composerFocused={composerFocused}
        onFocusSession={onOpenApprovalSession}
        onApproval={onApproval}
      />
      {whatsNew ? (
        <WhatsNewDialog
          version={whatsNew.version}
          markdown={whatsNew.markdown}
          onClose={() => setWhatsNew(null)}
        />
      ) : null}
      {newWorkspacePath ? (
        <NewWorkspaceDialog
          path={newWorkspacePath}
          onClose={() => setNewWorkspacePath(null)}
          onCreated={(workspace) => {
            setNewWorkspacePath(null);
            onSelectProject(workspace.path);
          }}
        />
      ) : null}
    </div>
  );
}



function isBlankSession(session: Session | undefined): boolean {
  if (!session || session.busy) return false;
  // A server session whose transcript has not been fetched yet is unknown,
  // not blank: a restored heavy tab must not be reused as a fresh one.
  if (!session.loaded && !sessionStore.isDraft(session.id)) return false;
  return !session.blocks.some((block) => block.role === "user");
}

function selectedChangePath(
  tab: WorkspaceTab,
  gitCwd?: string,
): string | undefined {
  const file = focusedFileTab(tab);
  if (!file || !isFilesystemTab(file) || !file.review) return undefined;
  return displayPath(file.path, gitCwd || file.cwd);
}

function isBlankWorkspaceTab(tab: WorkspaceTab, sessions: Session[]): boolean {
  if (tab.editorPanes.some((pane) => pane.files.length > 0)) return false;
  if ((tab.terminalPanes ?? []).some((pane) => pane.files.length > 0))
    return false;
  const ids = leafIds(tab.layout);
  if (ids.length !== 1) return false;
  return isBlankSession(sessions.find((entry) => entry.id === ids[0]));
}



/**
 * A thread that is finished and read: settled, no live or paused work in its
 * tree, nothing new since the user last looked, and no plan awaiting a build.
 * Drafts and file-only tabs stay live.
 */
/** A deck tab whose threads are all archived leaves the strip. */
function tabArchived(tab: WorkspaceTab, sessions: readonly SessionShell[]): boolean {
  const tabSessions = leafIds(tab.layout)
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is SessionShell => session != null);
  return tabSessions.length > 0 && tabSessions.every((session) => session.archived);
}


function dropOpenFiles(
  tab: WorkspaceTab,
  shouldDrop: (path: string) => boolean,
): WorkspaceTab {
  let layout = tab.layout;
  let focusedId = tab.focusedId;
  const editorPanes: EditorPane[] = [];
  for (const pane of tab.editorPanes) {
    const files = pane.files.filter(
      (file) => !isFilesystemTab(file) || !shouldDrop(file.path),
    );
    if (files.length === 0) {
      const sibling = siblingLeafId(layout, pane.id);
      const withoutPane = removePane(layout, pane.id);
      if (withoutPane) {
        layout = withoutPane;
        if (focusedId === pane.id)
          focusedId = sibling ?? firstLeafId(withoutPane);
      }
      continue;
    }
    editorPanes.push({
      ...pane,
      files,
      activeFileId: files.some((file) => file.id === pane.activeFileId)
        ? pane.activeFileId
        : files[0].id,
    });
  }
  return { ...tab, layout, focusedId, editorPanes };
}

function nudgeWorkspace(cwd?: string) {
  invalidateProjectFiles(cwd);
  notifyDirsChanged();
}

function nudgeOpenEditors(block: Block, cwd: string) {
  const event = block.tool;
  if (!event) return;
  const completed = event.status === "completed" || event.status === "success";

  const kind = event.kind?.trim().toLowerCase();
  if (kind === "execute" || event.preview?.kind === "shell") {
    if (!completed) return;
    nudgeWatchedFiles();
    window.setTimeout(() => nudgeWatchedFiles(), 150);
    notifyGitChanged();
    nudgeWorkspace(cwd);
    window.setTimeout(() => nudgeWorkspace(cwd), 150);
    return;
  }

  if (!isEditTool(event.kind, event.title, event.preview)) return;
  const raw = event.preview?.path;
  const resolved = raw ? (resolveWorkspacePath(raw, cwd) ?? raw) : undefined;
  if (resolved) {
    nudgeWatchedFiles([resolved]);
  } else if (completed) {
    nudgeWatchedFiles();
  }
  if (completed) {
    window.setTimeout(() => nudgeWatchedFiles(), 150);
    notifyGitChanged();
    nudgeWorkspace(cwd);
  }
}

function sameSettings(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}
