import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../lib/session";
import type { SessionMeta } from "../../../lib/tcserver/types";
import {
  agentLine,
  agentStats,
  fleetCounts,
  isLiveStatus,
  loadsTranscript,
  useAgents,
  useSessionById,
  useSessionIfLoaded,
  type AgentStats,
  type AgentTone,
  type FleetCounts,
} from "../../../lib/threads/agents";
import { useNow } from "../bits";
import { readingPercent, useContextReading, type ContextReading } from "./contextCache";

/**
 * The fleet as one model: ranked rows, counts, whether the panel should be
 * open, and per-row stats. Pure helpers carry the rules; the two hooks
 * wire them to the session store and the context cache.
 */

// ── the fleet's state ───────────────────────────────────────────────────

/** A child works or waits on the user. */
export function fleetActive(counts: FleetCounts): boolean {
  return counts.working > 0 || counts.waiting > 0;
}

// ── row stats ───────────────────────────────────────────────────────────

export type FleetStats = AgentStats & {
  /** The latest compaction never settled: show "compacting…" over the ring. */
  compacting: boolean;
};

/** M4's fold flags `thread.compacting`; older projections just lack it. */
export function isCompacting(session: Session | undefined): boolean {
  return (session?.thread as { compacting?: boolean } | undefined)?.compacting === true;
}

/**
 * Store stats plus the polled reading: the server's window wins over the
 * harness-reported level because it knows the model's window.
 */
export function fleetStats(session: Session | undefined, reading: ContextReading | null): FleetStats {
  const base = agentStats(session);
  const polled = readingPercent(reading);
  return { ...base, ctxPct: polled ?? base.ctxPct, compacting: isCompacting(session) };
}

export type StatsPart =
  | { key: "diff"; adds: number; dels: number }
  | { key: "tasks"; done: number; total: number; pct: number }
  | { key: "compact" }
  | { key: "ctx"; pct: number };

/** The parts of the one-line stats: "+12 −3 · 3/7 tasks · 43% · ◔ 42%". */
export function statsParts(s: FleetStats): StatsPart[] {
  const parts: StatsPart[] = [];
  if (s.adds > 0 || s.dels > 0) parts.push({ key: "diff", adds: s.adds, dels: s.dels });
  if (s.tasksTotal > 0) {
    parts.push({
      key: "tasks",
      done: s.tasksDone,
      total: s.tasksTotal,
      pct: Math.round((s.tasksDone / s.tasksTotal) * 100),
    });
  }
  if (s.compacting) parts.push({ key: "compact" });
  else if (s.ctxPct !== null) parts.push({ key: "ctx", pct: s.ctxPct });
  return parts;
}

/** The row's line, with compaction shown while the agent is live. */
export function fleetLine(
  status: SessionMeta["status"] | undefined,
  session: Session | undefined,
): { text: string; tone: AgentTone } {
  if (isLiveStatus(status) && isCompacting(session)) {
    return { text: "compacting the context…", tone: "muted" };
  }
  return agentLine(status, session?.blocks ?? []);
}

// ── hooks ───────────────────────────────────────────────────────────────

export type FleetModel = {
  agents: SessionMeta[];
  counts: FleetCounts;
  /** A child works or waits. */
  active: boolean;
  anyWaiting: boolean;
  detailId: string | null;
  setDetailId: (id: string | null) => void;
  now: number;
};

/** One thread's fleet, and which row is open. */
export function useFleetModel(sessionId: string): FleetModel {
  const agents = useAgents(sessionId);
  const counts = useMemo(() => fleetCounts(agents), [agents]);
  const active = fleetActive(counts);
  const anyWaiting = counts.waiting > 0;
  const [detailId, setDetailId] = useState<string | null>(null);
  const now = useNow(counts.working > 0);

  // A row that vanished (archived, re-parented) closes its detail.
  useEffect(() => {
    if (detailId && !agents.some((a) => a.id === detailId)) setDetailId(null);
  }, [agents, detailId]);

  return {
    agents,
    counts,
    active,
    anyWaiting,
    detailId,
    setDetailId,
    now,
  };
}

export type AgentModel = {
  session: Session | undefined;
  live: boolean;
  /** Neither working, waiting nor failed. */
  idle: boolean;
  line: { text: string; tone: AgentTone };
  stats: FleetStats;
  elapsed: number;
};

/** One row's derived state: its session, line, stats and the context poll
 *  while live. `fleetSize` decides whether a settled row fetches its
 *  transcript (`loadsTranscript`); otherwise it shows what the store holds. */
export function useAgentModel(agent: SessionMeta, now: number, fleetSize = 1): AgentModel {
  const wanted = loadsTranscript(agent, fleetSize);
  const fetched = useSessionById(wanted ? agent.id : null);
  const held = useSessionIfLoaded(agent.id);
  const session = wanted ? fetched : held;
  const live = isLiveStatus(agent.status);
  const reading = useContextReading(agent.id, live);
  const line = useMemo(() => fleetLine(agent.status, session), [agent.status, session]);
  const stats = useMemo(() => fleetStats(session, reading), [session, reading]);
  return {
    session,
    live,
    idle: !live && agent.status !== "waiting" && agent.status !== "error" && agent.status !== "watching",
    line,
    stats,
    elapsed: live ? now - agent.createdAt : agent.updatedAt - agent.createdAt,
  };
}
