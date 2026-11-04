import type { Block } from "../lib/session";
import { inputOf } from "../lib/toolDetails";
import { isProseBlock, isThinkingBlock, toolCallState } from "./transcriptActivity";

/**
 * A wait_for_agent call is a state of the turn, never a row: while it is
 * open the working line says "Waiting on <title>", and once it returns each
 * agent that settled folds into the group as one step, as its report would.
 * A wait that returned nothing (steered, aborted, timed out, refused) leaves
 * nothing behind.
 */

/** One agent a wait returned on: its id and the status it settled in. */
export type WaitOutcome = { id: string; status: string };

/** The statuses a settled agent reports; a wait's timeout, refusal, steer and abort are not among them. */
const SETTLED = new Set(["done", "idle", "watching", "waiting", "failed", "error", "stopped", "paused"]);

const shortName = (name: string): string => name.replace(/^mcp__[^_]+(?:__)?/, "").replace(/^.*\./, "");

/** A wait_for_agent call from any harness: claude in-process, codex over the bridge. */
export function isWaitCall(block: Block): boolean {
  return (block.role === "tool" || block.role === "approval") && shortName(block.tool?.name ?? "") === "wait_for_agent";
}

/** A wait still waiting. */
export function isOpenWait(block: Block): boolean {
  return isWaitCall(block) && toolCallState(block) === "pending";
}

/** The agents a wait names, in its own order. */
export function waitIds(block: Block): string[] {
  const input = inputOf(block);
  const many = Array.isArray(input.agentIds) ? input.agentIds.filter((id): id is string => typeof id === "string" && !!id) : [];
  const one = typeof input.agentId === "string" && input.agentId ? [input.agentId] : [];
  return [...new Set([...many, ...one])];
}

/** What a settled wait returned on: each agent that settled, in order; [] for anything else. */
export function waitOutcomes(block: Block): WaitOutcome[] {
  if (!isWaitCall(block) || toolCallState(block) === "pending") return [];
  const detail = block.tool?.detail?.trim();
  if (!detail) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: WaitOutcome[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { agentId, status } = row as { agentId?: unknown; status?: unknown };
    if (typeof agentId === "string" && agentId && typeof status === "string" && SETTLED.has(status)) {
      out.push({ id: agentId, status });
    }
  }
  return out;
}

/**
 * The wait the turn is in now: its last open wait call, when nothing after
 * it speaks (prose, a thought) or still runs beside it. With another call
 * running the turn reads as that work, which is true; the host's status
 * line still says what it waits on.
 */
export function openWaitOf(blocks: readonly Block[]): Block | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (isOpenWait(block)) return block;
    if (isProseBlock(block) || isThinkingBlock(block)) return null;
    if ((block.role === "tool" || block.role === "approval") && toolCallState(block) === "pending") return null;
  }
  return null;
}

/** What a spawn call says about each child it stamped: the title it gave, else its task. */
export type SpawnedName = { title?: string; task?: string };

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * The agents a run's spawn calls named, by id: so a step about an agent the
 * store has not listed (archived, on a host not connected) still says the
 * name its spawn gave it, as a report names it by its stamp.
 */
export function spawnedNames(blocks: readonly Block[]): Map<string, SpawnedName> {
  const names = new Map<string, SpawnedName>();
  for (const block of blocks) {
    const spawned = block.tool?.spawned;
    if (!spawned?.length || (block.tool?.name ?? "").replace(/^.*(__|\.)/, "") !== "spawn_agent") continue;
    const input = inputOf(block);
    const entries = Array.isArray(input.agents) ? (input.agents as { title?: unknown; task?: unknown }[]) : null;
    spawned.forEach((id, i) => {
      const entry = entries ? entries[i] : input;
      names.set(id, { title: text(entry?.title), task: text(entry?.task) ?? text(input.task) });
    });
  }
  return names;
}
