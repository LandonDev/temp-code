import { registry, useEnvironments } from "../lib/connection";
import { environmentOfCwd } from "../lib/tcserver/projects";
import { aliasKeys, mergeRailSections, type RailItem } from "../lib/linkedRail";
import { HostsRow } from "./HostRows";
import { useHostsOffline } from "./hostOffline";
import {
  Archive,
  FolderOpen,
  FolderPlus,
  ChartBar,
  Inbox,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Users,
  Settings,
  Trash2,
} from "./icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDragResize } from "../hooks/useDragResize";
import { useSashKeys } from "../hooks/useSashKeys";
import { useInboxUnseen } from "../hooks/useInboxUnseen";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useSortable } from "../hooks/useSortable";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  loadProjectRailWidth,
  PROJECT_RAIL_WIDTH_DEFAULT,
  PROJECT_RAIL_WIDTH_MAX,
  PROJECT_RAIL_WIDTH_MIN,
  saveProjectRailWidth,
} from "../lib/appearance";
import { basename, revealPath } from "../lib/fs";
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
import { threadsToMarkRead } from "../lib/markRead";
import { batchActionOfMenuId, batchCounts, batchMenuRows, type BatchCounts } from "../lib/threadBatchMenu";
import { requestThreadBatch, type BatchScope } from "../lib/threadBatch";
import { selectionFor } from "../lib/threadBatchSelection";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { markAllSeen, markSessionsSeen } from "../lib/sessionSeen";
import { useSessionMetas } from "../lib/tcserver/store";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import { subscribeProjectRailActions } from "../lib/projectRailActions";
import {
  useWorkspaceIcon,
  useWorkspaces,
  workspaceByPath,
  workspaceLabelKey,
} from "../lib/tcserver/workspaces";
import { RailHeading, RailRow } from "./RailRow";
import { useWorkspaceMarks, WorkspaceGlyph, WorkspaceLineView, WorkspaceMarkTrigger } from "./WorkspaceRowMarks";
import type { WorkspaceMark } from "../lib/sidebarRows";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DevModeSlot, TabVisitNav } from "./TitleBar";
import { UpdateRow, useUpdateRowState } from "./UpdateRow";
import { SignInRow, useSignInTarget } from "./SignInRow";
import { UsageMeter } from "./UsageMeter";
import { shell, useShell, type AliaxPageId } from "../stores/shell";
import { SettingsNav } from "./SettingsRail";
import { CUSTOMIZE, groupMenuRows } from "./TabGroupMenu";
import { RowsContextMenu, type MenuRow } from "./menuRows";
import { aliaxChunk, inboxChunk, searchChunk, settingsChunk, customizeChunk } from "../surfaces/chunks";

/** The Customize dialog loads with the click (its menu warms it). */
const CustomizeGroupDialog = customizeChunk.surface("CustomizeGroupDialog");
import { Kbd } from "../components/ui/kbd";
import { StatusMark } from "../components/ui/status";

const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : typeof navigator !== "undefined" && /Win/.test(navigator.platform)
    ? "Reveal in File Explorer"
    : "Open Containing Folder";

/** The project menu's rows after the label, colour and mascot: pin, reveal,
 *  Mark all read, the fleet switches, then archive and remove (the folder
 *  stays; its threads go). */
export function projectMenuExtraItems(
  pinned: boolean,
  canRemove: boolean,
  counts: BatchCounts | null,
): MenuRow[] {
  const items: MenuRow[] = [
    pinned
      ? { kind: "item", id: "unpin", label: "Unpin workspace", icon: PinOff }
      : { kind: "item", id: "pin", label: "Pin workspace", icon: Pin },
    { kind: "item", id: "reveal", label: REVEAL_LABEL, icon: FolderOpen },
    { kind: "sep" },
    { kind: "item", id: "read", label: "Mark all read", icon: ListChecks },
    ...batchMenuRows(counts),
  ];
  if (canRemove) {
    items.push(
      { kind: "sep" },
      { kind: "item", id: "archive", label: "Archive", icon: Archive },
      { kind: "item", id: "delete", label: "Remove…", icon: Trash2, danger: true },
    );
  }
  return items;
}

type Props = {
  cwd: string;
  recents: RecentProject[];
  busyPaths?: Iterable<string>;
  /** Folders holding a thread blocked on the user. Outranks `busyPaths`. */
  needsYouPaths?: Iterable<string>;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onSearch?: () => void;
  onOpenInbox?: () => void;
  /** The foot's Accounts and Stats rows: the embedded Aliax pages. */
  onOpenAccountsPage?: (page: AliaxPageId) => void;
  /** The home: the chats outside every workspace. */
  onOpenChats?: () => void;
  onSelectProject: (path: string) => void;
  /** Add a workspace: this machine's folder dialog, or a host's folders when `environmentId` is another machine. */
  onOpenProject: (environmentId?: string) => void;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  activeSessionId?: string;
  onSelectAgent?: (sessionId: string) => void;
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
};

export function ProjectRail({
  cwd,
  recents,
  busyPaths,
  needsYouPaths,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onSearch,
  onOpenInbox,
  onOpenAccountsPage,
  onOpenChats,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  activeSessionId,
  onSelectAgent,
  onOpenWhatsNew,
}: Props) {
  const searchActive = useShell((s) => s.searchViewOpen);
  const inboxActive = useShell((s) => s.inboxViewOpen);
  const notesActive = useShell((s) => s.notesViewOpen);
  const accountsPage = useShell((s) => s.accountsPage);
  const settingsOpen = useShell((s) => s.settingsOpen);
  const settingsSection = useShell((s) => s.settingsSection);
  /** A full-window view covers the list: no workspace row is selected. */
  const overlayOpen = searchActive || inboxActive || notesActive || !!accountsPage;
  const resize = useDragResize({
    min: PROJECT_RAIL_WIDTH_MIN,
    max: () =>
      Math.min(PROJECT_RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.35)),
    defaultWidth: PROJECT_RAIL_WIDTH_DEFAULT,
    initial: loadProjectRailWidth(),
    onCommit: saveProjectRailWidth,
  });
  const sashKeys = useSashKeys({
    label: "Resize workspace rail",
    orientation: "vertical",
    value: resize.width,
    min: PROJECT_RAIL_WIDTH_MIN,
    max: Math.min(PROJECT_RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.35)),
    getSpan: (handle) => handle.closest(".app-shell")?.getBoundingClientRect().width || window.innerWidth,
    direction: 1,
    onChange: resize.resizeTo,
    onReset: resize.reset,
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
  // The project whose menu is open (its ⋯ reads expanded) and whose Customize dialog is.
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState<{ path: string; projectKey: string } | null>(null);
  const projectMenu = useRef<((at: { x: number; y: number; id: string | null }) => void) | null>(null);
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
  // One list for every host: a workspace linked across hosts is one row
  // with every copy's threads (lib/linkedRail.ts); each host's status sits
  // in its own row at the foot (HostRows).
  const rows = useMemo(() => mergeRailSections(sections, workspaces), [sections, workspaces]);
  /** The rail row a workspace folder sits in (its own, or its link's). */
  const rowOf = (path: string): RailItem | undefined =>
    [...rows.pinned, ...rows.projects].find((row) => row.paths.some((p) => sameProjectPath(p, path)));
  /** The status map's key for a row: its link's leader path. */
  const statusKey = useMemo(() => aliasKeys(workspaces).path, [workspaces]);
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
  const railStatuses = useWorkspaceMarks();
  const metas = useSessionMetas();
  const catalog = useWorkspaceCatalog();
  const lastSeen = useLastSeen();
  const seenFloor = useSeenFloor();
  // "Mark all read": every thread on one workspace and its copies, or on
  // every host (the latter raises the seen floor too, as the View menu's
  // item does).
  const markRead = (path: string | null): void => {
    const { ids, at } = threadsToMarkRead(metas, catalog, path === null ? null : (rowOf(path)?.paths ?? path));
    if (path === null) markAllSeen(ids, at);
    else markSessionsSeen(ids, at);
  };
  /** The fleet switches' scope for a row: every copy's folder. */
  const projectScope = (path: string, projectKey: string): BatchScope => ({
    kind: "project",
    path,
    paths: rowOf(path)?.paths ?? [path],
    name: resolveTabGroupLabel(projectKey, groupLabels, basename(path)),
  });

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


  const openProjectMenu = (path: string, x: number, y: number) => projectMenu.current?.({ x, y, id: path });

  /** A project's menu: Customize… (the look), then pin, reveal, the fleet switches, archive and delete. */
  const projectMenuRows = (path: string | null): MenuRow[] | null => {
    if (!path) return null;
    const projectKey = labelKey(path);
    return groupMenuRows({
      actions: false,
      extra: projectMenuExtraItems(
        pinnedPaths.some((pinned) => (rowOf(path)?.paths ?? [path]).some((p) => sameProjectPath(pinned, p))),
        Boolean(onRemoveProject),
        batchCounts(metas, { catalog, lastSeen, floor: seenFloor, scope: projectScope(path, projectKey) }),
      ),
    });
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
    const subset = new Set(pinnedIds);
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onReorderProjects = (ids: string[]) => {
    const subset = new Set(projectIds);
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onTogglePin = (path: string) => {
    // A linked row pins and unpins as one: every copy's folder.
    const paths = rowOf(path)?.paths ?? [path];
    const isPinned = pinnedPaths.some((pinned) => paths.some((p) => sameProjectPath(pinned, p)));
    const next = isPinned
      ? pinnedPaths.filter((pinned) => !paths.some((p) => sameProjectPath(pinned, p)))
      : [...pinnedPaths, path];
    setPinnedPaths(next);
    savePinnedProjects(next);
  };

  const onProjectMenuPick = (action: string, path: string | null) => {
    if (!path) return;
    const projectKey = labelKey(path);
    if (action === CUSTOMIZE) setCustomizing({ path, projectKey });
    else if (action === "pin" || action === "unpin") onTogglePin(path);
    else if (action === "reveal") void revealPath(path);
    else if (action === "read") markRead(path);
    else if (batchActionOfMenuId(action)) {
      const scope = projectScope(path, projectKey);
      void requestThreadBatch(batchActionOfMenuId(action)!, scope, () => selectionFor(scope));
    } else if (action === "archive") {
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

  // The draggable rows: a linked row moves as one, by its lead folder.
  const pinnedIds = rows.pinned.map((item) => item.path);
  // With nothing in the list, its own row adds the first workspace and the
  // heading drops its +, so the action is on screen once.
  const noWorkspaces = rows.pinned.length === 0 && rows.projects.length === 0;
  const projectIds = rows.projects.map((item) => item.path);
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
      className="sidebar-glass relative flex shrink-0 flex-col border-r border-border"
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
          <div
            ref={(el) => {
              lockOverscroll(el);
              scrollRef.current = el;
            }}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2"
          >
            <RowsContextMenu
              label="Workspace actions"
              rowsFor={projectMenuRows}
              onPick={onProjectMenuPick}
              onOpenChange={(open, path) => {
                setMenuPath(open ? path : null);
                if (open) customizeChunk.preload();
              }}
              openRef={projectMenu}
            >
            <div className="contents">
            {onOpenChats ? (
              <div className="shrink-0 px-2">
                <RailRow
                  icon={MessageSquare}
                  label="Chats"
                  ariaLabel={chatsAriaLabel(busy.has("~"), needsYou.has("~"))}
                  onClick={onOpenChats}
                  selected={!overlayOpen && cwd === "~"}
                  trailing={
                    needsYou.has("~") ? (
                      <StatusMark state="waiting" word={false} />
                    ) : busy.has("~") ? (
                      <StatusMark state="working" word={false} />
                    ) : null
                  }
                />
              </div>
            ) : null}
            {rows.pinned.length > 0 ? (
              <ProjectSection
                label="Pinned"
                items={rows.pinned}
                statusKey={statusKey}
                cwd={cwd}
                busy={busy}
                needsYou={needsYou}
                railStatuses={railStatuses}
                activeSessionId={activeSessionId ?? null}
                onSelectAgent={onSelectAgent}
                sortable={pinnedSortable}
                searchActive={overlayOpen}
                onSelect={onSelectProject}
                onOpenMenu={openProjectMenu}
                menuPath={menuPath}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupLogos={groupLogos}
                groupMascots={groupMascots}
              />
            ) : null}

            <ProjectSection
              label="Workspaces"
              items={rows.projects}
              statusKey={statusKey}
              onAdd={noWorkspaces ? undefined : () => onOpenProject()}
              emptyRow={
                noWorkspaces ? <RailRow icon={FolderPlus} label="Add workspace…" onClick={() => onOpenProject()} /> : null
              }
              cwd={cwd}
              busy={busy}
              needsYou={needsYou}
              railStatuses={railStatuses}
              activeSessionId={activeSessionId ?? null}
              onSelectAgent={onSelectAgent}
              sortable={projectSortable}
              searchActive={overlayOpen}
              onSelect={onSelectProject}
              onOpenMenu={openProjectMenu}
              menuPath={menuPath}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupLogos={groupLogos}
              groupMascots={groupMascots}
            />
            </div>
            </RowsContextMenu>
          </div>
          <RailFoot
            activeSessionId={activeSessionId}
            onSearch={onSearch}
            onOpenInbox={onOpenInbox}
            onOpenAccountsPage={onOpenAccountsPage}
            onOpenWhatsNew={onOpenWhatsNew}
            onAddWorkspace={(environmentId) => onOpenProject(environmentId)}
          />
        </>
      )}
      {customizing ? (
        <CustomizeGroupDialog
          environmentId={environmentOfCwd(customizing.path) ?? registry.primary().environmentId}
          groupId={customizing.projectKey}
          label={resolveTabGroupLabel(customizing.projectKey, groupLabels, basename(customizing.path))}
          colorIndex={resolveTabGroupColorIndex(customizing.projectKey, groupColors, groupCustomColors)}
          customColor={resolveTabGroupCustomColor(customizing.projectKey, groupCustomColors)}
          currentColor={resolveTabGroupColor(customizing.projectKey, groupColors, groupCustomColors, customizing.projectKey)}
          logoPath={resolveTabGroupLogo(customizing.projectKey, groupLogos)}
          logoProject={customizing.projectKey}
          mascotName={resolveTabGroupMascot(customizing.projectKey, groupMascots)}
          mascotProject={customizing.projectKey}
          onSave={(look) => {
            onProjectRename(customizing.projectKey, look.name);
            if (look.customColor) onProjectCustomColorChange(customizing.projectKey, look.customColor);
            else onProjectColorChange(customizing.projectKey, look.colorIndex);
            onProjectMascotChange(customizing.projectKey, look.mascot);
          }}
          onClose={() => setCustomizing(null)}
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
        {...sashKeys}
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none outline-none focus-visible:bg-accent ${
          resize.dragging ? "bg-foreground/15" : "hover:bg-foreground/10"
        }`}
        onPointerDown={resize.onPointerDown}
      />
    </nav>
  );
}

type SortableHandle = ReturnType<typeof useSortable>;

function ProjectSection({
  label,
  items,
  statusKey,
  indexOf,
  emptyRow,
  onAdd,
  cwd,
  busy,
  needsYou,
  railStatuses,
  activeSessionId,
  onSelectAgent,
  sortable,
  searchActive,
  onSelect,
  onOpenMenu,
  menuPath,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  label: string;
  items: RailItem[];
  /** The status map's key for a row's folder (its link's leader path). */
  statusKey: (path: string) => string;
  /** The row's place in the sortable's whole list; defaults to its place in `items`. */
  indexOf?: (item: RailItem) => number;
  /** The row that stands in for an empty list (Add workspace…). */
  emptyRow?: ReactNode;
  onAdd?: () => void;
  cwd: string;
  busy: Set<string>;
  needsYou: Set<string>;
  railStatuses: Map<string, WorkspaceMark>;
  activeSessionId: string | null;
  onSelectAgent?: (sessionId: string) => void;
  sortable: SortableHandle;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  /** The folder whose menu is open: its ⋯ stays shown. */
  menuPath: string | null;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  return (
    <div className="shrink-0 px-2 pt-4">
      <RailHeading action={onAdd ? { label: "Add workspace", icon: Plus, onClick: onAdd } : undefined}>
        {label}
      </RailHeading>
      <div className="flex flex-col">
        {emptyRow}
        {items.map((item, index) => (
          <WorkspaceRow
            key={item.path}
            item={item}
            selected={!searchActive && item.paths.some((p) => sameProjectPath(p, cwd))}
            busy={item.paths.some((p) => pathIn(p, busy))}
            needsYou={item.paths.some((p) => pathIn(p, needsYou))}
            railStatus={railStatuses.get(statusKey(item.path))}
            activeSessionId={activeSessionId}
            onSelectAgent={onSelectAgent}
            sortable={sortable}
            index={indexOf ? indexOf(item) : index}
            onSelect={onSelect}
            onOpenMenu={onOpenMenu}
            menuOpen={menuPath !== null && item.paths.some((p) => sameProjectPath(p, menuPath))}
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

/**
 * One workspace: its glyph, its alias-resolved name, the status chip as
 * its trailing mark and ⋯ (the same menu as a right-click) as its hover
 * action; drag reorders it. A busy one has its working line under it.
 */
function WorkspaceRow({
  item,
  selected,
  busy,
  needsYou,
  railStatus,
  activeSessionId,
  onSelectAgent,
  sortable,
  index,
  onSelect,
  onOpenMenu,
  menuOpen,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  item: RailItem;
  selected: boolean;
  busy: boolean;
  needsYou: boolean;
  railStatus: WorkspaceMark | undefined;
  activeSessionId: string | null;
  onSelectAgent?: (sessionId: string) => void;
  sortable: SortableHandle;
  index: number;
  onSelect: (path: string) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  menuOpen: boolean;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  const workspaces = useWorkspaces();
  const workspaceId = workspaceByPath(workspaces, item.path)?.id ?? null;
  const offline = useHostsOffline(item.hosts);
  // Labels, colours and mascots key by the link's leader (lib/linkedRail.ts).
  const projectKey = workspaceLabelKey(workspaces, item.path, projectName(item.path));
  const name = resolveTabGroupLabel(projectKey, groupLabels, basename(item.path));
  const logoPath = resolveTabGroupLogo(projectKey, groupLogos);
  // No logo set: the server's repo icon or host mark stands in, unless the
  // user picked a mascot on purpose.
  const serverIcon = useWorkspaceIcon(workspaceId);
  const showLogo = !!logoPath || (!groupMascots[projectKey] && !!(serverIcon?.dataUrl || serverIcon?.host));
  const color = resolveTabGroupColor(projectKey, groupColors, groupCustomColors, projectKey);
  const dragging = sortable.draggingId === item.path;
  const dropping = sortable.draggingId && sortable.toIndex === index && sortable.fromIndex !== null;
  const showStart = dropping && sortable.toIndex! < sortable.fromIndex!;
  const showEnd = dropping && sortable.toIndex! > sortable.fromIndex!;

  return (
    <>
      <RailRow
        rowRef={(el) => sortable.setItemRef(item.path, el)}
        data-host-offline={offline || undefined}
        data-rail-path={item.path}
        className={`touch-none ${dragging ? "opacity-40" : offline ? "opacity-50" : ""}`}
        glyph={
          <WorkspaceGlyph
            showLogo={showLogo}
            logoPath={logoPath}
            workspaceId={workspaceId}
            projectKey={projectKey}
            color={color}
            mascotName={resolveTabGroupMascot(projectKey, groupMascots)}
          />
        }
        label={name}
        ariaLabel={workspaceRowAriaLabel(name, busy, needsYou)}
        selected={selected}
        emphasis={!!railStatus?.unread}
        trailingInteractive
        trailing={
          railStatus?.mark && workspaceId ? (
            <WorkspaceMarkTrigger
              mark={railStatus.mark}
              workspaceIds={item.workspaceIds.length > 0 ? item.workspaceIds : [workspaceId]}
              activeSessionId={activeSessionId}
              onSelectThread={onSelectAgent}
            />
          ) : null
        }
        hoverAction={{
          label: "Workspace options",
          icon: MoreHorizontal,
          menu: true,
          expanded: menuOpen,
          onClick: (event) => onOpenMenu(item.path, event.clientX, event.clientY),
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
          sortable.onItemPointerDown(item.path, event);
        }}
        // The sortable captures the pointer on this wrapper, so a mouse click
        // lands here, not on the row's button; a keyboard click bubbles here.
        onClickCapture={(event) => {
          if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
          if (sortable.consumeClick()) return;
          onSelect(item.path);
        }}
        data-menu-id={item.path}
      >
        {showStart ? (
          <div className="pointer-events-none absolute inset-x-2 top-0 z-20 h-0.5 rounded-full bg-accent" />
        ) : null}
        {showEnd ? (
          <div className="pointer-events-none absolute inset-x-2 bottom-0 z-20 h-0.5 rounded-full bg-accent" />
        ) : null}
      </RailRow>
      {railStatus?.mark ? <WorkspaceLineView mark={railStatus.mark} onSelect={onSelectAgent} /> : null}
    </>
  );
}

function pathIn(path: string, paths: Set<string>): boolean {
  for (const other of paths) {
    if (sameProjectPath(path, other)) return true;
  }
  return false;
}

/** The rail's Chats entry: loose chats signal like a workspace card does. */
export function chatsAriaLabel(busy: boolean, needsYou: boolean): string {
  if (needsYou) return "Chats, needs you";
  if (busy) return "Chats, working";
  return "Chats";
}

/** A workspace row's name for assistive tech: the name, then the one
 *  state that matters (needs you outranks working). */
export function workspaceRowAriaLabel(name: string, busy: boolean, needsYou = false): string {
  if (needsYou) return `${name}, needs you`;
  if (busy) return `${name}, working`;
  return name;
}

export type RailFootRowId = "signIn" | "update" | "hosts" | "inbox" | "search" | "accounts" | "stats" | "settings";

/** The foot's rows, in order: the sign-in while this machine has no account,
 *  the update when there is one to act on, the hosts with two or more, then
 *  Inbox, Search, Accounts, Stats, Settings. */
export function railFootRows(facts: { signIn: boolean; update: boolean; hosts: number }): RailFootRowId[] {
  const rows: RailFootRowId[] = [];
  if (facts.signIn) rows.push("signIn");
  if (facts.update) rows.push("update");
  if (facts.hosts >= 2) rows.push("hosts");
  rows.push("inbox", "search", "accounts", "stats", "settings");
  return rows;
}

/**
 * The rail's foot under a hairline: its rows, then the usage meter. The
 * same foot sits under the workspace column while the rail is collapsed.
 */
export function RailFoot({
  activeSessionId,
  onSearch,
  onOpenInbox,
  onOpenAccountsPage,
  onOpenWhatsNew,
  onAddWorkspace,
}: {
  activeSessionId?: string;
  onSearch?: () => void;
  onOpenInbox?: () => void;
  onOpenAccountsPage?: (page: AliaxPageId) => void;
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
  onAddWorkspace: (environmentId: string) => void;
}) {
  const searchActive = useShell((s) => s.searchViewOpen);
  const inboxActive = useShell((s) => s.inboxViewOpen);
  const accountsPage = useShell((s) => s.accountsPage);
  const inboxUnseen = useInboxUnseen();
  const environments = useEnvironments();
  const update = useUpdateRowState();
  const signIn = useSignInTarget();
  const ids = railFootRows({ signIn: signIn !== null, update: update !== null, hosts: environments.length });
  const row = (id: RailFootRowId) => {
    switch (id) {
      case "signIn":
        return signIn ? <SignInRow key={id} provider={signIn} /> : null;
      case "update":
        return <UpdateRow key={id} state={update} onOpenWhatsNew={onOpenWhatsNew} />;
      case "hosts":
        return <HostsRow key={id} onAddWorkspace={onAddWorkspace} />;
      case "inbox":
        return (
          <RailRow
            key={id}
            icon={Inbox}
            label="Inbox"
            ariaLabel={inboxUnseen ? "Inbox, new items" : "Inbox"}
            emphasis={inboxUnseen}
            selected={inboxActive}
            onClick={onOpenInbox}
            intent={inboxChunk.intent}
          />
        );
      case "search":
        return (
          <RailRow
            key={id}
            icon={Search}
            label="Search"
            selected={searchActive}
            onClick={onSearch}
            intent={searchChunk.intent}
            tooltip={<Kbd>{`${MOD}K`}</Kbd>}
          />
        );
      case "accounts":
        return (
          <RailRow
            key={id}
            icon={Users}
            label="Accounts"
            selected={accountsPage === "accounts"}
            onClick={() => onOpenAccountsPage?.("accounts")}
            intent={aliaxChunk.intent}
          />
        );
      case "stats":
        return (
          <RailRow
            key={id}
            icon={ChartBar}
            label="Stats"
            selected={accountsPage === "stats"}
            onClick={() => onOpenAccountsPage?.("stats")}
            intent={aliaxChunk.intent}
          />
        );
      case "settings":
        return (
          <RailRow
            key={id}
            icon={Settings}
            label="Settings"
            onClick={() => shell.openSettings()}
            intent={settingsChunk.intent}
            tooltip={<Kbd>{`${MOD},`}</Kbd>}
          />
        );
    }
  };
  return (
    <div className="flex shrink-0 flex-col border-t border-border">
      <div className="flex flex-col p-2">{ids.map(row)}</div>
      <UsageMeter sessionId={activeSessionId} />
    </div>
  );
}
