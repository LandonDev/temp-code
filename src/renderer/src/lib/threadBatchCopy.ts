import type { BatchAction, BatchScope } from "./threadBatch";

// The fleet confirm's words. Only the confirm dialog reads them, and it
// rides the dialogs chunk, so they stay out of the first paint.

const VERB: Record<BatchAction, { imperative: string; past: string; noun: string }> = {
  pause: { imperative: "Pause", past: "Paused", noun: "running" },
  resume: { imperative: "Resume", past: "Resumed", noun: "paused" },
  stop: { imperative: "Stop", past: "Stopped", noun: "running" },
  archiveDone: { imperative: "Archive", past: "Archived", noun: "finished" },
};

/** Where the action reaches, as the confirm's clause. */
export function scopePhrase(scope: BatchScope): string {
  switch (scope.kind) {
    case "all":
      return "everywhere";
    case "host":
      return `on ${scope.name}`;
    case "project":
    case "projects":
      return `in ${scope.name}`;
  }
}

const threads = (n: number) => (n === 1 ? "thread" : "threads");

export type BatchConfirmCopy = {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  /** The Archive done clause with its checkbox; absent when there is
   *  nothing to release or the host has no clean-up. */
  cleanup: string | null;
};

/**
 * The confirm dialog's words for a count computed live: "Pause 15 running
 * threads on the box?". `resources` is how many worktrees and simulators
 * Archive done could release, or null when the host cannot. `queued` is
 * how many of the count are queued threads, which Stop and Archive done
 * remove from the queue rather than stop or archive.
 */
export function batchConfirm(
  action: BatchAction,
  count: number,
  scope: BatchScope,
  resources: number | null = null,
  queued = 0,
): BatchConfirmCopy {
  const v = VERB[action];
  const where = scopePhrase(scope);
  if (count === 0) {
    return {
      title: `Nothing to ${v.imperative.toLowerCase()} ${where}`,
      body: `No ${v.noun} ${threads(2)} ${where} right now.`,
      confirmLabel: v.imperative,
      danger: false,
      cleanup: null,
    };
  }
  const acting = count - queued;
  const removal = queued > 0 ? `remove ${queued} from the queue` : null;
  const title =
    removal && acting === 0
      ? `Remove ${queued} ${threads(queued)} from the queue ${where}?`
      : removal
        ? `${v.imperative} ${acting} ${v.noun} ${threads(acting)} and ${removal} ${where}?`
        : `${v.imperative} ${count} ${v.noun} ${threads(count)} ${where}?`;
  const body =
    removal && acting === 0
      ? "They have not started, so nothing is lost."
      : action === "pause"
        ? "Each keeps its place and continues from there."
        : action === "stop"
          ? "Their turns end now; each keeps its history."
          : "Idle ten minutes or more, read, and waiting on nothing.";
  const cleanup =
    action === "archiveDone" && resources !== null && resources > 0
      ? `and remove their ${resources} ${resources === 1 ? "worktree or simulator" : "worktrees and simulators"}`
      : null;
  return {
    title,
    body,
    confirmLabel: `${removal && acting === 0 ? "Remove" : v.imperative} ${count}`,
    // Red only for Stop, and for an archive while its removal box is ticked
    // (the dialog adds that): archiving alone loses nothing.
    danger: action === "stop",
    cleanup,
  };
}
