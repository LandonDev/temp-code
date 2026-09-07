import { motion, useReducedMotion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { PanelRight } from '../../chrome/icons'
import { SPRING_PANEL } from '../../lib/ease'
import type { SessionStatus } from '../../lib/tcserver/types'
import { Spinner, StatusDot } from './bits'

const OPEN_W = 380
const RAIL_W = 36

/**
 * A log docked on the right edge, folded to a slim rail by default: the
 * hero surface keeps the room and the mechanics stay one click away.
 * The body stays mounted while folded (`inert` + `invisible absolute`) so
 * a streaming transcript keeps its scroll and never re-mounts.
 */
export function SidePanel({
  label,
  status,
  children
}: {
  label: string
  status?: SessionStatus
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion()
  const running = status === 'running' || status === 'starting'

  return (
    <motion.div
      initial={false}
      animate={{ width: open ? OPEN_W : RAIL_W }}
      transition={reduce ? { duration: 0 } : SPRING_PANEL}
      className="relative flex shrink-0 overflow-hidden border-l border-content/10"
    >
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={label}
          aria-label={`Expand ${label}`}
          className="group flex h-full flex-col items-center gap-3 pt-2.5 text-content/55 transition-colors hover:bg-content/5 hover:text-content"
          style={{ width: RAIL_W }}
        >
          <PanelRight className="size-4" strokeWidth={1.75} />
          <span
            className="text-[10px] font-medium tracking-[0.08em] uppercase transition-colors"
            style={{ writingMode: 'vertical-rl' }}
          >
            {label}
          </span>
          <StatusDot status={status} />
        </button>
      ) : null}
      <div
        inert={!open}
        style={{ width: OPEN_W }}
        className={`flex h-full flex-col ${open ? '' : 'invisible absolute inset-y-0 right-0'}`}
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-content/10 pr-1.5 pl-3">
          <span className="text-[10px] font-medium tracking-[0.08em] text-content/50 uppercase">
            {label}
          </span>
          {running ? <Spinner className="size-3 text-content/35" /> : null}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={`Collapse ${label}`}
            className="ml-auto flex size-6 items-center justify-center rounded-md text-content/55 transition hover:bg-content/5 hover:text-content active:scale-95"
          >
            <PanelRight className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </motion.div>
  )
}
