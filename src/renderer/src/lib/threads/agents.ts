import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { contextPercent } from "../contextUsage";
import { STATUS_WORD, statusNeedsYou, statusToneClass, threadStateOf, type ThreadState } from "../../components/ui/status";
import { findModel } from "../models";
import { markDrawing, type MarkId } from "../../chrome/HarnessIcon";
import { HARNESS_TITLE, type Block, type Session } from "../session";
import { asHarness, pickerModelId, sessionStore } from "../tcserver/store";
import { tallyOf } from "../tcserver/todos";
import type { SessionMeta, SessionStatus } from "../tcserver/types";
import { detailText, legacyDetail, plainStatus } from "@shared/statusWords";
import { GROUP_LABEL, GROUP_ORDER, groupOf, type MasterGroupId } from "../threadGroups";

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

// ── the tree and its sections ─────────────────────────────────────────

/** How deep a descendant is drawn: deeper ones sit at this depth. */
export const MAX_AGENT_DEPTH = 3;

export type AgentTreeRow = { meta: SessionMeta; depth: number };

/** A top-level agent and its unarchived descendants in pre-order. */
export type AgentTreeNode = { meta: SessionMeta; descendants: AgentTreeRow[] };

function needsYou(meta: Pick<SessionMeta, "status">): boolean {
  const state = threadStateOf(meta.status);
  return state === "waiting" || state === "failed";
}

/**
 * The agents under `rootId`: its direct unarchived children, each with
 * its unarchived descendants in pre-order and their depth (1 for a
 * grandchild, drawn at most `MAX_AGENT_DEPTH`). Siblings sort as the rows
 * do (`agentRank`, then oldest first); a top agent whose subtree holds a
 * waiting or failed agent sorts ahead of its peers, so it leads its
 * section. One pass over the metas, so a meta change costs a linear walk.
 */
export function agentTree(metas: readonly SessionMeta[], rootId: string): AgentTreeNode[] {
  const kids = new Map<string, SessionMeta[]>();
  for (const m of metas) {
    if (m.archived || !m.parentId) continue;
    (kids.get(m.parentId) ?? kids.set(m.parentId, []).get(m.parentId)!).push(m);
  }
  const seen = new Set<string>([rootId]);
  const walk = (id: string, depth: number, out: AgentTreeRow[]): void => {
    for (const child of sortAgents(kids.get(id) ?? [])) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ meta: child, depth: Math.min(depth, MAX_AGENT_DEPTH) });
      walk(child.id, depth + 1, out);
    }
  };
  const tops = sortAgents(kids.get(rootId) ?? []).filter((m) => !seen.has(m.id));
  for (const m of tops) seen.add(m.id);
  const nodes = tops.map((meta) => {
    const descendants: AgentTreeRow[] = [];
    walk(meta.id, 1, descendants);
    return { meta, descendants };
  });
  const lifted = (n: AgentTreeNode) => (n.descendants.some((d) => needsYou(d.meta)) ? 0 : 1);
  // Stable: a lifted top moves ahead, the rest keep the row order.
  return nodes.map((n, i) => ({ n, i })).sort((a, b) => lifted(a.n) - lifted(b.n) || a.i - b.i).map((x) => x.n);
}

export type AgentSection = { id: MasterGroupId; label: string; nodes: AgentTreeNode[] };

/** The tree in the board's sections (Needs you, Working, Queued, Done), by
 *  each top agent's own state; its descendants travel with it. A section
 *  with nothing in it is not returned. */
export function agentSections(tree: readonly AgentTreeNode[]): AgentSection[] {
  const by = new Map<MasterGroupId, AgentTreeNode[]>();
  for (const node of tree) {
    const g = groupOf(node.meta);
    (by.get(g) ?? by.set(g, []).get(g)!).push(node);
  }
  return GROUP_ORDER.filter((id) => by.has(id)).map((id) => ({ id, label: GROUP_LABEL[id], nodes: by.get(id)! }));
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

/** The catalog name for a server (provider, native model) pair; the model
 *  as written when the catalog lacks it, and "" when a meta names no model
 *  or no provider (a board stand-in for a child its host has not described). */
export function modelLabel(provider: string | null | undefined, model: string | null | undefined): string {
  if (!provider || !model) return "";
  return findModel(pickerModelId(asHarness(provider), model))?.name ?? model;
}

/** The maker of a (provider, native model) pair when it is not the
 *  harness's own (catalog `vendor`); null otherwise or when unknown. */
export function modelVendor(provider: string | null | undefined, model: string | null | undefined): "meta" | null {
  if (!provider || !model) return null;
  return findModel(pickerModelId(asHarness(provider), model))?.vendor ?? null;
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

/** The leads an old host's legacy activity carries that the state's word
 *  already says: "Waiting on 3 subagents" under Watching, "Queued  120 of
 *  120 running" under Queued (statusWords.ts `legacyDetail`, which reads the
 *  old dot too). A current host sends the detail alone (`statusDetail`). */
const LEADS: Partial<Record<ThreadState, string>> = {
  watching: "Waiting on",
  queued: "Queued",
};

/** What a row's state is about: the host's `statusDetail` as written, else
 *  an old host's legacy activity with the lead its word repeats taken off. */
export function leadStripped(text: string, state: ThreadState, statusDetail?: string | null): string {
  const host = detailText(statusDetail);
  if (host) return host;
  const lead = LEADS[state];
  return (lead && legacyDetail(text, lead)) || detailText(text) || "";
}

/** What a waiting agent asks: its open question's first line, else
 *  "Approve <tool>" from the undecided approval. */
function waitingDetail(blocks: Block[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.question) return firstLine(b.question.questions[0]?.question ?? "");
    if (b.approval && !b.approval.decided) {
      const title = b.tool?.title ?? b.tool?.name ?? "";
      return title ? `Approve ${firstLine(title)}` : "";
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
  meta: Pick<SessionMeta, "status" | "activity" | "statusDetail" | "failure">,
  blocks: Block[] = [],
): AgentStatus {
  const state = threadStateOf(meta.status, { settled: true });
  const activity = meta.activity?.trim() ?? "";
  switch (state) {
    case "working":
      return {
        state,
        detail: detailText(meta.statusDetail) || activity || (meta.status === "starting" ? "Starting" : "Thinking"),
        phrase: true,
      };
    case "watching":
    case "queued":
      return { state, detail: leadStripped(activity, state, meta.statusDetail), phrase: false };
    case "waiting":
      return { state, detail: waitingDetail(blocks), phrase: false };
    case "failed":
      return { state, detail: detailText(meta.failure?.summary || lastErrorLine(blocks)) ?? "", phrase: false };
    default:
      return { state, detail: "", phrase: false };
  }
}

// ── time ───────────────────────────────────────────────────────────────

export type AgentTime = {
  /** How long, in ms (at least a second). */
  ms: number;
  /** It ticks on the second hand (working, waiting, watching). */
  live: boolean;
  /** A settled agent's last event, for "Finished 2:02 PM". */
  finishedAt?: number;
};

type TimedMeta = Pick<
  SessionMeta,
  "status" | "busySince" | "frozenActiveElapsed" | "createdAt" | "updatedAt" | "lastEventAt" | "background"
>;

/**
 * How long a row says its agent has gone: a working or waiting agent since
 * its turn began, a watching one since it began to watch, ticking on `now`;
 * a paused one its frozen time; a settled one (done, idle, stopped,
 * failed) how long it ran, spawn to last event, still. A queued agent, a
 * missing stamp or a span under a second says nothing (null).
 */
export function agentTime(meta: TimedMeta, now: number): AgentTime | null {
  const state = threadStateOf(meta.status, { settled: true });
  const span = (ms: number | null | undefined, live: boolean, finishedAt?: number): AgentTime | null =>
    ms == null || !Number.isFinite(ms) || ms < 1000 ? null : { ms, live, ...(finishedAt ? { finishedAt } : {}) };
  switch (state) {
    case "working":
    case "waiting":
      return meta.busySince ? span(now - meta.busySince, true) : null;
    case "watching": {
      const since = meta.background?.watchingSince ?? meta.busySince;
      return since ? span(now - since, true) : null;
    }
    case "paused":
      return span(meta.frozenActiveElapsed, false);
    case "queued":
      return null;
    default: {
      const end = meta.lastEventAt ?? meta.updatedAt;
      return end && meta.createdAt ? span(end - meta.createdAt, false, end) : null;
    }
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

function sameTree(a: AgentTreeNode[], b: AgentTreeNode[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (n, i) =>
        n.meta === b[i].meta &&
        n.descendants.length === b[i].descendants.length &&
        n.descendants.every((d, j) => d.meta === b[i].descendants[j].meta && d.depth === b[i].descendants[j].depth),
    )
  );
}

/** The agent tree under `rootId` (`agentTree`), the same array while no
 *  row's meta or place changed: metas only, as `useAgents`. */
export function useAgentTree(rootId: string): AgentTreeNode[] {
  const cache = useRef<AgentTreeNode[]>([]);
  return useSyncExternalStore(sessionStore.onMetaChange.bind(sessionStore), () => {
    const next = agentTree(sessionStore.metas(), rootId);
    if (!sameTree(cache.current, next)) cache.current = next;
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

// ── the live-agents cue ───────────────────────────────────────────────

/** How many of a thread's subagents are live, by what the cue says of them,
 *  and the providers they run on (each once, in `MARK_ORDER`). */
export type LiveAgents = { working: number; waiting: number; queued: number; providers?: readonly MarkId[] };

/** The order the cue draws provider marks in: fixed, so a mark never moves
 *  because the agent that brought it settled before another. */
const MARK_ORDER: readonly MarkId[] = ["claude", "codex", "muse", "cursor", "meta", "grok", "opencode", "pi", "omp", "fx"];

/** The most marks the cue draws; the rest are "+N". */
export const CUE_MARKS = 4;

/** The live part of a subagent's state: watching counts as working (it
 *  watches its own subagents); paused, failed, stopped, done and idle are
 *  not live. */
function liveKind(status: SessionStatus | undefined): "working" | "waiting" | "queued" | null {
  const state = threadStateOf(status);
  if (state === "working" || state === "watching") return "working";
  if (state === "waiting") return "waiting";
  if (state === "queued") return "queued";
  return null;
}

/** The live agents in `rootId`'s subagent tree, walked by `parentId` at any
 *  depth through the store's parent index. A master's batch threads carry
 *  `masterId`, not `parentId`, so they are not counted: they live on its
 *  board. An archived agent is not counted, but its own children are. */
export function liveAgentCounts(childrenOf: (id: string) => readonly SessionMeta[], rootId: string): LiveAgents {
  const counts = { working: 0, waiting: 0, queued: 0 };
  const marks = new Set<MarkId>();
  const seen = new Set<string>([rootId]);
  const walk = (id: string): void => {
    for (const child of childrenOf(id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const kind = child.archived ? null : liveKind(child.status);
      if (kind) {
        counts[kind]++;
        // Its maker's mark when the harness serves another's model (Meta's rows).
        if (child.provider) marks.add(modelVendor(child.provider, child.model) ?? asHarness(child.provider));
      }
      walk(child.id);
    }
  };
  walk(rootId);
  return { ...counts, providers: MARK_ORDER.filter((m) => marks.has(m)) };
}

/** What the title bar's agents cue says. `still` draws working as the dot
 *  while the thread's own turn spins (one moving mark); `marks` are the
 *  live agents' providers, each drawing once, at most `CUE_MARKS`, and
 *  `more` the drawings past them; `label` is the count's words, "3 agents", or while
 *  one needs you "1 needs you"; `line` is its tooltip and accessible name. */
export type AgentsCue = {
  state: "working" | "waiting" | "queued";
  still: boolean;
  marks: readonly MarkId[];
  more: number;
  label: string;
  line: string;
};

/** The cue for these counts, or null when nothing is live. Waiting leads,
 *  then working, then queued. */
export function agentsCue(counts: LiveAgents, rootRunning: boolean): AgentsCue | null {
  const total = counts.working + counts.waiting + counts.queued;
  if (total === 0) return null;
  const state = counts.waiting ? "waiting" : counts.working ? "working" : "queued";
  const parts = (["waiting", "working", "queued"] as const).filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${STATUS_WORD[k].toLowerCase()}`);
  const providers = counts.providers ?? [];
  // Muse Code draws Meta's symbol: one glyph stands for both, the line names each.
  const drawn = providers.filter((m, i) => providers.findIndex((p) => markDrawing(p) === markDrawing(m)) === i);
  return {
    state,
    still: state === "working" && rootRunning,
    marks: drawn.slice(0, CUE_MARKS),
    more: Math.max(0, drawn.length - CUE_MARKS),
    label: counts.waiting ? `${counts.waiting} ${counts.waiting === 1 ? "needs" : "need"} you` : `${total} ${total === 1 ? "agent" : "agents"}`,
    line: plainStatus("Agents", parts.join(", ") + onProviders(providers)),
  };
}

/** " on Claude Code and Codex": the marks in words, for the tooltip and the
 *  accessible name; nothing when no provider is known. */
function onProviders(marks: readonly MarkId[]): string {
  const names = marks.map((m) => (m === "meta" ? "Meta" : HARNESS_TITLE[m]));
  const last = names.pop();
  return last ? ` on ${names.length ? `${names.join(", ")} and ${last}` : last}` : "";
}

function sameCue(a: AgentsCue | null, b: AgentsCue | null): boolean {
  // The line names every provider, so equal lines mean equal marks.
  return a === b || (!!a && !!b && a.state === b.state && a.still === b.still && a.label === b.label && a.line === b.line);
}

/** The cue for a root thread on screen, read from the store's parent index.
 *  It wakes React only for a meta change in that thread's tree (the store
 *  puts every ancestor of a changed meta in `affected`), and an equal
 *  answer is the same object. Null for no id, an unknown id, or a
 *  subagent (its tab has no panel) unless `agent` says a pane shows it in
 *  place of its tab's thread, where the pane's panel follows it. */
export function useAgentsCue(rootId: string | null, agent = false): AgentsCue | null {
  const cache = useRef<AgentsCue | null>(null);
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionStore.onMetaChange((changes) => {
        if (rootId && changes.affected.has(rootId)) listener();
      }),
    [rootId],
  );
  return useSyncExternalStore(subscribe, () => {
    const root = rootId ? sessionStore.metaOf(rootId) : null;
    const next =
      root && (agent || !root.parentId) ? agentsCue(liveAgentCounts(sessionStore.childrenOf, root.id), threadStateOf(root.status) === "working") : null;
    if (!sameCue(cache.current, next)) cache.current = next;
    return cache.current;
  });
}
