import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { DUR, EASE_OUT, FADE_OUT } from "../lib/ease";

const ENTER = { opacity: 1, transform: "none", transition: { duration: DUR.base, ease: EASE_OUT } };
const LEAVE = { opacity: 0, transform: "translateY(-3px)", transition: FADE_OUT.transition };

/**
 * Words replacing words in place when a state changes (a row's verb or a
 * group's phrase changing tense: "Reading" → "Read"): the old words lift 3px
 * and fade over --dur-fast, the new rise from 3px below over --dur-base, as
 * one transform each. The width changes at once (the old words leave the
 * flow). Keyed by `state`, so text that changes under the same state (a
 * count, a streamed word) never animates, and nothing moves on mount.
 * Reduced motion cross-fades.
 */
export function SwapText({ state, children, className }: { state: string; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={state}
        data-swap-text={state}
        className={cn("inline-block", className)}
        initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(3px)" }}
        animate={reduce ? { opacity: 1, transition: FADE_OUT.transition } : ENTER}
        exit={reduce ? FADE_OUT : LEAVE}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}
