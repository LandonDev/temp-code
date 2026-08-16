import { useState } from 'react'
import { AnimatePresence, Reorder, useReducedMotion } from 'motion/react'
import { GripVertical, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { ZIcon } from './zicon'

/**
 * Messages waiting their turn, stacked above the composer. Each sends
 * automatically as turns settle, in order. Drag to reorder, click the
 * text to edit in place, ✕ removes, ↑ steers it into the running turn
 * right now (providers that can't steer send it next instead).
 */
export function MessageQueue({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const items = useApp((s) => s.queues[sessionId]) ?? []
  const queueReorder = useApp((s) => s.queueReorder)
  const queueRemove = useApp((s) => s.queueRemove)
  const queueUpdate = useApp((s) => s.queueUpdate)
  const queueSteer = useApp((s) => s.queueSteer)
  const [editing, setEditing] = useState<string | null>(null)
  const reduce = useReducedMotion()

  if (items.length === 0) return null

  return (
    <div className="mb-2">
      <p className="mb-1 px-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/60 uppercase">
        Queued · {items.length}
      </p>
      <Reorder.Group
        axis="y"
        values={items.map((m) => m.id)}
        onReorder={(order) => void queueReorder(sessionId, order as string[])}
        className="flex flex-col gap-1"
      >
        <AnimatePresence initial={false}>
          {items.map((m, ix) => (
            <Reorder.Item
              key={m.id}
              value={m.id}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
              className="group/q relative"
            >
              <div
                className={cn(
                  'flex items-start gap-1.5 rounded-lg border border-border/60 bg-card/70 py-1.5 pr-1.5 pl-1',
                  'shadow-[0_1px_2px_rgb(0_0_0/0.04)]'
                )}
              >
                <span className="mt-[3px] cursor-grab text-muted-foreground/40 active:cursor-grabbing">
                  <GripVertical className="size-3.5" />
                </span>
                {editing === m.id ? (
                  <textarea
                    autoFocus
                    defaultValue={m.text}
                    rows={Math.min(4, m.text.split('\n').length)}
                    onFocus={(e) =>
                      e.currentTarget.setSelectionRange(
                        e.currentTarget.value.length,
                        e.currentTarget.value.length
                      )
                    }
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        e.currentTarget.blur()
                      }
                      if (e.key === 'Escape') {
                        e.currentTarget.value = m.text
                        e.currentTarget.blur()
                      }
                    }}
                    onBlur={(e) => {
                      setEditing(null)
                      const v = e.target.value.trim()
                      if (v && v !== m.text) void queueUpdate(sessionId, m.id, v)
                    }}
                    className="min-w-0 flex-1 resize-none bg-transparent text-[12.5px] leading-5 outline-none"
                  />
                ) : (
                  <button
                    onClick={() => setEditing(m.id)}
                    title="Edit"
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="line-clamp-2 text-[12.5px] leading-5 text-muted-foreground">
                      <span className="mr-1.5 text-[10.5px] tabular-nums text-muted-foreground/50">
                        {ix + 1}
                      </span>
                      {m.text}
                    </span>
                  </button>
                )}
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/q:opacity-100">
                  <button
                    onClick={() => void queueSteer(sessionId, m.id)}
                    aria-label="Send now (steer)"
                    title="Send now — into the running turn"
                    className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95"
                  >
                    <ZIcon name="arrow-up" size={11} />
                  </button>
                  <button
                    onClick={() => void queueRemove(sessionId, m.id)}
                    aria-label="Remove from queue"
                    className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              </div>
            </Reorder.Item>
          ))}
        </AnimatePresence>
      </Reorder.Group>
    </div>
  )
}
