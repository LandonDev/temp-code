import { motion, useReducedMotion } from "motion/react";
import { SPRING_PANEL } from "../../../lib/ease";
import { HarnessIcon } from "../../../chrome/HarnessIcon";
import { Check, X } from "../../../chrome/icons";
import { TONE_CLASS, hasStats, isLiveStatus, modelLabel } from "../../../lib/threads/agents";
import { asHarness } from "../../../lib/tcserver/store";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { Spinner, duration } from "../bits";
import { statsParts, useAgentModel, type FleetStats } from "./useFleetModel";

/**
 * One subagent as a row: status glyph, title, what it is doing, its edit
 * and task tallies, and on the right its model, elapsed time and cost.
 */

export function StatusGlyph({ status }: { status: SessionMeta["status"] }) {
  if (isLiveStatus(status)) return <Spinner className="size-3.5 text-content/40" />;
  if (status === "waiting") return <span className="size-2 motion-safe:animate-pulse rounded-full bg-warning" />;
  if (status === "error") return <X className="size-3.5 text-danger" />;
  return <Check className="size-3.5 text-success" />;
}

function CtxRing({ pct }: { pct: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90">
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="stroke-content/15" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        strokeLinecap="round"
        className={pct >= 85 ? "stroke-warning" : "stroke-content/50"}
      />
    </svg>
  );
}

/** The stats as one quiet line: "+120 −45 · 3/7 tasks · 43% · ◔ 42%". */
export function AgentStatsLine({ stats, className = "" }: { stats: FleetStats; className?: string }) {
  if (!hasStats(stats) && !stats.compacting) return null;
  const parts = statsParts(stats);
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] tabular-nums text-content/40 ${className}`}>
      {parts.map((p, i) => (
        <span key={p.key} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="text-content/20">·</span>}
          {p.key === "diff" ? (
            <span>
              <span className="text-success">+{p.adds}</span> <span className="text-danger">−{p.dels}</span>
            </span>
          ) : p.key === "tasks" ? (
            <span>
              {p.done}/{p.total} tasks · {p.pct}%
            </span>
          ) : p.key === "compact" ? (
            <span className="text-violet">compacting…</span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <CtxRing pct={p.pct} />
              {p.pct}%
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * `hidden` while the detail is open: the row keeps its slot but yields the
 * shared `agent-${id}` layoutId, so the detail morphs out of and back into it.
 */
export function AgentRow({
  agent,
  now,
  hidden = false,
  onOpen,
}: {
  agent: SessionMeta;
  now: number;
  hidden?: boolean;
  onOpen: () => void;
}) {
  const reduce = useReducedMotion();
  const { session, live, idle, line, stats, elapsed } = useAgentModel(agent, now);
  const cost = session?.thread?.cost;

  return (
    <motion.button
      type="button"
      layout
      layoutId={`agent-${agent.id}`}
      transition={SPRING_PANEL}
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: hidden ? 0 : 1, y: 0 }}
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-content/5"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StatusGlyph status={agent.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`truncate text-[13px] font-medium ${idle ? "text-content/50" : "text-content"}`}>
          {agent.title || "Subagent"}
        </span>
        {line.text ? (
          <span className={`truncate text-[11px] leading-4 ${TONE_CLASS[line.tone]}`}>{line.text}</span>
        ) : live ? (
          <span className="text-[11px] leading-4 text-content/40 italic">starting up</span>
        ) : null}
        <AgentStatsLine stats={stats} />
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] tabular-nums text-content/40">
        <span className="inline-flex items-center gap-1">
          <HarnessIcon harness={asHarness(agent.provider)} className="size-3" />
          {modelLabel(agent.provider, agent.model)}
        </span>
        {(elapsed > 2000 || cost !== undefined) && (
          <span>
            {elapsed > 2000 ? duration(elapsed) : null}
            {cost !== undefined ? `${elapsed > 2000 ? " · " : ""}$${cost.toFixed(2)}` : null}
          </span>
        )}
      </span>
    </motion.button>
  );
}
