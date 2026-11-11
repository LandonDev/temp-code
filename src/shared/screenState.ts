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
 * alone is not a lock. On macOS 27 the idle saver is the lock screen with
 * the Aerial wallpaper (loginwindow raises it after its idle time; no
 * ScreenSaverEngine process runs), and it posts com.apple.screenIsLocked and
 * com.apple.screenIsUnlocked like any lock. Three states:
 *   - `unlocked`: nothing covers the screen;
 *   - `saver`: the cover rose on its own after idle (the person idle at
 *     least IDLE_LAUNCH_MIN_S when it rose, where ⌃⌘Q or Lock Screen come
 *     with fresh input) and the policy asks no password yet (screenLock off,
 *     or its delay not run out): declaring user activity (`caffeinate -u`)
 *     puts the desktop back, and a dismiss that does not take is a lock;
 *   - `locked`: a password is needed: an explicit lock (always), the saver
 *     past the delay, another user on the console, or anything unread.
 * The display's sleep is the other axis (`asleep`), read beside it.
 */

export type ScreenCover = 'unlocked' | 'saver' | 'locked'

/** What the Mac says, raw: the session dictionary, and how the cover rose. */
export interface ScreenFacts {
  /** `CGSSessionScreenIsLocked` */
  sessionLocked: boolean
  /** `kCGSSessionOnConsoleKey`: false while another user has the console */
  onConsole: boolean
  /** the cover rose with the person idle (IDLE_LAUNCH_MIN_S or more at that moment, or now when the moment is unknown) */
  idleLaunched: boolean
  /**
   * `CGSSessionScreenLockedTime`, Unix seconds: the cover's start plus the lock
   * delay, from when a password is needed (screenLock off stores a delay of
   * 2147483647 s, the year 2094); null when the dictionary has none
   */
  passwordAt?: number | null
}

/** An explicit lock comes with the person's own input; the idle saver only after this much quiet (its own minimum is a minute). */
export const IDLE_LAUNCH_MIN_S = 60

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
 * Pure: the facts and the policy → the cover. The session's own
 * `passwordAt` decides when it is there (measured on macOS 27.2, 2026-11-11);
 * else the idle rule and the policy: `saverUpMs` is how long the saver has
 * been up when known (presence times it from its own notice), and under a
 * delay with no age known it reads locked. Unknown reads locked: keys typed
 * at a lock screen would reach the password field.
 */
export function classifyScreen(facts: ScreenFacts, policy: LockPolicy, saverUpMs: number | null = null, nowMs: number = Date.now()): ScreenCover {
  if (!facts.onConsole) return 'locked'
  if (!facts.sessionLocked) return 'unlocked'
  if (facts.passwordAt != null) return nowMs < facts.passwordAt * 1000 ? 'saver' : 'locked'
  if (!facts.idleLaunched) return 'locked'
  if (policy.kind === 'off') return 'saver'
  if (policy.kind === 'delay' && saverUpMs !== null && saverUpMs < policy.seconds * 1000) return 'saver'
  return 'locked'
}

/** How long a dismiss waits for the session to read uncovered. */
export const DISMISS_WAIT_MS = 3_000
/** How often it reads in that wait. */
export const DISMISS_POLL_MS = 200
