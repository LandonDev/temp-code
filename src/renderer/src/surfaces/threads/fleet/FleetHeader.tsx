import { FLEET_TONES, FLEET_WORDS, fleetCounts, type FleetCounts } from "../../../lib/threads/agents";
import type { SessionMeta } from "../../../lib/tcserver/types";

/** The goal line and the counts under it; each row below carries its own status. */
export function FleetHeader({ goal, agents }: { goal: string; agents: SessionMeta[] }) {
  const c = fleetCounts(agents);
  const counts = (["working", "waiting", "failed", "done"] as const satisfies readonly (keyof FleetCounts)[]).map(
    (k): [number, string, string?] => [c[k], FLEET_WORDS[k], FLEET_TONES[k]],
  );
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
