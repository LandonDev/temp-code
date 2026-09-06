import { useMemo, useState } from "react";
import { ChevronRight } from "../../chrome/icons";
import { isLiveStatus, taskTitle, useAgents } from "../../lib/threads/agents";
import { PaneHeader, useNow } from "./bits";
import { AgentDetail } from "./fleet/AgentDetail";
import { AgentRow } from "./fleet/AgentRow";
import { FleetHeader } from "./fleet/FleetHeader";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Orchestration thread: the fleet as full-width rows on the board, the
 * orchestrator's own stream and composer as the log column that folds to
 * an edge tab. Until the first agent spawns the log is the whole view.
 */
export function OrchestrationView(props: ThreadViewProps) {
  const { session } = props;
  const agents = useAgents(session.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(true);
  const anyLive = agents.some((a) => isLiveStatus(a.status));
  const now = useNow(anyLive);
  const hasBoard = agents.length > 0;
  const goal = useMemo(() => {
    const last = [...session.blocks].reverse().find((b) => b.role === "user" && b.text.trim());
    return last ? last.text.trim().split("\n")[0].trim() : taskTitle(session.blocks);
  }, [session.blocks]);
  const empty = session.blocks.length === 0 && !hasBoard && !session.busy;

  const board = (
    <div className="min-h-0 flex-1 overflow-y-auto select-text">
      <div className="mx-auto w-full max-w-3xl px-6 py-5">
        <FleetHeader goal={goal} agents={agents} />
        <div className="-mx-3 flex flex-col gap-0.5">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} now={now} onOpen={() => setOpenId(agent.id)} />
          ))}
        </div>
      </div>
    </div>
  );

  const chat = (
    <>
      {hasBoard ? (
        <PaneHeader label="Orchestrator log">
          <button
            type="button"
            onClick={() => setLogOpen(false)}
            title="Hide orchestrator log"
            aria-label="Hide orchestrator log"
            className="flex size-6 items-center justify-center rounded-md text-content/55 transition-colors hover:bg-content/5 hover:text-content"
          >
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </button>
        </PaneHeader>
      ) : null}
      {props.renderChat({
        topSlot: empty ? (
          <p className="mx-auto w-full max-w-[688px] px-6 pb-2 text-[13px] text-content/45">
            Describe the goal. The orchestrator splits it across subagents and picks a model for each.
          </p>
        ) : undefined,
      })}
    </>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SplitShell
        board={board}
        chat={chat}
        hasBoard={hasBoard}
        collapsed={!logOpen}
        onOpenChat={() => setLogOpen(true)}
        status={session.status}
        edgeTitle="Show orchestrator log"
      />
      {openId && (
        <AgentDetail
          agentId={openId}
          parentCwd={session.cwd}
          onClose={() => setOpenId(null)}
          onOpenSession={props.onOpenSession}
          onOpenFile={props.onOpenFile}
          onOpenDiff={props.onOpenDiff}
        />
      )}
    </div>
  );
}
