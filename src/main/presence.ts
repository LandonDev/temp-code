import { execFile as nodeExecFile } from 'node:child_process'
import type { MacPresence, PowerState, ScreenState } from '@shared/contract-relay'
import { classifyScreen, DISMISS_POLL_MS, DISMISS_WAIT_MS, parseLockPolicy, SAVER_PROCESSES, type LockPolicy, type ScreenCover, type ScreenFacts } from '@shared/screenState'

/**
 * This host's presence for the relay (docs/box.md "The relay"): whether its
 * screen is locked and whether it is awake. A Mac's processes keep running
 * behind a locked screen, so every read and steering call still works; what
 * cannot be answered is anything that needs the screen or its person, and
 * the box refuses those with `unavailable: the Mac is locked`. Sleep stops
 * everything, and the Mac says so itself (`suspend`) before its socket looks
 * dead to the box's pings.
 *
 * A screen saver that needs no password is not a lock (src/shared/screenState.ts):
 * the screen reads `unlocked` with `saver: true`, and anything that needs the
 * screen dismisses it first (`dismissSaver`: `caffeinate -u`, what
 * IOPMAssertionDeclareUserActivity does), never touching a real lock.
 *
 * Sources: Electron's powerMonitor (`lock-screen`, `unlock-screen`,
 * `suspend`, `resume`); on `lock-screen` and at boot the facts behind it
 * (`ioreg -n Root -d1 -a`, the `IOConsoleUsers` entry's
 * `CGSSessionScreenIsLocked`; `pgrep` for the saver's process;
 * `sysadminctl -screenLock status`, kept ten minutes), classified by
 * `classifyScreen`; and the seams: TEMP_CODE_PRESENCE for an isolated
 * instance's start state and the `presence.set` request under
 * TEMP_CODE_E2E_PRESENCE=1.
 */

export interface PresenceSource {
  snapshot(): MacPresence
  onChange(listener: (presence: MacPresence) => void): () => void
  /** Read the screen again from the Mac's own facts (a host with no desktop answers its snapshot). */
  refresh?(): Promise<MacPresence>
  /** A passwordless saver up: declare user activity and wait for the desktop; a real lock is left alone. */
  dismissSaver?(): Promise<MacPresence>
}

/** The part of Electron's powerMonitor the watcher reads (a fake in tests). */
export interface PowerMonitorLike {
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): unknown
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string | Buffer, stderr?: string | Buffer) => void
) => unknown

/** Pure: the IOConsoleUsers entry of `ioreg -n Root -d1 -a` → locked or not; null when the plist has no answer. */
export function parseConsoleUsers(plistXml: string): boolean | null {
  const at = plistXml.indexOf('<key>IOConsoleUsers</key>')
  if (at < 0) return null
  const open = plistXml.indexOf('<array', at)
  if (open < 0) return null
  if (plistXml.startsWith('<array/>', open)) return null
  const close = plistXml.indexOf('</array>', open)
  if (close < 0) return null
  const users = plistXml.slice(open, close)
  if (!users.includes('<dict>')) return null
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(users)
}

/** The facts and policy reader (a fake in tests): null when the session dictionary has no answer. */
export type ScreenReader = () => Promise<{ facts: ScreenFacts; policy: LockPolicy } | null>

/** While the screen reads covered (locked or a saver), the facts are read again this often: a missed unlock notice never leaves it stale. */
export const COVERED_RECHECK_MS = 30_000

/** How long sysadminctl's answer is kept: it changes only in System Settings. */
export const LOCK_POLICY_KEEP_MS = 10 * 60_000

const run = (exec: ExecFile, file: string, args: string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((done) => {
    try {
      exec(file, args, { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        done({ ok: !error, out: String(stdout ?? '') + String(stderr ?? '') })
      })
    } catch {
      done({ ok: false, out: '' })
    }
  })

/** The Mac's reader: ioreg's session dictionary, pgrep for the saver, sysadminctl's policy (kept LOCK_POLICY_KEEP_MS). */
export function macScreenReader(exec: ExecFile = nodeExecFile as unknown as ExecFile, now: () => number = Date.now): ScreenReader {
  let policy: { value: LockPolicy; at: number } | null = null
  return async () => {
    const ioreg = await run(exec, 'ioreg', ['-n', 'Root', '-d1', '-a'])
    const sessionLocked = ioreg.ok ? parseConsoleUsers(ioreg.out) : null
    if (sessionLocked === null) return null
    const saver = await run(exec, '/usr/bin/pgrep', ['-q', `^(${SAVER_PROCESSES.join('|')})$`])
    if (!policy || now() - policy.at > LOCK_POLICY_KEEP_MS) {
      // sysadminctl says it on stderr and exits 0
      const value = parseLockPolicy((await run(exec, '/usr/sbin/sysadminctl', ['-screenLock', 'status'])).out)
      policy = value.kind === 'unknown' ? null : { value, at: now() }
    }
    return { facts: { sessionLocked, onConsole: true, saverRunning: saver.ok }, policy: policy?.value ?? { kind: 'unknown' } }
  }
}

/** TEMP_CODE_PRESENCE=locked|unlocked|asleep|awake (comma-separated pairs allowed: "locked,awake") on an isolated instance (TEMP_CODE_USER_DATA). */
export function presenceFromEnv(env: NodeJS.ProcessEnv): Partial<Pick<MacPresence, 'screen' | 'power'>> {
  const out: Partial<Pick<MacPresence, 'screen' | 'power'>> = {}
  if (!env.TEMP_CODE_USER_DATA) return out
  for (const word of (env.TEMP_CODE_PRESENCE ?? '').split(',').map((w) => w.trim().toLowerCase())) {
    if (word === 'locked' || word === 'unlocked') out.screen = word
    else if (word === 'asleep' || word === 'awake') out.power = word
  }
  return out
}

/** Declares user activity for a second (`caffeinate -u -t 1`): the saver stops, as at a key press. */
export type ActivityDeclarer = () => Promise<void>

export const declareUserActivity = (exec: ExecFile = nodeExecFile as unknown as ExecFile): ActivityDeclarer => async () => {
  await run(exec, '/usr/bin/caffeinate', ['-u', '-t', '1'])
}

export class MacPresenceWatcher implements PresenceSource {
  private screen: ScreenState
  private power: PowerState
  private saver: boolean
  private at: number
  /** when lock-screen last fired: a delayed policy's saver is passwordless until its delay runs out */
  private coveredAt: number | null = null
  private delayTimer: ReturnType<typeof setTimeout> | null = null
  private recheck: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number
  private readonly listeners = new Set<(presence: MacPresence) => void>()
  private reader: ScreenReader | null = null
  private declare: ActivityDeclarer | null = null
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: { initial?: Partial<MacPresence>; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.screen = opts.initial?.screen ?? 'unknown'
    this.power = opts.initial?.power ?? 'awake'
    this.saver = opts.initial?.saver ?? false
    this.at = opts.initial?.at ?? this.now()
  }

  /** The Mac's own facts behind the lock flag, and the way to leave a passwordless saver. */
  useMac(reader: ScreenReader, declare: ActivityDeclarer): void {
    this.reader = reader
    this.declare = declare
  }

  /** Hooks Electron's powerMonitor: lock-screen → locked until the facts say saver; unlock-screen → unlocked; suspend → asleep, resume → awake. */
  attach(monitor: PowerMonitorLike): void {
    monitor.on('lock-screen', () => {
      this.coveredAt = this.now()
      this.set({ screen: 'locked' })
      void this.refresh()
    })
    monitor.on('unlock-screen', () => {
      this.coveredAt = null
      this.set({ screen: 'unlocked', saver: false })
    })
    monitor.on('suspend', () => this.set({ power: 'asleep' }))
    monitor.on('resume', () => this.set({ power: 'awake' }))
  }

  /** Reads the session dictionary once at boot (macOS) through the old ioreg path when no reader is set; a failure leaves `unknown`. */
  readInitialLock(exec: ExecFile = nodeExecFile as unknown as ExecFile): Promise<void> {
    if (this.reader) return this.refresh().then(() => undefined)
    return new Promise((done) => {
      try {
        exec('ioreg', ['-n', 'Root', '-d1', '-a'], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          if (!error) {
            const locked = parseConsoleUsers(String(stdout))
            if (locked !== null) this.set({ screen: locked ? 'locked' : 'unlocked' })
          }
          done()
        })
      } catch {
        done()
      }
    })
  }

  /** The screen read again from the facts; with no reader (or no answer) the snapshot stands. */
  async refresh(): Promise<MacPresence> {
    if (!this.reader) return this.snapshot()
    const read = await this.reader().catch(() => null)
    if (!read) return this.snapshot()
    const upMs = this.coveredAt === null ? null : this.now() - this.coveredAt
    const cover = classifyScreen(read.facts, read.policy, upMs)
    if (cover === 'unlocked') this.coveredAt = null
    this.armDelay(cover, read.policy, upMs)
    return this.set(coverPatch(cover))
  }

  /**
   * A passwordless saver: declare user activity, then read until the desktop
   * is back (DISMISS_WAIT_MS). A real lock or an uncovered screen is left as
   * it is; nothing is typed.
   */
  async dismissSaver(): Promise<MacPresence> {
    let p = await this.refresh()
    if (!p.saver || !this.declare) return p
    await this.declare().catch(() => undefined)
    const deadline = this.now() + DISMISS_WAIT_MS
    for (;;) {
      p = await this.refresh()
      if (!p.saver || this.now() >= deadline) return p
      await this.sleep(DISMISS_POLL_MS)
    }
  }

  /** The seam's write; emits when something changed. */
  set(patch: Partial<Pick<MacPresence, 'screen' | 'power' | 'saver'>>): MacPresence {
    const screen = patch.screen ?? this.screen
    const power = patch.power ?? this.power
    const saver = screen === 'unlocked' ? (patch.saver ?? this.saver) : false
    if (screen !== this.screen || power !== this.power || saver !== this.saver) {
      this.screen = screen
      this.power = power
      this.saver = saver
      this.at = this.now()
      this.armRecheck()
      const snapshot = this.snapshot()
      for (const l of this.listeners) l(snapshot)
    }
    return this.snapshot()
  }

  /** Stops the re-read timers (tests, shutdown). */
  dispose(): void {
    if (this.delayTimer) clearTimeout(this.delayTimer)
    if (this.recheck) clearInterval(this.recheck)
    this.delayTimer = null
    this.recheck = null
  }

  private armRecheck(): void {
    const covered = this.screen === 'locked' || this.saver
    if (covered && this.reader && !this.recheck) {
      this.recheck = setInterval(() => void this.refresh(), COVERED_RECHECK_MS)
      this.recheck.unref?.()
    } else if (!covered && this.recheck) {
      clearInterval(this.recheck)
      this.recheck = null
    }
  }

  snapshot(): MacPresence {
    return this.saver ? { screen: this.screen, power: this.power, at: this.at, saver: true } : { screen: this.screen, power: this.power, at: this.at }
  }

  onChange(listener: (presence: MacPresence) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Under a delay, a passwordless saver turns into a lock when it runs out: read again then. */
  private armDelay(cover: ScreenCover, policy: LockPolicy, upMs: number | null): void {
    if (this.delayTimer) clearTimeout(this.delayTimer)
    this.delayTimer = null
    if (cover !== 'saver' || policy.kind !== 'delay' || upMs === null) return
    this.delayTimer = setTimeout(() => void this.refresh(), Math.max(0, policy.seconds * 1000 - upMs) + 250)
    this.delayTimer.unref?.()
  }
}

/** A cover as presence says it: a passwordless saver is unlocked with the saver up. */
export function coverPatch(cover: ScreenCover): Pick<MacPresence, 'screen'> & { saver: boolean } {
  return cover === 'saver' ? { screen: 'unlocked', saver: true } : { screen: cover, saver: false }
}

/** A host with no desktop (headless, Linux): screen unknown, power awake, never changing on its own. */
export const staticPresence = (p: Partial<MacPresence> = {}): PresenceSource =>
  new MacPresenceWatcher({ initial: { screen: 'unknown', power: 'awake', ...p } })
