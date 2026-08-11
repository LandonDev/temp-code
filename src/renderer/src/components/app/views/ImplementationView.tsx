import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronRight, Circle } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import type { Block } from '../../../state/blocks'
import { cn } from '../../../lib/utils'
import { SPRING_LAYOUT } from '../../../lib/ease'
import { Spinner } from '../../ui/spinner'
import { BlockRow } from '../Transcript'
import { PromptBar } from '../PromptBar'

/**
 * Implementation thread: the todos ARE the view (docs/LAYOUT.md). Every
 * block belongs to the todo that was in_progress when it happened; the
 * running todo auto-expands and streams its steps, settled todos collapse
 * to one line. Until the agent posts a todo list, blocks flow as a plain
 * compact feed.
 */
export function ImplementationView({ session }: { session: SessionMeta }): React.JSX.Element {
  const todos = useApp((s) => s.todos[session.id]) ?? []
  const blocks = useApp((s) => s.blocks[session.id]) ?? []
  const running = session.status === 'running' || session.status === 'starting'

  const groups = useMemo(() => {
    const map = new Map<number, Block[]>()
    for (const b of blocks) {
      // The plan-tool calls themselves are the model, not content.
      if (b.kind === 'tool' && (b.name === 'TodoWrite' || b.name === 'update_plan')) continue
      const list = map.get(b.todo) ?? []
      list.push(b)
      map.set(b.todo, list)
    }
    return map
  }, [blocks])

  const active = todos.findIndex((t) => t.status === 'in_progress')
  const [manual, setManual] = useState<number | null>(null)
  // Work moved on — follow it again.
  useEffect(() => setManual(null), [active])
  const expanded = manual ?? active

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
  const done = todos.filter((t) => t.status === 'completed').length

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto select-text">
        <div className="mx-auto w-full max-w-3xl px-6 py-5">
          {goal && (
            <div className="mb-5">
              <p className="text-[15px] font-medium leading-snug tracking-[-0.01em]">
                {goal.kind === 'user' && goal.text.split('\n')[0]}
              </p>
              {todos.length > 0 && (
                <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                  {done}/{todos.length} done
                </p>
              )}
            </div>
          )}

          {todos.length === 0 ? (
            <div className="flex flex-col gap-2">
              {blocks
                .filter((b) => b.kind !== 'user')
                .map((b) => (
                  <BlockRow key={b.id} block={b} />
                ))}
              {running && (
                <div className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground">
                  <Spinner className="size-3.5" /> Breaking the task down…
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col">
              <SetupRow blocks={groups.get(-1) ?? []} />
              {todos.map((todo, i) => (
                <TodoRow
                  key={i}
                  index={i}
                  content={todo.content}
                  status={todo.status}
                  blocks={groups.get(i) ?? []}
                  expanded={expanded === i}
                  onToggle={() => setManual(expanded === i ? -2 : i)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <PromptBar compact />
    </>
  )
}

function SetupRow({ blocks }: { blocks: Block[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const content = blocks.filter((b) => b.kind !== 'user')
  if (content.length === 0) return null
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        Setup · {content.length} steps
      </button>
      {open && (
        <div className="ml-[5px] flex flex-col gap-1.5 border-l border-border/60 py-1 pl-4">
          {content.map((b) => (
            <BlockRow key={b.id} block={b} />
          ))}
        </div>
      )}
    </div>
  )
}

function TodoRow({
  index,
  content,
  status,
  blocks,
  expanded,
  onToggle
}: {
  index: number
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  blocks: Block[]
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const reduce = useReducedMotion()
  const running = status === 'in_progress'

  return (
    <div className="group">
      <button
        onClick={onToggle}
        disabled={blocks.length === 0 && !running}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left transition-colors',
          running ? 'text-foreground' : status === 'completed' ? 'text-muted-foreground' : 'text-muted-foreground/60',
          blocks.length > 0 && 'hover:bg-accent/40 active:scale-[0.997]'
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {running ? (
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
            running && 'font-medium',
            status === 'completed' && 'line-through decoration-border'
          )}
        >
          {content}
        </span>
        {blocks.length > 0 && !running && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100">
            {blocks.length} steps
          </span>
        )}
        {blocks.length > 0 && (
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted-foreground/40 transition-transform', expanded && 'rotate-90')}
          />
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && blocks.length > 0 && (
          <motion.div
            key={`trace-${index}`}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className="overflow-hidden"
          >
            <div className="mb-1.5 ml-[13px] flex flex-col gap-1.5 border-l border-border/60 py-1.5 pl-4">
              {blocks.map((b) =>
                b.kind === 'user' ? null : (
                  <div key={b.id} className={b.kind === 'assistant' ? 'text-muted-foreground' : undefined}>
                    <BlockRow block={b} />
                  </div>
                )
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
