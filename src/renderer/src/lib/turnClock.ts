import { useSyncExternalStore } from "react";
import type { Block, Session } from "./session";

/**
 * One clock for every timer in a thread. The server stamps `busySince`
 * when work starts and freezes the active span on pause; the renderer only
 * reads. The second hand is a single shared interval that subscribed rows
 * pick up through `useClock` — a row that is not live never subscribes
 * and never re-renders on the tick.
 */

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  now = Date.now();
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!timer) {
    now = Date.now();
    timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const idle = (): (() => void) => () => {};
const zero = (): number => 0;
const current = (): number => now;

/** Epoch ms, refreshed each second while `active`; a still 0 otherwise. */
export function useClock(active: boolean): number {
  return useSyncExternalStore<number>(active ? subscribe : idle, active ? current : zero, zero);
}

export const clockForTest = {
  listeners: (): number => listeners.size,
  subscribe,
  tick,
};

/** The slice of a Session the clock reads; `treeFrozenActiveElapsed` is the server's tree-wide fold (M4). */
export type ClockSession = Pick<Session, "status" | "busy" | "busySince" | "frozenActiveElapsed" | "blocks"> & {
  treeFrozenActiveElapsed?: number | null;
};

export function isTurnPaused(session: ClockSession): boolean {
  return session.status === "paused";
}

/** Work is in flight (starting, running or waiting on the user). */
export function isTurnActive(session: ClockSession): boolean {
  const status = session.status ?? (session.busy ? "running" : "idle");
  if (status === "paused") return false;
  return status === "running" || status === "starting" || status === "waiting" || !!session.busy;
}

/** When the current stretch of work began: the server's stamp, else the last user turn. */
export function turnStartOf(session: ClockSession): number | undefined {
  if (session.busySince) return session.busySince;
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const b = session.blocks[i];
    if (b.role === "user") return b.ts ?? b.startedAt;
  }
  return undefined;
}

/**
 * Elapsed working time for the live turn: the frozen span while paused
 * (tree-wide when the server folds one), the running span while active,
 * null once the turn has settled and its own duration takes over.
 */
export function turnElapsed(session: ClockSession, at: number): number | null {
  if (isTurnPaused(session)) {
    return Math.max(0, session.treeFrozenActiveElapsed ?? session.frozenActiveElapsed ?? 0);
  }
  if (!isTurnActive(session)) return null;
  const start = turnStartOf(session);
  return Math.max(0, at - (start ?? at));
}

/** A settled turn's length. A steered turn closes its earlier sections by doneTs alone. */
export function turnDurationOf(userBlock: Block | undefined): number | undefined {
  if (!userBlock) return undefined;
  if (userBlock.durationMs != null) return userBlock.durationMs;
  if (userBlock.doneTs != null && userBlock.startedAt != null) {
    return Math.max(0, userBlock.doneTs - userBlock.startedAt);
  }
  return undefined;
}

/** The actions of a completed-turn pass row ("Pass: review, commit"), else null. */
export function passActionsOf(block: Block): string[] | null {
  if (block.role !== "system") return null;
  const m = /^Pass:\s*(.*)$/s.exec(block.text);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
