import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { emptyBatch, type BatchState } from "@server/shared/contract-batch";
import { registry } from "../../../lib/connection";
import { isLiveStatus } from "../../../lib/threads/agents";
import { sessionStore } from "../../../lib/tcserver/store";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import { usePaneVisible } from "../../../hooks/paneVisibility";
import { useNow } from "../bits";

/**
 * The master's batch as one model (CLAUDE.md "Master threads"): its
 * children grouped by what they need from the person, the counts
 * sentence in the title bar, and the batch's own state from `batch.get`.
 * Pure helpers carry the rules; the hooks wire them to the session store
 * and the master's host.
 */

// ── grouping ────────────────────────────────────────────────────────────

export type MasterGroupId = "needsYou" | "running" | "queued" | "done";

export const GROUP_ORDER: readonly MasterGroupId[] = ["needsYou", "running", "queued", "done"];

export const GROUP_LABEL: Record<MasterGroupId, string> = {
  needsYou: "Needs you",
  running: "Running",
  queued: "Queued",
  done: "Done",
};

/** Which section a child sits in. A paused thread holds a live turn the
 *  person can resume, so it sits with the running ones. */
export function groupOf(status: SessionStatus): MasterGroupId {
  if (status === "waiting" || status === "error") return "needsYou";
  if (isLiveStatus(status) || status === "watching" || status === "paused") return "running";
  if (status === "queued") return "queued";
  return "done";
}

export type MasterGroup = { id: MasterGroupId; label: string; rows: SessionMeta[] };

/** The children in their sections, oldest first within one; a section
 *  with nothing in it is not returned (the board never draws an empty one). */
export function groupChildren(children: readonly SessionMeta[]): MasterGroup[] {
  const by = new Map<MasterGroupId, SessionMeta[]>();
  for (const child of children) {
    const g = groupOf(child.status);
    (by.get(g) ?? by.set(g, []).get(g)!).push(child);
  }
  return GROUP_ORDER.filter((id) => by.has(id)).map((id) => ({
    id,
    label: GROUP_LABEL[id],
    rows: [...by.get(id)!].sort((a, b) => a.createdAt - b.createdAt),
  }));
}

export type MasterCounts = Record<MasterGroupId, number>;

export function masterCounts(children: readonly { status: SessionStatus }[]): MasterCounts {
  const counts: MasterCounts = { needsYou: 0, running: 0, queued: 0, done: 0 };
  for (const c of children) counts[groupOf(c.status)]++;
  return counts;
}

/** The title bar's one sentence: "4 running · 1 needs you · 3 queued ·
 *  2 done", only the non-zero parts; empty with no children. */
export function countsSentence(counts: MasterCounts): string {
  const parts: string[] = [];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.needsYou) parts.push(`${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you`);
  if (counts.queued) parts.push(`${counts.queued} queued`);
  if (counts.done) parts.push(`${counts.done} done`);
  return parts.join(" · ");
}

/** The Queued label's hint: a row waiting on the host's cap (no sibling
 *  named in `after`) starts when a slot frees; rows waiting only on a
 *  sibling say so on their own line. */
export function queuedHint(rows: readonly Pick<SessionMeta, "status" | "after">[]): string | null {
  return rows.some((r) => r.status === "queued" && !r.after) ? "starts as a slot frees" : null;
}

/** The child's two muted words after its title: its type, and the host
 *  when it runs somewhere other than the master. */
export const TYPE_WORD: Record<string, string> = {
  implementation: "impl",
  planning: "plan",
  "project-plan": "project plan",
  orchestration: "orchestration",
  research: "research",
  chat: "chat",
};

export function typeWord(child: Pick<SessionMeta, "threadType">): string {
  return (child.threadType && TYPE_WORD[child.threadType]) || "";
}

/** The branch a child works on, read off its worktree: the last folder of
 *  a cwd that is not the master's. */
export function branchOf(child: Pick<SessionMeta, "cwd">, masterCwd: string): string | null {
  const cwd = child.cwd.replace(/\/+$/, "");
  if (!cwd || cwd === masterCwd.replace(/\/+$/, "")) return null;
  return cwd.split("/").filter(Boolean).pop() ?? null;
}

/** "12:08" for the stats line's "landed 12:08". */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "2 of 10 merged" under the list. */
export function mergedLine(batch: Pick<BatchState, "landed" | "pending">): string {
  const total = batch.landed.length + batch.pending.length;
  return `${batch.landed.length} of ${total} merged`;
}

// ── children ────────────────────────────────────────────────────────────

/** Unarchived root threads carrying this master's id, oldest first. */
export function masterChildrenOf(metas: readonly SessionMeta[], masterId: string): SessionMeta[] {
  return metas
    .filter((m) => m.masterId === masterId && !m.parentId && !m.archived)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function sameList(a: readonly SessionMeta[], b: readonly SessionMeta[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
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

// ── the batch ───────────────────────────────────────────────────────────

export const BATCH_POLL_MS = 5_000;

/** The `batch` push (`{ push: 'batch', state }`, contract.ts; every step
 *  change on the master's host), read by shape so a host on an older build
 *  that sends nothing, or a different envelope, never breaks the view. */
export function batchFromPush(push: unknown, masterId: string): BatchState | null {
  if (!push || typeof push !== "object") return null;
  const rec = push as { push?: unknown; state?: unknown; batch?: unknown };
  if (rec.push !== "batch") return null;
  const batch = (rec.state ?? rec.batch ?? rec) as Partial<BatchState>;
  if (batch.masterId !== masterId || !Array.isArray(batch.steps)) return null;
  return {
    masterId,
    steps: batch.steps,
    landed: Array.isArray(batch.landed) ? batch.landed : [],
    pending: Array.isArray(batch.pending) ? batch.pending : [],
  };
}

/**
 * The batch's state from the master's host: read on mount, taken from the
 * `batch` push on every step change, and re-read every BATCH_POLL_MS while
 * the view is on screen as a floor for a host on a build without the push
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
  children: SessionMeta[];
  groups: MasterGroup[];
  counts: MasterCounts;
  sentence: string;
  batch: BatchState;
  landed: ReadonlySet<string>;
  /** The row unfolded in place, if any. */
  openId: string | null;
  setOpenId: (id: string | null) => void;
  now: number;
};

export function useMasterModel(master: Pick<SessionMeta, "id" | "environmentId">): MasterModel {
  const children = useMasterChildren(master.id);
  const groups = useMemo(() => groupChildren(children), [children]);
  const counts = useMemo(() => masterCounts(children), [children]);
  const batch = useBatchState(master.id, master.environmentId);
  const landed = useMemo(() => new Set(batch.landed), [batch.landed]);
  const [openId, setOpenId] = useState<string | null>(null);
  const now = useNow(counts.running > 0);
  // A row that left (archived, removed) folds its detail.
  useEffect(() => {
    if (openId && !children.some((c) => c.id === openId)) setOpenId(null);
  }, [children, openId]);
  return { children, groups, counts, sentence: countsSentence(counts), batch, landed, openId, setOpenId, now };
}
