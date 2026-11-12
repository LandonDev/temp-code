import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type {
  ComputerHistoryCall,
  ComputerHistoryReadAnswer,
  ComputerHistoryStep,
  ComputerHistoryStepAnswer,
  ComputerSessionRow,
} from "@server/shared/contract-computer";
import { HISTORY_READ_MAX_KEYS } from "@server/shared/contract-computer";
import { macComputerKey } from "@server/shared/contract-maccomputer";
import type { EnvLink } from "./connection/link";
import { LOCAL_ENVIRONMENT_ID, registry } from "./connection/registry";
import type { ComputerEntry, PreviewContext } from "./computerSessions";

/**
 * A thread's computer history as the right panel's Computer section lists it
 * (docs/computer-protocol.md "What the person sees"): the journal this Mac
 * keeps per thread (the host's computer/history.ts), read over this desktop's
 * own socket with `computer.history.read` and kept by the `computer-history`
 * push. In the index chunk, since whether the section exists is asked before
 * its chunk loads.
 *
 * A key is what this Mac's sessions know a thread by: a Mac thread's own id,
 * a box thread's `macComputerKey(box, thread)`. The store listens before it
 * reads and reads again on every new socket (the host's subscription dies
 * with the old one). A call merges by `(key, n)` only when its revision is
 * newer, and every call that did not change keeps its object, so a push
 * re-renders one row and a read that lands late never undoes a newer push.
 */

export interface KeyHistory {
  /** when the history's first record was written; a new value means it was removed and begun again */
  born: number;
  /** oldest first */
  calls: ComputerHistoryCall[];
  /** older calls than the oldest held exist on the host */
  more: boolean;
  status: "loading" | "ready" | "failed";
}

interface HistoryState {
  byKey: Record<string, KeyHistory>;
}

const store = createStore<HistoryState>(() => ({ byKey: {} }));
export const computerHistoryStore = store;

/** One key of a tree's history, with the thread it belongs to. */
export interface HistoryKey {
  key: string;
  threadId: string;
}

/**
 * The keys a thread's tree keeps its history under on this Mac: each thread's
 * own id for a Mac thread, `macComputerKey(host, thread)` for a thread of
 * another host (a box thread that drove this Mac). None off a Mac's desktop:
 * the journal is read by this Mac's own socket alone.
 */
export function historyKeys(tree: ReadonlySet<string>, threadHost: string, ctx: Pick<PreviewContext, "macDesktop">): HistoryKey[] {
  if (!ctx.macDesktop) return [];
  return [...tree].map((threadId) => ({ threadId, key: threadHost === LOCAL_ENVIRONMENT_ID ? threadId : macComputerKey(threadHost, threadId) }));
}

/** A read names at most 64 keys: a bigger tree is read in parts. */
export function keyChunks(keys: readonly string[], size = HISTORY_READ_MAX_KEYS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}

// ── the merge ────────────────────────────────────────────────────────────

const EMPTY: KeyHistory = { born: 0, calls: [], more: false, status: "ready" };

/** One call into a key's calls, kept in order: taken only when its revision is newer, every other call the object it was. The same array when nothing changed. */
export function mergeCall(calls: ComputerHistoryCall[], call: ComputerHistoryCall): ComputerHistoryCall[] {
  const at = calls.findIndex((c) => c.n >= call.n);
  if (at < 0) return [...calls, call];
  if (calls[at].n !== call.n) return [...calls.slice(0, at), call, ...calls.slice(at)];
  if (calls[at].rev >= call.rev) return calls;
  const next = calls.slice();
  next[at] = call;
  return next;
}

/**
 * A read into what is held. A new `born` replaces everything: the history
 * was removed and begun again, and its numbers started over. Else each call
 * merges by its revision, so a push that landed while the read was out stays. `more` is about the oldest call held: a page of
 * older calls says it; the newest page says it only while nothing older is
 * held already.
 */
export function mergeRead(held: KeyHistory | undefined, read: { born: number; calls: ComputerHistoryCall[]; more: boolean }, older = false): KeyHistory {
  // a born of 0 is a key not read yet (or one just removed): what pushes put there merges with the read
  if (!held || (held.born !== 0 && held.born !== read.born)) return { born: read.born, calls: read.calls, more: read.more, status: "ready" };
  let calls = held.calls;
  for (const call of read.calls) calls = mergeCall(calls, call);
  const heldOlder = read.calls.length > 0 && held.calls.length > 0 && held.calls[0].n < read.calls[0].n;
  return { born: read.born, calls, more: older || !heldOlder ? read.more : held.more, status: "ready" };
}

// ── the store ────────────────────────────────────────────────────────────

/** the keys someone on screen reads, by how many */
const wanted = new Map<string, number>();
let local: EnvLink | null = null;
let started = false;

function setKey(key: string, next: (held: KeyHistory | undefined) => KeyHistory | undefined): void {
  store.setState((s) => {
    const held = s.byKey[key];
    const value = next(held);
    if (value === held) return s;
    const byKey = { ...s.byKey };
    if (value) byKey[key] = value;
    else delete byKey[key];
    return { byKey };
  });
}

async function read(keys: string[]): Promise<void> {
  const link = local;
  if (!link?.connected || !keys.length) return;
  for (const part of keyChunks(keys)) {
    try {
      const answer = await link.request<ComputerHistoryReadAnswer>("computer.history.read", { keys: part });
      for (const session of answer.sessions) if (wanted.has(session.key)) setKey(session.key, (held) => mergeRead(held, session));
    } catch {
      // an older host, or one without computer use: the keys say so, and Retry asks again
      for (const key of part) if (wanted.has(key)) setKey(key, (held) => ({ ...(held ?? EMPTY), status: "failed" }));
    }
  }
}

/** Hear this Mac's `computer-history` push and read the wanted keys again on every new socket; idempotent. */
export function startComputerHistory(): void {
  if (started) return;
  started = true;
  const attach = (link: EnvLink): void => {
    if (link.environmentId !== LOCAL_ENVIRONMENT_ID) return;
    local = link;
    link.onPush((push) => {
      if (push.push !== "computer-history" || !wanted.has(push.key)) return;
      if (push.gone) setKey(push.key, () => ({ ...EMPTY }));
      else if (push.call) {
        const call = push.call;
        setKey(push.key, (held) => {
          const base = held ?? { ...EMPTY, status: "loading" as const };
          const calls = mergeCall(base.calls, call);
          return calls === base.calls ? held : { ...base, calls };
        });
      }
    });
    // a subscription dies with its socket: every key on screen is read, and so heard, again
    link.onOpen(() => void read([...wanted.keys()]));
  };
  registry.onLink((link, event) => {
    if (event === "added") attach(link);
    else if (link === local) local = null;
  });
  const now = registry.link(LOCAL_ENVIRONMENT_ID);
  if (now && !local) attach(now);
}

/** Read these keys and keep them current until the returned function is called; a key nobody reads any more is dropped. */
export function watchHistory(keys: readonly string[]): () => void {
  startComputerHistory();
  const fresh: string[] = [];
  for (const key of keys) {
    const n = wanted.get(key) ?? 0;
    wanted.set(key, n + 1);
    if (n === 0) {
      fresh.push(key);
      setKey(key, (held) => held ?? { ...EMPTY, status: "loading" });
    }
  }
  void read(fresh);
  return () => {
    for (const key of keys) {
      const n = (wanted.get(key) ?? 1) - 1;
      if (n > 0) wanted.set(key, n);
      else {
        wanted.delete(key);
        setKey(key, () => undefined);
      }
    }
  };
}

/** Ask again for the keys whose read failed. */
export function retryHistory(keys: readonly string[]): void {
  const failed = keys.filter((key) => store.getState().byKey[key]?.status === "failed");
  for (const key of failed) setKey(key, (held) => (held ? { ...held, status: "loading" } : held));
  void read(failed);
}

/** The 200 calls under the oldest one held. */
export async function loadOlderHistory(key: string): Promise<void> {
  const held = store.getState().byKey[key];
  const link = local;
  if (!held?.more || !held.calls.length || !link?.connected) return;
  const answer = await link.request<ComputerHistoryReadAnswer>("computer.history.read", { keys: [key], before: held.calls[0].n });
  const page = answer.sessions[0];
  if (page && wanted.has(key)) setKey(key, (now) => mergeRead(now, page, true));
}

/** One call's kept picture and read text, from this Mac. */
export function readHistoryStep(key: string, n: number): Promise<ComputerHistoryStepAnswer> {
  const link = local ?? registry.link(LOCAL_ENVIRONMENT_ID);
  if (!link) return Promise.reject(new Error("This Mac is not connected"));
  return link.request<ComputerHistoryStepAnswer>("computer.history.step", { key, n });
}

/** A call's picture went (the host answered none for one it listed): what is held says so, as the host's next read would. */
export function markPictureGone(key: string, n: number): void {
  setKey(key, (held) => {
    const call = held?.calls.find((c) => c.n === n);
    if (!held || !call || !call.picture || "none" in call.picture) return held;
    return { ...held, calls: held.calls.map((c) => (c === call ? { ...c, picture: { none: "gone" as const } } : c)) };
  });
}

/** Test seam: forget everything. */
export function resetComputerHistory(): void {
  wanted.clear();
  store.setState({ byKey: {} });
}

/** The histories of these keys, live, each the same object while it did not change. */
export function useComputerHistory(keys: readonly HistoryKey[]): Record<string, KeyHistory> {
  const id = keys.map((k) => k.key).join("\n");
  useEffect(() => (id ? watchHistory(id.split("\n")) : undefined), [id]);
  const byKey = useStore(store, (s) => s.byKey);
  return useMemo(() => {
    const out: Record<string, KeyHistory> = {};
    for (const key of id ? id.split("\n") : []) if (byKey[key]) out[key] = byKey[key];
    return out;
  }, [byKey, id]);
}

/** Whether any of these keys holds a call: the section exists for a thread that used the computer, live or not. */
export function hasHistory(histories: Record<string, KeyHistory>): boolean {
  return Object.values(histories).some((h) => h.calls.length > 0);
}

// ── the list ─────────────────────────────────────────────────────────────

/** One thread's part of the section: its key, what the journal holds for it, and its live row when its session is live. */
export interface HistorySession {
  key: string;
  threadId: string;
  /** a subagent's title, when the thread is not the one on screen */
  title?: string;
  calls: readonly ComputerHistoryCall[];
}

/** One row of the list: a step of a call, or the whole call while it runs or when it never finished. */
export interface StepRow {
  id: string;
  key: string;
  call: ComputerHistoryCall;
  /** the step's place in its call */
  index: number;
  step: ComputerHistoryStep;
  /** the row stands for its whole call: a running or unfinished one */
  whole: boolean;
  /** names its app: the step before it (the row below) was in another app, or it is the oldest of its group */
  namesApp: boolean;
}

export interface StepGroup {
  id: string;
  /** the clock time of the turn's first computer call, and a subagent's title; null for the newest group of the thread on screen */
  heading: { at: number; title?: string } | null;
  rows: StepRow[];
}

export interface StepList {
  /** the calls that run now, the newest first: each one line above the list */
  running: StepRow[];
  /** newest first; a group is one turn of one session */
  groups: StepGroup[];
}

const rowId = (key: string, n: number, index: number): string => `${key}:${n}:${index}`;

/**
 * The section's list from the journal's calls: the running call apart, then
 * one row per finished step, newest first, grouped by session and turn. A
 * heading stands only where two groups meet, so the newest group has none
 * unless it is a subagent's, whose title says whose steps they are.
 */
export function rowsOf(sessions: readonly HistorySession[]): StepList {
  const running: StepRow[] = [];
  const groups: (StepGroup & { newest: number })[] = [];
  for (const session of sessions) {
    const byTurn = new Map<number, ComputerHistoryCall[]>();
    for (const call of session.calls) {
      if (call.state === "running") {
        running.push({ id: rowId(session.key, call.n, 0), key: session.key, call, index: 0, step: call.steps[0], whole: true, namesApp: true });
        continue;
      }
      const turn = byTurn.get(call.turn);
      if (turn) turn.push(call);
      else byTurn.set(call.turn, [call]);
    }
    for (const [turn, calls] of byTurn) {
      const sorted = calls.slice().sort((a, b) => a.n - b.n);
      // oldest first, to see where the app changes; then turned round
      const rows: StepRow[] = [];
      let app: string | null = null;
      for (const call of sorted) {
        // a call that never finished is one row: its steps never reported
        const steps = call.state === "unfinished" ? call.steps.slice(0, 1) : call.steps;
        steps.forEach((step, index) => {
          rows.push({ id: rowId(session.key, call.n, index), key: session.key, call, index, step, whole: call.state === "unfinished", namesApp: app === null || call.app !== app });
          app = call.app;
        });
      }
      if (!rows.length) continue;
      groups.push({
        id: `${session.key}:${turn}`,
        heading: { at: sorted[0].at, ...(session.title ? { title: session.title } : {}) },
        rows: rows.reverse(),
        newest: sorted[sorted.length - 1].at,
      });
    }
  }
  running.sort((a, b) => b.call.at - a.call.at);
  groups.sort((a, b) => b.newest - a.newest);
  return {
    running: running.filter((r) => r.step !== undefined),
    groups: groups.map((group, i) => ({ id: group.id, heading: i === 0 && !group.heading?.title ? null : group.heading, rows: group.rows })),
  };
}

/** Every finished row, newest first, as the keys walk them. */
export const flatRows = (list: StepList): StepRow[] => list.groups.flatMap((g) => g.rows);

/** What a live row is doing now, as a state: waiting on the person's card, held in line, working, or between calls. */
export function nowState(row: Pick<ComputerSessionRow, "running" | "asking">): "waiting" | "queued" | "working" | null {
  if (row.asking) return "waiting";
  if (row.running?.held) return "queued";
  return row.running ? "working" : null;
}

/** The key this desktop reads an entry's journal by: the one its preview asks, so a box thread's row on the box's push joins this Mac's journal. */
export const historyKeyOf = (entry: ComputerEntry): string | null => (entry.previewable ? (entry.previewKey ?? null) : null);
