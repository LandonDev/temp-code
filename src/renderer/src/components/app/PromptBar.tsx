import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowUp, GitBranch, Square } from 'lucide-react'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { EASE_OUT, SPRING_SWAP } from '../../lib/ease'

/**
 * The composer: a floating rounded surface (the one docked element allowed
 * a shadow — it's a floating layer). Send morphs into Stop with a blur swap
 * while a turn runs; typing stays enabled (the harness queues messages).
 */
export function PromptBar({ compact }: { compact?: boolean }): React.JSX.Element | null {
  const selectedId = useApp((s) => s.selectedId)
  const session = useApp((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined))
  const project = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId))
  const send = useApp((s) => s.send)
  const interrupt = useApp((s) => s.interrupt)
  const [text, setText] = useState('')
  const reduce = useReducedMotion()

  if (!selectedId || !session) return null
  const running = session.status === 'running' || session.status === 'starting'

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    void send(selectedId, t)
  }

  return (
    <div className={cn('shrink-0 px-6 pb-3', compact ? 'pt-1' : 'pt-2')}>
      <div className="mx-auto w-full max-w-2xl">
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
                ? `Message ${session.model}…`
                : 'Steer or follow up…'
            }
            className="flex-1 resize-none self-center bg-transparent text-[13px] leading-5 outline-none placeholder:text-muted-foreground/70"
          />
          <button
            onClick={() => (running ? void interrupt(selectedId) : submit())}
            disabled={!running && !text.trim()}
            className={cn(
              'relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full transition-colors active:scale-90',
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
                    : { opacity: 0, scale: 0.5, filter: 'blur(4px)', transition: { duration: 0.12, ease: EASE_OUT } }
                }
                className="flex items-center justify-center"
              >
                {running ? <Square className="size-3 fill-current" /> : <ArrowUp className="size-4" />}
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
        <div className="flex h-6 items-center gap-3 px-1.5 pt-1.5 text-[11px] text-muted-foreground/70">
          {project?.branch && (
            <span className="flex items-center gap-1">
              <GitBranch className="size-2.5" />
              {project.branch}
            </span>
          )}
          <span className="truncate">{session.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
          <span className="ml-auto shrink-0">
            {session.model} · {session.reasoning}
          </span>
        </div>
      </div>
    </div>
  )
}
