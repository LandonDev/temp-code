import { AnimatePresence } from "motion/react";
import { Empty, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import type { OpenFileFn } from "../../../lib/search";
import { AgentDetail } from "./AgentDetail";
import { AgentRow } from "./AgentRow";
import { useFleetModel } from "./useFleetModel";

/**
 * The subagent rows: the right panel's Agents section (surfaces/RightPanel.tsx),
 * with the agent detail sheet over the pane when a row is open. The rows
 * sit in a scroll area with the Activity section's inset and carry no
 * motion (docs/DESIGN.md: list rows animate nothing); only the detail has
 * an exit.
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
  const { agents, detailId } = fleet;

  return (
    <>
      {agents.length === 0 ? (
        <Empty className="p-6">
          <EmptyHeader>
            <EmptyTitle>No subagents</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 px-1 py-3" data-slot="agents-section">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} selected={detailId === agent.id} onOpen={() => fleet.setDetailId(agent.id)} />
            ))}
          </div>
        </ScrollArea>
      )}
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
    </>
  );
}
