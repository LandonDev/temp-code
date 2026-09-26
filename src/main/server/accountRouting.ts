import { hasRoom, pickFromCache, tiersFor } from 'aliax-core'
import { isRoutedProvider, SERVICE_OF, type AccountRoute, type AccountsSnapshot } from '@shared/accounts'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'

/**
 * Which Aliax account a thread spends from. Pure: the registry feeds it the
 * thread, its project and workspace, and the accounts snapshot; the result
 * is baked into the child's gateway URL at spawn.
 */

export type PinLevel = 'thread' | 'project' | 'workspace'

export interface ResolvedPin {
  name: string
  level: PinLevel
}

/**
 * The explicit pin that applies to a thread: its own, else its project's for
 * its provider, else its workspace's. A subagent has no pin of its own unless
 * set on it, so a parent's thread pin never reaches its children.
 */
export function resolvePin(
  meta: Pick<SessionMeta, 'provider' | 'accountPin'>,
  project: Pick<ProjectMeta, 'accountPins'> | null,
  workspace: Pick<WorkspaceMeta, 'accountPins'> | null
): ResolvedPin | null {
  if (!isRoutedProvider(meta.provider)) return null
  if (meta.accountPin) return { name: meta.accountPin, level: 'thread' }
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
 */
export function chooseAccount({ pin, current, model, provider, snapshot, now = Date.now() }: ChooseInput): Choice {
  if (!isRoutedProvider(provider)) return { route: null, current: null }
  const snap = snapshot.providers[provider]
  const serviceId = SERVICE_OF[provider]
  const tiers = tiersFor(serviceId, model)
  const known = (name: string | null): name is string => name !== null && snap.profiles.some((p) => p.name === name)
  const room = (name: string): boolean => hasRoom(snap.reports.find((r) => r.profileName === name), tiers, now)
  const pick = (tried: string[]): string | null =>
    pickFromCache({ serviceId, model, scoped: true, profiles: snap.profiles, reports: snap.reports, tried, now })

  if (known(pin)) {
    const expected = room(pin) ? pin : known(current) && room(current) ? current : (pick([pin]) ?? pin)
    return { route: { account: pin, pin: true }, current: expected }
  }
  if (known(current) && room(current)) return { route: { account: current, pin: false }, current }
  const picked = pick([]) ?? (known(current) ? current : null)
  return { route: picked ? { account: picked, pin: false } : null, current: picked }
}
