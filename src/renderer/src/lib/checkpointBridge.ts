import {
  captureSessionCheckpoint,
  ensureSessionCheckpoint,
  notifyReviewChanged,
  syncSessionCheckpoint,
} from "./checkpoint";
import { sessionWorkCwd } from "./session";
import { sessionStore } from "./tcserver/store";

/**
 * Drives the Rust checkpoint store from the server's turn lifecycle so a
 * turn that started anywhere (a send, a queue drain, a resume, a turn
 * pass) has a baseline and a settled diff to undo:
 *
 * - `user-text` → ensure (snapshot dirty files before the agent writes)
 * - settled `live-edit` → capture that file (disk truth, shell edits too)
 * - `turn-complete`, or status idle / error / paused → sync + review nudge
 */
export type CheckpointCalls = {
  ensure: typeof ensureSessionCheckpoint;
  capture: typeof captureSessionCheckpoint;
  sync: typeof syncSessionCheckpoint;
  changed: typeof notifyReviewChanged;
};

const DEFAULT_CALLS: CheckpointCalls = {
  ensure: ensureSessionCheckpoint,
  capture: captureSessionCheckpoint,
  sync: syncSessionCheckpoint,
  changed: notifyReviewChanged,
};

const SETTLING = new Set(["idle", "error", "paused"]);

function usable(cwd: string): boolean {
  return !!cwd && cwd !== "~";
}

export function installCheckpointBridge(
  store: Pick<typeof sessionStore, "onEvent" | "onLiveEdit" | "get"> = sessionStore,
  calls: CheckpointCalls = DEFAULT_CALLS,
): () => void {
  const offEvent = store.onEvent((sessionId, row, session) => {
    const cwd = sessionWorkCwd(session);
    if (!usable(cwd)) return;
    const event = row.event;
    if (event.type === "user-text") {
      void calls.ensure(sessionId, cwd).catch(() => undefined);
      return;
    }
    const settles =
      event.type === "turn-complete" ||
      (event.type === "status" && SETTLING.has(event.status));
    if (!settles) return;
    void calls
      .sync(sessionId, cwd)
      .catch(() => undefined)
      .then(() => calls.changed(sessionId));
  });
  const offLive = store.onLiveEdit((sessionIds, edit) => {
    if (!edit?.settled) return;
    for (const sessionId of sessionIds) {
      const session = store.get(sessionId);
      const cwd = session ? sessionWorkCwd(session) : "";
      if (!usable(cwd)) continue;
      const path = edit.path.startsWith("/") ? edit.path : `${edit.cwd}/${edit.path}`;
      void calls
        .capture(sessionId, cwd, [path])
        .catch(() => undefined)
        .then(() => calls.changed(sessionId));
    }
  });
  return () => {
    offEvent();
    offLive();
  };
}
