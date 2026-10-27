import { AnimatePresence, LayoutGroup, MotionConfig } from "motion/react";
import { useId } from "react";
import type { OpenFileFn } from "../../../lib/search";
import { fleetCounts, isLiveStatus, useAgents, useMetaById } from "../../../lib/threads/agents";
import { MatrixSpinner, StatusDot } from "../bits";
import { AgentDetail } from "./AgentDetail";
import { AgentRow } from "./AgentRow";
import { useFleetModel } from "./useFleetModel";

/**
 * The subagent rows: the right panel's Agents section (surfaces/RightPanel.tsx),
 * with the agent detail sheet over the pane when a row is open. The layout
 * group is scoped to this mount so rows in two panes on the same thread
 * never glide into each other.
 */
export function FleetList({
  sessionId,
  parentCwd,
  onOpenSession,
  onOpenFile,
  onOpenDiff,
}: {
  sessionId: string;
  parentCwd: string;
  onOpenSession?: (sessionId: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path?: string) => void;
}) {
  const fleet = useFleetModel(sessionId);
  const scope = useId();
  const { agents, detailId } = fleet;

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={scope}>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {agents.length === 0 ? <p className="px-1 py-1 text-[13px] text-muted-foreground">No subagents yet.</p> : null}
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              selected={detailId === agent.id}
              onOpen={() => fleet.setDetailId(agent.id)}
            />
          ))}
        </div>
        <AnimatePresence>
          {detailId ? (
            <AgentDetail
              key={detailId}
              agentId={detailId}
              parentCwd={parentCwd}
              onClose={() => fleet.setDetailId(null)}
              onOpenSession={onOpenSession}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ) : null}
        </AnimatePresence>
      </LayoutGroup>
    </MotionConfig>
  );
}

/** "3 subagents working" above the composer while the main thread is idle. */
export function FleetPulseLine({ sessionId }: { sessionId: string }) {
  const agents = useAgents(sessionId);
  const status = useMetaById(sessionId)?.status;
  if (agents.length === 0 || isLiveStatus(status)) return null;
  const counts = fleetCounts(agents);
  if (counts.working === 0 && counts.waiting === 0) return null;
  const n = counts.working > 0 ? counts.working : counts.waiting;
  const label =
    counts.working > 0
      ? `${n} subagent${n === 1 ? "" : "s"} working`
      : `${n} subagent${n === 1 ? "" : "s"} waiting on approval`;
  return (
    <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-4 pb-1 text-xs text-content/50">
      {counts.working > 0 ? (
        <MatrixSpinner cell={2} />
      ) : (
        <StatusDot status="waiting" />
      )}
      {label}
    </div>
  );
}
