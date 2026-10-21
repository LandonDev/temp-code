import { useSyncExternalStore } from "react";
import type { Capability } from "@server/shared/capabilities";
import type { SessionMoveResult } from "@server/shared/contract-session-move";
import { LOCAL_ENVIRONMENT_ID, registry } from "./connection";
import type { Environment, EnvironmentStatus } from "./connection/types";
import { sessionStore } from "./tcserver/store";

/**
 * Moving a thread between hosts from the desktop (docs/box.md "Moving a
 * thread between hosts"). The desktop's own server runs every move: it holds
 * the admin peer links, so `session.move` always goes to `local`, naming the
 * hosts by the ids their hellos report. While a move runs the thread's chip
 * shows it; the result lands as a notice the toasts read.
 */

export type MoveTarget = { environmentId: string; name: string; ok: true } | { environmentId: string; name: string; ok: false; reason: string };

/** What the menu needs to know about the thread. */
export type MovableThread = {
  id: string;
  environmentId: string;
  parentId?: string | null;
  status?: string;
  busy?: boolean;
  treeHasLiveWork?: boolean;
  treeHasPaused?: boolean;
  /** Unsent: a draft the server has not created. */
  draft?: boolean;
  queued?: number;
};

const AT_REST = new Set(["idle", "error", "done"]);

/** Whether the thread itself can move now; the reason when not. */
export function threadBlocker(t: MovableThread): string | null {
  if (t.draft) return "send a first message before moving it";
  if (t.parentId) return "a subagent moves with its thread";
  if (t.status === "paused" || t.treeHasPaused) return "the thread is paused; stop it first";
  if (t.busy || t.treeHasLiveWork || (t.status && !AT_REST.has(t.status))) return "the thread is working; stop it or wait for it to finish";
  if (t.queued) return "the thread has queued messages";
  return null;
}

/**
 * Where a thread could go, each with why not when it cannot: a move runs
 * between this machine and one saved host (never host to host), needs the
 * desktop's server and the other host connected, and an admin key there.
 */
export function moveTargets(
  t: MovableThread,
  environments: readonly Environment[],
  statusOf: (id: string) => Pick<EnvironmentStatus, "transport" | "lastHello">,
  moving: boolean,
): MoveTarget[] {
  if (!environments.some((e) => e.id === LOCAL_ENVIRONMENT_ID)) return [];
  const candidates = t.environmentId === LOCAL_ENVIRONMENT_ID ? environments.filter((e) => e.id !== LOCAL_ENVIRONMENT_ID) : environments.filter((e) => e.id === LOCAL_ENVIRONMENT_ID);
  const remote = t.environmentId === LOCAL_ENVIRONMENT_ID ? null : environments.find((e) => e.id === t.environmentId);
  const local = statusOf(LOCAL_ENVIRONMENT_ID);
  const blocker = moving ? "a move is already running" : threadBlocker(t);
  return candidates.map((e) => {
    const peer = e.id === LOCAL_ENVIRONMENT_ID ? remote : e;
    const peerStatus = peer ? statusOf(peer.id) : null;
    const caps: Capability[] = peerStatus?.lastHello?.caps ?? [];
    const why =
      blocker ??
      (local.transport !== "open" || !local.lastHello
        ? "this Mac's server is not connected"
        : !peer || !peerStatus || peerStatus.transport !== "open"
          ? `${peer?.name ?? "the other host"} is not connected`
          : !caps.includes("admin")
            ? `the key for ${peer.name} is not an admin key`
            : null);
    return why ? { environmentId: e.id, name: e.name, ok: false, reason: why } : { environmentId: e.id, name: e.name, ok: true };
  });
}

/** The status dot's tone for one environment's link. */
export function hostTone(status: Pick<EnvironmentStatus, "transport" | "fresh"> | undefined): string {
  if (!status) return "bg-content/25";
  if (status.transport === "open") return status.fresh ? "bg-success" : "bg-success/50";
  if (status.transport === "unauthorized") return "bg-danger";
  if (status.transport === "offline") return "bg-content/25";
  return "bg-warning";
}

// ── the running moves and their notices ────────────────────────────────

export type MoveNotice = {
  key: number;
  sessionId: string;
  title: string;
  fromName: string;
  toName: string;
  result: SessionMoveResult | null;
  error: string | null;
};

type State = { moving: ReadonlyMap<string, string>; notices: readonly MoveNotice[] };
let state: State = { moving: new Map(), notices: [] };
const listeners = new Set<() => void>();
let nextKey = 1;

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Session id → the environment it is moving to, while a move runs. */
export function useMoving(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => state.moving);
}

export function useMoveNotices(): readonly MoveNotice[] {
  return useSyncExternalStore(subscribe, () => state.notices);
}

export function dismissMoveNotice(key: number): void {
  set({ notices: state.notices.filter((n) => n.key !== key) });
}

const nameOf = (id: string): string => registry.environment(id)?.name ?? id;

/** The lines a finished move's notice carries under its heading. */
export function moveNoticeLines(n: Pick<MoveNotice, "result" | "fromName" | "toName" | "error">): string[] {
  if (n.error) return [n.error];
  const r = n.result;
  if (!r) return [];
  const lines: string[] = [];
  if (r.dirty.length) {
    const shown = r.dirty.slice(0, 5).join(", ");
    const more = r.dirty.length - 5 + r.dirtyMore;
    lines.push(`Uncommitted changes stayed on ${n.fromName}: ${shown}${more > 0 ? ` and ${more} more` : ""}. Commit and push them to carry them over.`);
  }
  if (r.checkpointsStayed) lines.push(`Undo history stayed on ${n.fromName}.`);
  if (r.transcript === "missing") lines.push(`The harness transcript was not on ${n.fromName}; the next message replays the dialogue as context.`);
  if (r.pendingRelease) lines.push(`${n.toName} finishes taking the thread when it next answers.`);
  return lines;
}

/** Move a thread to `to` (an environment of this window) through the desktop's server. */
export async function moveThread(sessionId: string, to: string): Promise<SessionMoveResult> {
  const from = sessionStore.environmentOf(sessionId);
  if (!from) throw new Error(`unknown session: ${sessionId}`);
  const title = sessionStore.metaOf(sessionId)?.title ?? sessionStore.get(sessionId)?.title ?? "thread";
  const notice = { sessionId, title, fromName: nameOf(from), toName: nameOf(to) };
  const moving = new Map(state.moving);
  moving.set(sessionId, to);
  set({ moving });
  try {
    const result = await registry.linkOf(LOCAL_ENVIRONMENT_ID).request<SessionMoveResult>("session.move", {
      sessionId,
      from: sessionStore.hostIdOf(from),
      to: sessionStore.hostIdOf(to),
    });
    set({ notices: [...state.notices, { key: nextKey++, ...notice, result, error: null }] });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    set({ notices: [...state.notices, { key: nextKey++, ...notice, result: null, error: message }] });
    throw err;
  } finally {
    const done = new Map(state.moving);
    done.delete(sessionId);
    set({ moving: done });
  }
}

/** Test seam. */
export function resetMoves(): void {
  state = { moving: new Map(), notices: [] };
}
