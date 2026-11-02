import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { FADE_OUT, SPRING_LAYOUT } from "../lib/ease";

type SwapIconProps =
  /** Two glyphs: `to` while `swapped`, else `from`. */
  | { swapped: boolean; from: ReactNode; to: ReactNode; state?: undefined; children?: undefined }
  /** Any number: the glyph swaps whenever `state` changes (a tool row's
   *  waiting, working, failed and icon). */
  | { state: string; children: ReactNode; swapped?: undefined; from?: undefined; to?: undefined };

/** One glyph replacing another in place (Copy → Check, a call settling): the
 *  new one grows from a quarter size on SPRING_LAYOUT, the old one leaves in
 *  --dur-fast, both as one transform. Nothing moves on the first render.
 *  Reduced motion cross-fades. */
export function SwapIcon(props: SwapIconProps) {
  const reduce = useReducedMotion();
  const keyed = props.state !== undefined;
  const key = keyed ? props.state : props.swapped ? "to" : "from";
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={key}
        data-swap={keyed ? key : undefined}
        className="grid place-items-center"
        initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "scale(0.25)" }}
        animate={reduce ? { opacity: 1, transition: FADE_OUT.transition } : { opacity: 1, transform: "none", transition: SPRING_LAYOUT }}
        exit={reduce ? FADE_OUT : { opacity: 0, transform: "scale(0.25)", transition: FADE_OUT.transition }}
      >
        {keyed ? props.children : props.swapped ? props.to : props.from}
      </motion.span>
    </AnimatePresence>
  );
}
