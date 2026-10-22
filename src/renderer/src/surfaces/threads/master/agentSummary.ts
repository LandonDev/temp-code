import { createContext, useContext, useSyncExternalStore } from "react";
import { FLEET_TONES, FLEET_WORDS, fleetCounts } from "../../../lib/threads/agents";
import type { SessionMeta } from "../../../lib/tcserver/types";

/**
 * A board row's subagents (docs/LAYOUT.md "Master"): every unarchived
 * session under the child by the parentId chain, subagents of subagents
 * too, from every host's rows in the store (a child on another host
 * spawns there, and its agents carry its bare id). The board builds one
 * parent index per meta change and one summary per row from it; a row
 * reads its own summary, the same object until it says something else.
 */

export type AgentSummary = { total: number; working: number; waiting: number; failed: number };

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

/** The count and the live states in the fleet's buckets; null with no agents. */
export function agentSummary(agents: readonly Pick<SessionMeta, "status">[]): AgentSummary | null {
  if (agents.length === 0) return null;
  const c = fleetCounts([...agents]);
  return { total: agents.length, working: c.working, waiting: c.waiting, failed: c.failed };
}

/** "4 agents", then each nonzero live state in the fleet header's words
 *  and tones: 4 agents · 2 working · 1 needs approval. Done ones are in
 *  the count only. */
export function agentSummaryParts(s: AgentSummary): { text: string; tone?: string }[] {
  const parts: { text: string; tone?: string }[] = [{ text: `${s.total} ${s.total === 1 ? "agent" : "agents"}` }];
  for (const k of ["working", "waiting", "failed"] as const) {
    if (s[k] > 0) parts.push({ text: `${s[k]} ${FLEET_WORDS[k]}`, tone: FLEET_TONES[k] });
  }
  return parts;
}

export function agentSummaryText(s: AgentSummary | null): string {
  return s ? agentSummaryParts(s).map((p) => p.text).join(" · ") : "";
}

const sig = (s: AgentSummary | null): string => (s ? `${s.total}/${s.working}/${s.waiting}/${s.failed}` : "");

/** Every row's summary, from one index of the store. `update` keeps each
 *  row's object while it reads the same and wakes the rows only when one
 *  changed; a row subscribed to its own (`useAgentSummary`) re-renders only
 *  when its own did. */
export class AgentSummaries {
  private readonly map = new Map<string, AgentSummary | null>();
  private readonly sigs = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = (id: string): AgentSummary | null => this.map.get(id) ?? null;

  update(rowIds: readonly string[], metas: readonly SessionMeta[]): void {
    const index = parentIndex(metas);
    let changed = false;
    for (const id of rowIds) {
      const next = agentSummary(subtreeOf(index, id));
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

/** One row's subagent summary on the board in context; null with none. */
export function useAgentSummary(id: string): AgentSummary | null {
  const store = useContext(AgentSummaryContext);
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, () => (store ? store.get(id) : null));
}
