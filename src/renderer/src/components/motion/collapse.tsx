import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { EASE_OUT } from '../../lib/ease'
import { cn } from '../../lib/utils'

/** Height-animated disclosure body. Fast (180ms) so frequent transcript
 *  expands never feel like waiting. */
export function Collapse({
  open,
  children,
  className
}: {
  open: boolean
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={reduce ? undefined : { height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
          className={cn('overflow-hidden', className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
