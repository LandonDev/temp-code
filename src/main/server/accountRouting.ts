import { DEFAULT_THREAD_CAP, hasRoom, pickFromCache, scopedSpent, tiersFor } from 'aliax-core'
import { isRoutedProvider, SERVICE_OF, type AccountHeadroom, type AccountRoute, type AccountsSnapshot } from '@shared/accounts'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { cacheWarmth, keepOrMove, rankAccounts, stickyTolerance } from './accountScore'

/**
 * Which Aliax account a thread spends from. Pure: the registry feeds it the
 * thread, its project and workspace, and the accounts snapshot; the result
 * is baked into the child's gateway URL at spawn.
 */

export type PinLevel = 'project' | 'workspace'

/** How a thread's account is picked: `fresh` drops the plain preference for
 *  its sticky account (only a warm prompt cache still holds it there);
 *  `load` is the live load when the caller already read it. */
export interface RouteOptions {
  fresh?: boolean
  load?: Record<string, number>
}

export interface ResolvedPin {
  name: string
  level: PinLevel
}

/**
 * The explicit pin that applies to a thread: its project's for its provider,
 * else its workspace's. A thread has no pin of its own: it is always auto
 * under whatever scope pin applies.
 */
export function resolvePin(
  meta: Pick<SessionMeta, 'provider'>,
  project: Pick<ProjectMeta, 'accountPins'> | null,
  workspace: Pick<WorkspaceMeta, 'accountPins'> | null
): ResolvedPin | null {
  if (!isRoutedProvider(meta.provider)) return null
  const fromProject = project?.accountPins?.[meta.provider]
  if (fromProject) return { name: fromProject, level: 'project' }
  const fromWorkspace = workspace?.accountPins?.[meta.provider]
  if (fromWorkspace) return { name: fromWorkspace, level: 'workspace' }
  return null
}

export interface ChooseInput {
  /** The explicit pin that applies, if any. */
  pin: string | null
  /** The account the thread spent from last (sticky). */
  current: string | null
  /** The account the thread's row shows when `current` was dropped as fresh (a re-pick ignores it, but the
   *  row must still learn that it is gone): reported as vanished when the snapshot no longer knows it. */
  stored?: string | null
  model: string | null
  provider: SessionMeta['provider']
  snapshot: AccountsSnapshot
  /** Live threads per account (running, watching, starting), from the registry. */
  load?: Record<string, number>
  /** Accounts whose sign-in is dead (a 401 answered a request): never a pick, never "room". */
  out?: string[]
  /**
   * The gateway's picture of each account (headroom.ts, merged across hosts).
   * With it the pick is scored (accountScore.ts); without it the older
   * cache-order pick runs. The registry always passes it.
   */
  headroom?: Record<string, AccountHeadroom>
  /** When the thread last got an answer, for the prompt-cache warmth of its sticky account. */
  lastActiveAt?: number | null
  /** See RouteOptions.fresh. */
  fresh?: boolean
  now?: number
}

export interface Choice {
  /** What the child's URL names; null sends an unscoped URL (no account to name). */
  route: AccountRoute | null
  /** The account the thread is expected to spend from, for its row. */
  current: string | null
  /** A pin or sticky account the snapshot no longer knows (deleted here, or dropped on its owner's word): the
   *  choice fell back to automatic routing, and the registry clears the pin and says so in the thread. Never
   *  set from an empty snapshot (nothing known yet is not the same as gone). */
  vanished?: { pin?: string; sticky?: string }
}

/**
 * Room is judged from the cached snapshot alone: many subagents may spawn
 * at once and must not each force a poll. The gateway still confirms with a
 * forced poll before it moves a thread.
 *
 * A pin is always what the URL names, even while it is out: the gateway
 * keeps the thread on an account with room and brings it back to the pin
 * the moment the cache shows room, with no restart. Without a pin the URL
 * names the sticky current account while it has room, else the best pick
 * for the model, else whatever we had (the gateway's 429 then surfaces).
 *
 * One exception to sticky: a model without a scoped cap (Opus) should
 * spend the accounts whose Fable window is gone and leave the fresh ones
 * to Fable threads. So when its current account's Fable window has room
 * (it reset) and the best pick is one whose Fable window is spent, the
 * thread moves there. Only that class change moves it — never a smaller
 * usedPercent shift between two accounts of the same class — so a thread
 * does not churn between accounts on every snapshot.
 *
 * Among accounts with room the pick prefers the most 5h headroom and the
 * fewest live threads (DEFAULT_THREAD_CAP is soft), so a burst of new
 * threads spreads instead of stacking on one account until its 5h fills.
 * The global pin carries the terminals' traffic, so it counts as one live
 * thread of its own.
 *
 * An account in `out` answered 401: it never spends, so by headroom it would
 * win every pick. It has no room here, so a pinned thread expects the
 * fallback, a sticky thread leaves it, and a first spawn never lands on it.
 */
export function chooseAccount({ pin, current: given, stored = null, model, provider, snapshot, load = {}, out = [], headroom, lastActiveAt, fresh = false, now = Date.now() }: ChooseInput): Choice {
  if (!isRoutedProvider(provider)) return { route: null, current: null }
  const snap = snapshot.providers[provider]
  const serviceId = SERVICE_OF[provider]
  const tiers = tiersFor(serviceId, model)
  const known = (name: string | null): name is string => name !== null && snap.profiles.some((p) => p.name === name)
  const gone = (name: string | null): name is string => name !== null && snap.profiles.length > 0 && !known(name)
  // The older pick forgets the sticky account on a fresh re-pick; the scored one keeps it and drops only the plain preference.
  const current = fresh ? null : given
  const goneSticky = gone(current) ? current : gone(stored ?? given) ? (stored ?? given) : null
  const vanished = gone(pin) || goneSticky ? { ...(gone(pin) ? { pin } : {}), ...(goneSticky ? { sticky: goneSticky } : {}) } : undefined
  const withVanished = (choice: Choice): Choice => (vanished ? { ...choice, vanished } : choice)
  const room = (name: string): boolean => !out.includes(name) && hasRoom(snap.reports.find((r) => r.profileName === name), tiers, now)
  const effectiveLoad = snap.pinned ? { ...load, [snap.pinned]: (load[snap.pinned] ?? 0) + 1 } : load
  if (headroom) return withVanished(chooseScored({ pin, current: given, model, serviceId, snap, known, room, load: effectiveLoad, headroom, lastActiveAt, fresh, now }))
  const pick = (tried: string[]): string | null =>
    pickFromCache({ serviceId, model, scoped: true, profiles: snap.profiles, reports: snap.reports, tried: [...tried, ...out], load: effectiveLoad, cap: DEFAULT_THREAD_CAP, now })

  if (known(pin)) {
    const expected = room(pin) ? pin : known(current) && room(current) ? current : (pick([pin]) ?? pin)
    return { route: { account: pin, pin: true }, current: expected }
  }
  if (known(current) && room(current)) {
    const report = (name: string) => snap.reports.find((r) => r.profileName === name)
    const best = pick([])
    const outclassed =
      best !== null &&
      best !== current &&
      scopedSpent(serviceId, model, report(current), now) === false &&
      scopedSpent(serviceId, model, report(best), now) === true
    const kept = outclassed ? best : current
    return withVanished({ route: { account: kept, pin: false }, current: kept })
  }
  const picked = pick([]) ?? (known(current) ? current : null)
  return withVanished({ route: picked ? { account: picked, pin: false } : null, current: picked })
}

interface ScoredInput {
  pin: string | null
  current: string | null
  model: string | null
  serviceId: (typeof SERVICE_OF)[keyof typeof SERVICE_OF]
  snap: AccountsSnapshot['providers'][keyof AccountsSnapshot['providers']]
  known: (name: string | null) => name is string
  room: (name: string) => boolean
  load: Record<string, number>
  headroom: Record<string, AccountHeadroom>
  lastActiveAt: number | null | undefined
  fresh: boolean
  now: number
}

/**
 * The scored pick (accountScore.ts): every known account with room that is
 * not out and not inside a 429's cooldown is scored for the model; the best
 * wins a first spawn, and a sticky thread moves only when the best leads
 * its own account by more than the sticky tolerance (cache warmth and all).
 * A pin is the route no matter what; its expected account follows the same
 * order as the older pick: the pin while usable, else the sticky account
 * while usable, else the best of the rest, else the pin.
 */
function chooseScored({ pin, current, model, serviceId, snap, known, room, load, headroom, lastActiveAt, fresh, now }: ScoredInput): Choice {
  const throttled = (name: string): boolean => (headroom[name]?.throttledUntil ?? 0) > now
  const usable = (name: string | null): name is string => known(name) && room(name) && !throttled(name)
  const ranked = (except: string[]) =>
    rankAccounts({ serviceId, model, names: snap.profiles.map((p) => p.name).filter((n) => usable(n) && !except.includes(n)), reports: snap.reports, headroom, load, now })
  if (known(pin)) {
    const expected = usable(pin) ? pin : usable(current) ? current : (ranked([pin])[0]?.name ?? pin)
    return { route: { account: pin, pin: true }, current: expected }
  }
  const list = ranked([])
  if (usable(current)) {
    const kept = keepOrMove(current, list, stickyTolerance(cacheWarmth(lastActiveAt, now), fresh))
    return { route: { account: kept, pin: false }, current: kept }
  }
  const picked = list[0]?.name ?? (known(current) ? current : null)
  return { route: picked ? { account: picked, pin: false } : null, current: picked }
}
