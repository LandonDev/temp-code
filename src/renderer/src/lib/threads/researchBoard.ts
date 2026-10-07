import type { ResearchSource } from "../tcserver/todos";

/**
 * The research board's data: research-source rows folded into one group
 * per angle (agent), each holding its queries in order with the sources
 * they surfaced beneath. Sources fetched before any query sit under a
 * `null` query. Totals count unique URLs and queries across the thread —
 * a source two angles consulted shows in both groups but counts once.
 */

export type SourceRow = {
  /** the row's identity — a url cited twice is two rows */
  callId: string;
  url: string;
  title?: string;
  /** the one-line finding this source supports (cite_source) */
  claim?: string;
};
export type QueryGroup = {
  /** null = sources fetched before any query (direct fetches) */
  query: string | null;
  sources: SourceRow[];
};
export type Angle = { agentId: string; label: string; queries: QueryGroup[] };
export type ResearchBoard = { angles: Angle[]; sources: number; searches: number };

export const EMPTY_BOARD: ResearchBoard = { angles: [], sources: 0, searches: 0 };

export function foldResearchBoard(rows: ResearchSource[]): ResearchBoard {
  if (rows.length === 0) return EMPTY_BOARD;
  const angles: Angle[] = [];
  const byAgent = new Map<string, Angle>();
  const byCall = new Map<string, SourceRow>();
  const urls = new Set<string>();
  const queries = new Set<string>();
  for (const e of rows) {
    const known = byCall.get(e.callId);
    if (known) {
      if (e.title) known.title = e.title;
      if (e.claim) known.claim = e.claim;
      continue;
    }
    let angle = byAgent.get(e.agentId);
    if (!angle) {
      angle = { agentId: e.agentId, label: e.agentLabel, queries: [] };
      byAgent.set(e.agentId, angle);
      angles.push(angle);
    }
    if (e.query) {
      queries.add(e.query);
      angle.queries.push({ query: e.query, sources: [] });
    } else if (e.url) {
      urls.add(e.url);
      let group = angle.queries[angle.queries.length - 1];
      if (!group) {
        group = { query: null, sources: [] };
        angle.queries.push(group);
      }
      const src: SourceRow = { callId: e.callId, url: e.url, title: e.title, claim: e.claim };
      group.sources.push(src);
      byCall.set(e.callId, src);
    }
  }
  return { angles, sources: urls.size, searches: queries.size };
}

/**
 * The angles the board shows: every child the thread spawned, in spawn
 * order, whether or not it has boarded a source yet (a codebase-only
 * explorer never calls a web tool, but it still has a findings file),
 * plus any other agent that boarded sources — the root's own direct
 * research — ahead of them. Totals are the board's.
 */
export function mergeAngles(board: ResearchBoard, agents: string[]): Angle[] {
  if (agents.length === 0) return board.angles;
  const byAgent = new Map(board.angles.map((a) => [a.agentId, a]));
  const spawned = new Set(agents);
  return [
    ...board.angles.filter((a) => !spawned.has(a.agentId)),
    ...agents.map((agentId) => byAgent.get(agentId) ?? { agentId, label: "", queries: [] }),
  ];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
