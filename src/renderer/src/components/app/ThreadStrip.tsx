import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Archive, ArchiveRestore, ChevronLeft, Pencil, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
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
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import { MatrixSpinner } from './WorkingStrip'
import { ConfirmDialog } from './ConfirmDialog'
import { OrchestrationTune } from './OrchestrationTune'
import type { ThreadRules } from '@shared/rules'
import { useNow } from '../../lib/useNow'
import { duration, THREAD_GLYPHS, THREAD_LABELS, THREAD_TINTS, timeAgo } from './bits'

/** Dialog titles stay one line — long thread names get elided. */
function clampTitle(t: string | undefined): string | undefined {
  if (!t) return t
  return t.length > 32 ? `${t.slice(0, 32).trimEnd()}…` : t
}

const TYPE_HINTS: Record<ThreadType, string> = {
  chat: 'Ask questions, explore the code',
  planning: 'Produce a plan document to implement from',
  implementation: 'Execute a task, todos in focus',
  orchestration: 'Spawn and direct subagents'
}

/** Tab-edge status, one glance apart (apple-design: things that mean
 *  different things must look different):
 *  working → the app's matrix-spinner motif + elapsed + what it's doing;
 *  needs you (approval/question) → amber "Needs you", in words;
 *  failed → red "Failed";
 *  plan written, no build started → violet "Plan ready";
 *  finished while you were elsewhere → blue dot + bold title (the mail
 *  idiom, applied by the caller); dormant → nothing, and the caller mutes
 *  the title so live tabs carry the eye. */
export function TabIndicator({
  status,
  unread,
  since,
  now,
  activity,
  activityKind,
  tasks,
  planReady
}: {
  status: SessionStatus
  unread: boolean
  /** when this working stretch began (its first message) */
  since: number
  now: number
  /** server-reported "where it's at" ("Editing PromptBar.tsx") */
  activity?: string | null
  /** tints the spinner: pink investigating, green editing, gray thinking */
  activityKind?: 'think' | 'investigate' | 'edit' | null
  /** implementation threads: this round's task tally */
  tasks?: { done: number; total: number } | null
  /** planning threads: plan written, awaiting a build */
  planReady?: boolean
}): React.JSX.Element | null {
  // An implementation thread's tally says more than any status word, so it
  // sits at the tab's edge in every state — done/total, never abbreviated.
  const tally = tasks ? (
    <span
      className={cn(
        'shrink-0 text-[10.5px] tabular-nums',
        tasks.done === tasks.total ? 'text-success' : 'text-muted-foreground/80'
      )}
      title={`${tasks.done} of ${tasks.total} tasks done`}
    >
      {tasks.done}/{tasks.total}
    </span>
  ) : null

  const body = ((): React.JSX.Element | null => {
    if (status === 'running' || status === 'starting') {
      const ms = now - since
      // Compact and still: tinted spinner (the color names the work-kind),
      // elapsed, and just the VERB of the activity. The elapsed time reads
      // whole — a clipped "5m 2…" is worse than a tab a few pixels wider.
      // The full "Editing PromptBar.tsx" lives in the tooltip; on a thread
      // that carries a tally the verb steps aside for it, since the
      // spinner's tint already names the kind of work.
      const verb = activity?.split(' ')[0] ?? ''
      return (
        <span className="flex shrink-0 items-center gap-1" title={activity ?? undefined}>
          <MatrixSpinner cell={1.8} tint={activityKind} />
          <span
            className={cn(
              'shrink-0 text-right text-[10.5px] whitespace-nowrap tabular-nums text-muted-foreground/60',
              ms < 3000 && 'opacity-0'
            )}
          >
            {duration(ms)}
          </span>
          {!tally && (
            <span className="w-14 shrink-0 truncate text-left text-[10.5px] text-muted-foreground/80">
              {verb}
            </span>
          )}
        </span>
      )
    }
    if (status === 'waiting')
      return (
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-warning">
          <span className="size-1.5 animate-pulse rounded-full bg-warning" />
          Needs you
        </span>
      )
    if (status === 'error')
      return <span className="shrink-0 text-[10.5px] font-medium text-destructive">Failed</span>
    if (planReady)
      return (
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-violet">
          <span className="size-1.5 rounded-full bg-violet" />
          Plan ready
        </span>
      )
    if (unread) return <span className="size-1.5 shrink-0 rounded-full bg-info" />
    return null
  })()

  if (!body && !tally) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {body}
      {tally}
    </span>
  )
}

/** Which idle planning threads have a WRITTEN plan awaiting a build.
 *  The strip peeks at each one's plan file on a slow poll (PlanView's
 *  idle cadence) — a bare planning thread that hasn't produced a document
 *  yet doesn't count. Starting a build archives the planning thread
 *  server-side, which drops it from the strip on its own. */
function usePlanReady(threads: SessionMeta[]): Record<string, boolean> {
  const readFile = useApp((s) => s.readFile)
  const [ready, setReady] = useState<Record<string, boolean>>({})
  const key = threads
    .filter((t) => t.threadType === 'planning' && t.status === 'idle' && t.planPath)
    .map((t) => t.id)
    .join(',')
  useEffect(() => {
    const ids = key ? key.split(',') : []
    if (ids.length === 0) {
      setReady({})
      return
    }
    let alive = true
    const poll = async (): Promise<void> => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          const path = useApp.getState().sessions[id]?.planPath
          const doc = path ? await readFile(path) : null
          return [id, !!doc?.trim()] as const
        })
      )
      if (alive) setReady(Object.fromEntries(entries))
    }
    void poll()
    const t = setInterval(() => void poll(), 8000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [key, readFile])
  return ready
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
  const activeSurface = useApp((s) =>
    s.selectedProjectId ? (s.activeSurface[s.selectedProjectId] ?? null) : null
  )
  const setActiveSurface = useApp((s) => s.setActiveSurface)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [tuning, setTuning] = useState<string | null>(null)
  const deleteSession = useApp((s) => s.deleteSession)
  const reduce = useReducedMotion()

  const threads = useMemo(() => threadsOfProject(sessions, projectId), [sessions, projectId])
  // Live tabs (working, needs-you, failed, unread) lead; dormant/read
  // threads settle on the shelf below, smaller and faded, so the strip's
  // left edge is always "what matters now". Unread stays in the live
  // group until it's been looked at. Being OPEN earns nothing — a
  // selected dormant thread stays on the shelf, just highlighted there.
  // A written plan awaiting its build holds the top row too.
  const planReady = usePlanReady(threads)
  const live = threads.filter(
    (t) => t.status !== 'idle' || t.updatedAt > (lastSeen[t.id] ?? 0) || planReady[t.id]
  )
  const dorm = threads.filter((t) => !live.includes(t))
  /** This pass's tally, for the threads whose work IS a task list. */
  const tasksOf = (t: SessionMeta): { done: number; total: number } | null =>
    t.threadType === 'implementation' ? (t.tasks ?? null) : null
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

  // File/diff surfaces live on their own bar (SurfaceStrip). While one is
  // active no thread tab is selected; clicking a thread takes the view back.
  const value = activeSurface ? '' : (selectedId ?? '')
  const onValue = (id: string): void => {
    if (!projectId) return
    setActiveSurface(projectId, null)
    void select(id)
  }

  return (
    <div className="shrink-0 border-b border-border/60">
      <div className="flex h-10 items-center gap-1 px-4">
      <Tabs
        value={value}
        onValueChange={onValue}
        variant="soft"
        className="flex min-w-0 items-center self-stretch overflow-x-auto [scrollbar-width:none]"
      >
        <TabsList className="h-full">
          <AnimatePresence initial={false} mode="popLayout">
            {live.map((t) => {
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
                            <span
                              className={cn(
                                'truncate',
                                // A working tab lends the indicator some of
                                // its title budget; the whole tab stays
                                // narrower than an idle one with this title.
                                t.status === 'running' || t.status === 'starting'
                                  ? 'max-w-32'
                                  : 'max-w-44',
                                // Unread reads like unread mail: bold, full
                                // color. Dormant tabs recede so live ones
                                // carry the eye.
                                unread && 'font-medium text-foreground'
                              )}
                            >
                              {t.title}
                            </span>
                            <TabIndicator
                              status={t.status}
                              unread={unread}
                              since={t.busySince ?? t.updatedAt}
                              now={now}
                              activity={t.activity}
                              activityKind={t.activityKind}
                              tasks={tasksOf(t)}
                              planReady={!!planReady[t.id]}
                            />
                          </TabsTrigger>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onClick={() => setRenaming(t.id)}>
                          <Pencil className="size-3.5 text-muted-foreground" />
                          Rename
                        </ContextMenuItem>
                        {t.threadType === 'orchestration' && (
                          <ContextMenuItem onClick={() => setTuning(t.id)}>
                            <SlidersHorizontal className="size-3.5 text-muted-foreground" />
                            Orchestration options…
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem onClick={() => archive(t.id)}>
                          <Archive className="size-3.5 text-muted-foreground" />
                          Archive
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onClick={() => setDeleting(t.id)}>
                          <Trash2 className="size-3.5" />
                          Delete…
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

      {/* The shelf: dormant threads live a line BELOW the working ones —
          smaller, grayscale, faded — and only climb back up by working,
          failing, needing you, or finishing unread. */}
      {dorm.length > 0 && (
        <div className="flex h-7 items-center gap-0.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          <AnimatePresence initial={false} mode="popLayout">
            {dorm.map((t) => {
              const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
              const open = !activeSurface && t.id === selectedId
              return (
                <motion.div
                  key={t.id}
                  layout
                  initial={reduce ? false : { opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduce ? undefined : { opacity: 0, scale: 0.92 }}
                  transition={SPRING_LAYOUT}
                >
                  {renaming === t.id ? (
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
                      className="h-[20px] w-36 rounded-[5px] bg-accent px-1.5 text-[11.5px] outline-none"
                    />
                  ) : (
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        onClick={() => onValue(t.id)}
                        onDoubleClick={() => setRenaming(t.id)}
                        className={cn(
                          'flex h-[20px] items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] transition active:scale-[0.98]',
                          open
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground/70 opacity-70 hover:bg-accent/60 hover:text-foreground hover:opacity-100'
                        )}
                      >
                        <Glyph
                          className={cn(
                            'size-3 shrink-0',
                            open
                              ? cn('opacity-80', THREAD_TINTS[t.threadType ?? 'chat'])
                              : 'opacity-60 grayscale'
                          )}
                        />
                        <span className="max-w-36 truncate">{t.title}</span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setRenaming(t.id)}>
                        <Pencil className="size-3.5 text-muted-foreground" />
                        Rename
                      </ContextMenuItem>
                      {t.threadType === 'orchestration' && (
                        <ContextMenuItem onClick={() => setTuning(t.id)}>
                          <SlidersHorizontal className="size-3.5 text-muted-foreground" />
                          Orchestration options…
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onClick={() => archive(t.id)}>
                        <Archive className="size-3.5 text-muted-foreground" />
                        Archive
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onClick={() => setDeleting(t.id)}>
                        <Trash2 className="size-3.5" />
                        Delete…
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      )}
      {tuning && (
        <TuneDialog
          key={tuning}
          session={sessions[tuning]}
          onClose={() => setTuning(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${clampTitle(deleting ? sessions[deleting]?.title : undefined) ?? 'thread'}?`}
        body="The thread and its whole transcript are gone for good. Archive keeps it instead."
        confirmLabel="Delete thread"
        onConfirm={async () => {
          if (!deleting) return
          if (selectedId === deleting) {
            const rest = threads.filter((t) => t.id !== deleting)
            void select(rest[0]?.id ?? null)
          }
          await deleteSession(deleting)
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

/** Recover archived threads: restore puts the tab back and opens it.
 *  Grows a search field once the shelf holds more than a screenful. */
function ArchivedShelf({ archived }: { archived: SessionMeta[] }): React.JSX.Element | null {
  const select = useApp((s) => s.select)
  const setArchived = useApp((s) => s.setArchived)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const reduce = useReducedMotion()

  if (archived.length === 0) return null

  const restore = async (id: string): Promise<void> => {
    if (archived.length === 1) setOpen(false)
    await setArchived(id, false)
    await select(id)
  }

  const q = query.trim().toLowerCase()
  const shown = q ? archived.filter((t) => t.title.toLowerCase().includes(q)) : archived

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
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
          Archived · {archived.length}
        </div>
        {archived.length > 6 && (
          <div className="relative px-1 pb-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3 -translate-y-[calc(50%+2px)] text-muted-foreground/50" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="h-7 pl-7.5 text-xs"
            />
          </div>
        )}
        <div className="max-h-80 overflow-y-auto">
          {shown.length === 0 && (
            <p className="px-2 py-3 text-center text-[11px] text-muted-foreground/60">
              No matches.
            </p>
          )}
          <AnimatePresence initial={false}>
            {shown.map((t) => {
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
        </div>
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
  const workspaceId = useApp(
    (s) => s.projects.find((p) => p.id === projectId)?.workspaceId ?? null
  )
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ThreadType | null>(null)
  // 'tune' swaps the popover into the orchestration options — same
  // surface, anchored where it came from; Back returns along that path.
  const [view, setView] = useState<'list' | 'tune'>('list')
  const [tune, setTune] = useState<ThreadRules>({})

  if (!catalog) return <span />

  // One click per type — provider/model/reasoning/security come from the
  // thread defaults (workspace override → global), resolved server-side.
  const create = async (type: ThreadType, threadRules?: ThreadRules): Promise<void> => {
    if (busy) return
    setBusy(type)
    try {
      await createThread({
        projectId,
        threadType: type,
        agentType: type === 'orchestration' ? 'orchestrator' : 'implementer',
        ...(threadRules && (threadRules.conduct || threadRules.instructions?.trim())
          ? { threadRules }
          : {})
      })
      setOpen(false)
    } finally {
      setBusy(null)
    }
  }

  const reset = (o: boolean): void => {
    setOpen(o)
    if (!o) {
      setView('list')
      setTune({})
    }
  }

  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>
        <button
          aria-label="New thread"
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95',
            empty && 'text-foreground',
            open && 'bg-accent text-foreground'
          )}
        >
          <Plus className="size-4" />
          {empty && <span className="text-[13px]">New thread</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn('gap-0 p-1', view === 'tune' ? 'w-80' : 'w-72')}>
        {view === 'tune' ? (
          <div className="p-2">
            <div className="mb-2 flex items-center gap-1">
              <button
                onClick={() => setView('list')}
                aria-label="Back"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-[13px] font-medium">Orchestration options</span>
            </div>
            <OrchestrationTune workspaceId={workspaceId} value={tune} onChange={setTune} />
            <button
              disabled={busy !== null}
              onClick={() => void create('orchestration', tune)}
              className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60"
            >
              {busy === 'orchestration' ? <Spinner className="size-3.5" /> : 'Start orchestration'}
            </button>
          </div>
        ) : (
          (Object.keys(THREAD_LABELS) as ThreadType[]).map((t) => {
            const Glyph = THREAD_GLYPHS[t]
            return (
              <div
                key={t}
                role="button"
                tabIndex={0}
                aria-disabled={busy !== null}
                onClick={() => busy === null && void create(t)}
                onKeyDown={(e) => e.key === 'Enter' && busy === null && void create(t)}
                className={cn(
                  'group/new flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-150 active:scale-[0.99]',
                  'hover:bg-accent',
                  busy !== null && 'pointer-events-none opacity-60'
                )}
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60',
                    'shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] transition-transform duration-150 group-hover/new:scale-105'
                  )}
                >
                  {busy === t ? (
                    <Spinner className="size-3.5 text-muted-foreground" />
                  ) : (
                    <Glyph className={cn('size-4', THREAD_TINTS[t])} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{THREAD_LABELS[t]}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    {TYPE_HINTS[t]}
                  </span>
                </span>
                {t === 'orchestration' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setView('tune')
                    }}
                    title="Instructions & rule overrides"
                    aria-label="Orchestration options"
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-hover/new:opacity-100 hover:bg-background/60 hover:text-foreground active:scale-95"
                  >
                    <SlidersHorizontal className="size-3.5" />
                  </button>
                )}
              </div>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}


/** Right-click → Orchestration options: edit a live thread's per-run tune.
 *  Saves apply on the next send (the harness reboots with the new prompt);
 *  spawn caps read rules per call and tighten immediately. */
function TuneDialog({
  session,
  onClose
}: {
  session: SessionMeta | undefined
  onClose: () => void
}): React.JSX.Element | null {
  const setThreadRules = useApp((s) => s.setThreadRules)
  const workspaceId = useApp((s) =>
    session?.projectId
      ? (s.projects.find((p) => p.id === session.projectId)?.workspaceId ?? null)
      : (session?.workspaceId ?? null)
  )
  const [tune, setTune] = useState<ThreadRules>(session?.threadRules ?? {})
  if (!session) return null
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[360px] gap-0 p-4">
        <DialogTitle className="text-[13.5px] font-medium">Orchestration options</DialogTitle>
        <p className="mt-0.5 mb-3 truncate text-[11.5px] text-muted-foreground">
          {session.title} — changes apply from the next message.
        </p>
        <OrchestrationTune workspaceId={workspaceId} value={tune} onChange={setTune} />
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="flex h-7 items-center rounded-lg px-3 text-[12.5px] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              void setThreadRules(
                session.id,
                tune.conduct || tune.instructions?.trim() ? tune : null
              )
              onClose()
            }}
            className="flex h-7 items-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90 active:scale-[0.98]"
          >
            Save
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
