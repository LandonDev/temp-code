import { fleetCounts } from "../../../lib/threads/agents";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";

const SEG: Partial<Record<SessionStatus, string>> = {
  idle: "bg-success",
  done: "bg-success",
  running: "bg-success/35 motion-safe:animate-pulse",
  starting: "bg-success/35 motion-safe:animate-pulse",
  waiting: "bg-warning",
  error: "bg-danger",
};

/** The goal line, one progress segment per agent, and the counts under it. */
export function FleetHeader({ goal, agents }: { goal: string; agents: SessionMeta[] }) {
  const c = fleetCounts(agents);
  const counts: [number, string, string?][] = [
    [c.working, "working"],
    [c.waiting, "needs approval", "text-warning"],
    [c.failed, "failed", "text-danger"],
    [c.done, "done"],
  ];
  return (
    <div className="mb-4">
      {goal && <p className="text-[15px] leading-snug font-medium tracking-[-0.01em] text-content">{goal}</p>}
      <div className="mt-3 flex h-[3px] gap-[3px]">
        {agents.map((a) => (
          <span key={a.id} className={`flex-1 rounded-full ${SEG[a.status] ?? "bg-content/20"}`} />
        ))}
      </div>
      <div className="mt-2 flex gap-2 text-[11px] tabular-nums text-content/40">
        {counts
          .filter(([n]) => n > 0)
          .map(([n, label, tone], i) => (
            <span key={label} className={tone}>
              {i > 0 && <span className="mr-2 text-content/20">·</span>}
              {n} {label}
            </span>
          ))}
      </div>
    </div>
  );
}
