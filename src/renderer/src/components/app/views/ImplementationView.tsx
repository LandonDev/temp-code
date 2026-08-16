import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { motion } from 'motion/react'
import { Check, Circle } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import type { Block } from '../../../state/blocks'
import { cn } from '../../../lib/utils'
import { useNow } from '../../../lib/useNow'
import { duration } from '../bits'
import { Spinner } from '../../ui/spinner'
import { ApprovalCard } from '../blocks/ApprovalCard'
import { QuestionCard } from '../blocks/QuestionCard'
import { ErrorChip, EDIT_TOOLS, splitEdit, ZEditCard } from '../blocks/ToolGroup'
import { MarkdownText } from '../blocks/MarkdownText'
import { SidePanel } from '../SidePanel'
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

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto select-text">
          <div className="mx-auto w-full max-w-3xl px-6 py-5">
            {goal ? (
              <div className="mb-5">
                <p className="text-[15px] leading-snug font-medium tracking-[-0.01em]">
                  {goal.kind === 'user' && goal.text.split('\n')[0]}
                </p>
                {todos.length > 0 && <ProgressSegments todos={todos} />}
                <ChangesLine session={session} />
              </div>
            ) : (
              !running && (
                <p className="pt-1 text-[13px] text-muted-foreground">Describe the task below.</p>
              )
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
                  return (
                    <TodoRow
                      key={i}
                      content={todo.content}
                      status={todo.status}
                      live={live}
                      ms={ms !== null && ms > 1500 ? ms : null}
                    />
                  )
                })}
              </div>
            )}

            {work.length > 0 && (
              <div className="flex flex-col gap-2">
                {work.map((b) =>
                  b.kind === 'approval' ? (
                    <ApprovalCard key={b.id} block={b} sessionId={session.id} />
                  ) : b.kind === 'question' ? (
                    <QuestionCard key={b.id} block={b} sessionId={session.id} />
                  ) : b.kind === 'error' ? (
                    <ErrorChip key={b.id} text={b.text} />
                  ) : (
                    <FreshEdit key={b.id} block={b as ToolBlock} />
                  )
                )}
              </div>
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
        <PromptBar compact />
      </div>

      <SidePanel sessionId={session.id} label="Chat" />
    </div>
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
