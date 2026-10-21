import { DEFAULT_THREAD_CAP, liveWindow, scopedSpent, tiersFor, type ServiceId, type UsageReport } from 'aliax-core'
import type { AccountHeadroom } from '@shared/accounts'

/**
 * How much room an account has for one more thread of a model, as one
 * number in 0..1, and how far another account must lead before a thread
 * leaves the one it is on. Pure; chooseAccount (accountRouting.ts) calls it
 * with the usage reports, the gateway's headroom picture (headroom.ts) and
 * the live load.
 *
 * The score is a weighted sum of four shares, each 0 (nothing left) to 1:
 *
 *  window  0.45  the least room among the model's usage windows (5h, Weekly,
 *                and Fable's own cap): the slow budget that decides whether
 *                the account can carry the thread for the next hours.
 *  limit   0.30  the tightest per-request limit the provider last sent
 *                (requests or tokens remaining ÷ limit): the fast budget that
 *                decides whether the next call answers now. An account no
 *                host has heard from counts as full: nothing says it is busy.
 *  load    0.15  live threads already on the account, against the soft
 *                thread cap (DEFAULT_THREAD_CAP), so a burst spreads.
 *  rate    0.10  answers in the last minute across every host, against
 *                RATE_FULL_PER_MIN, so an account the other host is hammering
 *                is worth less here even before its headers thin.
 *
 * Plus SPEND_FIRST_BONUS for a model without a scoped cap (Opus) on an
 * account whose Fable window is spent: that account is worth nothing to a
 * Fable thread, so Opus should use it first and leave the fresh ones.
 *
 * Stickiness: a thread stays on its account unless the best other account
 * leads by more than a tolerance. The tolerance is STICKY.base (a plain
 * preference for not moving, since a move drops the harness process) plus
 * STICKY.cache × warmth, where warmth is 1 right after the thread's last
 * answer and falls to 0 over the provider's prompt-cache TTL (5 minutes):
 * a warm cache is worth up to a quarter of the whole scale, so a thread
 * mid-conversation only moves for an account with far more room, and a
 * thread idle for ten minutes moves for a little. A `fresh` pick (the
 * thread has no process and its model or sticky account changed) drops the
 * base and keeps only the cache term.
 */
export const WEIGHTS = { window: 0.45, limit: 0.3, load: 0.15, rate: 0.1 } as const
export const RATE_FULL_PER_MIN = 30
export const SPEND_FIRST_BONUS = 0.15
export const STICKY = { base: 0.1, cache: 0.25, cacheTtlMs: 5 * 60_000 } as const

export interface ScoreInput {
  serviceId: ServiceId
  model: string | null
  report: UsageReport | undefined
  headroom: AccountHeadroom | undefined
  /** Live threads on the account. */
  threads: number
  now: number
}

export interface ScoreDetail {
  total: number
  window: number
  limit: number
  load: number
  rate: number
  spendFirst: boolean
}

export interface ScoredAccount extends ScoreDetail {
  name: string
  threads: number
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

/** The least room among the model's usage windows; a lifted or absent window is full. */
export function windowShare(serviceId: ServiceId, model: string | null, report: UsageReport | undefined, now: number): number {
  let least = 1
  for (const label of tiersFor(serviceId, model)) {
    const w = liveWindow(report, label, now)
    if (!w) continue
    least = Math.min(least, clamp01((100 - w.usedPercent) / 100))
  }
  return least
}

export function scoreAccount({ serviceId, model, report, headroom, threads, now }: ScoreInput): ScoreDetail {
  const window = windowShare(serviceId, model, report, now)
  const limit = headroom?.room ?? 1
  const load = 1 - clamp01(threads / DEFAULT_THREAD_CAP)
  const rate = 1 - clamp01((headroom?.ratePerMin ?? 0) / RATE_FULL_PER_MIN)
  const spendFirst = scopedSpent(serviceId, model, report, now) === true
  const total = WEIGHTS.window * window + WEIGHTS.limit * limit + WEIGHTS.load * load + WEIGHTS.rate * rate + (spendFirst ? SPEND_FIRST_BONUS : 0)
  return { total, window, limit, load, rate, spendFirst }
}

export interface RankInput {
  serviceId: ServiceId
  model: string | null
  /** The accounts worth scoring: known, with room, not out, not throttled. */
  names: string[]
  reports: UsageReport[]
  headroom: Record<string, AccountHeadroom>
  load: Record<string, number>
  now: number
}

/** Best first; ties go to the fewer live threads, then the name, so a pick is deterministic. */
export function rankAccounts({ serviceId, model, names, reports, headroom, load, now }: RankInput): ScoredAccount[] {
  return names
    .map((name) => {
      const threads = load[name] ?? 0
      return { name, threads, ...scoreAccount({ serviceId, model, report: reports.find((r) => r.profileName === name), headroom: headroom[name], threads, now }) }
    })
    .sort((a, b) => b.total - a.total || a.threads - b.threads || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 1 right after the thread's last answer, 0 once the prompt cache has surely expired. */
export function cacheWarmth(lastActiveAt: number | null | undefined, now: number): number {
  if (lastActiveAt === null || lastActiveAt === undefined) return 0
  return clamp01(1 - (now - lastActiveAt) / STICKY.cacheTtlMs)
}

/** How far the best account must lead the current one before the thread moves. */
export function stickyTolerance(warmth: number, fresh: boolean): number {
  return STICKY.cache * clamp01(warmth) + (fresh ? 0 : STICKY.base)
}

/**
 * The account a thread with a sticky `current` ends up on: the best one when
 * it leads by more than the tolerance, else where it is. `ranked` must hold
 * `current`.
 */
export function keepOrMove(current: string, ranked: ScoredAccount[], tolerance: number): string {
  const best = ranked[0]
  const own = ranked.find((r) => r.name === current)
  if (!best || !own || best.name === current) return current
  return best.total - own.total > tolerance ? best.name : current
}
