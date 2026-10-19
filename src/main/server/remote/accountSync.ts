import { accounts as coreAccounts, adapter, pinProfile, vault, type Hooks, type ServiceId } from 'aliax-core'
import type { SaveOrigin } from 'aliax-core/config'
import {
  applyTransfer,
  confirmHandoff,
  exportAccount,
  hasRefresh,
  markSynced,
  ownsProfile,
  releaseTo,
  type ApplyOutcome,
  type Transfer
} from 'aliax-core/sync'
import { ACCOUNT_PROVIDERS, PROVIDER_OF, type AccountProvider } from '@shared/accounts'
import type { ServerPush } from '@shared/contract'
import type { PeerLink, Peers } from './peers'

/**
 * Accounts shared between this host and the ones it holds admin keys for
 * (thread V), on top of aliax-core's ownership rules (sync.ts):
 *  - as a host, it answers `accounts.push` (a handoff that makes this host
 *    the owner, or an access-only copy from an owner) and `accounts.pull`
 *    (every account this host owns or holds statically, access-only; with
 *    `takeOver`, the full grant for the caller, after which this host keeps
 *    an access-only copy). A socket that pulled gets every later rotation
 *    as an `account` push, so another host's main process stays current
 *    without asking; renderers never pull and never see a credential.
 *  - as a client of its peers (remote/peers.ts), it syncs on connect, on
 *    every local vault write, and on request: it pulls what the peer
 *    shares, then pushes what it owns, handing a grant off outright when
 *    the peer is its provider's home and the grant is not the one the CLI
 *    on this machine is signed in with (that one the CLI keeps refreshing;
 *    a fresh sign-in mints a grant for the box instead).
 *  - a consumer copy near its end asks its owner (aliax-core's askOwner)
 *    over the owner's link; an owner out of reach means the copy runs out
 *    and the Accounts page says so.
 */

const SERVICES: ServiceId[] = ['claude-code', 'codex', 'cursor']
/** Settings row per provider: the environment new sign-ins are handed to. */
export const HOME_PREFIX = 'accounts.home.'
const PUSH_DEBOUNCE_MS = 1_000

export interface AccountSyncDeps {
  environmentId: string
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  /** The accounts snapshot changed under us: rebuild and push it. */
  nudge: () => void
  log?: (line: string) => void
  now?: () => number
  /** Test seams for the live sign-in: who the CLI here is signed in as, and installing a blob as that sign-in. */
  liveAccountId?: (service: ServiceId) => Promise<string | null>
  activate?: (service: ServiceId, name: string, blob: string) => Promise<void>
}

export interface PullAnswer {
  transfers: Transfer[]
}

export class AccountSync {
  private readonly subscribers = new Set<(push: ServerPush) => void>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly syncing = new Map<string, Promise<void>>()

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
        const out = await this.takeOver(service, p.name, was).catch((err) => {
          this.log(`${service} ${p.name}: could not take over from ${was} (${(err as Error).message})`)
          return null
        })
        if (out?.ok) this.log(`${service} ${p.name}: refreshed here again`)
      }
    }
    await this.syncAll()
  }

  // ── this host, asked by another host's main process ────────────────────

  handlePush(from: string, t: Transfer): ApplyOutcome {
    const out = applyTransfer(t)
    if (!out.ok) {
      this.log(`${t.service} ${t.profile.name}: ${t.mode} from ${from} refused (${out.reason})`)
      return out
    }
    if (out.saved) {
      this.log(`${t.service} ${out.name}: ${t.profile.static ? 'static token' : t.mode} from ${from} landed`)
      void this.activateIfNothingLive(t.service, out.name, t.profile.static)
    }
    this.deps.nudge()
    return out
  }

  handlePull(from: string, params: { service?: ServiceId; name?: string; takeOver?: boolean }): PullAnswer {
    const transfers: Transfer[] = []
    for (const service of params.service ? [params.service] : SERVICES) {
      for (const p of vault.profiles(service)) {
        if (params.name && p.name !== params.name) continue
        try {
          if (params.takeOver && params.name) {
            if (p.static || !ownsProfile(p)) continue
            transfers.push(releaseTo(service, p.name, from))
            this.log(`${service} ${p.name}: handed to ${from}, access-only here from now on`)
            this.deps.nudge()
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
      // What the host owns or holds statically, for us.
      const { transfers } = await link.request<PullAnswer>('accounts.pull', { from: this.me })
      let landed = 0
      for (const t of transfers) {
        const out = applyTransfer(t)
        if (out.ok && out.saved) landed++
        else if (!out.ok) this.log(`${t.service} ${t.profile.name} from ${link.env.name}: refused (${out.reason})`)
      }
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
    const handoff = !p.static && home === link.id && hasRefresh(service, stored) && !(await this.liveLineage(service, stored))
    const transfer = exportAccount(service, name, handoff ? 'handoff' : 'access', link.id)
    const out = await link.request<ApplyOutcome>('accounts.push', { from: this.me, transfer })
    if (!out.ok) {
      this.log(`${service} ${name} → ${link.env.name}: refused (${out.reason})`)
      return false
    }
    if (handoff) {
      confirmHandoff(service, name, link.id)
      this.log(`${service} ${name}: now refreshed by ${link.env.name}`)
    } else markSynced(service, name)
    return true
  }

  /**
   * Whether the stored grant is the one the CLI on this machine is signed
   * in with. Handing that off would let the CLI's own refresh revoke it under
   * the new owner; the user adds the account again to mint one for the box.
   */
  async liveLineage(service: ServiceId, stored: string): Promise<boolean> {
    const a = adapter(service)
    const mine = a.fingerprintOf?.(stored) ?? null
    if (mine === null) return false
    const live = (await a.liveFingerprint?.().catch(() => null)) ?? null
    return mine === live
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

  /** An `account` push from a peer: its owner rotated. */
  onPeerPush = (from: string, push: ServerPush): void => {
    if (push.push !== 'account') return
    const out = applyTransfer(push.transfer)
    if (out.ok && out.saved) {
      this.log(`${push.transfer.service} ${out.name}: rotation from ${from} landed`)
      this.deps.nudge()
    } else if (!out.ok) this.log(`${push.transfer.service} ${push.transfer.profile.name}: rotation from ${from} refused (${out.reason})`)
  }

  /** aliax-core's askOwner: a consumer copy near its end asks its owner over our link. */
  askOwner: NonNullable<Hooks['askOwner']> = async (serviceId: ServiceId, name: string, owner: string): Promise<string | null> => {
    const link = this.deps.peers.get(owner)
    if (!link?.connected) return null
    try {
      const { transfers } = await link.request<PullAnswer>('accounts.pull', { from: this.me, service: serviceId, name })
      let landed: string | null = null
      for (const t of transfers) {
        const out = applyTransfer(t)
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

  /** Take a grant back from its owner (the home moved here). */
  async takeOver(service: ServiceId, name: string, from: string): Promise<ApplyOutcome | null> {
    const link = this.deps.peers.get(from)
    if (!link?.connected) return null
    const { transfers } = await link.request<PullAnswer>('accounts.pull', { from: this.me, service, name, takeOver: true })
    const t = transfers[0]
    if (!t) return null
    const out = applyTransfer(t)
    this.deps.nudge()
    return out
  }

  /**
   * A host with no live sign-in for a service (the box) makes what it was
   * given the live one, so its CLI children can start; a static token
   * replaces a live copy that is only a consumer's (it lapses when the owner
   * is away). A sign-in this machine refreshes itself is never replaced.
   */
  private async activateIfNothingLive(service: ServiceId, name: string, isStatic: boolean): Promise<void> {
    const a = adapter(service)
    if (!a.detect()) return
    const liveId = await (this.deps.liveAccountId ?? ((s: ServiceId) => adapter(s).liveAccountId()))(service).catch(() => null)
    if (liveId) {
      if (!isStatic) return
      const live = vault.profiles(service).find((p) => p.accountId === liveId)
      if (!live || live.static || ownsProfile(live)) return
    }
    let blob: string | null
    try {
      blob = vault.readSecret(service, name)
    } catch {
      return
    }
    if (!blob) return
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
  }
}

/** Make a blob the CLI's live sign-in on this host, restarting nothing. */
const installLive = async (service: ServiceId, name: string, blob: string): Promise<void> => {
  await adapter(service).activate(blob, coreAccounts.extra(service, name), new Set())
}

/** The running instance, for aliax-core's hooks (set by startServer; aliax.ts reads it). */
export const accountSyncHooks: { current: AccountSync | null } = { current: null }
