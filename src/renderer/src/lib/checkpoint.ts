import { invokeOn } from "./native";

export type CheckpointFile = {
  path: string;
  relative: string;
  status: string;
  additions: number;
  deletions: number;
};

export type CheckpointStatus = {
  files: CheckpointFile[];
};

const REVIEW_CHANGED = "monocode-review-changed";

export function notifyReviewChanged(sessionId?: string) {
  window.dispatchEvent(
    new CustomEvent(REVIEW_CHANGED, { detail: sessionId ?? "" }),
  );
}

export function subscribeReviewChanged(
  listener: (sessionId: string) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<string>).detail ?? "");
  };
  window.addEventListener(REVIEW_CHANGED, handler);
  return () => window.removeEventListener(REVIEW_CHANGED, handler);
}

export function ensureSessionCheckpoint(environmentId: string, sessionId: string,
  cwd: string,
): Promise<void> {
  return invokeOn<void>(environmentId, "session_checkpoint_ensure", { sessionId, cwd });
}

/** Snapshot the worktree before a live turn so Keep/Undo can target this session. */
export async function beginSessionTurn(
  environmentId: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  if (!cwd || cwd === "~") return;
  await ensureSessionCheckpoint(environmentId, sessionId, cwd);
  notifyReviewChanged(sessionId);
}

export function captureSessionCheckpoint(environmentId: string, sessionId: string,
  cwd: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return Promise.resolve();
  return invokeOn<void>(environmentId, "session_checkpoint_capture", {
    sessionId,
    cwd,
    paths,
  });
}

export function syncSessionCheckpoint(environmentId: string, sessionId: string,
  cwd: string,
): Promise<void> {
  if (!cwd || cwd === "~") return Promise.resolve();
  return invokeOn<void>(environmentId, "session_checkpoint_sync", { sessionId, cwd });
}

export function sessionCheckpointStatus(environmentId: string, sessionId: string,
  cwd: string,
): Promise<CheckpointStatus> {
  return invokeOn<CheckpointStatus>(environmentId, "session_checkpoint_status", {
    sessionId,
    cwd,
  });
}

export function undoSessionChanges(environmentId: string, sessionId: string,
  cwd: string,
  relative?: string,
): Promise<CheckpointStatus> {
  return invokeOn<CheckpointStatus>(environmentId, "session_checkpoint_undo", {
    sessionId,
    cwd,
    relative: relative ?? null,
  });
}

export function keepSessionChanges(environmentId: string, sessionId: string,
  cwd: string,
  relative?: string,
): Promise<CheckpointStatus> {
  return invokeOn<CheckpointStatus>(environmentId, "session_checkpoint_keep", {
    sessionId,
    cwd,
    relative: relative ?? null,
  });
}
