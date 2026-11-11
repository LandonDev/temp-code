import type { SeenMap, HostMarks } from "./sessionSeen";

/**
 * The hosts' read marks on the desktop (CLAUDE.md "Read and unread: the
 * host's mark"). A host that keeps them sends `readAt` on every thread's
 * meta; a thread reads unread while its `updatedAt` is past that mark, on
 * every client alike. This module:
 * - collects the marks off the metas into one map `sessionSeen` lays over
 *   this window's own (a thread whose host sends none is left to the window);
 * - writes the mark when the person sees a thread: the thread they are
 *   looking at (the focused pane, the window focused, the person at the
 *   machine: `FocusSignal.attended`), again as its updatedAt moves, and every
 *   thread Mark all read names;
 * - coalesces those writes per host into one `session.markRead` a beat after
 *   the last (`QUIET_MS`, never later than `MAX_WAIT_MS` after the first),
 *   holding them while the host's link is down and sending them when it opens.
 * The window's own on-screen thread is left out of the overlay, so it never
 * reads unread under the person while a write is on its way, and a write not
 * yet heard back covers its thread meanwhile (`pending`).
 */

export const QUIET_MS = 1500;
export const MAX_WAIT_MS = 5000;
/** At most this many marks in one request (the contract caps at 5,000). */
export const BATCH = 2000;

export type MarkMeta = { id: string; updatedAt: number; readAt?: number };

export type MarkLink = {
  readonly connected: boolean;
  request(method: string, params: unknown, options?: { retry?: boolean }): Promise<unknown>;
  onOpen(listener: () => void): () => void;
};

export type ReadMarksDeps = {
  metas(): readonly MarkMeta[];
  metaOf(id: string): MarkMeta | null;
  environmentOf(id: string): string | undefined;
  /** Fires once per meta flush with the ids that changed or left. */
  onMetaChange(listener: (ids: ReadonlySet<string>) => void): () => void;
  linkOf(environmentId: string): MarkLink | undefined;
  /** The thread the person looks at, the one on screen, and their changes. */
  attended(): string | null;
  shown(): string | null;
  onFocusChange(listener: () => void): () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type HostQueue = { items: Map<string, number>; first: number | null; timer: unknown; offOpen: (() => void) | null };

export type ReadMarks = HostMarks & { dispose(): void; flushNow(): Promise<void> };

export function createReadMarks(deps: ReadMarksDeps): ReadMarks {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  /** Each mark-keeping host's mark, by thread. */
  const hostRead = new Map<string, number>();
  /** What this window sent and has not heard back yet, by thread. */
  const pending = new Map<string, number>();
  const queues = new Map<string, HostQueue>();
  let snapshot: SeenMap | null = null;
  let shownId = deps.shown();

  const notify = () => {
    snapshot = null;
    for (const listener of listeners) listener();
  };

  /** Folds a meta's mark in; true when the overlay moved. */
  const take = (id: string, meta: MarkMeta | null): boolean => {
    const before = hostRead.get(id);
    if (!meta || meta.readAt === undefined) {
      pending.delete(id);
      if (before === undefined) return false;
      hostRead.delete(id);
      return true;
    }
    const want = pending.get(id);
    if (want !== undefined && meta.readAt >= Math.min(want, meta.updatedAt)) pending.delete(id);
    if (before === meta.readAt) return false;
    hostRead.set(id, meta.readAt);
    return true;
  };

  for (const meta of deps.metas()) take(meta.id, meta);

  const send = async (environmentId: string): Promise<void> => {
    const queue = queues.get(environmentId);
    if (!queue || queue.items.size === 0) return;
    if (queue.timer != null) clearTimer(queue.timer);
    queue.timer = null;
    const link = deps.linkOf(environmentId);
    if (!link?.connected) {
      // Held until the host's link opens again.
      if (link && !queue.offOpen) queue.offOpen = link.onOpen(() => void send(environmentId));
      return;
    }
    queue.offOpen?.();
    queue.offOpen = null;
    const items = [...queue.items].map(([sessionId, at]) => ({ sessionId, at }));
    queue.items.clear();
    queue.first = null;
    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH);
      try {
        await link.request("session.markRead", { items: chunk }, { retry: false });
      } catch {
        // Not delivered for sure: back in line for the next open or mark.
        for (const { sessionId, at } of chunk) {
          if ((queue.items.get(sessionId) ?? -1) < at) queue.items.set(sessionId, at);
        }
        if (!queue.offOpen) queue.offOpen = link.onOpen(() => void send(environmentId));
      }
    }
  };

  const schedule = (environmentId: string) => {
    const queue = queues.get(environmentId)!;
    const now = Date.now();
    queue.first ??= now;
    if (queue.timer != null) clearTimer(queue.timer);
    const wait = Math.max(0, Math.min(QUIET_MS, queue.first + MAX_WAIT_MS - now));
    queue.timer = setTimer(() => void send(environmentId), wait);
  };

  const read = (ids: Iterable<string>, at?: number) => {
    let moved = false;
    const touched = new Set<string>();
    for (const id of ids) {
      const meta = id ? deps.metaOf(id) : null;
      if (!meta || meta.readAt === undefined) continue; // the host keeps no marks: the window's map answers
      const mark = Math.min(at ?? meta.updatedAt, meta.updatedAt);
      if (mark <= Math.max(meta.readAt, pending.get(id) ?? -1)) continue;
      const environmentId = deps.environmentOf(id);
      if (!environmentId) continue;
      pending.set(id, mark);
      let queue = queues.get(environmentId);
      if (!queue) queues.set(environmentId, (queue = { items: new Map(), first: null, timer: null, offOpen: null }));
      queue.items.set(id, mark);
      touched.add(environmentId);
      if (id !== shownId) moved = true;
    }
    for (const environmentId of touched) schedule(environmentId);
    if (moved) notify();
  };

  // The thread the person looks at is read, and stays read as it moves.
  let attendedId = deps.attended();
  const readAttended = () => {
    if (attendedId) read([attendedId]);
  };
  readAttended();

  const offMeta = deps.onMetaChange((ids) => {
    let moved = false;
    // The on-screen thread is out of the overlay: its moves repaint nothing.
    for (const id of ids) if (take(id, deps.metaOf(id)) && id !== shownId) moved = true;
    if (attendedId && ids.has(attendedId)) readAttended();
    if (moved) notify();
  });
  const offFocus = deps.onFocusChange(() => {
    const leaving = attendedId;
    attendedId = deps.attended();
    // The thread leaving as it stands (what landed before the next write), then the one arriving.
    if (leaving && leaving !== attendedId) read([leaving]);
    readAttended();
    const shown = deps.shown();
    if (shown !== shownId) {
      shownId = shown;
      notify();
    }
  });

  return {
    marks() {
      if (snapshot) return snapshot;
      const out: SeenMap = {};
      for (const [id, at] of hostRead) out[id] = Math.max(at, pending.get(id) ?? 0);
      // The window's own on-screen thread is the window's to say.
      if (shownId) delete out[shownId];
      return (snapshot = out);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read(ids, at) {
      read(ids, at);
    },
    async flushNow() {
      await Promise.all([...queues.keys()].map((environmentId) => send(environmentId)));
    },
    dispose() {
      offMeta();
      offFocus();
      for (const queue of queues.values()) {
        if (queue.timer != null) clearTimer(queue.timer);
        queue.offOpen?.();
      }
      listeners.clear();
    },
  };
}
