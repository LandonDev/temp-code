import { MoreHorizontal, Plus } from "./icons";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { warmProjectForCwd } from "../lib/monaco/focusBoot";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DUR, EASE_OUT } from "../lib/ease";
import { IS_MAC, MOD } from "../lib/platform";
import { basename } from "../lib/fs";
import { projectName } from "../lib/paths";
import { loadTabGroupLabels, resolveTabGroupLabel, TAB_GROUP_LABELS_CHANGED } from "../lib/tabGroups";
import type { ProjectMeta } from "../lib/tcserver/types";
import {
  useWorkspaceCatalog,
  useWorkspaces,
  workspaceIdOf,
  workspaceLabelKey,
} from "../lib/tcserver/workspaces";
import { useSessionMetas } from "../lib/tcserver/store";
import { archive } from "../lib/tcserver/commands";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { dormantByType, dormantThreads, focusedTree } from "../lib/threadStripModel";
import { scopeTest } from "../lib/workspaceSessions";
import { openWorkspaceSettings } from "../lib/settings";
import { canTabVisitBack, canTabVisitForward } from "../lib/tabVisitHistory";
import { useWorkspaceTabs } from "../stores/workspace";
import { requestProjectRailAction } from "../lib/projectRailActions";
import WorkspaceSessions from "./WorkspaceSessions";
import { sidebarVisible as asideVisible } from "./sidebarVisibility";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { openOrchestrationSettings } from "../lib/tcserver/rules";
import { useBootResumeToasts } from "./HostRows";
import { useProjectSignals } from "../hooks/useProjectSignals";
import { useDragResize } from "../hooks/useDragResize";
import { useSashKeys } from "../hooks/useSashKeys";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { looksLikeProject } from "../lib/recents";
import { ADD_WORKSPACE, ProjectRail, RailFoot } from "./ProjectRail";
import {
  useProject,
  useProjectCwds,
  useRailRecents,
  useSelectedWorkspaceId,
  useSelectedWorkspaceIds,
} from "../stores/project";
import { shell, useShell, type AliaxPageId } from "../stores/shell";
import { DevModeSlot, TabVisitNav } from "./TitleBar";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import type { OpenFileFn } from "../lib/search";
import { dialogsChunk } from "../surfaces/chunks";

// Opened from the workspace menu; mounted only while open (chrome/dialogs.ts).
const NewProjectDialog = dialogsChunk.surface("NewProjectDialog");
const ThreadDefaultsDialog = dialogsChunk.surface("ThreadDefaultsDialog");
const PreambleDialog = dialogsChunk.surface("PreambleDialog");

const MIN_WIDTH = 260;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 260;

let rememberedWidth = DEFAULT_WIDTH;

type Props = {
  onSelectSession: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => void;
  onDeleteSession?: (sessionId: string, options?: { confirmed?: boolean }) => void;
  onOpenFile: OpenFileFn;
  onOpenTerminal?: (cwd: string) => void;
  onFileMoved?: (from: string, to: string) => void;
  onFileDeleted?: (path: string) => void;
  onOpenFilesSearch?: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onOpenDiff?: (path: string) => void;
  onShowSourceControl?: () => void;
  onSelectAgent?: (sessionId: string) => void;
  onSelectProject?: (path: string) => void;
  onOpenProject?: (environmentId?: string, title?: string) => void;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  onNew?: () => string | void;
  onNewTerminal?: () => void;
  onSearch?: () => void;
  onOpenInbox?: () => void;
  onOpenNotes?: () => void;
  onOpenAccountsPage?: (page: AliaxPageId) => void;
  onOpenChats?: () => void;
  onGoToFile?: () => void;
  onSelectProjectCard?: (projectId: string | null) => void;
  onNewChat?: (projectId: string | null) => void;
  onProjectCreated?: (project: ProjectMeta) => void;
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
};

function SidebarComponent({
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onGoBack,
  onGoForward,
  onSelectAgent,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  onNew,
  onSearch,
  onOpenInbox,
  onOpenAccountsPage,
  onOpenChats,
  onSelectProjectCard,
  onNewChat,
  onProjectCreated,
  onOpenWhatsNew,
}: Props) {
  // The folder, the focused session and the visit trail come off the stores:
  // App passes handlers only, so a tab switch re-renders this, not App's tree.
  const { active, sidebarCwd: cwd, gitCwd } = useProjectCwds();
  const activeSessionId = active?.id;
  const canVisitBack = useWorkspaceTabs((s) => canTabVisitBack(s.visits));
  const canGoForward = useWorkspaceTabs((s) => canTabVisitForward(s.visits));
  const recents = useRailRecents();
  const selectedProjectId = useProject((s) => s.selectedProjectId);
  /** The workspace folder the app is in: the rail highlights this row, not
   *  the focused thread's project folder. */
  const workspaceCwd = useProject((s) => s.projectCwd);
  /** Server workspace shown in the Sessions tab (null before the catalog loads). */
  const workspaceId = useSelectedWorkspaceId();
  /** With the workspace linked across hosts, every copy (the leader first). */
  const workspaceIds = useSelectedWorkspaceIds();
  const { busy: busyProjectPaths, needsYou: needsYouProjectPaths } =
    useProjectSignals();
  useBootResumeToasts();
  const reduceMotion = useReducedMotion();
  const gitRoot = gitCwd || cwd;
  // Focus boot: start the JVM engine for a build-file project as soon as
  // it is selected, so the first Java tab opens warm.
  const inProject = looksLikeProject(cwd);
  useEffect(() => {
    if (inProject) void warmProjectForCwd(gitRoot);
  }, [gitRoot, inProject]);
  const resize = useDragResize({
    min: MIN_WIDTH,
    max: () => Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5)),
    defaultWidth: DEFAULT_WIDTH,
    initial: rememberedWidth,
    onCommit: (next) => {
      rememberedWidth = next;
    },
  });
  const sashKeys = useSashKeys({
    label: "Resize sidebar",
    orientation: "vertical",
    value: resize.width,
    min: MIN_WIDTH,
    max: Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5)),
    getSpan: (handle) => handle.closest(".app-shell")?.getBoundingClientRect().width || window.innerWidth,
    direction: 1,
    onChange: resize.resizeTo,
    onReset: resize.reset,
  });
  const sessionsLock = useLockOverscroll<HTMLDivElement>();
  // The element that scrolls the column, as state: the list attaches to it
  // the render it arrives, also when Back mounts the column again.
  const [sessionsScroller, setSessionsScroller] = useState<HTMLDivElement | null>(null);
  const sessionsScrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      sessionsLock(el);
      setSessionsScroller(el);
    },
    [sessionsLock],
  );
  /** The home: no workspace folder, the chats outside every workspace. */
  const atHome = workspaceCwd === "~";
  const searchActive = useShell((s) => s.searchViewOpen);
  const inboxActive = useShell((s) => s.inboxViewOpen);
  const notesActive = useShell((s) => s.notesViewOpen);
  const accountsPage = useShell((s) => s.accountsPage);
  const projectRailOpen = useShell((s) => s.projectRailOpen);
  const settingsOpen = useShell((s) => s.settingsOpen);
  // Back leaves an overlay before it walks tab history.
  const canGoBack =
    canVisitBack || searchActive || settingsOpen || inboxActive || notesActive || !!accountsPage;
  const showProjectRail = Boolean(onSelectProject && onOpenProject);
  // Settings live in the rail slot, so they keep it visible even when the
  // project rail itself is collapsed.
  const railVisible = showProjectRail && (projectRailOpen || settingsOpen);
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const workspacePath = workspace?.path ?? cwd;
  // The header names the workspace as the rail does: its label, else its name.
  const [groupLabels, setGroupLabels] = useState(loadTabGroupLabels);
  useEffect(() => {
    const refresh = () => setGroupLabels(loadTabGroupLabels());
    window.addEventListener(TAB_GROUP_LABELS_CHANGED, refresh);
    return () => window.removeEventListener(TAB_GROUP_LABELS_CHANGED, refresh);
  }, []);
  const workspaces = useWorkspaces();
  const title = atHome
    ? "Chats"
    : resolveTabGroupLabel(
        workspaceLabelKey(workspaces, workspacePath, projectName(workspacePath)),
        groupLabels,
        workspace?.name ?? basename(workspacePath),
      );
  /** What the Sessions list shows: a workspace, the home (null), or nothing. */
  const sessionsScope: string | null | undefined = workspaceId ?? (atHome ? null : undefined);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [threadDefaultsOpen, setThreadDefaultsOpen] = useState(false);
  const [preambleOpen, setPreambleOpen] = useState(false);
  // The workspace menu's "Archive dormant threads": every settled, seen,
  // unpinned root the Sessions list shows for this workspace, project
  // threads and loose chats alike, sparing the focused session's tree.
  const metas = useSessionMetas();
  const { projects: catalogProjects, workspaces: catalogWorkspaces } = useWorkspaceCatalog();
  const lastSeen = useLastSeen();
  const seenFloor = useSeenFloor();
  const dormant = useMemo(() => {
    if (sessionsScope === undefined) return [];
    const inScope = scopeTest(workspaceIds && workspaceIds.length > 1 ? workspaceIds : sessionsScope);
    const roots = metas.filter(
      (m) =>
        !m.parentId &&
        !m.archived &&
        inScope(workspaceIdOf(m, catalogProjects, catalogWorkspaces)),
    );
    return dormantThreads(roots, lastSeen, seenFloor, focusedTree(metas, activeSessionId));
  }, [activeSessionId, catalogProjects, catalogWorkspaces, lastSeen, metas, seenFloor, sessionsScope, workspaceIds]);
  const dormantGroups = useMemo(() => dormantByType(dormant), [dormant]);
  const workspaceSessions =
    sessionsScope !== undefined && onSelectProjectCard && onNewChat ? (
      <WorkspaceSessions
        // One column per scope: a switch mounts the new scope's own memory.
        key={sessionsScope ?? "home"}
        workspaceId={sessionsScope}
        workspaceIds={workspaceIds}
        selectedProjectId={selectedProjectId}
        activeSessionId={activeSessionId}
        onSelectProject={onSelectProjectCard}
        onOpenSession={(id) => onSelectSession?.(id)}
        onNewChat={onNewChat}
        onNewProject={() => setNewProjectOpen(true)}
        onRenameSession={(id, title) => onRenameSession?.(id, title)}
        onDeleteSession={(id) => onDeleteSession?.(id, { confirmed: true })}
        scroller={sessionsScroller}
      />
    ) : null;
  const showSidebarFooter = !projectRailOpen;
  const sidebarVisible = asideVisible({
    inProject,
    atHome,
    searchActive,
    inboxActive,
    notesActive,
    accountsPage: accountsPage !== null,
    settingsOpen,
  });
  const sidebarContent = (
    <aside
      ref={resize.setPaneRef}
      className="sidebar-glass relative flex h-full min-h-0 shrink-0 flex-col border-r border-border"
    >
      {railVisible ? null : (
        <div
          className="flex h-10 shrink-0 select-none items-center pr-1.5"
          data-tauri-drag-region="deep"
        >
          {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
          <DevModeSlot />
          <TabVisitNav
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onGoBack={onGoBack}
            onGoForward={onGoForward}
            onTogglePanel={shell.toggleProjectRail}
            panelActive={false}
          />
        </div>
      )}
      {/* A 40px content box with the hairline under it, as the title bar's rows:
          its controls share the strip's y 6 line, its hairline the title bar's. */}
      <div
        className="box-content flex h-10 shrink-0 select-none items-center gap-0.5 border-b border-border pr-1.5 pl-3"
        data-tauri-drag-region="deep"
      >
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{title}</h2>
        <div className="flex shrink-0 items-center gap-0.5" data-tauri-drag-region="false">
          {onNew ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="New thread"
                    onClick={() => void onNew()}
                    className="text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <Plus className="size-4" strokeWidth={1.5} />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                New thread <Kbd>{`${MOD}N`}</Kbd>
              </TooltipContent>
            </Tooltip>
          ) : null}
          {workspaceSessions ? (
            <WorkspaceMenu
              trigger={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Workspace options"
                  {...dialogsChunk.intent}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="size-4" strokeWidth={1.5} />
                </Button>
              }
              canNewProject={!!workspace}
              onNewProject={() => setNewProjectOpen(true)}
              onNewChat={() => onNewChat?.(null)}
              dormantCount={dormant.length}
              onArchiveDormant={() => void Promise.allSettled(dormant.map((t) => archive(t.id, true)))}
              dormantGroups={dormantGroups}
              onArchiveDormantType={(type) =>
                void Promise.allSettled((dormantGroups.find((g) => g.type === type)?.threads ?? []).map((t) => archive(t.id, true)))
              }
              onThreadDefaults={workspace ? () => setThreadDefaultsOpen(true) : undefined}
              onOrchestration={workspace ? () => openOrchestrationSettings(workspace.id) : undefined}
              onPreamble={workspace ? () => setPreambleOpen(true) : undefined}
              onWorkspaceSettings={workspace ? () => openWorkspaceSettings(workspace.id) : undefined}
              onRemoveWorkspace={railVisible && !atHome ? () => requestProjectRailAction({ kind: "remove", path: workspacePath }) : undefined}
            />
          ) : null}
        </div>
      </div>
      <div
        ref={sessionsScrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none"
      >
        {workspaceSessions ?? (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">
            No project folder
          </p>
        )}
      </div>
      {showSidebarFooter && onOpenProject ? (
        <RailFoot
          activeSessionId={activeSessionId}
          onSearch={onSearch}
          onOpenInbox={onOpenInbox}
          onOpenAccountsPage={onOpenAccountsPage}
          onOpenWhatsNew={onOpenWhatsNew}
          onAddWorkspace={(environmentId) => onOpenProject(environmentId, ADD_WORKSPACE)}
        />
      ) : null}
      {preambleOpen && workspace ? (
        <PreambleDialog scope={{ kind: "workspace", workspace }} onClose={() => setPreambleOpen(false)} />
      ) : null}
      {threadDefaultsOpen && workspace ? (
        <ThreadDefaultsDialog
          workspace={workspace}
          onClose={() => setThreadDefaultsOpen(false)}
        />
      ) : null}
      {newProjectOpen && workspace ? (
        <NewProjectDialog
          workspace={workspace}
          onClose={() => setNewProjectOpen(false)}
          onCreated={(project) => {
            setNewProjectOpen(false);
            onProjectCreated?.(project);
          }}
        />
      ) : null}
      <div
        {...sashKeys}
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none outline-none focus-visible:bg-accent ${
          resize.dragging ? "bg-foreground/12" : "hover:bg-foreground/7"
        }`}
        onPointerDown={resize.onPointerDown}
      />
    </aside>
  );

  return (
    <div
      className={`flex h-full shrink-0 ${
        railVisible || sidebarVisible ? "" : "hidden"
      }`}
    >
      {railVisible && onSelectProject && onOpenProject ? (
        <ProjectRail
          cwd={workspaceCwd}
          recents={recents}
          busyPaths={busyProjectPaths}
          needsYouPaths={needsYouProjectPaths}
          activeSessionId={activeSessionId}
          onSelectAgent={onSelectAgent}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={onGoBack}
          onGoForward={onGoForward}
          onSearch={onSearch}
          onOpenInbox={onOpenInbox}
          onOpenAccountsPage={onOpenAccountsPage}
          onOpenChats={onOpenChats}
          onSelectProject={onSelectProject}
          onOpenProject={onOpenProject}
          onRemoveProject={onRemoveProject}
          onOpenWhatsNew={onOpenWhatsNew}
        />
      ) : null}
      <AnimatePresence initial={false}>
        {sidebarVisible ? (
          <motion.div
            key="sidebar"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: DUR.fast, ease: EASE_OUT }}
            className="flex h-full shrink-0"
          >
            {sidebarContent}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export const Sidebar = memo(SidebarComponent);
