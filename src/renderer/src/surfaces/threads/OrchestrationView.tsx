import { GLIDE_MAX_ROWS } from "../../lib/listGlide";
import { AnimatePresence, LayoutGroup, MotionConfig } from "motion/react";
import { useId, useMemo, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { ChevronRight } from "../../chrome/icons";
import { taskTitle } from "../../lib/threads/agents";
import { PaneHeader } from "./bits";
import { chatOf, slotsOf } from "./chatSlots";
import { AgentDetail } from "./fleet/AgentDetail";
import { OpenAgentDetailContext } from "../agentDetailContext";
import { AgentRow } from "./fleet/AgentRow";
import { FleetHeader } from "./fleet/FleetHeader";
import { useFleetModel } from "./fleet/useFleetModel";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Orchestration thread: the fleet as full-width rows on the hero, the
 * compact composer under it, and the orchestrator's own stream in the chat
 * column the board views share (SplitShell), folded to its edge tab by
 * default. Until the first agent spawns the stream is the whole view.
 */
export function OrchestrationView(props: ThreadViewProps) {
  const { session } = props;
  const fleet = useFleetModel(session.id);
  const scope = useId();
  const { agents, detailId, now } = fleet;
  const hasBoard = agents.length > 0;
  const [chatOpen, setChatOpen] = useState(false);
  const goal = useMemo(() => {
    const last = [...session.blocks].reverse().find((b) => b.role === "user" && b.text.trim());
    return last ? last.text.trim().split("\n")[0].trim() : taskTitle(session.blocks);
  }, [session.blocks]);

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
        <OpenAgentDetailContext.Provider value={fleet.setDetailId}>{chatOf(props)}</OpenAgentDetailContext.Provider>
        {detail}
      </div>
    );
  }

  const slots = slotsOf(props);
  const board = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto select-text">
        <div className="mx-auto w-full max-w-3xl px-6 py-5">
          <FleetHeader goal={goal} agents={agents} />
          <div className="-mx-3 flex flex-col gap-0.5">
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                now={now}
                glide={agents.length <= GLIDE_MAX_ROWS}
                onOpen={() => fleet.setDetailId(agent.id)}
              />
            ))}
          </div>
        </div>
      </div>
      {slots.composer ? <div className="mx-auto w-full max-w-4xl shrink-0">{slots.composer}</div> : null}
    </>
  );
  const chat = (
    <>
      <PaneHeader label="Orchestrator log">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Hide orchestrator log"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setChatOpen(false)}
        >
          <ChevronRight className="size-3.5" strokeWidth={1.75} />
        </Button>
      </PaneHeader>
      <OpenAgentDetailContext.Provider value={fleet.setDetailId}>{slots.transcript}</OpenAgentDetailContext.Provider>
    </>
  );

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={scope}>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <SplitShell
            className="[contain:layout_style]"
            board={board}
            chat={chat}
            hasBoard
            collapsed={!chatOpen}
            onOpenChat={() => setChatOpen(true)}
            status={session.status}
            edgeTitle="Show orchestrator log"
          />
          {detail}
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}
