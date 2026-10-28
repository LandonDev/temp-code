import { hostOfCwd } from "../lib/tcserver/projects";
import { useEffect, useMemo, useState } from "react";
import { readFile } from "../lib/tcserver/commands";

/**
 * Which settled planning threads have a WRITTEN plan awaiting a build. Peeks
 * at each one's plan file on a slow poll — a planning thread that has not
 * produced a document yet does not count. Starting a build archives the
 * planning thread server-side, which drops it from the list on its own.
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

export function usePlanReady(
  threads: { id: string; threadType?: string | null; status?: string; planPath?: string | null; planCompletedAt?: number | null }[],
): Record<string, boolean> {
  const [ready, setReady] = useState<Record<string, boolean>>({});
  // A plan the planner marked complete (plan_complete) is ready on the
  // server's word; the file peek covers plans written before that tool.
  const completed = threads.filter((t) => isSettledPlanning(t) && !!t.planCompletedAt).map((t) => t.id);
  const idle = threads.filter((t) => isSettledPlanning(t) && !t.planCompletedAt);
  const key = idle.map((t) => `${t.id}=${t.planPath}`).join(",");
  useEffect(() => {
    const entries = key ? key.split(",").map((pair) => pair.split("=") as [string, string]) : [];
    if (entries.length === 0) {
      setReady((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let alive = true;
    const poll = async (): Promise<void> => {
      const next = await Promise.all(
        entries.map(async ([id, path]) => [id, !!(await readFile(hostOfCwd(path), path))?.trim()] as const),
      );
      if (!alive) return;
      setReady((prev) => {
        const out = Object.fromEntries(next);
        const same =
          Object.keys(prev).length === next.length && next.every(([id, v]) => prev[id] === v);
        return same ? prev : out;
      });
    };
    void poll();
    const t = setInterval(() => void poll(), 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  const completedKey = completed.join(",");
  return useMemo(() => {
    if (!completedKey) return ready;
    const out = { ...ready };
    for (const id of completedKey.split(",")) out[id] = true;
    return out;
  }, [ready, completedKey]);
}
