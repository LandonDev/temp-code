import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "motion/react";
import { usePaneVisible } from "../hooks/paneVisibility";
import { DUR, EASE_OUT } from "../lib/ease";

/** A displayed count ticking toward its target over DUR.slow on EASE_OUT.
 *  Each new target starts from the value on screen, so a count that keeps
 *  moving reads as one count. Off (reduced motion, a parked pane, `animate`
 *  false) it returns the target as is. */
export function useCountUp(target: number, animateOn: boolean): number {
  const [shownValue, setShownValue] = useState(0);
  const current = useRef(0);
  const shown = usePaneVisible();
  const reduce = useReducedMotion() === true;
  const run = animateOn && shown && !reduce;
  useEffect(() => {
    // Off, it returns the target and only notes it: no state, so a settled
    // row's count costs no render of its own.
    if (!run) {
      current.current = target;
      return;
    }
    // Back on with the count it already holds (a pane shown again): show that
    // count, never the 0 it started from.
    if (current.current === target) {
      setShownValue(target);
      return;
    }
    const controls = animate(current.current, target, {
      duration: DUR.slow,
      ease: EASE_OUT,
      onUpdate: (value) => {
        current.current = Math.round(value);
        setShownValue(current.current);
      },
    });
    return () => controls.stop();
  }, [target, run]);
  return run ? shownValue : target;
}
