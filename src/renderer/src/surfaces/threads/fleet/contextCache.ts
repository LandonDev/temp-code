import { useEffect, useSyncExternalStore } from "react";
import { client } from "../../../lib/tcserver/client";

/**
 * A per-session cache of the server's `session.context` reading, polled
 * every 20 s while a session is live and once when polling starts. Rows
 * read it through `useContextReading`; nothing here is global — a
 * session's poll runs only while some row asks for it, and stops when the
 * last one lets go.
 *
 * The server answers null while the agent is mid-turn, so a null reply
 * keeps the previous reading rather than clearing it.
 */

export type ContextCategory = { name: string; tokens: number; color?: string };
export type ContextMemoryFile = { path: string; tokens: number };
export type ContextMcpTool = { name: string; server: string; tokens: number };

export type ContextReading = {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model?: string;
  /** The /context breakdown, where the harness reports one (claude does). */
  categories?: ContextCategory[];
  memoryFiles?: ContextMemoryFile[];
  mcpTools?: ContextMcpTool[];
};

export const CONTEXT_POLL_MS = 20_000;

type Fetcher = (sessionId: string) => Promise<unknown>;
type Timers = {
  setInterval: (cb: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
};

const fetchOverWs: Fetcher = (sessionId) => client.request("session.context", { sessionId });
const windowTimers: Timers = {
  setInterval: (cb, ms) => window.setInterval(cb, ms),
  clearInterval: (id) => window.clearInterval(id),
};

/** Whole percent of the window in use, or null when the reading has no window. */
export function readingPercent(r: ContextReading | null | undefined): number | null {
  if (!r || !r.maxTokens || r.maxTokens <= 0) return null;
  const pct = Number.isFinite(r.percentage) ? r.percentage : (r.totalTokens / r.maxTokens) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Narrow whatever the server sent to a reading; anything else is "no reading". */
export function parseReading(raw: unknown): ContextReading | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.totalTokens !== "number" || typeof rec.maxTokens !== "number") return null;
  const reading: ContextReading = {
    totalTokens: rec.totalTokens,
    maxTokens: rec.maxTokens,
    percentage: typeof rec.percentage === "number" ? rec.percentage : 0,
    model: typeof rec.model === "string" ? rec.model : undefined,
  };
  const categories = list(rec.categories, (c) =>
    typeof c.name === "string" && typeof c.tokens === "number"
      ? { name: c.name, tokens: c.tokens, ...(typeof c.color === "string" ? { color: c.color } : {}) }
      : null,
  );
  if (categories) reading.categories = categories;
  const memoryFiles = list(rec.memoryFiles, (m) =>
    typeof m.path === "string" && typeof m.tokens === "number" ? { path: m.path, tokens: m.tokens } : null,
  );
  if (memoryFiles) reading.memoryFiles = memoryFiles;
  const mcpTools = list(rec.mcpTools, (t) =>
    typeof t.name === "string" && typeof t.tokens === "number"
      ? { name: t.name, server: typeof t.serverName === "string" ? t.serverName : "", tokens: t.tokens }
      : null,
  );
  if (mcpTools) reading.mcpTools = mcpTools;
  return reading;
}

function list<T>(raw: unknown, pick: (rec: Record<string, unknown>) => T | null): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: T[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = pick(item as Record<string, unknown>);
    if (v) out.push(v);
  }
  return out;
}

/** What a re-render hangs on: totals plus the breakdown's shape and sizes. */
function signature(r: ContextReading): string {
  const cats = r.categories?.map((c) => `${c.name}=${c.tokens}`).join(",") ?? "";
  return `${r.totalTokens}/${r.maxTokens}/${r.percentage}|${cats}|${r.memoryFiles?.length ?? ""}|${r.mcpTools?.length ?? ""}`;
}

export class ContextCache {
  private readings = new Map<string, ContextReading>();
  private listeners = new Set<() => void>();
  private polls = new Map<string, { refs: number; timer: number }>();

  constructor(
    private fetcher: Fetcher = fetchOverWs,
    private timers: Timers = windowTimers,
  ) {}

  get(sessionId: string): ContextReading | null {
    return this.readings.get(sessionId) ?? null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Fetch once now; a null reply leaves the last reading in place. */
  async refresh(sessionId: string): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.fetcher(sessionId);
    } catch {
      return;
    }
    const next = parseReading(raw);
    if (!next) return;
    const prev = this.readings.get(sessionId);
    if (prev && signature(prev) === signature(next)) return;
    this.readings.set(sessionId, next);
    for (const l of this.listeners) l();
  }

  /** Start (or share) the poll for one session; returns the release. */
  poll(sessionId: string): () => void {
    const entry = this.polls.get(sessionId);
    if (entry) {
      entry.refs++;
    } else {
      void this.refresh(sessionId);
      const timer = this.timers.setInterval(() => void this.refresh(sessionId), CONTEXT_POLL_MS);
      this.polls.set(sessionId, { refs: 1, timer });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.polls.get(sessionId);
      if (!cur) return;
      if (--cur.refs > 0) return;
      this.timers.clearInterval(cur.timer);
      this.polls.delete(sessionId);
    };
  }

  polling(sessionId: string): boolean {
    return this.polls.has(sessionId);
  }
}

export const contextCache = new ContextCache();

/**
 * The cached reading for `sessionId`, polling while `live`. The first
 * fetch fires as soon as a live row mounts, so the ring shows before the
 * first 20 s tick.
 */
export function useContextReading(sessionId: string, live: boolean): ContextReading | null {
  const reading = useSyncExternalStore(contextCache.subscribe, () => contextCache.get(sessionId));
  useEffect(() => {
    if (!live) return;
    return contextCache.poll(sessionId);
  }, [sessionId, live]);
  return reading;
}
