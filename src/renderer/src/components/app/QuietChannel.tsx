import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { activityLine } from '../../lib/activity'
import { SPRING_LAYOUT } from '../../lib/ease'
import { Spinner } from '../ui/spinner'
import { Transcript } from './Transcript'

/**
 * The quiet channel: a one-line strip above the prompt bar streaming a
 * session's latest utterance, expandable to the full transcript. The
 * non-chat views share it — orchestration (the orchestrator's narration)
 * and planning (the conversation) — so the hero surface keeps the room.
 */
export function QuietChannel({
  sessionId,
  label
}: {
  sessionId: string
  label: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const line = useApp((s) => activityLine(s.blocks[sessionId]))
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const running = status === 'running' || status === 'starting'
  const reduce = useReducedMotion()

  return (
    <div className="shrink-0 border-t border-border/60">
      <button
        onClick={() => setOpen(!open)}
        className="group flex h-8 w-full items-center gap-2 px-6 text-left transition-colors hover:bg-accent/30"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground',
            open && 'rotate-90'
          )}
        />
        <span className="shrink-0 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/60 uppercase">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{line ?? ''}</span>
        {running && <Spinner className="size-3 shrink-0 text-muted-foreground/50" />}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className="overflow-hidden"
          >
            <Transcript
              sessionId={sessionId}
              className="h-80 overflow-y-auto border-t border-border/40 select-text"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
