import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderPlus,
  GitBranch,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import {
  chatsOfWorkspace,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  threadsOfProject,
  unsortedSessions,
  useApp
} from '../../state/store'
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
 * Workspaces → projects, one flat left edge: workspace headers carry the
 * repo's own logo, project rows sit flush below them at the same x and
 * say what their tabs are up to. The bar drag-resizes at its right edge
 * (rubber-banding past its limits) and collapses — drag it shut or ⌘B.
 */

/** Dragging below this raw width snaps the bar closed. */
const COLLAPSE_AT = 130

/** Progressive resistance past the min/max — the bar slows, never walls. */
const rubberband = (over: number): number => (over * 300 * 0.55) / (300 + 0.55 * over)
const rubber = (raw: number): number =>
  raw > SIDEBAR_MAX
    ? SIDEBAR_MAX + rubberband(raw - SIDEBAR_MAX)
    : raw < SIDEBAR_MIN
      ? SIDEBAR_MIN - rubberband(SIDEBAR_MIN - raw)
      : raw

export function Sidebar(): React.JSX.Element {
  const workspaces = useApp((s) => s.workspaces)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const connected = useApp((s) => s.connected)
  const settingsOpen = useApp((s) => s.settingsOpen)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const width = useApp((s) => s.sidebarWidth)
  const collapsed = useApp((s) => s.sidebarCollapsed)
  const setSidebarWidth = useApp((s) => s.setSidebarWidth)
  const setSidebarCollapsed = useApp((s) => s.setSidebarCollapsed)
  const [dragging, setDragging] = useState(false)
  const reduce = useReducedMotion()
  const [newProjectWs, setNewProjectWs] = useState<WorkspaceMeta | null>(null)
  const [newWorkspacePath, setNewWorkspacePath] = useState<string | null>(null)

  const unsorted = useMemo(() => unsortedSessions(sessions), [sessions])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        const s = useApp.getState()
        s.setSidebarCollapsed(!s.sidebarCollapsed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pickWorkspace = async (): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) setNewWorkspacePath(path)
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      // capture is best-effort; tracking still works while over the handle
    }
    const startX = e.clientX
    const startW = useApp.getState().sidebarWidth
    let raw = startW
    setDragging(true)
    const onMove = (ev: PointerEvent): void => {
      raw = startW + (ev.clientX - startX)
      setSidebarWidth(rubber(raw))
    }
    const onUp = (): void => {
      setDragging(false)
      handle.removeEventListener('pointermove', onMove)
      if (raw < COLLAPSE_AT) {
        // Snap shut; reopening restores the pre-drag width.
        setSidebarCollapsed(true)
        setSidebarWidth(startW)
      } else {
        setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw)))
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp, { once: true })
    handle.addEventListener('pointercancel', onUp, { once: true })
  }

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 0 : width }}
      transition={dragging || reduce ? { duration: 0 } : SPRING_LAYOUT}
      className={cn(
        'relative shrink-0 overflow-hidden bg-sidebar',
        !collapsed && 'border-r border-border/60'
      )}
    >
      {/* Content keeps its width while the bar animates, so it slides, not squishes. */}
      <div className="flex h-full flex-col" style={{ width }}>
        {/* traffic-light strip; the hide control lives here, Finder-style */}
        <div className="titlebar-drag group/strip relative h-11 shrink-0">
          <button
            onClick={() => setSidebarCollapsed(true)}
            title="Hide sidebar (⌘B)"
            aria-label="Hide sidebar"
            className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent/60 hover:text-foreground active:scale-95 group-hover/strip:opacity-100"
          >
            <PanelLeft className="size-[15px]" />
          </button>
        </div>

        {/* layoutRoot scopes the active pill's shared-layout measurement to the
            sidebar; layoutScroll folds this element's scroll offset into it —
            without both, the pill's flight replays stale page/scroll deltas. */}
        <motion.div layoutRoot layoutScroll className="flex-1 space-y-3 overflow-y-auto px-2 pb-2">
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
              className="mt-1 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground active:scale-[0.99]"
            >
              <FolderPlus className="size-3.5 shrink-0 opacity-80" />
              Add workspace
            </button>
          </div>

          <ChatsGroup sessions={unsorted} />
        </motion.div>

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
      </div>

      {/* resize handle: 1:1 drag, double-click resets */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        className={cn(
          'absolute inset-y-0 right-0 z-10 w-[3px] cursor-col-resize transition-colors hover:bg-border',
          dragging && 'bg-border'
        )}
      />

      {newProjectWs && (
        <NewProjectDialog workspace={newProjectWs} onClose={() => setNewProjectWs(null)} />
      )}
      {newWorkspacePath && (
        <NewWorkspaceDialog path={newWorkspacePath} onClose={() => setNewWorkspacePath(null)} />
      )}
    </motion.aside>
  )
}

/** The repo's own face: favicon/avatar image, else its git host's mark. */
function WorkspaceLogo({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const icon = useApp((s) => s.workspaceIcons[workspaceId])
  if (icon?.dataUrl)
    return (
      <img
        src={icon.dataUrl}
        alt=""
        className="size-[18px] shrink-0 rounded-[4px] object-cover"
      />
    )
  if (icon?.host === 'github')
    return <ZIcon name="github-mark" size={16} className="shrink-0 text-foreground/70" />
  if (icon?.host === 'gitlab')
    return <ZIcon name="gitlab-mark" size={16} className="shrink-0 text-foreground/70" />
  return <ZIcon name="folder" size={16} className="shrink-0 text-muted-foreground/80" />
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
    <div className="group/ws mt-2 first:mt-0">
      <div className="flex h-8 items-center rounded-md pr-1 pl-2 hover:bg-accent/40">
        <button
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
        >
          <WorkspaceLogo workspaceId={workspace.id} />
          <span className="truncate text-[13px] font-semibold text-foreground/90">
            {workspace.name}
          </span>
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className={cn(
              'flex size-3 shrink-0 items-center justify-center text-muted-foreground/70 transition-opacity',
              open && 'opacity-0 group-hover/ws:opacity-100'
            )}
          >
            <ChevronRight className="size-3" />
          </motion.span>
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
            // Clip only while the fold animates: a permanent overflow-hidden
            // would clip the active pill's flight in from another workspace.
            initial={reduce ? false : { height: 0, opacity: 0, overflow: 'hidden' }}
            animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
            exit={reduce ? undefined : { height: 0, opacity: 0, overflow: 'hidden' }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
          >
            <div className="mt-0.5 space-y-px">
              {active.length === 0 && chats.length === 0 && archived.length === 0 ? (
                <button
                  onClick={onNewProject}
                  className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground"
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

/** One colored count in a project's tab summary. */
function Stat({
  dot,
  tint,
  pulse,
  count,
  word
}: {
  dot: string
  tint: string
  pulse?: boolean
  count: number
  word: string
}): React.JSX.Element {
  return (
    <span className={cn('flex shrink-0 items-center gap-1', tint)}>
      <span className={cn('size-1.5 rounded-full', dot, pulse && 'animate-pulse')} />
      {count} {word}
    </span>
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
  const selectedId = useApp((s) => s.selectedId)
  const lastSeen = useApp((s) => s.lastSeen)
  const selectProject = useApp((s) => s.selectProject)
  const removeProject = useApp((s) => s.removeProject)
  const archiveProject = useApp((s) => s.archiveProject)
  const renameProject = useApp((s) => s.renameProject)
  const [renaming, setRenaming] = useState(false)
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null)

  const threads = threadsOfProject(sessions, project.id)
  const archivedCount = useMemo(
    () =>
      Object.values(sessions).filter((s) => s.projectId === project.id && !s.parentId && s.archived)
        .length,
    [sessions, project.id]
  )
  const latest = threads.reduce<number>((a, t) => Math.max(a, t.updatedAt), 0)

  // The tab states that matter, loudest first: running, waiting on the
  // user, failed, finished-but-unseen. Everything else is dormant and only
  // counts toward the muted total.
  const running = threads.filter((t) => t.status === 'running' || t.status === 'starting').length
  const waiting = threads.filter((t) => t.status === 'waiting').length
  const failed = threads.filter((t) => t.status === 'error').length
  const unread = threads.filter(
    (t) =>
      (t.status === 'idle' || t.status === 'done') &&
      t.id !== selectedId &&
      t.updatedAt > (lastSeen[t.id] ?? 0)
  ).length

  if (renaming) {
    // The row itself becomes the editor — no dialog for a name.
    return (
      <div className="flex items-center rounded-md bg-accent px-2 py-1.5">
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
    <div className="group/row relative">
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
        title={[
          running > 0 && `${running} running`,
          waiting > 0 && `${waiting} waiting on you`,
          failed > 0 && `${failed} failed`,
          unread > 0 && `${unread} unread`,
          `${threads.length} open ${threads.length === 1 ? 'tab' : 'tabs'}`,
          archivedCount > 0 && `${archivedCount} archived`
        ]
          .filter(Boolean)
          .join(' · ')}
        className={cn(
          'relative flex w-full flex-col gap-[3px] rounded-md px-2 py-2 text-left',
          !selected && 'hover:bg-accent/50'
        )}
      >
        <div className="flex w-full items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] leading-5',
              selected ? 'text-foreground' : 'text-foreground/80'
            )}
          >
            {project.name}
          </span>
          {latest > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60 group-hover/row:opacity-0">
              {timeAgo(latest)}
            </span>
          )}
        </div>

        <div className="flex w-full items-center gap-1 text-[11px] leading-4 text-muted-foreground/70">
          <GitBranch className="size-2.5 shrink-0" />
          <span className="truncate">{project.branch ?? 'local checkout'}</span>
          <span className="shrink-0 text-muted-foreground/50">
            · {project.mode === 'worktree' ? 'worktree' : 'local'}
          </span>
        </div>

        <div className="flex w-full items-center gap-2 text-[11px] leading-4 tabular-nums">
          {running > 0 && (
            <Stat dot="bg-success" tint="text-success" pulse count={running} word="running" />
          )}
          {waiting > 0 && (
            <Stat dot="bg-warning" tint="text-warning" pulse count={waiting} word="need you" />
          )}
          {failed > 0 && (
            <Stat dot="bg-destructive" tint="text-destructive" count={failed} word="failed" />
          )}
          {unread > 0 && <Stat dot="bg-info" tint="text-info" count={unread} word="unread" />}
          <span className="truncate text-muted-foreground/60">
            {threads.length === 0
              ? 'No tabs'
              : `${threads.length} ${threads.length === 1 ? 'tab' : 'tabs'}`}
            {archivedCount > 0 && ` · ${archivedCount} archived`}
          </span>
        </div>
      </button>
      <div className="absolute top-2 right-1.5 opacity-0 transition-opacity group-hover/row:opacity-100">
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
    <div>
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
      <div className="flex h-7 items-center rounded-md bg-accent px-2">
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
    <div className="group/row relative">
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
          'relative flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left',
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
      <div className="flex h-8 items-center rounded-md pr-1 pl-2 hover:bg-accent/40">
        <button
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="truncate text-[13px] font-semibold text-foreground/90">Chats</span>
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground/70 transition-transform',
              open && 'rotate-90 opacity-0 group-hover/chats:opacity-100'
            )}
          />
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
            // Same as the workspace fold: clip only while animating so the
            // active pill can fly across group boundaries unclipped.
            initial={reduce ? false : { height: 0, opacity: 0, overflow: 'hidden' }}
            animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
            exit={reduce ? undefined : { height: 0, opacity: 0, overflow: 'hidden' }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
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
