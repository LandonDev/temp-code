import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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
import { AGENT_GLYPHS } from "../surfaces/threads/bits";
import { useLastSeen } from "../lib/sessionSeen";
import { interrupt } from "../lib/tcserver/commands";
import {
  archiveProject,
  deleteProject,
  renameProject,
} from "../lib/tcserver/projects";
import { sessionStore } from "../lib/tcserver/store";
import type {
  ProjectMeta,
  SessionMeta,
  WorkspaceMeta,
} from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import {
  groupWorkspaceSessions,
  summarizeThreads,
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

// --- store hooks -----------------------------------------------------------

let metasCache: SessionMeta[] | null = null;
sessionStore.onMetaChange(() => {
  metasCache = null;
});
const readMetas = () => (metasCache ??= sessionStore.metas());
const subscribeMetas = (listener: () => void) =>
  sessionStore.onMetaChange(listener);

function useSessionMetas(): SessionMeta[] {
  return useSyncExternalStore(subscribeMetas, readMetas);
}

function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(
      () => setNow(Date.now()),
      fast ? 1000 : 30_000,
    );
    return () => window.clearInterval(id);
  }, [fast]);
  return now;
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

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  if (!n) return null;
  return (
    <span className={tone}>
      {n} {label}
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
  now: number;
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

  const trailing = thread.running
    ? duration(actions.now - (thread.busySince ?? thread.updatedAt))
    : timeAgo(thread.updatedAt, actions.now);

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

function LiveStrip({
  threads,
  now,
  onOpen,
}: {
  threads: ThreadRow[];
  now: number;
  onOpen: (id: string) => void;
}) {
  const live = threads.filter((t) => t.running || t.paused || t.unread);
  if (!live.length) return null;
  return (
    <div className="divide-y divide-content/10 border-y border-content/10">
      {live.map((t) => {
        const elapsed = now - (t.busySince ?? t.updatedAt);
        return (
          <button
            key={t.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(t.id);
            }}
            className={`flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] ${
              t.paused
                ? "bg-amber-400/5 text-amber-400"
                : "text-content/60 hover:bg-content/5"
            }`}
          >
            {t.running ? (
              <Spinner />
            ) : t.paused ? (
              <Pause className="size-3 shrink-0" />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-accent" />
            )}
            <span
              className={`min-w-0 flex-1 truncate ${t.unread ? "font-medium text-content" : ""}`}
            >
              {t.title || "Untitled"}
            </span>
            {t.running ? (
              <span
                className={`shrink-0 text-[11px] tabular-nums text-content/45 ${elapsed < 3000 ? "opacity-0" : ""}`}
              >
                {duration(elapsed)}
              </span>
            ) : t.paused ? (
              <span className="shrink-0 text-[11px]">Paused</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// --- project card ----------------------------------------------------------

type CardProps = {
  group: ProjectGroup;
  selected: boolean;
  now: number;
  rows: RowActions;
  onSelect: () => void;
  onNewChat: () => void;
  onRename: (name: string) => void;
  onSettings: () => void;
  onArchive: () => void;
  onDelete: () => void;
};

function ProjectCard({
  group,
  selected,
  now,
  rows,
  onSelect,
  onNewChat,
  onRename,
  onSettings,
  onArchive,
  onDelete,
}: CardProps) {
  const { project, threads, latest, archivedCount } = group;
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => setCollapsed(false), [selected]);
  const expanded = selected && !collapsed;
  const sum = summarizeThreads(threads);
  const running = threads.filter((t) => t.running);
  const showSummary =
    sum.needYou ||
    sum.failed ||
    sum.paused ||
    sum.dormant ||
    archivedCount ||
    !threads.length;

  const menu = (at: { x: number; y: number }) =>
    rows.openMenu({
      ...at,
      items: [
        { kind: "item", id: "chat", label: "New chat" },
        { kind: "item", id: "rename", label: "Rename" },
        { kind: "item", id: "settings", label: "Project settings" },
        {
          kind: "item",
          id: "stop",
          label: "Stop threads",
          disabled: !running.length,
        },
        { kind: "sep" },
        { kind: "item", id: "archive", label: "Archive" },
        { kind: "item", id: "delete", label: "Delete", danger: true },
      ],
      onPick: (id) => {
        if (id === "chat") onNewChat();
        else if (id === "rename") setRenaming(true);
        else if (id === "settings") onSettings();
        else if (id === "stop") running.forEach((t) => void interrupt(t.id));
        else if (id === "archive") onArchive();
        else if (id === "delete") onDelete();
      },
    });

  const onHeaderClick = (e: ReactMouseEvent) => {
    if (renaming) return;
    e.stopPropagation();
    if (selected) setCollapsed((c) => !c);
    else onSelect();
  };

  return (
    <section
      aria-current={selected || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY });
      }}
      className={`group/card relative rounded-lg border border-content/10 ${
        selected ? "bg-content/8" : "hover:bg-content/5"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onHeaderClick}
        onKeyDown={(e) =>
          e.key === "Enter" &&
          !renaming &&
          (selected ? setCollapsed((c) => !c) : onSelect())
        }
        className="flex cursor-default flex-col gap-0.5 px-2 pt-2 pb-1.5"
      >
        <div className="flex items-center gap-1.5">
          {renaming ? (
            <InlineRename
              value={project.name}
              className="text-[13px] font-medium"
              onCommit={(n) => {
                setRenaming(false);
                onRename(n);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <>
              <span
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenaming(true);
                }}
                className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
                  selected ? "text-content" : "text-content/80"
                }`}
              >
                {project.name}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-content/45 group-hover/card:opacity-0">
                {timeAgo(latest, now)}
              </span>
              <Kebab
                className="absolute top-2 right-1.5 opacity-0 group-hover/card:opacity-100 focus:opacity-100"
                onOpen={(el) => menu(menuAt(el))}
              />
            </>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-content/45">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate font-mono">
            {project.branch ?? "local checkout"}
          </span>
          <span className="shrink-0">· {project.mode}</span>
        </div>
      </div>

      <Fold open={!expanded}>
        <div className="pb-1.5">
          <LiveStrip threads={threads} now={now} onOpen={rows.onOpen} />
          {showSummary ? (
            <div className="flex flex-wrap items-center gap-x-2 px-2 pt-1.5 text-[11px] text-content/45">
              <Stat n={sum.needYou} label="need you" tone="text-amber-400" />
              <Stat n={sum.failed} label="failed" tone="text-red-400" />
              <Stat n={sum.paused} label="paused" tone="text-amber-400/80" />
              {threads.length ? (
                <span>
                  {[
                    sum.dormant ? `${sum.dormant} dormant` : null,
                    archivedCount ? `${archivedCount} archived` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : (
                <span>
                  {archivedCount ? `${archivedCount} archived` : "No threads"}
                </span>
              )}
            </div>
          ) : null}
        </div>
      </Fold>

      <Fold open={expanded}>
        <div className="flex flex-col gap-px px-1 pb-1.5">
          {threads.map((t) => (
            <ThreadRows key={t.id} thread={t} actions={rows} />
          ))}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNewChat();
            }}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-content/50 hover:bg-content/5 hover:text-content"
          >
            <Plus className="size-3.5" />
            New chat
          </button>
        </div>
      </Fold>
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
  const groups = groupWorkspaceSessions(
    metas,
    projects,
    workspaces,
    workspaceId,
    lastSeen,
  );
  const workspace: WorkspaceMeta | undefined = workspaces.find(
    (w) => w.id === workspaceId,
  );
  const anyRunning =
    groups.chats.some((t) => t.running) ||
    groups.projects.some((g) => g.threads.some((t) => t.running));
  const now = useNow(anyRunning);

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
    now,
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
          now={now}
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
