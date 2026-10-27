import { useEffect } from "react";
import { driftMark, driftTitle } from "@server/shared/deployDrift";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { startDeployDrift, useDeployDrift, type DeployDrift } from "../lib/deployDrift";

/**
 * The deploy-drift mark: a quiet `+3` at the trailing edge of a host's row
 * (the rail's host rows, a host's header on Settings → Hosts) when the host runs
 * that many releases behind master, with the command that closes the gap in
 * its tooltip. Nothing at all when the host is current or either number is
 * unknown, and no motion: the number changes a few times a day at most.
 */
export function DeployDriftMark({ environmentId, className = "" }: { environmentId: string; className?: string }) {
  useEffect(() => startDeployDrift(), []);
  const drift = useDeployDrift(environmentId);
  return <DriftMark drift={drift} className={className} />;
}

/** The mark itself, from a computed drift (the hook-free half, for tests and composition). */
export function DriftMark({ drift, className = "" }: { drift: DeployDrift; className?: string }) {
  if (!drift.behind || drift.running === null || drift.master === null) return null;
  const title = driftTitle({ behind: drift.behind, running: drift.running, master: drift.master, kind: drift.kind });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-deploy-drift={drift.behind}
            aria-label={title}
            className={`shrink-0 cursor-default text-[11px] tabular-nums text-muted-foreground ${className}`.trim()}
          />
        }
      >
        {driftMark(drift.behind)}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{title}</TooltipContent>
    </Tooltip>
  );
}
