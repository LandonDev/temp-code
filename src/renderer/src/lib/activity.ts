import { killBackground } from "./tcserver/commands";

/**
 * A thread's background work as the right panel's Activity section and the
 * watching strip read it: the meta's `background` (CLAUDE.md "Background
 * work and watching") joined with the thread's dev servers and Mac calls.
 */

/** Stop everything a watching thread waits on (session.killBackground). */
export function stopAll(sessionId: string): Promise<void> {
  return killBackground(sessionId);
}
