/**
 * Screen admission for unattended proofs (docs/computer-protocol.md "The
 * unattended proof modes"). A screen saver that needs no password is not a
 * lock (src/shared/screenState.ts): `readyMacScreen` dismisses it by
 * declaring user activity (`caffeinate -u`) and reads again; it never
 * touches a real lock and never types, and it wakes a dark display only
 * when the app's keep-awake setting is `while-working` (TEMP_CODE_KEEP_AWAKE,
 * which the app sets for its children).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyScreen, DISMISS_POLL_MS, DISMISS_WAIT_MS, parseLockPolicy, SAVER_PROCESSES, type LockPolicy, type ScreenCover } from '../../src/shared/screenState'

/** `locked`: a password is needed; `saver`: a passwordless screen saver is up (locked false); `asleep`: the main display sleeps. */
export interface MacScreen { locked: boolean; asleep: boolean; saver?: boolean }
export const SCREEN_SKIP_NOTE = 'the Mac is locked or asleep; run it by hand when unlocked'
export const SCREEN_SKIP_LINE = 'skipped: the Mac is locked or asleep'

// Same rule as computer-proof-probe.swift's screen command, without AppKit or its other probes:
// `locked` is the raw cover (the flag, or another user on the console); `session` and `console` let it be classified.
export const SCREEN_SOURCE = String.raw`import CoreGraphics
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
let locked = session["CGSSessionScreenIsLocked"] as? Bool ?? false
let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool ?? true
let asleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0
print("{\"locked\":\(locked || !onConsole),\"asleep\":\(asleep),\"session\":\(locked),\"console\":\(onConsole)}")
`

let keptPolicy: LockPolicy | null = null

/** The Mac's own answer for a covered session: the saver's process (pgrep) and sysadminctl's policy (on stderr, kept per process). */
export function liveCover(session: { sessionLocked: boolean; onConsole: boolean }): ScreenCover {
  try {
    const saverRunning = spawnSync('/usr/bin/pgrep', ['-q', `^(${SAVER_PROCESSES.join('|')})$`], { timeout: 1_000 }).status === 0
    if (!keptPolicy) {
      const r = spawnSync('/usr/sbin/sysadminctl', ['-screenLock', 'status'], { encoding: 'utf8', timeout: 2_000 })
      const policy = parseLockPolicy(`${r.stdout ?? ''}${r.stderr ?? ''}`)
      if (policy.kind !== 'unknown') keptPolicy = policy
    }
    return classifyScreen({ ...session, saverRunning }, keptPolicy ?? { kind: 'unknown' })
  } catch {
    return 'locked'
  }
}

/**
 * Parse the probe's screen reply; missing fields are an unreadable screen. A
 * covered reply that carries the raw `session` and `console` is classified
 * (`coverOf`): a passwordless saver reads `{ locked: false, saver: true }`.
 */
export function parseMacScreen(text: string, coverOf: (session: { sessionLocked: boolean; onConsole: boolean }) => ScreenCover = liveCover): MacScreen | null {
  try {
    const value = JSON.parse(text)
    if (typeof value?.locked !== 'boolean' || typeof value?.asleep !== 'boolean') return null
    if (value.locked && typeof value.session === 'boolean' && typeof value.console === 'boolean') {
      const cover = coverOf({ sessionLocked: value.session, onConsole: value.console })
      if (cover === 'saver') return { locked: false, asleep: value.asleep, saver: true }
      if (cover === 'unlocked') return { locked: false, asleep: value.asleep }
    }
    return { locked: value.locked, asleep: value.asleep }
  } catch {
    return null
  }
}

/** Declares user activity for a second, as a key press would: the saver stops and a dark display wakes. */
export function declareUserActivity(): void {
  execFileSync('/usr/bin/caffeinate', ['-u', '-t', '1'], { timeout: 3_000, stdio: 'ignore' })
}

const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export interface ReadyOptions {
  /** may a dark display be woken: the app's keep-awake setting, else no */
  wake?: boolean
  declare?: () => void
  sleep?: (ms: number) => void
  now?: () => number
}

/**
 * The screen made ready for a proof, then read: a passwordless saver is
 * dismissed (a dark display woken only under `wake`), and the read repeated
 * every DISMISS_POLL_MS until the desktop is back or DISMISS_WAIT_MS pass.
 * A lock, an unreadable screen or a dark display it may not wake comes back
 * as read; nothing is dismissed then.
 */
export function readyMacScreen(read: () => MacScreen | null, opts: ReadyOptions = {}): MacScreen | null {
  const wake = opts.wake ?? process.env.TEMP_CODE_KEEP_AWAKE === 'while-working'
  const now = opts.now ?? Date.now
  let screen = read()
  const act = (s: MacScreen | null): boolean => !!s && !s.locked && (s.saver === true || s.asleep) && (!s.asleep || wake)
  if (!act(screen)) return screen
  try {
    ;(opts.declare ?? declareUserActivity)()
  } catch {
    return screen
  }
  const deadline = now() + DISMISS_WAIT_MS
  for (;;) {
    screen = read()
    if (!screen || screen.locked || (!screen.saver && !screen.asleep) || now() >= deadline) return screen
    ;(opts.sleep ?? sleepSync)(DISMISS_POLL_MS)
  }
}

/** Compile once per source in the gate logs; compile and read share a 1.95 s budget. */
export function readMacScreen(logDir: string): MacScreen | null {
  const deadline = Date.now() + 1950
  const binary = join(logDir, `screen-${createHash('sha256').update(SCREEN_SOURCE).digest('hex').slice(0, 12)}`)
  const source = `${binary}.${process.pid}.swift`
  const built = `${binary}.${process.pid}`
  try {
    mkdirSync(logDir, { recursive: true })
    if (!existsSync(binary)) {
      writeFileSync(source, SCREEN_SOURCE)
      execFileSync('/usr/bin/xcrun', ['swiftc', source, '-o', built], { timeout: 1800, stdio: 'pipe' })
      renameSync(built, binary)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    return parseMacScreen(execFileSync(binary, [], { encoding: 'utf8', timeout: Math.min(400, remaining), stdio: 'pipe' }))
  } catch {
    return null
  } finally {
    rmSync(source, { force: true })
    rmSync(built, { force: true })
  }
}

/** Direct --gate runs check before any build, wait, scratch app, or model starts; a passwordless saver is dismissed first. */
export function gateScreenSkip(
  gate: boolean,
  root: string,
  platform: NodeJS.Platform = process.platform,
  read: () => MacScreen | null = () => {
    const gitDir = execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], { encoding: 'utf8', timeout: 400 }).trim()
    return readMacScreen(join(resolve(root, gitDir), 'temp-code-gate', 'logs'))
  }
): string | null {
  if (!gate || platform !== 'darwin') return null
  try {
    const screen = readyMacScreen(read)
    return screen && !screen.locked && !screen.asleep && !screen.saver ? null : SCREEN_SKIP_LINE
  } catch {
    return SCREEN_SKIP_LINE
  }
}
