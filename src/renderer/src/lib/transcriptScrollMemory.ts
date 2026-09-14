/**
 * Where a transcript's reader was when its pane unmounted (a tab parked
 * long enough to leave the warm set). A transcript that was following the
 * bottom stores nothing: a fresh mount lands there anyway.
 */
export type TranscriptScrollMemory = {
  /** Distance from the bottom of the scroller, in px, spacer excluded. */
  fromBottom: number;
  /** How many turns the transcript's window had grown to. */
  turnCount: number;
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
