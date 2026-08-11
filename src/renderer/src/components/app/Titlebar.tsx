import { PanelRight } from 'lucide-react'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'

/**
 * The main column's top strip: breadcrumb left, rail toggle right.
 * (The traffic lights live over the sidebar, Cursor-style; the whole
 * strip drags the window.)
 */
export function Titlebar(): React.JSX.Element {
  const workspace = useApp((s) =>
    s.workspaces.find((w) => w.id === s.projects.find((p) => p.id === s.selectedProjectId)?.workspaceId)
  )
  const project = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId))
  const cost = useApp((s) => (s.selectedId ? s.costs[s.selectedId] : undefined))
  const railOpen = useApp((s) => s.railOpen)
  const setRailOpen = useApp((s) => s.setRailOpen)

  return (
    <header className="titlebar-drag flex h-11 shrink-0 items-center gap-1.5 px-4">
      {workspace && (
        <>
          <span className="text-[13px] text-muted-foreground">{workspace.name}</span>
          {project && (
            <>
              <span className="text-[13px] text-muted-foreground/50">/</span>
              <span className="text-[13px] font-medium">{project.name}</span>
            </>
          )}
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        {cost !== undefined && (
          <span className="text-[11px] tabular-nums text-muted-foreground">${cost.toFixed(2)}</span>
        )}
        {project && (
          <button
            onClick={() => setRailOpen(!railOpen)}
            className={cn(
              'flex size-6 items-center justify-center rounded-md transition-colors active:scale-95',
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
