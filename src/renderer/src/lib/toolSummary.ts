import { createContext, useContext, useEffect, useReducer, useRef, useState } from "react";
import type { Block } from "./session";
import { client } from "./tcserver/client";
import {
  loadSummaryModel,
  loadToolCaptions,
  loadToolSummaries,
  type SummaryModel,
} from "./settings";

/**
 * Model-written headers for a settled group of tool calls, over the
 * server's `tools.summarize`. The request goes out once, only after every
 * output in the group is final, so a sentence never overrides itself;
 * the server caches by group key, and this side keeps the answer for the
 * life of the window. Where nothing has arrived the caller keeps the
 * humanized header it already has.
 */

export type SummarizeItem = { name: string; detail: string; output?: string };
export type SummaryResult = { sentence: string | null; captions: (string | null)[] };
export type SummaryWants = { sentence: boolean; captions: boolean };
export type SummaryLink = { request<T>(method: string, params?: unknown): Promise<T> };

export const MAX_SUMMARY_ITEMS = 24;
export const SUMMARY_OUTPUT_CHARS = 220;
const DETAIL_CHARS = 200;
const OPEN_STATUSES = new Set(["running", "pending", "in_progress", "starting"]);
export const EMPTY_SUMMARY: SummaryResult = { sentence: null, captions: [] };

/** Rows the summariser reads: tool calls and approvals, never questions. */
export function isSummaryTool(block: Block): boolean {
  return (block.role === "tool" || block.role === "approval") && !block.question;
}

/** Its output is final: nothing streams, nothing waits on the user. */
export function toolSettled(block: Block): boolean {
  if (block.streaming) return false;
  if (block.approval && !block.approval.decided) return false;
  return !OPEN_STATUSES.has(block.tool?.status?.toLowerCase() ?? "");
}

export function summaryGroupSettled(blocks: Block[], active: boolean): boolean {
  const tools = blocks.filter(isSummaryTool);
  return !active && tools.length > 0 && tools.every(toolSettled);
}

export function groupKeyFor(tools: Block[]): string {
  const first = tools[0];
  return `${first?.tool?.callId ?? first?.id ?? "none"}:${tools.length}`;
}

/**
 * The cache key for what this group wants, or null while it is not yet
 * worth asking: still running, empty, or a lone call with captions off
 * (one row summarises itself).
 */
export function summaryKeyFor(
  blocks: Block[],
  active: boolean,
  wants: SummaryWants,
): string | null {
  if (!summaryGroupSettled(blocks, active)) return null;
  const tools = blocks.filter(isSummaryTool);
  const sentence = wants.sentence && tools.length > 1;
  if (!sentence && !wants.captions) return null;
  return `${groupKeyFor(tools)}:${wants.captions ? "c" : "s"}`;
}

export function summaryItemsFor(tools: Block[]): SummarizeItem[] {
  return tools.slice(0, MAX_SUMMARY_ITEMS).map((block) => {
    const name = block.tool?.name ?? block.tool?.kind ?? "tool";
    const detail = (block.text || block.tool?.title || name).slice(0, DETAIL_CHARS);
    const output = block.tool?.detail;
    return {
      name,
      detail,
      ...(output !== undefined ? { output: output.slice(0, SUMMARY_OUTPUT_CHARS) } : {}),
    };
  });
}

export function summaryRequestFor(
  sessionId: string,
  tools: Block[],
  model: SummaryModel,
  captions: boolean,
): {
  sessionId: string;
  groupKey: string;
  items: SummarizeItem[];
  model: SummaryModel;
  captions: boolean;
} {
  return { sessionId, groupKey: groupKeyFor(tools), items: summaryItemsFor(tools), model, captions };
}

const cache = new Map<string, SummaryResult>();
const inflight = new Map<string, Promise<SummaryResult>>();

export function cachedSummary(key: string): SummaryResult | undefined {
  return cache.get(key);
}

/** One request per key; a failure caches as empty so a group never retries in a loop. */
export function fetchSummary(
  key: string,
  sessionId: string,
  tools: Block[],
  wants: SummaryWants,
  model: SummaryModel,
  link: SummaryLink = client,
): Promise<SummaryResult> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = link
    .request<SummaryResult | null>(
      "tools.summarize",
      summaryRequestFor(sessionId, tools, model, wants.captions),
    )
    .then(
      (result) => normalizeSummary(result, wants),
      () => EMPTY_SUMMARY,
    )
    .then((result) => {
      cache.set(key, result);
      inflight.delete(key);
      return result;
    });
  inflight.set(key, run);
  return run;
}

function normalizeSummary(result: SummaryResult | null, wants: SummaryWants): SummaryResult {
  if (!result) return EMPTY_SUMMARY;
  const sentence = wants.sentence && typeof result.sentence === "string" && result.sentence.trim()
    ? result.sentence.trim()
    : null;
  const captions = wants.captions && Array.isArray(result.captions)
    ? result.captions.map((c) => (typeof c === "string" && c.trim() ? c.trim() : null))
    : [];
  return { sentence, captions };
}

export function resetSummaryCacheForTest(): void {
  cache.clear();
  inflight.clear();
}

export function summaryWants(): SummaryWants {
  return { sentence: loadToolSummaries(), captions: loadToolCaptions() };
}

/**
 * The summary for a phase, once it can have one. Settings are read on
 * mount: the header is stable, and the toggles in Settings apply to the
 * next transcript you open.
 */
export function useSectionSummary(
  sessionId: string | undefined,
  blocks: Block[],
  active: boolean,
): SummaryResult {
  const [wants] = useState(summaryWants);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const latest = useRef(blocks);
  latest.current = blocks;
  const key = sessionId ? summaryKeyFor(blocks, active, wants) : null;
  useEffect(() => {
    if (!key || !sessionId || cache.has(key)) return;
    let live = true;
    void fetchSummary(
      key,
      sessionId,
      latest.current.filter(isSummaryTool),
      wants,
      loadSummaryModel(),
    ).then(() => {
      if (live) bump();
    });
    return () => {
      live = false;
    };
  }, [key, sessionId, wants]);
  return (key && cache.get(key)) || EMPTY_SUMMARY;
}

/** callId → caption, for the rows under a summarised header. */
export function captionMapOf(tools: Block[], result: SummaryResult): Map<string, string> {
  const map = new Map<string, string>();
  tools.slice(0, MAX_SUMMARY_ITEMS).forEach((block, i) => {
    const caption = result.captions[i];
    const id = block.tool?.callId ?? block.id;
    if (caption) map.set(id, caption);
  });
  return map;
}

/** Rows read their caption from the phase that fetched it. */
export const ToolCaptionsContext = createContext<ReadonlyMap<string, string> | null>(null);

export function useToolCaption(block: Block): string | undefined {
  const map = useContext(ToolCaptionsContext);
  return map?.get(block.tool?.callId ?? block.id);
}
