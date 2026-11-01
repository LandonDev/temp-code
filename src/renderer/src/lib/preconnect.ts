import type { SessionStatus } from "@shared/events";
import { nativeModelId } from "./models";
import type { Session } from "./session";
import * as serverCommands from "./tcserver/commands";
import { sessionStore } from "./tcserver/store";

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

/** Once per key per half minute: whether this ask goes out. */
function due(key: string, now: number): boolean {
  const last = lastAsk.get(key);
  if (last !== undefined && now - last < ASK_EVERY_MS) return false;
  lastAsk.set(key, now);
  return true;
}

/**
 * The person's own gesture in a composer (a pointer down in it, its first
 * keystroke), never a programmatic focus: a turn is about to be written. An
 * idle thread asks its host to boot its harness if it is down (the host
 * holds the bounds: once per thread per 30 s, under the cap, nothing
 * queued); an unsent draft asks for the socket a fresh thread of its
 * project and model would ride. Its own throttle key, so a tab's
 * socket-only ask never swallows the boot. Never throws. Returns whether it asked.
 */
export function askOnGesture(
  session: Pick<Session, "id" | "environmentId" | "status" | "harness" | "model" | "projectId">,
  now = Date.now(),
): boolean {
  if (sessionStore.isDraft(session.id)) {
    if (!session.projectId) return false;
    const draft = { provider: session.harness, model: nativeModelId(session.model), projectId: session.projectId };
    if (!due(`draft:${session.environmentId}:${draft.projectId}:${draft.provider}:${draft.model}`, now)) return false;
    void serverCommands.preconnectDraft(session.environmentId, draft).catch(() => undefined);
    return true;
  }
  if (!idleForPreconnect(session.status)) return false;
  if (!due(`boot:${session.id}`, now)) return false;
  void serverCommands.preconnect(session.id, { boot: true }).catch(() => undefined);
  return true;
}

/** Tests. */
export const resetPreconnectAsks = (): void => lastAsk.clear();
