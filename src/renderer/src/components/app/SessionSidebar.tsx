import { useState } from 'react'
import { Archive, ArchiveRestore, ChevronRight, MoreHorizontal, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { cn } from '../../lib/utils'
import { useApp } from '../../state/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Button } from '../ui/button'

const statusColor: Record<SessionMeta['status'], string> = {
  starting: 'bg-yellow-500',
  idle: 'bg-emerald-500',
  running: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
  done: 'bg-neutral-500'
}

function SessionRow({
  session,
  depth,
  onDelete
}: {
  session: SessionMeta
  depth: number
  onDelete: (s: SessionMeta) => void
}): React.JSX.Element {
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const setArchived = useApp((s) => s.setArchived)
  const restartSession = useApp((s) => s.restartSession)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div
      className={cn(
        'group flex w-full items-center gap-2 rounded-md pr-1 text-sm',
        selectedId === session.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      )}
    >
      <button
        onClick={() => void select(session.id)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', statusColor[session.status])} />
        <span className="truncate">{session.title}</span>
        <span className="ml-auto shrink-0 pr-1 text-xs text-muted-foreground">
          {session.provider}
        </span>
      </button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          {session.status === 'error' && (
            <DropdownMenuItem onClick={() => void restartSession(session.id)}>
              <RotateCcw className="size-3.5" /> Restart
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void setArchived(session.id, !session.archived)}>
            {session.archived ? (
              <>
                <ArchiveRestore className="size-3.5" /> Unarchive
              </>
            ) : (
              <>
                <Archive className="size-3.5" /> Archive
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => onDelete(session)}>
            <Trash2 className="size-3.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function SessionSidebar({ onNew }: { onNew: () => void }): React.JSX.Element {
  const sessions = useApp((s) => s.sessions)
  const connected = useApp((s) => s.connected)
  const deleteSession = useApp((s) => s.deleteSession)
  const [showArchived, setShowArchived] = useState(false)
  const [toDelete, setToDelete] = useState<SessionMeta | null>(null)

  const all = Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt)
  const active = all.filter((s) => !s.archived)
  const archived = all.filter((s) => s.archived)
  const roots = active.filter((s) => !s.parentId || !sessions[s.parentId])
  const childrenOf = (id: string): SessionMeta[] => active.filter((s) => s.parentId === id)

  const renderTree = (session: SessionMeta, depth: number): React.JSX.Element => (
    <div key={session.id}>
      <SessionRow session={session} depth={depth} onDelete={setToDelete} />
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
        {archived.length > 0 && (
          <div className="pt-2">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="flex w-full items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', showArchived && 'rotate-90')}
              />
              Archived ({archived.length})
            </button>
            {showArchived &&
              archived.map((s) => (
                <SessionRow key={s.id} session={s} depth={0} onDelete={setToDelete} />
              ))}
          </div>
        )}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-2 border-t px-3 text-xs text-muted-foreground">
        <span
          className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-yellow-500')}
        />
        {connected ? `${active.length} session${active.length === 1 ? '' : 's'}` : 'Reconnecting…'}
      </div>

      <Dialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              “{toDelete?.title}” and its transcript will be gone for good
              {toDelete && Object.values(sessions).some((s) => s.parentId === toDelete.id)
                ? ', along with its subagent sessions'
                : ''}
              .
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (toDelete) void deleteSession(toDelete.id)
                setToDelete(null)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
