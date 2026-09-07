/**
 * A seam between the app shell and the editor panes: each mounted pane
 * registers how to flush its buffer, and closing a dirty tab with autosave
 * on flushes through here instead of confirming, and Save All (⌘S) flushes
 * every registered pane. No editor imports, so the shell never pulls an
 * editor chunk in.
 */

type Flusher = () => Promise<boolean>;

const flushers = new Map<string, Flusher>();

export function registerEditorFlusher(path: string, flush: Flusher): () => void {
  flushers.set(path, flush);
  return () => {
    if (flushers.get(path) === flush) flushers.delete(path);
  };
}

/** Write `path`'s buffer now; true when the disk holds it afterwards
 *  (no open editor counts as nothing to do). */
export async function flushEditor(path: string): Promise<boolean> {
  const flush = flushers.get(path);
  if (!flush) return true;
  try {
    return await flush();
  } catch {
    return false;
  }
}

/** Write every open editor's buffer; the paths whose write failed. */
export async function flushAllEditors(): Promise<string[]> {
  const failed: string[] = [];
  await Promise.all(
    [...flushers.keys()].map(async (path) => {
      if (!(await flushEditor(path))) failed.push(path);
    }),
  );
  return failed;
}

/** Paths with a registered editor, for tests and the dev facade. */
export function registeredEditorPaths(): string[] {
  return [...flushers.keys()];
}
