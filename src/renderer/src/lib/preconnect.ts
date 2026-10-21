import type { SessionStatus } from "@shared/events";
import * as serverCommands from "./tcserver/commands";

/** How often one thread asks its host to pre-connect; the host holds each account to one a minute anyway. */
export const ASK_EVERY_MS = 30_000;

/** A thread with no turn in flight: the next send pays a handshake unless a socket is open. */
export function idleForPreconnect(status: SessionStatus | string | null | undefined): boolean {
  return status !== "running" && status !== "starting" && status !== "waiting";
}

const lastAsk = new Map<string, number>();

/** Ask once per thread per half minute; never throws, never awaited. Returns whether it asked. */
export function askPreconnect(sessionId: string, now = Date.now()): boolean {
  const last = lastAsk.get(sessionId);
  if (last !== undefined && now - last < ASK_EVERY_MS) return false;
  lastAsk.set(sessionId, now);
  void serverCommands.preconnect(sessionId).catch(() => undefined);
  return true;
}

/** Tests. */
export const resetPreconnectAsks = (): void => lastAsk.clear();
