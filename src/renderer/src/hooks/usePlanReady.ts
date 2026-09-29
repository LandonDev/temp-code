import { useEffect, useState } from "react";
import { readFile } from "../lib/tcserver/commands";

/**
 * Which settled planning threads have a WRITTEN plan awaiting a build. Peeks
 * at each one's plan file on a slow poll — a planning thread that has not
 * produced a document yet does not count. Starting a build archives the
 * planning thread server-side, which drops it from the list on its own.
 *
 * `watching` counts as settled: a planning thread whose turn ended on a
 * background wait (a Monitor, a cron, a run_in_background Bash) has still
 * written its plan, and before v184 that same thread read idle.
 */
export function isSettledPlanning(t: {
  threadType?: string | null;
  status?: string;
  planPath?: string | null;
}): boolean {
  return (
    t.threadType === "planning" && (t.status === "idle" || t.status === "watching") && !!t.planPath
  );
}

export function usePlanReady(
  threads: { id: string; threadType?: string | null; status?: string; planPath?: string | null }[],
): Record<string, boolean> {
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const idle = threads.filter(isSettledPlanning);
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
        entries.map(async ([id, path]) => [id, !!(await readFile(path))?.trim()] as const),
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
  return ready;
}
