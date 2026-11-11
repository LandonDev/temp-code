import type { ServerFrame, ServerPush } from '@shared/contract'
import type { KeepAwakeStatusWire } from '@shared/contract-power'

/**
 * Keep the Mac's display awake while threads work (docs/box.md "Keep awake").
 *
 * A Mac holds one display-sleep assertion (Electron's powerSaveBlocker
 * `prevent-display-sleep`, IOKit's PreventUserIdleDisplaySleep: what
 * `caffeinate -d` holds) whenever a thread is live here (starting, running,
 * waiting, watching: a master watching its batch and a running batch step
 * read as watching) or a linked host says it has live work. With it held
 * the display never dims and the screen saver never starts, so nothing reads
 * the session as covered while the person is away.
 *
 * Every host computes its own `live` (live threads now, or within
 * RELEASE_GRACE_MS of the last one settling). A host with peers on its own
 * listener (the box) pushes `live-work` down every registered link on a
 * change and every LIVE_WORK_HEARTBEAT_MS; the Mac counts a peer's word for
 * PEER_LIVE_TTL_MS after it heard it, so a link that drops releases the
 * hold within that. The setting `power.keepAwake` (`while-working`, the
 * default, or `never`) and the power source gate it: on battery nothing is
 * held. A headless host never holds (it has no blocker), it only tells.
 */

export const KEEP_AWAKE_SETTING = 'power.keepAwake'
export type KeepAwakeMode = 'while-working' | 'never'
export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ['while-working', 'never']
export const LIVE_WORK_PUSH = 'live-work'

/** How long the hold outlives the last live thread: a thread between turns does not drop it. */
export const RELEASE_GRACE_MS = 30_000
/** A host with live work says so this often, change or not. */
export const LIVE_WORK_HEARTBEAT_MS = 60_000
/** A peer's word holds this long after it was heard: two missed heartbeats and a half. */
export const PEER_LIVE_TTL_MS = 150_000
/** How often the host re-reads its live threads. */
export const KEEP_AWAKE_TICK_MS = 15_000

export function keepAwakeMode(raw: string | null): KeepAwakeMode {
  return raw === 'never' ? 'never' : 'while-working'
}

export interface LocalWork {
  /** threads in a live status on this host now */
  live: number
  /** when the last one was seen live, null before any */
  lastLiveAt: number | null
}

export interface PeerWork {
  live: boolean
  /** when this host heard it (its own clock) */
  heardAt: number
}

/** This host's own word: live threads now, or one settled within the grace. */
export function localLive(local: LocalWork, now: number): boolean {
  return local.live > 0 || (local.lastLiveAt !== null && now - local.lastLiveAt < RELEASE_GRACE_MS)
}

/** The one rule: hold while this host or a peer has live work, the setting allows it and the Mac is on AC power. */
export function shouldHoldAwake(
  local: LocalWork,
  peers: readonly PeerWork[],
  setting: { mode: KeepAwakeMode; onBattery: boolean },
  now: number
): boolean {
  if (setting.mode === 'never' || setting.onBattery) return false
  if (localLive(local, now)) return true
  return peers.some((p) => p.live && now - p.heardAt < PEER_LIVE_TTL_MS)
}

/** The seam over Electron's powerSaveBlocker (a fake in tests). */
export interface AwakeBlocker {
  start(): number
  stop(id: number): void
}

/** The seam over Electron's powerMonitor: whether the Mac runs on battery, and when that changes. */
export interface PowerSourceLike {
  onBattery(): boolean
  onChange(listener: () => void): void
}

/** What Settings → Hosts shows on This Mac's row; `supported` is false on a host with no display to keep awake. */
export type KeepAwakeStatus = KeepAwakeStatusWire

/** The setting as this host's children see it: the proofs may wake a dark display only under `while-working` (scripts/lib/macScreen.ts). */
export const KEEP_AWAKE_ENV = 'TEMP_CODE_KEEP_AWAKE'

export interface KeepAwakeDeps {
  environmentId: string
  /** threads in a live status here (SessionRegistry.runningCount) */
  liveCount: () => number
  getSetting: (key: string) => string | null
  setSetting: (key: string, value: string | null) => void
  /** absent on a headless host: it never holds, it only tells its peers */
  blocker?: AwakeBlocker
  power?: PowerSourceLike
  /** one frame down every registered peer's socket (PeerCalls.notify) */
  notify?: (frame: ServerFrame) => void
  /** where the mode goes for this host's children (process.env[KEEP_AWAKE_ENV]); absent in tests */
  env?: (mode: KeepAwakeMode) => void
  now?: () => number
  log?: (line: string) => void
}

export class KeepAwake {
  private readonly now: () => number
  private readonly local: LocalWork = { live: 0, lastLiveAt: null }
  private readonly peers = new Map<string, PeerWork>()
  private holdId: number | null = null
  private told: boolean | null = null
  private toldAt = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: KeepAwakeDeps) {
    this.now = deps.now ?? Date.now
    deps.power?.onChange(() => this.check())
  }

  start(): void {
    if (this.timer) return
    this.check()
    this.timer = setInterval(() => this.check(), KEEP_AWAKE_TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.release()
  }

  mode(): KeepAwakeMode {
    return keepAwakeMode(this.deps.getSetting(KEEP_AWAKE_SETTING))
  }

  status(): KeepAwakeStatus {
    return { mode: this.mode(), supported: !!this.deps.blocker, holding: this.holdId !== null, onBattery: this.onBattery() }
  }

  setMode(mode: KeepAwakeMode): KeepAwakeStatus {
    this.deps.setSetting(KEEP_AWAKE_SETTING, mode === 'while-working' ? null : mode)
    this.check()
    return this.status()
  }

  /** A push on a link this host holds: a peer's word on its live work. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push !== LIVE_WORK_PUSH) return false
    this.peers.set(from, { live: push.live === true, heardAt: this.now() })
    this.check()
    return true
  }

  /** A peer registered: it hears this host's word now, not at the next heartbeat. */
  peerUp(): void {
    this.told = null
    this.check()
  }

  /** A peer's link went down: its word goes with it. */
  peerDown(from: string): void {
    if (this.peers.delete(from)) this.check()
  }

  /** Re-read the live threads, tell the peers, and take or drop the hold. */
  check(): void {
    const now = this.now()
    this.local.live = this.deps.liveCount()
    if (this.local.live > 0) this.local.lastLiveAt = now
    this.tell(localLive(this.local, now), now)
    if (!this.deps.blocker) return
    const mode = this.mode()
    this.deps.env?.(mode)
    const peers = [...this.peers.values()]
    if (shouldHoldAwake(this.local, peers, { mode, onBattery: this.onBattery() }, now)) this.hold()
    else this.release()
  }

  private onBattery(): boolean {
    return this.deps.power?.onBattery() ?? false
  }

  private tell(live: boolean, now: number): void {
    if (!this.deps.notify) return
    if (live === this.told && now - this.toldAt < LIVE_WORK_HEARTBEAT_MS) return
    this.told = live
    this.toldAt = now
    this.deps.notify({ push: LIVE_WORK_PUSH, from: this.deps.environmentId, live })
  }

  private hold(): void {
    if (this.holdId !== null || !this.deps.blocker) return
    try {
      this.holdId = this.deps.blocker.start()
      this.deps.log?.('[keep-awake] holding the display awake')
    } catch (err) {
      this.deps.log?.(`[keep-awake] could not hold: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private release(): void {
    if (this.holdId === null || !this.deps.blocker) return
    this.deps.blocker.stop(this.holdId)
    this.holdId = null
    this.deps.log?.('[keep-awake] released')
  }
}
