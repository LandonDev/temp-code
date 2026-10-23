import { createContext, useContext, useSyncExternalStore } from "react";
import type { AgentTone } from "../../../lib/threads/agents";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import { whatLine } from "./rowBody";
import { digestLine } from "./useMasterModel";

/**
 * A board row's subagents (docs/LAYOUT.md "Master"): every unarchived
 * session under the child by the parentId chain, subagents of subagents
 * too, from every host's rows in the store (a child on another host
 * spawns there, and its agents carry its bare id). The ones still at work
 * or waiting are lines under the row, the person's first, at most
 * `AGENT_LINES`, the rest counted; settled ones are only a count beside
 * them. The board builds one parent index per meta change and one entry
 * per row from it; a row reads its own, the same object until it says
 * something else.
 */

/** One subagent under a row: what it is and what it is doing, in the
 *  board row's own words (`whatLine` over `digestLine`, meta only). */
export type AgentLine = {
  id: string;
  environmentId: string;
  title: string;
  status: SessionStatus;
  agentType: SessionMeta["agentType"];
  threadType: SessionMeta["threadType"];
  what: { text: string; tone: AgentTone } | null;
};

export type RowAgents = {
  lines: AgentLine[];
  /** Live agents past the cap, and how many of those wait on the person. */
  more: number;
  moreWaiting: number;
  /** Settled agents (idle, done, stopped). */
  done: number;
};

/** The most a row lists; the rest are "and N more". */
export const AGENT_LINES = 3;

const LINE_RANK: Partial<Record<SessionStatus, number>> = {
  waiting: 0,
  error: 1,
  starting: 2,
  running: 2,
  watching: 2,
  paused: 3,
  queued: 3,
};

/** Children by parent id, archived ones included (their own children still count). */
export function parentIndex(metas: readonly SessionMeta[]): Map<string, SessionMeta[]> {
  const by = new Map<string, SessionMeta[]>();
  for (const m of metas) {
    if (!m.parentId) continue;
    (by.get(m.parentId) ?? by.set(m.parentId, []).get(m.parentId)!).push(m);
  }
  return by;
}

/** Every unarchived session under `rootId`, at any depth. */
export function subtreeOf(index: ReadonlyMap<string, readonly SessionMeta[]>, rootId: string): SessionMeta[] {
  const out: SessionMeta[] = [];
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    for (const m of index.get(stack.pop()!) ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      stack.push(m.id);
      if (!m.archived) out.push(m);
    }
  }
  return out;
}

const NO_DIGEST = {};

function lineOf(m: SessionMeta): AgentLine {
  return {
    id: m.id,
    environmentId: m.environmentId,
    title: m.title,
    status: m.status,
    agentType: m.agentType,
    threadType: m.threadType,
    what: whatLine(m, digestLine(m, NO_DIGEST), false),
  };
}

/** The live agents as lines, the person's first (waiting, failed, working,
 *  paused or queued; oldest first within each), capped; null when none is
 *  live, so a row whose agents all settled shows nothing. */
export function rowAgents(agents: readonly SessionMeta[], cap = AGENT_LINES): RowAgents | null {
  const live = agents.filter((m) => LINE_RANK[m.status] !== undefined);
  if (live.length === 0) return null;
  live.sort((a, b) => LINE_RANK[a.status]! - LINE_RANK[b.status]! || a.createdAt - b.createdAt);
  const rest = live.slice(cap);
  return {
    lines: live.slice(0, cap).map(lineOf),
    more: rest.length,
    moreWaiting: rest.filter((m) => m.status === "waiting").length,
    done: agents.length - live.length,
  };
}

/** The quiet line after the agents: "and 2 more · 3 done"; null when
 *  every agent has a line. */
export function agentTail(r: RowAgents): { text: string; waiting: boolean } | null {
  const parts = [r.more > 0 ? `and ${r.more} more` : null, r.done > 0 ? `${r.done} done` : null].filter(Boolean);
  return parts.length ? { text: parts.join(" · "), waiting: r.moreWaiting > 0 } : null;
}

const sig = (r: RowAgents | null): string =>
  r
    ? `${r.more}/${r.moreWaiting}/${r.done}\n` +
      r.lines.map((l) => [l.id, l.environmentId, l.status, l.title, l.agentType, l.threadType, l.what?.tone, l.what?.text].join("\t")).join("\n")
    : "";

/** Every row's agents, from one index of the store. `update` keeps each
 *  row's object while it reads the same and wakes the rows only when one
 *  changed; a row subscribed to its own (`useRowAgents`) re-renders only
 *  when its own did. */
export class AgentSummaries {
  private readonly map = new Map<string, RowAgents | null>();
  private readonly sigs = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = (id: string): RowAgents | null => this.map.get(id) ?? null;

  update(rowIds: readonly string[], metas: readonly SessionMeta[]): void {
    const index = parentIndex(metas);
    let changed = false;
    for (const id of rowIds) {
      const next = rowAgents(subtreeOf(index, id));
      const s = sig(next);
      if (this.sigs.get(id) === s && this.map.has(id)) continue;
      this.sigs.set(id, s);
      this.map.set(id, next);
      changed = true;
    }
    if (changed) for (const l of this.listeners) l();
  }
}

export const AgentSummaryContext = createContext<AgentSummaries | null>(null);

const noSubscribe = (): (() => void) => () => {};

/** One row's live subagents on the board in context; null with none. */
export function useRowAgents(id: string): RowAgents | null {
  const store = useContext(AgentSummaryContext);
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, () => (store ? store.get(id) : null));
}
