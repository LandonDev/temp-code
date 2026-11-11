/**
 * What covers a Mac's screen, read the one way every check reads it
 * (docs/computer-protocol.md §20.7): presence (src/main/presence.ts), the
 * proofs' screen check (scripts/lib/macScreen.ts), the probe's `screen`
 * and the computer service's session tier all classify through here.
 *
 * The session dictionary's `CGSSessionScreenIsLocked` is true while the
 * screen saver or the lock screen is up, whether or not a password is
 * needed to get back: on 2026-11-11 it read true for hours on a Mac whose
 * `sysadminctl -screenLock status` said "screenLock is off". So the flag
 * alone is not a lock. Three states:
 *   - `unlocked`: nothing covers the screen;
 *   - `saver`: the screen saver is up and leaving it needs no password
 *     (screenLock off, or its delay not yet run out): declaring user
 *     activity (`caffeinate -u`) puts the desktop back;
 *   - `locked`: a password is needed (an explicit Lock Screen, the saver
 *     past the delay, another user on the console, or anything unread).
 * The display's sleep is the other axis (`asleep`), read beside it.
 */

export type ScreenCover = 'unlocked' | 'saver' | 'locked'

/** What the Mac says, raw: the session dictionary, the saver's process and the main display. */
export interface ScreenFacts {
  /** `CGSSessionScreenIsLocked` */
  sessionLocked: boolean
  /** `kCGSSessionOnConsoleKey`: false while another user has the console */
  onConsole: boolean
  /** a ScreenSaverEngine (or legacyScreenSaver) process runs */
  saverRunning: boolean
}

/** `sysadminctl -screenLock status`: how soon the saver asks for the password. */
export type LockPolicy = { kind: 'off' } | { kind: 'immediate' } | { kind: 'delay'; seconds: number } | { kind: 'unknown' }

/** Pure: sysadminctl's words (it logs them on stderr, after a timestamp) → the policy; anything else is unknown. */
export function parseLockPolicy(text: string): LockPolicy {
  if (/screenLock is off/i.test(text)) return { kind: 'off' }
  if (/screenLock delay is immediate/i.test(text)) return { kind: 'immediate' }
  const delay = /screenLock delay is (\d+) seconds?/i.exec(text)
  if (delay) return { kind: 'delay', seconds: Number(delay[1]) }
  return { kind: 'unknown' }
}

/**
 * Pure: the facts and the policy → the cover. `saverUpMs` is how long the
 * saver has been up when known (presence times it from its own notice);
 * under a delay with no age known it reads locked. Unknown reads locked:
 * keys typed at a lock screen would reach the password field.
 */
export function classifyScreen(facts: ScreenFacts, policy: LockPolicy, saverUpMs: number | null = null): ScreenCover {
  if (!facts.onConsole) return 'locked'
  if (!facts.sessionLocked) return 'unlocked'
  if (!facts.saverRunning) return 'locked'
  if (policy.kind === 'off') return 'saver'
  if (policy.kind === 'delay' && saverUpMs !== null && saverUpMs < policy.seconds * 1000) return 'saver'
  return 'locked'
}

/** The saver's process names on macOS 14 and later. */
export const SAVER_PROCESSES: readonly string[] = ['ScreenSaverEngine', 'legacyScreenSaver']

/** How long a dismiss waits for the session to read uncovered. */
export const DISMISS_WAIT_MS = 3_000
/** How often it reads in that wait. */
export const DISMISS_POLL_MS = 200
