import type { ClientRequest } from '@shared/contract'
import { ESCAPE_WATCH } from '@shared/computer/protocol'
import { ComputerRpcError } from './connection'
import type { Clock, ComputerService } from './service'
import type { ComputerSessions } from './sessions'

export interface ComputerBannerHooks {
  show(opts: { esc: boolean }): void
  hide(): void
}
export const computerBannerHooks: { current: ComputerBannerHooks | null } = { current: null }
export interface SessionHold {
  thread: string | null
  since: number
}
export const HOLD_LINGER_MS = 3_000
const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

/** Follows the scheduler's holder, including a button kept down between calls. */
export class SessionHolds {
  private hold: SessionHold | null = null
  private readonly clock: Clock
  private linger: unknown = null
  private renew: unknown = null
  private generation = 0
  private watching: number | null = null
  private unsupported = false
  private logged = false
  private closed = false
  private readonly off: (() => void)[] = []
  constructor(
    private readonly deps: {
      service: ComputerService
      sessions: ComputerSessions
      banner: () => ComputerBannerHooks | null
      clock?: Clock
      log?: (line: string) => void
    }
  ) {
    this.clock = deps.clock ?? REAL_CLOCK
    this.off.push(
      deps.service.onNotification((n) => {
        if (n.method !== 'escape/pressed' || !this.hold) return
        const thread = this.hold.thread
        this.end()
        if (thread !== null)
          void deps.sessions
            .stop(thread)
            .catch((e: Error) => deps.log?.(`Computer Stop: ${e.message}`))
      })
    )
    this.off.push(
      deps.service.onEpoch(() => {
        this.unsupported = false
        if (this.hold && this.watching !== this.generation) {
          deps.banner()?.show({ esc: false })
          void this.watch()
        }
      })
    )
  }
  /** A proof may hold for no thread; null alone releases the holder. */
  holder = (threadId: string | Pick<SessionHold, 'thread'> | null): void => {
    if (this.closed) return
    if (this.linger !== null) this.clock.clearTimeout(this.linger)
    this.linger = null
    if (threadId === null) {
      if (this.hold)
        this.linger = this.clock.setTimeout(() => {
          this.linger = null
          this.end()
        }, HOLD_LINGER_MS)
      return
    }
    const thread = typeof threadId === 'string' ? threadId : threadId.thread
    if (this.hold) {
      this.hold = { thread, since: this.hold.since }
      return
    }
    this.hold = { thread, since: this.clock.now() }
    this.generation++
    this.deps.banner()?.show({ esc: false })
    void this.watch()
  }
  current(): SessionHold | null {
    return this.hold ? { ...this.hold } : null
  }
  close(): void {
    if (this.closed) return
    this.end()
    this.closed = true
    for (const off of this.off) off()
  }
  private async watch(): Promise<void> {
    if (!this.hold || this.unsupported) return
    const generation = this.generation
    this.watching = generation
    if (this.renew !== null) this.clock.clearTimeout(this.renew)
    this.renew = null
    try {
      await this.deps.service.request('escape.watch', { on: true, leaseMs: ESCAPE_WATCH.leaseMs })
      if (this.watching === generation) this.watching = null
      if (generation !== this.generation || !this.hold) return
      this.deps.banner()?.show({ esc: true })
    } catch (error) {
      if (this.watching === generation) this.watching = null
      if (generation !== this.generation || !this.hold) return
      this.deps.banner()?.show({ esc: false })
      if (error instanceof ComputerRpcError && error.code === -32601) {
        this.unsupported = true
        if (!this.logged) {
          this.logged = true
          ;(this.deps.log ?? console.log)(
            '[computer] This service has no Escape watch; use Stop in Activity.'
          )
        }
        return
      }
      this.deps.log?.(`Computer Escape watch: ${(error as Error).message}`)
    }
    this.renew = this.clock.setTimeout(() => {
      this.renew = null
      void this.watch()
    }, ESCAPE_WATCH.renewMs)
  }
  private end(): void {
    if (this.linger !== null) this.clock.clearTimeout(this.linger)
    if (this.renew !== null) this.clock.clearTimeout(this.renew)
    this.linger = null
    this.renew = null
    if (!this.hold) return
    this.hold = null
    this.generation++
    this.deps.banner()?.hide()
    void this.deps.service.request('escape.watch', { on: false }).catch(() => undefined)
  }
}

/** Kept with the holds so the local proof guard is tested without starting the server. */
export function handleComputerProofHold(
  req: ClientRequest,
  holds: SessionHolds | null,
  env = process.env
): { handled: boolean; result?: null } {
  if (req.method !== 'computer.proofHold') return { handled: false }
  if (env.TEMP_CODE_E2E_STATUS !== '1')
    throw new Error('Computer proof hold is only available in a proof instance')
  if (!holds) throw new Error('Computer use is not available here')
  holds.holder(req.params.on ? { thread: null } : null)
  return { handled: true, result: null }
}
