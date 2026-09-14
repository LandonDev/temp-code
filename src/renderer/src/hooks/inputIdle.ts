import { useEffect, useState } from "react";

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"] as const;

/**
 * True once the window has seen no pointer or key input for `ms`, false
 * again on the next input. Off while `enabled` is false, and the clock
 * starts over each time it turns on: a pane that just came on screen
 * counts its `ms` from then, after the click or key that showed it.
 */
export function useInputIdle(ms: number, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    let timer = 0;
    const check = () => {
      const left = ms - (Date.now() - last);
      if (left > 0) {
        timer = window.setTimeout(check, left);
      } else {
        timer = 0;
        setIdle(true);
      }
    };
    // One timer per idle spell: input while it runs only moves `last`, and
    // the timer re-arms for the remainder when it fires.
    const onInput = () => {
      last = Date.now();
      if (!timer) {
        setIdle(false);
        timer = window.setTimeout(check, ms);
      }
    };
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }
    timer = window.setTimeout(check, ms);
    return () => {
      window.clearTimeout(timer);
      for (const type of INPUT_EVENTS) {
        window.removeEventListener(type, onInput, { capture: true });
      }
      setIdle(false);
    };
  }, [enabled, ms]);
  return enabled && idle;
}
