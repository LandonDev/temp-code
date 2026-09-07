import { motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { EASE_OUT } from '../../lib/ease'

/**
 * The keyed page slide for a stepped question card: each step's body rides
 * in from the right as it becomes current. Pass as QuestionCard's
 * `renderPage`; the key is the step so React remounts (and re-slides) per
 * step instead of tweening the old body into the new one.
 */
export function slideQuestionPage(page: ReactNode, step: number): ReactNode {
  return <QuestionPageSlide key={step}>{page}</QuestionPageSlide>
}

export function QuestionPageSlide({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  )
}
