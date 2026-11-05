import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "../lib/cn";
import { DUR, EASE_OUT, EASE_SWAP, EASE_SWAP_CSS } from "../lib/ease";

// Full transform strings, so Motion hands the work to the compositor; the
// end value is explicit because Motion interpolates to a transform, never to "none".
const LEAVE = { opacity: 0, transform: "translateY(-3px)", transition: { duration: DUR.swapOut, ease: EASE_SWAP } };
const ARRIVE_FROM = { opacity: 0, transform: "translateY(3px)" };
const ARRIVE = { opacity: 1, transform: "translateY(0px)", transition: { duration: DUR.base, ease: EASE_SWAP } };
const FADE = { duration: DUR.fast, ease: EASE_OUT };

/**
 * Words replacing words in place when a state changes (a row's verb or a
 * group's phrase changing tense, the working line's phases): the old words
 * lift 3px and fade over --dur-swap-out, and only then do the new rise from
 * 3px below over --dur-base, both on --ease-swap, so two words are never
 * drawn in one place. While the new words arrive the box glides its width
 * from where it stood to theirs (a Web Animation on the one inline box, from
 * its live width when a glide is cut short), so they unroll left to right:
 * laid out at their own width and clipped by the box, never ellipsized
 * mid-glide (`data-gliding`).
 * Keyed by `state`: text that changes under the same state (a count, a
 * seconds figure, a streamed word) is drawn at once, and nothing moves on
 * mount. Reduced motion fades out, then in, over --dur-fast, with no
 * movement and no glide.
 */
export function MorphText({ state, children, className }: { state: string; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const box = useRef<HTMLSpanElement>(null);
  const shown = useRef(state);
  const held = useRef<number | null>(null);
  const glide = useRef<Animation | null>(null);

  // In the commit that changes the state the old words are still there: hold
  // the box at its live width (mid-glide included) while they leave.
  useLayoutEffect(() => {
    if (shown.current === state) return;
    shown.current = state;
    const el = box.current;
    if (!el || reduce) return;
    const width = el.getBoundingClientRect().width;
    glide.current?.cancel();
    glide.current = null;
    held.current = width;
    el.style.width = `${String(width)}px`;
  }, [state, reduce]);

  // The new words mounted (before paint): glide from the held width to theirs.
  const arrive = useCallback((node: HTMLSpanElement | null) => {
    const el = box.current;
    const from = held.current;
    if (!node || !el || from === null) return;
    held.current = null;
    el.style.width = "";
    const to = el.getBoundingClientRect().width;
    if (Math.abs(to - from) < 0.5 || typeof el.animate !== "function") return;
    const animation = el.animate([{ width: `${String(from)}px` }, { width: `${String(to)}px` }], {
      duration: DUR.base * 1000,
      easing: EASE_SWAP_CSS,
    });
    glide.current = animation;
    // While it glides the new words keep their own width and the box clips
    // them, so they unroll; truncated to the box they would show an ellipsis
    // that moves (components.css, [data-gliding]).
    el.dataset.gliding = "";
    const done = () => {
      if (glide.current !== animation) return;
      glide.current = null;
      delete el.dataset.gliding;
    };
    animation.onfinish = done;
    animation.oncancel = done;
  }, []);

  useEffect(() => () => glide.current?.cancel(), []);

  return (
    <span ref={box} data-slot="morph-text" className={cn("inline-flex min-w-0 overflow-clip whitespace-nowrap", className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state}
          ref={arrive}
          data-morph-key={state}
          className="block min-w-0 truncate"
          initial={reduce ? { opacity: 0 } : ARRIVE_FROM}
          animate={reduce ? { opacity: 1, transition: FADE } : ARRIVE}
          exit={reduce ? { opacity: 0, transition: FADE } : LEAVE}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
