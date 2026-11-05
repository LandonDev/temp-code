import {
  AWAY_OFF_STATE,
  AwayDecidedSchema,
  AwayStateSchema,
  isNewerAway,
  type AwayDecided,
  type AwayState
} from '@shared/away'
import type { AwaySnapshot } from '@shared/contract-away'

export const AWAY_SETTING = 'away'
export const AWAY_DECIDED_SETTING = 'away:decided'
/** The tally's write waits this long after its last count. */
export const AWAY_TALLY_MS = 1_000

export interface AwayDeps {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
  environmentId: string
  now?: () => number
}

const parse = <T>(raw: string | null, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): T | null => {
  if (!raw) return null
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? (parsed.data as T) : null
  } catch {
    return null
  }
}

/**
 * Away from computer on this host: the state (`away`) and the stretch's
 * tally of decisions per thread (`away:decided`), both in the settings
 * table. `set` is the person's flip, stamped here; `apply` is a peer's,
 * taken only when newer (remote/awaySync.ts). Every change, and every tally
 * write, reaches the listeners: the sockets' `away` push and the registry.
 */
export class AwayService {
  private state: AwayState
  private decided: AwayDecided
  private readonly listeners = new Set<(snapshot: AwaySnapshot, stateChanged: boolean) => void>()
  private tallyTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly deps: AwayDeps) {
    this.now = deps.now ?? Date.now
    this.state = parse<AwayState>(deps.getSetting(AWAY_SETTING), AwayStateSchema) ?? AWAY_OFF_STATE
    this.decided = parse<AwayDecided>(deps.getSetting(AWAY_DECIDED_SETTING), AwayDecidedSchema) ?? { since: 0, threads: [] }
  }

  get enabled(): boolean {
    return this.state.enabled
  }

  get(): AwaySnapshot {
    return { state: this.state, decided: this.decided }
  }

  /** The person's flip. A flip to the same value changes nothing. */
  set(enabled: boolean): AwayState {
    if (enabled === this.state.enabled) return this.state
    this.take({ enabled, at: this.now(), by: this.deps.environmentId })
    return this.state
  }

  /** A peer's state: taken when its `at` is newer than this host's. */
  apply(state: AwayState): boolean {
    if (!isNewerAway(state, this.state)) return false
    if (state.enabled === this.state.enabled) {
      // Same value, newer stamp: keep the stamp so the hosts agree, tell nobody.
      this.state = state
      this.deps.setSetting(AWAY_SETTING, JSON.stringify(state))
      return false
    }
    this.take(state)
    return true
  }

  /** One decision (an away notice) on `sessionId`, written within a second. */
  count(sessionId: string): void {
    const threads = this.decided.threads.map((t) => (t.sessionId === sessionId ? { ...t, count: t.count + 1 } : t))
    if (!threads.some((t) => t.sessionId === sessionId)) threads.push({ sessionId, count: 1 })
    this.decided = { since: this.decided.since, threads }
    if (this.tallyTimer) return
    this.tallyTimer = setTimeout(() => {
      this.tallyTimer = null
      this.writeTally()
      this.emit(false)
    }, AWAY_TALLY_MS)
  }

  onChange(listener: (snapshot: AwaySnapshot, stateChanged: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.tallyTimer) {
      clearTimeout(this.tallyTimer)
      this.tallyTimer = null
      this.writeTally()
    }
    this.listeners.clear()
  }

  private take(state: AwayState): void {
    this.state = state
    this.deps.setSetting(AWAY_SETTING, JSON.stringify(state))
    // A new stretch starts its own tally; turning off keeps it for the return toast.
    if (state.enabled) {
      if (this.tallyTimer) clearTimeout(this.tallyTimer)
      this.tallyTimer = null
      this.decided = { since: state.at, threads: [] }
      this.writeTally()
    }
    this.emit(true)
  }

  private writeTally(): void {
    this.deps.setSetting(AWAY_DECIDED_SETTING, JSON.stringify(this.decided))
  }

  private emit(stateChanged: boolean): void {
    const snapshot = this.get()
    for (const listener of this.listeners) listener(snapshot, stateChanged)
  }
}
