/**
 * Debounced saver for the workspace layout. `touch()` says something may
 * have changed; the snapshot is collected only when the timer fires, from
 * whatever is current then, so a burst of state changes costs one collect
 * and one save. A pending save is never dropped: a later touch only moves
 * it, and a burst that never quiets still saves within `maxWait`.
 */
export type WorkspaceAutosave = {
  touch: () => void;
  /** Drop the pending save. A later touch arms a new one. */
  cancel: () => void;
};

export type WorkspaceAutosaveOptions<T> = {
  collect: () => T;
  key: (snapshot: T) => string;
  save: (snapshot: T) => void;
  /** Skip the save when this says so (the window is quitting). */
  skip?: () => boolean;
  wait?: number;
  maxWait?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
};

export function createWorkspaceAutosave<T>({
  collect,
  key,
  save,
  skip,
  wait = 250,
  maxWait = 2000,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer = (id) => clearTimeout(id),
}: WorkspaceAutosaveOptions<T>): WorkspaceAutosave {
  let timer: number | null = null;
  let firstTouch = 0;
  let lastKey: string | null = null;

  const fire = () => {
    timer = null;
    if (skip?.()) return;
    const snapshot = collect();
    const next = key(snapshot);
    if (next === lastKey) return;
    lastKey = next;
    save(snapshot);
  };

  return {
    touch() {
      const at = now();
      if (timer === null) {
        firstTouch = at;
      } else {
        clearTimer(timer);
      }
      const remaining = Math.max(0, firstTouch + maxWait - at);
      timer = setTimer(fire, Math.min(wait, remaining));
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
