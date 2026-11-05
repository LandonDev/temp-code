import { useEffect, useState } from "react";
import { FOLD_HOLD_MS } from "./ease";

/**
 * Whether a fold that opens on its own still holds open: while `working`,
 * and for FOLD_HOLD_MS after it stops, so the last step's settle shows
 * before the fold closes (the transcript's working group, the master
 * board's task list). Decided during render, so the frame `working` turns
 * false on never starts a fold; a fold mounted settled never holds.
 */
export function useFoldHold(working: boolean): boolean {
  const [held, setHeld] = useState(false);
  const [was, setWas] = useState(working);
  if (was !== working) {
    setWas(working);
    setHeld(!working);
  }
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), FOLD_HOLD_MS);
    return () => clearTimeout(timer);
  }, [held]);
  return working || held;
}
