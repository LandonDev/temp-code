import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowUp, Square } from 'lucide-react'
import type { Reasoning } from '@shared/catalog'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { EASE_OUT, SPRING_SWAP } from '../../lib/ease'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

const REASONING_LABELS: Record<Reasoning, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
}

/**
 * The composer: a floating rounded surface (the one docked element allowed
 * a shadow — it's a floating layer). Send morphs into Stop with a blur swap
 * while a turn runs; typing stays enabled (the harness queues messages).
 *
 * Model and reasoning are per message, not per thread — the pickers below
 * the field ride along with each send.
 */
export function PromptBar({ compact }: { compact?: boolean }): React.JSX.Element | null {
  const selectedId = useApp((s) => s.selectedId)
  const session = useApp((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined))
  const catalog = useApp((s) => s.catalog)
  const send = useApp((s) => s.send)
  const interrupt = useApp((s) => s.interrupt)
  const [text, setText] = useState('')
  // Seeded from the session's last-used values; the component remounts per
  // thread (ThreadView is keyed), so this state is per thread.
  const [model, setModel] = useState(session?.model ?? '')
  const [reasoning, setReasoning] = useState<Reasoning>(session?.reasoning ?? 'medium')
  const reduce = useReducedMotion()

  if (!selectedId || !session) return null
  const running = session.status === 'running' || session.status === 'starting'
  const provider = catalog?.[session.provider]

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    void send(selectedId, t, { model: model || undefined, reasoning })
  }

  return (
    <div className={cn('shrink-0 px-6 pb-3', compact ? 'pt-1' : 'pt-2')}>
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            'flex items-end gap-2 rounded-xl border bg-popover shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_16px_rgb(0_0_0/0.06)] transition-shadow focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.05),0_6px_24px_rgb(0_0_0/0.09)]',
            compact ? 'px-3 py-1.5' : 'px-3.5 py-2.5'
          )}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={Math.min(8, Math.max(1, text.split('\n').length))}
            placeholder={
              session.threadType === 'chat' || !session.threadType
                ? 'Message…'
                : 'Steer or follow up…'
            }
            aria-label="Message"
            className="flex-1 resize-none self-center bg-transparent text-[13px] leading-5 outline-none placeholder:text-muted-foreground/70"
          />
          <button
            onClick={() => (running ? void interrupt(selectedId) : submit())}
            disabled={!running && !text.trim()}
            aria-label={running ? 'Stop' : 'Send'}
            className={cn(
              'relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full transition active:scale-95',
              running
                ? 'bg-foreground text-background'
                : text.trim()
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground'
            )}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={running ? 'stop' : 'send'}
                initial={reduce ? false : { opacity: 0, scale: 0.5, filter: 'blur(4px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', transition: SPRING_SWAP }}
                exit={
                  reduce
                    ? undefined
                    : {
                        opacity: 0,
                        scale: 0.5,
                        filter: 'blur(4px)',
                        transition: { duration: 0.12, ease: EASE_OUT }
                      }
                }
                className="flex items-center justify-center"
              >
                {running ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
        <div className="flex h-7 items-center pt-1">
          {provider && (
            <>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger
                  aria-label="Model"
                  className="h-6 gap-1 rounded-md border-0 bg-transparent py-0 pr-1 pl-1.5 text-[11px] text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-accent/50 [&_svg]:size-3"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {provider.models.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {provider.reasoning.length > 1 && (
                <Select value={reasoning} onValueChange={(v) => setReasoning(v as Reasoning)}>
                  <SelectTrigger
                    aria-label="Reasoning effort"
                    className="h-6 gap-1 rounded-md border-0 bg-transparent py-0 pr-1 pl-1.5 text-[11px] text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-accent/50 [&_svg]:size-3"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {provider.reasoning.map((r) => (
                      <SelectItem key={r} value={r} className="text-xs">
                        {REASONING_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
