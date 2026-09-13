import {
  Inbox,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  StickyNote,
} from "./icons";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { warmProjectForCwd } from "../lib/monaco/focusBoot";
import {
  loadSidebarTabOrder,
  saveSidebarTabOrder,
  type SidebarLayout,
  type SidebarTabId,
} from "../lib/appearance";
import { basename } from "../lib/fs";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { SPRING_LAYOUT } from "../lib/ease";
import { IS_MAC, MOD } from "../lib/platform";
import { projectName } from "../lib/paths";
import type { HarnessId } from "../lib/session";
import type { ProjectMeta } from "../lib/tcserver/types";
import { useWorkspaces, workspaceLabelKey } from "../lib/tcserver/workspaces";
import { openWorkspaceSettings } from "../lib/settings";
import { requestProjectRailAction } from "../lib/projectRailActions";
import WorkspaceSessions from "./WorkspaceSessions";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { NewProjectDialog } from "./ProjectDialogs";
import { ThreadDefaultsDialog } from "./ThreadDefaultsDialog";
import { openOrchestrationSettings } from "../lib/tcserver/rules";
import { useLiveAgents } from "../lib/liveAgentTracker";
import { useProjectSignals } from "../hooks/useProjectSignals";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../lib/tabGroups";
import { useDragResize } from "../hooks/useDragResize";
import { useGitFileStatuses } from "../hooks/useGitFileStatuses";
import { useInboxUnseen } from "../hooks/useInboxUnseen";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useProjectDiffStats } from "../hooks/useProjectDiffStats";
import { useSortable } from "../hooks/useSortable";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  looksLikeProject,
  sameProjectPath,
  type RecentProject,
} from "../lib/recents";
import { CwdPicker } from "./CwdPicker";
import { FileTree } from "./FileTree";
import { FileTypeIcon } from "./FileTypeIcon";
import { ProjectRail } from "./ProjectRail";
import { shell, useShell } from "../stores/shell";
import { RailAction } from "./RailAction";
import { SettingsNav } from "./SettingsRail";
import { DevModeLabel, DevModeSlot, IconButton, TabVisitNav } from "./TitleBar";
import { ProjectSearch } from "./ProjectSearch";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectMascot } from "./ProjectMascot";
import { SidebarUpdateFooter } from "./SidebarUpdate";
import { SourceControl } from "./SourceControl";
import { InboxView } from "../surfaces/InboxView";

const MIN_WIDTH = 260;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 260;

let rememberedWidth = DEFAULT_WIDTH;

type SidebarTab = SidebarTabId;

const TAB_LABELS: Record<SidebarTab, string> = {
  sessions: "Sessions",
  inbox: "Inbox",
  files: "Explorer",
  changes: "Changes",
};

function projectPathIn(
  paths: Iterable<string> | undefined,
  cwd: string,
): boolean {
  if (!paths) return false;
  for (const path of paths) {
    if (sameProjectPath(path, cwd)) return true;
  }
  return false;
}

type Props = {
  cwd: string;
  /** Working copy for Changes / explorer git. Falls back to `cwd`. */
  gitCwd?: string;
  layout: SidebarLayout;
  activeSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => void;
  onDeleteSession?: (sessionId: string, options?: { confirmed?: boolean }) => void;
  onOpenFile: (path: string) => void;
  onOpenTerminal?: (cwd: string) => void;
  onFileMoved?: (from: string, to: string) => void;
  onFileDeleted?: (path: string) => void;
  onOpenFilesSearch?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onOpenDiff?: (path: string) => void;
  selectedDiffPath?: string;
  textHarness?: HarnessId;
  onShowSourceControl?: () => void;
  recents?: RecentProject[];
  onSelectAgent?: (sessionId: string) => void;
  onSelectProject?: (path: string) => void;
  onOpenProject?: () => void;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  onNew?: () => string | void;
  onNewTerminal?: () => void;
  onSearch?: () => void;
  onOpenInbox?: () => void;
  onOpenNotes?: () => void;
  onGoToFile?: () => void;
  notesEnabled?: boolean;
  /** Server workspace shown in the Sessions tab (null before the catalog loads). */
  workspaceId?: string | null;
  selectedProjectId?: string | null;
  onSelectProjectCard?: (projectId: string | null) => void;
  onNewChat?: (projectId: string | null) => void;
  onProjectCreated?: (project: ProjectMeta) => void;
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
};

function SidebarComponent({
  cwd,
  gitCwd,
  layout,
  activeSessionId,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onOpenFile,
  onOpenTerminal,
  onFileMoved,
  onFileDeleted,
  onOpenFilesSearch,
  canGoBack: canVisitBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onOpenDiff,
  selectedDiffPath,
  textHarness,
  onShowSourceControl,
  recents = [],
  onSelectAgent,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  onNew,
  onNewTerminal,
  onSearch,
  onOpenInbox,
  onOpenNotes,
  onGoToFile,
  notesEnabled = true,
  workspaceId = null,
  selectedProjectId = null,
  onSelectProjectCard,
  onNewChat,
  onProjectCreated,
  onOpenWhatsNew,
}: Props) {
  const { busy: busyProjectPaths, needsYou: needsYouProjectPaths } =
    useProjectSignals();
  const liveAgents = useLiveAgents();
  const reduceMotion = useReducedMotion();
  const gitRoot = gitCwd || cwd;
  // Focus boot: start the JVM engine for a build-file project as soon as
  // it is selected, so the first Java tab opens warm.
  useEffect(() => {
    if (cwd && cwd !== "~") void warmProjectForCwd(gitRoot);
  }, [cwd, gitRoot]);
  const inboxUnseen = useInboxUnseen(recents, cwd);
  const resize = useDragResize({
    min: MIN_WIDTH,
    max: () => Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5)),
    defaultWidth: DEFAULT_WIDTH,
    initial: rememberedWidth,
    onCommit: (next) => {
      rememberedWidth = next;
    },
  });
  const [tabOrder, setTabOrder] = useState<SidebarTab[]>(loadSidebarTabOrder);
  const sessionsLock = useLockOverscroll<HTMLDivElement>();
  const sessionsScrollRef = useRef<HTMLDivElement>(null);
  const deckLayout = layout === "deck";
  const tab = useShell((s) => s.sidebarTab);
  const filesSearchOpen = useShell((s) => s.filesSearchOpen);
  const searchFocusToken = useShell((s) => s.searchFocusToken);
  const searchActive = useShell((s) => s.searchViewOpen);
  const inboxActive = useShell((s) => s.inboxViewOpen);
  const notesActive = useShell((s) => s.notesViewOpen);
  const sidebarOpen = useShell((s) => s.sidebarOpen);
  const projectRailOpen = useShell((s) => s.projectRailOpen);
  const settingsOpen = useShell((s) => s.settingsOpen);
  const settingsSection = useShell((s) => s.settingsSection);
  const updateNotice = useShell((s) => s.updateNotice);
  const open = deckLayout || sidebarOpen || settingsOpen;
  // Back leaves an overlay before it walks tab history.
  const canGoBack =
    canVisitBack || searchActive || settingsOpen || inboxActive || notesActive;
  const sortable = useSortable(tabOrder, (ids) => {
    const next = ids as SidebarTab[];
    setTabOrder(next);
    saveSidebarTabOrder(next);
    if (next[0]) shell.setSidebarTab(next[0]);
  });
  const visibleTabs = deckLayout
    ? tabOrder.filter((itemId) => itemId !== "inbox")
    : tabOrder.filter((itemId) => itemId !== "changes");
  const canDragTabs = visibleTabs.length > 1;
  const showProjectRail =
    deckLayout && Boolean(onSelectProject && onOpenProject);
  // Settings live in the rail slot, so they keep it visible even when the
  // project rail itself is collapsed.
  const railVisible = showProjectRail && (projectRailOpen || settingsOpen);
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const workspacePath = workspace?.path ?? cwd;
  const [workspaceMenu, setWorkspaceMenu] = useState<HTMLElement | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [threadDefaultsOpen, setThreadDefaultsOpen] = useState(false);
  const openWorkspaceMenu = (event: ReactMouseEvent<HTMLButtonElement>) =>
    setWorkspaceMenu(event.currentTarget);
  const workspaceSessions =
    workspaceId && onSelectProjectCard && onNewChat ? (
      <WorkspaceSessions
        workspaceId={workspaceId}
        selectedProjectId={selectedProjectId}
        activeSessionId={activeSessionId}
        onSelectProject={onSelectProjectCard}
        onOpenSession={(id) => onSelectSession?.(id)}
        onNewChat={onNewChat}
        onNewProject={() => setNewProjectOpen(true)}
        onRenameSession={(id, title) => onRenameSession?.(id, title)}
        onDeleteSession={(id) => onDeleteSession?.(id, { confirmed: true })}
      />
    ) : null;
  const inProject = looksLikeProject(cwd);
  const classicSettings = settingsOpen && !deckLayout;
  const showSidebarFooter = !deckLayout || !projectRailOpen;
  // A blank session has no project to browse, so the shell stands alone until
  // one is picked — whether or not the rail is open. Classic settings keep the
  // sidebar so it can host the section nav the rail would otherwise carry.
  const sidebarVisible =
    open &&
    !searchActive &&
    !inboxActive &&
    !notesActive &&
    (classicSettings || (!settingsOpen && !(deckLayout && !inProject)));
  const gitStatuses = useGitFileStatuses(gitRoot, open && tab === "files");
  const changeStats = useProjectDiffStats(gitRoot, open);
  const groupLogos = useTabGroupLogos();
  const projectLogoPath = resolveTabGroupLogo(projectName(cwd), groupLogos);

  const onTabPick = (itemId: SidebarTab) => {
    shell.setSidebarTab(itemId);
  };

  const changeAdditions = changeStats?.additions ?? 0;
  const changeDeletions = changeStats?.deletions ?? 0;
  const hasChangeStats = changeAdditions > 0 || changeDeletions > 0;

  const workspaceTabItems = visibleTabs.map((itemId, index) => {
    const active = tab === itemId;
    const isChangesTab = itemId === "changes";
    const draggingTab = sortable.draggingId === itemId;
    const showStart =
      sortable.draggingId &&
      sortable.toIndex !== null &&
      sortable.toIndex === index &&
      sortable.fromIndex !== null &&
      sortable.toIndex < sortable.fromIndex;
    const showEnd =
      sortable.draggingId &&
      sortable.toIndex !== null &&
      sortable.toIndex === index &&
      sortable.fromIndex !== null &&
      sortable.toIndex > sortable.fromIndex;
    return (
      <div
        key={itemId}
        ref={(el) => sortable.setItemRef(itemId, el)}
        className={`relative flex min-w-0 flex-1 touch-none items-stretch ${
          draggingTab ? "opacity-40" : ""
        } ${canDragTabs ? "cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          onTabPick(itemId);
          sortable.onItemPointerDown(itemId, event);
        }}
      >
        {showStart ? (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-0.5 bg-accent" />
        ) : null}
        {showEnd ? (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-0.5 bg-accent" />
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={active}
          aria-label={
            isChangesTab
              ? hasChangeStats
                ? [
                    "Changes",
                    changeAdditions > 0 ? `+${changeAdditions}` : "",
                    changeDeletions > 0 ? `-${changeDeletions}` : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                : "Changes"
              : undefined
          }
          data-tauri-drag-region="false"
          onClick={() => {
            if (sortable.consumeClick()) return;
            onTabPick(itemId);
          }}
          className={`flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md px-2 text-[12px] leading-none ${
            active
              ? "bg-content/10 text-content"
              : "text-content/50 hover:bg-content/5 hover:text-content"
          } ${canDragTabs ? "cursor-grab active:cursor-grabbing" : ""}`}
        >
          {isChangesTab && hasChangeStats ? (
            <DiffStat additions={changeAdditions} deletions={changeDeletions} />
          ) : (
            <span className="block truncate">{TAB_LABELS[itemId]}</span>
          )}
        </button>
      </div>
    );
  });

  const sidebarContent = (
    <aside
      ref={resize.setPaneRef}
      className="sidebar-glass relative flex h-full min-h-0 shrink-0 flex-col border-r border-content/10"
    >
      {deckLayout && railVisible ? (
        <>
          <div
            className="flex h-10 shrink-0 select-none items-center gap-1 border-b border-content/10 pl-3 pr-1.5"
            data-tauri-drag-region="deep"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
              Workspace
            </span>
            <WorkspaceTitleActions
              onSearch={onGoToFile}
              onNew={onNew}
              onMenu={workspaceSessions ? openWorkspaceMenu : undefined}
              menuOpen={!!workspaceMenu}
            />
          </div>
          <div
            role="tablist"
            aria-label="Workspace"
            className="flex h-9 shrink-0 items-center gap-px border-b border-content/10 px-2"
          >
            {workspaceTabItems}
          </div>
        </>
      ) : (
        <>
          {deckLayout ? (
            <div
              className="flex h-10 shrink-0 select-none items-center border-b border-content/10 pr-1.5"
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
          ) : (
            <div
              className="flex h-9.75 shrink-0 select-none items-center justify-end gap-1 pr-1.5"
              data-tauri-drag-region="deep"
            >
              <DevModeLabel />
              <TabVisitNav
                canGoBack={canGoBack}
                canGoForward={canGoForward}
                onGoBack={onGoBack}
                onGoForward={onGoForward}
              />
            </div>
          )}
          {deckLayout && onSelectProject ? (
            <SidebarProjectPicker
              cwd={cwd}
              recents={recents}
              busy={projectPathIn(busyProjectPaths, cwd)}
              needsYou={projectPathIn(needsYouProjectPaths, cwd)}
              onSelectProject={onSelectProject}
              onNewTerminal={onNewTerminal}
              onSearch={onSearch}
              onOpenInbox={onOpenInbox}
              onOpenNotes={notesEnabled ? onOpenNotes : undefined}
              searchActive={searchActive}
              inboxActive={inboxActive}
              notesActive={notesActive}
              inboxUnseen={inboxUnseen}
            />
          ) : null}
          {classicSettings ? null : (
            <div
              role="tablist"
              aria-label="Workspace"
              className={`flex h-9 shrink-0 items-center gap-px overflow-visible border-content/10 px-2 ${
                // Mirrors the rail-open header stack: each row owns its own
                // bottom border, so the seams land on the title bar's.
                deckLayout ? "border-b" : "border-y"
              }`}
            >
              {workspaceTabItems}
            </div>
          )}
        </>
      )}
      {classicSettings ? (
        <SettingsNav
          section={settingsSection}
          onSelect={shell.selectSettingsSection}
          onClose={shell.closeSettings}
        />
      ) : (
        <>
          <div
            className={`flex min-h-0 flex-1 flex-col overflow-hidden ${
              tab === "files" ? "" : "hidden"
            }`}
          >
            {filesSearchOpen ? (
              <ProjectSearch
                cwd={gitRoot}
                focusToken={searchFocusToken}
                onOpenFile={onOpenFile}
                onClose={() => shell.setFilesSearchOpen(false)}
              />
            ) : cwd && cwd !== "~" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <FileTree
                  key={gitRoot}
                  cwd={gitRoot}
                  onOpenFile={onOpenFile}
                  onOpenTerminal={onOpenTerminal}
                  onFileMoved={onFileMoved}
                  onFileDeleted={onFileDeleted}
                  onSearch={onOpenFilesSearch}
                  gitStatuses={gitStatuses}
                  sourceControlActive={open && tab === "changes"}
                  onShowSourceControl={onShowSourceControl}
                />
              </div>
            ) : (
              <p className="px-3 py-2 text-[12px] text-content/50">
                No project folder
              </p>
            )}
          </div>
          {!deckLayout && tab === "sessions" && cwd && cwd !== "~" ? (
            <div className="shrink-0 border-b border-content/10">
              <div className="flex h-9 items-center px-2 pr-1.5">
                <div
                  title={cwd}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5"
                >
                  {projectLogoPath ? (
                    <ProjectLogoIcon
                      path={projectLogoPath}
                      className="size-4 shrink-0 rounded-sm ml-1.5"
                      imageClassName="size-4"
                    />
                  ) : (
                    <span className="grid size-6 shrink-0 place-items-center">
                      <FileTypeIcon name={basename(cwd)} isDir isRoot />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">
                    {workspace?.name ?? basename(cwd)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-px">
                  {workspaceSessions ? (
                    <SessionsHeaderButton
                      label="Workspace actions"
                      open={!!workspaceMenu}
                      hasPopup
                      onClick={openWorkspaceMenu}
                    >
                      <MoreHorizontal className="size-3" strokeWidth={1.75} />
                    </SessionsHeaderButton>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          <div
            ref={(el) => {
              sessionsLock(el);
              sessionsScrollRef.current = el;
            }}
            className={`min-h-0 flex-1 overflow-y-auto overscroll-none ${
              tab === "sessions" ? "" : "hidden"
            }`}
          >
            {!cwd || cwd === "~" ? (
              <p className="px-3 py-2 text-[12px] text-content/50">
                No project folder
              </p>
            ) : (
              workspaceSessions
            )}
          </div>
          {deckLayout && tab === "changes" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <SourceControl
                cwd={gitRoot}
                enabled={open}
                textHarness={textHarness}
                selectedPath={selectedDiffPath}
                onOpenFile={onOpenDiff ?? onOpenFile}
              />
            </div>
          ) : null}
          {!deckLayout && tab === "inbox" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <InboxView cwd={cwd} recents={recents} variant="sidebar" />
            </div>
          ) : null}
          {showSidebarFooter ? (
            <>
              <SidebarUpdateFooter
                update={updateNotice}
                onOpenWhatsNew={onOpenWhatsNew}
                onDismissUpdate={shell.dismissUpdate}
              />
              <div className="flex shrink-0 flex-col gap-px p-2 pt-0">
                <RailAction
                  label="Settings"
                  icon={Settings}
                  onClick={() => shell.openSettings()}
                  shortcut={`${MOD},`}
                  ariaLabel={`Settings (${MOD},)`}
                />
              </div>
            </>
          ) : null}
        </>
      )}
      {workspaceMenu ? (
        <WorkspaceMenu
          anchor={workspaceMenu}
          onDismiss={() => setWorkspaceMenu(null)}
          canNewProject={!!workspace}
          onNewProject={() => setNewProjectOpen(true)}
          onNewChat={() => onNewChat?.(null)}
          onThreadDefaults={workspace ? () => setThreadDefaultsOpen(true) : undefined}
          onOrchestration={workspace ? () => openOrchestrationSettings(workspace.id) : undefined}
          onWorkspaceSettings={workspace ? () => openWorkspaceSettings(workspace.id) : undefined}
          onRemoveWorkspace={
            railVisible
              ? () => requestProjectRailAction({ kind: "remove", path: workspacePath })
              : undefined
          }
        />
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
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={resize.width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
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
          cwd={cwd}
          recents={recents}
          inboxUnseen={inboxUnseen}
          busyPaths={busyProjectPaths}
          needsYouPaths={needsYouProjectPaths}
          liveAgents={liveAgents}
          activeSessionId={activeSessionId}
          onSelectAgent={onSelectAgent}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={onGoBack}
          onGoForward={onGoForward}
          onSearch={onSearch}
          onOpenInbox={onOpenInbox}
          notesEnabled={notesEnabled}
          onOpenNotes={onOpenNotes}
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
            initial={{ width: 0 }}
            animate={{ width: "auto" }}
            exit={{ width: 0 }}
            transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
            className="flex h-full shrink-0 overflow-hidden"
          >
            {sidebarContent}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export const Sidebar = memo(SidebarComponent);

function SidebarProjectPicker({
  cwd,
  recents,
  busy,
  needsYou = false,
  onSelectProject,
  onNewTerminal,
  onSearch,
  onOpenInbox,
  onOpenNotes,
  searchActive = false,
  inboxActive = false,
  notesActive = false,
  inboxUnseen = false,
}: {
  cwd: string;
  recents: RecentProject[];
  busy: boolean;
  needsYou?: boolean;
  onSelectProject: (path: string) => void;
  onNewTerminal?: () => void;
  onSearch?: () => void;
  onOpenInbox?: () => void;
  onOpenNotes?: () => void;
  searchActive?: boolean;
  inboxActive?: boolean;
  notesActive?: boolean;
  inboxUnseen?: boolean;
}) {
  const [groupLabels] = useState(loadTabGroupLabels);
  const [groupColors] = useState(loadTabGroupColors);
  const [groupCustomColors] = useState(loadTabGroupCustomColors);
  const [groupMascots] = useState(loadTabGroupMascots);
  const groupLogos = useTabGroupLogos();
  const projectKey = workspaceLabelKey(useWorkspaces(), cwd, projectName(cwd));
  const label = resolveTabGroupLabel(
    projectKey,
    groupLabels,
    basename(cwd) || projectKey,
  );
  const logoPath = resolveTabGroupLogo(projectKey, groupLogos);
  const color = resolveTabGroupColor(
    projectKey,
    groupColors,
    groupCustomColors,
    projectKey,
  );

  return (
    <div
      className="flex h-9 items-center gap-0.5 border-b border-content/10 px-2"
      data-tauri-drag-region="deep"
    >
      <CwdPicker
        cwd={cwd}
        recents={recents}
        placement="below"
        chevron
        onCwdChange={onSelectProject}
        onNewTerminal={onNewTerminal}
        className="min-w-0 items-center"
        buttonClassName="flex h-6.5 w-full items-center gap-1.5 rounded-md px-2 text-[12px] leading-none text-content/50 hover:text-content"
      >
        {logoPath ? (
          <ProjectLogoIcon
            path={logoPath}
            className="size-3.5 shrink-0 rounded-sm"
            imageClassName="size-3.5"
          />
        ) : (
          <ProjectMascot
            project={projectKey}
            color={needsYou ? "var(--color-warning)" : color}
            name={resolveTabGroupMascot(projectKey, groupMascots)}
            className="size-3 shrink-0"
            active={busy}
          />
        )}
        <span className="min-w-0 truncate">{label}</span>
      </CwdPicker>
      <div className="flex items-center ml-auto">
        {onSearch ? (
          <IconButton
            label={`Search (${MOD}K)`}
            active={searchActive}
            onClick={onSearch}
          >
            <Search className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        ) : null}
        {onOpenInbox ? (
          <IconButton
            label={inboxUnseen ? "Inbox, new items" : "Inbox"}
            active={inboxActive}
            onClick={onOpenInbox}
          >
            <span className="relative">
              <Inbox className="size-3.5" strokeWidth={1.75} />
              {inboxUnseen ? (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent"
                />
              ) : null}
            </span>
          </IconButton>
        ) : null}
        {onOpenNotes ? (
          <IconButton label="Notes" active={notesActive} onClick={onOpenNotes}>
            <StickyNote className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceTitleActions({
  onSearch,
  onNew,
  onMenu,
  menuOpen = false,
}: {
  onSearch?: () => void;
  onNew?: () => void;
  onMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  menuOpen?: boolean;
}) {
  if (!onSearch && !onNew && !onMenu) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      data-tauri-drag-region="false"
    >
      {onMenu ? (
        <SessionsHeaderButton
          label="Workspace actions"
          open={menuOpen}
          hasPopup
          onClick={onMenu}
        >
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </SessionsHeaderButton>
      ) : null}
      {onSearch ? (
        <IconButton label={`Go to File (${MOD}P)`} onClick={onSearch}>
          <Search className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
      {onNew ? (
        <IconButton label={`New session (${MOD}T)`} onClick={onNew}>
          <Plus className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
    </div>
  );
}

function SessionsHeaderButton({
  label,
  active = false,
  open = false,
  hasPopup = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  open?: boolean;
  hasPopup?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup={hasPopup ? "menu" : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={`relative z-50 grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content ${
        open || active ? "bg-content/10 text-content" : ""
      }`}
    >
      {children}
    </button>
  );
}

function DiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions <= 0 && deletions <= 0) return null;

  const label = [
    additions > 0 ? `+${additions}` : "",
    deletions > 0 ? `-${deletions}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      title={`${label} uncommitted`}
      className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] font-semibold tabular-nums"
    >
      {additions > 0 ? (
        <span className="text-emerald-400">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-red-400">-{deletions}</span>
      ) : null}
    </span>
  );
}

