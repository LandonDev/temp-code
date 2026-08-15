import { useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, FolderPlus, GitBranch, MoreHorizontal, Plus } from 'lucide-react'
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
import { ZIcon } from './zicon'
import { NewProjectDialog } from './NewProjectDialog'
import { WorkspaceRulesDialog } from './OrchestrationRules'

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
  const addWorkspace = useApp((s) => s.addWorkspace)
  const [newProjectWs, setNewProjectWs] = useState<WorkspaceMeta | null>(null)
  const [rulesWs, setRulesWs] = useState<WorkspaceMeta | null>(null)

  const unsorted = useMemo(() => unsortedSessions(sessions), [sessions])

  const pickWorkspace = async (): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) await addWorkspace(path)
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
              onRules={() => setRulesWs(ws)}
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

        {unsorted.length > 0 && <UnsortedGroup sessions={unsorted} />}
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
      {rulesWs && <WorkspaceRulesDialog workspace={rulesWs} onClose={() => setRulesWs(null)} />}
    </aside>
  )
}

function WorkspaceGroup({
  workspace,
  projects,
  sessions,
  onNewProject,
  onRules
}: {
  workspace: WorkspaceMeta
  projects: ProjectMeta[]
  sessions: Record<string, SessionMeta>
  onNewProject: () => void
  onRules: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const reduce = useReducedMotion()
  const removeWorkspace = useApp((s) => s.removeWorkspace)

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
              <DropdownMenuItem onClick={onRules}>Orchestration rules</DropdownMenuItem>
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
            <div className="mt-0.5 space-y-px">
              {projects.length === 0 ? (
                <button
                  onClick={onNewProject}
                  className="ml-4 flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                >
                  <Plus className="size-3" /> New project
                </button>
              ) : (
                projects.map((p) => <ProjectRow key={p.id} project={p} sessions={sessions} />)
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

  const threads = threadsOfProject(sessions, project.id)
  const busy = threads.find(
    (t) => t.status === 'running' || t.status === 'waiting' || t.status === 'error'
  )
  const latest = threads.at(-1)

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
  const reduce = useReducedMotion()

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full items-center gap-1.5 px-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/50 uppercase transition-colors hover:text-muted-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        Unsorted · {sessions.length}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className="overflow-hidden"
          >
            {sessions.map((s) => (
              <button
                key={s.id}
                onPointerDown={() => {
                  selectProject(null)
                  void select(s.id)
                }}
                className={cn(
                  'ml-4 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-left text-xs',
                  selectedId === s.id
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50'
                )}
              >
                <StatusDot status={s.status} />
                <span className="truncate">{s.title}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
