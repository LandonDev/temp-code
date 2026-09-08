import { Pause } from "./icons";
import type { ActivityKind } from "../lib/session";
import type { SessionStatus } from "../lib/tcserver/types";
import { MatrixSpinner, duration } from "../surfaces/threads/bits";

/** What a tab's focused thread is up to, computed in App from the session. */
export type TabThread = {
  type: string | null;
  status: SessionStatus;
  unread?: boolean;
  /** when this working stretch began (its first message) */
  since: number;
  activity?: string | null;
  activityKind?: ActivityKind | null;
  /** implementation threads: this round's task tally */
  tasks?: { done: number; total: number } | null;
  /** planning threads: plan written, awaiting a build */
  planReady?: boolean;
  /** paused active time, excluding the paused span */
  frozenElapsed?: number | null;
};

/**
 * Tab-edge status, one glance apart: working → matrix spinner + elapsed +
 * the activity verb; needs you → amber, in words; failed → red; plan
 * written, no build started → violet "Plan ready"; finished while you
 * were elsewhere → blue dot. An implementation thread's tally sits at
 * the edge in every state.
 */
export function TabIndicator({ thread, now }: { thread: TabThread; now: number }) {
  const { status, tasks } = thread;
  const tally = tasks ? (
    <span
      className={`shrink-0 text-[11px] tabular-nums ${
        tasks.done === tasks.total ? "text-success" : "text-content/60"
      }`}
      title={`${tasks.done} of ${tasks.total} tasks done`}
    >
      {tasks.done}/{tasks.total}
    </span>
  ) : null;

  const body = ((): React.ReactNode => {
    if (status === "running" || status === "starting") {
      const ms = Math.max(0, now - thread.since);
      const verb = thread.activity?.split(" ")[0] ?? "";
      return (
        <span className="flex shrink-0 items-center gap-1" title={thread.activity ?? undefined}>
          <MatrixSpinner cell={1.8} tint={thread.activityKind} />
          <span
            className={`shrink-0 text-right text-[11px] whitespace-nowrap tabular-nums text-content/45 ${
              ms < 3000 ? "opacity-0" : ""
            }`}
          >
            {duration(ms)}
          </span>
          {!tally && verb ? (
            <span className="w-14 shrink-0 truncate text-left text-[11px] text-content/60">{verb}</span>
          ) : null}
        </span>
      );
    }
    if (status === "paused") {
      return (
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-warning">
          <Pause className="size-3 fill-current" strokeWidth={1.8} />
          Paused
          <span className="font-normal tabular-nums text-current/75">
            {duration(Math.max(0, thread.frozenElapsed ?? 0))}
          </span>
        </span>
      );
    }
    if (status === "waiting") {
      return (
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-warning">
          <span className="size-1.5 animate-pulse rounded-full bg-warning" />
          Needs you
        </span>
      );
    }
    if (status === "error") {
      return <span className="shrink-0 text-[11px] font-medium text-danger">Failed</span>;
    }
    if (thread.planReady) {
      return (
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-violet">
          <span className="size-1.5 rounded-full bg-violet" />
          Plan ready
        </span>
      );
    }
    if (thread.unread) return <span className="size-1.5 shrink-0 rounded-full bg-info" />;
    return null;
  })();

  if (!body && !tally) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {body}
      {tally}
    </span>
  );
}
