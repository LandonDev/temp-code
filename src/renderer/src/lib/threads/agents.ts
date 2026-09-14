import { useEffect, useRef, useSyncExternalStore } from "react";
import { contextPercent } from "../contextUsage";
import { findModel } from "../models";
import type { Block, Session } from "../session";
import { asHarness, pickerModelId, sessionStore } from "../tcserver/store";
import { tallyOf } from "../tcserver/todos";
import type { SessionMeta, SessionStatus } from "../tcserver/types";

/**
 * Fleet selectors: which children a thread has, how they rank, and the one
 * line + stats a row shows for each. Pure functions first, hooks after.
 */

// ── rank and order ─────────────────────────────────────────────────────

const RANK: Partial<Record<SessionStatus, number>> = {
  waiting: 0,
  error: 1,
  starting: 2,
  running: 2,
};

/** Rows sort by what needs the user first: waiting, failed, working, done. */
export function agentRank(status: SessionStatus | undefined): number {
  return (status && RANK[status]) ?? 3;
}

export function isLiveStatus(status: SessionStatus | undefined): boolean {
  return status === "running" || status === "starting";
}

export function sortAgents<T extends { status: SessionStatus; createdAt: number }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => agentRank(a.status) - agentRank(b.status) || a.createdAt - b.createdAt,
  );
}

/** Unarchived children of `parentId`, ranked. */
export function childrenOf(metas: SessionMeta[], parentId: string): SessionMeta[] {
  return sortAgents(metas.filter((m) => m.parentId === parentId && !m.archived));
}

export type FleetCounts = { working: number; waiting: number; failed: number; done: number };

export function fleetCounts(agents: { status: SessionStatus }[]): FleetCounts {
  const out: FleetCounts = { working: 0, waiting: 0, failed: 0, done: 0 };
  for (const a of agents) {
    if (isLiveStatus(a.status)) out.working++;
    else if (a.status === "waiting") out.waiting++;
    else if (a.status === "error") out.failed++;
    else out.done++;
  }
  return out;
}

/** The catalog name for a server (provider, native model) pair. */
export function modelLabel(provider: string, model: string): string {
  return findModel(pickerModelId(asHarness(provider), model))?.name ?? model;
}

// ── transcript lines ───────────────────────────────────────────────────

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "description", "query"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return firstLine(v);
  }
  return "";
}

/** What the agent is doing right now: its latest tool call, else its
 *  latest words, else its latest error. */
export function activityLine(blocks: Block[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.role === "tool") {
      const name = b.tool?.name ?? b.tool?.title ?? "tool";
      const detail = b.tool?.detail || toolDetail(b.tool?.input);
      return detail ? `${name} · ${detail}` : name;
    }
    if (b.role === "assistant" && b.text.trim()) return firstLine(b.text);
    if (b.role === "system" && b.id.startsWith("err:") && b.text.trim()) return firstLine(b.text);
  }
  return "";
}

export function lastAssistantLine(blocks: Block[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.role === "assistant" && b.text.trim()) return firstLine(b.text);
  }
  return "";
}

/** The task the agent was handed: its first user message. */
export function taskTitle(blocks: Block[]): string {
  const first = blocks.find((b) => b.role === "user" && b.text.trim());
  return first ? firstLine(first.text) : "";
}

export function lastErrorLine(blocks: Block[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.role === "system" && b.id.startsWith("err:") && b.text.trim()) return firstLine(b.text);
  }
  return "";
}

export type AgentTone = "warning" | "danger" | "muted";

export const TONE_CLASS: Record<AgentTone, string> = {
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-content/50",
};

/** The row's one-line status and its colour. */
export function agentLine(status: SessionStatus | undefined, blocks: Block[]): { text: string; tone: AgentTone } {
  if (status === "waiting") {
    const last = [...blocks].reverse().find((b) => b.question || (b.approval && !b.approval.decided));
    if (last?.question) {
      const q = last.question.questions[0]?.question ?? "";
      return { text: q ? `has a question — ${firstLine(q)}` : "has a question", tone: "warning" };
    }
    const title = last?.tool?.title ?? last?.tool?.name ?? "";
    return { text: title ? `waiting for approval — ${title}` : "waiting for approval", tone: "warning" };
  }
  if (status === "error") return { text: lastErrorLine(blocks) || "failed", tone: "danger" };
  if (isLiveStatus(status)) return { text: activityLine(blocks), tone: "muted" };
  return { text: lastAssistantLine(blocks), tone: "muted" };
}

// ── stats ──────────────────────────────────────────────────────────────

export type AgentStats = {
  adds: number;
  dels: number;
  tasksDone: number;
  tasksTotal: number;
  /** Whole percent of the context window in use; null when unknown. */
  ctxPct: number | null;
  cost: number | undefined;
};

export function agentStats(session: Session | undefined): AgentStats {
  let adds = 0;
  let dels = 0;
  for (const b of session?.blocks ?? []) {
    if (b.role !== "tool" || !b.tool?.preview) continue;
    adds += b.tool.preview.additions ?? 0;
    dels += b.tool.preview.deletions ?? 0;
  }
  const tasks = session?.tasks ?? (session?.thread ? tallyOf(session.thread.todos) : null);
  return {
    adds,
    dels,
    tasksDone: tasks?.done ?? 0,
    tasksTotal: tasks?.total ?? 0,
    ctxPct: contextPercent(session?.context),
    cost: session?.thread?.cost,
  };
}

export function hasStats(s: AgentStats): boolean {
  return s.adds > 0 || s.dels > 0 || s.tasksTotal > 0 || s.ctxPct !== null;
}

// ── hooks ──────────────────────────────────────────────────────────────

function sameList(a: SessionMeta[], b: SessionMeta[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

/** The ranked children of `parentId`, each subscribed so its blocks fold. */
export function useAgents(parentId: string): SessionMeta[] {
  const cache = useRef<SessionMeta[]>([]);
  const agents = useSyncExternalStore(sessionStore.onMetaChange.bind(sessionStore), () => {
    const next = childrenOf(sessionStore.metas(), parentId);
    if (!sameList(cache.current, next)) cache.current = next;
    return cache.current;
  });
  const key = agents.map((a) => a.id).join(",");
  useEffect(() => {
    for (const id of key ? key.split(",") : []) void sessionStore.ensureLoaded(id);
  }, [key]);
  return agents;
}

/** One session's folded state, loading its transcript on first use. */
export function useSessionById(id: string | null): Session | undefined {
  const session = useSyncExternalStore(sessionStore.subscribe, () =>
    id ? sessionStore.get(id) : undefined,
  );
  useEffect(() => {
    if (id) void sessionStore.ensureLoaded(id);
  }, [id]);
  return session;
}

const subscribeMeta = (listener: () => void): (() => void) => sessionStore.onMetaChange(listener);

export function useMetaById(id: string | null): SessionMeta | null {
  return useSyncExternalStore(subscribeMeta, () => (id ? sessionStore.metaOf(id) : null));
}
