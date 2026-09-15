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
import { modelLabel } from "../lib/threads/agents";
import {
  AGENT_GLYPHS,
  MatrixSpinner,
  THREAD_GLYPHS,
  THREAD_TINTS,
} from "../surfaces/threads/bits";
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
  nextPage,
  sessionItemIndex,
  sidebarItems,
  windowRows,
  type SidebarItem,
} from "../lib/sidebarRows";
import { interrupt, pause, resume } from "../lib/tcserver/commands";
import {
  archiveProject,
  deleteProject,
  renameProject,
} from "../lib/tcserver/projects";
import { sessionPrefetch } from "../lib/sessionPrefetch";
import { useSessionMetas } from "../lib/tcserver/store";
import { useClock, useSlowClock } from "../lib/turnClock";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import {
  groupWorkspaceSessions,
  rowCache,
  type ProjectGroup,
  type ThreadRow,
} from "../lib/workspaceSessions";

type Props = {
  workspaceId: string;
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

/** A running span since `since`, refreshed each second. */
function Elapsed({ since }: { since: number }) {
  const now = useClock(true);
  return <>{duration(Math.max(0, now - since))}</>;
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
    <button
      type="button"
      onClick={onMore}
      className="pressable flex h-6 w-full items-center rounded-md px-2 text-[11px] text-content/40 hover:bg-content/5 hover:text-content"
    >
      {hidden} more
    </button>
  );
}

function Spinner() {
  return <MatrixSpinner cell={1.5} />;
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

function StatusDot({ status }: { status: ThreadRow["status"] }) {
  const cls =
    status === "waiting"
      ? "bg-warning motion-safe:animate-pulse"
      : status === "error"
        ? "bg-danger"
        : status === "starting"
          ? "bg-content/40 motion-safe:animate-pulse"
          : null;
  return cls ? (
    <span className={`size-1.5 shrink-0 rounded-full ${cls}`} />
  ) : null;
}

function Kebab({
  onOpen,
  className = "",
}: {
  onOpen: (anchor: HTMLElement) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="More"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e.currentTarget);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`pressable flex size-6 shrink-0 items-center justify-center rounded-md text-content/50 hover:bg-content/10 hover:text-content ${className}`}
    >
      <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

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
      className={`w-full rounded-md bg-content/10 px-1.5 py-0.5 leading-snug text-content outline-none ring-1 ring-accent/40 ${className}`}
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
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (thread: ThreadRow) => void;
  openMenu: (state: MenuState) => void;
};

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

const ChatRow = memo(function ChatRow({
  thread,
  actions,
}: {
  thread: ThreadRow;
  actions: RowActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const selected = thread.id === actions.activeSessionId;
  const title = thread.title || "Untitled";

  const menu = (at: { x: number; y: number }) => {
    const items: ExplorerMenuItem[] = [
      { kind: "item", id: "rename", label: "Rename" },
      ...(thread.running
        ? [{ kind: "item", id: "stop", label: "Stop" } as const]
        : []),
      { kind: "sep" },
      { kind: "item", id: "delete", label: "Delete chat", danger: true },
    ];
    actions.openMenu({
      ...at,
      items,
      onPick: (id) => {
        if (id === "rename") setRenaming(true);
        else if (id === "stop") void interrupt(thread.id);
        else if (id === "delete") actions.onDelete(thread);
      },
    });
  };

  const trailing = thread.running ? (
    <Elapsed since={thread.busySince ?? thread.updatedAt} />
  ) : (
    <Ago at={thread.updatedAt} />
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={() => !renaming && actions.onOpen(thread.id)}
      onPointerEnter={() => sessionPrefetch.enter(thread.id)}
      onPointerLeave={() => sessionPrefetch.leave(thread.id)}
      onDoubleClick={() => setRenaming(true)}
      onKeyDown={(e) =>
        e.key === "Enter" && !renaming && actions.onOpen(thread.id)
      }
      onContextMenu={(e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY });
      }}
      className={`group/row relative flex h-7 w-full cursor-default items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors ${
        selected
          ? "bg-content/10 text-content"
          : thread.paused
            ? "bg-warning/8 text-content/70 hover:bg-warning/12 active:bg-warning/12"
            : "text-content/70 hover:bg-content/5 hover:text-content active:bg-content/10"
      }`}
    >
      {thread.running ? (
        <Spinner />
      ) : thread.paused ? (
        <Pause className="size-3.5 shrink-0 text-warning" strokeWidth={1.75} />
      ) : thread.unread ? (
        <span className="size-1.5 shrink-0 rounded-full bg-accent" />
      ) : null}
      {renaming ? (
        <InlineRename
          value={thread.title}
          className="text-[13px]"
          onCommit={(t) => {
            setRenaming(false);
            actions.onRename(thread.id, t);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate ${thread.unread ? "font-medium text-content" : ""}`}
        >
          {title}
        </span>
      )}
      {!renaming ? (
        <>
          <StatusDot status={thread.status} />
          <span className="shrink-0 text-[11px] tabular-nums text-content/40 group-hover/row:opacity-0">
            {trailing}
          </span>
          <Kebab
            className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus:opacity-100"
            onOpen={(el) => menu(menuAt(el))}
          />
        </>
      ) : null}
    </div>
  );
});

/** A subagent under its root: one step in, status, role glyph, title, model. */
const ChildRow = memo(function ChildRow({
  thread,
  actions,
}: {
  thread: ThreadRow;
  actions: RowActions;
}) {
  const selected = thread.id === actions.activeSessionId;
  const Glyph = thread.agentType ? AGENT_GLYPHS[thread.agentType] : null;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={() => actions.onOpen(thread.id)}
      onPointerEnter={() => sessionPrefetch.enter(thread.id)}
      onPointerLeave={() => sessionPrefetch.leave(thread.id)}
      onKeyDown={(e) => e.key === "Enter" && actions.onOpen(thread.id)}
      className={`relative flex h-6 w-full cursor-default items-center gap-1.5 rounded-md py-0 pr-2 pl-6 text-left text-[12px] transition-colors ${
        selected
          ? "bg-content/10 text-content"
          : "text-content/70 hover:bg-content/5 hover:text-content active:bg-content/10"
      }`}
    >
      {thread.running ? <Spinner /> : <StatusDot status={thread.status} />}
      {Glyph ? <Glyph className="size-3 shrink-0 text-content/40" strokeWidth={1.75} /> : null}
      <span className="min-w-0 flex-1 truncate">{thread.title || "Subagent"}</span>
      {thread.provider && thread.model ? (
        <span className="shrink-0 text-[11px] text-content/40">
          {modelLabel(thread.provider, thread.model)}
        </span>
      ) : null}
    </div>
  );
});

/** A root row and its subagents beneath it. */
const ThreadRows = memo(function ThreadRows({
  thread,
  actions,
}: {
  thread: ThreadRow;
  actions: RowActions;
}) {
  return (
    <>
      <ChatRow thread={thread} actions={actions} />
      {thread.children?.map((c) => (
        <ChildRow key={c.id} thread={c} actions={actions} />
      ))}
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
function TaskLine({ tasks, paused }: { tasks: Tasks; paused?: boolean }) {
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

function ThreadGlyph({ thread }: { thread: ThreadRow }) {
  const type = thread.threadType ?? "chat";
  const Glyph = THREAD_GLYPHS[type];
  return <Glyph className={`size-3 shrink-0 ${THREAD_TINTS[type]}`} strokeWidth={1.75} />;
}

type LiveStatus = ReturnType<typeof projectCardStatus<ThreadRow>>;

function RunningLine({ thread: t, now }: { thread: ThreadRow; now: number }) {
  const ms = runningElapsed(t, now);
  const tasks = cardTasks(t);
  return (
    <div className="w-full py-1" title={t.activity ?? undefined}>
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
    </div>
  );
}

function PausedLine({ thread: t }: { thread: ThreadRow }) {
  const tasks = cardTasks(t);
  return (
    <div className="w-full bg-warning/5 py-1">
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
    </div>
  );
}

function UnreadLine({ thread: t }: { thread: ThreadRow }) {
  return (
    <div className="flex w-full items-center gap-1.5 py-1 text-[11px] leading-4">
      <span className="size-1.5 shrink-0 rounded-full bg-info" />
      <ThreadGlyph thread={t} />
      <span className="min-w-0 flex-1 truncate font-medium text-content">
        {t.title || "Untitled"}
      </span>
    </div>
  );
}

/** One line per live-or-unseen thread, status leading the eye: tinted
 *  spinner (or the blue unread dot) up front, title, elapsed at the end.
 *  A paused line freezes its elapsed where the pause left it. Only a card
 *  with a running line subscribes to the second hand. A card prints one
 *  page of lines (`sessionListWindow`) and a "more" row for the rest. */
export function LiveLines({
  status,
  activeId,
  requested = SESSION_LIST_PAGE,
  onMore,
}: {
  status: LiveStatus;
  activeId: string | null;
  requested?: number;
  onMore?: () => void;
}) {
  const now = useClock(status.running.length > 0);
  const { shown, hidden } = windowRows(liveLines(status), requested, activeId);
  if (!shown.length) return null;
  return (
    <div className="w-full">
      {shown.map(({ kind, thread }) =>
        kind === "running" ? (
          <RunningLine key={thread.id} thread={thread} now={now} />
        ) : kind === "paused" ? (
          <PausedLine key={thread.id} thread={thread} />
        ) : (
          <UnreadLine key={thread.id} thread={thread} />
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
  onArchive: archive,
  onDelete: remove,
}: CardProps) {
  const { project, threads, latest, archivedCount } = group;
  const onSelect = () => selectProject(project.id);
  const onNewChat = () => newChat(project.id);
  const onRename = (name: string) => renameTo(project.id, name);
  const onSettings = () => openSettings(project);
  const onArchive = () => archive(project);
  const onDelete = () => remove(project);
  const onMore = () => more(project.id);
  const [renaming, setRenaming] = useState(false);
  const status = projectCardStatus(threads, rows.activeSessionId ?? null, lastSeen, seenFloor);
  const runAction = projectRunAction(status);
  const stoppable = stoppableThreads(status);
  const teardown = project.mode === "worktree" && Boolean(project.branch);
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
        else if (id === "resume")
          void Promise.allSettled(status.paused.map((t) => resume(t.id)));
        else if (id === "pause")
          void Promise.allSettled(status.running.map((t) => pause(t.id)));
        else if (id === "stop")
          void Promise.allSettled(stoppable.map((t) => interrupt(t.id)));
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
      className="group/card relative rounded-md border border-content/10"
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
                <span className="shrink-0 text-[11px] tabular-nums text-content/40 group-hover/card:opacity-0">
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
        <Kebab
          className="absolute top-1.5 right-1 opacity-0 group-hover/card:opacity-100 focus:opacity-100"
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

export default function WorkspaceSessions({
  workspaceId,
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
        workspaceId,
        lastSeen,
        seenFloor,
        cache,
      ),
    [cache, lastSeen, metas, projects, seenFloor, workspaceId, workspaces],
  );
  const workspace: WorkspaceMeta | undefined = workspaces.find(
    (w) => w.id === workspaceId,
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [archived, setArchived] = useState<ArchivedState>({ open: false, shown: null });
  const [pages, setPages] = useState<Pages>({});
  const close = () => setDialog(null);

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
  const rename = useCallback((id: string, name: string) => void renameProject(id, name), []);
  const openSettings = useCallback(
    (project: ProjectMeta) => setDialog({ kind: "settings", project }),
    [],
  );
  const teardownOrConfirm = useCallback(
    (project: ProjectMeta, action: "archive" | "delete") => {
      if (project.mode === "worktree" && project.branch)
        setDialog({ kind: "teardown", project, action });
      else if (action === "delete") setDialog({ kind: "delete-project", project });
      else void archiveProject(project.id, true);
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
  const restore = useCallback((project: ProjectMeta) => void archiveProject(project.id, false), []);
  const toggleChats = useCallback(() => setChatsOpen((o) => !o), []);
  const morePages = useCallback(
    (key: string) => setPages((prev) => ({ ...prev, [key]: nextPage(pageOf(prev, key)) })),
    [],
  );
  const moreChats = useCallback(() => morePages("chats"), [morePages]);

  const rows = useMemo<RowActions>(
    () => ({
      activeSessionId,
      onOpen: openSession,
      onRename: renameSession,
      onDelete: (thread) => setDialog({ kind: "delete-chat", thread }),
      openMenu: setMenu,
    }),
    [activeSessionId, openSession, renameSession],
  );

  // Cards are the virtual unit: each roots its own border and hover group,
  // and the shared ActivePill lives inside one. Every item is measured, so
  // a card that grows a live line pushes the ones below it. (A fold's
  // height animation is measured too: the root re-renders per frame while
  // a section opens or closes, and the memoized cards sit that out.)
  const items = useMemo(() => sidebarItems(groups), [groups]);
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
      (item) => item.kind === "project" && item.group.project.id === selectedProjectId,
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
            selected={item.group.project.id === selectedProjectId}
            lastSeen={lastSeen}
            seenFloor={seenFloor}
            rows={rows}
            requested={pageOf(pages, item.key)}
            onMore={morePages}
            onSelect={selectProject}
            onNewChat={newChat}
            onRename={rename}
            onSettings={openSettings}
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
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
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
