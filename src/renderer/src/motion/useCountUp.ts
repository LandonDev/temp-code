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
    if (!run) {
      current.current = target;
      return;
    }
    if (current.current === target) return;
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
