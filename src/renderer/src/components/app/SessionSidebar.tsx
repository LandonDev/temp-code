import { Plus } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { cn } from '../../lib/utils'
import { useApp } from '../../state/store'

const statusColor: Record<SessionMeta['status'], string> = {
  starting: 'bg-yellow-500',
  idle: 'bg-emerald-500',
  running: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
  done: 'bg-neutral-500'
}

function SessionRow({ session, depth }: { session: SessionMeta; depth: number }): React.JSX.Element {
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  return (
    <button
      onClick={() => void select(session.id)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        selectedId === session.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      )}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', statusColor[session.status])} />
      <span className="truncate">{session.title}</span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{session.provider}</span>
    </button>
  )
}

export function SessionSidebar({ onNew }: { onNew: () => void }): React.JSX.Element {
  const sessions = useApp((s) => s.sessions)
  const all = Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt)
  const roots = all.filter((s) => !s.parentId)
  const childrenOf = (id: string): SessionMeta[] => all.filter((s) => s.parentId === id)

  const renderTree = (session: SessionMeta, depth: number): React.JSX.Element => (
    <div key={session.id}>
      <SessionRow session={session} depth={depth} />
      {childrenOf(session.id).map((c) => renderTree(c, depth + 1))}
    </div>
  )

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r">
      <div className="titlebar-drag flex h-12 items-center justify-between pr-2 pl-20">
        <span className="text-sm font-medium text-muted-foreground">Sessions</span>
        <button
          onClick={onNew}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New session"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {roots.map((s) => renderTree(s, 0))}
        {roots.length === 0 && (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">No sessions yet</p>
        )}
      </div>
    </aside>
  )
}
