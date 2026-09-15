import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FolderOpen,
  Inbox,
  MoreHorizontal,
  Pause,
  Pin,
  PinOff,
  File,
  Plus,
  Search,
  Settings,
  Trash2,
} from "./icons";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useProjectDiffStats } from "../hooks/useProjectDiffStats";
import { useSortable } from "../hooks/useSortable";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  loadProjectRailWidth,
  PROJECT_RAIL_WIDTH_DEFAULT,
  PROJECT_RAIL_WIDTH_MAX,
  PROJECT_RAIL_WIDTH_MIN,
  saveProjectRailWidth,
} from "../lib/appearance";
import { basename, revealPath, type GitDiffStats } from "../lib/fs";
import { IS_MAC, MOD } from "../lib/platform";
import { projectName } from "../lib/paths";
import {
  collectRailProjects,
  loadPinnedProjects,
  loadProjectRailOrder,
  projectRailSections,
  sameProjectPath,
  savePinnedProjects,
  saveProjectRailOrder,
  syncProjectRailOrder,
  type RecentProject,
} from "../lib/recents";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  TAB_GROUP_LABELS_CHANGED,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupColorIndex,
  resolveTabGroupCustomColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
  saveTabGroupColor,
  saveTabGroupCustomColor,
  saveTabGroupLabel,
  saveTabGroupMascot,
} from "../lib/tabGroups";
import { formatLiveElapsed, type LiveAgent } from "../lib/liveAgents";
import type { CardThread } from "../lib/projectCardModel";
import { useWorkspaceRailStatuses, type WorkspaceRailStatus } from "../hooks/useProjectSignals";
import { HarnessIcon } from "./HarnessIcon";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { WorkspaceThreadsPopover } from "./WorkspaceThreadsPopover";
import { subscribeProjectRailActions } from "../lib/projectRailActions";
import {
  useWorkspaceIcon,
  useWorkspaces,
  workspaceByPath,
  workspaceLabelKey,
} from "../lib/tcserver/workspaces";
import { ProjectMascot } from "./ProjectMascot";
import { RailAction, RailSearch } from "./RailAction";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DevModeSlot, TabVisitNav } from "./TitleBar";
import { SidebarUpdateFooter } from "./SidebarUpdate";
import { shell, useShell } from "../stores/shell";
import { SettingsNav } from "./SettingsRail";
import { Shimmer } from "../surfaces/Shimmer";
import { TabGroupMenu, type TabGroupMenuExtraItem } from "./TabGroupMenu";
import { TerminalSpinner } from "./TerminalSpinner";

const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : typeof navigator !== "undefined" && /Win/.test(navigator.platform)
    ? "Reveal in File Explorer"
    : "Open Containing Folder";

function projectMenuExtraItems(
  pinned: boolean,
  canRemove: boolean,
): TabGroupMenuExtraItem[] {
  const items: TabGroupMenuExtraItem[] = [
    pinned
      ? { id: "unpin", label: "Unpin workspace", icon: PinOff }
      : { id: "pin", label: "Pin workspace", icon: Pin },
    { id: "reveal", label: REVEAL_LABEL, icon: FolderOpen },
  ];
  if (canRemove) {
    items.push(
      { id: "archive", label: "Archive", icon: Archive, sepBefore: true },
      { id: "delete", label: "Delete", icon: Trash2, danger: true },
    );
  }
  return items;
}

type Props = {
  cwd: string;
  recents: RecentProject[];
  inboxUnseen?: boolean;
  busyPaths?: Iterable<string>;
  /** Folders holding a thread blocked on the user. Outranks `busyPaths`. */
  needsYouPaths?: Iterable<string>;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onSearch?: () => void;
  onOpenInbox?: () => void;
  notesEnabled?: boolean;
  onOpenNotes?: () => void;
  onSelectProject: (path: string) => void;
  onOpenProject: () => void;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  liveAgents?: LiveAgent[];
  activeSessionId?: string;
  onSelectAgent?: (sessionId: string) => void;
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
};

export function ProjectRail({
  cwd,
  recents,
  inboxUnseen = false,
  busyPaths,
  needsYouPaths,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onSearch,
  onOpenInbox,
  notesEnabled = true,
  onOpenNotes,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  liveAgents = [],
  activeSessionId,
  onSelectAgent,
  onOpenWhatsNew,
}: Props) {
  const searchActive = useShell((s) => s.searchViewOpen);
  const inboxActive = useShell((s) => s.inboxViewOpen);
  const notesActive = useShell((s) => s.notesViewOpen);
  const settingsOpen = useShell((s) => s.settingsOpen);
  const settingsSection = useShell((s) => s.settingsSection);
  const updateNotice = useShell((s) => s.updateNotice);
  const resize = useDragResize({
    min: PROJECT_RAIL_WIDTH_MIN,
    max: () =>
      Math.min(PROJECT_RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.35)),
    defaultWidth: PROJECT_RAIL_WIDTH_DEFAULT,
    initial: loadProjectRailWidth(),
    onCommit: saveProjectRailWidth,
  });
  const [railOrder, setRailOrder] = useState(loadProjectRailOrder);
  const [pinnedPaths, setPinnedPaths] = useState(loadPinnedProjects);
  // Labels, colours and mascots key by workspace id so two folders that
  // share a basename stay apart.
  const workspaces = useWorkspaces();
  const labelKey = (path: string) => workspaceLabelKey(workspaces, path, projectName(path));
  const [groupLabels, setGroupLabels] = useState(loadTabGroupLabels);
  useEffect(() => {
    const refresh = () => setGroupLabels(loadTabGroupLabels());
    window.addEventListener(TAB_GROUP_LABELS_CHANGED, refresh);
    return () => window.removeEventListener(TAB_GROUP_LABELS_CHANGED, refresh);
  }, []);
  const [groupColors, setGroupColors] = useState(loadTabGroupColors);
  const [groupMascots, setGroupMascots] = useState(loadTabGroupMascots);
  const [groupCustomColors, setGroupCustomColors] = useState(
    loadTabGroupCustomColors,
  );
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    path: string;
    projectKey: string;
  } | null>(null);
  const [removing, setRemoving] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const groupLogos = useTabGroupLogos();
  // Workspaces only: a thread's project folder never earns a row of its own.
  const allProjects = useMemo(() => collectRailProjects(recents, null), [recents]);
  const sections = useMemo(
    () => projectRailSections(recents, null, railOrder, pinnedPaths),
    [pinnedPaths, railOrder, recents],
  );
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const path of busyPaths ?? []) set.add(path);
    return set;
  }, [busyPaths]);
  const needsYou = useMemo(() => {
    const set = new Set<string>();
    for (const path of needsYouPaths ?? []) set.add(path);
    return set;
  }, [needsYouPaths]);
  const railStatuses = useWorkspaceRailStatuses();

  useEffect(() => {
    setRailOrder((prev) => {
      const synced = syncProjectRailOrder(prev, allProjects);
      if (synced.join("\0") === prev.join("\0")) return prev;
      saveProjectRailOrder(synced);
      return synced;
    });
  }, [allProjects]);

  useEffect(() => {
    setPinnedPaths((prev) => {
      const next = prev.filter((path) => allProjects.has(path));
      if (next.length === prev.length) return prev;
      savePinnedProjects(next);
      return next;
    });
  }, [allProjects]);

  useEffect(() => {
    if (!projectMenu) return;
    const onScroll = () => setProjectMenu(null);
    const scrollParent = scrollRef.current ?? window;
    scrollParent.addEventListener("scroll", onScroll, true);
    return () => scrollParent.removeEventListener("scroll", onScroll, true);
  }, [projectMenu]);

  const openProjectMenu = (path: string, x: number, y: number) => {
    setProjectMenu({
      x,
      y,
      path,
      projectKey: labelKey(path),
    });
  };

  const onProjectContextMenu = (
    path: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectMenu(path, event.clientX, event.clientY);
  };

  const onProjectRename = (projectKey: string, label: string) => {
    saveTabGroupLabel(projectKey, label);
    setGroupLabels(loadTabGroupLabels());
  };

  const onProjectColorChange = (
    projectKey: string,
    colorIndex: number | null,
  ) => {
    saveTabGroupColor(projectKey, colorIndex);
    setGroupColors(loadTabGroupColors());
    setGroupCustomColors(loadTabGroupCustomColors());
  };

  const onProjectMascotChange = (projectKey: string, name: string | null) => {
    saveTabGroupMascot(projectKey, name);
    setGroupMascots(loadTabGroupMascots());
  };

  const onProjectCustomColorChange = (projectKey: string, color: string) => {
    saveTabGroupCustomColor(projectKey, color);
    setGroupColors(loadTabGroupColors());
    setGroupCustomColors(loadTabGroupCustomColors());
  };

  const reorderSubset = (
    fullOrder: string[],
    subsetOrder: string[],
    subsetPaths: Set<string>,
  ) => {
    const next: string[] = [];
    let subsetIndex = 0;
    for (const path of fullOrder) {
      if (!subsetPaths.has(path)) {
        next.push(path);
        continue;
      }
      if (subsetIndex < subsetOrder.length) {
        next.push(subsetOrder[subsetIndex++]);
      }
    }
    return next;
  };

  const onReorderPinned = (ids: string[]) => {
    const subset = new Set(sections.pinned.map((item) => item.path));
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onReorderProjects = (ids: string[]) => {
    const subset = new Set(sections.projects.map((item) => item.path));
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onTogglePin = (path: string) => {
    const isPinned = pinnedPaths.some((pinned) =>
      sameProjectPath(pinned, path),
    );
    const next = isPinned
      ? pinnedPaths.filter((pinned) => !sameProjectPath(pinned, path))
      : [...pinnedPaths, path];
    setPinnedPaths(next);
    savePinnedProjects(next);
  };

  const onProjectMenuPick = (action: string) => {
    if (!projectMenu) return;
    const { path, projectKey } = projectMenu;
    if (action === "pin" || action === "unpin") onTogglePin(path);
    else if (action === "reveal") void revealPath(path);
    else if (action === "archive") {
      onRemoveProject?.(path, { purgeData: false });
    } else if (action === "delete") {
      setRemoving({
        path,
        name: resolveTabGroupLabel(projectKey, groupLabels, basename(path)),
      });
    }
  };

  // The sidebar's workspace menu opens these through the rail.
  useEffect(
    () =>
      subscribeProjectRailActions((action) => {
        if (action.kind === "menu") {
          openProjectMenu(action.path, action.x, action.y);
        } else {
          const projectKey = labelKey(action.path);
          setRemoving({
            path: action.path,
            name: resolveTabGroupLabel(projectKey, groupLabels, basename(action.path)),
          });
        }
      }),
    [groupLabels, workspaces],
  );

  const onConfirmDelete = () => {
    if (!removing) return;
    onRemoveProject?.(removing.path, { purgeData: true });
    setRemoving(null);
  };

  const pinnedIds = sections.pinned.map((item) => item.path);
  const projectIds = sections.projects.map((item) => item.path);
  const pinnedSortable = useSortable(pinnedIds, onReorderPinned, {
    axis: "y",
    onActivate: onSelectProject,
  });
  const projectSortable = useSortable(projectIds, onReorderProjects, {
    axis: "y",
    onActivate: onSelectProject,
  });
  return (
    <nav
      ref={resize.setPaneRef}
      aria-label="Workspaces"
      className="sidebar-glass relative flex shrink-0 flex-col border-r border-content/10"
    >
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
          onTogglePanel={settingsOpen ? undefined : shell.toggleProjectRail}
          panelActive
          panelLabel="Toggle workspaces"
        />
      </div>

      {settingsOpen ? (
        <SettingsNav
          section={settingsSection}
          onSelect={shell.selectSettingsSection}
          onClose={shell.closeSettings}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-px p-2 pt-0">
            <RailSearch
              label="Search"
              icon={Search}
              onClick={onSearch}
              active={searchActive}
              shortcut={`${MOD}K`}
              ariaLabel={`Search (${MOD}K)`}
            />
            <RailAction
              label="Inbox"
              icon={Inbox}
              onClick={onOpenInbox}
              active={inboxActive}
              dot={inboxUnseen}
              ariaLabel={inboxUnseen ? "Inbox, new items" : "Inbox"}
            />
            {notesEnabled ? (
              <RailAction
                label="Notes"
                icon={File}
                onClick={onOpenNotes}
                active={notesActive}
                ariaLabel="Notes"
              />
            ) : null}
          </div>

          <div
            ref={(el) => {
              lockOverscroll(el);
              scrollRef.current = el;
            }}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pt-2 pb-2"
          >
            {sections.pinned.length > 0 ? (
              <ProjectSection
                label="Pinned"
                items={sections.pinned}
                cwd={cwd}
                busy={busy}
                needsYou={needsYou}
                railStatuses={railStatuses}
                activeSessionId={activeSessionId ?? null}
                onSelectAgent={onSelectAgent}
                sortable={pinnedSortable}
                pinned
                searchActive={searchActive || inboxActive || notesActive}
                onSelect={onSelectProject}
                onTogglePin={onTogglePin}
                onContextMenu={onProjectContextMenu}
                onOpenMenu={openProjectMenu}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupLogos={groupLogos}
                groupMascots={groupMascots}
              />
            ) : null}

            <ProjectSection
              label="Workspaces"
              items={sections.projects}
              emptyLabel="No workspaces yet"
              onAdd={onOpenProject}
              cwd={cwd}
              busy={busy}
              needsYou={needsYou}
              railStatuses={railStatuses}
              activeSessionId={activeSessionId ?? null}
              onSelectAgent={onSelectAgent}
              sortable={projectSortable}
              pinned={false}
              searchActive={searchActive || inboxActive || notesActive}
              onSelect={onSelectProject}
              onTogglePin={onTogglePin}
              onContextMenu={onProjectContextMenu}
              onOpenMenu={openProjectMenu}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupLogos={groupLogos}
              groupMascots={groupMascots}
            />
          </div>
          <LiveAgentsPreview
            agents={liveAgents}
            activeSessionId={activeSessionId}
            onSelect={onSelectAgent}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupMascots={groupMascots}
          />
          <SidebarUpdateFooter
            update={updateNotice}
            onOpenWhatsNew={onOpenWhatsNew}
            onDismissUpdate={shell.dismissUpdate}
          />
          <div className="flex shrink-0 flex-col gap-px p-2 pt-px">
            <RailAction
              label="Settings"
              icon={Settings}
              onClick={() => shell.openSettings()}
              shortcut={`${MOD},`}
              ariaLabel={`Settings (${MOD},)`}
            />
          </div>
        </>
      )}
      {projectMenu ? (
        <TabGroupMenu
          x={projectMenu.x}
          y={projectMenu.y}
          groupId={projectMenu.projectKey}
          label={resolveTabGroupLabel(
            projectMenu.projectKey,
            groupLabels,
            basename(projectMenu.path),
          )}
          colorIndex={resolveTabGroupColorIndex(
            projectMenu.projectKey,
            groupColors,
            groupCustomColors,
          )}
          customColor={resolveTabGroupCustomColor(
            projectMenu.projectKey,
            groupCustomColors,
          )}
          currentColor={resolveTabGroupColor(
            projectMenu.projectKey,
            groupColors,
            groupCustomColors,
            projectMenu.projectKey,
          )}
          logoPath={resolveTabGroupLogo(projectMenu.projectKey, groupLogos)}
          logoProject={projectMenu.projectKey}
          mascotName={resolveTabGroupMascot(
            projectMenu.projectKey,
            groupMascots,
          )}
          mascotProject={projectMenu.projectKey}
          onRename={onProjectRename}
          onColorChange={onProjectColorChange}
          onCustomColorChange={onProjectCustomColorChange}
          onMascotChange={onProjectMascotChange}
          onLogoChange={() => {}}
          onPick={() => {}}
          onClose={() => setProjectMenu(null)}
          showActions={false}
          extraItems={projectMenuExtraItems(
            pinnedPaths.some((pinned) =>
              sameProjectPath(pinned, projectMenu.path),
            ),
            Boolean(onRemoveProject),
          )}
          onExtraPick={onProjectMenuPick}
        />
      ) : null}
      {removing ? (
        <RemoveProjectDialog
          name={removing.name}
          path={removing.path}
          onConfirm={onConfirmDelete}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace rail"
        aria-valuenow={resize.width}
        aria-valuemin={PROJECT_RAIL_WIDTH_MIN}
        aria-valuemax={PROJECT_RAIL_WIDTH_MAX}
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
    </nav>
  );
}

type SortableHandle = ReturnType<typeof useSortable>;

const LIVE_AGENT_MIN = 2;
const LIVE_AGENT_CAP = 4;

function LiveAgentsPreview({
  agents,
  activeSessionId,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  agents: LiveAgent[];
  activeSessionId?: string;
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lockList = useLockOverscroll<HTMLDivElement>();
  const ticking =
    agents.length >= LIVE_AGENT_MIN &&
    agents.some((agent) => !agent.done && agent.startedAt != null);

  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  if (agents.length < LIVE_AGENT_MIN) return null;

  const extra = agents.length - LIVE_AGENT_CAP;
  const visible =
    expanded || extra <= 0 ? agents : agents.slice(0, LIVE_AGENT_CAP);

  return (
    <div
      role="status"
      aria-label="Working agents"
      className="shrink-0 border-t border-content/10"
    >
      <div className="flex h-9 items-center gap-2 px-2 pr-1.5">
        <span aria-hidden className="ml-2 size-1.5 shrink-0 rounded-full bg-accent" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">
          Working
        </span>
        <span className="px-1 text-[11px] tabular-nums text-content/40">{agents.length}</span>
      </div>
      <div
        ref={expanded ? lockList : undefined}
        className={`flex flex-col gap-px p-2 pt-0 ${
          expanded ? "max-h-[45vh] overflow-y-auto overscroll-none" : ""
        }`}
      >
          {visible.map((agent) => (
            <LiveAgentCard
              key={agent.id}
              agent={agent}
              now={now}
              selected={agent.id === activeSessionId}
              onSelect={onSelect}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupMascots={groupMascots}
            />
        ))}
        {extra > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="pressable flex h-7 w-full items-center gap-2 rounded-md px-2 text-[11px] text-content/50 hover:bg-content/5 hover:text-content"
          >
            {expanded ? (
              <ChevronUp className="size-3.5" strokeWidth={1.75} />
            ) : (
              <ChevronDown className="size-3.5" strokeWidth={1.75} />
            )}
            <span className="tabular-nums">{expanded ? "Show less" : `${extra} more`}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LiveAgentCard({
  agent,
  now,
  selected,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  agent: LiveAgent;
  now: number;
  selected: boolean;
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const projectKey = workspaceLabelKey(useWorkspaces(), agent.cwd, projectName(agent.cwd));
  const project = resolveTabGroupLabel(projectKey, groupLabels, projectName(agent.cwd));
  const color = resolveTabGroupColor(
    projectKey,
    groupColors,
    groupCustomColors,
    projectKey,
  );
  const elapsed = agent.done
    ? agent.durationMs != null
      ? formatLiveElapsed(0, agent.durationMs)
      : ""
    : agent.startedAt != null
      ? formatLiveElapsed(agent.startedAt, now)
      : "";
  const activity = agent.needsApproval
    ? "Needs you"
    : agent.done
      ? "Done"
      : agent.activity;
  const live = !agent.needsApproval && !agent.done;
  const title = [agent.title, project, activity, elapsed]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      title={title}
      aria-label={[agent.title, project, activity, elapsed]
        .filter(Boolean)
        .join(", ")}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect?.(agent.id)}
      className={`relative flex w-full flex-col rounded-md px-2 py-1.5 text-left ${
        selected ? "bg-content/10 text-content" : "hover:bg-content/5 active:bg-content/10"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ProjectMascot
          project={projectKey}
          color={color}
          name={resolveTabGroupMascot(projectKey, groupMascots)}
          className="size-2 shrink-0"
          active={live}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
          {agent.title}
        </span>
      </span>
      <span
        className={`mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight ${
          agent.needsApproval
            ? "text-warning"
            : agent.done
              ? "text-success"
              : "text-content/50"
        }`}
      >
        {agent.needsApproval ? (
          <CircleAlert className="size-3.5 shrink-0" strokeWidth={1.75} />
        ) : agent.done ? (
          <Check className="size-3.5 shrink-0" strokeWidth={2.25} />
        ) : (
          <TerminalSpinner />
        )}
        <span className="min-w-0 truncate">{activity}</span>
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight text-content/40">
        <HarnessIcon harness={agent.harness} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{project}</span>
        {elapsed ? (
          <span className="shrink-0 tabular-nums">{elapsed}</span>
        ) : null}
      </span>
    </button>
  );
}

function ProjectSection({
  label,
  items,
  emptyLabel,
  onAdd,
  cwd,
  busy,
  needsYou,
  railStatuses,
  activeSessionId,
  onSelectAgent,
  sortable,
  pinned,
  searchActive,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  label: string;
  items: RecentProject[];
  emptyLabel?: string;
  onAdd?: () => void;
  cwd: string;
  busy: Set<string>;
  needsYou: Set<string>;
  railStatuses: Map<string, WorkspaceRailStatus>;
  activeSessionId: string | null;
  onSelectAgent?: (sessionId: string) => void;
  sortable: SortableHandle;
  pinned: boolean;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  return (
    <div className="shrink-0">
      <div className="flex h-9 items-center gap-1 px-2 pr-1.5">
        <span className="min-w-0 flex-1 truncate px-2 text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">
          {label}
        </span>
        {onAdd ? (
          <button
            type="button"
            title="Add workspace"
            aria-label="Add workspace"
            onClick={onAdd}
            className="pressable grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {items.length === 0 && emptyLabel ? (
        <p className="px-3 py-2 text-[12px] text-content/50">{emptyLabel}</p>
      ) : null}
      <div className="flex flex-col gap-px p-2 pt-0">
        {items.map((item, index) => (
          <ProjectCard
            key={item.path}
            item={item}
            selected={!searchActive && sameProjectPath(item.path, cwd)}
            busy={pathIn(item.path, busy)}
            needsYou={pathIn(item.path, needsYou)}
            railStatus={railStatuses.get(item.path)}
            activeSessionId={activeSessionId}
            onSelectAgent={onSelectAgent}
            pinned={pinned}
            sortable={sortable}
            index={index}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onContextMenu={onContextMenu}
            onOpenMenu={onOpenMenu}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupLogos={groupLogos}
            groupMascots={groupMascots}
          />
        ))}
      </div>
    </div>
  );
}

const nameClassName = "min-w-0 flex-1 truncate text-[12px] leading-none";

/** The chip's word for each dominant workspace state, plural-aware. */
const RAIL_CHIP_LABEL: Record<NonNullable<WorkspaceRailStatus["kind"]>, string> = {
  paused: "Paused",
  needsYou: "Needs you",
  busy: "Working",
  unread: "Done",
};

function railChipTitle(status: WorkspaceRailStatus): string {
  if (!status.kind) return "";
  const word = status.count === 1 ? "thread" : "threads";
  return `${RAIL_CHIP_LABEL[status.kind]} — ${status.count} ${word}`;
}

/** One small always-visible indicator per workspace row, replacing the
 *  plain shimmer/tint as the only signal something is happening: click
 *  opens the compact per-thread breakdown. */
function RailStatusChip({
  status,
  open,
  onToggle,
  chipRef,
}: {
  status: WorkspaceRailStatus;
  open: boolean;
  onToggle: () => void;
  chipRef: RefObject<HTMLButtonElement | null>;
}) {
  if (!status.kind) return null;
  return (
    <button
      ref={chipRef}
      type="button"
      data-no-drag
      title={railChipTitle(status)}
      aria-label={railChipTitle(status)}
      aria-haspopup="menu"
      aria-expanded={open}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={`pressable grid size-4 shrink-0 place-items-center rounded ${
        open ? "bg-content/10" : "hover:bg-content/10"
      }`}
    >
      {status.kind === "paused" ? (
        <Pause className="size-2.5 fill-current text-warning" strokeWidth={1.75} />
      ) : status.kind === "needsYou" ? (
        <span className="size-1.5 rounded-full bg-warning" />
      ) : status.kind === "busy" ? (
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
      ) : (
        <span className="size-1.5 rounded-full bg-info" />
      )}
    </button>
  );
}

/** What a busy workspace is doing, indented under its row: no chip, no
 *  popover to open — the running thread's own name says it. Several
 *  threads working name the loudest one and count the rest. */
function WorkspaceWorkingLine({
  running,
  onSelect,
}: {
  running: CardThread[];
  onSelect?: (sessionId: string) => void;
}) {
  const [first, ...rest] = running;
  if (!first) return null;
  return (
    <button
      type="button"
      data-no-drag
      title={running.map((t) => t.title || "Untitled").join("\n")}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(first.id);
      }}
      className="pressable flex h-6 w-full items-center gap-1.5 rounded-md py-0.5 pr-2 pl-8 text-left text-[11px] leading-tight text-content/50 hover:bg-content/5 hover:text-content"
    >
      <TerminalSpinner />
      <span className="min-w-0 flex-1 truncate">{first.title || "Untitled"}</span>
      {rest.length > 0 ? (
        <span className="shrink-0 tabular-nums text-content/40">+{rest.length}</span>
      ) : null}
    </button>
  );
}

function ProjectCard({
  item,
  selected,
  busy,
  needsYou,
  railStatus,
  activeSessionId,
  onSelectAgent,
  pinned,
  sortable,
  index,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  item: RecentProject;
  selected: boolean;
  busy: boolean;
  needsYou: boolean;
  railStatus: WorkspaceRailStatus | undefined;
  activeSessionId: string | null;
  onSelectAgent?: (sessionId: string) => void;
  pinned: boolean;
  sortable: SortableHandle;
  index: number;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  const fallbackName = basename(item.path);
  const workspaceId = workspaceByPath(useWorkspaces(), item.path)?.id ?? null;
  const projectKey = workspaceId ?? projectName(item.path);
  const name = resolveTabGroupLabel(projectKey, groupLabels, fallbackName);
  const logoPath = resolveTabGroupLogo(projectKey, groupLogos);
  // No logo set: the server's repo icon or host mark stands in, unless the
  // user picked a mascot on purpose.
  const serverIcon = useWorkspaceIcon(workspaceId);
  const showLogo =
    !!logoPath ||
    (!groupMascots[projectKey] && !!(serverIcon?.dataUrl || serverIcon?.host));
  const color = resolveTabGroupColor(
    projectKey,
    groupColors,
    groupCustomColors,
    projectKey,
  );
  const dragging = sortable.draggingId === item.path;
  const showStart =
    sortable.draggingId &&
    sortable.toIndex === index &&
    sortable.fromIndex !== null &&
    sortable.toIndex < sortable.fromIndex;
  const showEnd =
    sortable.draggingId &&
    sortable.toIndex === index &&
    sortable.fromIndex !== null &&
    sortable.toIndex > sortable.fromIndex;
  // Only the active card asks git; the rest show nothing rather than fan out.
  const diffEnabled = selected && Boolean(item.path) && item.path !== "~";
  const stats = useProjectDiffStats(item.path, diffEnabled);
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const hasChanges = files > 0 || additions > 0 || deletions > 0;
  const cardTitle = projectCardTitle(item.path, name, stats, busy, needsYou);
  const cardAriaLabel = projectCardAriaLabel(name, stats, busy, needsYou);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  return (
    <>
    <div
      ref={(el) => sortable.setItemRef(item.path, el)}
      className={`group relative flex h-7 touch-none items-stretch rounded-md px-2 ${
        selected
          ? "bg-content/10 text-content"
          : "text-content/50 hover:bg-content/5 hover:text-content"
      } ${dragging ? "opacity-40" : ""} cursor-default`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        sortable.onItemPointerDown(item.path, event);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        if (sortable.consumeClick()) return;
        onSelect(item.path);
      }}
      onContextMenu={(event) => onContextMenu(item.path, event)}
    >
      {showStart ? (
        <div className="pointer-events-none absolute inset-x-2 top-0 z-20 h-0.5 rounded-full bg-accent" />
      ) : null}
      {showEnd ? (
        <div className="pointer-events-none absolute inset-x-2 bottom-0 z-20 h-0.5 rounded-full bg-accent" />
      ) : null}
      <button
        type="button"
        title={cardTitle}
        aria-label={cardAriaLabel}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 pr-1 text-left"
      >
        <div className="grid size-4 shrink-0 place-items-center transition-opacity group-hover:opacity-0">
          {showLogo && !busy && !needsYou ? (
            <ProjectLogoIcon
              path={logoPath}
              workspaceId={workspaceId}
              className="size-4 rounded-md"
              imageClassName="size-4"
            />
          ) : (
            <ProjectMascot
              project={projectKey}
              color={needsYou ? "var(--color-warning)" : color}
              name={resolveTabGroupMascot(projectKey, groupMascots)}
              className="size-3"
              active={busy}
            />
          )}
        </div>
        {busy ? (
          <Shimmer as="span" duration={1.4} className={nameClassName}>
            {name}
          </Shimmer>
        ) : (
          <span className={nameClassName}>{name}</span>
        )}
        {hasChanges ? (
          <span className="shrink-0">
            <ProjectDiffStat additions={additions} deletions={deletions} />
          </span>
        ) : null}
      </button>
      {railStatus?.kind && railStatus.kind !== "busy" ? (
        <RailStatusChip
          status={railStatus}
          open={threadsOpen}
          onToggle={() => setThreadsOpen((v) => !v)}
          chipRef={chipRef}
        />
      ) : null}
      <button
        type="button"
        data-no-drag
        title="Workspace options"
        aria-label="Workspace options"
        aria-haspopup="menu"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(item.path, event.clientX, event.clientY);
        }}
        className="pressable pointer-events-none absolute right-0.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-content/50 opacity-0 transition-opacity hover:bg-content/10 hover:text-content group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        data-no-drag
        title={pinned ? "Unpin workspace" : "Pin workspace"}
        aria-label={pinned ? "Unpin workspace" : "Pin workspace"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(item.path);
        }}
        className="absolute left-2 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-md text-content/50 opacity-0 pointer-events-none transition-opacity hover:text-content group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
      >
        {pinned ? (
          <PinOff className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Pin className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
    </div>
    {railStatus?.kind === "busy" && railStatus.running?.length ? (
      <WorkspaceWorkingLine running={railStatus.running} onSelect={onSelectAgent} />
    ) : null}
    {threadsOpen && workspaceId ? (
      <WorkspaceThreadsPopover
        anchor={chipRef}
        workspaceId={workspaceId}
        activeSessionId={activeSessionId}
        onDismiss={() => setThreadsOpen(false)}
        onSelectThread={(sessionId) => {
          setThreadsOpen(false);
          onSelectAgent?.(sessionId);
        }}
      />
    ) : null}
    </>
  );
}

function pathIn(path: string, paths: Set<string>): boolean {
  for (const other of paths) {
    if (sameProjectPath(path, other)) return true;
  }
  return false;
}

function ProjectDiffStat({
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
      className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums"
    >
      {additions > 0 ? (
        <span className="text-success">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-danger">-{deletions}</span>
      ) : null}
    </span>
  );
}

export function projectCardTitle(
  path: string,
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
  needsYou = false,
): string {
  const parts = [name, path];
  // A blocked thread outranks a working one, and only one of the two is said.
  if (needsYou) parts.push("Needs you");
  else if (busy) parts.push("Working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0 || additions > 0 || deletions > 0) {
    parts.push(
      [
        files > 0 ? `${files} ${files === 1 ? "file" : "files"} changed` : "",
        additions > 0 ? `+${additions}` : "",
        deletions > 0 ? `-${deletions}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return parts.join("\n");
}

export function projectCardAriaLabel(
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
  needsYou = false,
): string {
  const parts = [name];
  if (needsYou) parts.push("needs you");
  else if (busy) parts.push("working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0) {
    parts.push(`${files} ${files === 1 ? "file" : "files"} changed`);
  }
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.join(", ");
}
