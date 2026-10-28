import { useHostsOffline } from "./hostOffline";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
  GitBranch,
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
import { agentSummaryParts, modelLabel, type AgentSummary } from "../lib/threads/agents";
import { AGENT_GLYPHS, THREAD_MENU_ICONS } from "../surfaces/threads/threadTypes";
import { TypeGlyph } from "../surfaces/threads/TypeGlyph";
import { STATUS_WORD, StatusMark, type ThreadState } from "../components/ui/status";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { useTruncated } from "../components/tip";
import { cn } from "../lib/cn";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import {
  cardTasks,
  pausedElapsed,
  projectCardStatus,
  projectRunAction,
  runningElapsed,
  stoppableThreads,
} from "../lib/projectCardModel";
import { SESSION_LIST_PAGE } from "../lib/sessionListWindow";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import {
  cardCounts,
  cardLines,
  groupUnread,
  nextPage,
  projectCardAriaLabel,
  rowState,
  type CardCount,
  type CardLine,
  type GroupMark,
  type MasterBlock,
  sessionItemIndex,
  sidebarItems,
  windowRows,
  type SidebarItem,
} from "../lib/sidebarRows";
import { duration } from "../lib/duration";
import { timeAgo } from "../lib/format";
import { useClock, useSlowClock } from "../lib/turnClock";
import { archive as archiveThread, interrupt, pause, resume } from "../lib/tcserver/commands";
import { dormantByType, dormantThreads, focusedTree, marksAtRest, threadStatus } from "../lib/threadStripModel";
import { deleteProject } from "../lib/tcserver/projects";
import { archiveLinked, projectHomeNow, renameLinked } from "../lib/projectHome";
import { sessionPrefetch } from "../lib/sessionPrefetch";
import { useSessionMetas } from "../lib/tcserver/store";
import { usePlanReady } from "../hooks/usePlanReady";
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
import { RAIL_SCROLL_MARGIN_PX, RailRows } from "./railRows";

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
  /** The element that scrolls the column (the sidebar's), as state: the
   *  list attaches to it the render it arrives. */
  scroller: HTMLElement | null;
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
  // Ended from the keyboard, focus goes to the row's More, which mounts
  // again in the same commit that removes the field; a blur leaves focus
  // where the person put it.
  const field = useRef<HTMLInputElement>(null);
  const byKey = useRef(false);
  useLayoutEffect(() => {
    const row = field.current?.closest<HTMLElement>("[data-thread-row], [data-project-row]") ?? null;
    return () => {
      if (!byKey.current || !row) return;
      queueMicrotask(() => row.querySelector<HTMLElement>('[aria-label="More"]')?.focus());
    };
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else onCancel();
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      byKey.current = !done.current;
      commit();
    }
    if (e.key === "Escape") {
      byKey.current = !done.current;
      done.current = true;
      onCancel();
    }
  };
  return (
    <Input
      ref={field}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      className={cn("h-auto rounded-md bg-background px-1.5 py-px leading-snug text-foreground", className)}
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
/** The rail's planning threads whose plan awaits its build (usePlanReady), by id. */
export const PlanReadyContext = createContext<Readonly<Record<string, boolean>>>({});

export function rowMark(row: ThreadRow, planReady = false): { state: ThreadState; label: string } {
  const state = rowState(row, planReady);
  const status = threadStatus({
    planReady,
    status: row.status,
    treeHasPaused: row.treeHasPaused,
    treeCanContinue: row.treeCanContinue,
    activity: row.activity,
    tasks: row.tasks,
    failure: row.failure,
    background: row.background,
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
  const { state, label } = rowMark(row, !!useContext(PlanReadyContext)[row.id]);
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
 * type's glyph in the lead column, so its title sits in the project name's
 * column) or a child one step in (a subagent or a batch thread, 28px, the
 * role's plain glyph or the type's tinted one before its title, what a
 * running one does after). It ends in its mark: the glyph alone, the word,
 * what it is about and a child's model on hover. Unread is weight on the title, never a dot.
 * Selection is a `muted` fill; nothing tints a paused row.
 */
export function ThreadRowView({
  row,
  selected = false,
  offline = false,
  child = false,
  word = false,
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
  const RoleGlyph = child && row.agentType ? AGENT_GLYPHS[row.agentType] : null;
  const live = child && row.running ? row.activity?.trim() : "";
  const editing = title != null;
  const planReady = !!useContext(PlanReadyContext)[row.id];
  const verdict = word && row.failure && rowState(row) === "failed" ? row.failure : null;
  const mark = rowMark(row, planReady);
  const shownTitle = row.title || (child && !row.masterId ? "Subagent" : "Untitled");
  // Hover and focus put More over the glyph, so the row itself says the
  // word and its detail: the pointer anywhere on it, or the keyboard on it.
  const state = !word && !editing && marksAtRest(mark.state) ? mark.label : null;
  // A subagent's model is said on hover, never at the row's end: a row ends in its glyph.
  const model = child && !editing && row.provider && row.model ? modelLabel(row.provider, row.model) : null;
  const detail =
    state && model ? (
      <span className="flex gap-2">
        <span>{state}</span>
        <span>{model}</span>
      </span>
    ) : (
      state ?? model
    );
  // A cut title is the row's one tooltip too: the whole title, the word under it.
  const { ref: titleRef, cut } = useTruncated(shownTitle);
  const tip =
    cut && !editing ? (
      <span className="flex flex-col text-left">
        <span>{shownTitle}</span>
        {detail ? <span className="font-normal text-background/60">{detail}</span> : null}
      </span>
    ) : (
      detail
    );
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
      {/* The lead column: a root's type glyph; under it a child's one step in. */}
      <span aria-hidden className="grid size-4 shrink-0 place-items-center">
        {child ? null : <TypeGlyph type={row.threadType} className="size-3" />}
      </span>
      {RoleGlyph ? (
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-muted-foreground">
          <RoleGlyph className="size-3" strokeWidth={1.5} />
        </span>
      ) : child && row.threadType ? (
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">
          <TypeGlyph type={row.threadType} className="size-3" />
        </span>
      ) : null}
      {editing ? (
        title
      ) : verdict ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span ref={titleRef} className="truncate">
            {shownTitle}
          </span>
          <span className="truncate text-[12px] text-muted-foreground">{verdict}</span>
        </span>
      ) : (
        <span ref={titleRef} className={cn("min-w-0 truncate", live ? "shrink" : "flex-1", row.unread && "font-medium text-foreground")}>
          {shownTitle}
        </span>
      )}
      {!editing ? (
        <>
          <HostGlyph environmentId={row.environmentId} />
          {live ? (
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" data-activity>
              {live}
            </span>
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
 * An archived project's row, presentational: the chevron, the name and,
 * for a live caller, one word at the end, the project's loudest state.
 * Its threads fold under it.
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

// --- project cards -----------------------------------------------------------

type CardMenu = { rows: () => readonly MenuRow[]; onPick: (id: string) => void };

/** A card line's 12px lead: the state's glyph, so titles one level down
 *  share one column whatever the mark; empty for an unread line. */
function LineMark({ state }: { state: ThreadState | null }) {
  return (
    <span aria-hidden className="grid size-3 shrink-0 place-items-center">
      {state && marksAtRest(state) ? <StatusMark state={state} word={false} className="[&_svg]:size-3" /> : null}
    </span>
  );
}

/** A line's type glyph: the thread's kind at 12px, muted. */
function LineGlyph({ thread }: { thread: ThreadRow }) {
  return <TypeGlyph type={thread.threadType} className="size-3" />;
}

const LINE = "flex h-6 min-w-0 items-center gap-2";
const LINE_TIME = "shrink-0 tabular-nums text-muted-foreground";
/** Elapsed shows from three seconds in, as at 303: a turn that ends at once never flashes a clock. */
const SHOWS_ELAPSED_MS = 3000;

/** An implementation thread's tally and current task, under its title. */
function TaskLine({ tasks, indent }: { tasks: NonNullable<ThreadRow["tasks"]>; indent: string }) {
  return (
    <span className={cn("flex h-4 min-w-0 items-center gap-2 text-muted-foreground", indent)}>
      <span className={cn("shrink-0 tabular-nums", tasks.done === tasks.total && "text-success")}>
        {tasks.done}/{tasks.total}
      </span>
      {tasks.current ? <span className="min-w-0 truncate">{tasks.current}</span> : null}
    </span>
  );
}

/** A thread's working subagents in the fleet's words, two spaces apart. */
function AgentsLine({ summary, indent }: { summary: AgentSummary; indent: string }) {
  return (
    <span className={cn("flex h-4 min-w-0 items-center gap-2 text-muted-foreground", indent)}>
      {agentSummaryParts(summary).map((part) => (
        <span key={part.text} className={cn("shrink-0 truncate", part.tone)}>
          {part.text}
        </span>
      ))}
    </span>
  );
}

/** One root's line: its mark, type glyph, title and host; at the end the
 *  elapsed while it works, Paused and the frozen elapsed while paused. */
function ThreadLine({ kind, thread, now }: { kind: "working" | "paused" | "unread"; thread: ThreadRow; now: number }) {
  const tasks = kind === "unread" ? null : cardTasks(thread);
  const ms = kind === "working" ? runningElapsed(thread, now) : 0;
  return (
    <span className="flex min-w-0 flex-col" data-card-line={kind}>
      <span className={LINE}>
        <LineMark state={kind === "unread" ? null : rowState(thread)} />
        <LineGlyph thread={thread} />
        <span className={cn("min-w-0 flex-1 truncate", kind === "unread" ? "font-medium text-foreground" : "text-muted-foreground")}>
          {thread.title || "Untitled"}
        </span>
        <HostGlyph environmentId={thread.environmentId} />
        {kind === "working" && now > 0 && ms >= SHOWS_ELAPSED_MS ? <span className={LINE_TIME}>{duration(ms)}</span> : null}
        {kind === "paused" ? (
          <span className="flex shrink-0 gap-2 text-muted-foreground">
            <span>Paused</span>
            <span className="tabular-nums">{duration(pausedElapsed(thread))}</span>
          </span>
        ) : null}
      </span>
      {tasks ? <TaskLine tasks={tasks} indent="pl-10" /> : null}
    </span>
  );
}

/** A master and its batch: its line with the batch's done tally, its own
 *  working subagents, each batch thread with something to say one step
 *  in, and the queued ones as one count. Settled batch threads are the tally. */
function MasterLines({ block, now }: { block: MasterBlock; now: number }) {
  const { master, unread, done, total } = block;
  return (
    <span className="flex min-w-0 flex-col" data-card-line="master">
      <span className={LINE}>
        <LineMark state={unread && !marksAtRest(block.state) ? null : block.state} />
        <LineGlyph thread={master} />
        <span className={cn("min-w-0 flex-1 truncate", unread ? "font-medium text-foreground" : "text-muted-foreground")}>
          {master.title || "Untitled"}
        </span>
        <HostGlyph environmentId={master.environmentId} />
        <span className={cn(LINE_TIME, done === total && "text-success")}>
          {done}/{total}
        </span>
      </span>
      {block.agents ? <AgentsLine summary={block.agents} indent="pl-10" /> : null}
      {block.lines.map(({ thread, state, agents }) => {
        const tasks = state === "working" ? cardTasks(thread) : null;
        const ms = state === "working" ? runningElapsed(thread, now) : 0;
        return (
          <span key={thread.id} className="flex min-w-0 flex-col pl-4">
            <span className={LINE}>
              <LineMark state={state} />
              <LineGlyph thread={thread} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{thread.title || "Untitled"}</span>
              <HostGlyph environmentId={thread.environmentId} />
              {tasks ? (
                <span className={cn(LINE_TIME, tasks.done === tasks.total && "text-success")}>
                  {tasks.done}/{tasks.total}
                </span>
              ) : state === "working" && now > 0 && ms >= SHOWS_ELAPSED_MS ? (
                <span className={LINE_TIME}>{duration(ms)}</span>
              ) : null}
            </span>
            {agents ? <AgentsLine summary={agents} indent="pl-10" /> : null}
          </span>
        );
      })}
      {block.queued > 0 ? (
        <span className={cn(LINE, "pl-4 text-muted-foreground")}>
          <LineMark state="queued" />
          <span>{block.queued} queued</span>
        </span>
      ) : null}
    </span>
  );
}

/** The count line's facts, two spaces apart: needs you in amber and failed
 *  in red with their glyphs, the rest muted. */
function CountLine({ counts }: { counts: readonly CardCount[] }) {
  return (
    <span className="mt-1 flex h-4 min-w-0 items-center gap-2 tabular-nums text-muted-foreground" data-card-counts>
      {counts.map((c) =>
        c.kind === "waiting" || c.kind === "failed" ? (
          <StatusMark key={c.kind} state={c.kind} word={c.text} className="shrink-0 font-normal [&_svg]:size-3" />
        ) : (
          <span key={c.kind} className="min-w-0 truncate">
            {c.text}
          </span>
        ),
      )}
    </span>
  );
}

export type ProjectCardViewProps = {
  name: string;
  branch: string | null | undefined;
  mode: ProjectMeta["mode"];
  /** Newest activity; 0 shows no time. */
  latest: number;
  /** The clock the time and the elapsed read; 0 before it has ticked. */
  now: number;
  lines: readonly CardLine[];
  /** Lines behind "N more". */
  hidden: number;
  counts: readonly CardCount[];
  ariaLabel: string;
  selected?: boolean;
  unread?: boolean;
  offline?: boolean;
  /** In place of the name: the rename field. */
  title?: ReactNode;
  onSelect?: () => void;
  onRename?: () => void;
  onMore?: () => void;
  /** The project's menu: its right-click and its ⋯ show the same rows. */
  menu?: CardMenu;
};

/**
 * A project card, presentational: the name and its last-active time, the
 * branch line, one read-only line per working, paused or unread thread (a
 * master's batch as a block), then the counts. The card is one button: a
 * click anywhere selects the project, and its lines never open a thread
 * (the strip above the pane is where threads are picked). ⋯ and "N more"
 * sit beside it, never inside.
 */
export function ProjectCardView({
  name,
  branch,
  mode,
  latest,
  now,
  lines,
  hidden,
  counts,
  ariaLabel,
  selected = false,
  unread = false,
  offline = false,
  title,
  onSelect,
  onRename,
  onMore,
  menu,
}: ProjectCardViewProps) {
  const editing = title != null;
  const ago = latest > 0 ? timeAgo(latest, now || Date.now()) : "";
  const body = (
    <>
      <span className="flex h-5 min-w-0 items-center gap-2">
        {editing ? (
          title
        ) : (
          <>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                unread && "font-medium",
                selected || unread ? "text-foreground" : "text-muted-foreground group-hover/row:text-foreground",
              )}
            >
              {name}
            </span>
            {ago ? <span className={cn("shrink-0 tabular-nums text-muted-foreground", menu && YIELDS)}>{ago}</span> : null}
          </>
        )}
      </span>
      <span className="mt-0.5 flex h-4 min-w-0 items-center gap-2 text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1">
          <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.5} />
          <span className="min-w-0 truncate">{branch ?? "local checkout"}</span>
        </span>
        <span className="shrink-0">{mode === "worktree" ? "worktree" : "local"}</span>
      </span>
      {lines.length ? (
        <span className="mt-1 flex min-w-0 flex-col">
          {lines.map((line) =>
            line.kind === "master" ? (
              <MasterLines key={line.id} block={line.block} now={now} />
            ) : (
              <ThreadLine key={line.id} kind={line.kind} thread={line.thread} now={now} />
            ),
          )}
        </span>
      ) : null}
      {counts.length ? <CountLine counts={counts} /> : null}
    </>
  );
  const box = cn(
    "flex w-full min-w-0 cursor-default flex-col rounded-lg px-3 py-2 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent",
    selected ? "bg-muted" : "hover:bg-foreground/5",
  );
  const card = (
    <div data-project-row data-host-offline={offline || undefined} className={cn("group/row relative", offline && "opacity-50")}>
      {editing ? (
        <div aria-current={selected || undefined} className={box}>
          {body}
        </div>
      ) : (
        <button
          type="button"
          aria-current={selected || undefined}
          aria-label={ariaLabel}
          data-project-card
          onClick={onSelect}
          onDoubleClick={onRename}
          className={box}
        >
          {body}
        </button>
      )}
      {menu && !editing ? (
        <RowsMenu
          label="Project actions"
          tip={{ label: "More", side: "right" }}
          trigger={moreTrigger("absolute top-1.5 right-2")}
          rows={menu.rows}
          onPick={menu.onPick}
          align="start"
        />
      ) : null}
      {hidden > 0 && onMore ? <MoreRow hidden={hidden} onMore={onMore} /> : null}
    </div>
  );
  return menu ? (
    <RowsContextMenu label="Project actions" lazyMount rowsFor={menu.rows} onPick={(pick) => menu.onPick(pick)}>
      {card}
    </RowsContextMenu>
  ) : (
    card
  );
}

/** A card's first-pass height: the two head lines and the padding, a line
 *  per thread with something to say (one page at most), the count line.
 *  The virtualizer measures the real card. */
export function estimateCard(group: ProjectGroup): number {
  const lines = group.threads.filter((t) => !t.housed && (t.unread || !!t.batch?.length || marksAtRest(rowState(t)))).length;
  const counts = group.threads.length === 0 || group.archivedCount > 0 || lines < group.threads.length;
  return 58 + 24 * Math.min(lines, SESSION_LIST_PAGE) + (counts ? 20 : 0);
}

type ProjectCardProps = {
  group: ProjectGroup;
  selected: boolean;
  /** The hosts of the project's copies, one per line: the card dims when none is reachable. */
  hosts: string;
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

/** A project's card, wired: its status over every root and batch thread,
 *  the clocks its lines need, its menu. A click selects the project
 *  (App's onSelectProjectCard); a double-click renames it in place. */
export const ProjectCard = memo(function ProjectCard({
  group,
  selected,
  hosts,
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
}: ProjectCardProps) {
  const { project, threads, latest, archivedCount } = group;
  const [renaming, setRenaming] = useState(false);
  const offline = useHostsOffline(hosts.split("\n"));
  const unread = useMemo(() => groupUnread(threads), [threads]);
  const status = projectCardStatus(cardThreads(threads), rows.activeSessionId ?? null, lastSeen, seenFloor);
  const all = cardLines(threads, status);
  const { shown, hidden } = windowRows(all, requested, null);
  // The second hand only while a shown line counts one; the time-ago on the half minute.
  const ticking = shown.some(
    (l) => (l.kind === "working" && l.thread.running) || (l.kind === "master" && l.block.lines.some((b) => b.state === "working")),
  );
  const fast = useClock(ticking);
  const slow = useSlowClock(!ticking && latest > 0);
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
      ...dormantByType(all).map((g): MenuRow => ({ kind: "item", id: `archive-dormant:${g.type}`, label: g.label, icon: THREAD_MENU_ICONS[g.type] })),
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
    <ProjectCardView
      name={project.name}
      branch={project.branch}
      mode={project.mode}
      latest={latest}
      now={fast || slow}
      lines={shown}
      hidden={hidden}
      counts={cardCounts(status, archivedCount)}
      ariaLabel={projectCardAriaLabel(project.name, status)}
      selected={selected}
      unread={unread}
      offline={offline}
      onSelect={() => selectProject(project.id)}
      onRename={() => setRenaming(true)}
      onMore={() => more(project.id)}
      menu={{ rows: menuRows, onPick: onMenuPick }}
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
 *  A card counts its lines and the chats section its first page. */
const estimateItem = (item: SidebarItem): number => {
  switch (item.kind) {
    case "project":
      return estimateCard(item.group);
    case "chats":
      return HEADING_PX + ROW_PX * Math.min(item.threads.length, SESSION_LIST_PAGE);
    case "archived":
      return HEADING_PX;
    case "empty":
      return ROW_PX;
  }
};

// --- root ------------------------------------------------------------------

/** What the column keeps across a remount (Settings unmounts it, Back mounts
 *  it again), per scope: where it was scrolled, how far each list was paged,
 *  whether Chats was open, and the project it last revealed. */
type ColumnMemory = { offset: number; pages: Pages; chatsOpen: boolean; revealed: string | null };
const columnMemory = new Map<string, ColumnMemory>();
const memoryOf = (scope: string): ColumnMemory => {
  let memory = columnMemory.get(scope);
  if (!memory) {
    memory = { offset: 0, pages: {}, chatsOpen: true, revealed: null };
    columnMemory.set(scope, memory);
  }
  return memory;
};
/** Tests start from a column that remembers nothing. */
export function forgetColumnMemory(): void {
  columnMemory.clear();
}

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
  scroller,
}: Props) {
  const metas = useSessionMetas();
  const planReady = usePlanReady(metas);
  const memory = memoryOf(workspaceId ?? "home");
  const { workspaces, projects } = useWorkspaceCatalog();
  // Each copy's host, for the card's offline tint: one string, so a
  // memoized card sees the same prop until a host changes.
  const hostsOf = useCallback(
    (group: ProjectGroup): string =>
      (group.projectIds ?? [group.project.id])
        .map((id) => projects.find((p) => p.id === id)?.environmentId ?? group.project.environmentId)
        .join("\n"),
    [projects],
  );
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
  const [chatsOpen, setChatsOpen] = useState(memory.chatsOpen);
  const [archived, setArchived] = useState<ArchivedState>({ open: false, shown: null });
  const [pages, setPages] = useState<Pages>(memory.pages);
  useEffect(() => {
    memory.chatsOpen = chatsOpen;
    memory.pages = pages;
  }, [chatsOpen, memory, pages]);
  // The offset follows the scroller, and comes back the render it arrives.
  // The list's first layout is its rows' estimates, which can fall short of
  // what they measure: an offset that clamps waits for the room, applied
  // again as the list grows, until it fits or the person scrolls.
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!scroller) return;
    let pending = false;
    let applied = 0;
    const restore = () => {
      scroller.scrollTop = memory.offset;
      applied = scroller.scrollTop;
      pending = applied < memory.offset;
      if (!pending) grow?.disconnect();
    };
    const grow =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => pending && restore());
    restore();
    if (pending && listRef.current) grow?.observe(listRef.current);
    const save = () => {
      // Our own restore's scroll is not a choice; any other scroll is the person's.
      if (pending && scroller.scrollTop === applied) return;
      pending = false;
      grow?.disconnect();
      memory.offset = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", save, { passive: true });
    return () => {
      grow?.disconnect();
      scroller.removeEventListener("scroll", save);
    };
  }, [memory, scroller]);
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

  // Cards are the list's unit (railRows.tsx, virtual once the chunk lands).
  // Every item is measured, so a card that grows a line pushes the ones
  // below it. (A fold's height animation is measured too: the root
  // re-renders per frame while a section opens or closes, and the memoized
  // cards sit that out.)
  const items = useMemo(
    () => sidebarItems(groups, workspaceId === null),
    [groups, workspaceId],
  );
  const estimateSize = useCallback((i: number) => estimateItem(items[i]), [items]);
  const getItemKey = useCallback((i: number) => items[i].key, [items]);
  const rowCount = useMemo(() => items.reduce((n, item) => n + estimateItem(item) / ROW_PX, 0), [items]);

  // Bring the selected card on screen once per selection: when it changes,
  // or as soon as the list fills after a boot that restored it. A meta push
  // re-sorting the cards must not scroll.
  const [reveal, setReveal] = useState<{ index: number } | null>(null);
  // A remount under the same selection keeps the remembered offset instead.
  useEffect(() => {
    if (!selectedProjectId || memory.revealed === selectedProjectId) return;
    const index = items.findIndex(
      (item) => item.kind === "project" && groupHolds(item.group, selectedProjectId),
    );
    if (index < 0) return;
    memory.revealed = selectedProjectId;
    setReveal({ index });
  }, [items, memory, selectedProjectId]);
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
          <ProjectCard
            group={item.group}
            selected={groupHolds(item.group, selectedProjectId)}
            hosts={hostsOf(item.group)}
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
    <PlanReadyContext.Provider value={planReady}>
    {/* The sidebar's element scrolls; this one only pads (pt-2 is the list's
    scroll margin). */}
    <div ref={listRef} className="px-2 pt-2 pb-2">
      {/* The menu's trigger is a DOM node: a component would drop its handler. */}
      <RowsContextMenu
        label="Thread actions"
        rowsFor={(id) => (id ? railMenu.rowsFor(id) : null)}
        onPick={(pick, id) => id && railMenu.onPick(id, pick)}
        onOpenChange={(open, id) => id && railMenu.onOpenChange(id, open)}
      >
        <div>
          <RailRows
            count={items.length}
            rows={rowCount}
            scroller={scroller}
            scrollMargin={RAIL_SCROLL_MARGIN_PX}
            initialOffset={memory.offset}
            estimateSize={estimateSize}
            getItemKey={getItemKey}
            render={(index) => entry(items[index])}
            reveal={reveal}
          />
        </div>
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
    </PlanReadyContext.Provider>
  );
}
