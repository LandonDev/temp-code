import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_BATCH_RULES, emptyBatch, type BatchRules, type BatchState } from "@server/shared/contract-batch";
import { registry } from "../../../lib/connection";
import { isLiveStatus } from "../../../lib/threads/agents";
import { sessionStore } from "../../../lib/tcserver/store";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import { usePaneVisible } from "../../../hooks/paneVisibility";
import { useNow } from "../bits";

/**
 * The master's batch as one model (CLAUDE.md "Master threads"): its
 * children folded into rows (a plan and the build it started are one
 * row), grouped by what they need from the person, the batch's own state
 * and rules from `batch.get`, and which child is open in the right pane.
 * Pure helpers carry the rules; the hooks wire them to the session store
 * and the master's host.
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

/** Unarchived root threads carrying this master's id, oldest first. */
export function masterChildrenOf(metas: readonly SessionMeta[], masterId: string): SessionMeta[] {
  return metas
    .filter((m) => m.masterId === masterId && !m.parentId && !m.archived)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The children as rows. A build whose `planThreadId` names a thread of
 * the same batch takes that plan's row (its key and title); the plan,
 * archived after the start or not, is never a second row. `metas` is the
 * whole store so an archived plan still lends its title.
 */
export function foldRows(children: readonly SessionMeta[], metas: readonly SessionMeta[], masterId: string): MasterRowModel[] {
  const planOf = (build: SessionMeta): SessionMeta | null => {
    if (!build.planThreadId) return null;
    const plan = metas.find((m) => m.id === build.planThreadId);
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

/** "2 of 10 landed" beside the land step. */
export function mergedLine(batch: Pick<BatchState, "landed" | "pending">): string {
  const total = batch.landed.length + batch.pending.length;
  return `${batch.landed.length} of ${total} landed`;
}

// ── the rules ───────────────────────────────────────────────────────────

export type { BatchRules };

/** The rules with the publish choice (a Mac release between the release
 *  and the deploy) a host may carry. */
export type Rules = BatchRules & { publish?: boolean };

/** The rules as one plain sentence: "Branches land as they finish, then
 *  one gate on the merged tree, a release and a deploy to the box. Then
 *  you are notified." */
export function rulesSentence(rules: Rules): string {
  const landing = rules.land === "all-at-once" ? "Branches land together once every thread is done" : "Branches land as they finish";
  const after = rules.steps.filter((s) => s.kind !== "land").map((s) => s.name.toLowerCase());
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
export async function stopBatchStep(environmentId: string, masterId: string): Promise<void> {
  const link = registry.link(environmentId);
  if (!link) throw new Error("The master's host is not connected");
  await link.request("batch.stop", { masterId });
}

// ── children ────────────────────────────────────────────────────────────

function sameList(a: readonly SessionMeta[], b: readonly SessionMeta[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

function sameRows(a: readonly MasterRowModel[], b: readonly MasterRowModel[]): boolean {
  return a.length === b.length && a.every((r, i) => r.meta === b[i].meta && r.plan === b[i].plan);
}

/** The master's children: metas only, the same object while unchanged so
 *  the rows never re-enter. */
export function useMasterChildren(masterId: string): SessionMeta[] {
  const cache = useRef<SessionMeta[]>([]);
  return useSyncExternalStore(sessionStore.onMetaChange.bind(sessionStore), () => {
    const next = masterChildrenOf(sessionStore.metas(), masterId);
    if (!sameList(cache.current, next)) cache.current = next;
    return cache.current;
  });
}

/** The children as rows, folded against the whole store (an archived plan
 *  still names its build's row); the same array while nothing changed. */
export function useMasterRows(masterId: string): MasterRowModel[] {
  const cache = useRef<MasterRowModel[]>([]);
  return useSyncExternalStore(sessionStore.onMetaChange.bind(sessionStore), () => {
    const metas = sessionStore.metas();
    const next = foldRows(masterChildrenOf(metas, masterId), metas, masterId);
    if (!sameRows(cache.current, next)) cache.current = next;
    return cache.current;
  });
}

// ── the batch ───────────────────────────────────────────────────────────

export const BATCH_POLL_MS = 5_000;

/** The `batch` push (`{ push: 'batch', state }`, contract.ts; every step
 *  or rule change on the master's host), read by shape so a malformed
 *  frame never breaks the view. */
export function batchFromPush(push: unknown, masterId: string): BatchState | null {
  if (!push || typeof push !== "object") return null;
  const rec = push as { push?: unknown; state?: unknown };
  if (rec.push !== "batch" || !rec.state || typeof rec.state !== "object") return null;
  const batch = rec.state as Partial<BatchState>;
  if (batch.masterId !== masterId || !Array.isArray(batch.steps)) return null;
  return {
    masterId,
    rules: batch.rules && typeof batch.rules === "object" ? { ...DEFAULT_BATCH_RULES, ...batch.rules } : DEFAULT_BATCH_RULES,
    steps: batch.steps,
    landed: Array.isArray(batch.landed) ? batch.landed : [],
    pending: Array.isArray(batch.pending) ? batch.pending : [],
    held: Array.isArray(batch.held) ? batch.held : [],
    blocked: batch.blocked ?? null,
    finishedAt: batch.finishedAt ?? null,
  };
}

/**
 * The batch's state from the master's host: read on mount, taken from the
 * `batch` push on every change, and re-read every BATCH_POLL_MS while the
 * view is on screen as a floor for a host on a build without the push
 * (the handler reads two tables; cheap).
 */
export function useBatchState(masterId: string, environmentId: string): BatchState {
  const [state, setState] = useState<BatchState>(() => emptyBatch(masterId));
  const visible = usePaneVisible();
  useEffect(() => {
    let alive = true;
    const link = registry.link(environmentId);
    if (!link) return;
    const read = () => {
      link
        .request<BatchState>("batch.get", { masterId })
        .then((next) => {
          if (alive && next && Array.isArray(next.steps)) setState(next);
        })
        .catch(() => undefined);
    };
    read();
    const timer = visible ? window.setInterval(read, BATCH_POLL_MS) : null;
    const off = link.onPush((push) => {
      const next = batchFromPush(push, masterId);
      if (next && alive) setState(next);
    });
    return () => {
      alive = false;
      if (timer !== null) window.clearInterval(timer);
      off();
    };
  }, [masterId, environmentId, visible]);
  return state;
}

// ── the model ───────────────────────────────────────────────────────────

export type MasterModel = {
  rows: MasterRowModel[];
  groups: MasterGroup[];
  counts: MasterCounts;
  batch: BatchState;
  landed: ReadonlySet<string>;
  /** The child open in the right pane, if any. */
  openId: string | null;
  setOpenId: (id: string | null) => void;
  now: number;
};

export function useMasterModel(master: Pick<SessionMeta, "id" | "environmentId">): MasterModel {
  const rows = useMasterRows(master.id);
  const groups = useMemo(() => groupRows(rows), [rows]);
  const counts = useMemo(() => masterCounts(rows), [rows]);
  const batch = useBatchState(master.id, master.environmentId);
  const landed = useMemo(() => new Set(batch.landed), [batch.landed]);
  const [openId, setOpenId] = useState<string | null>(null);
  const now = useNow(counts.running > 0);
  // A child that left the batch (archived, removed) closes its pane.
  useEffect(() => {
    if (openId && !rows.some((r) => r.meta.id === openId)) setOpenId(null);
  }, [rows, openId]);
  return { rows, groups, counts, batch, landed, openId, setOpenId, now };
}
