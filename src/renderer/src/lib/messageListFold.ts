/**
 * Whether the transcript's message list (surfaces/TranscriptOutline.tsx) is
 * folded to its chevron. One flag for the window, every thread alike, kept
 * in localStorage under one key; the list's chevron, View → Hide Message
 * List and ⌘⇧M all write it, and the native menu reads it (nativeMenuState).
 */

export const MESSAGE_LIST_FOLDED_KEY = "monocode.messageListFolded";

const listeners = new Set<() => void>();
let folded = read();

function read(): boolean {
  try {
    return localStorage.getItem(MESSAGE_LIST_FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

export const messageListFold = {
  get: (): boolean => folded,
  set(next: boolean): void {
    if (next === folded) return;
    folded = next;
    try {
      localStorage.setItem(MESSAGE_LIST_FOLDED_KEY, next ? "1" : "0");
    } catch {
      // private mode / quota: the fold still holds for this run
    }
    for (const listener of listeners) listener();
  },
  toggle(): void {
    messageListFold.set(!folded);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Tests: read the stored flag again. */
  reload(): void {
    folded = read();
  },
};
