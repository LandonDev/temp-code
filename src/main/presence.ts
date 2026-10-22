import { execFile as nodeExecFile } from 'node:child_process'
import type { MacPresence, PowerState, ScreenState } from '@shared/contract-relay'

/**
 * This host's presence for the relay (docs/box.md "The relay"): whether its
 * screen is locked and whether it is awake. A Mac's processes keep running
 * behind a locked screen, so every read and steering call still works; what
 * cannot be answered is anything that needs the screen or its person, and
 * the box refuses those with `unavailable: the Mac is locked`. Sleep stops
 * everything, and the Mac says so itself (`suspend`) before its socket looks
 * dead to the box's pings.
 *
 * Sources: Electron's powerMonitor (`lock-screen`, `unlock-screen`,
 * `suspend`, `resume`), the session dictionary once at boot (`ioreg -n Root
 * -d1 -a`, the `IOConsoleUsers` entry's `CGSSessionScreenIsLocked`), and
 * the seams: TEMP_CODE_PRESENCE for an isolated instance's start state and
 * the `presence.set` request under TEMP_CODE_E2E_PRESENCE=1.
 */

export interface PresenceSource {
  snapshot(): MacPresence
  onChange(listener: (presence: MacPresence) => void): () => void
}

/** The part of Electron's powerMonitor the watcher reads (a fake in tests). */
export interface PowerMonitorLike {
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): unknown
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string | Buffer) => void
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

export class MacPresenceWatcher implements PresenceSource {
  private screen: ScreenState
  private power: PowerState
  private at: number
  private readonly now: () => number
  private readonly listeners = new Set<(presence: MacPresence) => void>()

  constructor(opts: { initial?: Partial<MacPresence>; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
    this.screen = opts.initial?.screen ?? 'unknown'
    this.power = opts.initial?.power ?? 'awake'
    this.at = opts.initial?.at ?? this.now()
  }

  /** Hooks Electron's powerMonitor: lock-screen → locked, unlock-screen → unlocked, suspend → asleep, resume → awake. */
  attach(monitor: PowerMonitorLike): void {
    monitor.on('lock-screen', () => this.set({ screen: 'locked' }))
    monitor.on('unlock-screen', () => this.set({ screen: 'unlocked' }))
    monitor.on('suspend', () => this.set({ power: 'asleep' }))
    monitor.on('resume', () => this.set({ power: 'awake' }))
  }

  /** Reads the session dictionary once (macOS): `ioreg -n Root -d1 -a` through execFile, 2 s timeout; a failure leaves `unknown`. */
  readInitialLock(exec: ExecFile = nodeExecFile as unknown as ExecFile): Promise<void> {
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

  /** The seam's write; emits when something changed. */
  set(patch: Partial<Pick<MacPresence, 'screen' | 'power'>>): MacPresence {
    const screen = patch.screen ?? this.screen
    const power = patch.power ?? this.power
    if (screen !== this.screen || power !== this.power) {
      this.screen = screen
      this.power = power
      this.at = this.now()
      const snapshot = this.snapshot()
      for (const l of this.listeners) l(snapshot)
    }
    return this.snapshot()
  }

  snapshot(): MacPresence {
    return { screen: this.screen, power: this.power, at: this.at }
  }

  onChange(listener: (presence: MacPresence) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** A host with no desktop (headless, Linux): screen unknown, power awake, never changing on its own. */
export const staticPresence = (p: Partial<MacPresence> = {}): PresenceSource =>
  new MacPresenceWatcher({ initial: { screen: 'unknown', power: 'awake', ...p } })
