import { existsSync, watch, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accounts,
  adapter,
  isLive,
  pickNext,
  pinProfile,
  pinnedProfile,
  readMarker,
  vault,
  type ActionResult,
  type Limit,
  type LimitInfo,
  type Owner,
  type ProfileView,
  type ServiceId,
  type ServiceView,
  type UsageReport
} from 'aliax-core'
import { dataDir } from 'aliax-core/config'
import {
  ACCOUNT_PROVIDERS,
  PROVIDER_OF,
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
  /** Forced poll of one account, for choosing a failover target. */
  usageOf: (id: ServiceId, name: string) => Promise<UsageReport | null>
  /** Make the next poll of one account skip its TTL. */
  markStale: (id: ServiceId, name: string) => void
  /** Charge a window an error message named, so the pin is not picked again before its report refreshes. */
  observeLimit: (id: ServiceId, name: string, limit: Limit) => void
  /** Models of the threads running on a provider right now: every one must fit the next account. */
  liveModels: (provider: AccountProvider) => string[]
  dataDir: () => string
  pollMs: number
  now: () => number
}

/** The accounts a failover moved between. */
export interface Switched {
  from: string
  to: string
}

/** How long after a window's reset before the next poll believes it. */
export const RESET_GRACE_MS = 15_000
/** A reset further away than this re-arms on the next build instead. */
const RESET_HORIZON_MS = 24 * 3_600_000

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
  usageOf: (id, name) => accounts.usageOf(id, name, true),
  markStale: accounts.markUsageStale,
  observeLimit: (id, name, limit) => void accounts.observeLimit(id, name, limit),
  liveModels: () => [],
  dataDir,
  pollMs: 60_000,
  now: Date.now
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
  private reset: NodeJS.Timeout | null = null
  private chain: Promise<unknown> = Promise.resolve()
  /** Why the last failover's sign-in did not land, per provider, until the next switch. */
  private failoverNotes: Partial<Record<AccountProvider, string>> = {}
  /** One failover in flight per provider: a tree whose members all hit the limit asks once. */
  private failovers: Partial<Record<AccountProvider, Promise<Switched | null>>> = {}

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
    if (this.reset) clearTimeout(this.reset)
    this.reset = null
  }

  /** When the earliest full window resets, from the reports we hold. */
  nextReset(): { at: number; stale: { id: ServiceId; name: string }[] } | null {
    const now = this.deps.now()
    let at = Infinity
    const due: { id: ServiceId; name: string; at: number }[] = []
    for (const p of ACCOUNT_PROVIDERS) {
      for (const r of this.snap.providers[p].reports) {
        for (const w of r.windows) {
          if (w.usedPercent < 100 || w.resetsAt === undefined || w.resetsAt <= now) continue
          due.push({ id: SERVICE_OF[p], name: r.profileName, at: w.resetsAt })
          at = Math.min(at, w.resetsAt)
        }
      }
    }
    if (at === Infinity) return null
    // Everything resetting within the grace of the earliest goes stale together.
    const stale = due.filter((d) => d.at <= at + RESET_GRACE_MS).map(({ id, name }) => ({ id, name }))
    return { at: at + RESET_GRACE_MS, stale: stale.filter((s, i) => stale.findIndex((o) => o.id === s.id && o.name === s.name) === i) }
  }

  /**
   * Re-armed after every build: one timer for the soonest reset, owner-only
   * (Aliax polls on its own when it holds the gateway, and we follow its
   * cache). Firing marks those accounts stale and rebuilds, which polls them
   * in turn through the chain, so a slow poll never overlaps the next.
   */
  private armReset(): void {
    if (this.reset) clearTimeout(this.reset)
    this.reset = null
    if (!this.poll) return
    const next = this.nextReset()
    if (!next) return
    const delay = next.at - this.deps.now()
    if (delay > RESET_HORIZON_MS) return
    this.reset = setTimeout(() => {
      this.reset = null
      if (this.deps.owner() === 'aliax') return
      for (const s of next.stale) this.deps.markStale(s.id, s.name)
      void this.rebuild(false)
    }, Math.max(delay, 0))
  }

  /**
   * The gateway's 429 handler asks for the next account: one with room in
   * every window the refused model and every live model spend, ordered by
   * soonest reset, confirmed by a forced poll. Null passes the 429 through.
   */
  async pickNext(info: LimitInfo): Promise<string | null> {
    const provider = PROVIDER_OF[info.serviceId]
    const snap = (await this.list()).providers[provider]
    return pickNext({
      serviceId: info.serviceId,
      model: info.model,
      liveModels: this.deps.liveModels(provider),
      window: info.limit.window,
      profiles: snap.profiles,
      reports: snap.reports,
      tried: info.tried,
      poll: (name) => this.deps.usageOf(info.serviceId, name).catch(() => null),
      now: this.deps.now()
    })
  }

  /**
   * Core moved the pin and the request landed. Sign the CLIs in to match, in
   * the background: a failure leaves the pin where it is (the gateway routes
   * by pin, not by sign-in) and says so in the footer until the next switch.
   */
  failedOver({ serviceId, to }: { serviceId: ServiceId; to: string }): void {
    const provider = PROVIDER_OF[serviceId]
    delete this.failoverNotes[provider]
    void this.deps
      .activate(serviceId, to)
      .then((r) => {
        if (!r.ok) this.failoverNotes[provider] = `switched to ${to}; sign-in failed: ${r.error}`
      })
      .catch((e) => {
        this.failoverNotes[provider] = `switched to ${to}; sign-in failed: ${(e as Error).message}`
      })
      .then(() => this.rebuild(false))
  }

  /**
   * A thread's error named a usage limit the gateway never saw (the CLI
   * spoke to the provider directly, or the limit came back as text): charge
   * the pinned account's window, pick the next account with room for this
   * model and every live one, and switch to it. Null leaves the pin and the
   * thread's Continue button alone.
   */
  failover(provider: AccountProvider, info: { model: string | null; window: Limit['window'] }): Promise<Switched | null> {
    const inflight = this.failovers[provider]
    if (inflight) return inflight
    const run = this.runFailover(provider, info).finally(() => {
      delete this.failovers[provider]
    })
    this.failovers[provider] = run
    return run
  }

  private async runFailover(provider: AccountProvider, info: { model: string | null; window: Limit['window'] }): Promise<Switched | null> {
    if (info.window === 'transient') return null
    const id = SERVICE_OF[provider]
    const from = this.deps.pinned(id)
    if (!from) return null
    this.deps.observeLimit(id, from, { window: info.window })
    const to = await this.pickNext({ service: provider, serviceId: id, model: info.model, limit: { window: info.window }, tried: [from] })
    if (!to) return null
    const result = await this.switch(provider, to)
    if (!result.ok) {
      this.failoverNotes[provider] = `could not switch to ${to}: ${result.error}`
      await this.rebuild(false)
      return null
    }
    return { from, to }
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
    if (result.ok) {
      this.deps.pin(id, name)
      delete this.failoverNotes[provider]
    }
    await this.rebuild(false)
    return result
  }

  /** Rebuilds run one at a time; a forced one only forces its provider. */
  private rebuild(force: boolean, only?: AccountProvider): Promise<void> {
    const run = this.chain.then(() => this.build(force, only)).then((snap) => {
      this.snap = snap
      this.built = true
      this.armReset()
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
        note: note ?? this.failoverNotes[p] ?? view?.notice
      }
    }
    return { updatedAt: Date.now(), providers }
  }
}
