import { existsSync, watch, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accounts,
  adapter,
  isLive,
  pinProfile,
  pinnedProfile,
  readMarker,
  vault,
  type ActionResult,
  type Owner,
  type ProfileView,
  type ServiceId,
  type ServiceView,
  type UsageReport
} from 'aliax-core'
import { dataDir } from 'aliax-core/config'
import {
  ACCOUNT_PROVIDERS,
  SERVICE_OF,
  emptyAccounts,
  type AccountProvider,
  type AccountsSnapshot,
  type ProviderAccounts
} from '@shared/accounts'

export interface AccountsDeps {
  listServices: () => Promise<ServiceView[]>
  usage: (id: ServiceId, force?: boolean) => Promise<UsageReport[]>
  activate: (id: ServiceId, name: string) => Promise<ActionResult>
  pinned: (id: ServiceId) => string | null
  pin: (id: ServiceId, name: string) => void
  owner: () => Owner | null
  vaultPresent: () => boolean
  locked: () => boolean
  /** The live sign-in of a service, for a machine without an Aliax vault. */
  live: (id: ServiceId, force: boolean) => Promise<{ profile: ProfileView; report: UsageReport } | null>
  dataDir: () => string
  pollMs: number
}

const LIVE_TTL: Partial<Record<ServiceId, number>> = { 'claude-code': 10 * 60_000 }
const liveCache = new Map<ServiceId, { at: number; value: { profile: ProfileView; report: UsageReport } | null }>()

/**
 * No vault to read: poll the credentials the CLI itself is signed in with and
 * show them as one unnamed profile. Nothing is written back; the CLI renews
 * its own tokens.
 */
export async function liveAccount(
  id: ServiceId,
  force: boolean
): Promise<{ profile: ProfileView; report: UsageReport } | null> {
  const a = adapter(id)
  if (!a.detect()) return null
  const cached = liveCache.get(id)
  if (!force && cached && Date.now() - cached.at < (LIVE_TTL[id] ?? 90_000)) return cached.value
  let value: { profile: ProfileView; report: UsageReport } | null = null
  try {
    const cap = await a.capture((suffix) => join(tmpdir(), `temp-code-live-${id}-${suffix}`))
    if (cap.blob) {
      const name = cap.email ?? cap.accountId
      const profile: ProfileView = { name, email: cap.email, createdAt: 0, active: true, activeOn: ['Active'] }
      const r = await a.usage(cap.blob, true, force, true)
      const report: UsageReport =
        r.note === 'usage temporarily unavailable'
          ? { profileName: name, windows: [], plan: r.plan, rateLimit: { provider: a.name, until: r.retryAfterMs !== undefined ? Date.now() + r.retryAfterMs : undefined } }
          : { profileName: name, windows: r.windows, note: r.note, extra: r.extra, banked: r.banked, plan: r.plan, expired: r.expired }
      value = { profile, report }
    }
  } catch {
    value = null
  }
  liveCache.set(id, { at: Date.now(), value })
  return value
}

const defaults = (): AccountsDeps => ({
  listServices: accounts.listServices,
  usage: accounts.usage,
  activate: accounts.activate,
  pinned: pinnedProfile,
  pin: (id, name) => pinProfile(id, name),
  owner: () => {
    const m = readMarker()
    return isLive(m) ? m.owner : null
  },
  vaultPresent: () => existsSync(join(dataDir(), 'profiles.json')),
  locked: vault.vaultLocked,
  live: liveAccount,
  dataDir,
  pollMs: 60_000
})

/**
 * The server's view of Aliax's accounts: who is pinned per provider, every
 * saved profile and its usage. Rebuilt on demand, on a poll, and whenever
 * Aliax rewrites its settings or usage cache; every rebuild goes to the
 * listeners, which push it to each window.
 */
export class AccountsService {
  private deps: AccountsDeps
  private snap: AccountsSnapshot = emptyAccounts()
  private built = false
  private listeners = new Set<(snapshot: AccountsSnapshot) => void>()
  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(deps: Partial<AccountsDeps> = {}) {
    this.deps = { ...defaults(), ...deps }
  }

  snapshot(): AccountsSnapshot {
    return this.snap
  }

  onChange(listener: (snapshot: AccountsSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Watch Aliax's files (one fd) and poll while nobody else will. */
  start(): void {
    const dir = this.deps.dataDir()
    if (existsSync(dir)) {
      try {
        this.watcher = watch(dir, (_event, file) => {
          if (file !== 'settings.json' && file !== 'usage-cache.json') return
          this.nudge()
        })
        this.watcher.on('error', () => {})
      } catch {
        // the poll still catches up
      }
    }
    // Aliax polls when it owns the gateway; anyone else's poll would only
    // read the cache it writes. With no live owner, nobody else will.
    this.poll = setInterval(() => {
      if (this.deps.owner() !== 'aliax') void this.rebuild(false)
    }, this.deps.pollMs)
    void this.rebuild(false)
  }

  /** Something changed under us (a file, an observed window): rebuild soon, once. */
  nudge(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.rebuild(false), 200)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  async list(): Promise<AccountsSnapshot> {
    if (!this.built) await this.rebuild(false)
    return this.snap
  }

  /** The user's Refresh: force a poll (forwarded to the owner when standby). */
  async refresh(provider: AccountProvider): Promise<AccountsSnapshot> {
    await this.rebuild(true, provider)
    return this.snap
  }

  async switch(provider: AccountProvider, name: string): Promise<ActionResult> {
    const id = SERVICE_OF[provider]
    if (this.deps.pinned(id) === name) return { ok: false, error: `${name} is already the pinned account` }
    const result = await this.deps.activate(id, name)
    if (result.ok) this.deps.pin(id, name)
    await this.rebuild(false)
    return result
  }

  /** Rebuilds run one at a time; a forced one only forces its provider. */
  private rebuild(force: boolean, only?: AccountProvider): Promise<void> {
    const run = this.chain.then(() => this.build(force, only)).then((snap) => {
      this.snap = snap
      this.built = true
      for (const l of this.listeners) l(snap)
    })
    this.chain = run.catch(() => {})
    return run
  }

  private async build(force: boolean, only?: AccountProvider): Promise<AccountsSnapshot> {
    const d = this.deps
    const owner = d.owner()
    const providers = {} as Record<AccountProvider, ProviderAccounts>
    if (!d.vaultPresent() || d.locked()) {
      const note = d.vaultPresent() ? 'Aliax vault locked: allow temp-code in Keychain' : undefined
      for (const p of ACCOUNT_PROVIDERS) {
        const live = await d.live(SERVICE_OF[p], force && (!only || only === p)).catch(() => null)
        providers[p] = {
          pinned: live?.profile.name ?? null,
          profiles: live ? [live.profile] : [],
          reports: live ? [live.report] : [],
          owner,
          note
        }
      }
      return { updatedAt: Date.now(), providers }
    }
    const services = await d.listServices().catch(() => [] as ServiceView[])
    for (const p of ACCOUNT_PROVIDERS) {
      const id = SERVICE_OF[p]
      const view = services.find((s) => s.id === id)
      const profiles = view?.profiles ?? []
      let reports: UsageReport[] = []
      let note: string | undefined
      if (profiles.length > 0) {
        try {
          reports = await d.usage(id, force && (!only || only === p))
        } catch (e) {
          note = `usage unavailable (${(e as Error).message})`
        }
      }
      providers[p] = {
        pinned: d.pinned(id) ?? profiles.find((x) => x.active)?.name ?? null,
        profiles,
        reports,
        owner,
        note: note ?? view?.notice
      }
    }
    return { updatedAt: Date.now(), providers }
  }
}
