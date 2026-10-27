import { AnimatePresence } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { taskTitle, useAgents } from "../../lib/threads/agents";
import { OpenAgentDetailContext } from "../agentDetailContext";
import { ChatFooter, chatOf } from "./chatSlots";
import { AgentDetail } from "./fleet/AgentDetail";
import { FleetHeader } from "./fleet/FleetHeader";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Orchestration thread: the chat, under a header with the goal and one
 * sentence of what the agents are doing. The agents themselves are rows in
 * the right panel's Agents section; a spawn row in the transcript opens the
 * agent's detail over the pane.
 */
export function OrchestrationView(props: ThreadViewProps) {
  const { session } = props;
  const agents = useAgents(session.id);
  const [detailId, setDetailId] = useState<string | null>(null);
  const goal = useMemo(() => {
    const last = [...session.blocks].reverse().find((b) => b.role === "user" && b.text.trim());
    return last ? last.text.trim().split("\n")[0].trim() : taskTitle(session.blocks);
  }, [session.blocks]);

  const header =
    agents.length > 0 ? (
      <div className="shrink-0 px-4 pt-5 pb-3">
        <div className="mx-auto w-full max-w-4xl">
          <FleetHeader goal={goal} agents={agents} />
        </div>
      </div>
    ) : null;

  let column: ReactNode;
  if (props.renderSlots) {
    const slots = props.renderSlots();
    column = (
      <>
        {header}
        {slots.transcript}
        <ChatFooter slots={slots} />
      </>
    );
  } else {
    column = (
      <>
        {header}
        <div className="flex min-h-0 flex-1 flex-col">{chatOf(props)}</div>
      </>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <OpenAgentDetailContext.Provider value={setDetailId}>{column}</OpenAgentDetailContext.Provider>
      <AnimatePresence>
        {detailId ? (
          <AgentDetail
            key={detailId}
            agentId={detailId}
            parentCwd={session.cwd}
            onClose={() => setDetailId(null)}
            onOpenSession={props.onOpenSession}
            onOpenFile={props.onOpenFile}
            onOpenDiff={props.onOpenDiff}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
