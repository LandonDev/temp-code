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

/** A phase of the working line, held by its key. */
export type KeyedPhase = { key: string; words: string };

/**
 * `useHeldWord` for a whole phase (surfaces/transcript/workingPhase.ts): its
 * key is held at least `holdMs` once painted, so a phase that lasted 40 ms
 * never shows; while the key the line shows is the current one, the current
 * phase shows at once with its new words (a count, a seconds figure, a new
 * sentence). `same` says when two phases of one key draw alike.
 */
export function useHeldPhase<T extends KeyedPhase>(phase: T, same: (a: T, b: T) => boolean, holdMs = WORD_HOLD_MS): T {
  const shownKey = useHeldWord(phase.key, holdMs);
  const [kept, setKept] = useState(phase);
  if (phase.key === shownKey && !same(kept, phase)) setKept(phase);
  return phase.key === shownKey || kept.key !== shownKey ? phase : kept;
}
