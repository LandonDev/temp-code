import type { PresenceSource } from './presence'

/**
 * Whether the person is at this Mac: the screen unlocked and awake
 * (presence.ts) and input inside the last two minutes
 * (`powerMonitor.getSystemIdleTime`, read every 5 s). The renderer names a
 * focused thread to its hosts only while this holds (FocusSignal in
 * lib/tcserver/commands.ts), so a thread on screen silences the phone only
 * while someone is looking at it (remote/notifier.ts `onScreen`).
 */

export const ATTENTION_IDLE_SECONDS = 120
export const ATTENTION_POLL_MS = 5_000

/** The part of Electron's powerMonitor the watcher reads (a fake in tests). */
export interface IdleSource {
  getSystemIdleTime(): number
}

export class AttentionWatcher {
  private present: boolean
  private timer: ReturnType<typeof setInterval> | null = null
  private offPresence: (() => void) | null = null
  private readonly listeners = new Set<(present: boolean) => void>()

  constructor(
    private readonly presence: PresenceSource,
    private readonly idle: IdleSource,
    private readonly pollMs = ATTENTION_POLL_MS
  ) {
    this.present = this.read()
  }

  start(): void {
    if (this.timer) return
    this.offPresence = this.presence.onChange(() => this.check())
    this.timer = setInterval(() => this.check(), this.pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.offPresence?.()
    this.offPresence = null
  }

  isPresent(): boolean {
    return this.present
  }

  onChange(listener: (present: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private read(): boolean {
    const { screen, power } = this.presence.snapshot()
    if (screen === 'locked' || power === 'asleep') return false
    return this.idle.getSystemIdleTime() < ATTENTION_IDLE_SECONDS
  }

  private check(): void {
    const next = this.read()
    if (next === this.present) return
    this.present = next
    for (const l of this.listeners) l(next)
  }
}
