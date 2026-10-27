import { Fragment } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { fleetCounts, fleetSentence } from "../../../lib/threads/agents";
import type { SessionMeta } from "../../../lib/tcserver/types";

/** The orchestration thread's header: the goal, and one sentence of what
 *  its agents are doing ("2 working, 1 needs you, 3 done"). The agents
 *  themselves are the right panel's Agents rows. Nothing before the first. */
export function FleetHeader({ goal, agents }: { goal: string; agents: Pick<SessionMeta, "status">[] }) {
  if (agents.length === 0) return null;
  const parts = fleetSentence(fleetCounts(agents));
  return (
    <div data-slot="fleet-header" className="flex min-w-0 flex-col gap-0.5">
      {goal ? (
        <Tooltip>
          <TooltipTrigger render={<p className="truncate text-[15px] font-medium text-foreground" />}>{goal}</TooltipTrigger>
          <TooltipContent className="max-w-md">{goal}</TooltipContent>
        </Tooltip>
      ) : null}
      <p className="text-[13px] text-muted-foreground tabular-nums">
        {parts.map((p, i) => (
          <Fragment key={p.text}>
            {i > 0 ? ", " : null}
            <span className={p.tone}>{p.text}</span>
          </Fragment>
        ))}
      </p>
    </div>
  );
}
