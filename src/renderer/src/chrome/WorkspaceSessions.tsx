import { useHostsOffline } from "./hostOffline";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { RowsContextMenu, RowsMenu, tidy, type MenuRow } from "./menuRows";
import { useThreadMenu } from "./useThreadMenu";
import { HostGlyph } from "./HostGlyph";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FileText,
  MessageSquarePlus,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings,
  Square,
  Trash2,
} from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";
import { modelLabel } from "../lib/threads/agents";
import { AGENT_GLYPHS, THREAD_GLYPHS } from "../surfaces/threads/threadTypes";
import { STATUS_WORD, StatusMark, type ThreadState } from "../components/ui/status";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { projectFolds, projectFoldsStore, projectOpen, useProjectOpen } from "../lib/projectFolds";
import {
  projectCardStatus,
  projectRunAction,
  stoppableThreads,
} from "../lib/projectCardModel";
import { SESSION_LIST_PAGE } from "../lib/sessionListWindow";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import {
  groupMark,
  groupUnread,
  nextPage,
  rowState,
  type GroupMark,
  sessionItemIndex,
  sidebarItems,
  windowRows,
  type SidebarItem,
} from "../lib/sidebarRows";
import { archive as archiveThread, interrupt, pause, resume } from "../lib/tcserver/commands";
import { dormantByType, dormantThreads, focusedTree, marksAtRest, threadStatus } from "../lib/threadStripModel";
import { deleteProject } from "../lib/tcserver/projects";
import { archiveLinked, projectHomeNow, renameLinked } from "../lib/projectHome";
import { sessionPrefetch } from "../lib/sessionPrefetch";
import { useSessionMetas } from "../lib/tcserver/store";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import { subagentRows, subagentRowsOpen, useSubagentRows } from "../stores/subagentRows";
import {
  cardThreads,
  groupWorkspaceSessions,
  rowCache,
  type ProjectGroup,
  type ThreadRow,
} from "../lib/workspaceSessions";
import { dialogsChunk } from "../surfaces/chunks";
import { RailRows } from "./railRows";

// Opened from a project's menu; mounted only while open (chrome/dialogs.ts).
const ProjectSettingsDialog = dialogsChunk.surface("ProjectSettingsDialog");
const PreambleDialog = dialogsChunk.surface("PreambleDialog");
const ProjectTeardownDialog = dialogsChunk.surface("ProjectTeardownDialog");

type Props = {
  /** Null: the home, the chats outside every workspace. */
  workspaceId: string | null;
  /** The workspace's copies on other hosts with it, the leader's first
   *  (lib/linkedRail.ts): their threads interleave as one list. */
  workspaceIds?: readonly string[] | null;
  selectedProjectId: string | null;
  activeSessionId?: string;
  onSelectProject: (projectId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  onNewChat: (projectId: string | null) => void;
  onNewProject: () => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
};

type Dialog =
  | { kind: "settings"; project: ProjectMeta }
  | { kind: "preamble"; project: ProjectMeta }
  | { kind: "teardown"; project: ProjectMeta; action: "archive" | "delete" }
  | { kind: "delete-project"; project: ProjectMeta };


// --- clocks ---------------------------------------------------------------

// --- small parts -----------------------------------------------------------

/** The row behind which a windowed list keeps the rest. */
function MoreRow({ hidden, onMore }: { hidden: number; onMore: () => void }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onMore}
      className="w-full justify-start pl-9 font-normal text-muted-foreground hover:text-foreground"
    >
      {hidden} more
    </Button>
  );
}

/** A row's one hover action: ⋯, the same menu a right-click opens. It
 *  takes the trailing slot's place by opacity, as the rail's rows do. */
/** The ⋯ a row shows on hover and focus, as a menu's trigger. */
function moreTrigger(className?: string) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="More"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "text-muted-foreground hover:text-foreground",
        "pointer-events-none opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
        "group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 data-popup-open:pointer-events-auto data-popup-open:opacity-100",
        className,
      )}
    >
      <MoreHorizontal className="size-4" strokeWidth={1.5} />
    </Button>
  );
}


/** The trailing slot fades while the row's hover action shows. */
const YIELDS =
  "transition-opacity duration-(--dur-fast) ease-(--ease-out) group-focus-within/row:opacity-0 group-hover/row:opacity-0 motion-reduce:transition-none";

function InlineRename({
  value,
  className,
  onCommit,
  onCancel,
}: {
  value: string;
  className: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else onCancel();
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      done.current = true;
      onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      className={cn("w-full rounded-md bg-background px-1.5 py-0.5 leading-snug text-foreground outline-none ring-1 ring-accent", className)}
    />
  );
}

// --- rows ------------------------------------------------------------------

type RowActions = {
  activeSessionId?: string;
  /** The focused session's root and children: "Archive dormant" spares them. */
  focusedTree: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  /** The thread rows' one menu (chrome/useThreadMenu.tsx). */
  menu: RailThreadMenu;
  /** The row whose title is being renamed in place. */
  renamingId: string | null;
  onStartRename: (id: string | null) => void;
};

/** The thread menu as the rail's rows use it: stable across renders. */
type RailThreadMenu = {
  rowsFor: (id: string) => readonly MenuRow[];
  onPick: (id: string, pick: string) => void;
  onOpenChange: (id: string, open: boolean) => void;
};

/** Scrolls the list's selected row into view when the selection moves, and
 *  only then: a list the virtualizer re-mounts around an unchanged selection
 *  must not tug the scroller. */
function useRevealActive(activeSessionId: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const was = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId === was.current) return;
    was.current = activeSessionId;
    ref.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeSessionId]);
  return ref;
}

/** The subagent fold in a root row's tail: how many, whether they show, the flip. */
type Fold = { count: number; open: boolean; noun: "subagent" | "thread"; onToggle: () => void };

/** A row's state and what its tooltip says about it: the word, then the
 *  activity, the failure or the round's tally (docs/DESIGN.md "Status vocabulary"). */
export function rowMark(row: ThreadRow): { state: ThreadState; label: string } {
  const state = rowState(row);
  const status = threadStatus({
    status: row.status,
    treeHasPaused: row.treeHasPaused,
    treeCanContinue: row.treeCanContinue,
    activity: row.activity,
    tasks: row.tasks,
    failure: row.failure,
  });
  const same = status.state === state;
  return {
    state,
    label: [STATUS_WORD[state], same ? status.detail : null, same ? status.tally : null].filter(Boolean).join("  "),
  };
}

/** The mark at a row's end: the glyph alone, its word and detail as its
 *  label (the row's tooltip says them), or the glyph and its word (`word`,
 *  the popover's rows). Nothing on a settled row. */
function RowMark({ row, word }: { row: ThreadRow; word?: boolean }) {
  const { state, label } = rowMark(row);
  if (!marksAtRest(state)) return null;
  if (word) return <StatusMark state={state} className="shrink-0" />;
  return <StatusMark state={state} word={false} aria-label={label} />;
}

/** A master's done tally over its batch: settled threads of all of them. */
export function batchTally(row: ThreadRow): { done: number; total: number } | null {
  if (!row.batch?.length) return null;
  const done = row.batch.filter((b) => !marksAtRest(rowState(b))).length;
  return { done, total: row.batch.length };
}

const ROW =
  "group/row relative flex w-full cursor-default items-center gap-2 rounded-md px-3 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * A thread row, presentational: a root in the workspace column (32px, its
 * title in the project name's column) or a child one step in (a subagent or
 * a batch thread, 28px, the role's or type's glyph before its title, what it
 * does or its model after). It ends in its mark: the glyph alone, the word
 * and what it is about on hover. Unread is weight on the title, never a dot.
 * Selection is a `muted` fill; nothing tints a paused row.
 */
export function ThreadRowView({
  row,
  selected = false,
  offline = false,
  child = false,
  word = false,
  lead = true,
  fold,
  title,
  onOpen,
  menuId,
  more,
  onRename,
}: {
  row: ThreadRow;
  selected?: boolean;
  offline?: boolean;
  child?: boolean;
  /** The mark with its word (the popover, where the width allows it); a
   *  failed row then prints the host's verdict under its title. */
  word?: boolean;
  /** The empty 16px slot that puts a root's title in the project name's
   *  column; the popover, with no chevrons, leaves it out. */
  lead?: boolean;
  fold?: Fold;
  /** In place of the title: the rename field. */
  title?: ReactNode;
  onOpen?: () => void;
  /** The row's thread for the list's one right-click menu (`data-menu-id`). */
  menuId?: string;
  /** The row's ⋯ menu, over the mark on hover and focus. */
  more?: ReactNode;
  onRename?: () => void;
}) {
  const tally = batchTally(row);
  const Glyph = child ? (row.agentType ? AGENT_GLYPHS[row.agentType] : row.threadType ? THREAD_GLYPHS[row.threadType] : null) : null;
  const live = child && row.running ? row.activity?.trim() : "";
  const editing = title != null;
  const verdict = word && row.failure && rowState(row) === "failed" ? row.failure : null;
  const mark = rowMark(row);
  // Hover and focus put More over the glyph, so the row itself says the
  // word and its detail: the pointer anywhere on it, or the keyboard on it.
  const tip = !word && !editing && marksAtRest(mark.state) ? mark.label : null;
  const element = (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      data-host-offline={offline || undefined}
      data-thread-row
      onClick={() => !editing && onOpen?.()}
      onPointerEnter={() => sessionPrefetch.enter(row.id)}
      onPointerLeave={() => sessionPrefetch.leave(row.id)}
      onDoubleClick={onRename}
      onKeyDown={(e) => e.key === "Enter" && !editing && onOpen?.()}
      data-menu-id={menuId}
      className={cn(
        ROW,
        verdict ? "min-h-8 py-1.5" : child ? "h-7" : "h-8",
        selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        offline && "opacity-50",
      )}
    >
      {lead ? <span aria-hidden className="size-4 shrink-0" /> : null}
      {Glyph ? (
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-muted-foreground">
          <Glyph className="size-3" strokeWidth={1.5} />
        </span>
      ) : null}
      {editing ? (
        title
      ) : verdict ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate">{row.title || "Untitled"}</span>
          <span className="truncate text-[12px] text-muted-foreground">{verdict}</span>
        </span>
      ) : (
        <span className={cn("min-w-0 truncate", live ? "shrink" : "flex-1", row.unread && "font-medium text-foreground")}>
          {row.title || (child && !row.masterId ? "Subagent" : "Untitled")}
        </span>
      )}
      {!editing ? (
        <>
          <HostGlyph environmentId={row.environmentId} />
          {live ? (
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" data-activity>
              {live}
            </span>
          ) : child && row.provider && row.model ? (
            <span className="shrink-0 text-[12px] text-muted-foreground">{modelLabel(row.provider, row.model)}</span>
          ) : null}
          {fold ? (
            <Button
              variant="ghost"
              size="xs"
              aria-expanded={fold.open}
              aria-label={`${fold.open ? "Hide" : "Show"} ${fold.count} ${fold.noun}${fold.count === 1 ? "" : "s"}`}
              onClick={(e) => {
                e.stopPropagation();
                fold.onToggle();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-5 gap-0.5 px-1 text-[11px] font-normal tabular-nums text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-3 transition-transform duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
                  fold.open && "rotate-90",
                )}
                strokeWidth={1.5}
              />
              {fold.count}
            </Button>
          ) : null}
          <span className={cn("flex shrink-0 items-center gap-2", more && YIELDS)}>
            {tally ? (
              <span className={cn("text-[12px] tabular-nums", tally.done === tally.total ? "text-success" : "text-muted-foreground")}>
                {tally.done}/{tally.total}
              </span>
            ) : null}
            <span className={cn("grid shrink-0 place-items-center", word ? "min-w-4" : "size-4")}>
              <RowMark row={row} word={word} />
            </span>
          </span>
          {more}
        </>
      ) : null}
    </div>
  );
  // Always the same tree, the tooltip disabled when there is nothing to say,
  // so a focused row keeps its focus when its thread settles.
  return (
    <Tooltip disabled={!tip}>
      <TooltipTrigger render={element} />
      {tip ? <TooltipContent side="right">{tip}</TooltipContent> : null}
    </Tooltip>
  );
}

const ChatRow = memo(function ChatRow({
  thread,
  actions,
  fold,
}: {
  thread: ThreadRow;
  actions: RowActions;
  fold?: Fold;
}) {
  const offline = useHostsOffline([thread.environmentId]);
  const renaming = actions.renamingId === thread.id;
  return (
    <ThreadRowView
      row={thread}
      selected={thread.id === actions.activeSessionId}
      offline={offline}
      fold={fold}
      onOpen={() => actions.onOpen(thread.id)}
      menuId={thread.id}
      more={<MoreMenu id={thread.id} menu={actions.menu} />}
      onRename={() => actions.onStartRename(thread.id)}
      title={
        renaming ? (
          <InlineRename
            value={thread.title}
            className="text-[13px]"
            onCommit={(t) => {
              actions.onStartRename(null);
              actions.onRename(thread.id, t);
            }}
            onCancel={() => actions.onStartRename(null)}
          />
        ) : undefined
      }
    />
  );
});

/** A rail row's ⋯: the thread's menu from its trigger. */
function MoreMenu({ id, menu }: { id: string; menu: RailThreadMenu }) {
  return (
    <RowsMenu
      label="Thread actions"
      tip={{ label: "More", side: "right" }}
      trigger={moreTrigger("absolute top-1/2 right-1 -translate-y-1/2")}
      rows={() => menu.rowsFor(id)}
      onPick={(pick) => menu.onPick(id, pick)}
      onOpenChange={(open) => menu.onOpenChange(id, open)}
      align="start"
    />
  );
}

/** A subagent under its root, or a batch thread under its master. */
const ChildRow = memo(function ChildRow({
  thread,
  actions,
}: {
  thread: ThreadRow;
  actions: RowActions;
}) {
  const offline = useHostsOffline([thread.environmentId]);
  return (
    <ThreadRowView
      row={thread}
      child
      selected={thread.id === actions.activeSessionId}
      offline={offline}
      onOpen={() => actions.onOpen(thread.id)}
      menuId={thread.id}
    />
  );
});

/** A root row and its subagents beneath it, or a master's batch threads
 *  (`batchHome`). They show while the root or one of them works, or while
 *  one is the open thread; otherwise the root's tail counts them and a
 *  click unfolds them (see subagentRows). */
const ThreadRows = memo(function ThreadRows({
  thread,
  actions,
}: {
  thread: ThreadRow;
  actions: RowActions;
}) {
  // A master's batch first, then its own subagents, never interleaved.
  const kids = useMemo(
    () => (thread.batch ? [...thread.batch, ...(thread.children ?? [])] : thread.children),
    [thread.batch, thread.children],
  );
  const count = kids?.length ?? 0;
  const auto =
    thread.running ||
    (kids?.some((c) => c.running || c.id === actions.activeSessionId) ?? false);
  const open = useSubagentRows((s) => count > 0 && subagentRowsOpen(s, thread.id, auto));
  const noun = thread.batch?.length ? "thread" : "subagent";
  const fold = useMemo<Fold | undefined>(
    () =>
      count > 0
        ? { count, open, noun, onToggle: () => subagentRows.toggle(thread.id, auto) }
        : undefined,
    [auto, count, noun, open, thread.id],
  );
  return (
    <>
      <ChatRow thread={thread} actions={actions} fold={fold} />
      {open ? kids?.map((c) => <ChildRow key={c.id} thread={c} actions={actions} />) : null}
    </>
  );
});

/** How many rows each windowed list shows, by list key; the root owns it so
 *  a section the virtualizer unmounts comes back as long as it was. */
type Pages = Record<string, number>;
const pageOf = (pages: Pages, key: string): number => pages[key] ?? SESSION_LIST_PAGE;

/** Root rows, one page at a time (`sessionListWindow`), the active row always in it. */
export const ThreadList = memo(function ThreadList({
  threads,
  actions,
  requested = SESSION_LIST_PAGE,
  onMore,
  className,
}: {
  threads: readonly ThreadRow[];
  actions: RowActions;
  requested?: number;
  onMore?: () => void;
  className: string;
}) {
  const { shown, hidden } = windowRows(threads, requested, actions.activeSessionId);
  const ref = useRevealActive(actions.activeSessionId);
  return (
    <div ref={ref} className={className}>
      {shown.map((t) => (
        <ThreadRows key={t.id} thread={t} actions={actions} />
      ))}
      {hidden > 0 && onMore ? <MoreRow hidden={hidden} onMore={onMore} /> : null}
    </div>
  );
});

// --- project rows ----------------------------------------------------------

/** A fold's chevron: 14px, muted, a quarter turn when open. */
function FoldChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
        open && "rotate-90",
        className,
      )}
      strokeWidth={1.5}
    />
  );
}

/**
 * A project row, presentational: the chevron, the name (heavier while a
 * thread in it is unread) and one word at the end, the project's loudest
 * state (Needs you, Failed, Working, Paused; nothing when quiet). Its
 * threads fold under it.
 */
export function ProjectRowView({
  name,
  open,
  selected = false,
  unread = false,
  mark,
  title,
  onClick,
  menu,
  onRename,
}: {
  name: string;
  open: boolean;
  selected?: boolean;
  unread?: boolean;
  mark: GroupMark<ThreadRow> | null;
  /** In place of the name: the rename field. */
  title?: ReactNode;
  onClick?: () => void;
  /** The project's menu: its right-click and its ⋯ show the same rows. */
  menu?: { rows: () => readonly MenuRow[]; onPick: (id: string) => void };
  onRename?: () => void;
}) {
  const editing = title != null;
  const row = (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-current={selected || undefined}
      data-project-row
      onClick={() => !editing && onClick?.()}
      onDoubleClick={onRename}
      onKeyDown={(e) => e.key === "Enter" && !editing && onClick?.()}
      className={cn(ROW, "h-8 hover:bg-foreground/5", selected || unread ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      <span aria-hidden className="grid size-4 shrink-0 place-items-center">
        <FoldChevron open={open} />
      </span>
      {editing ? title : <span className={cn("min-w-0 flex-1 truncate", unread && "font-medium")}>{name}</span>}
      {!editing ? (
        <>
          {mark ? <StatusMark state={mark.state} className={cn("shrink-0", menu && YIELDS)} /> : null}
          {menu ? (
            <RowsMenu
              label="Project actions"
              tip={{ label: "More", side: "right" }}
              trigger={moreTrigger("absolute top-1/2 right-1 -translate-y-1/2")}
              rows={menu.rows}
              onPick={menu.onPick}
              align="start"
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
  return menu ? (
    <RowsContextMenu label="Project actions" lazyMount rowsFor={menu.rows} onPick={(pick) => menu.onPick(pick)}>
      {row}
    </RowsContextMenu>
  ) : (
    row
  );
}

type ProjectRowProps = {
  group: ProjectGroup;
  selected: boolean;
  lastSeen: Record<string, number>;
  seenFloor: number;
  rows: RowActions;
  requested: number;
  onMore: (key: string) => void;
  onSelect: (projectId: string) => void;
  onNewChat: (projectId: string) => void;
  onRename: (projectId: string, name: string) => void;
  onSettings: (project: ProjectMeta) => void;
  onPreamble: (project: ProjectMeta) => void;
  onArchive: (project: ProjectMeta) => void;
  onDelete: (project: ProjectMeta) => void;
};

/** A project and, unless the person folded it, its threads under it (open
 *  by default, the close remembered: lib/projectFolds.ts). A click selects
 *  the project and flips the fold; a double-click renames it. */
export const ProjectRow = memo(function ProjectRow({
  group,
  selected,
  lastSeen,
  seenFloor,
  rows,
  requested,
  onMore: more,
  onSelect: selectProject,
  onNewChat: newChat,
  onRename: renameTo,
  onSettings: openSettings,
  onPreamble: openPreamble,
  onArchive: archive,
  onDelete: remove,
}: ProjectRowProps) {
  const { project, threads } = group;
  const open = useProjectOpen(project.id);
  const [renaming, setRenaming] = useState(false);
  const mark = useMemo(() => groupMark(threads), [threads]);
  const unread = useMemo(() => groupUnread(threads), [threads]);
  const status = projectCardStatus(cardThreads(threads), rows.activeSessionId ?? null, lastSeen, seenFloor);
  const runAction = projectRunAction(status);
  const stoppable = stoppableThreads(status);
  const teardown = project.mode === "worktree" && Boolean(project.branch);

  const dormant = () => dormantThreads(threads, lastSeen, seenFloor, rows.focusedTree);
  const menuRows = (): MenuRow[] => {
    const all = dormant();
    const items: MenuRow[] = [
      { kind: "item", id: "chat", label: "New chat", icon: MessageSquarePlus },
      { kind: "item", id: "rename", label: "Rename", icon: Pencil },
      { kind: "item", id: "settings", label: "Project settings", icon: Settings },
      { kind: "item", id: "preamble", label: "Preamble…", icon: FileText },
      { kind: "sep" },
    ];
    if (runAction === "resume") items.push({ kind: "item", id: "resume", label: "Continue paused threads", icon: Play });
    else if (runAction === "pause") items.push({ kind: "item", id: "pause", label: "Pause active threads", icon: Pause });
    if (stoppable.length) items.push({ kind: "item", id: "stop", label: "Stop active threads", icon: Square, danger: true });
    items.push(
      { kind: "sep" },
      {
        kind: "item",
        id: "archive-dormant",
        label: all.length > 0 ? `Archive ${all.length} dormant thread${all.length === 1 ? "" : "s"}` : "Archive dormant threads",
        icon: Archive,
        disabled: all.length === 0,
      },
      ...dormantByType(all).map((g): MenuRow => ({ kind: "item", id: `archive-dormant:${g.type}`, label: g.label, icon: THREAD_GLYPHS[g.type] })),
      { kind: "item", id: "archive", label: teardown ? "Archive project…" : "Archive project", icon: Archive },
      { kind: "sep" },
      { kind: "item", id: "delete", label: "Delete project…", icon: Trash2, danger: true },
    );
    return tidy(items);
  };
  const onMenuPick = (id: string) => {
    if (id === "chat") newChat(project.id);
    else if (id === "rename") setRenaming(true);
    else if (id === "settings") openSettings(project);
    else if (id === "preamble") openPreamble(project);
    else if (id === "resume") void Promise.allSettled(status.paused.map((t) => resume(t.id)));
    else if (id === "pause") void Promise.allSettled(status.running.map((t) => pause(t.id)));
    else if (id === "stop") void Promise.allSettled(stoppable.map((t) => interrupt(t.id)));
    else if (id === "archive-dormant") void Promise.allSettled(dormant().map((t) => archiveThread(t.id, true)));
    else if (id.startsWith("archive-dormant:"))
      void Promise.allSettled(
        (dormantByType(dormant()).find((g) => g.type === id.slice("archive-dormant:".length))?.threads ?? []).map((t) => archiveThread(t.id, true)),
      );
    else if (id === "archive") archive(project);
    else if (id === "delete") remove(project);
  };

  return (
    <Collapsible open={open} onOpenChange={() => projectFolds.toggle(project.id)}>
      <ProjectRowView
        name={project.name}
        open={open}
        selected={selected}
        unread={unread}
        mark={mark}
        onClick={() => {
          if (!selected) selectProject(project.id);
          projectFolds.toggle(project.id);
        }}
        menu={{ rows: menuRows, onPick: onMenuPick }}
        onRename={() => setRenaming(true)}
        title={
          renaming ? (
            <InlineRename
              value={project.name}
              className="text-[13px]"
              onCommit={(n) => {
                setRenaming(false);
                renameTo(project.id, n);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : undefined
        }
      />
      <CollapsibleContent>
        <ThreadList
          threads={threads}
          actions={rows}
          requested={requested}
          onMore={() => more(project.id)}
          className="flex flex-col"
        />
      </CollapsibleContent>
    </Collapsible>
  );
});

/** A section's heading over its rows: 28px, 12px medium muted, sentence
 *  case; the heading flips the fold, `trailing` sits at its end. */
function SectionHeading({
  label,
  open,
  onToggle,
  trailing,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-1 pr-1">
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={open}
        onClick={onToggle}
        className="h-7 min-w-0 flex-1 justify-start gap-1 px-3 text-[12px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        <span className="truncate">{label}</span>
        <FoldChevron open={open} className="size-3" />
      </Button>
      {trailing}
    </div>
  );
}

// --- archived --------------------------------------------------------------

type ArchivedState = { open: boolean; shown: string | null };

const ArchivedProjects = memo(function ArchivedProjects({
  groups,
  rows,
  state,
  setState,
  pages,
  onMore,
  onRestore,
  onDelete,
}: {
  groups: ProjectGroup[];
  rows: RowActions;
  state: ArchivedState;
  setState: (update: (prev: ArchivedState) => ArchivedState) => void;
  pages: Pages;
  onMore: (key: string) => void;
  onRestore: (project: ProjectMeta) => void;
  onDelete: (project: ProjectMeta) => void;
}) {
  const { open, shown } = state;
  const toggle = () => setState((prev) => ({ ...prev, open: !prev.open }));
  const show = (id: string) => setState((prev) => ({ ...prev, shown: prev.shown === id ? null : id }));
  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <SectionHeading
        label="Archived"
        open={open}
        onToggle={toggle}
        trailing={<span className="pr-2 text-[12px] tabular-nums text-muted-foreground">{groups.length}</span>}
      />
      <CollapsibleContent>
        {groups.map(({ project, threads }) => (
          <Collapsible key={project.id} open={shown === project.id} onOpenChange={() => show(project.id)}>
            <ProjectRowView
              name={project.name}
              open={shown === project.id}
              mark={null}
              onClick={() => show(project.id)}
              menu={{
                rows: () => [
                  { kind: "item", id: "restore", label: "Restore", icon: ArchiveRestore },
                  { kind: "sep" },
                  { kind: "item", id: "delete", label: "Delete project…", icon: Trash2, danger: true },
                ],
                onPick: (id) => (id === "restore" ? onRestore(project) : onDelete(project)),
              }}
            />
            <CollapsibleContent>
              <ThreadList
                threads={threads}
                actions={rows}
                requested={pageOf(pages, `archived:${project.id}`)}
                onMore={() => onMore(`archived:${project.id}`)}
                className="flex flex-col"
              />
            </CollapsibleContent>
          </Collapsible>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
});

/** The loose chats under the projects, folded as one. */
const ChatsSection = memo(function ChatsSection({
  threads,
  rows,
  open,
  requested,
  onMore,
  onToggle,
  onNewChat,
}: {
  threads: ThreadRow[];
  rows: RowActions;
  open: boolean;
  requested: number;
  onMore: () => void;
  onToggle: () => void;
  onNewChat: (projectId: string | null) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <SectionHeading
        label="Chats"
        open={open}
        onToggle={onToggle}
        trailing={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="New chat"
                  onClick={() => onNewChat(null)}
                  className="text-muted-foreground hover:text-foreground"
                />
              }
            >
              <Plus className="size-3.5" strokeWidth={1.5} />
            </TooltipTrigger>
            <TooltipContent side="right">New chat</TooltipContent>
          </Tooltip>
        }
      />
      <CollapsibleContent>
        <ThreadList threads={threads} actions={rows} requested={requested} onMore={onMore} className="flex flex-col" />
      </CollapsibleContent>
    </Collapsible>
  );
});

const ROW_PX = 32;
const HEADING_PX = 28;

/** Heights for the virtualizer's first pass; every item is then measured.
 *  An open project and the chats section count their first page. */
const estimateItem = (item: SidebarItem): number => {
  switch (item.kind) {
    case "project":
      return (
        ROW_PX +
        (projectOpen(projectFoldsStore.getState(), item.group.project.id)
          ? ROW_PX * Math.min(item.group.threads.length, SESSION_LIST_PAGE)
          : 0)
      );
    case "chats":
      return HEADING_PX + ROW_PX * Math.min(item.threads.length, SESSION_LIST_PAGE);
    case "archived":
      return HEADING_PX;
    case "empty":
      return ROW_PX;
  }
};

// --- root ------------------------------------------------------------------

/** A project group is selected when the selection names any of its copies. */
const groupHolds = (group: ProjectGroup, projectId: string | null): boolean =>
  !!projectId && (group.project.id === projectId || !!group.projectIds?.includes(projectId));

export default function WorkspaceSessions({
  workspaceId,
  workspaceIds,
  selectedProjectId,
  activeSessionId,
  onSelectProject,
  onOpenSession,
  onNewChat,
  onNewProject,
  onRenameSession,
  onDeleteSession,
}: Props) {
  const metas = useSessionMetas();
  const { workspaces, projects } = useWorkspaceCatalog();
  const lastSeen = useLastSeen();
  const seenFloor = useSeenFloor();
  const [cache] = useState(rowCache);
  const groups = useMemo(
    () =>
      groupWorkspaceSessions(
        metas,
        projects,
        workspaces,
        workspaceIds && workspaceIds.length > 1 ? workspaceIds : workspaceId,
        lastSeen,
        seenFloor,
        cache,
      ),
    [cache, lastSeen, metas, projects, seenFloor, workspaceId, workspaceIds, workspaces],
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [archived, setArchived] = useState<ArchivedState>({ open: false, shown: null });
  const [pages, setPages] = useState<Pages>({});
  const close = () => setDialog(null);
  // A dialog edits a project in its own workspace (a linked group's leader
  // may sit in another copy than the one selected).
  const dialogProject = dialog && "project" in dialog ? dialog.project : null;
  const workspace: WorkspaceMeta | undefined = workspaces.find(
    (w) => w.id === (dialogProject?.workspaceId ?? workspaceId),
  );

  // The parent hands down fresh closures each render; the memoized cards and
  // rows see one stable callback that reads the newest.
  const latest = useRef({ onSelectProject, onOpenSession, onNewChat, onRenameSession, onDeleteSession, activeSessionId });
  latest.current = { onSelectProject, onOpenSession, onNewChat, onRenameSession, onDeleteSession, activeSessionId };
  const selectProject = useCallback((id: string) => latest.current.onSelectProject(id), []);
  const openSession = useCallback((id: string) => latest.current.onOpenSession(id), []);
  const newChat = useCallback(
    (projectId: string | null) => latest.current.onNewChat(projectId),
    [],
  );
  const renameSession = useCallback(
    (id: string, title: string) => latest.current.onRenameSession(id, title),
    [],
  );
  // A linked project's name and archived state live on its settings home
  // (lib/projectHome.ts); the copies follow.
  const rename = useCallback((id: string, name: string) => void renameLinked(id, name).catch(() => {}), []);
  const openSettings = useCallback(
    (project: ProjectMeta) => setDialog({ kind: "settings", project }),
    [],
  );
  const openPreamble = useCallback(
    (project: ProjectMeta) => setDialog({ kind: "preamble", project }),
    [],
  );
  const teardownOrConfirm = useCallback(
    (project: ProjectMeta, action: "archive" | "delete") => {
      const at = projectHomeNow(project);
      // A linked delete asks about the other copies; a linked archive whose
      // home is offline says so instead of failing out of sight.
      if (
        (project.mode === "worktree" && project.branch) ||
        (at.linked && (action === "delete" || at.blocked))
      )
        setDialog({ kind: "teardown", project, action });
      else if (action === "delete") setDialog({ kind: "delete-project", project });
      else void archiveLinked(project, true).catch(() => {});
    },
    [],
  );
  const archive = useCallback(
    (project: ProjectMeta) => teardownOrConfirm(project, "archive"),
    [teardownOrConfirm],
  );
  const remove = useCallback(
    (project: ProjectMeta) => teardownOrConfirm(project, "delete"),
    [teardownOrConfirm],
  );
  const restore = useCallback(
    (project: ProjectMeta) => void archiveLinked(project, false).catch(() => {}),
    [],
  );
  const toggleChats = useCallback(() => setChatsOpen((o) => !o), []);
  const morePages = useCallback(
    (key: string) => setPages((prev) => ({ ...prev, [key]: nextPage(pageOf(prev, key)) })),
    [],
  );
  const moreChats = useCallback(() => morePages("chats"), [morePages]);

  const focused = useMemo(() => focusedTree(metas, activeSessionId), [activeSessionId, metas]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const threadMenu = useThreadMenu({
    onRename: setRenamingId,
    onDelete: (id) => latest.current.onDeleteSession(id),
    onScreen: (id) => id === latest.current.activeSessionId,
  });
  // The rows are memoized: they get one stable menu that reads the newest.
  const menuRef = useRef(threadMenu);
  menuRef.current = threadMenu;
  const railMenu = useMemo<RailThreadMenu>(
    () => ({
      rowsFor: (id) => menuRef.current.rowsFor(id),
      onPick: (id, pick) => menuRef.current.onPick(id, pick),
      onOpenChange: (id, open) => menuRef.current.onOpenChange(id, open),
    }),
    [],
  );
  const rows = useMemo<RowActions>(
    () => ({
      activeSessionId,
      focusedTree: focused,
      onOpen: openSession,
      onRename: renameSession,
      menu: railMenu,
      renamingId,
      onStartRename: setRenamingId,
    }),
    [activeSessionId, focused, openSession, renameSession, railMenu, renamingId],
  );

  // Cards are the list's unit (railRows.tsx, virtual once the chunk lands):
  // each roots its own border and hover group, and the shared ActivePill
  // lives inside one. Every item is measured, so a card that grows a live
  // line pushes the ones below it. (A fold's
  // height animation is measured too: the root re-renders per frame while
  // a section opens or closes, and the memoized cards sit that out.)
  const items = useMemo(
    () => sidebarItems(groups, workspaceId === null),
    [groups, workspaceId],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const estimateSize = useCallback((i: number) => estimateItem(items[i]), [items]);
  const getItemKey = useCallback((i: number) => items[i].key, [items]);
  const rowCount = useMemo(() => items.reduce((n, item) => n + estimateItem(item) / ROW_PX, 0), [items]);

  // Bring the selected card on screen once per selection: when it changes,
  // or as soon as the list fills after a boot that restored it. A meta push
  // re-sorting the cards must not scroll.
  const [reveal, setReveal] = useState<{ index: number } | null>(null);
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedProjectId || revealed.current === selectedProjectId) return;
    const index = items.findIndex(
      (item) => item.kind === "project" && groupHolds(item.group, selectedProjectId),
    );
    if (index < 0) return;
    revealed.current = selectedProjectId;
    setReveal({ index });
  }, [items, selectedProjectId]);
  const revealedSession = useRef(activeSessionId);
  useEffect(() => {
    if (!activeSessionId || revealedSession.current === activeSessionId) return;
    const index = sessionItemIndex(items, activeSessionId);
    if (index < 0) return;
    revealedSession.current = activeSessionId;
    setReveal({ index });
  }, [activeSessionId, items]);

  const entry = (item: SidebarItem): ReactNode => {
    switch (item.kind) {
      case "project":
        return (
          <ProjectRow
            group={item.group}
            selected={groupHolds(item.group, selectedProjectId)}
            lastSeen={lastSeen}
            seenFloor={seenFloor}
            rows={rows}
            requested={pageOf(pages, item.key)}
            onMore={morePages}
            onSelect={selectProject}
            onNewChat={newChat}
            onRename={rename}
            onSettings={openSettings}
            onPreamble={openPreamble}
            onArchive={archive}
            onDelete={remove}
          />
        );
      case "chats":
        return (
          <ChatsSection
            threads={item.threads}
            rows={rows}
            open={chatsOpen}
            requested={pageOf(pages, "chats")}
            onMore={moreChats}
            onToggle={toggleChats}
            onNewChat={newChat}
          />
        );
      case "archived":
        return (
          <ArchivedProjects
            groups={item.groups}
            rows={rows}
            state={archived}
            setState={setArchived}
            pages={pages}
            onMore={morePages}
            onRestore={restore}
            onDelete={remove}
          />
        );
      case "empty":
        return (
          <Button
            variant="ghost"
            size="sm"
            onClick={onNewProject}
            className="h-8 w-full justify-start gap-2 px-3 font-normal text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-4" strokeWidth={1.5} />
            New project
          </Button>
        );
    }
  };

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2">
        <RowsContextMenu
          label="Thread actions"
          rowsFor={(id) => (id ? railMenu.rowsFor(id) : null)}
          onPick={(pick, id) => id && railMenu.onPick(id, pick)}
          onOpenChange={(open, id) => id && railMenu.onOpenChange(id, open)}
        >
        <RailRows
          count={items.length}
          rows={rowCount}
          scroller={scroller}
          estimateSize={estimateSize}
          getItemKey={getItemKey}
          render={(index) => entry(items[index])}
          reveal={reveal}
        />
        </RowsContextMenu>


      {dialog?.kind === "settings" && workspace ? (
        <ProjectSettingsDialog
          project={dialog.project}
          workspace={workspace}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "preamble" && workspace ? (
        <PreambleDialog
          scope={{ kind: "project", project: dialog.project, workspace }}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "teardown" ? (
        <ProjectTeardownDialog
          project={dialog.project}
          action={dialog.action}
          onClose={close}
          onDone={close}
        />
      ) : null}
      {dialog?.kind === "delete-project" ? (
        <ConfirmDialog
          title="Delete project"
          body={`${dialog.project.name} and its threads are deleted for good.`}
          confirmLabel="Delete"
          danger
          onCancel={close}
          onConfirm={async () => {
            await deleteProject(dialog.project.id);
            close();
          }}
        />
      ) : null}
      {threadMenu.dialogs}
    </div>
  );
}
