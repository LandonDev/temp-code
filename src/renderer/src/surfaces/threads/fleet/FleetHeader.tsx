import { fleetCounts } from "../../../lib/threads/agents";
import type { SessionMeta } from "../../../lib/tcserver/types";

/** The goal line and the counts under it; each row below carries its own status. */
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
      {goal && <p className="text-sm leading-snug font-medium tracking-[-0.01em] text-content">{goal}</p>}
      <div className="mt-1 flex gap-2 text-xs tabular-nums text-content/40">
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
