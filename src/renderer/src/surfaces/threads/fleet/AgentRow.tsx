import { motion, useReducedMotion } from "motion/react";
import { ENTER, SPRING_PANEL } from "../../../lib/ease";
import { HarnessIcon } from "../../../chrome/HarnessIcon";
import { TONE_CLASS, modelLabel } from "../../../lib/threads/agents";
import { asHarness } from "../../../lib/tcserver/store";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { duration } from "../bits";
import { AgentStatsLine, StatusGlyph } from "./rowBits";
import { useAgentModel } from "./useFleetModel";

/**
 * One subagent as a row: status glyph, title, what it is doing, its edit
 * and task tallies, and on the right its model, elapsed time and cost.
 * The pieces are rowBits.tsx, shared with the master board's rows.
 */

/**
 * One subagent's row. `glide` lets the row animate reorders; parents pass
 * it only while the list is at or under GLIDE_MAX_ROWS.
 */
export function AgentRow({
  agent,
  now,
  glide = false,
  fleetSize = 1,
  onOpen,
}: {
  agent: SessionMeta;
  now: number;
  glide?: boolean;
  /** How many rows the board shows; large fleets load settled rows on open only. */
  fleetSize?: number;
  onOpen: () => void;
}) {
  const reduce = useReducedMotion();
  const { session, live, idle, line, stats, elapsed } = useAgentModel(agent, now, fleetSize);
  const cost = session?.thread?.cost;

  return (
    <motion.button
      type="button"
      layout={glide && !reduce}
      transition={{ ...SPRING_PANEL, opacity: ENTER.transition, y: ENTER.transition }}
      initial={reduce ? false : ENTER.initial}
      animate={ENTER.animate}
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-content/5 active:bg-content/10"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StatusGlyph status={agent.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`truncate text-[13px] font-medium ${idle ? "text-content/50" : "text-content"}`}>
          {agent.title || "Subagent"}
        </span>
        {line.text ? (
          <span className={`truncate text-xs leading-4 ${TONE_CLASS[line.tone]}`}>{line.text}</span>
        ) : live ? (
          <span className="text-xs leading-4 text-content/40 italic">starting up</span>
        ) : null}
        <AgentStatsLine stats={stats} />
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs tabular-nums text-content/40">
        <span className="inline-flex items-center gap-1">
          <HarnessIcon harness={asHarness(agent.provider)} className="size-3.5" />
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
