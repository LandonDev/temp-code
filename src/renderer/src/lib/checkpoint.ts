import { registry } from "./connection";
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

/**
 * A thread's undo checkpoint lives on its host, which keeps it from its own
 * turns (src/main/server/checkpointTurns.ts) in the thread's cwd: the calls
 * here name the thread only, and `checkpoint-changed` says when to read it
 * again (a turn settled). Only sockets subscribed to the thread hear it.
 */
const changeListeners = new Set<(sessionId: string) => void>();
let hearing = false;

export function subscribeCheckpointChanged(listener: (sessionId: string) => void): () => void {
  if (!hearing) {
    hearing = true;
    registry.onLink((link, event) => {
      if (event === "removed") return;
      link.onPush((push) => {
        if (push.push !== "checkpoint-changed") return;
        for (const heard of changeListeners) heard(push.sessionId);
      });
    });
  }
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function sessionCheckpointStatus(environmentId: string, sessionId: string): Promise<CheckpointStatus> {
  return invokeOn<CheckpointStatus>(environmentId, "session_checkpoint_status", { sessionId });
}

export function undoSessionChanges(
  environmentId: string,
  sessionId: string,
  relative?: string,
): Promise<CheckpointStatus> {
  return invokeOn<CheckpointStatus>(environmentId, "session_checkpoint_undo", {
    sessionId,
    relative: relative ?? null,
  });
}

export function keepSessionChanges(
  environmentId: string,
  sessionId: string,
  relative?: string,
): Promise<CheckpointStatus> {
  return invokeOn<CheckpointStatus>(environmentId, "session_checkpoint_keep", {
    sessionId,
    relative: relative ?? null,
  });
}
