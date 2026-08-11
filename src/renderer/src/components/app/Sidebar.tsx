import { useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, FolderGit2, FolderPlus, GitBranch, MoreHorizontal, Plus } from 'lucide-react'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { threadsOfProject, unsortedSessions, useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { SPRING_LAYOUT } from '../../lib/ease'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { StatusDot, timeAgo } from './bits'
import { NewProjectDialog } from './NewProjectDialog'

/**
 * Workspaces → projects. The active project gets a shared-layout pill that
 * glides between rows (SPRING_LAYOUT); rows respond on pointer-down.
 */
export function Sidebar(): React.JSX.Element {
  const workspaces = useApp((s) => s.workspaces)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const connected = useApp((s) => s.connected)
  const addWorkspace = useApp((s) => s.addWorkspace)
  const [newProjectWs, setNewProjectWs] = useState<WorkspaceMeta | null>(null)

  const unsorted = useMemo(() => unsortedSessions(sessions), [sessions])

  const pickWorkspace = async (): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) await addWorkspace(path)
  }

  return (
    <aside className="flex w-[232px] shrink-0 flex-col bg-sidebar">
      {/* traffic-light strip */}
      <div className="titlebar-drag h-11 shrink-0" />

      <div className="flex-1 overflow-y-auto px-2 pb-2">
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
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground active:scale-[0.99]"
        >
          <FolderPlus className="size-[15px]" />
          Add workspace
        </button>

        {unsorted.length > 0 && <UnsortedGroup sessions={unsorted} />}
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border/60 px-3">
        <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-warning animate-pulse')} />
        <span className="text-[11px] text-muted-foreground">
          {connected ? 'Connected' : 'Reconnecting…'}
        </span>
      </div>

      {newProjectWs && (
        <NewProjectDialog workspace={newProjectWs} onClose={() => setNewProjectWs(null)} />
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
  const reduce = useReducedMotion()
  const removeWorkspace = useApp((s) => s.removeWorkspace)

  return (
    <div className="group/ws mt-1">
      <div className="flex items-center rounded-md px-1 py-1 hover:bg-accent/40">
        <button
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className="text-muted-foreground/70"
          >
            <ChevronRight className="size-3" />
          </motion.span>
          <FolderGit2 className="size-[13px] shrink-0 text-muted-foreground/70" />
          <span className="truncate text-xs font-medium text-muted-foreground">{workspace.name}</span>
        </button>
        <div className="flex items-center opacity-0 transition-opacity group-hover/ws:opacity-100">
          <button
            onClick={onNewProject}
            title="New project"
            aria-label="New project"
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground active:scale-95"
          >
            <Plus className="size-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Workspace options"
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuItem onClick={onNewProject}>New project</DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => void removeWorkspace(workspace.id)}
              >
                Remove workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className="overflow-hidden"
          >
            {projects.length === 0 ? (
              <button
                onClick={onNewProject}
                className="ml-5 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground"
              >
                <Plus className="size-3" /> New project
              </button>
            ) : (
              projects.map((p) => <ProjectRow key={p.id} project={p} sessions={sessions} />)
            )}
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

  const threads = threadsOfProject(sessions, project.id)
  const busy = threads.find((t) => t.status === 'running' || t.status === 'waiting' || t.status === 'error')
  const latest = threads.at(-1)

  return (
    <div className="group/row relative ml-3">
      {selected && (
        <motion.div
          layoutId="sidebar-active"
          transition={SPRING_LAYOUT}
          className="absolute inset-0 rounded-md bg-accent"
        />
      )}
      <button
        onPointerDown={() => selectProject(project.id)}
        className={cn(
          'relative flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left transition-transform active:scale-[0.99]',
          !selected && 'hover:bg-accent/50'
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-[13px]', selected ? 'text-foreground' : 'text-foreground/80')}>
              {project.name}
            </span>
            {busy && <StatusDot status={busy.status} />}
          </div>
          {project.branch && (
            <div className="mt-px flex items-center gap-1 text-[11px] text-muted-foreground/70">
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
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Project options"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem variant="destructive" onClick={() => void removeProject(project.id)}>
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/** Legacy sessions from before projects existed — kept reachable, out of the way. */
function UnsortedGroup({ sessions }: { sessions: SessionMeta[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const select = useApp((s) => s.select)
  const selectProject = useApp((s) => s.selectProject)
  const selectedId = useApp((s) => s.selectedId)

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/50 hover:text-muted-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        Unsorted · {sessions.length}
      </button>
      {open &&
        sessions.map((s) => (
          <button
            key={s.id}
            onPointerDown={() => {
              selectProject(null)
              void select(s.id)
            }}
            className={cn(
              'ml-3 flex w-[calc(100%-0.75rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
              selectedId === s.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
            )}
          >
            <StatusDot status={s.status} />
            <span className="truncate">{s.title}</span>
          </button>
        ))}
    </div>
  )
}
