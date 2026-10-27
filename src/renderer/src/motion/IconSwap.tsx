import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { FADE_OUT, SPRING_LAYOUT } from "../lib/ease";

/** One glyph replacing another in place (Copy → Check, idle → done): the new
 *  one grows from a quarter size on SPRING_LAYOUT, the old one leaves in
 *  --dur-fast. Reduced motion cross-fades. */
export function SwapIcon({ swapped, from, to }: { swapped: boolean; from: ReactNode; to: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={swapped ? "to" : "from"}
        className="grid place-items-center"
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25 }}
        animate={reduce ? { opacity: 1, transition: FADE_OUT.transition } : { opacity: 1, scale: 1, transition: SPRING_LAYOUT }}
        exit={reduce ? FADE_OUT : { opacity: 0, scale: 0.25, transition: FADE_OUT.transition }}
      >
        {swapped ? to : from}
      </motion.span>
    </AnimatePresence>
  );
}
