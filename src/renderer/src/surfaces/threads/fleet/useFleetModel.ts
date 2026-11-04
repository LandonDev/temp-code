import { useEffect, useMemo, useState } from "react";
import { COMPACTING_WORDS } from "@shared/statusWords";
import type { Session } from "../../../lib/session";
import type { SessionMeta } from "../../../lib/tcserver/types";
import {
  agentStats,
  agentStatus,
  fleetCounts,
  loadsTranscript,
  useAgentTree,
  useSessionById,
  useSessionIfLoaded,
  type AgentStats,
  type AgentStatus,
  type AgentTreeNode,
  type FleetCounts,
} from "../../../lib/threads/agents";
import { readingPercent, type ContextReading } from "../../../lib/contextCache";
import { isCompacting } from "../../../lib/contextUsage";

/**
 * The fleet as one model: ranked rows, counts, whether the panel should be
 * open, each row's status and the detail's numbers. Pure helpers carry the
 * rules; the hooks wire them to the session store.
 */

// ── the fleet's state ───────────────────────────────────────────────────

/** A child works, watches its own work or waits on the user. */
export function fleetActive(counts: FleetCounts): boolean {
  return counts.working > 0 || counts.watching > 0 || counts.waiting > 0;
}

// ── row stats ───────────────────────────────────────────────────────────

export type FleetStats = AgentStats & {
  /** The latest compaction never settled: the detail says Compacting over the context. */
  compacting: boolean;
};

/**
 * Store stats plus the polled reading: the server's window wins over the
 * harness-reported level because it knows the model's window.
 */
export function fleetStats(session: Session | undefined, reading: ContextReading | null): FleetStats {
  const base = agentStats(session);
  const polled = readingPercent(reading);
  return { ...base, ctxPct: polled ?? base.ctxPct, compacting: isCompacting(session) };
}

export type NumberPart =
  | { key: "diff"; adds: number; dels: number }
  | { key: "tasks"; text: string }
  | { key: "context"; text: string }
  | { key: "cost"; text: string };

/** The detail's numbers in order: diff, tasks, context (Compacting while
 *  compaction runs), cost. A fact the agent lacks gives no part; the time
 *  is the turn's closing line ("Working for 12s", "Worked for 3s"). */
export function agentNumbers(s: FleetStats, cost: number | undefined): NumberPart[] {
  const parts: NumberPart[] = [];
  if (s.adds > 0 || s.dels > 0) parts.push({ key: "diff", adds: s.adds, dels: s.dels });
  if (s.tasksTotal > 0) parts.push({ key: "tasks", text: `${s.tasksDone}/${s.tasksTotal} tasks` });
  if (s.compacting) parts.push({ key: "context", text: COMPACTING_WORDS });
  else if (s.ctxPct !== null) parts.push({ key: "context", text: `${s.ctxPct}% context` });
  if (cost !== undefined && cost > 0) parts.push({ key: "cost", text: `$${cost.toFixed(2)}` });
  return parts;
}

// ── hooks ───────────────────────────────────────────────────────────────

export type FleetModel = {
  /** The direct children, each with its descendants (`agentTree`). */
  tree: AgentTreeNode[];
  /** Every row of the tree, top agents and descendants. */
  agents: SessionMeta[];
  counts: FleetCounts;
  /** A child works or waits. */
  active: boolean;
  anyWaiting: boolean;
  detailId: string | null;
  setDetailId: (id: string | null) => void;
};

/** Every row of the tree in the order drawn. */
export function treeRows(tree: readonly AgentTreeNode[]): SessionMeta[] {
  return tree.flatMap((n) => [n.meta, ...n.descendants.map((d) => d.meta)]);
}

/** One thread's fleet, and which row is open. */
export function useFleetModel(sessionId: string): FleetModel {
  const tree = useAgentTree(sessionId);
  const agents = useMemo(() => treeRows(tree), [tree]);
  const counts = useMemo(() => fleetCounts(agents), [agents]);
  const [detailId, setDetailId] = useState<string | null>(null);

  // A row that vanished (archived, re-parented) closes its detail.
  useEffect(() => {
    if (detailId && !agents.some((a) => a.id === detailId)) setDetailId(null);
  }, [agents, detailId]);

  return { tree, agents, counts, active: fleetActive(counts), anyWaiting: counts.waiting > 0, detailId, setDetailId };
}

/** One row's status. The transcript is fetched only under `loadsTranscript`
 *  (a waiting agent's question, a failure the meta lacks); otherwise the row
 *  reads what the store already holds. No context poll, no clock. */
export function useAgentStatus(agent: SessionMeta): AgentStatus {
  const wanted = loadsTranscript(agent);
  const fetched = useSessionById(wanted ? agent.id : null);
  const held = useSessionIfLoaded(agent.id);
  const blocks = (wanted ? fetched : held)?.blocks;
  return useMemo(() => agentStatus(agent, blocks), [agent, blocks]);
}
