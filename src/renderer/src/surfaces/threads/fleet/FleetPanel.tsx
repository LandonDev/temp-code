import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useId } from "react";
import type { OpenFileFn } from "../../../lib/search";
import { EASE_OUT } from "../../../lib/ease";
import { ChevronRight, Users } from "../../../chrome/icons";
import { fleetCounts, isLiveStatus, useAgents, useMetaById } from "../../../lib/threads/agents";
import { MatrixSpinner } from "../bits";
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
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: PANEL_W, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: EASE_OUT }}
              className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-content/10"
            >
              <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3" style={{ width: PANEL_W }}>
                <span className="text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">Subagents</span>
                <span className="text-[11px] tabular-nums text-content/35">{agents.length}</span>
                <button
                  type="button"
                  onClick={() => fleet.setOpen(false)}
                  aria-label="Hide subagents"
                  className="ml-auto flex size-6 items-center justify-center rounded-md text-content/45 transition-colors hover:bg-content/5 hover:text-content"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
              <div
                className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-3"
                style={{ width: PANEL_W }}
              >
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
            <Users className="size-3.5 text-content/55 transition-colors group-hover:text-content" />
            <span
              className={`size-1.5 rounded-full ${
                anyWaiting ? "bg-warning" : active ? "animate-pulse bg-success" : "bg-content/20"
              }`}
            />
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
    <div className="mx-auto flex w-full max-w-[688px] items-center gap-2 px-6 pb-1 text-[12px] text-content/55">
      {counts.working > 0 ? (
        <MatrixSpinner cell={2} />
      ) : (
        <span className="size-1.5 animate-pulse rounded-full bg-warning" />
      )}
      {label}
    </div>
  );
}
