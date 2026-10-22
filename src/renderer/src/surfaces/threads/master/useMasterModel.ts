import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BATCH_STEP_LOG_LINES,
  DEFAULT_BATCH_RULES,
  emptyBatch,
  type BatchBoard,
  type BatchRules,
  type BatchState,
  type BoardDigest,
} from "@server/shared/contract-batch";
import { batchThreadId, remoteArchivePlan, type ArchiveWhich } from "./boardActions";
import { stepsOf } from "./steps";
import { registry } from "../../../lib/connection";
import { useEnvironmentStatuses } from "../../../lib/connection/status";
import * as commands from "../../../lib/tcserver/commands";
import type { EnvironmentStatus } from "../../../lib/connection/types";
import { isLiveStatus, type AgentTone } from "../../../lib/threads/agents";
import { hostTone } from "../../../lib/threadMove";
import { sessionStore, useSessionMeta } from "../../../lib/tcserver/store";
import type { SessionMeta, SessionStatus, ThreadType } from "../../../lib/tcserver/types";
import { usePaneVisible } from "../../../hooks/paneVisibility";

/**
 * The master's batch as one model (CLAUDE.md "Master threads"): one
 * `batch.board` answer from the master's host (its children there, a
 * digest per child, the batch's state), kept live by the `board` and
 * `batch` pushes that host sends only to sockets watching this master.
 * The rows are the children of every host the renderer knows (the session
 * store holds each connected or mirrored host's rows) folded into rows (a
 * plan and the build it started are one row) and grouped by what they
 * need from the person. The list's layout changes only when a row joins,
 * leaves, changes section, plan or host; each row reads its own meta and
 * digest, so one child's activity re-renders that row alone. Nothing here
 * loads a transcript, polls a context or reads notes. Pure helpers carry
 * the rules; the hooks wire them to the store and the master's host.
 */

// ── rows ────────────────────────────────────────────────────────────────

/** One row of the board: the thread it shows and, when a plan started
 *  it, that plan. The row keeps the plan's key and title across the
 *  hand-off, so it stays in place and reads as the same piece of work. */
export type MasterRowModel = {
  key: string;
  /** The thread the row shows: the build once it exists, else the plan. */
  meta: SessionMeta;
  /** The planning thread the build came from, when it is in this batch. */
  plan: SessionMeta | null;
  title: string;
};

/** Unarchived root threads carrying this master's id, on any host, oldest first. */
export function masterChildrenOf(metas: readonly SessionMeta[], masterId: string): SessionMeta[] {
  return metas
    .filter((m) => m.masterId === masterId && !m.parentId && !m.archived)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The children as rows. A build whose `planThreadId` names a thread of
 * the same batch takes that plan's row (its key and title); the plan,
 * archived after the start or not, is never a second row. `metas` finds a
 * plan by id (the whole store, or a lookup into it) so an archived plan
 * still lends its title.
 */
export function foldRows(
  children: readonly SessionMeta[],
  metas: readonly SessionMeta[] | ((id: string) => SessionMeta | null | undefined),
  masterId: string,
): MasterRowModel[] {
  const find = typeof metas === "function" ? metas : lookupOf(metas);
  const planOf = (build: SessionMeta): SessionMeta | null => {
    if (!build.planThreadId) return null;
    const plan = find(build.planThreadId);
    return plan && plan.masterId === masterId && !plan.parentId ? plan : null;
  };
  const taken = new Set<string>();
  const rows: MasterRowModel[] = [];
  for (const child of children) {
    const plan = planOf(child);
    if (plan) taken.add(plan.id);
    rows.push({ key: plan?.id ?? child.id, meta: child, plan, title: plan?.title || child.title });
  }
  return rows
    .filter((r) => !(r.plan === null && taken.has(r.meta.id)))
    .sort((a, b) => (a.plan ?? a.meta).createdAt - (b.plan ?? b.meta).createdAt);
}

function lookupOf(metas: readonly SessionMeta[]): (id: string) => SessionMeta | undefined {
  const byId = new Map(metas.map((m) => [m.id, m]));
  return (id) => byId.get(id);
}

// ── the row's host ──────────────────────────────────────────────────────

/** A row's host when it is not the master's: the name and the dot's tone
 *  the thread header's host chip would show, and whether the host is out
 *  of reach (its rows are the launch mirror's, under the offline tint). */
export type RowHost = { id: string; name: string; tone: string; offline: boolean };

export function rowHost(
  meta: Pick<SessionMeta, "environmentId">,
  master: Pick<SessionMeta, "environmentId">,
  environments: readonly { id: string; name: string }[],
  statusOf: (id: string) => Pick<EnvironmentStatus, "transport" | "fresh"> | undefined,
): RowHost | null {
  if (meta.environmentId === master.environmentId) return null;
  const status = statusOf(meta.environmentId);
  return {
    id: meta.environmentId,
    name: environments.find((e) => e.id === meta.environmentId)?.name ?? meta.environmentId,
    tone: hostTone(status),
    offline: status?.transport !== "open",
  };
}

/** One child as `batch.get` may list it once the host spans hosts: the
 *  thread, its host and its state as the master's host last saw them.
 *  Read by shape (`batchChildrenOf`), so a host without the list, or one
 *  listing more than this, changes nothing. */
export type BatchChild = {
  sessionId: string;
  environmentId: string;
  title?: string;
  status?: SessionStatus;
  threadType?: ThreadType | null;
};

export function batchChildrenOf(state: unknown): BatchChild[] {
  const list = (state as { children?: unknown } | null)?.children;
  if (!Array.isArray(list)) return [];
  const out: BatchChild[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.sessionId !== "string" || typeof c.environmentId !== "string") continue;
    out.push({
      sessionId: c.sessionId,
      environmentId: c.environmentId,
      ...(typeof c.title === "string" ? { title: c.title } : {}),
      ...(typeof c.status === "string" ? { status: c.status as SessionStatus } : {}),
      ...(typeof c.threadType === "string" ? { threadType: c.threadType as ThreadType } : typeof c.type === "string" ? { threadType: c.type as ThreadType } : {}),
    });
  }
  return out;
}

/**
 * The batch's own child list laid over the rows: the master's host is the
 * authority on a child's host and state, the session rows keep the bodies.
 * A row the list names takes its host and status when they differ (a new
 * meta object, so the row re-renders once); a child the store has no row
 * for (its host unknown here) becomes a plain row with what the list says;
 * a row the list does not name stays as it is. Without a list, the rows.
 */
export function mergeBatchChildren(rows: readonly MasterRowModel[], children: readonly BatchChild[], masterId: string): readonly MasterRowModel[] {
  if (children.length === 0) return rows;
  const byId = new Map(children.map((c) => [c.sessionId, c]));
  const seen = new Set<string>();
  let changed = false;
  const out = rows.map((row) => {
    const child = byId.get(row.meta.id);
    if (!child) return row;
    seen.add(child.sessionId);
    const status = child.status ?? row.meta.status;
    if (child.environmentId === row.meta.environmentId && status === row.meta.status) return row;
    changed = true;
    return { ...row, meta: { ...row.meta, environmentId: child.environmentId, status } };
  });
  for (const child of children) {
    if (seen.has(child.sessionId) || rows.some((r) => r.plan?.id === child.sessionId)) continue;
    const meta = {
      id: child.sessionId,
      environmentId: child.environmentId,
      parentId: null,
      masterId,
      archived: false,
      status: child.status ?? "idle",
      title: child.title ?? "",
      threadType: child.threadType ?? null,
      createdAt: Number.MAX_SAFE_INTEGER,
      updatedAt: 0,
    } as unknown as SessionMeta;
    out.push({ key: child.sessionId, meta, plan: null, title: meta.title });
    changed = true;
  }
  return changed ? out : rows;
}

// ── grouping ────────────────────────────────────────────────────────────

export type MasterGroupId = "needsYou" | "running" | "queued" | "done";

export const GROUP_ORDER: readonly MasterGroupId[] = ["needsYou", "running", "queued", "done"];

export const GROUP_LABEL: Record<MasterGroupId, string> = {
  needsYou: "Needs you",
  running: "Running",
  queued: "Queued",
  done: "Done",
};

/** Which section a row sits in. A paused thread holds a live turn the
 *  person can resume, so it sits with the running ones; a queued one
 *  waits for a sibling. */
export function groupOf(status: SessionStatus): MasterGroupId {
  if (status === "waiting" || status === "error") return "needsYou";
  if (isLiveStatus(status) || status === "watching" || status === "paused") return "running";
  if (status === "queued") return "queued";
  return "done";
}

export type MasterGroup = { id: MasterGroupId; label: string; rows: MasterRowModel[] };

/** The rows in their sections, oldest first within one; a section with
 *  nothing in it is not returned (the board never draws an empty one). */
export function groupRows(rows: readonly MasterRowModel[]): MasterGroup[] {
  const by = new Map<MasterGroupId, MasterRowModel[]>();
  for (const row of rows) {
    const g = groupOf(row.meta.status);
    (by.get(g) ?? by.set(g, []).get(g)!).push(row);
  }
  return GROUP_ORDER.filter((id) => by.has(id)).map((id) => ({ id, label: GROUP_LABEL[id], rows: by.get(id)! }));
}

export type MasterCounts = Record<MasterGroupId, number>;

export function masterCounts(rows: readonly { meta: { status: SessionStatus } }[]): MasterCounts {
  const counts: MasterCounts = { needsYou: 0, running: 0, queued: 0, done: 0 };
  for (const r of rows) counts[groupOf(r.meta.status)]++;
  return counts;
}

/** The muted word after a row's title: its type. */
export const TYPE_WORD: Record<string, string> = {
  implementation: "Implementation",
  planning: "Plan",
  "project-plan": "Project plan",
  orchestration: "Orchestration",
  research: "Research",
  chat: "Chat",
};

export function typeWord(child: Pick<SessionMeta, "threadType">): string {
  return (child.threadType && TYPE_WORD[child.threadType]) || "";
}

/** "12:08" for a done row's "Landed 12:08". */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A row's line from its digest (what agentLine read from the transcript
 *  before): the question or the approval while it waits, the failure when
 *  it errored, its last words otherwise. */
export function digestLine(meta: Pick<SessionMeta, "status" | "activity" | "failure">, digest: BoardDigest): { text: string; tone: AgentTone } {
  switch (meta.status) {
    case "waiting":
      if (digest.question) return { text: `has a question — ${digest.question}`, tone: "warning" };
      return { text: meta.activity ? `waiting for approval — ${meta.activity}` : "waiting for approval", tone: "warning" };
    case "error":
      return { text: digest.failure || meta.failure?.summary || "failed", tone: "danger" };
    case "watching":
      return { text: "waiting on background work", tone: "muted" };
    default:
      return { text: digest.last ?? "", tone: "muted" };
  }
}

/** "2 of 10 landed" beside the land step. */
export function mergedLine(batch: Pick<BatchState, "landed" | "pending">): string {
  const total = batch.landed.length + batch.pending.length;
  return `${batch.landed.length} of ${total} landed`;
}

// ── the rules ───────────────────────────────────────────────────────────

export type { BatchRules };

export type Rules = BatchRules;

/** The rules as one plain sentence from the master's step list: "Branches
 *  land as they finish, then Gate, Release and Deploy to the box. Then
 *  you are notified." A list with no merge step says so. */
export function rulesSentence(rules: Rules): string {
  const steps = stepsOf(rules);
  const merges = steps.some((s) => s.kind === "land");
  const landing = !merges
    ? "The branches are left unmerged"
    : rules.land === "all-at-once"
      ? "Branches land together once every thread is done"
      : "Branches land as they finish";
  const after = steps.filter((s) => s.kind !== "land").map((s) => s.name.trim() || s.id);
  const first = after.length === 0 ? `${landing}, nothing runs after.` : `${landing}, then ${listWords(after)}.`;
  const then = rules.then === "archive-children" ? "Then the threads are archived." : "Then you are notified.";
  return `${first} ${then}`;
}

function listWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What blocks the batch's end, as the foot says it: "Blocked: <title> errored". */
export function blockedLine(batch: Pick<BatchState, "blocked">, titleOf: (id: string) => string | undefined): string | null {
  if (!batch.blocked) return null;
  return `Blocked: ${titleOf(batch.blocked.sessionId) || "a thread"} ${batch.blocked.why}`;
}

export async function setBatchRules(environmentId: string, masterId: string, rules: Rules): Promise<void> {
  const link = registry.link(environmentId);
  if (!link) throw new Error("The master's host is not connected");
  await link.request("batch.setRules", { masterId, rules });
}

/** Stop the step the batch is running now (the console's Stop). */
export async function stopBatchStep(environmentId: string, masterId: string, stepId: string): Promise<void> {
  const link = registry.link(environmentId);
  if (!link) throw new Error("The master's host is not connected");
  await link.request("batch.stopStep", { masterId, stepId });
}

/** Archive the batch's done children, or every one (the title bar's
 *  menu): `batch.archive` on the master's host, then each other host's own
 *  `session.batch` for the rows of that host the answer left out
 *  (`remoteArchivePlan`). A host that fails leaves the others to finish;
 *  the first failure is thrown once all have answered. */
export async function archiveBatch(
  master: Pick<SessionMeta, "id" | "environmentId">,
  rows: readonly MasterRowModel[],
  which: ArchiveWhich,
  removeResources: boolean,
): Promise<void> {
  const link = registry.link(master.environmentId);
  if (!link) throw new Error("The master's host is not connected");
  const result = await link.request<{ succeeded?: string[] } | null>("batch.archive", { masterId: master.id, which, removeResources });
  const plan = remoteArchivePlan(rows, master, which, result?.succeeded ?? []);
  const outcomes = await Promise.allSettled(
    plan.map(async ({ environmentId, stop, archive }) => {
      if (stop.length) await commands.sessionBatch(environmentId, "stop", stop);
      await commands.sessionBatch(environmentId, "archive", archive, { cleanup: removeResources });
    }),
  );
  const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
  if (failed) throw failed.reason;
}

/** Existing root threads of the project, on any host, join the batch
 *  ("Add existing thread…"): one `batch.adopt` on the master's host, a
 *  thread of another host named in the cross-host id form. The server's
 *  refusals come back as one error naming each. */
export async function adoptThreads(master: Pick<SessionMeta, "id" | "environmentId">, threads: readonly Pick<SessionMeta, "id" | "environmentId" | "title">[]): Promise<void> {
  const link = registry.link(master.environmentId);
  if (!link) throw new Error("The master's host is not connected");
  const result = await link.request<{ refused?: { sessionId: string; why: string }[] } | null>("batch.adopt", {
    masterId: master.id,
    sessionIds: threads.map((t) => batchThreadId(t, master)),
  });
  const refused = result?.refused ?? [];
  if (refused.length) {
    const titleOf = (id: string) => threads.find((t) => batchThreadId(t, master) === id)?.title || id;
    throw new Error(refused.map((r) => `${titleOf(r.sessionId)}: ${r.why}`).join("\n"));
  }
}

// ── the board's data ────────────────────────────────────────────────────

const NO_DIGEST: BoardDigest = Object.freeze({}) as BoardDigest;
const NO_METAS: SessionMeta[] = [];

/**
 * The digests of one board, by child: the `batch.board` answer's, then the
 * `board` push's for one child. A digest that reads the same keeps its
 * object, so a row subscribed to its own (`useBoardDigest`) re-renders only
 * when its own changed.
 */
export class BoardDigests {
  private readonly map = new Map<string, BoardDigest>();
  private readonly json = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = (id: string): BoardDigest => this.map.get(id) ?? NO_DIGEST;

  /** A whole answer: every digest it names (a child it leaves out keeps what it had). */
  replace(record: Record<string, BoardDigest>): void {
    let changed = false;
    for (const [id, digest] of Object.entries(record)) changed = this.put(id, digest) || changed;
    if (changed) this.emit();
  }

  set(id: string, digest: BoardDigest): void {
    if (this.put(id, digest)) this.emit();
  }

  private put(id: string, digest: BoardDigest): boolean {
    const json = JSON.stringify(digest ?? {});
    if (this.json.get(id) === json) return false;
    this.json.set(id, json);
    this.map.set(id, digest ?? NO_DIGEST);
    return true;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const BoardDigestContext = createContext<BoardDigests | null>(null);

const noSubscribe = (): (() => void) => () => {};

/** One child's digest on the board in context; the same object until its own changes. */
export function useBoardDigest(id: string): BoardDigest {
  const store = useContext(BoardDigestContext);
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, () => (store ? store.get(id) : NO_DIGEST));
}

/** The `batch` push (`{ push: 'batch', state }`, contract.ts), read by
 *  shape so a malformed frame never breaks the view. Its steps' logs are
 *  as the host sent them: the lines since the last push (`{ from, lines }`)
 *  or, from an older host, the whole log; `foldBatchPush` lays them on the
 *  state held. */
export function batchFromPush(push: unknown, masterId: string): BatchState | null {
  if (!push || typeof push !== "object") return null;
  const rec = push as { push?: unknown; state?: unknown };
  if (rec.push !== "batch" || !rec.state || typeof rec.state !== "object") return null;
  const batch = rec.state as Partial<BatchState>;
  if (batch.masterId !== masterId || !Array.isArray(batch.steps)) return null;
  const children = batchChildrenOf(batch);
  return {
    masterId,
    rules: batch.rules && typeof batch.rules === "object" ? { ...DEFAULT_BATCH_RULES, ...batch.rules } : DEFAULT_BATCH_RULES,
    steps: batch.steps,
    landed: Array.isArray(batch.landed) ? batch.landed : [],
    pending: Array.isArray(batch.pending) ? batch.pending : [],
    held: Array.isArray(batch.held) ? batch.held : [],
    blocked: batch.blocked ?? null,
    finishedAt: batch.finishedAt ?? null,
    ...(children.length ? { children } : {}),
  } as BatchState;
}

type LogDelta = { from: number; lines: string[] };

const isDelta = (log: unknown): log is LogDelta =>
  !!log && typeof log === "object" && typeof (log as LogDelta).from === "number" && Array.isArray((log as LogDelta).lines);

/**
 * A push laid on the state held: each step's new lines appended to its log
 * (numbered from the step's start, so an overlap is dropped), the newest
 * BATCH_STEP_LOG_LINES kept. A step that started again begins from its
 * first line. `gap` when a push starts past what is held (a push missed):
 * the caller asks `batch.get` for the whole state.
 */
export function foldBatchPush(prev: BatchState, next: BatchState): { state: BatchState; gap: boolean } {
  let gap = false;
  const steps = next.steps.map((step) => {
    const log: unknown = (step as { log?: unknown }).log;
    if (!isDelta(log)) return step;
    const before = prev.steps.find((s) => s.id === step.id);
    const fresh = !before || before.startedAt !== step.startedAt;
    const held = fresh ? [] : (before.log ?? []);
    const count = fresh ? 0 : (before.logCount ?? held.length);
    if (log.from > count) {
      gap = true;
      return { ...step, log: held, logCount: count };
    }
    const lines = [...held, ...log.lines.slice(count - log.from)];
    return { ...step, log: lines.slice(-BATCH_STEP_LOG_LINES), logCount: Math.max(count, log.from + log.lines.length) };
  });
  return { state: { ...next, steps }, gap };
}

/** How often the board asks again while it is on screen: the host keeps a
 *  socket watching a master for a minute after its `batch.board`
 *  (BOARD_WATCH_MS), and the answer settles anything a push missed. */
export const BOARD_RENEW_MS = 45_000;

export type Board = {
  state: BatchState;
  /** The master's children on its host, as the answer had them: rows for ids the store does not hold yet. */
  children: SessionMeta[];
  digests: BoardDigests;
  /** The first answer is in. */
  loaded: boolean;
};

/**
 * The board from the master's host: `batch.board` on mount, on every new
 * socket and every BOARD_RENEW_MS while the pane shows; then the `board`
 * push (one child's digest) and the `batch` push (the state, logs as
 * deltas). A host without `batch.board` answers `batch.get` alone.
 */
export function useBoard(masterId: string, environmentId: string): Board {
  const digests = useMemo(() => new BoardDigests(), [masterId, environmentId]);
  const [data, setData] = useState<{ state: BatchState; children: SessionMeta[]; loaded: boolean }>(() => ({
    state: emptyBatch(masterId),
    children: NO_METAS,
    loaded: false,
  }));
  const held = useRef(data.state);
  const visible = usePaneVisible();
  useEffect(() => {
    let alive = true;
    const link = registry.link(environmentId);
    if (!link) return;
    // An answer marks the board loaded; a push only moves the state it holds.
    const take = (state: BatchState, children?: SessionMeta[], answer = true) => {
      held.current = state;
      setData((d) => ({ state, children: children ?? d.children, loaded: d.loaded || answer }));
    };
    const readState = () =>
      link
        .request<BatchState>("batch.get", { masterId })
        .then((state) => {
          if (alive && state && Array.isArray(state.steps)) take(state);
        })
        .catch(() => {
          if (alive) setData((d) => (d.loaded ? d : { ...d, loaded: true }));
        });
    const read = () => {
      link.request<BatchBoard>("batch.board", { masterId }).then(
        (answer) => {
          if (!alive || !answer?.state || !Array.isArray(answer.state.steps)) return;
          digests.replace(answer.digests ?? {});
          // The wire's metas name no host: they are the master's host's, as the store stamps a list.
          take(answer.state, Array.isArray(answer.children) ? answer.children.map((m) => ({ ...m, environmentId })) : NO_METAS);
        },
        () => void readState(),
      );
    };
    read();
    const timer = visible ? window.setInterval(read, BOARD_RENEW_MS) : null;
    const offOpen = link.onOpen(read);
    const offPush = link.onPush((push) => {
      if (!alive) return;
      if (push.push === "board") {
        if (push.masterId === masterId) digests.set(push.sessionId, push.digest);
        return;
      }
      // A child gone from its host leaves the answer's rows with it.
      if (push.push === "session-removed") {
        const gone = new Set(push.sessionIds);
        setData((d) => (d.children.some((c) => gone.has(c.id)) ? { ...d, children: d.children.filter((c) => !gone.has(c.id)) } : d));
        return;
      }
      const next = batchFromPush(push, masterId);
      if (!next) return;
      const folded = foldBatchPush(held.current, next);
      take(folded.state, undefined, false);
      if (folded.gap) void readState();
    });
    return () => {
      alive = false;
      if (timer !== null) window.clearInterval(timer);
      offOpen();
      offPush();
    };
  }, [masterId, environmentId, visible, digests]);
  return { ...data, digests };
}

/**
 * The digests of the batch's threads on other hosts: each host in reach
 * that has rows on the board answers `batch.board` for its own threads
 * carrying the master's id (its index by master), and sends their `board`
 * pushes to this socket while it watches. Only the digests are taken; the
 * batch's state is the master's host's.
 */
export function useFarDigests(masterId: string, hostsKey: string, digests: BoardDigests): void {
  const visible = usePaneVisible();
  useEffect(() => {
    if (!hostsKey) return;
    let alive = true;
    const offs: (() => void)[] = [];
    const timers: number[] = [];
    for (const environmentId of hostsKey.split("\n")) {
      const link = registry.link(environmentId);
      if (!link) continue;
      const read = () =>
        link.request<BatchBoard>("batch.board", { masterId }).then(
          (answer) => {
            if (alive && answer?.digests) digests.replace(answer.digests);
          },
          () => undefined,
        );
      void read();
      if (visible) timers.push(window.setInterval(read, BOARD_RENEW_MS));
      offs.push(link.onOpen(read));
      offs.push(
        link.onPush((push) => {
          if (alive && push.push === "board" && push.masterId === masterId) digests.set(push.sessionId, push.digest);
        }),
      );
    }
    return () => {
      alive = false;
      for (const t of timers) window.clearInterval(t);
      for (const off of offs) off();
    };
  }, [masterId, hostsKey, digests, visible]);
}

// ── the layout ──────────────────────────────────────────────────────────

/** One row as the list lays it out: the thread, the plan it came from, its
 *  section and host. `fallback` is the meta for a thread the store does not
 *  hold (from the answer or the batch's list); `override` the batch's own
 *  word on the host and status of one it does (mergeBatchChildren). */
export type BoardRowRef = {
  key: string;
  id: string;
  planId: string | null;
  group: MasterGroupId;
  environmentId: string;
  fallback: SessionMeta | null;
  override: { environmentId: string; status: SessionStatus } | null;
};

export type BoardGroup = { id: MasterGroupId; label: string; rows: BoardRowRef[] };

export type BoardLayout = { rows: BoardRowRef[]; groups: BoardGroup[]; counts: MasterCounts };

const EMPTY_LAYOUT: BoardLayout = { rows: [], groups: [], counts: { needsYou: 0, running: 0, queued: 0, done: 0 } };

const refSig = (r: BoardRowRef): string =>
  [r.key, r.id, r.planId ?? "", r.group, r.environmentId, r.override?.status ?? "", r.fallback ? `${r.fallback.title}\u0001${r.fallback.status}` : ""].join("\u0000");

/**
 * The board's rows from the store's metas, the answer's children it does
 * not hold and the batch's own list, as refs. The list speaks for a child
 * the store does not hold, or holds from a host out of reach (`live`); a
 * child the store follows live keeps its own host and status, which are
 * newer than the list's last answer. `previous` lends every ref whose
 * signature is unchanged, and the whole layout when nothing moved, so the
 * list re-renders only when a row joins, leaves, changes section, plan or
 * host.
 */
export function boardLayout(
  masterId: string,
  metas: readonly SessionMeta[],
  metaOf: (id: string) => SessionMeta | null,
  answer: readonly SessionMeta[],
  listed: readonly BatchChild[],
  previous: BoardLayout = EMPTY_LAYOUT,
  live: (environmentId: string) => boolean = () => false,
): BoardLayout {
  listed = listed.filter((c) => {
    const held = metaOf(c.sessionId);
    return !held || !live(held.environmentId);
  });
  const extra = answer.filter((m) => !metaOf(m.id) && m.masterId === masterId && !m.parentId && !m.archived);
  const children = extra.length ? [...masterChildrenOf(metas, masterId), ...extra].sort((a, b) => a.createdAt - b.createdAt) : masterChildrenOf(metas, masterId);
  const answered = extra.length ? lookupOf(extra) : () => undefined;
  const rows = mergeBatchChildren(foldRows(children, (id) => metaOf(id) ?? answered(id), masterId), listed, masterId);
  const before = new Map(previous.rows.map((r) => [r.key, r]));
  let same = rows.length === previous.rows.length;
  const refs = rows.map((row, i): BoardRowRef => {
    const stored = metaOf(row.meta.id);
    const ref: BoardRowRef = {
      key: row.key,
      id: row.meta.id,
      planId: row.plan?.id ?? null,
      group: groupOf(row.meta.status),
      environmentId: row.meta.environmentId,
      fallback: stored ? null : row.meta,
      override:
        stored && (stored.environmentId !== row.meta.environmentId || stored.status !== row.meta.status)
          ? { environmentId: row.meta.environmentId, status: row.meta.status }
          : null,
    };
    const had = before.get(ref.key);
    const kept = had && refSig(had) === refSig(ref) ? had : ref;
    if (kept !== previous.rows[i]) same = false;
    return kept;
  });
  if (same) return previous;
  const by = new Map<MasterGroupId, BoardRowRef[]>();
  for (const ref of refs) (by.get(ref.group) ?? by.set(ref.group, []).get(ref.group)!).push(ref);
  const groups = GROUP_ORDER.filter((id) => by.has(id)).map((id) => ({ id, label: GROUP_LABEL[id], rows: by.get(id)! }));
  const counts: MasterCounts = { needsYou: 0, running: 0, queued: 0, done: 0 };
  for (const ref of refs) counts[ref.group]++;
  return { rows: refs, groups, counts };
}

const subscribeMetas = (listener: () => void): (() => void) => sessionStore.onMetaChange(listener);
const storeMetaOf = (id: string): SessionMeta | null => sessionStore.metaOf(id);

/** The board's layout, the same object until a row joins, leaves, or changes section, plan or host. */
export function useBoardLayout(
  masterId: string,
  answer: readonly SessionMeta[],
  listed: readonly BatchChild[],
  live: (environmentId: string) => boolean,
): BoardLayout {
  const cache = useRef<BoardLayout>(EMPTY_LAYOUT);
  return useSyncExternalStore(subscribeMetas, () => {
    cache.current = boardLayout(masterId, sessionStore.metas(), storeMetaOf, answer, listed, cache.current, live);
    return cache.current;
  });
}

/** A row's meta as the board shows it: the store's (with the batch's word
 *  on its host and status), else the fallback. The same object while
 *  neither changed. */
export function useRowMeta(ref: Pick<BoardRowRef, "id" | "fallback" | "override">): SessionMeta | null {
  const stored = useSessionMeta(ref.id);
  const { override, fallback } = ref;
  return useMemo(() => (stored ? (override ? { ...stored, ...override } : stored) : fallback), [stored, override, fallback]);
}

/** The rows with their metas as the store holds them now, for the menus,
 *  the dialogs and the archive split (read when one opens, never per frame). */
export function rowModels(layout: BoardLayout): MasterRowModel[] {
  const out: MasterRowModel[] = [];
  for (const ref of layout.rows) {
    const stored = storeMetaOf(ref.id);
    const meta = stored ? (ref.override ? { ...stored, ...ref.override } : stored) : ref.fallback;
    if (!meta) continue;
    const plan = ref.planId ? storeMetaOf(ref.planId) : null;
    out.push({ key: ref.key, meta, plan, title: plan?.title || meta.title });
  }
  return out;
}

// ── the model ───────────────────────────────────────────────────────────

export type MasterModel = {
  layout: BoardLayout;
  batch: BatchState;
  digests: BoardDigests;
  /** The first `batch.board` answer is in. */
  loaded: boolean;
  landed: ReadonlySet<string>;
  /** The child open in the board's place, if any. */
  openId: string | null;
  setOpenId: (id: string | null) => void;
};

export function useMasterModel(master: Pick<SessionMeta, "id" | "environmentId">): MasterModel {
  const board = useBoard(master.id, master.environmentId);
  const listed = useMemo(() => batchChildrenOf(board.state), [board.state]);
  const statuses = useEnvironmentStatuses();
  const live = useCallback((environmentId: string) => statuses.get(environmentId)?.transport === "open", [statuses]);
  const layout = useBoardLayout(master.id, board.children, listed, live);
  // The other hosts in reach with rows on the board, as one stable key.
  const farHosts = useMemo(
    () => [...new Set(layout.rows.map((r) => r.environmentId))].filter((id) => id !== master.environmentId && live(id)).sort().join("\n"),
    [layout, master.environmentId, live],
  );
  useFarDigests(master.id, farHosts, board.digests);
  const landed = useMemo(() => new Set(board.state.landed), [board.state.landed]);
  const [openId, setOpenId] = useState<string | null>(null);
  // A child that left the batch (archived, removed) closes its view.
  useEffect(() => {
    if (openId && !layout.rows.some((r) => r.id === openId)) setOpenId(null);
  }, [layout, openId]);
  return { layout, batch: board.state, digests: board.digests, loaded: board.loaded, landed, openId, setOpenId };
}
