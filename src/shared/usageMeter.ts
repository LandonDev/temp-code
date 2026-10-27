import type { UsageReport } from 'aliax-core/shared/types'
import type { AccountProvider, AccountsSnapshot, ProviderAccounts } from './accounts'

/*
 * The usage meter at the rail's foot, one per provider: how much is left
 * across every account routing could pick, and when more comes back. No
 * account is named. This file and its tests are the spec the phone ports
 * word for word; keep both pure.
 */

/** What the rail's foot says about one provider. */
export interface UsageMeter {
  /** Pooled room 0..1 over the routable accounts that reported; null before any did. */
  share: number | null
  /** The next refill that raises the share; null when every account is full or nothing says when. */
  resetsAt: number | null
  /** Every routable reporting account is throttled or usage-limited right now; until is the soonest lift. */
  limited: { until: number | null } | null
  /** Routable reporting accounts with room > 0 and not throttled now. */
  withRoom: number
  /** One row per window label, general windows first: the popover's rows. */
  windows: MeterWindow[]
}

export interface MeterWindow {
  label: string
  /** What the popover prints: "Week" for the weekly labels, else the label. */
  name: string
  share: number
  resetsAt: number | null
}

/**
 * The windows every model of a provider spends, in the order the popover
 * lists them. Keep in step with aliax-core's `tiersFor` (gateway/failover.ts);
 * a local table because src/shared takes no aliax-core runtime import.
 */
export const GENERAL_LABELS: Record<AccountProvider, string[]> = {
  claude: ['5h', 'Weekly'],
  codex: ['5h', 'week'],
  cursor: []
}

/** The provider as the meter names it: the plan the accounts are on, not the harness. */
export const PROVIDER_NAME: Record<AccountProvider, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }

/** Below this share a bar's fill turns amber. */
export const LOW_SHARE = 0.1
export const isLow = (share: number | null): boolean => share !== null && share < LOW_SHARE

/** The word a window label reads as. */
export const windowName = (label: string): string => (label === 'Weekly' || label === 'week' ? 'Week' : label)

type Window = UsageReport['windows'][number]

const isLive = (w: Window, now: number): boolean => !(w.resetsAt !== undefined && w.resetsAt <= now)
const roomOfWindow = (w: Window): number => Math.min(1, Math.max(0, (100 - w.usedPercent) / 100))

interface AccountRoom {
  room: number
  /** The binding window's reset (a usage limit's until), when it is in the future. */
  resetsAt: number | null
  throttled: boolean
  throttledUntil: number | null
}

const usable = (r: UsageReport): boolean => !r.expired && (r.windows.length > 0 || r.rateLimit !== undefined)

function accountRoom(report: UsageReport, accounts: ProviderAccounts, general: Set<string> | null, now: number): AccountRoom {
  const throttle = accounts.headroom?.[report.profileName]?.throttledUntil ?? 0
  const limit = report.rateLimit
  const limitLive = limit !== undefined && (limit.until === undefined || limit.until > now)
  const throttled = throttle > now || limitLive
  const lifts = [throttle > now ? throttle : null, limitLive ? (limit?.until ?? null) : null].filter(
    (t): t is number => t !== null
  )
  const throttledUntil = lifts.length > 0 ? Math.max(...lifts) : null
  if (limit) {
    const until = limit.until !== undefined && limit.until > now ? limit.until : null
    return { room: 0, resetsAt: until, throttled, throttledUntil }
  }
  let room = 1
  let resetsAt: number | null = null
  for (const w of report.windows) {
    if (general && !general.has(w.label)) continue
    if (!isLive(w, now)) continue
    const r = roomOfWindow(w)
    if (r < room) {
      room = r
      resetsAt = w.resetsAt !== undefined && w.resetsAt > now ? w.resetsAt : null
    }
  }
  return { room, resetsAt, throttled, throttledUntil }
}

const soonest = (times: (number | null)[]): number | null => {
  const known = times.filter((t): t is number => t !== null)
  return known.length > 0 ? Math.min(...known) : null
}

/**
 * The provider's meter, or null when it has no accounts. Pure, so the rail
 * and the phone agree.
 */
export function meterFor(provider: AccountProvider, snapshot: AccountsSnapshot, now = Date.now()): UsageMeter | null {
  const accounts = snapshot.providers[provider]
  if (!accounts || accounts.profiles.length === 0) return null
  const names = new Set(accounts.profiles.map((p) => p.name))
  const reports = accounts.reports.filter((r) => names.has(r.profileName) && usable(r))
  if (reports.length === 0) return { share: null, resetsAt: null, limited: null, withRoom: 0, windows: [] }

  const labels = GENERAL_LABELS[provider]
  const anyGeneral = reports.some((r) => r.windows.some((w) => labels.includes(w.label)))
  const general = anyGeneral ? new Set(labels) : null
  const rooms = reports.map((r) => accountRoom(r, accounts, general, now))

  const share = rooms.reduce((sum, a) => sum + a.room, 0) / rooms.length
  const resetsAt = soonest(rooms.filter((a) => a.room < 1).map((a) => a.resetsAt))
  const limited = rooms.every((a) => a.throttled) ? { until: soonest(rooms.map((a) => a.throttledUntil)) } : null
  const withRoom = rooms.filter((a) => a.room > 0 && !a.throttled).length

  return { share, resetsAt, limited, withRoom, windows: windowsOf(reports, labels, now) }
}

function windowsOf(reports: UsageReport[], labels: string[], now: number): MeterWindow[] {
  const seen: string[] = []
  for (const r of reports) for (const w of r.windows) if (!seen.includes(w.label)) seen.push(w.label)
  const ordered = [...labels.filter((l) => seen.includes(l)), ...seen.filter((l) => !labels.includes(l))]
  return ordered.map((label) => {
    const rows = reports.flatMap((r) => r.windows.filter((w) => w.label === label))
    const rooms = rows.map((w) => (isLive(w, now) ? roomOfWindow(w) : 1))
    const share = rooms.reduce((s, r) => s + r, 0) / rooms.length
    const resetsAt = soonest(rows.map((w, i) => (rooms[i] < 1 && w.resetsAt !== undefined && w.resetsAt > now ? w.resetsAt : null)))
    return { label, name: windowName(label), share, resetsAt }
  })
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
