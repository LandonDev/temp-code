import { useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderPlus,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { chatsOfWorkspace, threadsOfProject, unsortedSessions, useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { SPRING_LAYOUT } from '../../lib/ease'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { StatusDot, THREAD_GLYPHS, THREAD_TINTS, timeAgo } from './bits'
import { ZIcon } from './zicon'
import { NewProjectDialog } from './NewProjectDialog'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { ProjectTeardownDialog } from './ProjectTeardownDialog'
import { updateReady, useUpdateStatus } from '../../lib/updates'

/**
 * Workspaces → projects. One left-edge rhythm: workspace names start at
 * x=24 (6px pad + 12px chevron + 6px gap) and project rows indent to the
 * same 24 so titles align down the bar. The active project gets a
 * shared-layout pill; rows respond on pointer-down.
 */
export function Sidebar(): React.JSX.Element {
  const workspaces = useApp((s) => s.workspaces)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const connected = useApp((s) => s.connected)
  const settingsOpen = useApp((s) => s.settingsOpen)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const [newProjectWs, setNewProjectWs] = useState<WorkspaceMeta | null>(null)
  const [newWorkspacePath, setNewWorkspacePath] = useState<string | null>(null)

  const unsorted = useMemo(() => unsortedSessions(sessions), [sessions])

  const pickWorkspace = async (): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) setNewWorkspacePath(path)
  }

  return (
    <aside className="flex w-[232px] shrink-0 flex-col bg-sidebar">
      {/* traffic-light strip */}
      <div className="titlebar-drag h-11 shrink-0" />

      <div className="flex-1 space-y-3 overflow-y-auto px-2 pb-2">
        <div>
          {workspaces.map((ws) => (
            <WorkspaceGroup
              key={ws.id}
              workspace={ws}
              projects={projects.filter((p) => p.workspaceId === ws.id)}
              sessions={sessions}
              onNewProject={() => setNewProjectWs(ws)}
            />
          ))}

          <button
            onClick={() => void pickWorkspace()}
            className="mt-1 flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground active:scale-[0.99]"
          >
            <FolderPlus className="size-3.5 shrink-0 opacity-80" />
            Add workspace
          </button>
        </div>

        <ChatsGroup sessions={unsorted} />
      </div>

      <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border/60 px-2">
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className={cn(
            'flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground active:scale-[0.99]',
            settingsOpen && 'bg-accent text-foreground'
          )}
        >
          <ZIcon name="settings-minimalistic" size={15} className="shrink-0 opacity-80" />
          Settings
          <UpdateDot />
        </button>
        {!connected && (
          <span
            title="Reconnecting…"
            className="mr-1 size-1.5 shrink-0 animate-pulse rounded-full bg-warning"
          />
        )}
      </div>

      {newProjectWs && (
        <NewProjectDialog workspace={newProjectWs} onClose={() => setNewProjectWs(null)} />
      )}
      {newWorkspacePath && (
        <NewWorkspaceDialog path={newWorkspacePath} onClose={() => setNewWorkspacePath(null)} />
      )}
    </aside>
  )
}

function WorkspaceGroup({
  workspace,
  projects,
  sessions,
  onNewProject
}: {
  workspace: WorkspaceMeta
  projects: ProjectMeta[]
  sessions: Record<string, SessionMeta>
  onNewProject: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const reduce = useReducedMotion()
  const removeWorkspace = useApp((s) => s.removeWorkspace)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const selectProject = useApp((s) => s.selectProject)
  const createThread = useApp((s) => s.createThread)

  const active = projects.filter((p) => !p.archived)
  const archived = projects.filter((p) => p.archived)
  const chats = chatsOfWorkspace(sessions, workspace.id)
  const newChat = async (): Promise<void> => {
    // One-off chat outside a project: runs at the workspace root.
    selectProject(null)
    await createThread({ threadType: 'chat', workspaceId: workspace.id })
    setOpen(true)
  }

  return (
    <div className="group/ws mt-1 first:mt-0">
      <div className="flex h-7 items-center rounded-md pr-1 pl-1.5 hover:bg-accent/40">
        <button
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className="flex size-3 shrink-0 items-center justify-center text-muted-foreground/70"
          >
            <ChevronRight className="size-3" />
          </motion.span>
          <span className="truncate text-xs font-medium text-muted-foreground">
            {workspace.name}
          </span>
        </button>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/ws:opacity-100">
          <button
            onClick={onNewProject}
            title="New project"
            aria-label="New project"
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:text-foreground active:scale-95"
          >
            <Plus className="size-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Workspace options"
                className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:text-foreground active:scale-95"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuItem onClick={onNewProject}>New project</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void newChat()}>New chat</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSettingsOpen(true, `ws:${workspace.id}`)}>
                Workspace settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmRemove(true)}>
                Remove workspace…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${workspace.name}?`}
        body="Its projects and threads leave the app. Files and worktrees on disk stay."
        confirmLabel="Remove workspace"
        onConfirm={() => removeWorkspace(workspace.id)}
        onClose={() => setConfirmRemove(false)}
      />

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className="overflow-hidden"
          >
            <div className="mt-0.5 space-y-px">
              {active.length === 0 && chats.length === 0 && archived.length === 0 ? (
                <button
                  onClick={onNewProject}
                  className="ml-4 flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                >
                  <Plus className="size-3" /> New project
                </button>
              ) : (
                <>
                  {active.map((p) => <ProjectRow key={p.id} project={p} sessions={sessions} />)}
                  {chats.map((c) => <ChatRow key={c.id} session={c} />)}
                  <ArchivedProjects projects={archived} />
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ProjectRow({
  project,
  sessions
}: {
  project: ProjectMeta
  sessions: Record<string, SessionMeta>
}): React.JSX.Element {
  const selected = useApp((s) => s.selectedProjectId === project.id)
  const selectProject = useApp((s) => s.selectProject)
  const removeProject = useApp((s) => s.removeProject)
  const archiveProject = useApp((s) => s.archiveProject)
  const renameProject = useApp((s) => s.renameProject)
  const [renaming, setRenaming] = useState(false)
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null)

  const threads = threadsOfProject(sessions, project.id)
  const busy = threads.find(
    (t) => t.status === 'running' || t.status === 'waiting' || t.status === 'error'
  )
  const latest = threads.at(-1)

  if (renaming) {
    // The row itself becomes the editor — no dialog for a name.
    return (
      <div className="ml-4 flex items-center rounded-md bg-accent px-2 py-1.5">
        <input
          autoFocus
          defaultValue={project.name}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.currentTarget.value = project.name
              e.currentTarget.blur()
            }
          }}
          onBlur={(e) => {
            setRenaming(false)
            const v = e.target.value.trim()
            if (v && v !== project.name) void renameProject(project.id, v)
          }}
          className="w-full bg-transparent text-[13px] leading-5 outline-none"
        />
      </div>
    )
  }

  return (
    <div className="group/row relative ml-4">
      {selected && (
        <motion.div
          layoutId="sidebar-active"
          transition={SPRING_LAYOUT}
          className="absolute inset-0 rounded-md bg-accent"
        />
      )}
      <button
        onPointerDown={() => selectProject(project.id)}
        onDoubleClick={() => setRenaming(true)}
        className={cn(
          'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-transform active:scale-[0.99]',
          !selected && 'hover:bg-accent/50'
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'truncate text-[13px] leading-5',
                selected ? 'text-foreground' : 'text-foreground/80'
              )}
            >
              {project.name}
            </span>
            {busy && <StatusDot status={busy.status} />}
          </div>
          {project.branch && (
            <div className="mt-px flex items-center gap-1 text-[11px] leading-4 text-muted-foreground/70">
              <GitBranch className="size-2.5 shrink-0" />
              <span className="truncate">{project.branch}</span>
            </div>
          )}
        </div>
        {latest && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60 group-hover/row:opacity-0">
            {timeAgo(latest.updatedAt)}
          </span>
        )}
      </button>
      <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Project options"
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:text-foreground active:scale-95"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <Pencil className="size-3.5 text-muted-foreground" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                // Nothing to tear down on a local project — archive right away.
                if (project.mode === 'worktree') setConfirm('archive')
                else void archiveProject(project.id, true)
              }}
            >
              <Archive className="size-3.5 text-muted-foreground" />
              {project.mode === 'worktree' ? 'Archive project…' : 'Archive project'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirm('delete')}>
              Delete project…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {confirm && (
        <ProjectTeardownDialog
          open
          project={project}
          action={confirm}
          onConfirm={(cleanup) =>
            confirm === 'delete'
              ? removeProject(project.id, cleanup)
              : archiveProject(project.id, true, cleanup)
          }
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

/** Archived projects, folded away under the workspace's rows. */
function ArchivedProjects({ projects }: { projects: ProjectMeta[] }): React.JSX.Element | null {
  const archiveProject = useApp((s) => s.archiveProject)
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState<ProjectMeta | null>(null)

  if (projects.length === 0) return null

  return (
    <div className="ml-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      >
        <Archive className="size-3" />
        Archived · {projects.length}
      </button>
      {open &&
        projects.map((p) => (
          <div
            key={p.id}
            className="group/arch flex h-7 items-center gap-2 rounded-md px-2 hover:bg-accent/40"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-muted-foreground">
              {p.name}
            </span>
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/arch:opacity-100">
              <button
                title="Restore"
                aria-label="Restore project"
                onClick={() => void archiveProject(p.id, false)}
                className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:text-foreground active:scale-95"
              >
                <ArchiveRestore className="size-3.5" />
              </button>
              <button
                title="Delete"
                aria-label="Delete project"
                onClick={() => setDeleting(p)}
                className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:text-destructive active:scale-95"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>
        ))}
      {deleting && (
        <ProjectTeardownDialog
          open
          project={deleting}
          action="delete"
          onConfirm={(cleanup) => useApp.getState().removeProject(deleting.id, cleanup)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

/** A quiet signal on the Settings button while an update waits. */
function UpdateDot(): React.JSX.Element | null {
  const s = useUpdateStatus()
  if (!updateReady(s)) return null
  return <span title="Update ready" className="ml-auto size-1.5 shrink-0 rounded-full bg-info" />
}

/** A one-off chat thread in the sidebar — workspace chats and loose chats alike. */
function ChatRow({ session }: { session: SessionMeta }): React.JSX.Element {
  const selected = useApp((s) => s.selectedId === session.id && !s.selectedProjectId)
  const select = useApp((s) => s.select)
  const selectProject = useApp((s) => s.selectProject)
  const renameSession = useApp((s) => s.renameSession)
  const deleteSession = useApp((s) => s.deleteSession)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const Glyph = THREAD_GLYPHS[session.threadType ?? 'chat']

  if (renaming) {
    return (
      <div className="ml-4 flex h-7 items-center rounded-md bg-accent px-2">
        <input
          autoFocus
          defaultValue={session.title}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.currentTarget.value = session.title
              e.currentTarget.blur()
            }
          }}
          onBlur={(e) => {
            setRenaming(false)
            const v = e.target.value.trim()
            if (v && v !== session.title) void renameSession(session.id, v)
          }}
          className="w-full bg-transparent text-[13px] leading-5 outline-none"
        />
      </div>
    )
  }

  return (
    <div className="group/row relative ml-4">
      {selected && (
        <motion.div
          layoutId="sidebar-active"
          transition={SPRING_LAYOUT}
          className="absolute inset-0 rounded-md bg-accent"
        />
      )}
      <button
        onPointerDown={() => {
          selectProject(null)
          void select(session.id)
        }}
        onDoubleClick={() => setRenaming(true)}
        className={cn(
          'relative flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left transition-transform active:scale-[0.99]',
          !selected && 'hover:bg-accent/50'
        )}
      >
        <Glyph
          className={cn('size-3 shrink-0 opacity-80', THREAD_TINTS[session.threadType ?? 'chat'])}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] leading-5',
            selected ? 'text-foreground' : 'text-foreground/80'
          )}
        >
          {session.title}
        </span>
        <StatusDot status={session.status} />
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60 group-hover/row:opacity-0">
          {timeAgo(session.updatedAt)}
        </span>
      </button>
      <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Chat options"
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:text-foreground active:scale-95"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <Pencil className="size-3.5 text-muted-foreground" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              Delete chat…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${session.title.length > 32 ? `${session.title.slice(0, 32).trimEnd()}…` : session.title}?`}
        body="The chat and its whole transcript are gone for good."
        confirmLabel="Delete chat"
        onConfirm={() => deleteSession(session.id)}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  )
}

/** Loose chats outside any workspace (legacy unsorted sessions land here too). */
function ChatsGroup({ sessions }: { sessions: SessionMeta[] }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const selectProject = useApp((s) => s.selectProject)
  const createThread = useApp((s) => s.createThread)
  const reduce = useReducedMotion()

  const newChat = async (): Promise<void> => {
    selectProject(null)
    await createThread({ threadType: 'chat' })
    setOpen(true)
  }

  return (
    <div className="group/chats">
      <div className="flex h-7 items-center rounded-md pr-1 pl-1.5 hover:bg-accent/40">
        <button
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground/70 transition-transform',
              open && 'rotate-90'
            )}
          />
          <span className="truncate text-xs font-medium text-muted-foreground">Chats</span>
        </button>
        <button
          onClick={() => void newChat()}
          title="New chat"
          aria-label="New chat"
          className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:text-foreground active:scale-95 group-hover/chats:opacity-100"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && sessions.length > 0 && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className="overflow-hidden"
          >
            <div className="mt-0.5 space-y-px">
              {sessions.map((s) => (
                <ChatRow key={s.id} session={s} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
