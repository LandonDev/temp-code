import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { usePaneVisible } from "../hooks/paneVisibility";

/** Tween a displayed count toward its target — 550ms ease-out cubic. The
 *  tween restarts from the value on screen, so a target that keeps moving
 *  reads as one continuous count. Off, it returns the target as is. */
export function useCountUp(target: number, animate: boolean): number {
  const [v, setV] = useState(0);
  const cur = useRef(0);
  const raf = useRef(0);
  const shown = usePaneVisible();
  const reduce = useReducedMotion() === true;
  const run = animate && shown && !reduce;
  useEffect(() => {
    if (!run) {
      cur.current = target;
      return;
    }
    if (cur.current === target) return;
    const start = cur.current;
    const t0 = performance.now();
    const tick = (now: number): void => {
      // rAF timestamps are frame-start times and can predate t0 — clamp low.
      const p = Math.min(1, Math.max(0, (now - t0) / 550));
      const eased = 1 - Math.pow(1 - p, 3);
      cur.current = Math.round(start + (target - start) * eased);
      setV(cur.current);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, run]);
  return run ? v : target;
}
