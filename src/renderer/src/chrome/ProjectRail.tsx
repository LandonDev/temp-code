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
  StickyNote,
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
import { isWebMode } from "../lib/nativeWeb";
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
import { loadLastSeen, seenFloor } from "../lib/sessionSeen";
import { markAllSeen, markSessionsSeen } from "../lib/sessionSeen";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { subscribeProjectRailActions } from "../lib/projectRailActions";
import {
  useWorkspaces,
  workspaceByPath,
  workspaceLabelKey,
} from "../lib/tcserver/workspaces";
import { RAIL_YIELD, RailHeading, RailRow } from "./RailRow";
import { diffWords, useWorkspaceMarks, WorkspaceMarkTrigger } from "./WorkspaceRowMarks";
import type { WorkspaceMark } from "../lib/sidebarRows";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DevModeSlot, TabVisitNav } from "./TitleBar";
import { UpdateRow, useUpdateRowState } from "./UpdateRow";
import { SignInRow, useSignInTarget } from "./SignInRow";
import { UsageMeter } from "./UsageMeter";
import { RailWorking } from "./RailWorking";
import { cn } from "../lib/cn";
import { useGitDiffStats } from "../lib/gitIndexStore";
import type { GitDiffStats } from "../lib/fs";
import { shell, useShell, type AliaxPageId } from "../stores/shell";
import { SettingsNav } from "./SettingsRail";
import { CUSTOMIZE, groupMenuRows } from "./TabGroupMenu";
import { RowsContextMenu, type MenuRow } from "./menuRows";
import { aliaxChunk, inboxChunk, notesChunk, searchChunk, settingsChunk, customizeChunk } from "../surfaces/chunks";

/** The Customize dialog loads with the click (its menu warms it). */
const CustomizeGroupDialog = customizeChunk.surface("CustomizeGroupDialog");
import { Kbd } from "../components/ui/kbd";
import { StatusMark } from "../components/ui/status";

/** The folder picker's title when it adds a workspace (⌘O's says "Open project"). */
export const ADD_WORKSPACE = "Add workspace";

const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : typeof navigator !== "undefined" && /Win/.test(navigator.platform)
    ? "Reveal in File Explorer"
    : "Open containing folder";

/** The project menu's rows after the label, colour and mascot: pin, reveal
 *  (in the desktop app only: a browser has no file manager), Mark all read,
 *  the fleet switches, then archive and remove (the folder stays; its
 *  threads go). */
export function projectMenuExtraItems(
  pinned: boolean,
  canRemove: boolean,
  counts: BatchCounts | null,
  desktop = !isWebMode(),
): MenuRow[] {
  const items: MenuRow[] = [
    pinned
      ? { kind: "item", id: "unpin", label: "Unpin workspace", icon: PinOff }
      : { kind: "item", id: "pin", label: "Pin workspace", icon: Pin },
    ...(desktop ? [{ kind: "item", id: "reveal", label: REVEAL_LABEL, icon: FolderOpen } as const] : []),
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
  onOpenNotes?: () => void;
  /** The Accounts and Stats rows: the embedded Aliax pages. */
  onOpenAccountsPage?: (page: AliaxPageId) => void;
  /** The home: the chats outside every workspace. */
  onOpenChats?: () => void;
  onSelectProject: (path: string) => void;
  /** Add a workspace: this machine's folder dialog, or a host's folders when `environmentId` is another machine. */
  /** The folder picker; Add workspace passes its own title. */
  onOpenProject: (environmentId?: string, title?: string) => void;
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
  onOpenNotes,
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
  // Taken apart at once: the pane's ref callback goes to a `ref` prop, which
  // would make the React Compiler read the whole object as a ref.
  const { attachPane, dragging, onPointerDown, reset, resizeTo, width } = resize;
  const sashKeys = useSashKeys({
    label: "Resize workspace rail",
    orientation: "vertical",
    value: width,
    min: PROJECT_RAIL_WIDTH_MIN,
    max: Math.min(PROJECT_RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.35)),
    getSpan: (handle) => handle.closest(".app-shell")?.getBoundingClientRect().width || window.innerWidth,
    direction: 1,
    onChange: resizeTo,
    onReset: reset,
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
  // "Mark all read": every thread on one workspace and its copies, or on
  // every host (the latter raises the seen floor too, as the View menu's
  // item does). It and the project menu's counts read the stores when they
  // run: subscribing here re-rendered every rail row on every meta push.
  const markRead = (path: string | null): void => {
    const { ids, at } = threadsToMarkRead(sessionStore.metas(), workspaceStore.getSnapshot(), path === null ? null : (rowOf(path)?.paths ?? path));
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
        batchCounts(sessionStore.metas(), { catalog: workspaceStore.getSnapshot(), lastSeen: loadLastSeen(), floor: seenFloor(), scope: projectScope(path, projectKey) }),
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
  const inboxUnseen = useInboxUnseen();
  const topIds = railTopRows({
    chats: onOpenChats !== undefined,
    notes: onOpenNotes !== undefined,
    aliax: onOpenAccountsPage !== undefined,
  });
  const topRow = (id: RailTopRowId) => {
    switch (id) {
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
      case "read":
        return <RailRow key={id} icon={ListChecks} label="Mark all read" onClick={() => markRead(null)} />;
      case "notes":
        return <RailRow key={id} icon={StickyNote} label="Notes" selected={notesActive} onClick={onOpenNotes} intent={notesChunk.intent} />;
      case "chats":
        return (
          <RailRow
            key={id}
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
        );
      case "accounts":
      case "stats":
        return (
          <RailRow
            key={id}
            icon={id === "accounts" ? Users : ChartBar}
            label={id === "accounts" ? "Accounts" : "Stats"}
            selected={accountsPage === id}
            onClick={() => onOpenAccountsPage?.(id)}
            intent={aliaxChunk.intent}
          />
        );
    }
  };
  return (
    <nav
      ref={attachPane}
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
            <div className="shrink-0 px-2">{topIds.map(topRow)}</div>
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
                pinned
                onTogglePin={onTogglePin}
                menuPath={menuPath}
                groupLabels={groupLabels}
              />
            ) : null}

            <ProjectSection
              label="Workspaces"
              items={rows.projects}
              statusKey={statusKey}
              onAdd={noWorkspaces ? undefined : () => onOpenProject(undefined, ADD_WORKSPACE)}
              emptyRow={
                noWorkspaces ? <RailRow icon={FolderPlus} label="Add workspace…" onClick={() => onOpenProject(undefined, ADD_WORKSPACE)} /> : null
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
              pinned={false}
              onTogglePin={onTogglePin}
              menuPath={menuPath}
              groupLabels={groupLabels}
            />
            </div>
            </RowsContextMenu>
          </div>
          <RailFoot
            activeSessionId={activeSessionId}
            working
            onSelectThread={onSelectAgent}
            onOpenWhatsNew={onOpenWhatsNew}
            onAddWorkspace={(environmentId) => onOpenProject(environmentId, ADD_WORKSPACE)}
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
          dragging ? "bg-foreground/12" : "hover:bg-foreground/7"
        }`}
        onPointerDown={onPointerDown}
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
  pinned,
  onTogglePin,
  menuPath,
  groupLabels,
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
  /** The section's rows are pinned: their glyph action unpins. */
  pinned: boolean;
  onTogglePin: (path: string) => void;
  /** The folder whose menu is open: its ⋯ stays shown. */
  menuPath: string | null;
  groupLabels: Record<string, string>;
}) {
  return (
    <div className="shrink-0 px-2 pt-4">
      <RailHeading action={onAdd ? { label: "Add workspace", icon: Plus, onClick: onAdd } : undefined}>
        {label}
      </RailHeading>
      <div className="flex flex-col gap-1">
        {emptyRow}
        {items.map((item, index) => (
          <WorkspaceRow
            key={item.path}
            item={item}
            selectedPath={searchActive ? null : (item.paths.find((p) => sameProjectPath(p, cwd)) ?? null)}
            busy={item.paths.some((p) => pathIn(p, busy))}
            needsYou={item.paths.some((p) => pathIn(p, needsYou))}
            railStatus={railStatuses.get(statusKey(item.path))}
            activeSessionId={activeSessionId}
            onSelectAgent={onSelectAgent}
            sortable={sortable}
            index={indexOf ? indexOf(item) : index}
            onSelect={onSelect}
            onOpenMenu={onOpenMenu}
            pinned={pinned}
            onTogglePin={onTogglePin}
            menuOpen={menuPath !== null && item.paths.some((p) => sameProjectPath(p, menuPath))}
            groupLabels={groupLabels}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One workspace, a container on the sidebar-group fill: its alias-resolved
 * name alone (no logo, mascot or colour in the rail; medium while a thread
 * in it is unread), the selected row's uncommitted lines muted and the
 * state's one glyph as its trailing marks, and Pin or Unpin then ⋯ (the
 * same menu as a right-click) as its hover actions; drag reorders it.
 */
function WorkspaceRow({
  item,
  selectedPath,
  busy,
  needsYou,
  railStatus,
  activeSessionId,
  onSelectAgent,
  sortable,
  index,
  onSelect,
  onOpenMenu,
  pinned,
  onTogglePin,
  menuOpen,
  groupLabels,
}: {
  item: RailItem;
  /** The copy of this row's workspace on screen, when the row is selected:
   *  its diff is that copy's, on that copy's host. */
  selectedPath: string | null;
  busy: boolean;
  needsYou: boolean;
  railStatus: WorkspaceMark | undefined;
  activeSessionId: string | null;
  onSelectAgent?: (sessionId: string) => void;
  sortable: SortableHandle;
  index: number;
  onSelect: (path: string) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  pinned: boolean;
  onTogglePin: (path: string) => void;
  menuOpen: boolean;
  groupLabels: Record<string, string>;
}) {
  const workspaces = useWorkspaces();
  const workspaceId = workspaceByPath(workspaces, item.path)?.id ?? null;
  const offline = useHostsOffline(item.hosts);
  // Labels, colours and mascots key by the link's leader (lib/linkedRail.ts).
  const projectKey = workspaceLabelKey(workspaces, item.path, projectName(item.path));
  const name = resolveTabGroupLabel(projectKey, groupLabels, basename(item.path));
  const dragging = sortable.draggingId === item.path;
  const dropping = sortable.draggingId && sortable.toIndex === index && sortable.fromIndex !== null;
  const showStart = dropping && sortable.toIndex! < sortable.fromIndex!;
  const showEnd = dropping && sortable.toIndex! > sortable.fromIndex!;
  // Only the selected row asks git, on the bulk lane; the rest say nothing.
  const selected = selectedPath !== null;
  const stats = useGitDiffStats(selectedPath, selected && selectedPath !== "~");
  const changed = !!stats && (stats.additions > 0 || stats.deletions > 0);

  return (
      <RailRow
        rowRef={(el) => sortable.setItemRef(item.path, el)}
        data-host-offline={offline || undefined}
        data-rail-path={item.path}
        className={`@container/railrow touch-none ${dragging ? "relative z-10" : ""} ${offline ? "opacity-50" : ""}`}
        surface="group"
        label={name}
        ariaLabel={workspaceRowAriaLabel(name, busy, needsYou, stats)}
        selected={selected}
        emphasis={!!railStatus?.unread}
        trailingInteractive
        trailing={
          changed || (railStatus?.mark && workspaceId) ? (
            <>
              {changed ? (
                // Muted: the colours belong to the Changes section. It yields to
                // the hover actions, and to the name in a rail under 15rem; the
                // button's name still says it.
                <span
                  data-workspace-diff
                  data-rail-yield={RAIL_YIELD["data-rail-yield"]}
                  className={cn("pointer-events-none pr-1 whitespace-nowrap @max-[15rem]/railrow:hidden", RAIL_YIELD.className)}
                >
                  {diffWords(stats.additions, stats.deletions)}
                </span>
              ) : null}
              {railStatus?.mark && workspaceId ? (
                <WorkspaceMarkTrigger
                  mark={railStatus.mark}
                  workspaceIds={item.workspaceIds.length > 0 ? item.workspaceIds : [workspaceId]}
                  activeSessionId={activeSessionId}
                  onSelectThread={onSelectAgent}
                />
              ) : null}
            </>
          ) : null
        }
        hoverActions={[
          {
            label: pinned ? "Unpin workspace" : "Pin workspace",
            icon: pinned ? PinOff : Pin,
            onClick: () => onTogglePin(item.path),
          },
          {
            label: "Workspace options",
            icon: MoreHorizontal,
            menu: true,
            expanded: menuOpen,
            onClick: (event) => onOpenMenu(item.path, event.clientX, event.clientY),
          },
        ]}
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

/** A workspace row's name for assistive tech: the name, the one state that
 *  matters (needs you outranks working), then the selected row's
 *  uncommitted changes ("3 files changed, +12, -4"). */
export function workspaceRowAriaLabel(
  name: string,
  busy: boolean,
  needsYou = false,
  stats?: Pick<GitDiffStats, "files" | "additions" | "deletions"> | null,
): string {
  const parts = [name];
  if (needsYou) parts.push("needs you");
  else if (busy) parts.push("working");
  if (stats && (stats.files > 0 || stats.additions > 0 || stats.deletions > 0))
    parts.push(`${stats.files} ${stats.files === 1 ? "file" : "files"} changed`, `+${stats.additions}`, `-${stats.deletions}`);
  return parts.join(", ");
}

export type RailTopRowId = "search" | "inbox" | "read" | "notes" | "chats" | "accounts" | "stats";

/** The rail's one navigation group, first in its list and with no heading:
 *  Search, Inbox, Mark all read, Notes (where the view can open), Chats
 *  (where the home is), then Accounts and Stats (where their pages open,
 *  never at /ui). */
export function railTopRows(facts: { chats: boolean; notes: boolean; aliax: boolean }): RailTopRowId[] {
  const rows: RailTopRowId[] = ["search", "inbox", "read"];
  if (facts.notes) rows.push("notes");
  if (facts.chats) rows.push("chats");
  if (facts.aliax) rows.push("accounts", "stats");
  return rows;
}

export type RailFootRowId = "signIn" | "update" | "hosts" | "settings";

/** The foot's rows, in order: the sign-in while this machine has no account,
 *  the update when there is one to act on, the hosts with two or more, then
 *  Settings. */
export function railFootRows(facts: { signIn: boolean; update: boolean; hosts: number }): RailFootRowId[] {
  const rows: RailFootRowId[] = [];
  if (facts.signIn) rows.push("signIn");
  if (facts.update) rows.push("update");
  if (facts.hosts >= 2) rows.push("hosts");
  rows.push("settings");
  return rows;
}

/**
 * The rail's foot under one hairline: the Working section (the rail's own),
 * its rows 16px under it, then the usage meter. The same foot, without
 * Working, sits under the workspace column while the rail is collapsed:
 * that column already lists the threads.
 */
export function RailFoot({
  activeSessionId,
  working = false,
  onSelectThread,
  onOpenWhatsNew,
  onAddWorkspace,
}: {
  activeSessionId?: string;
  /** Draw the Working section above the rows. */
  working?: boolean;
  onSelectThread?: (sessionId: string) => void;
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
  onAddWorkspace: (environmentId: string) => void;
}) {
  const environments = useEnvironments();
  const update = useUpdateRowState();
  const signIn = useSignInTarget();
  const ids = railFootRows({
    signIn: signIn !== null,
    update: update !== null,
    hosts: environments.length,
  });
  const row = (id: RailFootRowId) => {
    switch (id) {
      case "signIn":
        return signIn ? <SignInRow key={id} provider={signIn} /> : null;
      case "update":
        return <UpdateRow key={id} state={update} onOpenWhatsNew={onOpenWhatsNew} />;
      case "hosts":
        return <HostsRow key={id} onAddWorkspace={onAddWorkspace} />;
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
      {working ? <RailWorking activeSessionId={activeSessionId} onSelect={onSelectThread} /> : null}
      <div className="flex flex-col p-2">{ids.map(row)}</div>
      <UsageMeter sessionId={activeSessionId} />
    </div>
  );
}
