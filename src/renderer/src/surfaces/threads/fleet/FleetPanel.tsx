import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useId } from "react";
import type { OpenFileFn } from "../../../lib/search";
import { EASE_OUT } from "../../../lib/ease";
import { ChevronRight, Users } from "../../../chrome/icons";
import { fleetCounts, isLiveStatus, useAgents, useMetaById } from "../../../lib/threads/agents";
import { GLIDE_MAX_ROWS } from "../../../lib/listGlide";
import { MatrixSpinner, PaneHeader, StatusDot } from "../bits";
import { AgentDetail } from "./AgentDetail";
import { AgentRow } from "./AgentRow";
import { useFleetModel } from "./useFleetModel";

const PANEL_W = 340;

/**
 * The subagent panel on a thread's right edge: rows while open, a slim
 * tab with a status dot while folded. It opens itself while any child
 * works or waits on the user; a manual toggle wins until that state
 * flips. Nothing renders when the thread has no children.
 *
 * Row and detail share a layout id scoped to this mount, so two panes on
 * the same thread never morph into each other.
 */
export function FleetPanel({
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
  if (fleet.agents.length === 0) return null;
  const { agents, open, active, anyWaiting, detailId, now } = fleet;

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={scope}>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              key="fleet"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0 } }}
              transition={{ duration: 0.12, ease: EASE_OUT }}
              style={{ width: PANEL_W }}
              className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-content/10"
            >
              <PaneHeader label="Subagents" detail={String(agents.length)}>
                <button
                  type="button"
                  onClick={() => fleet.setOpen(false)}
                  aria-label="Hide subagents"
                  className="pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
                >
                  <ChevronRight className="size-3.5" strokeWidth={1.75} />
                </button>
              </PaneHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2 pt-0">
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    now={now}
                    glide={agents.length <= GLIDE_MAX_ROWS}
                    hidden={agent.id === detailId}
                    onOpen={() => fleet.setDetailId(agent.id)}
                  />
                ))}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {!open ? (
          <button
            type="button"
            onClick={() => fleet.setOpen(true)}
            title="Subagents"
            aria-label="Show subagents"
            className="group flex w-8 shrink-0 flex-col items-center gap-2 border-l border-content/10 pt-4 transition-colors hover:bg-content/5"
          >
            <Users className="size-3.5 text-content/50 transition-colors group-hover:text-content" />
            <StatusDot status={anyWaiting ? "waiting" : active ? "running" : "idle"} />
          </button>
        ) : null}
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
