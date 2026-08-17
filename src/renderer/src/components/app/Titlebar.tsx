import { PanelRight } from 'lucide-react'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'

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

  if (settingsOpen) {
    return (
      <header className="titlebar-drag flex h-[38px] shrink-0 items-center px-4 pt-0.5">
        <span className="text-[13px] font-medium">Settings</span>
      </header>
    )
  }

  return (
    // Zeron titlebar: 38px, content sitting 2px lower.
    <header className="titlebar-drag flex h-[38px] shrink-0 items-center gap-1.5 px-4 pt-0.5">
      {workspace && (
        <span className="text-[13px] text-muted-foreground">{workspace.name}</span>
      )}
      {workspace && (project || chat) && (
        <span className="text-[13px] text-muted-foreground/50">/</span>
      )}
      {project ? (
        <span className="text-[13px] font-medium">{project.name}</span>
      ) : (
        chat && <span className="truncate text-[13px] font-medium">{chat.title}</span>
      )}
      <div className="ml-auto flex items-center gap-2">
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
