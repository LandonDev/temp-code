import { useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react'
import type { ThreadType } from '@shared/domain'
import type { SessionMeta, SessionStatus } from '@shared/events'
import { threadsOfProject, useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { SPRING_LAYOUT } from '../../lib/ease'
import { Tabs, TabsList, TabsTrigger } from '../motion/tabs'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { useNow } from '../../lib/useNow'
import { duration, THREAD_GLYPHS, THREAD_LABELS, THREAD_TINTS, timeAgo } from './bits'

const TYPE_HINTS: Record<ThreadType, string> = {
  chat: 'Ask questions, explore the code',
  planning: 'Produce a plan document to implement from',
  implementation: 'Execute a task, todos in focus',
  orchestration: 'Spawn and direct subagents'
}

/** Tab-edge status: what this thread is doing, or what it wants from you.
 *  Working → spinner; needs you (approval/question) → amber; failed → red;
 *  finished something while you were elsewhere → unread dot. */
function TabIndicator({
  status,
  unread,
  since,
  now
}: {
  status: SessionStatus
  unread: boolean
  /** when the thread started working (status → running transition) */
  since: number
  now: number
}): React.JSX.Element | null {
  if (status === 'running' || status === 'starting') {
    const ms = now - since
    return (
      <span className="flex shrink-0 items-center gap-1">
        <Spinner className="size-3 text-muted-foreground" />
        {ms >= 3000 && (
          <span className="text-[10.5px] tabular-nums text-muted-foreground/60">
            {duration(ms)}
          </span>
        )}
      </span>
    )
  }
  if (status === 'waiting')
    return <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
  if (status === 'error') return <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
  if (unread) return <span className="size-1.5 shrink-0 rounded-full bg-info" />
  return null
}

/**
 * Threads of the selected project as soft chip tabs, freshest activity
 * first — the active chip's accent wash glides between tabs, chips slide
 * closed when archived and glide when the order changes. Each tab wears
 * its thread's live status (TabIndicator); right-click renames or
 * archives; the shelf at the strip's end recovers archived threads
 * (Zeron: hidden, never deleted).
 */
export function ThreadStrip(): React.JSX.Element | null {
  const projectId = useApp((s) => s.selectedProjectId)
  const sessions = useApp((s) => s.sessions)
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const setArchived = useApp((s) => s.setArchived)
  const renameSession = useApp((s) => s.renameSession)
  const lastSeen = useApp((s) => s.lastSeen)
  const [renaming, setRenaming] = useState<string | null>(null)
  const reduce = useReducedMotion()

  const threads = useMemo(() => threadsOfProject(sessions, projectId), [sessions, projectId])
  const anyLive = threads.some((t) => t.status === 'running' || t.status === 'starting')
  const now = useNow(anyLive)
  const archived = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.projectId === projectId && !s.parentId && s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, projectId]
  )
  if (!projectId) return null

  const archive = (id: string): void => {
    // Archiving the open tab hands selection to its nearest neighbour.
    if (selectedId === id) {
      const rest = threads.filter((t) => t.id !== id)
      const at = threads.findIndex((t) => t.id === id)
      void select(rest[Math.min(Math.max(at, 0), rest.length - 1)]?.id ?? null)
    }
    void setArchived(id, true)
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-4">
      <Tabs
        value={selectedId ?? ''}
        onValueChange={(id) => void select(id)}
        variant="soft"
        className="flex min-w-0 items-center self-stretch overflow-x-auto [scrollbar-width:none]"
      >
        <TabsList className="h-full">
          <AnimatePresence initial={false} mode="popLayout">
            {threads.map((t) => {
              const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
              const unread = t.id !== selectedId && t.updatedAt > (lastSeen[t.id] ?? 0)
              return (
                <motion.div
                  key={t.id}
                  layout
                  initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
                  transition={SPRING_LAYOUT}
                >
                  {renaming === t.id ? (
                    // The tab itself becomes the editor — no dialog for a name.
                    <div className="flex h-[26px] items-center gap-1.5 rounded-md bg-accent px-2.5">
                      <Glyph
                        className={cn(
                          'size-[13px] shrink-0 opacity-80',
                          THREAD_TINTS[t.threadType ?? 'chat']
                        )}
                      />
                      <input
                        autoFocus
                        defaultValue={t.title}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') {
                            e.currentTarget.value = t.title
                            e.currentTarget.blur()
                          }
                        }}
                        onBlur={(e) => {
                          setRenaming(null)
                          const v = e.target.value.trim()
                          if (v && v !== t.title) void renameSession(t.id, v)
                        }}
                        className="w-40 bg-transparent text-[13px] outline-none"
                      />
                    </div>
                  ) : (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div onDoubleClick={() => setRenaming(t.id)}>
                          <TabsTrigger
                            value={t.id}
                            className="h-[26px] min-h-0 gap-1.5 px-2.5 py-0 font-normal"
                          >
                            <Glyph
                              className={cn(
                                'size-[13px] opacity-80',
                                THREAD_TINTS[t.threadType ?? 'chat']
                              )}
                            />
                            <span className="max-w-44 truncate">{t.title}</span>
                            <TabIndicator
                              status={t.status}
                              unread={unread}
                              since={t.updatedAt}
                              now={now}
                            />
                          </TabsTrigger>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onClick={() => setRenaming(t.id)}>
                          <Pencil className="size-3.5 text-muted-foreground" />
                          Rename
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => archive(t.id)}>
                          <Archive className="size-3.5 text-muted-foreground" />
                          Archive
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </TabsList>
      </Tabs>
      <NewThreadButton projectId={projectId} empty={threads.length === 0} />
      <div className="flex-1" />
      <ArchivedShelf archived={archived} />
    </div>
  )
}

/** Recover archived threads: restore puts the tab back and opens it. */
function ArchivedShelf({ archived }: { archived: SessionMeta[] }): React.JSX.Element | null {
  const select = useApp((s) => s.select)
  const setArchived = useApp((s) => s.setArchived)
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion()

  if (archived.length === 0) return null

  const restore = async (id: string): Promise<void> => {
    if (archived.length === 1) setOpen(false)
    await setArchived(id, false)
    await select(id)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="Archived threads"
          title="Archived threads"
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95',
            open && 'bg-accent text-foreground'
          )}
        >
          <Archive className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-0 p-1">
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/60">
          Archived
        </div>
        <AnimatePresence initial={false}>
          {archived.map((t) => {
            const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
            return (
              <motion.button
                key={t.id}
                layout
                exit={reduce ? undefined : { opacity: 0, height: 0 }}
                transition={SPRING_LAYOUT}
                onClick={() => void restore(t.id)}
                className="group/arch flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border">
                  <Glyph
                    className={cn('size-3.5 opacity-80', THREAD_TINTS[t.threadType ?? 'chat'])}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{t.title}</span>
                  <span className="block text-[11px] text-muted-foreground/60">
                    {timeAgo(t.updatedAt)}
                  </span>
                </span>
                {/* settle-on-hover: the restore affordance appears with the row */}
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/arch:opacity-100">
                  <ArchiveRestore className="size-3.5" />
                  Restore
                </span>
              </motion.button>
            )
          })}
        </AnimatePresence>
      </PopoverContent>
    </Popover>
  )
}

function NewThreadButton({
  projectId,
  empty
}: {
  projectId: string
  empty: boolean
}): React.JSX.Element {
  const catalog = useApp((s) => s.catalog)
  const createThread = useApp((s) => s.createThread)
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ThreadType>('chat')
  const [busy, setBusy] = useState(false)
  const reduce = useReducedMotion()

  if (!catalog) return <span />

  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      // Provider/model/reasoning/security come from the thread defaults
      // (workspace override → global), resolved server-side.
      await createThread({
        projectId,
        threadType: type,
        agentType: type === 'orchestration' ? 'orchestrator' : 'implementer'
      })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="New thread"
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95',
            empty && 'text-foreground'
          )}
        >
          <Plus className="size-4" />
          {empty && <span className="text-[13px]">New thread</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 rounded-xl p-2">
        <div className="flex flex-col gap-0.5">
          {(Object.keys(THREAD_LABELS) as ThreadType[]).map((t) => {
            const Glyph = THREAD_GLYPHS[t]
            return (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  'relative flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left active:scale-[0.99]',
                  type !== t && 'hover:bg-accent/50'
                )}
              >
                {type === t && (
                  <motion.span
                    layoutId="new-thread-type"
                    transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                    className="absolute inset-0 rounded-md bg-accent"
                  />
                )}
                <Glyph className={cn('relative mt-0.5 size-4 shrink-0', THREAD_TINTS[t])} />
                <span className="relative min-w-0">
                  <span className="block text-[13px] font-medium">{THREAD_LABELS[t]}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    {TYPE_HINTS[t]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-2 border-t border-border/60 pt-2">
          <Button
            size="sm"
            className="h-7 w-full text-xs"
            disabled={busy}
            onClick={() => void create()}
          >
            Create
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
