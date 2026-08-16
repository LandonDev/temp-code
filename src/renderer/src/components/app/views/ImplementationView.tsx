import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronRight, Circle, MessageSquare } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import type { Block } from '../../../state/blocks'
import { cn } from '../../../lib/utils'
import { useNow } from '../../../lib/useNow'
import { EASE_OUT } from '../../../lib/ease'
import { duration, StatusDot } from '../bits'
import { Spinner } from '../../ui/spinner'
import { AgentDetail, AgentRow, useAgents } from '../AgentFleet'
import { ApprovalCard } from '../blocks/ApprovalCard'
import { QuestionCard } from '../blocks/QuestionCard'
import { editModel, ErrorChip, EDIT_TOOLS, splitEdit, ZEditCard } from '../blocks/ToolGroup'
import { MarkdownText } from '../blocks/MarkdownText'
import { Transcript } from '../Transcript'
import { WorkingStrip } from '../WorkingStrip'
import { PromptBar } from '../PromptBar'

type ToolBlock = Extract<Block, { kind: 'tool' }>

/**
 * Implementation thread: the CHANGES are the view. The hero surface shows
 * the plan (slim checklist), then every file change as an open diff card
 * streaming in as it happens — plus anything that needs the user (approvals,
 * errors) and the agent's closing report. All other mechanics (thinking,
 * reads, commands, prose) live in the chat panel docked on the right.
 */
export function ImplementationView({ session }: { session: SessionMeta }): React.JSX.Element {
  const todos = useApp((s) => s.todos[session.id]) ?? []
  const blocksRaw = useApp((s) => s.blocks[session.id])
  const blocks = useMemo(() => blocksRaw ?? [], [blocksRaw])
  const running = session.status === 'running' || session.status === 'starting'
  const waiting = session.status === 'waiting'

  // Subagents this thread spawned — the fleet rows render under the plan,
  // same surface orchestration uses, without displacing the change stream.
  const sessions = useApp((s) => s.sessions)
  const agents = useAgents(session.id)
  const [openAgentId, setOpenAgentId] = useState<string | null>(null)
  const anyAgentLive = agents.some((a) => a.status === 'running' || a.status === 'starting')
  const agentNow = useNow(anyAgentLive)
  const openAgent = openAgentId ? (sessions[openAgentId] ?? null) : null

  const allDone = todos.length > 0 && todos.every((t) => t.status === 'completed')
  // The agent's final report renders as the closing note under the work.
  const closing = useMemo(() => {
    const last = blocks.at(-1)
    return allDone && last?.kind === 'assistant' && !last.streaming && last.text.trim()
      ? last
      : null
  }, [blocks, allDone])

  // The hero stream: file changes, plus the blocks that demand the user.
  // Resolved approvals are history, not work — the chat panel keeps them.
  const work = useMemo(
    () =>
      blocks.filter(
        (b) =>
          // Bookkeeping-only edits (.temp-code/) aren't work to review.
          (b.kind === 'tool' && EDIT_TOOLS.has(b.name) && splitEdit(b).edits.length > 0) ||
          ((b.kind === 'approval' || b.kind === 'question') && !b.resolved) ||
          b.kind === 'error'
      ),
    [blocks]
  )

  // The breakdown: file each work item under the task that was in
  // progress when it was born (block.todo). Items from before the first
  // list — or when no list exists — group separately; indices past a
  // shrunken list clamp to the last task.
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set())
  const workByTodo = useMemo(() => {
    const m = new Map<number, Block[]>()
    for (const b of work) {
      const k = todos.length === 0 ? -1 : b.todo < 0 ? -1 : Math.min(b.todo, todos.length - 1)
      const arr = m.get(k)
      if (arr) arr.push(b)
      else m.set(k, [b])
    }
    return m
  }, [work, todos.length])
  const preWork = todos.length ? (workByTodo.get(-1) ?? []) : []
  const postWork = todos.length === 0 ? (workByTodo.get(-1) ?? []) : []

  // Per-todo wall clock, from block timestamps.
  const spans = useMemo(() => {
    const m = new Map<number, { first: number; last: number }>()
    for (const b of blocks) {
      if (b.ts === undefined) continue
      const s = m.get(b.todo)
      if (!s) m.set(b.todo, { first: b.ts, last: b.ts })
      else s.last = b.ts
    }
    return m
  }, [blocks])

  const active = todos.findIndex((t) => t.status === 'in_progress')
  const now = useNow(running && active !== -1)

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [session.id])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current && running) el.scrollTop = el.scrollHeight
  })

  const goal = blocks.find((b) => b.kind === 'user')

  // The view is phased like planning: a plain chat until there is a board
  // to show (tasks or subagents), then a draggable split — board left,
  // conversation right. The chat can fold to an edge bar; a thread stopped
  // on a question forces it open (render-time adjust, not an effect).
  const hasBoard = todos.length > 0 || agents.length > 0
  const [chatOpen, setChatOpen] = useState(true)
  const [sawWaiting, setSawWaiting] = useState(waiting)
  if (waiting !== sawWaiting) {
    setSawWaiting(waiting)
    if (waiting) setChatOpen(true)
  }
  const collapsed = hasBoard && !chatOpen

  // Board/chat split in %, draggable 30–70, double-click resets.
  const containerRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(50)
  const [dragging, setDragging] = useState(false)
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    setDragging(true)
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent): void => {
      setSplit(Math.min(70, Math.max(30, ((ev.clientX - rect.left) / rect.width) * 100)))
    }
    const up = (): void => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const reduce = useReducedMotion()

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1">
      <AnimatePresence initial={false}>
        {hasBoard && (
          <motion.div
            key="board"
            initial={reduce ? false : { flexBasis: '0%', opacity: 0 }}
            animate={{ flexBasis: collapsed ? '100%' : `${split}%`, opacity: 1 }}
            transition={dragging || reduce ? { duration: 0 } : { duration: 0.28, ease: EASE_OUT }}
            style={{ flexGrow: 0, flexShrink: 1 }}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          >
            <div ref={scrollRef} className="flex-1 overflow-y-auto select-text">
              <div className="mx-auto w-full max-w-3xl px-6 py-5">
                {goal && (
                  <div className="mb-5">
                    <p className="text-[15px] leading-snug font-medium tracking-[-0.01em]">
                      {goal.kind === 'user' && goal.text.split('\n')[0]}
                    </p>
                    {todos.length > 0 && <ProgressSegments todos={todos} />}
                    <ChangesLine session={session} />
                  </div>
                )}

                {agents.length > 0 && (
                  <div className="mb-5">
                    <p className="mb-1 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                      Subagents
                    </p>
                    <div className="-mx-3 flex flex-col gap-0.5">
                      {agents.map((agent) => (
                        <AgentRow
                          key={agent.id}
                          agent={agent}
                          now={agentNow}
                          hidden={openAgentId === agent.id}
                          onOpen={() => setOpenAgentId(agent.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* The breakdown: every action files under the task that was in
                progress when it happened. Settled tasks fold their work to
                a one-line summary; the live task streams open. */}
                {preWork.length > 0 && (
                  <div className="mb-4">
                    {todos.length > 0 && (
                      <p className="mb-1.5 text-[11px] font-medium tracking-[0.06em] text-muted-foreground/70 uppercase">
                        Setup
                      </p>
                    )}
                    <WorkItems blocks={preWork} sessionId={session.id} />
                  </div>
                )}

                {todos.length > 0 && (
                  <div className="mb-5 flex flex-col">
                    {todos.map((todo, i) => {
                      const span = spans.get(i)
                      const live = running && todo.status === 'in_progress'
                      const ms =
                        todo.status === 'pending' || !span
                          ? null
                          : live
                            ? now - span.first
                            : span.last - span.first
                      const items = workByTodo.get(i) ?? []
                      const needsUser = items.some(
                        (b) => (b.kind === 'approval' || b.kind === 'question') && !b.resolved
                      )
                      const folded = todo.status === 'completed' && !needsUser && !openGroups.has(i)
                      return (
                        <div key={i}>
                          <TodoRow
                            content={todo.content}
                            status={todo.status}
                            live={live}
                            ms={ms !== null && ms > 1500 ? ms : null}
                          />
                          {items.length > 0 &&
                            (folded ? (
                              <FoldedWork
                                blocks={items}
                                onOpen={() =>
                                  setOpenGroups((s) => {
                                    const next = new Set(s)
                                    next.add(i)
                                    return next
                                  })
                                }
                              />
                            ) : (
                              <div className="mt-1 mb-2 ml-[7px] border-l border-border/60 pt-0.5 pb-1 pl-4">
                                <WorkItems blocks={items} sessionId={session.id} />
                              </div>
                            ))}
                        </div>
                      )
                    })}
                  </div>
                )}

                {todos.length === 0 && postWork.length > 0 && (
                  <WorkItems blocks={postWork} sessionId={session.id} />
                )}

                {running && work.length === 0 && (
                  <div className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground">
                    <Spinner className="size-3.5" />
                    {todos.length === 0 ? 'Breaking the task down…' : 'Working…'}
                  </div>
                )}

                {closing && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="mt-6 border-t border-border/60 pt-4"
                  >
                    <MarkdownText text={closing.text} streaming={false} />
                  </motion.div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {hasBoard && !collapsed && (
        <div
          onPointerDown={startDrag}
          onDoubleClick={() => setSplit(50)}
          title="Drag to resize · double-click to reset"
          className={cn(
            'w-[3px] shrink-0 cursor-col-resize bg-hairline transition-colors hover:bg-border-strong',
            dragging && 'bg-border-strong'
          )}
        />
      )}

      {collapsed ? (
        <button
          onClick={() => setChatOpen(true)}
          title="Show conversation"
          aria-label="Show conversation"
          className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-hairline pt-4 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <MessageSquare className="size-3.5" />
          <StatusDot status={session.status} />
        </button>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hasBoard && (
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline pr-1.5 pl-4">
              <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                Conversation
              </span>
              <button
                onClick={() => setChatOpen(false)}
                title="Hide conversation"
                aria-label="Hide conversation"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          )}
          {/* No minimap in the side pane — it overlaps the text there. */}
          <Transcript sessionId={session.id} minimap={!hasBoard} />
          <WorkingStrip sessionId={session.id} />
          <PromptBar compact={hasBoard} narrow={hasBoard} />
        </div>
      )}

      <AnimatePresence>
        {openAgent && (
          <AgentDetail
            key={openAgent.id}
            agent={openAgent}
            parent={session}
            onClose={() => setOpenAgentId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** The work stream for one group, in birth order. */
function WorkItems({
  blocks,
  sessionId
}: {
  blocks: Block[]
  sessionId: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b) =>
        b.kind === 'approval' ? (
          <ApprovalCard key={b.id} block={b} sessionId={sessionId} />
        ) : b.kind === 'question' ? (
          <QuestionCard key={b.id} block={b} sessionId={sessionId} />
        ) : b.kind === 'error' ? (
          <ErrorChip key={b.id} text={b.text} />
        ) : (
          <FreshEdit key={b.id} block={b as ToolBlock} />
        )
      )}
    </div>
  )
}

/** A settled task's work, folded to its footprint — click to expand. */
function FoldedWork({
  blocks,
  onOpen
}: {
  blocks: Block[]
  onOpen: () => void
}): React.JSX.Element {
  let files = 0
  let adds = 0
  let dels = 0
  let errors = 0
  for (const b of blocks) {
    if (b.kind === 'error') errors++
    if (b.kind !== 'tool') continue
    for (const e of splitEdit(b).edits) {
      const m = editModel(e)
      files++
      adds += m.adds
      dels += m.dels
    }
  }
  return (
    <button
      onClick={onOpen}
      className="mb-1 ml-[7px] flex items-center gap-1.5 border-l border-border/60 py-0.5 pl-4 text-[11px] tabular-nums text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      <ChevronRight className="size-3" />
      {files} {files === 1 ? 'change' : 'changes'}
      {adds + dels > 0 && (
        <span>
          <span className="text-success">+{adds}</span>{' '}
          <span className="text-destructive">−{dels}</span>
        </span>
      )}
      {errors > 0 && <span className="text-destructive">{errors} errors</span>}
    </button>
  )
}

/** Edit cards land open — the diff IS the content here, not a detail.
 *  One card per file, never collapsed behind "+N more". */
function FreshEdit({ block }: { block: ToolBlock }): React.JSX.Element {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-2">
      {splitEdit(block).edits.map((eb) => (
        <ZEditCard key={eb.id} b={eb} defaultOpen />
      ))}
    </motion.div>
  )
}

/** One tick per todo — the progress reads as a shape, not a number. */
function ProgressSegments({
  todos
}: {
  todos: { status: 'pending' | 'in_progress' | 'completed' }[]
}): React.JSX.Element {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div
      className="mt-2.5 flex h-[3px] max-w-72 gap-[3px]"
      role="img"
      aria-label={`${done} of ${todos.length} tasks done`}
    >
      {todos.map((t, i) => (
        <span
          key={i}
          className={cn(
            'min-w-0 flex-1 rounded-full transition-colors duration-300',
            t.status === 'completed'
              ? 'bg-success'
              : t.status === 'in_progress'
                ? 'animate-pulse bg-success/35'
                : 'bg-border'
          )}
        />
      ))}
    </div>
  )
}

/** The blast radius: working-tree diffstat, click-through to the Changes rail. */
function ChangesLine({ session }: { session: SessionMeta }): React.JSX.Element | null {
  const changes = useApp((s) => (session.projectId ? s.changes[session.projectId] : undefined))
  const fetchChanges = useApp((s) => s.fetchChanges)
  const setRailOpen = useApp((s) => s.setRailOpen)
  const idle = session.status === 'idle'

  // Refresh when the turn settles — that's when edits have landed.
  useEffect(() => {
    if (session.projectId) void fetchChanges(session.projectId)
  }, [session.projectId, idle, fetchChanges])

  if (!changes?.length) return null
  const adds = changes.reduce((n, c) => n + c.adds, 0)
  const dels = changes.reduce((n, c) => n + c.dels, 0)
  return (
    <button
      onClick={() => setRailOpen(true)}
      className="mt-2 flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
    >
      {changes.length} {changes.length === 1 ? 'file' : 'files'}
      <span className="text-success">+{adds}</span>
      <span className="text-destructive">−{dels}</span>
    </button>
  )
}

/** Slim plan row: status glyph, title, wall clock. The work lives below —
 *  rows carry state, never traces. */
function TodoRow({
  content,
  status,
  live,
  ms
}: {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** in_progress AND the session is actually running — spinner-worthy */
  live: boolean
  ms: number | null
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 px-2 py-[5px]',
        live
          ? 'text-foreground'
          : status === 'completed'
            ? 'text-muted-foreground'
            : 'text-muted-foreground/60'
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {live ? (
          <Spinner className="size-3.5" />
        ) : status === 'completed' ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <Circle className="size-3 text-muted-foreground/40" />
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[13px]',
          live && 'font-medium',
          status === 'completed' && 'line-through decoration-border'
        )}
      >
        {content}
      </span>
      {ms !== null && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
          {duration(ms)}
        </span>
      )}
    </div>
  )
}
