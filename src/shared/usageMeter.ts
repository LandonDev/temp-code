import type { UsageReport } from 'aliax-core/shared/types'
import type { AccountProvider, AccountsSnapshot, ProviderAccounts } from './accounts'

/** What the rail's foot says about one provider: how much is left, and when it refills. */
export interface UsageMeter {
  /** The best account's least room among its usage windows, 0..1; null before any account reported. */
  room: number | null
  /** When that window (or the throttle keeping the best account out) lifts, if known. */
  resetsAt: number | null
}

interface AccountRoom {
  room: number
  resetsAt: number | null
}

/**
 * One account's room: the tightest of its windows. A throttled, rate-limited
 * or expired account has none, and frees when the throttle lifts. A window
 * whose reset has passed has refilled.
 */
function roomOf(report: UsageReport, accounts: ProviderAccounts, now: number): AccountRoom {
  const until = Math.max(report.rateLimit?.until ?? 0, accounts.headroom?.[report.profileName]?.throttledUntil ?? 0)
  if (report.expired) return { room: 0, resetsAt: null }
  if (report.rateLimit || until > now) return { room: 0, resetsAt: until > now ? until : null }
  let best: AccountRoom = { room: 1, resetsAt: null }
  for (const w of report.windows) {
    if (w.resetsAt !== undefined && w.resetsAt <= now) continue
    const room = Math.min(1, Math.max(0, (100 - w.usedPercent) / 100))
    if (room < best.room) best = { room, resetsAt: w.resetsAt ?? null }
  }
  return best
}

/** More room wins; on a tie, the sooner refill. */
const better = (a: AccountRoom, b: AccountRoom): boolean =>
  a.room !== b.room ? a.room > b.room : (a.resetsAt ?? Infinity) < (b.resetsAt ?? Infinity)

/**
 * The provider's meter: the room of the account a pick would land on. Null
 * when the provider has no accounts. Pure, so the rail and the phone agree.
 */
export function meterFor(provider: AccountProvider, snapshot: AccountsSnapshot, now = Date.now()): UsageMeter | null {
  const accounts = snapshot.providers[provider]
  if (!accounts || accounts.profiles.length === 0) return null
  const names = new Set(accounts.profiles.map((p) => p.name))
  let best: AccountRoom | null = null
  for (const report of accounts.reports) {
    if (!names.has(report.profileName)) continue
    const room = roomOf(report, accounts, now)
    if (!best || better(room, best)) best = room
  }
  return best ?? { room: null, resetsAt: null }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The largest whole unit until a reset, for a narrow row: "3d", "2h", "14m", "under a minute". */
export function untilShort(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms < MINUTE) return 'under a minute'
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d`
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / MINUTE)}m`
}
