/**
 * The small, testable rules that keep the language-server pool out of a
 * spawn loop: an errored entry stays errored for a while, and an engine
 * build that says it has expired is done for the whole session, not just
 * this one project. lsp.ts owns the processes; this owns the decisions.
 */

/** Two crashes inside this window stop the retries; an errored entry also holds this long. */
export const CRASH_WINDOW_MS = 30_000

const STDERR_TAIL_BYTES = 8 * 1024

/** The engine's exact words on stderr before it exits, ~400 ms after launch. */
const EXPIRED_RE = /This build of intellij-server has expired[^\n]*/

/** The last few KB of a child's stderr: enough to read an exit message. */
export class StderrTail {
  private text = ''
  push(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-STDERR_TAIL_BYTES)
  }
  read(): string {
    return this.text
  }
}

/** The expiry line when the engine printed one, else null. */
export function expiredBuildMessage(stderr: string): string | null {
  return EXPIRED_RE.exec(stderr)?.[0].trim() ?? null
}

/** An errored entry answers with its error until the window passes; only then does an ensure respawn. */
export function erroredEntryHolds(erroredAt: number | undefined, now: number): boolean {
  return erroredAt !== undefined && now - erroredAt < CRASH_WINDOW_MS
}
