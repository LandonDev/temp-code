import { useSyncExternalStore } from "react";
import type { Capability } from "@server/shared/capabilities";
import type { SessionMovePreview, SessionMoveResult } from "@server/shared/contract-session-move";
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
  /** Unsent: a draft the server has not created (it switches host, no move). */
  draft?: boolean;
  queued?: number;
};

const AT_REST = new Set(["idle", "error", "done"]);

/** Whether the thread itself can move now; the reason when not. */
export function threadBlocker(t: MovableThread): string | null {
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

const files = (n: number): string => `${n} uncommitted file${n === 1 ? "" : "s"}`;

/**
 * What the move confirm says about the branch: `null` while the host is
 * still looking, `"error"` when it could not say.
 */
export function movePreviewLine(p: SessionMovePreview | null | "error"): string {
  if (p === null) return "Checking the branch…";
  if (p === "error") return "Could not read the branch; the move carries it if there is one.";
  if (!p.branch && !p.detached) return p.dirty ? `No branch to carry · ${files(p.dirty)} stay behind` : "No branch to carry";
  const what = p.branch ? `Branch ${p.branch} travels too` : "The checked-out commit travels too";
  return p.dirty ? `${what} · ${files(p.dirty)} will be carried` : what;
}

/** The one fact a finished move's toast carries under its title, when the
 *  person needs it: changes that did not come along. Everything else the
 *  move did is what they asked for, so it goes unsaid. */
export function moveNoticeException(n: Pick<MoveNotice, "result" | "fromName">): string | null {
  const r = n.result;
  if (!r) return null;
  const b = r.branch;
  if (b?.landing.patch === "kept") return `The patch didn't apply; it's at ${b.landing.patchPath}`;
  if (b?.patchSkipped || (!b && r.dirty.length + r.dirtyMore > 0)) return `Uncommitted changes stayed on ${n.fromName}`;
  return null;
}

/** What the confirm says about the thread's branch, asked of the host that holds the thread through the desktop's server. */
export function previewMove(sessionId: string): Promise<SessionMovePreview> {
  const from = sessionStore.environmentOf(sessionId);
  if (!from) throw new Error(`unknown session: ${sessionId}`);
  return registry.linkOf(LOCAL_ENVIRONMENT_ID).request<SessionMovePreview>("session.move.preview", { sessionId, from: sessionStore.hostIdOf(from) });
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
