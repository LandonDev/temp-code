import { useEffect } from "react";
import { driftMark, driftTitle } from "@server/shared/deployDrift";
import { startDeployDrift, useDeployDrift, type DeployDrift } from "../lib/deployDrift";

/**
 * The deploy-drift mark: a quiet `+3` at the trailing edge of a host's row
 * (the environment switcher, Settings → Remote access) when the host runs
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
    <span
      data-deploy-drift={drift.behind}
      title={title}
      aria-label={title}
      className={`shrink-0 text-[11px] tabular-nums text-content/40 ${className}`.trim()}
    >
      {driftMark(drift.behind)}
    </span>
  );
}
