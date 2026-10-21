/**
 * Where a transcript's reader was when its pane unmounted (a tab parked
 * long enough to leave the warm set). A transcript that was following the
 * bottom stores nothing: a fresh mount lands there anyway.
 */
import type { RowAnchor } from "./transcriptWindow";

export type TranscriptScrollMemory = {
  /** The row at the top edge of the viewport and how far into it the edge
   *  sat (lib/transcriptWindow.ts `RowAnchor`), so the place survives the
   *  heights being estimates again on the next mount. */
  anchor: RowAnchor;
};

const memory = new Map<string, TranscriptScrollMemory>();

export function saveTranscriptScroll(
  sessionId: string,
  entry: TranscriptScrollMemory | null,
): void {
  if (!sessionId) return;
  if (entry) memory.set(sessionId, entry);
  else memory.delete(sessionId);
}

/** The saved place, left in place for the mount that will consume it. */
export function peekTranscriptScroll(sessionId: string): TranscriptScrollMemory | undefined {
  return memory.get(sessionId);
}

export function takeTranscriptScroll(sessionId: string): TranscriptScrollMemory | undefined {
  const entry = memory.get(sessionId);
  memory.delete(sessionId);
  return entry;
}
