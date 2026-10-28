import { useEffect, useRef, useSyncExternalStore } from "react";
import { contextPercent } from "../contextUsage";
import { STATUS_WORD, statusNeedsYou, statusToneClass, threadStateOf, type ThreadState } from "../../components/ui/status";
import { findModel } from "../models";
import type { Block, Session } from "../session";
import { asHarness, pickerModelId, sessionStore } from "../tcserver/store";
import { tallyOf } from "../tcserver/todos";
import type { SessionMeta, SessionStatus } from "../tcserver/types";
import { lowerFirst } from "../threadStripModel";

/**
 * Fleet selectors: which children a thread has, how they rank, the status
 * a row shows for each and the stats its detail shows. Pure functions first, hooks after.
 */

// ── rank and order ─────────────────────────────────────────────────────

const FIRST: readonly ThreadState[] = ["waiting", "failed", "working"];

/** Rows sort by what needs the user first: waiting, failed, working, then the rest. */
export function agentRank(status: SessionStatus | undefined): number {
  const i = FIRST.indexOf(threadStateOf(status));
  return i < 0 ? FIRST.length : i;
}

export function isLiveStatus(status: SessionStatus | undefined): boolean {
  return threadStateOf(status) === "working";
}

export function sortAgents<T extends { status: SessionStatus; createdAt: number }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => agentRank(a.status) - agentRank(b.status) || a.createdAt - b.createdAt,
  );
}

/** Unarchived children of `parentId`, ranked, from every host's rows: the
 *  store holds every connected host's sessions, and a child spawned on
 *  another host carries the parent's bare id as its `parentId`. Each row's
 *  `environmentId` names the host it lives on. */
export function childrenOf(metas: SessionMeta[], parentId: string): SessionMeta[] {
  return sortAgents(metas.filter((m) => m.parentId === parentId && !m.archived));
}

export type FleetCounts = { working: number; watching: number; waiting: number; failed: number; done: number };

export function fleetCounts(agents: { status: SessionStatus }[]): FleetCounts {
  const out: FleetCounts = { working: 0, watching: 0, waiting: 0, failed: 0, done: 0 };
  for (const a of agents) out[countOf(threadStateOf(a.status))]++;
  return out;
}

/** The count a state falls in: working, watching, waiting and failed their own, every other quiet state done. */
function countOf(state: ThreadState): keyof FleetCounts {
  if (state === "working" || state === "watching") return state;
  return state === "waiting" || state === "failed" ? state : "done";
}

/** A count said in the vocabulary's word for its state ("2 needs you"), in
 *  its tone where the tone means something (needs you, failed). */
function countPart(k: keyof FleetCounts, n: number): { text: string; tone?: string } {
  return { text: `${n} ${STATUS_WORD[k].toLowerCase()}`, tone: statusNeedsYou(k) ? statusToneClass(k) : undefined };
}

/** The fleet's counts as one sentence, nonzero parts in order working,
 *  watching, needs you, failed, done; the renderer joins them with ", ". */
export function fleetSentence(c: FleetCounts): { text: string; tone?: string }[] {
  return (["working", "watching", "waiting", "failed", "done"] as const)
    .filter((k) => c[k] > 0)
    .map((k) => countPart(k, c[k]));
}

/** A row's subagents: the count and the live states in the fleet's buckets. */
export type AgentSummary = { total: number; working: number; waiting: number; failed: number };

/** The count and the live states in the fleet's buckets; null with no agents. */
export function agentSummary(agents: readonly { status: SessionStatus }[]): AgentSummary | null {
  if (agents.length === 0) return null;
  const c = fleetCounts([...agents]);
  return { total: agents.length, working: c.working, waiting: c.waiting, failed: c.failed };
}

/** "4 agents", then each nonzero live state in the fleet header's words
 *  and tones: 4 agents · 2 working · 1 needs you. Done ones are in
 *  the count only. */
export function agentSummaryParts(s: AgentSummary): { text: string; tone?: string }[] {
  const parts: { text: string; tone?: string }[] = [{ text: `${s.total} ${s.total === 1 ? "agent" : "agents"}` }];
  for (const k of ["working", "waiting", "failed"] as const) {
    if (s[k] > 0) parts.push(countPart(k, s[k]));
  }
  return parts;
}

/** The catalog name for a server (provider, native model) pair. */
export function modelLabel(provider: string, model: string): string {
  return findModel(pickerModelId(asHarness(provider), model))?.name ?? model;
}

// ── transcript lines ───────────────────────────────────────────────────

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
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

/** A line's tone in the vocabulary's colours: the person is needed, it failed, or neither. */
export const TONE_CLASS: Record<AgentTone, string> = {
  warning: statusToneClass("waiting"),
  danger: statusToneClass("failed"),
  muted: statusToneClass("done"),
};

// ── status ─────────────────────────────────────────────────────────────

/** The prefixes the host writes that the state's word already says:
 *  "Waiting on 3 subagents" under Watching, "Queued · 120 of 120 running"
 *  under Queued (sessions.ts `watchLine`, scheduler.ts). */
const LEADS: Partial<Record<ThreadState, string>> = {
  watching: "Waiting on ",
  queued: "Queued · ",
};

/** The activity with the lead its state's word repeats taken off. */
export function leadStripped(text: string, state: ThreadState): string {
  const lead = LEADS[state];
  const t = text.trim();
  return lead && t.startsWith(lead) ? t.slice(lead.length).trim() : t;
}

/** What a waiting agent asks: its open question's first line, else
 *  "approve <tool>" from the undecided approval. */
function waitingDetail(blocks: Block[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.question) return firstLine(b.question.questions[0]?.question ?? "");
    if (b.approval && !b.approval.decided) {
      const title = b.tool?.title ?? b.tool?.name ?? "";
      return title ? `approve ${firstLine(title)}` : "";
    }
  }
  return "";
}

export type AgentStatus = {
  state: ThreadState;
  /** What the state is about; for a working agent, the host's phrase itself. */
  detail: string;
  /** The detail stands in for the word ("Editing HomeView.swift", not "Working"). */
  phrase: boolean;
};

/**
 * A subagent's status in the vocabulary, from its meta: the host's phrase
 * while it works, the question while it waits, the failure's summary. The
 * transcript is read only for what the meta does not carry (`blocks`, when
 * `loadsTranscript` fetched it). A subagent's idle is done.
 */
export function agentStatus(
  meta: Pick<SessionMeta, "status" | "activity" | "failure">,
  blocks: Block[] = [],
): AgentStatus {
  const state = threadStateOf(meta.status, { settled: true });
  const activity = meta.activity?.trim() ?? "";
  switch (state) {
    case "working":
      return { state, detail: activity || (meta.status === "starting" ? "Starting" : "Thinking"), phrase: true };
    case "watching":
    case "queued":
      // A detail starts lower-case (docs/DESIGN.md); the working phrase leads its row and keeps its capital.
      return { state, detail: lowerFirst(leadStripped(activity, state)) ?? "", phrase: false };
    case "waiting":
      return { state, detail: waitingDetail(blocks), phrase: false };
    case "failed":
      return { state, detail: lowerFirst(meta.failure?.summary.trim() || lastErrorLine(blocks)) ?? "", phrase: false };
    default:
      return { state, detail: "", phrase: false };
  }
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

/** The ranked children of `parentId`: metas only. A row fetches its own
 *  transcript under `loadsTranscript`; the board never loads them all. On
 *  2026-10-17 a parent with 833 settled children pulled every transcript
 *  through the socket on mount. */
export function useAgents(parentId: string): SessionMeta[] {
  const cache = useRef<SessionMeta[]>([]);
  return useSyncExternalStore(sessionStore.onMetaChange.bind(sessionStore), () => {
    const next = childrenOf(sessionStore.metas(), parentId);
    if (!sameList(cache.current, next)) cache.current = next;
    return cache.current;
  });
}

/** Whether a fleet row fetches its transcript: only to quote what a waiting
 *  agent asks, or a failure the meta does not carry. Everything else a row
 *  shows is on the meta (`activity`, `failure`). */
export function loadsTranscript(agent: Pick<SessionMeta, "status" | "failure">): boolean {
  const state = threadStateOf(agent.status);
  return state === "waiting" || (state === "failed" && !agent.failure);
}

/** One session's folded state, loading its transcript on first use. */
export function useSessionById(id: string | null): Session | undefined {
  const session = useSyncExternalStore(sessionStore.subscribe, () =>
    id ? sessionStore.get(id) : undefined,
  );
  const loaded = session?.loaded === true;
  useEffect(() => {
    if (id && !loaded) void sessionStore.ensureLoaded(id, "byId").catch(() => undefined);
  }, [id, loaded]);
  return session;
}

/** One session as the store holds it, loaded or not; never fetches. */
export function useSessionIfLoaded(id: string): Session | undefined {
  return useSyncExternalStore(sessionStore.subscribe, () => sessionStore.get(id));
}

const subscribeMeta = (listener: () => void): (() => void) => sessionStore.onMetaChange(listener);

export function useMetaById(id: string | null): SessionMeta | null {
  return useSyncExternalStore(subscribeMeta, () => (id ? sessionStore.metaOf(id) : null));
}
