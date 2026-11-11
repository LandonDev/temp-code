import type { ComputerServiceState } from '@shared/contract-computer'
import type {
  ComputerMethod,
  ComputerNotification,
  ComputerParams,
  ComputerFeature,
  ComputerResult,
  HostNotification,
  Permissions
} from '@shared/computer/protocol'
import { computerBinaryPath } from './binary'
import { ComputerConnection, ComputerHostError, ComputerStartError, type ComputerConnectionOptions, type ComputerExit } from './connection'

/**
 * The supervisor of this host's one `tc-computer` (docs/computer-protocol.md
 * "The host"): spawned on the first call and never at boot, respawned after
 * a crash with backoff, put down for five minutes after five crashes in two
 * minutes, pinged while a request runs long, and shut down after ten idle
 * minutes with no live session. The shell's contract (exit codes, a new
 * epoch per process, `permissions.get` as the ping) is plan-EvYtk68iFpQT §8.4.
 */

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

export interface ComputerServiceOptions extends Omit<ComputerConnectionOptions, 'bin' | 'onTimeout'> {
  /** binary.ts's `computerUnavailable`; asked again at every spawn */
  unavailable?: () => string | null
  clock?: Clock
  /** the binary; computerBinaryPath() by default */
  bin?: () => string
}

/** The waits before a respawn after the nth crash in a row. */
export const SPAWN_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
export const CRASH_WINDOW_MS = 120_000
export const CRASHES_TO_DOWN = 5
export const DOWN_FOR_MS = 300_000
export const IDLE_SHUTDOWN_MS = 600_000
export const PING_EVERY_MS = 30_000
/** a request in flight this long makes the next tick ping */
export const PING_AFTER_MS = 10_000
export const PING_DEADLINE_MS = 3_000
export const PING_MISSES_TO_KILL = 2

export class ComputerService {
  private readonly clock: Clock
  private conn: ComputerConnection | null = null
  private starting: Promise<ComputerConnection> | null = null
  private status: ComputerServiceState = { state: 'off', restarts: 0, permissions: null }
  private perms: Permissions | null = null
  private crashes: number[] = []
  private nextSpawnAt = 0
  private backoffStep = 0
  private downUntil = 0
  private downReason = ''
  private permanent: string | null = null
  private busy = false
  private closed = false
  private shuttingDown: ComputerConnection | null = null
  private idleTimer: unknown = null
  private pingTimer: unknown = null
  private pingMisses = 0
  private readonly notes = new Set<(n: ComputerNotification) => void>()
  private readonly epochs = new Set<(epoch: string) => void>()
  private readonly states = new Set<(s: ComputerServiceState) => void>()

  constructor(private readonly opts: ComputerServiceOptions) {
    this.clock = opts.clock ?? REAL_CLOCK
  }

  /** Why a call cannot run now (closing, unavailable here, down after crashes), or null. */
  unavailableReason(): string | null {
    if (this.closed) return 'the app is closing'
    if (this.permanent) return this.permanent
    const why = this.opts.unavailable?.() ?? null
    if (why) {
      if (this.status.state !== 'unavailable' || this.status.reason !== why) this.setState({ state: 'unavailable', reason: why })
      return why
    }
    if (this.clock.now() < this.downUntil) return this.downReason
    return null
  }

  /** The live connection, spawning one on first use; throws host error service_unavailable with its one line. */
  async connection(): Promise<ComputerConnection> {
    const why = this.unavailableReason()
    if (why) throw new ComputerHostError('service_unavailable', why)
    this.clearIdle()
    if (this.conn?.alive) return this.conn
    this.starting ??= this.spawnAfterBackoff().finally(() => (this.starting = null))
    return this.starting
  }

  async request<M extends ComputerMethod>(
    method: M,
    params: ComputerParams<M>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<ComputerResult<M>> {
    const conn = await this.connection()
    try {
      return await conn.request(method, params, opts)
    } finally {
      this.armIdle()
    }
  }

  notify(n: HostNotification): void {
    this.conn?.notify(n)
  }

  onNotification(fn: (n: ComputerNotification) => void): () => void {
    this.notes.add(fn)
    return () => this.notes.delete(fn)
  }

  /** A new process came up: its epoch. */
  onEpoch(fn: (epoch: string) => void): () => void {
    this.epochs.add(fn)
    return () => this.epochs.delete(fn)
  }

  state(): ComputerServiceState {
    return { ...this.status, permissions: this.perms }
  }

  onState(fn: (s: ComputerServiceState) => void): () => void {
    this.states.add(fn)
    return () => this.states.delete(fn)
  }

  permissions(): Permissions | null {
    return this.perms
  }

  /** Whether the live service speaks a feature beyond protocol 1 (§25, decision 14); false with no service up. */
  serves(feature: ComputerFeature): boolean {
    return this.conn?.features.has(feature) ?? false
  }

  /** Live sessions count as use: the idle shutdown waits for none. */
  setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    if (busy) this.clearIdle()
    else this.armIdle()
  }

  /** The server closing: shut down, never respawn. */
  async close(): Promise<void> {
    this.closed = true
    this.clearIdle()
    this.clearPing()
    const conn = this.conn
    this.conn = null
    if (conn) {
      this.shuttingDown = conn
      await conn.shutdown()
    }
  }

  private async spawnAfterBackoff(): Promise<ComputerConnection> {
    const wait = this.nextSpawnAt - this.clock.now()
    if (wait > 0) await new Promise<void>((r) => this.clock.setTimeout(r, wait))
    this.setState({ state: 'starting' })
    let conn: ComputerConnection
    try {
      conn = await ComputerConnection.start({
        ...this.opts,
        bin: this.opts.bin?.() ?? computerBinaryPath(this.opts.env),
        onTimeout: () => this.suspect(),
        now: () => this.clock.now()
      })
    } catch (error) {
      const exit = error instanceof ComputerStartError ? error.exit : undefined
      if (exit?.kind === 'bad-command' || exit?.kind === 'old-macos') this.onExit(null, exit)
      else this.noteCrash((error as Error).message)
      throw new ComputerHostError('service_unavailable', this.permanent ?? (error as Error).message)
    }
    if (this.closed) {
      void conn.shutdown()
      throw new ComputerHostError('service_unavailable', 'the app is closing')
    }
    this.conn = conn
    this.perms = conn.init.permissions
    this.pingMisses = 0
    conn.onNotification((n) => {
      if (n.method === 'permissions/changed') {
        this.perms = n.params
        this.emitState()
      }
      for (const fn of this.notes) fn(n)
    })
    void conn.exited.then((exit) => this.onExit(conn, exit))
    this.setState({ state: 'up', pid: conn.pid, epoch: conn.epoch })
    for (const fn of this.epochs) fn(conn.epoch)
    this.armPing()
    this.armIdle()
    return conn
  }

  private onExit(conn: ComputerConnection | null, exit: ComputerExit): void {
    if (conn && this.conn === conn) this.conn = null
    this.clearPing()
    if (conn && this.shuttingDown === conn) this.shuttingDown = null
    if (this.closed) return this.setState({ state: 'off' })
    const last = exit.stderrTail.filter((l) => l.trim()).slice(-1)[0]
    switch (exit.kind) {
      case 'clean':
        return this.setState({ state: 'idle' })
      case 'grant-restart':
        this.status.restarts++
        this.nextSpawnAt = 0
        this.setState({ state: 'idle' })
        if (this.busy) void this.connection().catch((e: Error) => this.log(`respawn after the grant restart failed: ${e.message}`))
        return
      case 'bad-command':
        this.permanent = `tc-computer refused its command line${last ? `: ${last}` : ''}`
        return this.setState({ state: 'unavailable', reason: this.permanent })
      case 'old-macos':
        this.permanent = 'computer use needs macOS 14 or later'
        return this.setState({ state: 'unavailable', reason: this.permanent })
      default:
        this.status.restarts++
        this.log(`tc-computer exited (${exit.kind}${exit.code !== null ? ` ${exit.code}` : ''}${exit.signal ? ` ${exit.signal}` : ''})${last ? `: ${last}` : ''}`)
        this.noteCrash(last ?? `tc-computer ${exit.kind === 'killed' ? 'stopped answering' : 'crashed'}`)
    }
  }

  /** A crash, a failed start or a killed suspect: back off, or go down after five in two minutes. */
  private noteCrash(reason: string): void {
    const now = this.clock.now()
    if (!this.crashes.some((t) => now - t < CRASH_WINDOW_MS)) this.backoffStep = 0
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    if (this.crashes.length >= CRASHES_TO_DOWN) {
      this.crashes = []
      this.backoffStep = 0
      this.downUntil = now + DOWN_FOR_MS
      this.downReason = `tc-computer crashed ${CRASHES_TO_DOWN} times in two minutes: ${reason}`
      this.nextSpawnAt = this.downUntil
      return this.setState({ state: 'down', reason: this.downReason, until: this.downUntil })
    }
    this.nextSpawnAt = now + SPAWN_BACKOFF_MS[Math.min(this.backoffStep, SPAWN_BACKOFF_MS.length - 1)]
    this.backoffStep++
    this.setState({ state: 'idle', reason })
  }

  /** A request timed out: ping at once; two misses kill the process. */
  private suspect(): void {
    void this.ping()
  }

  private async ping(): Promise<void> {
    const conn = this.conn
    if (!conn?.alive) return
    const answered = await Promise.race([
      conn.request('permissions.get', {}, { timeoutMs: PING_DEADLINE_MS }).then(
        () => true,
        () => false
      ),
      new Promise<boolean>((r) => this.clock.setTimeout(() => r(false), PING_DEADLINE_MS))
    ])
    if (answered) {
      this.pingMisses = 0
      return
    }
    this.pingMisses++
    if (this.pingMisses >= PING_MISSES_TO_KILL && this.conn === conn) {
      this.log(`tc-computer missed ${PING_MISSES_TO_KILL} pings: killing it`)
      conn.kill()
    }
  }

  private armPing(): void {
    this.clearPing()
    this.pingTimer = this.clock.setTimeout(() => {
      const conn = this.conn
      if (!conn?.alive) return
      const now = this.clock.now()
      const long = conn.inFlight().some((r) => r.method !== 'permissions.get' && now - r.startedAt >= PING_AFTER_MS)
      if (long) void this.ping()
      else this.pingMisses = 0
      this.armPing()
    }, PING_EVERY_MS)
  }

  private clearPing(): void {
    if (this.pingTimer !== null) this.clock.clearTimeout(this.pingTimer)
    this.pingTimer = null
  }

  private armIdle(): void {
    this.clearIdle()
    const conn = this.conn
    if (!conn || this.busy || conn.inFlight().length) return
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null
      if (this.busy || this.conn !== conn || conn.inFlight().length) return
      this.conn = null
      this.shuttingDown = conn
      this.clearPing()
      void conn.shutdown().then(() => this.setState({ state: 'idle' }))
    }, IDLE_SHUTDOWN_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.clock.clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private setState(next: Partial<ComputerServiceState> & Pick<ComputerServiceState, 'state'>): void {
    this.status = { restarts: this.status.restarts, permissions: this.perms, ...next }
    if (next.state !== 'up') {
      delete this.status.pid
      delete this.status.epoch
    }
    this.emitState()
  }

  private emitState(): void {
    const s = this.state()
    for (const fn of this.states) fn(s)
  }

  private log(line: string): void {
    ;(this.opts.log ?? console.log)(`[computer] ${line}`)
  }
}
