import { existsSync, watch, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accounts,
  adapter,
  isLive,
  pickNext,
  pinnedProfile,
  readMarker,
  vault,
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
  isRoutedProvider,
  type AccountHeadroom,
  type AccountProvider,
  type AccountRoute,
  type AccountsSnapshot,
  type PeerState,
  type ProviderAccounts, type MintProgress } from '@shared/accounts'
import type { SessionMeta } from '@shared/events'
import { chooseAccount, type ResolvedPin, type RouteOptions } from './accountRouting'
import type { HeadroomStore } from './headroom'

export interface AccountsDeps {
  listServices: () => Promise<ServiceView[]>
  usage: (id: ServiceId, force?: boolean) => Promise<UsageReport[]>
  /** Aliax's global pin: what unscoped (terminal) traffic spends from. */
  pinned: (id: ServiceId) => string | null
  owner: () => Owner | null
  vaultPresent: () => boolean
  locked: () => boolean
  /** The live sign-in of a service, for a machine without an Aliax vault. */
  live: (id: ServiceId, force: boolean) => Promise<{ profile: ProfileView; report: UsageReport } | null>
  /** Forced poll of one account, for choosing a failover target. */
  usageOf: (id: ServiceId, name: string) => Promise<UsageReport | null>
  /** Make the next poll of one account skip its TTL. */
  markStale: (id: ServiceId, name: string) => void
  /** Charge a window an error message named, so the account is not picked again before its report refreshes. */
  observeLimit: (id: ServiceId, name: string, limit: Limit) => void
  /** Live threads per account for a provider, from the session registry. */
  load: (provider: AccountProvider) => Record<string, number>
  /** Per provider, the environment new sign-ins are handed to (remote/accountSync.ts). */
  homes: () => Partial<Record<AccountProvider, string>>
  /** The account-sync links to other hosts, by environment id. */
  peers: () => Record<string, PeerState>
  /** What the gateways of every host have seen of each account's rate limits (headroom.ts); null routes the older way. */
  headroom: () => Pick<HeadroomStore, 'summary'> | null
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
/**
 * How long a 401 keeps an account out of routing. The usage cache cannot
 * lift the mark (Aliax's poll of the dead account still reads healthy, and a
 * standby never polls), so the mark lasts this long, one request then tries
 * the account again, and a second 401 marks it again while the gateway
 * replays that request elsewhere. A successful answer lifts it at once.
 */
export const OUT_RETRY_MS = 10 * 60_000
/** A reset further away than this re-arms on the next build instead. */
const RESET_HORIZON_MS = 24 * 3_600_000
/** The most often one socket hears the `accounts` push (index.ts): every
 *  routed answer moves a usage window, and the rows need no more than this. */
export const ACCOUNTS_PUSH_MS = 5_000

/** What a snapshot shows, less the build's own clock: equal digests are the same picture. */
export function snapshotDigest(snap: AccountsSnapshot): string {
  return JSON.stringify({ ...snap, updatedAt: 0 })
}

/**
 * The `accounts` push one socket hears: the newest snapshot, at most once per
 * `everyMs`, and never the one it already has. The first goes out at once; a
 * change inside the window waits for its end and goes out as the newest.
 */
export function accountsPusher(
  send: (snapshot: AccountsSnapshot) => void,
  everyMs = ACCOUNTS_PUSH_MS,
  now: () => number = Date.now
): { offer(snapshot: AccountsSnapshot): void; dispose(): void } {
  let sent: AccountsSnapshot | null = null
  let sentAt = -Infinity
  let pending: AccountsSnapshot | null = null
  let timer: NodeJS.Timeout | null = null
  const flush = (): void => {
    timer = null
    if (!pending || pending === sent) return
    sent = pending
    pending = null
    sentAt = now()
    send(sent)
  }
  return {
    offer(snapshot) {
      if (snapshot === sent) return
      pending = snapshot
      if (timer) return
      const wait = sentAt + everyMs - now()
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait)
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    }
  }
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
      const r = await a.usage(cap.blob, true, force, null)
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
  pinned: pinnedProfile,
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
  load: () => ({}),
  homes: () => ({}),
  peers: () => ({}),
  headroom: () => null,
  dataDir,
  pollMs: 60_000,
  now: Date.now
})

/**
 * The server's view of Aliax's accounts: every saved profile and its usage,
 * plus Aliax's global pin. Rebuilt on demand, on a poll, and whenever Aliax
 * rewrites its settings or usage cache; every rebuild goes to the
 * listeners, which push it to each window. Threads pick their own account
 * from it (routeFor); nothing here moves the global pin.
 */
export class AccountsService {
  /** One-year token mints under way, for the Claude rows (set by aliaxPages.ts; null until then). */
  mint: (() => MintProgress | null) | null = null
  private deps: AccountsDeps
  private snap: AccountsSnapshot = emptyAccounts()
  private built = false
  private listeners = new Set<(snapshot: AccountsSnapshot) => void>()
  private pickableListeners = new Set<(snapshot: AccountsSnapshot) => void>()
  /** The last picture the listeners heard, and the last pickable set. */
  private digest: string | null = null
  private pickable: string | null = null
  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private reset: NodeJS.Timeout | null = null
  private chain: Promise<unknown> = Promise.resolve()
  /** One failover in flight per thread: a limit that fires twice on one turn asks once. */
  private failovers = new Map<string, Promise<Switched | null>>()
  /** Accounts a 401 took out of routing, with when: provider → name → marked at. */
  private out = new Map<AccountProvider, Map<string, number>>()

  constructor(deps: Partial<AccountsDeps> = {}) {
    this.deps = { ...defaults(), ...deps }
  }

  snapshot(): AccountsSnapshot {
    return this.snap
  }

  /** Every rebuild whose picture changed (a usage window moved, a profile
   *  came or went); a rebuild that read the same picture tells nobody. */
  onChange(listener: (snapshot: AccountsSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A rebuild that changed what a thread could be routed to (pickableDigest):
   *  the open threads re-pick then, never on a usage or headroom number. */
  onPickable(listener: (snapshot: AccountsSnapshot) => void): () => void {
    this.pickableListeners.add(listener)
    return () => this.pickableListeners.delete(listener)
  }

  /**
   * What a pick can choose between, per provider: the profiles, the pin, and
   * which accounts are out (a 401 mark, an expired sign-in, a 429 cooldown)
   * or have a window full and not yet reset. Usage percentages and headroom
   * numbers are left out: they move with every answer and only reorder the
   * accounts a pick already had.
   */
  pickableDigest(snap: AccountsSnapshot = this.snap): string {
    const now = this.deps.now()
    const out: Record<string, unknown> = {}
    for (const p of ACCOUNT_PROVIDERS) {
      const v = snap.providers[p]
      out[p] = {
        pinned: v.pinned,
        out: [...this.outFor(p)].sort(),
        throttled: Object.entries(v.headroom ?? {})
          .filter(([, h]) => (h.throttledUntil ?? 0) > now)
          .map(([name]) => name)
          .sort(),
        profiles: v.profiles
          .map((profile) => {
            const report = v.reports.find((r) => r.profileName === profile.name)
            const full = (report?.windows ?? [])
              .filter((w) => w.usedPercent >= 100 && !(w.resetsAt !== undefined && w.resetsAt <= now))
              .map((w) => w.label)
              .sort()
            return [profile.name, !!report?.expired, full]
          })
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      }
    }
    return JSON.stringify(out)
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
   * The account a thread's child spends from at spawn, from the cached
   * snapshot (many subagents may spawn at once; nobody polls here).
   */
  routeFor(meta: SessionMeta, pin: ResolvedPin | null, opts?: RouteOptions): { route: AccountRoute | null; current: string | null } {
    return chooseAccount({
      pin: pin?.name ?? null,
      current: meta.account ?? null,
      stored: meta.account ?? null,
      fresh: opts?.fresh ?? false,
      // The row's last change is the thread's last answer or status: the prompt-cache clock.
      lastActiveAt: meta.updatedAt,
      model: meta.model ?? null,
      provider: meta.provider,
      snapshot: this.snap,
      load: isRoutedProvider(meta.provider) ? (opts?.load ?? this.deps.load(meta.provider)) : {},
      out: isRoutedProvider(meta.provider) ? this.outFor(meta.provider) : [],
      headroom: isRoutedProvider(meta.provider) ? this.headroomFor(meta.provider) : undefined,
      now: this.deps.now()
    })
  }

  /** The gateway's picture of a provider's accounts for a pick, read live (the snapshot's copy is for the rows); undefined routes the older way (no store). */
  private headroomFor(provider: AccountProvider): Record<string, AccountHeadroom> | undefined {
    const store = this.deps.headroom()
    if (!store) return undefined
    return store.summary(SERVICE_OF[provider], this.snap.providers[provider].profiles.map((p) => p.name), this.deps.now())
  }

  /**
   * An account answered 401: its sign-in is dead (the token lapsed and the
   * owner's refresh failed) and no thread should route to it. Returns whether
   * the mark is new, so the caller logs once. The next poll of it skips its
   * TTL, in case the owner can learn more.
   */
  markOut(serviceId: ServiceId, name: string): boolean {
    const provider = PROVIDER_OF[serviceId]
    const marks = this.out.get(provider) ?? new Map<string, number>()
    const fresh = !this.isOut(provider, name)
    marks.set(name, this.deps.now())
    this.out.set(provider, marks)
    if (fresh) this.deps.markStale(serviceId, name)
    return fresh
  }

  /** The account answered: the mark lifts. */
  markAnswered(serviceId: ServiceId, name: string): void {
    this.out.get(PROVIDER_OF[serviceId])?.delete(name)
  }

  isOut(provider: AccountProvider, name: string): boolean {
    const at = this.out.get(provider)?.get(name)
    return at !== undefined && this.deps.now() - at < OUT_RETRY_MS
  }

  /** Accounts out of routing for a provider right now, marks and dead sign-ins the snapshot reports alike. */
  outFor(provider: AccountProvider): string[] {
    const names = new Set<string>()
    for (const [name] of this.out.get(provider) ?? []) if (this.isOut(provider, name)) names.add(name)
    for (const r of this.snap.providers[provider].reports) if (r.expired) names.add(r.profileName)
    return [...names]
  }

  /**
   * The account a scoped request should spend from instead of `account` when
   * that one is out: the best pick for the model with room, the live load
   * counted, as a first spawn would get. Null keeps the request where it is
   * (the account is fine, or nothing else has room: the 401 then surfaces).
   */
  substitute(serviceId: ServiceId, account: string, model: string | null): string | null {
    const provider = PROVIDER_OF[serviceId]
    if (!this.outFor(provider).includes(account)) return null
    const { route } = chooseAccount({
      pin: null,
      current: null,
      model,
      provider,
      snapshot: this.snap,
      load: this.deps.load(provider),
      out: this.outFor(provider),
      headroom: this.headroomFor(provider),
      now: this.deps.now()
    })
    return route && route.account !== account ? route.account : null
  }

  /**
   * The gateway's 429 handler asks for the next account, confirmed by a
   * forced poll. For a thread (`info.thread`) that is one with room in the
   * refused model's windows, soonest reset of the model's own window first.
   * For the pin (unscoped terminal traffic) the same, on the weekly clock.
   * Either way the live load counts, so a failover lands on the emptiest
   * account with room. Null passes the 429 through.
   */
  async pickNext(info: LimitInfo): Promise<string | null> {
    const provider = PROVIDER_OF[info.serviceId]
    const snap = (await this.list()).providers[provider]
    return pickNext({
      serviceId: info.serviceId,
      model: info.model,
      scoped: info.thread !== undefined,
      window: info.limit.window,
      profiles: snap.profiles,
      reports: snap.reports,
      tried: info.tried,
      load: this.deps.load(provider),
      poll: (name) => this.deps.usageOf(info.serviceId, name).catch(() => null),
      now: this.deps.now()
    })
  }

  /**
   * A thread's error named a usage limit the gateway did not replay (no
   * candidate at the time, or the limit came back as text): charge the
   * thread's account, and pick the next account with room for its model.
   * Only that thread moves; the gateway's own pick on its next request
   * reads the same cache and lands on the same account. Null leaves the
   * thread's Continue button alone.
   */
  failover(
    sessionId: string,
    info: { provider: AccountProvider; model: string | null; window: Limit['window']; account: string | null }
  ): Promise<Switched | null> {
    const inflight = this.failovers.get(sessionId)
    if (inflight) return inflight
    const run = this.runFailover(sessionId, info).finally(() => {
      this.failovers.delete(sessionId)
    })
    this.failovers.set(sessionId, run)
    return run
  }

  private async runFailover(
    sessionId: string,
    info: { provider: AccountProvider; model: string | null; window: Limit['window']; account: string | null }
  ): Promise<Switched | null> {
    if (info.window === 'transient') return null
    const id = SERVICE_OF[info.provider]
    // An unscoped thread (an owner too old for scoped routes) spent from the pin.
    const from = info.account ?? this.deps.pinned(id)
    if (!from) return null
    this.deps.observeLimit(id, from, { window: info.window })
    const to = await this.pickNext({
      service: info.provider,
      serviceId: id,
      model: info.model,
      limit: { window: info.window },
      tried: [from],
      account: from,
      thread: sessionId
    })
    return to ? { from, to } : null
  }

  async list(): Promise<AccountsSnapshot> {
    if (!this.built) await this.rebuild(false)
    return this.snap
  }

  /** A profile was deleted: rebuild now, no debounce, so nothing routes to it meanwhile. */
  rebuildNow(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    return this.rebuild(false)
  }

  /** The user's Refresh: force a poll (forwarded to the owner when standby). */
  async refresh(provider: AccountProvider): Promise<AccountsSnapshot> {
    await this.rebuild(true, provider)
    return this.snap
  }

  /** Rebuilds run one at a time; a forced one only forces its provider. */
  private rebuild(force: boolean, only?: AccountProvider): Promise<void> {
    const run = this.chain.then(() => this.build(force, only)).then((snap) => {
      this.snap = snap
      this.built = true
      this.armReset()
      // Every routed answer nudges a rebuild; only a changed picture is news.
      const digest = snapshotDigest(snap)
      if (digest !== this.digest) {
        this.digest = digest
        for (const l of this.listeners) l(snap)
      }
      const pickable = this.pickableDigest(snap)
      if (pickable !== this.pickable) {
        this.pickable = pickable
        for (const l of this.pickableListeners) l(snap)
      }
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
      return { updatedAt: Date.now(), providers, homes: d.homes(), peers: d.peers() }
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
      const headroom = d.headroom()
      providers[p] = {
        pinned: d.pinned(id) ?? profiles.find((x) => x.active)?.name ?? null,
        profiles,
        reports,
        owner,
        note: note ?? view?.notice,
        ...(p === 'claude' ? { mint: this.mint?.() ?? undefined } : {}),
        ...(headroom && profiles.length ? { headroom: headroom.summary(id, profiles.map((x) => x.name), d.now()) } : {})
      }
    }
    return { updatedAt: Date.now(), providers, homes: d.homes(), peers: d.peers() }
  }
}
