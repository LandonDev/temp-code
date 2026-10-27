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
  type TransitionEvent,
} from "react";
import { measureElement, useVirtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import { ExplorerMenu, type ExplorerMenuItem } from "./ExplorerMenu";
import { HostGlyph } from "./HostGlyph";
import { PreambleDialog } from "./PreambleDialog";
import {
  ArchiveRestore,
  ChevronRight,
  GitBranch,
  MoreHorizontal,
  Pause,
  Plus,
  Trash2,
} from "./icons";
import {
  ConfirmDialog,
  ProjectSettingsDialog,
  ProjectTeardownDialog,
} from "./ProjectDialogs";
import { duration, timeAgo } from "../lib/format";
import { agentSummaryParts, modelLabel, type AgentSummary } from "../lib/threads/agents";
import { AGENT_GLYPHS, THREAD_GLYPHS, THREAD_TINTS } from "../surfaces/threads/threadTypes";
import { MatrixSpinner } from "../surfaces/threads/spinners";
import { STATUS_WORD, StatusMark, type ThreadState } from "../components/ui/status";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import {
  cardTasks,
  cardTooltip,
  pausedElapsed,
  projectCardStatus,
  projectRunAction,
  quietSummary,
  runningElapsed,
  stoppableThreads,
  type CardThread,
} from "../lib/projectCardModel";
import { SESSION_LIST_PAGE } from "../lib/sessionListWindow";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import {
  liveLines,
  type BatchLine,
  type MasterBlock,
  nextPage,
  rowState,
  sessionItemIndex,
  sidebarItems,
  windowRows,
  type SidebarItem,
} from "../lib/sidebarRows";
import { archive as archiveThread, interrupt, pause, resume, setMaster } from "../lib/tcserver/commands";
import { masterMenuLabel, useMasterIds } from "../lib/masterThread";
import { dormantByType, dormantThreads, focusedTree, marksAtRest, threadStatus } from "../lib/threadStripModel";
import { deleteProject } from "../lib/tcserver/projects";
import { archiveLinked, projectHomeNow, renameLinked } from "../lib/projectHome";
import { sessionPrefetch } from "../lib/sessionPrefetch";
import { useSessionMetas } from "../lib/tcserver/store";
import { useClock, useSlowClock } from "../lib/turnClock";
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
  | { kind: "delete-project"; project: ProjectMeta }
  | { kind: "delete-chat"; thread: ThreadRow };

type MenuState = {
  x: number;
  y: number;
  items: ExplorerMenuItem[];
  onPick: (id: string) => void;
};

const MENU_WIDTH = 228;

// --- clocks ---------------------------------------------------------------

/** "3m" since `at`, refreshed every half minute. Only this span re-renders on the tick. */
function Ago({ at }: { at: number }) {
  const now = useSlowClock(true);
  return <>{timeAgo(at, now)}</>;
}

// --- small parts -----------------------------------------------------------

/** The grid transition in index.css runs 200 ms; a closed fold with no
 *  transition (reduced motion) still empties itself after this long. */
const FOLD_MS = 240;

/** A collapsing section. Its children mount when it opens and unmount once
 *  the closing transition has run, so a closed fold holds no DOM at all. */
export function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), FOLD_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);
  const onEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (!open && e.target === e.currentTarget && e.propertyName === "grid-template-rows")
      setMounted(false);
  };
  return (
    <div className="ws-fold" data-open={open} onTransitionEnd={onEnd}>
      <div inert={!open}>{mounted ? children : null}</div>
    </div>
  );
}

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

function Stat({
  dot,
  tint,
  pulse,
  count,
  word,
}: {
  dot: string;
  tint: string;
  pulse?: boolean;
  count: number;
  word: string;
}) {
  return (
    <span className={`flex shrink-0 items-center gap-1 ${tint}`}>
      <span
        className={`size-1.5 rounded-full ${dot} ${pulse ? "motion-safe:animate-pulse" : ""}`}
      />
      {count} {word}
    </span>
  );
}

/** A row's one hover action: ⋯, the same menu a right-click opens. It
 *  takes the trailing slot's place by opacity, as the rail's rows do. */
function MoreAction({ onOpen, className }: { onOpen: (anchor: HTMLElement) => void; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="More"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(e.currentTarget);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              "pointer-events-none opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
              "group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100",
              className,
            )}
          />
        }
      >
        <MoreHorizontal className="size-4" strokeWidth={1.5} />
      </TooltipTrigger>
      <TooltipContent side="right">More</TooltipContent>
    </Tooltip>
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

const menuAt = (anchor: HTMLElement) => {
  const rect = anchor.getBoundingClientRect();
  return { x: Math.max(8, rect.right - MENU_WIDTH), y: rect.bottom + 4 };
};

// --- rows ------------------------------------------------------------------

type RowActions = {
  activeSessionId?: string;
  /** The focused session's root and children: "Archive dormant" spares them. */
  focusedTree: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (thread: ThreadRow) => void;
  openMenu: (state: MenuState) => void;
  /** The master threads (CLAUDE.md "Master threads"), any number per project. */
  masterIds?: ReadonlySet<string>;
};

/** The rail row's pin item: a root thread in a project may be made a
 *  master, and a master may stop being one. */
export function masterMenuItem(
  thread: Pick<ThreadRow, "id" | "projectId">,
  masterIds: ReadonlySet<string> | undefined,
): ExplorerMenuItem | null {
  if (!thread.projectId) return null;
  return { kind: "item", id: "master", label: masterMenuLabel(!!masterIds?.has(thread.id)) };
}

/** Row sizes come from the ResizeObserver, which reports every row once on
 *  observe and again when it grows: a row mounting under a switch keeps its
 *  cached or estimated size instead of reading a rect, which would force a
 *  layout per new row before the paint. */
const measureRow: VirtualizerOptions<HTMLDivElement, HTMLDivElement>["measureElement"] = (
  node,
  entry,
  instance,
) => {
  if (entry) return measureElement(node, entry, instance);
  const index = instance.indexFromElement(node);
  return instance.measurementsCache[index]?.size ?? instance.options.estimateSize(index);
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

/** The mark at a row's end: the glyph alone with its word and detail on
 *  hover, or the glyph and its word (`word`, the popover's rows). Nothing
 *  on a settled row. */
function RowMark({ row, word }: { row: ThreadRow; word?: boolean }) {
  const { state, label } = rowMark(row);
  if (!marksAtRest(state)) return null;
  if (word) return <StatusMark state={state} className="shrink-0" />;
  return (
    <Tooltip>
      <TooltipTrigger render={<StatusMark state={state} word={false} aria-label={label} />} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
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
  fold,
  title,
  onOpen,
  onMenu,
  onRename,
}: {
  row: ThreadRow;
  selected?: boolean;
  offline?: boolean;
  child?: boolean;
  /** The mark with its word (the popover, where the width allows it). */
  word?: boolean;
  fold?: Fold;
  /** In place of the title: the rename field. */
  title?: ReactNode;
  onOpen?: () => void;
  /** A right-click or ⋯ opens the row's menu at this point. */
  onMenu?: (at: { x: number; y: number }) => void;
  onRename?: () => void;
}) {
  const tally = batchTally(row);
  const Glyph = child ? (row.agentType ? AGENT_GLYPHS[row.agentType] : row.threadType ? THREAD_GLYPHS[row.threadType] : null) : null;
  const live = child && row.running ? row.activity?.trim() : "";
  const editing = title != null;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      data-host-offline={offline || undefined}
      onClick={() => !editing && onOpen?.()}
      onPointerEnter={() => sessionPrefetch.enter(row.id)}
      onPointerLeave={() => sessionPrefetch.leave(row.id)}
      onDoubleClick={onRename}
      onKeyDown={(e) => e.key === "Enter" && !editing && onOpen?.()}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
      className={cn(
        ROW,
        child ? "h-7" : "h-8",
        selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        offline && "opacity-50",
      )}
    >
      <span aria-hidden className="size-4 shrink-0" />
      {Glyph ? (
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-muted-foreground">
          <Glyph className="size-3" strokeWidth={1.5} />
        </span>
      ) : null}
      {editing ? (
        title
      ) : (
        <span className={cn("min-w-0 flex-1 truncate", row.unread && "font-medium text-foreground")}>
          {row.title || (child && !row.masterId ? "Subagent" : "Untitled")}
        </span>
      )}
      {!editing ? (
        <>
          <HostGlyph environmentId={row.environmentId} />
          {live ? (
            <span className="max-w-[45%] shrink-0 truncate text-[12px] text-muted-foreground" data-activity>
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
          <span className={cn("flex shrink-0 items-center gap-2", onMenu && YIELDS)}>
            {tally ? (
              <span className={cn("text-[12px] tabular-nums", tally.done === tally.total ? "text-success" : "text-muted-foreground")}>
                {tally.done}/{tally.total}
              </span>
            ) : null}
            <span className={cn("grid shrink-0 place-items-center", word ? "min-w-4" : "size-4")}>
              <RowMark row={row} word={word} />
            </span>
          </span>
          {onMenu ? (
            <MoreAction
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onOpen={(el) => onMenu(menuAt(el))}
            />
          ) : null}
        </>
      ) : null}
    </div>
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
  const [renaming, setRenaming] = useState(false);
  const offline = useHostsOffline([thread.environmentId]);

  const menu = (at: { x: number; y: number }) => {
    const master = masterMenuItem(thread, actions.masterIds);
    const items: ExplorerMenuItem[] = [
      { kind: "item", id: "rename", label: "Rename" },
      ...(thread.running
        ? [{ kind: "item", id: "stop", label: "Stop" } as const]
        : thread.stopped
          ? [{ kind: "item", id: "resume", label: "Resume" } as const]
          : []),
      ...(master ? [{ kind: "sep" } as const, master] : []),
      { kind: "sep" },
      { kind: "item", id: "delete", label: "Delete chat", danger: true },
    ];
    actions.openMenu({
      ...at,
      items,
      onPick: (id) => {
        if (id === "rename") setRenaming(true);
        else if (id === "stop") void interrupt(thread.id);
        else if (id === "resume") void resume(thread.id);
        else if (id === "master") void setMaster(thread.id, !actions.masterIds?.has(thread.id));
        else if (id === "delete") actions.onDelete(thread);
      },
    });
  };

  return (
    <ThreadRowView
      row={thread}
      selected={thread.id === actions.activeSessionId}
      offline={offline}
      fold={fold}
      onOpen={() => actions.onOpen(thread.id)}
      onMenu={menu}
      onRename={() => setRenaming(true)}
      title={
        renaming ? (
          <InlineRename
            value={thread.title}
            className="text-[13px]"
            onCommit={(t) => {
              setRenaming(false);
              actions.onRename(thread.id, t);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : undefined
      }
    />
  );
});

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

type Tasks = NonNullable<CardThread["tasks"]>;

/** An implementation thread's tally and current task, one step in. */
export function TaskLine({ tasks, paused }: { tasks: Tasks; paused?: boolean }) {
  const tally = paused
    ? "text-warning"
    : tasks.done === tasks.total
      ? "text-success"
      : "text-content/70";
  return (
    <div className="flex items-center gap-1.5 pl-3 text-[11px] leading-4">
      <span
        className={`shrink-0 text-[11px] tabular-nums ${tally}`}
        title={`${tasks.done} of ${tasks.total} tasks done`}
      >
        {tasks.done}/{tasks.total}
      </span>
      {tasks.current ? (
        <span className={`truncate ${paused ? "text-warning/70" : "text-content/40"}`}>
          {tasks.current}
        </span>
      ) : null}
    </div>
  );
}

export function ThreadGlyph({ thread }: { thread: ThreadRow }) {
  const type = thread.threadType ?? "chat";
  const Glyph = THREAD_GLYPHS[type];
  return <Glyph className={`size-3 shrink-0 ${THREAD_TINTS[type]}`} strokeWidth={1.75} />;
}

type LiveStatus = ReturnType<typeof projectCardStatus<ThreadRow>>;

/** The Sessions tab's card reads these lines, never clicks them ("the
 *  strip above the pane is where the threads live"). A caller that wants
 *  a row to jump straight to its thread (the rail's popover) passes
 *  `onSelect`; the row becomes a button instead of a div, same layout. */
export function RowShell({
  onSelect,
  className,
  title,
  children,
}: {
  onSelect?: () => void;
  className: string;
  title?: string;
  children: ReactNode;
}) {
  if (onSelect) {
    return (
      <button
        type="button"
        title={title}
        onClick={onSelect}
        className={`${className} cursor-default text-left hover:bg-content/5`}
      >
        {children}
      </button>
    );
  }
  return (
    <div className={className} title={title}>
      {children}
    </div>
  );
}

function RunningLine({
  thread: t,
  now,
  onSelect,
}: {
  thread: ThreadRow;
  now: number;
  onSelect?: (id: string) => void;
}) {
  const ms = runningElapsed(t, now);
  const tasks = cardTasks(t);
  return (
    <RowShell
      className="w-full py-1"
      title={t.activity ?? undefined}
      onSelect={onSelect ? () => onSelect(t.id) : undefined}
    >
      <div className="flex w-full items-center gap-1.5 text-[11px] leading-4">
        <MatrixSpinner cell={1.8} tint={t.activityKind} />
        <ThreadGlyph thread={t} />
        <span className="min-w-0 flex-1 truncate text-content/50">
          {t.title || "Untitled"}
        </span>
        <span
          className={`shrink-0 text-[11px] whitespace-nowrap tabular-nums text-content/40 ${ms < 3000 ? "opacity-0" : ""}`}
        >
          {duration(ms)}
        </span>
      </div>
      {tasks ? <TaskLine tasks={tasks} /> : null}
    </RowShell>
  );
}

function PausedLine({
  thread: t,
  onSelect,
}: {
  thread: ThreadRow;
  onSelect?: (id: string) => void;
}) {
  const tasks = cardTasks(t);
  return (
    <RowShell
      className="w-full bg-warning/5 py-1"
      onSelect={onSelect ? () => onSelect(t.id) : undefined}
    >
      <div className="flex w-full items-center gap-1.5 text-[11px] leading-4 text-warning">
        <Pause className="size-3 shrink-0 fill-current" strokeWidth={1.75} />
        <ThreadGlyph thread={t} />
        <span className="min-w-0 flex-1 truncate">{t.title || "Untitled"}</span>
        <span className="shrink-0 font-medium">Paused</span>
        <span className="shrink-0 text-[11px] tabular-nums text-current/70">
          {duration(pausedElapsed(t))}
        </span>
      </div>
      {tasks ? <TaskLine tasks={tasks} paused /> : null}
    </RowShell>
  );
}

function UnreadLine({
  thread: t,
  onSelect,
}: {
  thread: ThreadRow;
  onSelect?: (id: string) => void;
}) {
  return (
    <RowShell
      className="flex w-full items-center gap-1.5 py-1 text-[11px] leading-4"
      onSelect={onSelect ? () => onSelect(t.id) : undefined}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-info" />
      <ThreadGlyph thread={t} />
      <span className="min-w-0 flex-1 truncate font-medium text-content">
        {t.title || "Untitled"}
      </span>
    </RowShell>
  );
}

/** A line's lead mark in a 16px box, so titles one level down share one
 *  column whatever the mark; nothing for a settled line. */
function LineMark({ state }: { state: ThreadState }) {
  return (
    <span className="grid size-4 shrink-0 place-items-center">
      {marksAtRest(state) ? <StatusMark state={state} word={false} /> : null}
    </span>
  );
}

/** A thread's working subagents, one quiet line aligned with its title, in
 *  the fleet's words and tones (2 agents · 1 working · 1 needs approval). */
function AgentsLine({ summary, indent }: { summary: AgentSummary; indent: string }) {
  return (
    <div className={`flex min-w-0 items-center gap-1 py-0.5 ${indent} text-[11px] leading-4 text-content/40`}>
      {agentSummaryParts(summary).map((part, i) => (
        <span key={part.text} className={`shrink-0 truncate ${part.tone ?? ""}`}>
          {i > 0 ? "· " : ""}
          {part.text}
        </span>
      ))}
    </div>
  );
}

/** A batch thread one step under its master: its mark under the master's
 *  glyph, title, then what it waits on (Needs you, Failed) or, while it
 *  works, its task tally or elapsed; its working subagents under its title. */
function BatchThreadLine({
  line: { thread: t, state, agents },
  now,
  onSelect,
}: {
  line: BatchLine;
  now: number;
  onSelect?: (id: string) => void;
}) {
  const tasks = cardTasks(t);
  const ms = runningElapsed(t, now);
  return (
    <>
      <RowShell
        className="flex w-full items-center gap-1.5 py-0.5 pl-[18px] text-[11px] leading-4"
        title={state === "failed" ? (t.failure ?? undefined) : (t.activity ?? undefined)}
        onSelect={onSelect ? () => onSelect(t.id) : undefined}
      >
        <LineMark state={state} />
        <ThreadGlyph thread={t} />
        <span
          className={`min-w-0 flex-1 truncate ${state === "paused" ? "text-warning" : state === "stopped" ? "text-content/40" : "text-content/60"}`}
        >
          {t.title || "Untitled"}
        </span>
        <HostGlyph environmentId={t.environmentId} />
        {state === "waiting" ? (
          <span className="shrink-0 font-medium text-warning">Needs you</span>
        ) : state === "failed" ? (
          <span className="shrink-0 font-medium text-danger">Failed</span>
        ) : state === "working" && tasks ? (
          <span className="shrink-0 tabular-nums text-content/40" title={`${tasks.done} of ${tasks.total} tasks done`}>
            {tasks.done}/{tasks.total}
          </span>
        ) : state === "working" ? (
          <span className={`shrink-0 whitespace-nowrap tabular-nums text-content/40 ${ms < 3000 ? "opacity-0" : ""}`}>
            {duration(ms)}
          </span>
        ) : null}
      </RowShell>
      {agents ? <AgentsLine summary={agents} indent="pl-[54px]" /> : null}
    </>
  );
}

/** A master and its batch as one line of the card: the master's own line
 *  with the batch's done tally, its own working subagents under its title,
 *  then each batch thread with something to say one step in, loudest
 *  first, and the queued ones as one quiet count. Settled batch threads
 *  are the tally; nothing inside a master is ever unread. */
function MasterLines({
  block,
  now,
  onSelect,
}: {
  block: MasterBlock;
  now: number;
  onSelect?: (id: string) => void;
}) {
  const { master, state, unread, done, total } = block;
  return (
    <div className="flex w-full flex-col py-0.5">
      <RowShell
        className="flex w-full items-center gap-1.5 py-0.5 text-[11px] leading-4"
        title={master.activity ?? undefined}
        onSelect={onSelect ? () => onSelect(master.id) : undefined}
      >
        <LineMark state={state} />
        <ThreadGlyph thread={master} />
        <span
          className={`min-w-0 flex-1 truncate ${
            unread ? "font-medium text-content" : state === "paused" ? "text-warning" : "text-content/70"
          }`}
        >
          {master.title || "Untitled"}
        </span>
        {state === "waiting" ? (
          <span className="shrink-0 font-medium text-warning">Needs you</span>
        ) : state === "failed" ? (
          <span className="shrink-0 font-medium text-danger">Failed</span>
        ) : null}
        <span
          className={`shrink-0 tabular-nums ${done === total ? "text-success" : "text-content/40"}`}
          title={`${done} of ${total} ${total === 1 ? "thread" : "threads"} done`}
        >
          {done}/{total}
        </span>
      </RowShell>
      {block.agents ? <AgentsLine summary={block.agents} indent="pl-9" /> : null}
      {block.lines.map((line) => (
        <BatchThreadLine key={line.thread.id} line={line} now={now} onSelect={onSelect} />
      ))}
      {block.queued > 0 ? (
        <div className="flex items-center gap-1.5 py-0.5 pl-[18px] text-[11px] leading-4 text-content/40">
          <LineMark state="queued" />
          {block.queued} queued
        </div>
      ) : null}
    </div>
  );
}

/** One line per live-or-unseen thread, status leading the eye: tinted
 *  spinner (or the blue unread dot) up front, title, elapsed at the end.
 *  A paused line freezes its elapsed where the pause left it. Only a card
 *  with a running line subscribes to the second hand. A card prints one
 *  page of lines (`sessionListWindow`) and a "more" row for the rest.
 *  `onSelectThread`: opt a caller's rows into jumping to their thread on
 *  click (the Sessions tab's own card leaves this unset by design). */
export function LiveLines({
  status,
  roots,
  activeId,
  requested = SESSION_LIST_PAGE,
  onMore,
  onSelectThread,
}: {
  status: LiveStatus;
  /** The card's root rows: a master among them prints as a block with its
   *  batch under it (`MasterLines`). */
  roots?: readonly ThreadRow[];
  activeId: string | null;
  requested?: number;
  onMore?: () => void;
  onSelectThread?: (id: string) => void;
}) {
  const now = useClock(status.running.length > 0);
  const { shown, hidden } = windowRows(liveLines(status, roots), requested, activeId);
  if (!shown.length) return null;
  return (
    <div className="w-full divide-y divide-content/10 border-y border-content/10">
      {shown.map((line) =>
        line.kind === "master" ? (
          <MasterLines key={line.id} block={line.block} now={now} onSelect={onSelectThread} />
        ) : line.kind === "running" ? (
          <RunningLine key={line.id} thread={line.thread} now={now} onSelect={onSelectThread} />
        ) : line.kind === "paused" ? (
          <PausedLine key={line.id} thread={line.thread} onSelect={onSelectThread} />
        ) : (
          <UnreadLine key={line.id} thread={line.thread} onSelect={onSelectThread} />
        ),
      )}
      {hidden > 0 && onMore ? (
        <div className="py-1">
          <MoreRow hidden={hidden} onMore={onMore} />
        </div>
      ) : null}
    </div>
  );
}

// --- project card ----------------------------------------------------------

type CardProps = {
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

/** temp-code's project card: always the summary, never a thread list. The
 *  strip above the pane is where the threads live; this card only says how
 *  the project is doing and selects it the moment the pointer lands. */
const ProjectCard = memo(function ProjectCard({
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
}: CardProps) {
  const { project, threads, latest, archivedCount } = group;
  const onSelect = () => selectProject(project.id);
  const onNewChat = () => newChat(project.id);
  const onRename = (name: string) => renameTo(project.id, name);
  const onSettings = () => openSettings(project);
  const onPreamble = () => openPreamble(project);
  const onArchive = () => archive(project);
  const onDelete = () => remove(project);
  const onMore = () => more(project.id);
  const [renaming, setRenaming] = useState(false);
  const status = projectCardStatus(cardThreads(threads), rows.activeSessionId ?? null, lastSeen, seenFloor);
  const runAction = projectRunAction(status);
  const stoppable = stoppableThreads(status);
  const teardown = project.mode === "worktree" && Boolean(project.branch);
  const dormant = dormantThreads(threads, lastSeen, seenFloor, rows.focusedTree);
  const dormantGroups = dormantByType(dormant);
  const showSummary =
    status.waiting > 0 ||
    status.failed > 0 ||
    status.paused.length > 0 ||
    status.dormant > 0 ||
    archivedCount > 0 ||
    threads.length === 0;

  const menu = (at: { x: number; y: number }) => {
    const items: ExplorerMenuItem[] = [
      { kind: "item", id: "chat", label: "New chat" },
      { kind: "item", id: "rename", label: "Rename" },
      { kind: "item", id: "settings", label: "Project settings" },
      { kind: "item", id: "preamble", label: "Preamble…" },
    ];
    if (runAction === "resume")
      items.push({ kind: "item", id: "resume", label: "Continue paused threads" });
    else if (runAction === "pause")
      items.push({ kind: "item", id: "pause", label: "Pause active threads" });
    if (stoppable.length)
      items.push(
        { kind: "item", id: "stop", label: "Stop active threads", danger: true },
        { kind: "sep" },
      );
    items.push(
      {
        kind: "item",
        id: "archive-dormant",
        label:
          dormant.length > 0
            ? `Archive ${dormant.length} dormant thread${dormant.length === 1 ? "" : "s"}`
            : "Archive dormant threads",
        disabled: dormant.length === 0,
      },
      ...dormantGroups.map(
        (g): ExplorerMenuItem => ({ kind: "item", id: `archive-dormant:${g.type}`, label: g.label }),
      ),
      {
        kind: "item",
        id: "archive",
        label: teardown ? "Archive project…" : "Archive project",
      },
      { kind: "sep" },
      { kind: "item", id: "delete", label: "Delete project…", danger: true },
    );
    rows.openMenu({
      ...at,
      items,
      onPick: (id) => {
        if (id === "chat") onNewChat();
        else if (id === "rename") setRenaming(true);
        else if (id === "settings") onSettings();
        else if (id === "preamble") onPreamble();
        else if (id === "resume")
          void Promise.allSettled(status.paused.map((t) => resume(t.id)));
        else if (id === "pause")
          void Promise.allSettled(status.running.map((t) => pause(t.id)));
        else if (id === "stop")
          void Promise.allSettled(stoppable.map((t) => interrupt(t.id)));
        else if (id === "archive-dormant")
          void Promise.allSettled(dormant.map((t) => archiveThread(t.id, true)));
        else if (id.startsWith("archive-dormant:"))
          void Promise.allSettled(
            (dormantGroups.find((g) => g.type === id.slice("archive-dormant:".length))?.threads ?? [])
              .map((t) => archiveThread(t.id, true)),
          );
        else if (id === "archive") onArchive();
        else if (id === "delete") onDelete();
      },
    });
  };

  return (
    <section
      aria-current={selected || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY });
      }}
      className="group/row relative rounded-md border border-content/10"
    >
      <div
        role="button"
        tabIndex={0}
        title={cardTooltip(status, archivedCount)}
        onPointerDown={() => !renaming && !selected && onSelect()}
        onKeyDown={(e) => e.key === "Enter" && !renaming && onSelect()}
        onDoubleClick={() => setRenaming(true)}
        className={`relative flex w-full cursor-default flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors ${
          selected ? "bg-content/10" : "hover:bg-content/5"
        }`}
      >
        <div className="flex w-full items-center gap-2">
          {renaming ? (
            <InlineRename
              value={project.name}
              className="text-[13px]"
              onCommit={(n) => {
                setRenaming(false);
                onRename(n);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <>
              <span
                className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${
                  selected ? "text-content" : "text-content/70"
                }`}
              >
                {project.name}
              </span>
              {latest > 0 ? (
                <span className="shrink-0 text-[11px] tabular-nums text-content/40 group-hover/row:opacity-0">
                  <Ago at={latest} />
                </span>
              ) : null}
            </>
          )}
        </div>

        <div className="flex w-full items-center gap-1 text-[11px] leading-4 text-content/50">
          <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{project.branch ?? "local checkout"}</span>
          <span className="shrink-0 text-content/40">
            · {project.mode === "worktree" ? "worktree" : "local"}
          </span>
        </div>

        <LiveLines
          status={status}
          roots={threads}
          activeId={rows.activeSessionId ?? null}
          requested={requested}
          onMore={onMore}
        />

        {showSummary ? (
          <div className="flex w-full items-center gap-2 text-[11px] leading-4 tabular-nums">
            {status.waiting > 0 ? (
              <Stat dot="bg-warning" tint="text-warning" pulse count={status.waiting} word="need you" />
            ) : null}
            {status.failed > 0 ? (
              <Stat dot="bg-danger" tint="text-danger" count={status.failed} word="failed" />
            ) : null}
            {status.paused.length > 0 ? (
              <span className="flex shrink-0 items-center gap-1 text-warning">
                <Pause className="size-3 fill-current" strokeWidth={1.75} />
                {status.paused.length} paused
              </span>
            ) : null}
            <span className="truncate text-content/40">
              {quietSummary(status, archivedCount)}
            </span>
          </div>
        ) : null}
      </div>
      {!renaming ? (
        <MoreAction
          className="absolute top-1.5 right-1"
          onOpen={(el) => menu(menuAt(el))}
        />
      ) : null}
    </section>
  );
});

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
  const setOpen = (update: (o: boolean) => boolean) =>
    setState((prev) => ({ ...prev, open: update(prev.open) }));
  const setShown = (update: (s: string | null) => string | null) =>
    setState((prev) => ({ ...prev, shown: update(prev.shown) }));
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="pressable flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase tabular-nums hover:text-content"
      >
        <ChevronRight
          className={`size-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          strokeWidth={2}
        />
        Archived · {groups.length}
      </button>
      <Fold open={open}>
        <div className="flex flex-col gap-px">
          {groups.map(({ project, threads }) => (
            <div key={project.id}>
              <div className="group/arch relative flex h-7 items-center gap-2 rounded-md px-2 transition-colors hover:bg-content/5">
                <button
                  type="button"
                  onClick={() =>
                    setShown((s) => (s === project.id ? null : project.id))
                  }
                  className="min-w-0 flex-1 truncate text-left text-[13px] text-content/70"
                >
                  {project.name}
                </button>
                <span className="text-[11px] tabular-nums text-content/40 group-hover/arch:opacity-0">
                  {threads.length}
                </span>
                <div className="absolute inset-y-0 right-0.5 flex items-center gap-0.5 opacity-0 group-hover/arch:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    aria-label="Restore"
                    onClick={() => onRestore(project)}
                    className="pressable flex size-6 items-center justify-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
                  >
                    <ArchiveRestore className="size-3.5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete"
                    onClick={() => onDelete(project)}
                    className="pressable flex size-6 items-center justify-center rounded-md text-content/50 hover:bg-danger/15 hover:text-danger"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              </div>
              <Fold open={shown === project.id}>
                <ThreadList
                  threads={threads}
                  actions={rows}
                  requested={pageOf(pages, `archived:${project.id}`)}
                  onMore={() => onMore(`archived:${project.id}`)}
                  className="flex flex-col gap-px pl-2"
                />
              </Fold>
            </div>
          ))}
        </div>
      </Fold>
    </div>
  );
});

/** The loose chats under the cards, folded as one. */
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
    <div>
      <div className="group/chats flex h-7 items-center gap-1 pl-2 pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="pressable flex h-7 min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase hover:text-content"
        >
          <ChevronRight
            className={`size-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            strokeWidth={2}
          />
          Chats
        </button>
        <button
          type="button"
          aria-label="New chat"
          onClick={() => onNewChat(null)}
          className="pressable flex size-6 items-center justify-center rounded-md text-content/50 opacity-0 group-hover/chats:opacity-100 hover:bg-content/10 hover:text-content focus:opacity-100"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <Fold open={open}>
        <ThreadList
          threads={threads}
          actions={rows}
          requested={requested}
          onMore={onMore}
          className="flex flex-col gap-px"
        />
      </Fold>
    </div>
  );
});

const ROW_PX = 28;

/** Heights for the virtualizer's first pass; every item is then measured.
 *  The chats section opens by default, so it counts its first page. */
const estimateItem = (item: SidebarItem): number => {
  switch (item.kind) {
    case "project":
      return 72;
    case "chats":
      return 24 + ROW_PX * Math.min(item.threads.length, SESSION_LIST_PAGE);
    case "archived":
      return 24;
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
  const [menu, setMenu] = useState<MenuState | null>(null);
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
  const latest = useRef({ onSelectProject, onOpenSession, onNewChat, onRenameSession });
  latest.current = { onSelectProject, onOpenSession, onNewChat, onRenameSession };
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
  const masterIds = useMasterIds();
  const rows = useMemo<RowActions>(
    () => ({
      activeSessionId,
      focusedTree: focused,
      onOpen: openSession,
      onRename: renameSession,
      onDelete: (thread) => setDialog({ kind: "delete-chat", thread }),
      openMenu: setMenu,
      masterIds,
    }),
    [activeSessionId, focused, openSession, renameSession, masterIds],
  );

  // Cards are the virtual unit: each roots its own border and hover group,
  // and the shared ActivePill lives inside one. Every item is measured, so
  // a card that grows a live line pushes the ones below it. (A fold's
  // height animation is measured too: the root re-renders per frame while
  // a section opens or closes, and the memoized cards sit that out.)
  const items = useMemo(
    () => sidebarItems(groups, workspaceId === null),
    [groups, workspaceId],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const estimateSize = useCallback((i: number) => estimateItem(items[i]), [items]);
  const getItemKey = useCallback((i: number) => items[i].key, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize,
    getItemKey,
    overscan: 4,
    gap: 8,
    measureElement: measureRow,
  });

  // Bring the selected card on screen once per selection: when it changes,
  // or as soon as the list fills after a boot that restored it. A meta push
  // re-sorting the cards must not scroll.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedProjectId || revealed.current === selectedProjectId) return;
    const index = items.findIndex(
      (item) => item.kind === "project" && groupHolds(item.group, selectedProjectId),
    );
    if (index < 0) return;
    revealed.current = selectedProjectId;
    virtualizer.scrollToIndex(index, { align: "auto" });
  }, [items, selectedProjectId, virtualizer]);
  const revealedSession = useRef(activeSessionId);
  useEffect(() => {
    if (!activeSessionId || revealedSession.current === activeSessionId) return;
    const index = sessionItemIndex(items, activeSessionId);
    if (index < 0) return;
    revealedSession.current = activeSessionId;
    virtualizer.scrollToIndex(index, { align: "auto" });
  }, [activeSessionId, items, virtualizer]);

  const entry = (item: SidebarItem): ReactNode => {
    switch (item.kind) {
      case "project":
        return (
          <ProjectCard
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
          <button
            type="button"
            onClick={onNewProject}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-content/50 hover:bg-content/5 hover:text-content"
          >
            <Plus className="size-3.5" />
            New project
          </button>
        );
    }
  };

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {entry(items[row.index])}
            </div>
          ))}
        </div>

      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          ariaLabel="Actions"
          onPick={(id) => {
            setMenu(null);
            menu.onPick(id);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}

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
      {dialog?.kind === "delete-chat" ? (
        <ConfirmDialog
          title="Delete chat"
          body="The chat and its whole transcript are gone for good."
          confirmLabel="Delete"
          danger
          onCancel={close}
          onConfirm={() => {
            close();
            onDeleteSession(dialog.thread.id);
          }}
        />
      ) : null}
    </div>
  );
}
