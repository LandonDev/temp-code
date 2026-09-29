import { DEFAULT_THREAD_CAP, hasRoom, pickFromCache, scopedSpent, tiersFor } from 'aliax-core'
import { isRoutedProvider, SERVICE_OF, type AccountRoute, type AccountsSnapshot } from '@shared/accounts'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'

/**
 * Which Aliax account a thread spends from. Pure: the registry feeds it the
 * thread, its project and workspace, and the accounts snapshot; the result
 * is baked into the child's gateway URL at spawn.
 */

export type PinLevel = 'project' | 'workspace'

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
  model: string | null
  provider: SessionMeta['provider']
  snapshot: AccountsSnapshot
  /** Live threads per account (running, watching, starting), from the registry. */
  load?: Record<string, number>
  now?: number
}

export interface Choice {
  /** What the child's URL names; null sends an unscoped URL (no account to name). */
  route: AccountRoute | null
  /** The account the thread is expected to spend from, for its row. */
  current: string | null
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
 */
export function chooseAccount({ pin, current, model, provider, snapshot, load = {}, now = Date.now() }: ChooseInput): Choice {
  if (!isRoutedProvider(provider)) return { route: null, current: null }
  const snap = snapshot.providers[provider]
  const serviceId = SERVICE_OF[provider]
  const tiers = tiersFor(serviceId, model)
  const known = (name: string | null): name is string => name !== null && snap.profiles.some((p) => p.name === name)
  const room = (name: string): boolean => hasRoom(snap.reports.find((r) => r.profileName === name), tiers, now)
  const effectiveLoad = snap.pinned ? { ...load, [snap.pinned]: (load[snap.pinned] ?? 0) + 1 } : load
  const pick = (tried: string[]): string | null =>
    pickFromCache({ serviceId, model, scoped: true, profiles: snap.profiles, reports: snap.reports, tried, load: effectiveLoad, cap: DEFAULT_THREAD_CAP, now })

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
    return { route: { account: kept, pin: false }, current: kept }
  }
  const picked = pick([]) ?? (known(current) ? current : null)
  return { route: picked ? { account: picked, pin: false } : null, current: picked }
}
