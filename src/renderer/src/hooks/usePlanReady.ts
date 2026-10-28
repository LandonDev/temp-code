import { useMemo } from "react";

/**
 * Which settled planning threads have a plan awaiting a build: those whose
 * planner called `plan_complete` (`planCompletedAt`), on the server's word
 * alone. Nothing reads a plan file for it: the old 8 s peek at every
 * settled planner's file sent hundreds of `file.read` per workspace click.
 * Starting a build archives the planning thread server-side, which drops it
 * from the list on its own.
 *
 * `watching` counts as settled: a planning thread whose turn ended on a
 * background wait (a Monitor, a cron, a run_in_background Bash) has still
 * written its plan, and before v184 that same thread read idle. `done` is
 * the server's terminal status for a finished run and settles the same way.
 */
export function isSettledPlanning(t: {
  threadType?: string | null;
  status?: string;
  planPath?: string | null;
}): boolean {
  return (
    t.threadType === "planning" &&
    (t.status === "idle" || t.status === "watching" || t.status === "done") &&
    !!t.planPath
  );
}

const NONE: Readonly<Record<string, boolean>> = {};

export function usePlanReady(
  threads: { id: string; threadType?: string | null; status?: string; planPath?: string | null; planCompletedAt?: number | null }[],
): Readonly<Record<string, boolean>> {
  // One string, so the answer keeps its identity while the set holds.
  const key = threads
    .filter((t) => isSettledPlanning(t) && !!t.planCompletedAt)
    .map((t) => t.id)
    .join("\n");
  return useMemo(() => (key ? Object.fromEntries(key.split("\n").map((id) => [id, true])) : NONE), [key]);
}
