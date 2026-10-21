import { accounts as coreAccounts, adapter, pinProfile, vault, withLock, type Hooks, type ServiceId } from 'aliax-core'
import type { SaveOrigin } from 'aliax-core/config'
import { liveKeychain } from 'aliax-core/adapters/claude'
import {
  accessExpiry,
  applyTransfer,
  isProvisional,
  beginHandoff,
  claimHandoff,
  clearReleased,
  exportAccount,
  hasRefresh,
  markSynced,
  ownsProfile,
  refreshFingerprint,
  stripRefresh,
  type ApplyOutcome,
  type Handoff,
  type Transfer,
  type TransferProfile
} from 'aliax-core/sync'
import { ACCOUNT_PROVIDERS, PROVIDER_OF, type AccountProvider, type AccountRemoval, type ListedAccount } from '@shared/accounts'
import type { ServerPush } from '@shared/contract'
import type { PeerLink, Peers } from './peers'
import type { HeadroomSnapshot, HeadroomStore } from '../headroom'

/**
 * Accounts shared between this host and the ones it holds admin keys for
 * (thread V), on top of aliax-core's ownership rules (sync.ts):
 *  - as a host, it answers `accounts.push` (a handoff, saved provisionally
 *    until the sender says it stripped its copy, or an access-only copy from
 *    an owner) and `accounts.pull` (every account this host owns or holds
 *    statically, access-only; with `takeOver`, the full grant for the
 *    caller, held out under the profile's lock until the caller confirms it
 *    saved it, `accounts.confirm`, after which this host keeps an
 *    access-only copy; no word in time and this host keeps the grant). A
 *    socket that pulled gets every later rotation as an `account` push, so
 *    another host's main process stays current without asking; renderers
 *    never pull and never see a credential.
 *  - as a client of its peers (remote/peers.ts), it syncs on connect, on
 *    every local vault write, and on request: it pulls what the peer
 *    shares, settles what is half done (a grant the peer handed it that it
 *    has not confirmed, a grant it handed the peer that it has not told it
 *    about), then pushes what it owns, handing a grant off outright when
 *    the peer is its provider's home and the grant is not the one the CLI
 *    on this machine is signed in with (that one the CLI keeps refreshing;
 *    a fresh sign-in mints a grant for the box instead). A handoff strips
 *    this side only on an answer that echoes the fingerprint of the
 *    refresh token it sent, and the peer makes itself the owner on
 *    `accounts.released`.
 *  - what a peer sends unasked (an `account` push) or in answer to a pull
 *    lands only for an account already on file here: a host accepts account
 *    state only for accounts it paired or owns.
 *  - a consumer copy near its end asks its owner (aliax-core's askOwner)
 *    over the owner's link; an owner out of reach means the copy runs out
 *    and the Accounts page says so.
 *  - removals follow the owner (deleteProfile, prune). Every pull answer
 *    carries the sender's whole file (`listed`) and its tombstones, and a
 *    deletion is also pushed at once (`accounts.removed` over the links,
 *    the `accounts-removed` push to sockets that pulled). The tombstone
 *    rule: a host that deletes a profile it refreshes or a static token
 *    keeps a tombstone (service, account id, when) in its settings for
 *    TOMBSTONE_TTL_MS, dropped the moment a profile of that account is
 *    saved here again. A peer deletes an access-only copy whose owner is
 *    the sender when the sender's list no longer has the account: the
 *    owner's file is the whole truth about what it refreshes. A static
 *    one-year token (no owner, every host holds one) is deleted only when
 *    a tombstone names it: absence from one host's list proves nothing,
 *    since that host may simply not have received it yet. Never deleted on
 *    a peer's word: a profile this host refreshes, the one its CLI is
 *    signed in with (Claude's Keychain item or credentials file, Codex's
 *    auth.json), or a provisional copy (a handoff in flight). Each deletion
 *    rebuilds the accounts snapshot at once (`refreshNow`), so the gateway
 *    and the routing stop naming the account before the next turn.
 */

const SERVICES: ServiceId[] = ['claude-code', 'codex', 'cursor']
/** Settings row per provider: the environment new sign-ins are handed to. */
export const HOME_PREFIX = 'accounts.home.'
const PUSH_DEBOUNCE_MS = 1_000
/** How often each host pushes its headroom picture to its peers; a 429 pushes at once (debounced). */
export const HEADROOM_PUSH_MS = 30_000
const HEADROOM_DEBOUNCE_MS = 1_000
/** How long a grant handed out on a pull waits for the taker's confirm before this host keeps it. */
export const RELEASE_TIMEOUT_MS = 30_000
/** Settings row holding this host's tombstones (AccountRemoval[]). */
export const TOMBSTONES_KEY = 'accounts.tombstones'
/** How long a tombstone is kept and sent. */
export const TOMBSTONE_TTL_MS = 30 * 86_400_000

export interface AccountSyncDeps {
  environmentId: string
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  /** The accounts snapshot changed under us: rebuild and push it. */
  nudge: () => void
  /** A profile is gone: rebuild the snapshot now, before anything else routes to it. Falls back to nudge. */
  refreshNow?: () => Promise<void> | void
  /** The gateway's rate-limit picture (headroom.ts); shared with every peer so both hosts route from the same one. */
  headroom?: Pick<HeadroomStore, 'own' | 'merge'>
  /** Test seam: the headroom push cadence. */
  headroomPushMs?: number
  log?: (line: string) => void
  now?: () => number
  /** Test seams for the live sign-in: who the CLI here is signed in as, when its credential lapses, and installing a blob as that sign-in. */
  liveAccountId?: (service: ServiceId) => Promise<string | null>
  liveExpiry?: (service: ServiceId) => Promise<number | null>
  activate?: (service: ServiceId, name: string, blob: string) => Promise<void>
  /** Test seam: the release timeout. */
  releaseTimeoutMs?: number
}

export interface PullAnswer {
  transfers: Transfer[]
  /** The sender's whole file for the services asked (absent from a host too old to send it). */
  listed?: ListedAccount[]
  /** The sender's tombstones (absent from a host too old to send them). */
  tombstones?: AccountRemoval[]
}

export type DeleteAnswer = { ok: true; removal: AccountRemoval } | { ok: false; error: string }
export interface HeadroomAnswer {
  /** The answering host's own picture; null when it keeps none (an older host). */
  snapshot: HeadroomSnapshot | null
}

export interface ConfirmParams {
  service: ServiceId
  accountId: string
  refreshFingerprint: string
}

export type ConfirmAnswer = { ok: true } | { ok: false; reason: 'unknown-account' | 'not-released' | 'fingerprint' }
export type ReleasedAnswer = { ok: true } | { ok: false; reason: 'unknown-account' | 'not-held' }

type PendingRelease = { handoff: Handoff; to: string; name: string; timer: NodeJS.Timeout }

export class AccountSync {
  private readonly subscribers = new Set<(push: ServerPush) => void>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly syncing = new Map<string, Promise<void>>()
  /** Grants handed out on a takeOver pull, by `service:accountId`, until the taker confirms or the timeout. */
  private readonly pending = new Map<string, PendingRelease>()
  private headroomTimer: NodeJS.Timeout | null = null
  private headroomSoon: NodeJS.Timeout | null = null

  constructor(private readonly deps: AccountSyncDeps) {
    if (deps.headroom) {
      this.headroomTimer = setInterval(() => void this.pushHeadroom(), deps.headroomPushMs ?? HEADROOM_PUSH_MS)
      this.headroomTimer.unref()
    }
  }

  private get me(): string {
    return this.deps.environmentId
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[accounts-sync] ${l}`)))(line)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Per provider, the environment new sign-ins are handed to; absent means this machine. */
  homes(): Partial<Record<AccountProvider, string>> {
    const out: Partial<Record<AccountProvider, string>> = {}
    for (const p of ACCOUNT_PROVIDERS) {
      const v = this.deps.store.getSetting(`${HOME_PREFIX}${p}`)
      if (v && v !== this.me) out[p] = v
    }
    return out
  }

  /**
   * Move a provider's home. To another host: every grant this machine
   * holds for it (and is not the CLI's own) goes there on the next sync.
   * Back to this machine: every grant that host owns is taken back.
   */
  async setHome(provider: AccountProvider, environmentId: string | null): Promise<void> {
    const was = this.homes()[provider]
    const next = environmentId && environmentId !== this.me ? environmentId : null
    this.deps.store.setSetting(`${HOME_PREFIX}${provider}`, next)
    this.deps.nudge()
    if (!next && was) {
      const service = ({ claude: 'claude-code', codex: 'codex', cursor: 'cursor' } as const)[provider]
      for (const p of vault.profiles(service)) {
        if (p.owner !== was || p.static) continue
        // takeOver says what became of it; a grant left provisional settles on the sync below.
        await this.takeOver(service, p.name, was).catch((err) => this.log(`${service} ${p.name}: could not take over from ${was} (${(err as Error).message})`))
      }
    }
    await this.syncAll()
  }

  // ── this host, asked by another host's main process ────────────────────

  /** The row a transfer would land on, for the lock: the account's existing name, else the sender's. */
  private storedNameFor(service: ServiceId, profile: TransferProfile): string {
    const list = vault.profiles(service)
    const match = list.find((p) => p.accountId === profile.accountId) ?? (profile.email ? list.find((p) => p.email?.toLowerCase() === profile.email!.toLowerCase()) : undefined)
    return match?.name ?? profile.name
  }

  async handlePush(from: string, t: Transfer): Promise<ApplyOutcome> {
    // A handoff waits for any refresh in flight here (a copy asking its owner) before it lands.
    const out = t.mode === 'handoff' ? await withLock(t.service, this.storedNameFor(t.service, t.profile), async () => applyTransfer(t, from)) : applyTransfer(t, from)
    if (!out.ok) {
      this.log(`${t.service} ${t.profile.name}: ${t.mode} from ${from} refused (${out.reason})`)
      return out
    }
    if (out.saved) {
      this.forgetTombstone(t.service, t.profile.accountId)
      this.log(`${t.service} ${out.name}: ${t.profile.static ? 'static token' : t.mode} from ${from} landed${t.mode === 'handoff' ? ', waiting for its word' : ''}`)
      // A grant handed over becomes the live sign-in once the sender has stripped its copy (handleReleased).
      if (t.mode !== 'handoff') void this.activateIfNothingLive(t.service, out.name, t.profile.static)
    }
    this.deps.nudge()
    return out
  }

  /**
   * A peer's headroom picture (`accounts.headroom`): what its gateway saw of
   * each account. Merged under its id; the answer carries ours, so one
   * request a way keeps both hosts routing from the same picture. A new
   * throttle in it re-picks here as if our own gateway had seen it.
   */
  handleHeadroom(from: string, snapshot: HeadroomSnapshot | null | undefined): HeadroomAnswer {
    const store = this.deps.headroom
    if (!store) return { snapshot: null }
    if (store.merge(from, snapshot)) this.deps.nudge()
    return { snapshot: store.own() }
  }

  /** A 429 landed here: every peer hears of it within a second. */
  pushHeadroomSoon(): void {
    if (!this.deps.headroom || this.headroomSoon) return
    this.headroomSoon = setTimeout(() => {
      this.headroomSoon = null
      void this.pushHeadroom()
    }, HEADROOM_DEBOUNCE_MS)
    this.headroomSoon.unref()
  }

  /** Push this host's picture to every connected peer and take theirs from the answers. */
  async pushHeadroom(environmentId?: string): Promise<void> {
    const store = this.deps.headroom
    if (!store) return
    const links = environmentId ? [this.deps.peers.get(environmentId)] : this.deps.peers.all()
    await Promise.all(
      links.map(async (link) => {
        if (!link?.connected) return
        try {
          const answer = await link.request<HeadroomAnswer>('accounts.headroom', { from: this.me, snapshot: store.own() })
          if (store.merge(link.id, answer?.snapshot)) this.deps.nudge()
        } catch (err) {
          this.log(`${link.env.name}: headroom not shared (${(err as Error).message})`)
        }
      })
    )
  }

  async handlePull(from: string, params: { service?: ServiceId; name?: string; takeOver?: boolean }): Promise<PullAnswer> {
    const transfers: Transfer[] = []
    for (const service of params.service ? [params.service] : SERVICES) {
      for (const p of vault.profiles(service)) {
        if (params.name && p.name !== params.name) continue
        try {
          if (params.takeOver && params.name) {
            if (p.static || !ownsProfile(p)) continue
            transfers.push(await this.handOut(service, p.name, p.accountId, from))
            this.log(`${service} ${p.name}: handed out to ${from}, waiting for its word`)
          } else if (p.static || ownsProfile(p)) {
            transfers.push(exportAccount(service, p.name, 'access'))
          }
        } catch (err) {
          this.log(`${service} ${p.name}: not shared (${(err as Error).message})`)
        }
      }
    }
    return { transfers, listed: this.listed(params.service ? [params.service] : SERVICES), tombstones: this.tombstones() }
  }

  /** Every profile on file here for the services, with its owner: what a peer prunes against. */
  listed(services: ServiceId[] = SERVICES): ListedAccount[] {
    const out: ListedAccount[] = []
    for (const service of services) {
      for (const p of vault.profiles(service)) out.push({ service, accountId: p.accountId, name: p.name, static: p.static === true, owner: p.static ? null : (p.owner ?? this.me) })
    }
    return out
  }

  // ── removals ───────────────────────────────────────────────────────────

  /** This host's tombstones, the expired ones dropped. */
  tombstones(): AccountRemoval[] {
    const raw = this.deps.store.getSetting(TOMBSTONES_KEY)
    if (!raw) return []
    let rows: AccountRemoval[]
    try {
      rows = JSON.parse(raw) as AccountRemoval[]
    } catch {
      return []
    }
    const cutoff = this.now() - TOMBSTONE_TTL_MS
    return rows.filter((t) => t && typeof t.at === 'number' && t.at > cutoff)
  }

  private saveTombstones(rows: AccountRemoval[]): void {
    this.deps.store.setSetting(TOMBSTONES_KEY, rows.length ? JSON.stringify(rows) : null)
  }

  private recordTombstone(t: AccountRemoval): void {
    this.saveTombstones([...this.tombstones().filter((x) => !(x.service === t.service && x.accountId === t.accountId)), t])
  }

  /** A profile of the account is on file here again: its tombstone is void. */
  private forgetTombstone(service: ServiceId, accountId: string): void {
    const rows = this.tombstones()
    const kept = rows.filter((x) => !(x.service === service && x.accountId === accountId))
    if (kept.length !== rows.length) this.saveTombstones(kept)
  }

  /**
   * Delete a saved profile here (the Accounts page's Remove, `accounts.delete`).
   * The vault row goes, the snapshot rebuilds at once, and every peer hears:
   * over the links as `accounts.removed`, to the sockets that pulled as an
   * `accounts-removed` push. A profile this host refreshed, or a static
   * token, leaves a tombstone for the hosts that are not connected now.
   */
  async deleteProfile(service: ServiceId, name: string): Promise<DeleteAnswer> {
    const p = vault.profiles(service).find((x) => x.name === name)
    if (!p) return { ok: false, error: `no ${service} profile named ${name}` }
    const removal: AccountRemoval = { service, accountId: p.accountId, name, static: p.static === true, at: this.now() }
    vault.deleteProfile(service, name)
    coreAccounts.clearUsageCache(service)
    if (p.static || ownsProfile(p)) this.recordTombstone(removal)
    this.log(`${service} ${name}: deleted here${p.static ? ' (static token)' : ownsProfile(p) ? '' : ` (a copy refreshed by ${p.owner})`}`)
    await this.refreshNow()
    void this.broadcastRemoved([removal])
    return { ok: true, removal }
  }

  private async refreshNow(): Promise<void> {
    try {
      if (this.deps.refreshNow) await this.deps.refreshNow()
      else this.deps.nudge()
    } catch (err) {
      this.log(`snapshot did not rebuild (${(err as Error).message})`)
      this.deps.nudge()
    }
  }

  private async broadcastRemoved(removed: AccountRemoval[]): Promise<void> {
    for (const send of this.subscribers) {
      try {
        send({ push: 'accounts-removed', from: this.me, removed })
      } catch {
        // a socket on its way out
      }
    }
    for (const link of this.deps.peers.all()) {
      if (!link.connected) continue
      await link.request('accounts.removed', { from: this.me, removed }).catch((err) => this.log(`${link.env.name}: did not hear the removal (${(err as Error).message}); its next sync prunes`))
    }
  }

  /** A peer deleted profiles: prune what its word covers. */
  async handleRemoved(from: string, params: { removed: AccountRemoval[] }): Promise<{ dropped: number }> {
    const dropped = await this.prune(from, undefined, params.removed)
    this.deps.nudge()
    return { dropped }
  }

  /**
   * Drop what `from`'s word no longer supports (the tombstone rule in the
   * module comment): an access-only copy refreshed by `from` that its list
   * omits or a tombstone names, and a static token a tombstone names. Never
   * a profile this host refreshes, its CLI's sign-in, or a provisional copy.
   * Returns how many went; the snapshot rebuilds at once when any did.
   */
  async prune(from: string, listed: ListedAccount[] | undefined, tombstones: AccountRemoval[] | undefined): Promise<number> {
    if (!listed && !tombstones) return 0
    // A peer's tombstone is read on the same clock as this host's own.
    const cutoff = this.now() - TOMBSTONE_TTL_MS
    tombstones = tombstones?.filter((t) => typeof t.at === 'number' && t.at > cutoff)
    let dropped = 0
    for (const service of SERVICES) {
      const profiles = vault.profiles(service)
      if (profiles.length === 0) continue
      const live = await (this.deps.liveAccountId ?? ((s: ServiceId) => adapter(s).liveAccountId()))(service).catch(() => null)
      for (const p of profiles) {
        const tomb = tombstones?.find((t) => t.service === service && t.accountId === p.accountId)
        let why: string | null = null
        if (p.static) {
          if (tomb) why = `its token was removed on ${from}`
        } else if (p.owner === from && !ownsProfile(p)) {
          if (tomb) why = `removed on ${from}, which refreshed it`
          else if (listed && !listed.some((l) => l.service === service && l.accountId === p.accountId)) why = `no longer on ${from}, which refreshed it`
        }
        if (!why) continue
        const keep = ownsProfile(p) ? 'refreshed here' : live !== null && live === p.accountId ? "the CLI's sign-in here" : isProvisional(service, p) ? 'a handoff in flight' : null
        if (keep) {
          this.log(`${service} ${p.name}: ${why}; kept (${keep})`)
          continue
        }
        vault.deleteProfile(service, p.name)
        coreAccounts.clearUsageCache(service)
        dropped++
        this.log(`${service} ${p.name}: ${why}; deleted here`)
      }
    }
    if (dropped) await this.refreshNow()
    return dropped
  }

  /** Export the full grant for `to` under the profile's lock and keep it pending until `to` confirms or the timeout. */
  private async handOut(service: ServiceId, name: string, accountId: string, to: string): Promise<Transfer> {
    const key = `${service}:${accountId}`
    this.dropPending(key, 'handed out again')
    const handoff = await beginHandoff(service, name, to)
    const timer = setTimeout(() => {
      if (this.pending.get(key)?.handoff !== handoff) return
      this.pending.delete(key)
      handoff.abort()
      this.log(`${service} ${name}: no word from ${to}; still refreshed here`)
      this.deps.nudge()
    }, this.deps.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS)
    timer.unref()
    this.pending.set(key, { handoff, to, name, timer })
    return handoff.transfer
  }

  private dropPending(key: string, why: string): void {
    const prior = this.pending.get(key)
    if (!prior) return
    clearTimeout(prior.timer)
    this.pending.delete(key)
    prior.handoff.abort()
    this.log(`${key}: the grant handed out to ${prior.to} is kept (${why})`)
  }

  /** The taker says it saved the grant with this fingerprint: strip here, or say what happened to it. */
  handleConfirm(from: string, params: ConfirmParams): ConfirmAnswer {
    const key = `${params.service}:${params.accountId}`
    const pending = this.pending.get(key)
    if (pending && pending.to === from) {
      if (pending.handoff.fingerprint !== params.refreshFingerprint) {
        this.log(`${params.service} ${pending.name}: ${from} confirmed another grant than the one handed out; still waiting`)
        return { ok: false, reason: 'fingerprint' }
      }
      clearTimeout(pending.timer)
      this.pending.delete(key)
      pending.handoff.commit()
      // The taker told us itself: nothing to tell it.
      clearReleased(params.service, pending.name)
      this.log(`${params.service} ${pending.name}: now refreshed by ${from}, access-only here`)
      this.deps.nudge()
      return { ok: true }
    }
    const p = vault.profiles(params.service).find((x) => x.accountId === params.accountId)
    if (!p) return { ok: false, reason: 'unknown-account' }
    if (!p.static && p.owner === from && !this.holdsRefresh(params.service, p.name)) {
      clearReleased(params.service, p.name)
      return { ok: true }
    }
    return { ok: false, reason: 'not-released' }
  }

  /** The sender of a handoff stripped its copy: the grant held here provisionally is this host's to refresh. */
  handleReleased(from: string, params: { service: ServiceId; accountId: string }): ReleasedAnswer {
    const p = vault.profiles(params.service).find((x) => x.accountId === params.accountId)
    if (!p) return { ok: false, reason: 'unknown-account' }
    const was = ownsProfile(p)
    if (!claimHandoff(params.service, p.name, from)) return { ok: false, reason: 'not-held' }
    if (!was) {
      this.log(`${params.service} ${p.name}: ${from} released it; refreshed here now`)
      void this.activateIfNothingLive(params.service, p.name, false)
      this.deps.nudge()
    }
    return { ok: true }
  }

  private holdsRefresh(service: ServiceId, name: string): boolean {
    try {
      const stored = vault.readSecret(service, name)
      return stored !== null && hasRefresh(service, stored)
    } catch {
      return false
    }
  }

  /** A socket that pulled hears every later rotation of what this host owns. */
  subscribe(send: (push: ServerPush) => void): () => void {
    this.subscribers.add(send)
    return () => this.subscribers.delete(send)
  }

  // ── this host as a client of its peers ─────────────────────────────────

  async syncAll(): Promise<void> {
    await Promise.all(this.deps.peers.all().map((l) => this.syncWith(l.id)))
  }

  syncWith(environmentId: string): Promise<void> {
    const running = this.syncing.get(environmentId)
    if (running) return running
    const run = this.runSync(environmentId).finally(() => this.syncing.delete(environmentId))
    this.syncing.set(environmentId, run)
    return run
  }

  private async runSync(environmentId: string): Promise<void> {
    const link = this.deps.peers.get(environmentId)
    if (!link?.connected) return
    try {
      // What the host owns or holds statically, for us: only accounts already on file here.
      const { transfers, listed, tombstones } = await link.request<PullAnswer>('accounts.pull', { from: this.me })
      let landed = 0
      for (const t of transfers) {
        const out = applyTransfer(t, link.id, 'peer')
        if (out.ok && out.saved) landed++
        else if (!out.ok) this.log(`${t.service} ${t.profile.name} from ${link.env.name}: refused (${out.reason})`)
      }
      // What the host no longer has, this host drops (the tombstone rule).
      const dropped = await this.prune(link.id, listed, tombstones)
      await this.settle(link)
      // What we own or hold statically, for the host.
      let sent = 0
      for (const service of SERVICES) {
        for (const p of vault.profiles(service)) if (await this.pushOne(link, service, p.name)) sent++
      }
      link.lastSyncAt = this.now()
      link.lastError = null
      if (landed || sent || dropped) this.log(`${link.env.name}: ${landed} landed, ${sent} sent, ${dropped} dropped`)
    } catch (err) {
      link.lastError = (err as Error).message
      this.log(`${link.env.name}: sync failed (${link.lastError})`)
    }
    this.deps.nudge()
  }

  /**
   * Finish what an earlier exchange with this peer left half done. A grant
   * the peer handed this host that this host has not confirmed (a refresh
   * token on file under the peer's name): ask the peer to settle it, and
   * make this host the owner on ok, else drop back to an access-only copy.
   * A grant this host handed the peer and has not told it about: tell it.
   */
  private async settle(link: PeerLink): Promise<void> {
    for (const service of SERVICES) {
      for (const p of vault.profiles(service)) {
        if (p.static || p.owner !== link.id) continue
        try {
          if (this.holdsRefresh(service, p.name)) await this.confirmWith(link, service, p.name, p.accountId)
          else if (p.releasedAt !== undefined) await this.tellReleased(link, service, p.name, p.accountId)
        } catch (err) {
          this.log(`${service} ${p.name}: ${link.env.name} did not settle it (${(err as Error).message})`)
        }
      }
    }
  }

  /** The taker's confirm: on ok the grant is this host's; otherwise the owner kept it and the copy here is stripped. */
  private async confirmWith(link: PeerLink, service: ServiceId, name: string, accountId: string): Promise<boolean> {
    const stored = vault.readSecret(service, name)
    const fingerprint = stored ? refreshFingerprint(service, stored) : null
    if (!stored || !fingerprint) return false
    const word = await link.request<ConfirmAnswer>('accounts.confirm', { from: this.me, service, accountId, refreshFingerprint: fingerprint })
    if (word.ok) {
      claimHandoff(service, name, link.id)
      this.log(`${service} ${name}: refreshed here now`)
      void this.activateIfNothingLive(service, name, false)
      this.deps.nudge()
      return true
    }
    const p = vault.profiles(service).find((x) => x.name === name)
    vault.saveSecret(service, name, stripRefresh(service, stored), 'sync')
    if (p) vault.upsertProfile(service, { ...p, owner: link.id, syncedAt: this.now() })
    this.log(`${service} ${name}: ${link.env.name} kept the grant (${word.reason}); access-only here`)
    this.deps.nudge()
    return false
  }

  /** The sender's last word after a handoff: the peer makes itself the owner. */
  private async tellReleased(link: PeerLink, service: ServiceId, name: string, accountId: string): Promise<void> {
    const word = await link.request<ReleasedAnswer>('accounts.released', { from: this.me, service, accountId })
    if (word.ok) {
      clearReleased(service, name)
      return
    }
    // Nothing on the other side to release to: no host holds the refresh token; only a new sign-in mends that.
    clearReleased(service, name)
    this.log(`${service} ${name}: ${link.env.name} holds no grant to take over (${word.reason}); sign the account in again`)
  }

  /**
   * One profile to one host: a handoff when the host is the provider's home
   * and this machine holds a grant the CLI here is not signed in with, else
   * an access copy. Returns whether anything was sent.
   */
  private async pushOne(link: PeerLink, service: ServiceId, name: string): Promise<boolean> {
    const p = vault.profiles(service).find((x) => x.name === name)
    if (!p || (!p.static && !ownsProfile(p))) return false
    let stored: string | null
    try {
      stored = vault.readSecret(service, name)
    } catch {
      return false
    }
    if (!stored) return false
    const home = this.homes()[PROVIDER_OF[service]]
    const wantsHandoff = !p.static && home === link.id && hasRefresh(service, stored)
    if (wantsHandoff && (await this.liveLineage(service, stored))) this.log(`${service} ${name}: the sign-in here, or one that cannot be told apart; access copy only`)
    const handoff = wantsHandoff && !(await this.liveLineage(service, stored))
    if (!handoff) {
      const transfer = exportAccount(service, name, 'access')
      const out = await link.request<ApplyOutcome>('accounts.push', { from: this.me, transfer })
      if (!out.ok) {
        this.log(`${service} ${name} → ${link.env.name}: refused (${out.reason})`)
        return false
      }
      markSynced(service, name)
      return true
    }
    // The lock is held from the export to commit or abort: no refresh rotates the token meanwhile.
    const h = await beginHandoff(service, name, link.id)
    let out: ApplyOutcome
    try {
      out = await link.request<ApplyOutcome>('accounts.push', { from: this.me, transfer: h.transfer })
    } catch (err) {
      h.abort()
      throw err
    }
    if (!out.ok) {
      h.abort()
      this.log(`${service} ${name} → ${link.env.name}: refused (${out.reason})`)
      return false
    }
    if (out.refreshFingerprint !== h.fingerprint) {
      h.abort()
      this.log(`${service} ${name} → ${link.env.name}: it holds another grant for the account; this one stays here`)
      return false
    }
    h.commit()
    this.log(`${service} ${name}: now refreshed by ${link.env.name}`)
    await this.tellReleased(link, service, name, p.accountId).catch((err) => this.log(`${service} ${name}: ${link.env.name} did not hear the release (${(err as Error).message}); told again on the next sync`))
    return true
  }

  /**
   * Whether the stored grant is the one the CLI on this machine is signed
   * in with. Handing that off would let the CLI's own refresh revoke it under
   * the new owner; the user adds the account again to mint one for the box.
   * A service whose adapter cannot fingerprint grants (Cursor: the IDE keeps
   * its own tokens) counts as live, since it cannot be ruled out.
   */
  async liveLineage(service: ServiceId, stored: string): Promise<boolean> {
    const a = adapter(service)
    if (!a.fingerprintOf || !a.liveFingerprint) return true
    const mine = a.fingerprintOf(stored)
    if (mine === null) return false
    const live = await a.liveFingerprint().catch(() => null)
    return live !== null && mine === live
  }

  /** aliax-core's onSecretSaved: a write of this machine's own goes to every peer and every subscriber, debounced per profile. */
  onSecretSaved: NonNullable<Hooks['onSecretSaved']> = (serviceId: ServiceId, name: string, origin: SaveOrigin): void => {
    if (origin !== 'local') return
    const key = `${serviceId}:${name}`
    const prior = this.timers.get(key)
    if (prior) clearTimeout(prior)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      void this.broadcast(serviceId, name)
    }, PUSH_DEBOUNCE_MS)
    timer.unref()
    this.timers.set(key, timer)
  }

  private async broadcast(service: ServiceId, name: string): Promise<void> {
    const p = vault.profiles(service).find((x) => x.name === name)
    if (p) this.forgetTombstone(service, p.accountId)
    if (!p || (!p.static && !ownsProfile(p))) return
    if (this.subscribers.size > 0) {
      try {
        const transfer = exportAccount(service, name, 'access')
        for (const send of this.subscribers) send({ push: 'account', from: this.me, transfer })
      } catch (err) {
        this.log(`${service} ${name}: not pushed (${(err as Error).message})`)
      }
    }
    for (const link of this.deps.peers.all()) {
      if (!link.connected) continue
      await this.pushOne(link, service, name).catch((err) => this.log(`${service} ${name} → ${link.env.name}: ${(err as Error).message}`))
    }
  }

  /** An `account` push from a peer: its owner rotated. Only an account already on file here, and only from its owner. */
  onPeerPush = (from: string, push: ServerPush): void => {
    if (push.push === 'accounts-removed') {
      void this.handleRemoved(from, { removed: push.removed })
      return
    }
    if (push.push !== 'account') return
    const out = applyTransfer(push.transfer, from, 'peer')
    if (out.ok && out.saved) {
      this.log(`${push.transfer.service} ${out.name}: rotation from ${from} landed`)
      this.deps.nudge()
    } else if (!out.ok) {
      this.log(
        out.reason === 'unknown-account'
          ? `${push.transfer.service} ${push.transfer.profile.name}: ${from} pushed an account this host never had; refused`
          : `${push.transfer.service} ${push.transfer.profile.name}: rotation from ${from} refused (${out.reason})`
      )
    }
  }

  /** aliax-core's askOwner: a consumer copy near its end asks its owner over our link. */
  askOwner: NonNullable<Hooks['askOwner']> = async (serviceId: ServiceId, name: string, owner: string): Promise<string | null> => {
    const link = this.deps.peers.get(owner)
    if (!link?.connected) return null
    try {
      const { transfers } = await link.request<PullAnswer>('accounts.pull', { from: this.me, service: serviceId, name })
      let landed: string | null = null
      for (const t of transfers) {
        const out = applyTransfer(t, owner, 'peer')
        if (out.ok && t.service === serviceId) landed = out.name
      }
      if (!landed) return null
      this.deps.nudge()
      return vault.readSecret(serviceId, landed)
    } catch (err) {
      this.log(`${serviceId} ${name}: ${link.env.name} did not answer (${(err as Error).message})`)
      return null
    }
  }

  /**
   * Take a grant back from its owner (the home moved here): pull it, save it
   * provisionally, confirm with its fingerprint, and own it on the owner's
   * ok. No answer leaves the copy provisional until the next sync settles
   * it; a refusal means the owner kept it and the copy here is stripped.
   */
  async takeOver(service: ServiceId, name: string, from: string): Promise<ApplyOutcome | null> {
    const link = this.deps.peers.get(from)
    if (!link?.connected) return null
    return withLock(service, name, async () => {
      const { transfers } = await link.request<PullAnswer>('accounts.pull', { from: this.me, service, name, takeOver: true })
      const t = transfers[0]
      if (!t) return null
      const out = applyTransfer(t, from, 'peer')
      this.deps.nudge()
      if (!out.ok) {
        this.log(`${service} ${name}: the grant from ${link.env.name} did not land (${out.reason})`)
        return out
      }
      if (!out.refreshFingerprint) return out
      try {
        await this.confirmWith(link, service, out.name, t.profile.accountId)
      } catch (err) {
        this.log(`${service} ${name}: ${link.env.name} did not answer the confirm (${(err as Error).message}); settled on the next sync`)
      }
      return out
    })
  }

  /**
   * For the one-year token mint (aliax/staticTokens.ts): the grant back from
   * the host that refreshes it, over the takeOver pull above. Null once this
   * host holds it; otherwise why not, naming the host, for the row.
   */
  async takeBack(service: ServiceId, name: string, owner: string): Promise<string | null> {
    const link = this.deps.peers.get(owner)
    const host = link?.env.name ?? owner
    if (!link?.connected) return `${host}, which refreshes the grant, is not connected`
    try {
      const out = await this.takeOver(service, name, owner)
      const p = vault.profiles(service).find((x) => x.name === name)
      if (p && ownsProfile(p) && this.holdsRefresh(service, name)) return null
      if (p && !p.static && this.holdsRefresh(service, name)) return `${host} has not released the grant yet`
      return `${host} kept the grant${out && !out.ok ? ` (${out.reason})` : ''}`
    } catch (err) {
      return `${host} did not hand the grant back (${(err as Error).message})`
    }
  }

  /**
   * A host with no live sign-in for a service (the box) makes what it was
   * given the live one, so its CLI children can start; a static token
   * replaces a live copy that is only a consumer's (it lapses when the owner
   * is away), and a renewed static token replaces the older one of the same
   * account that is live, so the sign-in follows the renewal. A sign-in this
   * machine refreshes itself, and a static token of another account, are
   * never replaced.
   */
  private async activateIfNothingLive(service: ServiceId, name: string, isStatic: boolean): Promise<void> {
    const a = adapter(service)
    if (!a.detect()) return
    const liveId = await (this.deps.liveAccountId ?? ((s: ServiceId) => adapter(s).liveAccountId()))(service).catch(() => null)
    let blob: string | null
    try {
      blob = vault.readSecret(service, name)
    } catch {
      return
    }
    if (!blob) return
    if (liveId) {
      if (!isStatic) return
      const live = vault.profiles(service).find((p) => p.accountId === liveId)
      if (!live || ownsProfile(live)) return
      if (live.static) {
        if (live.name !== name) return
        // The live token's own renewal: install only what outlasts it.
        const liveExp = await (this.deps.liveExpiry ?? liveExpiryOf)(service).catch(() => null)
        const next = accessExpiry(service, blob)
        if (liveExp !== null && (next === null || next <= liveExp)) return
      }
    }
    try {
      await (this.deps.activate ?? installLive)(service, name, blob)
      pinProfile(service, name)
      coreAccounts.clearUsageCache(service)
      this.log(`${service}: ${name} is the live sign-in here now`)
      this.deps.nudge()
    } catch (err) {
      this.log(`${service}: could not make ${name} live (${(err as Error).message})`)
    }
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.headroomTimer) clearInterval(this.headroomTimer)
    this.headroomTimer = null
    if (this.headroomSoon) clearTimeout(this.headroomSoon)
    this.headroomSoon = null
    for (const key of [...this.pending.keys()]) this.dropPending(key, 'closing')
  }
}

/** When the CLI's own credential on this host lapses (Claude only; the one service with static tokens). */
const liveExpiryOf = async (service: ServiceId): Promise<number | null> => {
  if (service !== 'claude-code') return null
  const keychain = await liveKeychain()
  if (!keychain) return null
  try {
    const exp = JSON.parse(keychain)?.claudeAiOauth?.expiresAt
    return typeof exp === 'number' ? exp : null
  } catch {
    return null
  }
}

/** The value an access-only Codex copy carries where its refresh token was:
 *  codex-cli 0.163+ refuses an auth.json whose `tokens` lack `refresh_token`
 *  ("missing field `refresh_token`") and then runs as if signed out, so every
 *  thread answered 401 from the API-key path. The gateway swaps the real token
 *  into each request and the owner refreshes, so the file's own refresh token
 *  is never used here; it only has to parse. */
export const ACCESS_ONLY_REFRESH = 'aliax-access-only'

/** A Codex blob the CLI will read: an access-only copy gets the placeholder refresh token. Other services and malformed blobs pass through. */
export function cliReadable(service: ServiceId, blob: string): string {
  if (service !== 'codex') return blob
  let parsed: { tokens?: Record<string, unknown> }
  try {
    parsed = JSON.parse(blob)
  } catch {
    return blob
  }
  if (!parsed?.tokens || typeof parsed.tokens !== 'object' || typeof parsed.tokens.refresh_token === 'string') return blob
  parsed.tokens.refresh_token = ACCESS_ONLY_REFRESH
  return JSON.stringify(parsed)
}

/** Make a blob the CLI's live sign-in on this host, restarting nothing. */
const installLive = async (service: ServiceId, name: string, blob: string): Promise<void> => {
  await adapter(service).activate(cliReadable(service, blob), coreAccounts.extra(service, name), new Set())
}

/** The running instance, for aliax-core's hooks (set by startServer; aliax.ts reads it). */
export const accountSyncHooks: { current: AccountSync | null } = { current: null }
