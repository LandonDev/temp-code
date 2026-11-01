import { useEffect, useRef, useState } from "react";

/** How long a word on the working line stays once it painted. */
export const WORD_HOLD_MS = 300;

/**
 * The word to show for a word that changes: a word that painted stays at
 * least `holdMs`, so a phase that lasted 40 ms never flashes. A word that
 * came and went inside the hold is skipped; when the hold ends the latest
 * word shows.
 */
export function useHeldWord(word: string, holdMs = WORD_HOLD_MS): string {
  const [shown, setShown] = useState(word);
  const paintedAt = useRef(0);
  useEffect(() => {
    paintedAt.current = Date.now();
  }, [shown]);
  useEffect(() => {
    if (word === shown) return;
    const wait = paintedAt.current + holdMs - Date.now();
    if (wait <= 0) {
      setShown(word);
      return;
    }
    const timer = setTimeout(() => setShown(word), wait);
    return () => clearTimeout(timer);
  }, [word, shown, holdMs]);
  return shown;
}
