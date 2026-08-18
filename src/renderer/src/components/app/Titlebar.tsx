import { useState } from 'react'
import { PanelLeft, PanelRight, Pause } from 'lucide-react'
import { runningRoots, useApp } from '../../state/store'
import { cn } from '../../lib/utils'

/** With the sidebar hidden, the traffic lights sit over this strip:
 *  clear them, then offer the way back. */
function CollapsedLead(): React.JSX.Element {
  const setSidebarCollapsed = useApp((s) => s.setSidebarCollapsed)
  return (
    <button
      onClick={() => setSidebarCollapsed(false)}
      title="Show sidebar (⌘B)"
      aria-label="Show sidebar"
      className="ml-[68px] mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent/60 hover:text-foreground active:scale-95"
    >
      <PanelLeft className="size-[15px]" />
    </button>
  )
}

/** Stops every thread that is still working, wherever the user is. It
 *  shows only while something runs, so the strip stays quiet otherwise. */
function PauseAll(): React.JSX.Element | null {
  const sessions = useApp((s) => s.sessions)
  const pauseAllRunning = useApp((s) => s.pauseAllRunning)
  const running = runningRoots(sessions).length
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(0)

  if (running === 0) return null

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailed(0)
    try {
      const result = await pauseAllRunning()
      setFailed(result.failed.length)
    } catch {
      setFailed(running)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={() => void run()}
      disabled={busy}
      title={`Pause all ${running === 1 ? 'running thread' : `${running} running threads`}`}
      className={cn(
        'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition active:scale-95 disabled:active:scale-100',
        failed > 0
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
    >
      <Pause className="size-[13px]" strokeWidth={1.8} />
      {busy ? 'Pausing…' : failed > 0 ? 'Pause failed — retry' : 'Pause all'}
    </button>
  )
}

/**
 * The main column's top strip: breadcrumb left, rail toggle right.
 * (The traffic lights live over the sidebar, Cursor-style; the whole
 * strip drags the window.)
 */
export function Titlebar(): React.JSX.Element {
  const project = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId))
  // Projectless chat: the breadcrumb is the only place its title shows.
  const chat = useApp((s) =>
    !s.selectedProjectId && s.selectedId ? s.sessions[s.selectedId] : undefined
  )
  const workspace = useApp((s) =>
    s.workspaces.find((w) => w.id === (project?.workspaceId ?? chat?.workspaceId))
  )
  const cost = useApp((s) => (s.selectedId ? s.costs[s.selectedId] : undefined))
  const railOpen = useApp((s) => s.railOpen)
  const setRailOpen = useApp((s) => s.setRailOpen)
  const settingsOpen = useApp((s) => s.settingsOpen)
  const collapsed = useApp((s) => s.sidebarCollapsed)

  if (settingsOpen) {
    return (
      <header
        className={cn(
          'titlebar-drag flex h-[38px] shrink-0 items-center pt-0.5',
          collapsed ? 'pr-4 pl-0' : 'px-4'
        )}
      >
        {collapsed && <CollapsedLead />}
        <span className="text-[13px] font-medium">Settings</span>
        <div className="ml-auto flex items-center">
          <PauseAll />
        </div>
      </header>
    )
  }

  return (
    // Zeron titlebar: 38px, content sitting 2px lower.
    <header
      className={cn(
        'titlebar-drag flex h-[38px] shrink-0 items-center gap-1.5 pt-0.5',
        collapsed ? 'pr-4 pl-0' : 'px-4'
      )}
    >
      {collapsed && <CollapsedLead />}
      {workspace && <span className="text-[13px] text-muted-foreground">{workspace.name}</span>}
      {workspace && (project || chat) && (
        <span className="text-[13px] text-muted-foreground/50">/</span>
      )}
      {project ? (
        <span className="text-[13px] font-medium">{project.name}</span>
      ) : (
        chat && <span className="truncate text-[13px] font-medium">{chat.title}</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <PauseAll />
        {cost !== undefined && (
          <span className="text-[11px] tabular-nums text-muted-foreground">${cost.toFixed(2)}</span>
        )}
        {project && (
          <button
            onClick={() => setRailOpen(!railOpen)}
            className={cn(
              'flex size-6 items-center justify-center rounded-md transition active:scale-95',
              railOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
            title="Changes"
            aria-label="Toggle changes panel"
          >
            <PanelRight className="size-[15px]" />
          </button>
        )}
      </div>
    </header>
  )
}
