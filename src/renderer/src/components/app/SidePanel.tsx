import { useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { SPRING_PANEL } from '../../lib/ease'
import { Spinner } from '../ui/spinner'
import { Transcript } from './Transcript'

const OPEN_W = 380
const RAIL_W = 36

/**
 * The log panel: a session's raw transcript docked on the right edge,
 * collapsed to a slim rail by default — the hero surface keeps the room,
 * the mechanics stay one click away. Orchestration docks the orchestrator's
 * stream here; implementation docks the agent's chat.
 */
export function SidePanel({
  sessionId,
  label
}: {
  sessionId: string
  label: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const running = status === 'running' || status === 'starting'
  const reduce = useReducedMotion()

  return (
    <motion.div
      animate={{ width: open ? OPEN_W : RAIL_W }}
      initial={false}
      transition={reduce ? { duration: 0 } : SPRING_PANEL}
      className="relative shrink-0 overflow-hidden border-l border-border/60"
    >
      {open ? (
        <div className="flex h-full flex-col" style={{ width: OPEN_W }}>
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-3">
            <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
              {label}
            </span>
            {running && <Spinner className="size-3 text-muted-foreground/50" />}
            <button
              onClick={() => setOpen(false)}
              aria-label={`Collapse ${label}`}
              className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95"
            >
              <PanelRightClose className="size-3.5" />
            </button>
          </div>
          <Transcript sessionId={sessionId} className="min-h-0 flex-1 select-text" />
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          title={label}
          aria-label={`Expand ${label}`}
          className="group flex h-full flex-col items-center gap-3 pt-2.5 transition-colors hover:bg-accent/30"
          style={{ width: RAIL_W }}
        >
          <PanelRightOpen className="size-4 text-muted-foreground/70 transition-colors group-hover:text-foreground" />
          <span
            className={cn(
              'text-[10px] font-medium tracking-[0.08em] text-muted-foreground/60 uppercase',
              'transition-colors group-hover:text-muted-foreground'
            )}
            style={{ writingMode: 'vertical-rl' }}
          >
            {label}
          </span>
          {running && <span className="size-1.5 animate-pulse rounded-full bg-success" />}
        </button>
      )}
    </motion.div>
  )
}
