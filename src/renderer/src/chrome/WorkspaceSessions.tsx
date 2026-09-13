import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { MotionConfig, motion } from "motion/react";
import { SPRING_LAYOUT } from "../lib/ease";
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
import { TerminalSpinner } from "./TerminalSpinner";
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
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { interrupt, pause, resume } from "../lib/tcserver/commands";
import {
  archiveProject,
  deleteProject,
  renameProject,
} from "../lib/tcserver/projects";
import { useSessionMetas } from "../lib/tcserver/store";
import { useClock, useSlowClock } from "../lib/turnClock";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import {
  groupWorkspaceSessions,
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

function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="ws-fold" data-open={open}>
      <div inert={!open}>{children}</div>
    </div>
  );
}

function Spinner() {
  return (
    <TerminalSpinner className="inline-block w-3 shrink-0 select-none text-center text-[11px] leading-none text-accent" />
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
        className={`size-1.5 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`}
      />
      {count} {word}
    </span>
  );
}

function StatusDot({ status }: { status: ThreadRow["status"] }) {
  const cls =
    status === "waiting"
      ? "bg-amber-400 animate-pulse"
      : status === "error"
        ? "bg-red-400"
        : status === "starting"
          ? "bg-content/40 animate-pulse"
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
      className={`flex size-5 shrink-0 items-center justify-center rounded text-content/50 hover:bg-content/10 hover:text-content ${className}`}
    >
      <MoreHorizontal className="size-3.5" />
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
      className={`w-full rounded bg-content/10 px-1.5 py-0.5 leading-snug text-content outline-none ring-1 ring-accent/40 ${className}`}
    />
  );
}

const menuAt = (anchor: HTMLElement) => {
  const rect = anchor.getBoundingClientRect();
  return { x: Math.max(8, rect.right - MENU_WIDTH), y: rect.bottom + 2 };
};

// --- rows ------------------------------------------------------------------

type RowActions = {
  activeSessionId?: string;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (thread: ThreadRow) => void;
  openMenu: (state: MenuState) => void;
};

function ChatRow({
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
      onDoubleClick={() => setRenaming(true)}
      onKeyDown={(e) =>
        e.key === "Enter" && !renaming && actions.onOpen(thread.id)
      }
      onContextMenu={(e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY });
      }}
      className={`group/row relative isolate flex h-7 w-full cursor-default items-center gap-1.5 rounded-md px-2 text-left text-[13px] ${
        selected
          ? "text-content"
          : thread.paused
            ? "bg-amber-400/8 text-content/80 hover:bg-amber-400/12"
            : "text-content/80 hover:bg-content/5 hover:text-content"
      }`}
    >
      {selected ? <ActivePill /> : null}
      {thread.running ? (
        <Spinner />
      ) : thread.paused ? (
        <Pause className="size-3 shrink-0 text-amber-400" />
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
          <span className="shrink-0 text-[11px] tabular-nums text-content/45 group-hover/row:opacity-0">
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
}

/** The selected row's wash; one shared layoutId so it glides between rows. */
function ActivePill() {
  return (
    <motion.div
      layoutId="sidebar-active"
      transition={SPRING_LAYOUT}
      className="absolute inset-0 -z-10 rounded-md bg-content/10"
    />
  );
}

/** A subagent under its root: one step in, status, role glyph, title, model. */
function ChildRow({ thread, actions }: { thread: ThreadRow; actions: RowActions }) {
  const selected = thread.id === actions.activeSessionId;
  const Glyph = thread.agentType ? AGENT_GLYPHS[thread.agentType] : null;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={() => actions.onOpen(thread.id)}
      onKeyDown={(e) => e.key === "Enter" && actions.onOpen(thread.id)}
      className={`relative isolate flex h-6 w-full cursor-default items-center gap-1.5 rounded-md py-0 pr-2 pl-6 text-left text-[12px] ${
        selected ? "text-content" : "text-content/70 hover:bg-content/5 hover:text-content"
      }`}
    >
      {selected ? <ActivePill /> : null}
      {thread.running ? <Spinner /> : <StatusDot status={thread.status} />}
      {Glyph ? <Glyph className="size-3 shrink-0 text-content/45" /> : null}
      <span className="min-w-0 flex-1 truncate">{thread.title || "Subagent"}</span>
      {thread.provider && thread.model ? (
        <span className="shrink-0 text-[11px] text-content/40">
          {modelLabel(thread.provider, thread.model)}
        </span>
      ) : null}
    </div>
  );
}

/** A root row and its subagents beneath it. */
function ThreadRows({ thread, actions }: { thread: ThreadRow; actions: RowActions }) {
  return (
    <>
      <ChatRow thread={thread} actions={actions} />
      {thread.children?.map((c) => (
        <ChildRow key={c.id} thread={c} actions={actions} />
      ))}
    </>
  );
}

type Tasks = NonNullable<CardThread["tasks"]>;

/** An implementation thread's tally and current task, one step in. */
function TaskLine({ tasks, paused }: { tasks: Tasks; paused?: boolean }) {
  const tally = paused
    ? "text-warning/80"
    : tasks.done === tasks.total
      ? "text-success"
      : "text-content/70";
  return (
    <div className="flex items-center gap-1.5 pl-3 text-[11px] leading-4">
      <span
        className={`shrink-0 text-[10.5px] tabular-nums ${tally}`}
        title={`${tasks.done} of ${tasks.total} tasks done`}
      >
        {tasks.done}/{tasks.total}
      </span>
      {tasks.current ? (
        <span className={`truncate ${paused ? "text-warning/70" : "text-content/45"}`}>
          {tasks.current}
        </span>
      ) : null}
    </div>
  );
}

function ThreadGlyph({ thread }: { thread: ThreadRow }) {
  const type = thread.threadType ?? "chat";
  const Glyph = THREAD_GLYPHS[type];
  return <Glyph className={`size-3 shrink-0 opacity-80 ${THREAD_TINTS[type]}`} />;
}

/** One line per live-or-unseen thread, status leading the eye: tinted
 *  spinner (or the blue unread dot) up front, title, elapsed at the end.
 *  A paused line freezes its elapsed where the pause left it. Only a card
 *  with a running line subscribes to the second hand. */
function LiveLines({
  status,
}: {
  status: ReturnType<typeof projectCardStatus<ThreadRow>>;
}) {
  const now = useClock(status.running.length > 0);
  if (!status.running.length && !status.paused.length && !status.unread.length)
    return null;
  return (
    <div className="w-full divide-y divide-content/10 border-y border-content/10">
      {status.running.map((t) => {
        const ms = runningElapsed(t, now);
        const tasks = cardTasks(t);
        return (
          <div key={t.id} className="w-full py-[3px]" title={t.activity ?? undefined}>
            <div className="flex w-full items-center gap-1.5 text-[11px] leading-4">
              <MatrixSpinner cell={1.8} tint={t.activityKind} />
              <ThreadGlyph thread={t} />
              <span className="min-w-0 flex-1 truncate text-content/55">
                {t.title || "Untitled"}
              </span>
              <span
                className={`shrink-0 text-[10.5px] whitespace-nowrap tabular-nums text-content/45 ${ms < 3000 ? "opacity-0" : ""}`}
              >
                {duration(ms)}
              </span>
            </div>
            {tasks ? <TaskLine tasks={tasks} /> : null}
          </div>
        );
      })}
      {status.paused.map((t) => {
        const tasks = cardTasks(t);
        return (
          <div key={t.id} className="w-full bg-warning/5 py-[3px]">
            <div className="flex w-full items-center gap-1.5 text-[11px] leading-4 text-warning">
              <Pause className="size-3 shrink-0 fill-current" strokeWidth={1.8} />
              <ThreadGlyph thread={t} />
              <span className="min-w-0 flex-1 truncate">{t.title || "Untitled"}</span>
              <span className="shrink-0 font-medium">Paused</span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-current/75">
                {duration(pausedElapsed(t))}
              </span>
            </div>
            {tasks ? <TaskLine tasks={tasks} paused /> : null}
          </div>
        );
      })}
      {status.unread.map((t) => (
        <div
          key={t.id}
          className="flex w-full items-center gap-1.5 py-[3px] text-[11px] leading-4"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-info" />
          <ThreadGlyph thread={t} />
          <span className="min-w-0 flex-1 truncate font-medium text-content">
            {t.title || "Untitled"}
          </span>
        </div>
      ))}
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
  onSelect: () => void;
  onNewChat: () => void;
  onRename: (name: string) => void;
  onSettings: () => void;
  onArchive: () => void;
  onDelete: () => void;
};

/** temp-code's project card: always the summary, never a thread list. The
 *  strip above the pane is where the threads live; this card only says how
 *  the project is doing and selects it the moment the pointer lands. */
function ProjectCard({
  group,
  selected,
  lastSeen,
  seenFloor,
  rows,
  onSelect,
  onNewChat,
  onRename,
  onSettings,
  onArchive,
  onDelete,
}: CardProps) {
  const { project, threads, latest, archivedCount } = group;
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
      className="group/card relative isolate rounded-md border border-content/10"
    >
      {selected ? <ActivePill /> : null}
      <div
        role="button"
        tabIndex={0}
        title={cardTooltip(status, archivedCount)}
        onPointerDown={() => !renaming && !selected && onSelect()}
        onKeyDown={(e) => e.key === "Enter" && !renaming && onSelect()}
        onDoubleClick={() => setRenaming(true)}
        className={`relative flex w-full cursor-default flex-col gap-[3px] rounded-md px-2 py-2 text-left ${
          selected ? "" : "hover:bg-content/5"
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
                  selected ? "text-content" : "text-content/80"
                }`}
              >
                {project.name}
              </span>
              {latest > 0 ? (
                <span className="shrink-0 text-[11px] tabular-nums text-content/45 group-hover/card:opacity-0">
                  <Ago at={latest} />
                </span>
              ) : null}
            </>
          )}
        </div>

        <div className="flex w-full items-center gap-1 text-[11px] leading-4 text-content/55">
          <GitBranch className="size-2.5 shrink-0" />
          <span className="truncate">{project.branch ?? "local checkout"}</span>
          <span className="shrink-0 text-content/40">
            · {project.mode === "worktree" ? "worktree" : "local"}
          </span>
        </div>

        <LiveLines status={status} />

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
                <Pause className="size-3 fill-current" strokeWidth={1.8} />
                {status.paused.length} paused
              </span>
            ) : null}
            <span className="truncate text-content/45">
              {quietSummary(status, archivedCount)}
            </span>
          </div>
        ) : null}
      </div>
      {!renaming ? (
        <Kebab
          className="absolute top-2 right-1.5 opacity-0 group-hover/card:opacity-100 focus:opacity-100"
          onOpen={(el) => menu(menuAt(el))}
        />
      ) : null}
    </section>
  );
}

// --- archived --------------------------------------------------------------

function ArchivedProjects({
  groups,
  rows,
  onRestore,
  onDelete,
}: {
  groups: ProjectGroup[];
  rows: RowActions;
  onRestore: (project: ProjectMeta) => void;
  onDelete: (project: ProjectMeta) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-[11px] text-content/45 hover:text-content/70"
      >
        <ChevronRight
          className={`size-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        Archived · {groups.length}
      </button>
      <Fold open={open}>
        <div className="flex flex-col gap-px">
          {groups.map(({ project, threads }) => (
            <div key={project.id}>
              <div className="group/arch flex h-7 items-center gap-2 rounded-md px-2 hover:bg-content/5">
                <button
                  type="button"
                  onClick={() =>
                    setShown((s) => (s === project.id ? null : project.id))
                  }
                  className="min-w-0 flex-1 truncate text-left text-[13px] text-content/70"
                >
                  {project.name}
                </button>
                <span className="text-[11px] tabular-nums text-content/40 group-hover/arch:hidden">
                  {threads.length}
                </span>
                <div className="hidden items-center gap-0.5 group-hover/arch:flex">
                  <button
                    type="button"
                    aria-label="Restore"
                    onClick={() => onRestore(project)}
                    className="flex size-5 items-center justify-center rounded text-content/50 hover:bg-content/10 hover:text-content"
                  >
                    <ArchiveRestore className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete"
                    onClick={() => onDelete(project)}
                    className="flex size-5 items-center justify-center rounded text-content/50 hover:bg-red-500/15 hover:text-red-300"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              <Fold open={shown === project.id}>
                <div className="flex flex-col gap-px pl-2">
                  {threads.map((t) => (
                    <ThreadRows key={t.id} thread={t} actions={rows} />
                  ))}
                </div>
              </Fold>
            </div>
          ))}
        </div>
      </Fold>
    </div>
  );
}

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
  const groups = groupWorkspaceSessions(
    metas,
    projects,
    workspaces,
    workspaceId,
    lastSeen,
    seenFloor,
  );
  const workspace: WorkspaceMeta | undefined = workspaces.find(
    (w) => w.id === workspaceId,
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [chatsOpen, setChatsOpen] = useState(true);
  const close = () => setDialog(null);

  const teardownOrConfirm = (
    project: ProjectMeta,
    action: "archive" | "delete",
  ) => {
    if (project.mode === "worktree" && project.branch)
      setDialog({ kind: "teardown", project, action });
    else if (action === "delete")
      setDialog({ kind: "delete-project", project });
    else void archiveProject(project.id, true);
  };

  const rows: RowActions = {
    activeSessionId,
    onOpen: onOpenSession,
    onRename: onRenameSession,
    onDelete: (thread) => setDialog({ kind: "delete-chat", thread }),
    openMenu: setMenu,
  };

  const empty =
    !groups.projects.length && !groups.chats.length && !groups.archived.length;

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        layoutScroll
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
      >
      {groups.projects.map((group) => (
        <ProjectCard
          key={group.project.id}
          group={group}
          selected={group.project.id === selectedProjectId}
          lastSeen={lastSeen}
          seenFloor={seenFloor}
          rows={rows}
          onSelect={() => onSelectProject(group.project.id)}
          onNewChat={() => onNewChat(group.project.id)}
          onRename={(name) => void renameProject(group.project.id, name)}
          onSettings={() =>
            setDialog({ kind: "settings", project: group.project })
          }
          onArchive={() => teardownOrConfirm(group.project, "archive")}
          onDelete={() => teardownOrConfirm(group.project, "delete")}
        />
      ))}

      {groups.chats.length ? (
        <div>
          <div className="group/chats flex h-6 items-center gap-1 px-2">
            <button
              type="button"
              onClick={() => setChatsOpen((o) => !o)}
              aria-expanded={chatsOpen}
              className="flex min-w-0 flex-1 items-center gap-1 text-[12px] font-medium text-content/60 hover:text-content"
            >
              <ChevronRight
                className={`size-3 transition-transform duration-200 ${chatsOpen ? "rotate-90" : ""}`}
              />
              Chats
            </button>
            <button
              type="button"
              aria-label="New chat"
              onClick={() => onNewChat(null)}
              className="flex size-5 items-center justify-center rounded text-content/50 opacity-0 group-hover/chats:opacity-100 hover:bg-content/10 hover:text-content focus:opacity-100"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <Fold open={chatsOpen}>
            <div className="flex flex-col gap-px">
              {groups.chats.map((t) => (
                <ThreadRows key={t.id} thread={t} actions={rows} />
              ))}
            </div>
          </Fold>
        </div>
      ) : null}

      {groups.archived.length ? (
        <ArchivedProjects
          groups={groups.archived}
          rows={rows}
          onRestore={(p) => void archiveProject(p.id, false)}
          onDelete={(p) => teardownOrConfirm(p, "delete")}
        />
      ) : null}

      {empty ? (
        <button
          type="button"
          onClick={onNewProject}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-content/50 hover:bg-content/5 hover:text-content"
        >
          <Plus className="size-3.5" />
          New project
        </button>
      ) : null}

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
      </motion.div>
    </MotionConfig>
  );
}
