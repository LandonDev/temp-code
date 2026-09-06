import { AnimatePresence, MotionConfig } from "motion/react";
import type { OpenFileFn } from "../../../lib/search";
import { useState } from "react";
import { ChevronRight, Users } from "../../../chrome/icons";
import { fleetCounts, isLiveStatus, useAgents, useMetaById } from "../../../lib/threads/agents";
import { MatrixSpinner, useNow } from "../bits";
import { AgentDetail } from "./AgentDetail";
import { AgentRow } from "./AgentRow";

const PANEL_W = 340;

/**
 * The subagent panel on a thread's right edge: rows while open, a slim
 * tab with a status dot while folded. It opens itself while any child is
 * live; a manual toggle wins until that state flips. Nothing renders
 * when the thread has no children.
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
  const agents = useAgents(sessionId);
  const anyLive = agents.some((a) => isLiveStatus(a.status));
  const anyWaiting = agents.some((a) => a.status === "waiting");
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const now = useNow(anyLive);

  // A manual toggle wins until the fleet next changes state, at which point
  // the panel follows the fleet again (same render-phase reset as temp-code).
  const [sawLive, setSawLive] = useState(anyLive);
  if (anyLive !== sawLive) {
    setSawLive(anyLive);
    setUserOpen(null);
  }

  if (agents.length === 0) return null;
  const open = userOpen ?? anyLive;

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="relative shrink-0 overflow-hidden border-l border-content/10 transition-[width] duration-200 ease-out"
        style={{ width: open ? PANEL_W : 32 }}
      >
        {open ? (
          <div className="flex h-full flex-col" style={{ width: PANEL_W }}>
            <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
              <span className="text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">Subagents</span>
              <span className="text-[11px] tabular-nums text-content/35">{agents.length}</span>
              <button
                type="button"
                onClick={() => setUserOpen(false)}
                aria-label="Hide subagents"
                className="ml-auto flex size-6 items-center justify-center rounded-md text-content/45 transition-colors hover:bg-content/5 hover:text-content"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-3">
              {agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  now={now}
                  hidden={agent.id === detailId}
                  onOpen={() => setDetailId(agent.id)}
                />
              ))}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setUserOpen(true)}
            title="Subagents"
            aria-label="Show subagents"
            className="group flex h-full w-8 flex-col items-center gap-2 pt-2.5 transition-colors hover:bg-content/5"
          >
            <Users className="size-3.5 text-content/55 transition-colors group-hover:text-content" />
            <span
              className={`size-1.5 rounded-full ${
                anyWaiting ? "bg-warning" : anyLive ? "animate-pulse bg-success" : "bg-content/20"
              }`}
            />
          </button>
        )}
      </div>
      <AnimatePresence>
        {detailId && (
          <AgentDetail
            key={detailId}
            agentId={detailId}
            parentCwd={parentCwd}
            onClose={() => setDetailId(null)}
            onOpenSession={onOpenSession}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        )}
      </AnimatePresence>
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
