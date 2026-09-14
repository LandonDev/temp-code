import { AnimatePresence, LayoutGroup, MotionConfig } from "motion/react";
import { useId, useMemo } from "react";
import { taskTitle } from "../../lib/threads/agents";
import { chatOf, slotsOf } from "./chatSlots";
import { AgentDetail } from "./fleet/AgentDetail";
import { OpenAgentDetailContext } from "../agentDetailContext";
import { AgentRow } from "./fleet/AgentRow";
import { FleetHeader } from "./fleet/FleetHeader";
import { useFleetModel } from "./fleet/useFleetModel";
import { SidePanel } from "./SidePanel";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Orchestration thread: the fleet as full-width rows on the hero, the
 * compact composer under it, and the orchestrator's own stream docked on
 * the right as a log that starts folded. Until the first agent spawns the
 * stream is the whole view.
 */
export function OrchestrationView(props: ThreadViewProps) {
  const { session } = props;
  const fleet = useFleetModel(session.id);
  const scope = useId();
  const { agents, detailId, now } = fleet;
  const hasBoard = agents.length > 0;
  const goal = useMemo(() => {
    const last = [...session.blocks].reverse().find((b) => b.role === "user" && b.text.trim());
    return last ? last.text.trim().split("\n")[0].trim() : taskTitle(session.blocks);
  }, [session.blocks]);
  const empty = session.blocks.length === 0 && !hasBoard && !session.busy;
  const topSlot = empty ? (
    <p className="mx-auto w-full max-w-[688px] px-6 pb-2 text-[13px] text-content/40">
      Describe the goal. The orchestrator splits it across subagents and picks a model for each.
    </p>
  ) : undefined;

  const detail = (
    <AnimatePresence>
      {detailId ? (
        <AgentDetail
          key={detailId}
          agentId={detailId}
          parentCwd={session.cwd}
          onClose={() => fleet.setDetailId(null)}
          onOpenSession={props.onOpenSession}
          onOpenFile={props.onOpenFile}
          onOpenDiff={props.onOpenDiff}
        />
      ) : null}
    </AnimatePresence>
  );

  if (!hasBoard) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <OpenAgentDetailContext.Provider value={fleet.setDetailId}>{chatOf(props, { topSlot })}</OpenAgentDetailContext.Provider>
        {detail}
      </div>
    );
  }

  const slots = slotsOf(props);
  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={scope}>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto select-text">
              <div className="mx-auto w-full max-w-3xl px-6 py-5">
                <FleetHeader goal={goal} agents={agents} />
                <div className="-mx-3 flex flex-col gap-0.5">
                  {agents.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      now={now}
                      hidden={agent.id === detailId}
                      onOpen={() => fleet.setDetailId(agent.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
            {slots.composer ? <div className="mx-auto w-full max-w-4xl shrink-0">{slots.composer}</div> : null}
          </div>
          <SidePanel label="Orchestrator log" status={session.status}>
            <OpenAgentDetailContext.Provider value={fleet.setDetailId}>{slots.transcript}</OpenAgentDetailContext.Provider>
          </SidePanel>
          {detail}
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}
