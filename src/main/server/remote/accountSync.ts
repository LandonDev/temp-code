import { accounts as coreAccounts, adapter, pinProfile, vault, withLock, type Hooks, type ServiceId } from 'aliax-core'
import type { SaveOrigin } from 'aliax-core/config'
import { liveKeychain } from 'aliax-core/adapters/claude'
import {
  accessExpiry,
  applyTransfer,
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
import { ACCOUNT_PROVIDERS, PROVIDER_OF, type AccountProvider } from '@shared/accounts'
import type { ServerPush } from '@shared/contract'
import type { PeerLink, Peers } from './peers'

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
 */

const SERVICES: ServiceId[] = ['claude-code', 'codex', 'cursor']
/** Settings row per provider: the environment new sign-ins are handed to. */
export const HOME_PREFIX = 'accounts.home.'
const PUSH_DEBOUNCE_MS = 1_000
/** How long a grant handed out on a pull waits for the taker's confirm before this host keeps it. */
export const RELEASE_TIMEOUT_MS = 30_000

export interface AccountSyncDeps {
  environmentId: string
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  /** The accounts snapshot changed under us: rebuild and push it. */
  nudge: () => void
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

  constructor(private readonly deps: AccountSyncDeps) {}

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
      this.log(`${t.service} ${out.name}: ${t.profile.static ? 'static token' : t.mode} from ${from} landed${t.mode === 'handoff' ? ', waiting for its word' : ''}`)
      // A grant handed over becomes the live sign-in once the sender has stripped its copy (handleReleased).
      if (t.mode !== 'handoff') void this.activateIfNothingLive(t.service, out.name, t.profile.static)
    }
    this.deps.nudge()
    return out
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
    return { transfers }
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
      const { transfers } = await link.request<PullAnswer>('accounts.pull', { from: this.me })
      let landed = 0
      for (const t of transfers) {
        const out = applyTransfer(t, link.id, 'peer')
        if (out.ok && out.saved) landed++
        else if (!out.ok) this.log(`${t.service} ${t.profile.name} from ${link.env.name}: refused (${out.reason})`)
      }
      await this.settle(link)
      // What we own or hold statically, for the host.
      let sent = 0
      for (const service of SERVICES) {
        for (const p of vault.profiles(service)) if (await this.pushOne(link, service, p.name)) sent++
      }
      link.lastSyncAt = this.now()
      link.lastError = null
      if (landed || sent) this.log(`${link.env.name}: ${landed} landed, ${sent} sent`)
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

/** Make a blob the CLI's live sign-in on this host, restarting nothing. */
const installLive = async (service: ServiceId, name: string, blob: string): Promise<void> => {
  await adapter(service).activate(blob, coreAccounts.extra(service, name), new Set())
}

/** The running instance, for aliax-core's hooks (set by startServer; aliax.ts reads it). */
export const accountSyncHooks: { current: AccountSync | null } = { current: null }
