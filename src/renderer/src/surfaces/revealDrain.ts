// UI-22: the seam between the stream's reveal and the turn's closing line.
import { createContext, useContext, useId, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Which turns still have text being revealed. A row that reveals streamed
 * text (AgentMarkdown) reports itself revealing from its first step until its
 * reveal has drained: every step painted and the last fade done (its
 * `settled`). The pacer may keep revealing a burst for a while after the host
 * settled the turn, so the turn's closing line asks here and waits: the
 * working line keeps its mark until the text is all shown, then morphs into
 * "Worked for …", and no closing line is ever drawn above text still
 * appearing (TurnEnd). Rows report under the turn they belong to, which the
 * transcript provides (`RevealTurnContext`, a row's turn key); outside a
 * transcript nothing is reported.
 */
const revealing = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

function report(turn: string, row: string, on: boolean): void {
  const rows = revealing.get(turn);
  if (on === !!rows?.has(row)) return;
  if (on) {
    if (rows) rows.add(row);
    else revealing.set(turn, new Set([row]));
  } else if (rows) {
    rows.delete(row);
    if (!rows.size) revealing.delete(turn);
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The key of the turn a transcript row belongs to (transcriptRows.ts `TurnInfo.id`). */
export const RevealTurnContext = createContext<string | null>(null);

/** A row's reveal reports itself: `on` from its first step until it has drained. Cleared at unmount. */
export function useReportReveal(on: boolean): void {
  const turn = useContext(RevealTurnContext);
  const row = useId();
  useLayoutEffect(() => {
    if (!turn) return undefined;
    report(turn, row, on);
    return () => report(turn, row, false);
  }, [turn, row, on]);
}

/** Whether any row of the turn is still revealing its text. */
export function useTurnRevealing(turn: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => revealing.has(turn),
    () => false,
  );
}

export const revealDrainForTest = {
  report,
  reset(): void {
    revealing.clear();
    for (const listener of [...listeners]) listener();
  },
};
