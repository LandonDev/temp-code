import { useSyncExternalStore } from "react";
import type { Block, Session } from "./session";

/**
 * One clock for every timer in a thread. The server stamps `busySince`
 * when work starts and freezes the active span on pause; the renderer only
 * reads. The second hand is a single shared interval that subscribed rows
 * pick up through `useClock` — a row that is not live never subscribes
 * and never re-renders on the tick.
 */

type Clock = {
  subscribe: (l: () => void) => () => void;
  current: () => number;
  tick: () => void;
  listeners: Set<() => void>;
};

/** One interval shared by every subscriber; it starts with the first and stops with the last. */
function makeClock(periodMs: number): Clock {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  const tick = (): void => {
    now = Date.now();
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void): (() => void) => {
    listeners.add(l);
    if (!timer) {
      now = Date.now();
      timer = setInterval(tick, periodMs);
    }
    return () => {
      listeners.delete(l);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  };
  // With no subscriber the hand is stopped; a first read after a long gap
  // refreshes it so a freshly mounted row paints the right value at once.
  // Reads inside one period return the same value, as getSnapshot must.
  const current = (): number => {
    if (!timer && Date.now() - now >= periodMs) now = Date.now();
    return now;
  };
  return { subscribe, current, tick, listeners };
}

const seconds = makeClock(1000);
const halfMinutes = makeClock(30_000);

const idle = (): (() => void) => () => {};
const zero = (): number => 0;

/** Epoch ms, refreshed each second while `active`; a still 0 otherwise. */
export function useClock(active: boolean): number {
  return useSyncExternalStore<number>(
    active ? seconds.subscribe : idle,
    active ? seconds.current : zero,
    zero,
  );
}

/** Epoch ms, refreshed every half minute while `active`, for "3m ago" text; a still 0 otherwise. */
export function useSlowClock(active: boolean): number {
  return useSyncExternalStore<number>(
    active ? halfMinutes.subscribe : idle,
    active ? halfMinutes.current : zero,
    zero,
  );
}

export const clockForTest = {
  listeners: (): number => seconds.listeners.size,
  subscribe: seconds.subscribe,
  tick: seconds.tick,
  current: seconds.current,
  slowListeners: (): number => halfMinutes.listeners.size,
  slowTick: halfMinutes.tick,
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
