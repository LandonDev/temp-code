import { accounts as coreAccounts, refreshAddon, vault, withLock, type AddonRefresh } from 'aliax-core'
import { ownsProfile, profileOf } from 'aliax-core/sync'
import { ADDON_SERVICE, grantGaps, type AddonGrantBlob } from '@shared/addonGrant'
import {
  GRANT_NO_ADDON,
  GRANT_NO_FIELD,
  GRANT_OFFLINE,
  GRANT_ON_MAC,
  GRANT_PROBE_REFUSED,
  SIGNIN_BUSY,
  SIGNIN_NEEDS_BROWSER,
  SIGNIN_STEP_WORDS
} from '@shared/addonGrantWords'
import { grantFieldNames } from '@shared/addons'
import type { AddonGrantMethod, AddonGrantView, SignInState } from '@shared/contract-addonGrants'
import type { AddonRow, AddonSpec } from '@shared/contract-addons'
import type { AddonStore } from '../addonStore'
import type { AccountSync } from '../remote/accountSync'
import type { Peers } from '../remote/peers'
import { vaultGrantSource, type AddonGrantSource } from './grants'
import { SignInError, type AddonOAuth, type AddonSignIn } from './oauthFlow'
import type { ProbeAnswer } from './grantProbe'

/**
 * Add-on grants on this host (plan-8YMm3ynnFZYs.md §5): the vault-backed
 * source the add-on host reads, and everything that changes a grant.
 *
 *  - read: the vault's blob, fresh on every ask (grants.ts vaultGrantSource).
 *  - refresh, on a downstream 401 or 403: the owner forces a refresh at most
 *    once per 30 s per grant (a call inside the window is kept for its end);
 *    a copy asks its owner's `addons.grant.refresh`, then pulls, so the token
 *    the server just refused is never handed back from this vault.
 *  - the keeper: one timer per OAuth grant with an expiry, on its owner ahead
 *    of the end by min(5 min, a quarter of the token's life), on a copy at
 *    half that lead (the owner's push usually lands first); failures retry
 *    on fixed steps past the token's end; a refusal stops it and marks the
 *    view until the grant is saved again.
 *  - writes run on one host (`writerOf`): the host that refreshes the grant,
 *    else the add-on scope's home (the box), else here; others forward over
 *    the admin link or refuse. Every change runs under the profile lock a
 *    refresh and a handoff hold, and reads the vault again inside it.
 *  - the sweep: a grant whose add-on row is gone leaves this vault; only the
 *    scope's home (or the one host of an unshared scope) deletes with a
 *    tombstone, every other host deletes its own copy alone.
 *  - the sign-in, on a host with a browser (oauthFlow.ts), one per add-on.
 *  - the view and its push (`addon-grants`), never a value.
 */

export const ADDON_REFRESH_MARGIN_MS = 5 * 60_000
export const ADDON_REFRESH_RETRY_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] // then 10 min each time
export const ADDON_FORCE_REFRESH_MIN_MS = 30_000
export const ADDON_SWEEP_MS = 60 * 60_000
export const ADDON_SWEEP_DEBOUNCE_MS = 500
export const ADDON_GRANTS_PUSH_MS = 100

type Link = NonNullable<ReturnType<Peers['get']>>

export interface AddonGrantsDeps {
  environmentId: string
  addons: Pick<AddonStore, 'get' | 'list' | 'onChange'>
  accountSync: Pick<AccountSync, 'deleteProfile'>
  /** The env id of the host that holds the scope's rows (storeSync.homeFor non-null → rulesSync.homeOf()), null for this host or an unshared scope. */
  scopeHome: (workspaceId: string | null) => string | null
  peers: { get(id: string): Pick<Link, 'connected' | 'request'> | undefined }
  hostName: (environmentId: string) => string
  /** The add-on host's AddonHost.grantsChanged. */
  grantsChanged: (addonId: string | null) => void
  /** The sign-in, on a host that can open a browser; null elsewhere (the box). */
  signIn: AddonSignIn | null
  probe: (spec: AddonSpec, fields: Record<string, string>) => Promise<ProbeAnswer>
  now?: () => number
  log?: (line: string) => void
  /** Test seams. */
  sweepMs?: number
  pushMs?: number
}

interface Keeper {
  timer: NodeJS.Timeout | null
  expiresAt: number
  seenAt: number
  retry: number
}

interface SignInRun {
  ctl: AbortController
  state: Exclude<SignInState, 'failed'>
  since: number
  port?: number
}

export class AddonGrants implements AddonGrantSource {
  private readonly keepers = new Map<string, Keeper>()
  private readonly refused = new Set<string>()
  private readonly lastForced = new Map<string, number>()
  private readonly deferred = new Map<string, NodeJS.Timeout>()
  private readonly runs = new Map<string, SignInRun>()
  private readonly failed = new Map<string, { since: number; error: string }>()
  /** The last scope home seen per add-on row, kept after the row is gone: the sweep's rule reads it. */
  private readonly lastHome = new Map<string, string | null>()
  private readonly listeners = new Set<(grants: AddonGrantView[]) => void>()
  private pushTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private sweepPeriod: NodeJS.Timeout | null = null
  private offChange: (() => void) | null = null
  private closed = false

  constructor(private readonly deps: AddonGrantsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[addons] ${l}`)))(line)
  }

  /** This vault's add-on profiles; none where aliax-core is not configured (an in-process proof). */
  private profiles(): ReturnType<typeof vault.profiles> {
    try {
      return vault.profiles(ADDON_SERVICE)
    } catch {
      return []
    }
  }

  private nameOf(addonId: string): string {
    return this.deps.addons.get(addonId)?.name ?? addonId
  }

  start(): void {
    this.noteHomes()
    this.offChange = this.deps.addons.onChange(() => {
      this.noteHomes()
      this.changed()
      this.sweepSoon()
    })
    this.sweepPeriod = setInterval(() => void this.sweep(), this.deps.sweepMs ?? ADDON_SWEEP_MS)
    this.sweepPeriod.unref?.()
    for (const p of this.profiles()) this.schedule(p.name)
    void this.sweep()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.offChange?.()
    this.offChange = null
    for (const k of this.keepers.values()) if (k.timer) clearTimeout(k.timer)
    this.keepers.clear()
    for (const t of this.deferred.values()) clearTimeout(t)
    this.deferred.clear()
    for (const r of this.runs.values()) r.ctl.abort()
    this.runs.clear()
    for (const t of [this.pushTimer, this.sweepTimer]) if (t) clearTimeout(t)
    if (this.sweepPeriod) clearInterval(this.sweepPeriod)
    this.pushTimer = this.sweepTimer = this.sweepPeriod = null
    this.listeners.clear()
  }

  // ── the source ─────────────────────────────────────────────────────────

  read(addonId: string): Promise<AddonGrantBlob | null> {
    return vaultGrantSource.read(addonId)
  }

  async refresh(addonId: string): Promise<void> {
    const p = profileOf(ADDON_SERVICE, addonId)
    if (!p || p.static) return
    if (ownsProfile(p)) {
      await this.forceRefresh(addonId)
      return
    }
    // A copy: the owner refreshes first (it has not seen the 401), then this host pulls.
    const owner = p.owner
    const link = owner ? this.deps.peers.get(owner) : undefined
    if (link?.connected) await link.request('addons.grant.refresh', { id: addonId }).catch((err: Error) => this.log(`${this.nameOf(addonId)}: its owner did not refresh it (${err.message})`))
    this.outcome(addonId, await refreshAddon(addonId, { force: true }))
  }

  /** The owner's forced refresh, asked by a copy that met a 401 (`addons.grant.refresh`): once per 30 s per grant, a later ask kept for the window's end. */
  async forceRefresh(addonId: string): Promise<boolean> {
    const wait = (this.lastForced.get(addonId) ?? -Infinity) + ADDON_FORCE_REFRESH_MIN_MS - this.now()
    if (wait > 0) {
      if (!this.deferred.has(addonId)) {
        const t = setTimeout(() => {
          this.deferred.delete(addonId)
          void this.forceRefresh(addonId).then(() => this.deps.grantsChanged(addonId))
        }, wait)
        t.unref?.()
        this.deferred.set(addonId, t)
      }
      return false
    }
    this.lastForced.set(addonId, this.now())
    const out = await refreshAddon(addonId, { force: true })
    this.outcome(addonId, out)
    return out.ok
  }

  /** What a refresh's answer means here: a refusal marks the view until the grant is saved again. */
  private outcome(addonId: string, out: AddonRefresh): void {
    if (out.ok) return
    if (out.reason === 'refused') {
      this.refused.add(addonId)
      this.stopKeeper(addonId)
      this.log(`${this.nameOf(addonId)}: the server refused its refresh; it needs a sign-in again`)
      this.changed()
    } else if (out.reason !== 'static' && out.reason !== 'no-grant') {
      this.log(`${this.nameOf(addonId)}: not refreshed (${out.reason})`)
    }
  }

  // ── the keeper ─────────────────────────────────────────────────────────

  private stopKeeper(addonId: string): void {
    const k = this.keepers.get(addonId)
    if (k?.timer) clearTimeout(k.timer)
    this.keepers.delete(addonId)
  }

  /** Whether this host refreshes the grant (owner, with a refresh token), asks its owner (a copy), or neither. */
  private roleOf(addonId: string, blob: AddonGrantBlob | null): 'owner' | 'copy' | null {
    const p = profileOf(ADDON_SERVICE, addonId)
    if (!p || p.static || !blob?.oauth) return null
    if (ownsProfile(p)) return typeof blob.oauth.refreshToken === 'string' ? 'owner' : null
    return p.owner && p.owner !== this.deps.environmentId ? 'copy' : null
  }

  private schedule(addonId: string, delayMs?: number): void {
    if (this.closed) return
    const blob = this.readBlob(addonId)
    const role = this.roleOf(addonId, blob)
    const expiresAt = blob?.oauth?.expiresAt
    if (!role || typeof expiresAt !== 'number' || this.refused.has(addonId)) return this.stopKeeper(addonId)
    const prior = this.keepers.get(addonId)
    if (prior?.timer) clearTimeout(prior.timer)
    const seenAt = prior && prior.expiresAt === expiresAt ? prior.seenAt : this.now()
    const keeper: Keeper = { timer: null, expiresAt, seenAt, retry: prior && prior.expiresAt === expiresAt ? prior.retry : 0 }
    const lead = Math.min(ADDON_REFRESH_MARGIN_MS, Math.max(0, (expiresAt - seenAt) / 4))
    const ahead = role === 'owner' ? lead : lead / 2
    const wait = delayMs ?? Math.max(0, expiresAt - ahead - this.now())
    keeper.timer = setTimeout(() => void this.keep(addonId, ahead), wait)
    keeper.timer.unref?.()
    this.keepers.set(addonId, keeper)
  }

  private async keep(addonId: string, minValidMs: number): Promise<void> {
    const keeper = this.keepers.get(addonId)
    if (!keeper || this.closed) return
    keeper.timer = null
    const out = await refreshAddon(addonId, { minValidMs })
    if (this.closed || this.keepers.get(addonId) !== keeper) return
    const after = this.readBlob(addonId)?.oauth?.expiresAt
    if (out.ok && typeof after === 'number' && after !== keeper.expiresAt) return this.schedule(addonId)
    if (!out.ok && (out.reason === 'refused' || out.reason === 'no-grant' || out.reason === 'static' || out.reason === 'no-refresh')) {
      this.outcome(addonId, out)
      return this.stopKeeper(addonId)
    }
    // network, an owner out of reach, or a copy whose owner had nothing newer: the steps, past the token's end too.
    const step = ADDON_REFRESH_RETRY_MS[Math.min(keeper.retry, ADDON_REFRESH_RETRY_MS.length - 1)]
    keeper.retry++
    if (!out.ok) this.log(`${this.nameOf(addonId)}: not refreshed (${out.reason}); trying again in ${Math.round(step / 1000)} s`)
    this.schedule(addonId, step)
  }

  // ── hooks ──────────────────────────────────────────────────────────────

  /** aliax.ts onSecretSaved for ADDON_SERVICE, any origin: reschedule the keeper (after the save's row update), push. */
  onSaved(addonId: string): void {
    queueMicrotask(() => {
      if (this.closed) return
      this.refused.delete(addonId)
      const known = this.keepers.get(addonId)
      const expiresAt = this.readBlob(addonId)?.oauth?.expiresAt
      if (!known || known.expiresAt !== expiresAt || known.timer === null) this.schedule(addonId)
      this.changed()
    })
  }

  /** accountSync's onRemoved for ADDON_SERVICE: forget the keeper, push, tell the add-on host. */
  onRemoved(addonId: string): void {
    this.stopKeeper(addonId)
    this.refused.delete(addonId)
    this.changed()
    this.deps.grantsChanged(addonId)
  }

  /** storeRpc's onAddonRemoved: sweep that id now. */
  onAddonRemoved(addonId: string): void {
    void this.sweep(addonId)
  }

  /** accountSync's addonHome: the scope home of the add-on's row, null for an unknown row. */
  homeOf(addonId: string): string | null {
    const row = this.deps.addons.get(addonId)
    return row ? this.deps.scopeHome(row.workspaceId) : null
  }

  // ── the sweep ──────────────────────────────────────────────────────────

  /** Every row's scope home now, kept for when the row is gone. A home once seen is not forgotten for a null (a scope that only looks unshared before the first sync). */
  private noteHomes(): void {
    for (const row of this.deps.addons.list()) {
      const home = this.deps.scopeHome(row.workspaceId)
      if (home !== null || !this.lastHome.has(row.id)) this.lastHome.set(row.id, home)
    }
  }

  private sweepSoon(): void {
    if (this.sweepTimer || this.closed) return
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null
      void this.sweep()
    }, ADDON_SWEEP_DEBOUNCE_MS)
    this.sweepTimer.unref?.()
  }

  /** The one place a grant leaves with its add-on. */
  async sweep(only?: string): Promise<number> {
    let gone = 0
    for (const p of this.profiles()) {
      if (only && p.name !== only) continue
      if (this.deps.addons.get(p.name)) continue
      this.cancelSignIn(p.name)
      this.stopKeeper(p.name)
      const home = this.lastHome.has(p.name) ? this.lastHome.get(p.name)! : this.deps.scopeHome(null)
      await withLock(ADDON_SERVICE, p.name, async () => {
        const now = profileOf(ADDON_SERVICE, p.name)
        if (!now || this.deps.addons.get(p.name)) return
        if (home === null && (now.static || ownsProfile(now))) {
          await this.deps.accountSync.deleteProfile(ADDON_SERVICE, p.name)
          this.log(`${p.name}: its add-on is gone; the grant is removed with a tombstone`)
        } else {
          vault.deleteProfile(ADDON_SERVICE, p.name)
          this.log(`${p.name}: its add-on is gone; this host's copy of the grant is removed`)
          this.onRemoved(p.name)
        }
        gone++
      })
    }
    return gone
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /** Where a setFields or clear of this grant runs: null for this host. */
  writerOf(addonId: string): string | null {
    const p = profileOf(ADDON_SERVICE, addonId)
    if (p && !p.static) {
      if (ownsProfile(p)) return null
      if (p.owner && p.owner !== this.deps.environmentId) return p.owner
    }
    return this.homeOf(addonId)
  }

  private async forward<T>(writer: string, addonId: string, method: AddonGrantMethod, params: unknown): Promise<T> {
    const name = this.nameOf(addonId)
    const link = this.deps.peers.get(writer)
    // The box has no link to the Mac: a grant the Mac still refreshes moves at the next sync.
    if (!link) throw new Error(GRANT_ON_MAC(name))
    if (!link.connected) throw new Error(GRANT_OFFLINE(name, this.deps.hostName(writer)))
    try {
      return await link.request<T>(method, params)
    } catch (err) {
      if (!link.connected) throw new Error(GRANT_OFFLINE(name, this.deps.hostName(writer)))
      throw err
    }
  }

  async setFields(addonId: string, fields: Record<string, string | null>): Promise<AddonGrantView> {
    const writer = this.writerOf(addonId)
    if (writer) return (await this.forward<{ grant: AddonGrantView }>(writer, addonId, 'addons.grant.setFields', { id: addonId, fields })).grant
    return withLock(ADDON_SERVICE, addonId, async () => {
      const row = this.deps.addons.get(addonId)
      if (!row) throw new Error(GRANT_NO_ADDON(addonId))
      const names = grantFieldNames(row.spec)
      for (const name of Object.keys(fields)) if (!names.includes(name)) throw new Error(GRANT_NO_FIELD(row.name, name))
      const stored = this.readBlob(addonId)
      const merged: Record<string, string> = { ...(stored?.fields ?? {}) }
      let setsValue = false
      for (const [name, value] of Object.entries(fields)) {
        if (value === null || value === '') delete merged[name]
        else {
          if (merged[name] !== value) setsValue = true
          merged[name] = value
        }
      }
      // A spec that also needs a sign-in is not probed: its server refuses without the token either way.
      if (setsValue && row.spec.auth !== 'oauth' && names.every((n) => merged[n])) {
        if ((await this.deps.probe(row.spec, merged)) === 'refused') throw new Error(GRANT_PROBE_REFUSED)
      }
      const p = profileOf(ADDON_SERVICE, addonId)
      if (Object.keys(merged).length === 0 && !stored?.oauth) {
        if (p) await this.deps.accountSync.deleteProfile(ADDON_SERVICE, addonId)
      } else {
        const blob: AddonGrantBlob = { v: 1, mintedBy: 'app', addonId, fields: merged, ...(stored?.oauth ? { oauth: stored.oauth } : {}) }
        coreAccounts.saveAddonGrant({ addonId, nickname: row.name, blob: JSON.stringify(blob) })
      }
      this.log(`${row.name}: values ${Object.keys(fields).join(', ')} saved`)
      return this.viewOf(row)
    })
  }

  async clear(addonId: string): Promise<boolean> {
    const writer = this.writerOf(addonId)
    if (writer) return (await this.forward<{ cleared: boolean }>(writer, addonId, 'addons.grant.clear', { id: addonId })).cleared
    this.cancelSignIn(addonId)
    return withLock(ADDON_SERVICE, addonId, async () => {
      if (!profileOf(ADDON_SERVICE, addonId)) return false
      const out = await this.deps.accountSync.deleteProfile(ADDON_SERVICE, addonId)
      return out.ok
    })
  }

  // ── the sign-in ────────────────────────────────────────────────────────

  async startSignIn(addonId: string): Promise<{ started: true; port: number }> {
    const signIn = this.deps.signIn
    if (!signIn) throw new Error(SIGNIN_NEEDS_BROWSER)
    const row = this.deps.addons.get(addonId)
    if (!row) throw new Error(GRANT_NO_ADDON(addonId))
    if (this.runs.has(addonId)) throw new Error(SIGNIN_BUSY(row.name))
    const run: SignInRun = { ctl: new AbortController(), state: 'discovering', since: this.now() }
    this.runs.set(addonId, run)
    this.failed.delete(addonId)
    this.changed()
    const profile = profileOf(ADDON_SERVICE, addonId)
    const refreshedElsewhere = !!profile && !profile.static && !ownsProfile(profile)
    let ready!: { resolve: (port: number) => void; reject: (err: Error) => void; done: boolean }
    const bound = new Promise<number>((resolve, reject) => (ready = { resolve, reject, done: false }))
    const isReady = (port: number): void => {
      if (ready.done) return
      ready.done = true
      ready.resolve(port)
    }
    void signIn
      .run({ addon: { id: row.id, name: row.name, spec: row.spec }, prior: this.readBlob(addonId), refreshedElsewhere }, run.ctl.signal, {
        step: (s) => {
          run.state = s.step
          run.since = this.now()
          if (s.step === 'waiting') {
            run.port = s.port
            isReady(s.port)
          }
          this.changed()
        },
        registered: async (oauth) => {
          await this.saveSignIn(addonId, run, oauth, false)
          run.port = oauth.redirectPort
          isReady(oauth.redirectPort)
        }
      })
      .then(async (oauth) => {
        await this.saveSignIn(addonId, run, oauth, true)
        this.log(`${row.name}: signed in${oauth.refreshToken ? '' : ' (no refresh token: it lasts until its token does)'}`)
      })
      .catch((err: Error) => {
        if (run.ctl.signal.aborted || err.name === 'AbortError') return
        const error = err instanceof SignInError ? err.message : SIGNIN_STEP_WORDS.failed
        if (!(err instanceof SignInError)) this.log(`${row.name}: the sign-in failed at ${run.state}`)
        this.failed.set(addonId, { since: this.now(), error })
        if (!ready.done) {
          ready.done = true
          ready.reject(new Error(error))
        }
      })
      .finally(() => {
        if (this.runs.get(addonId) === run) this.runs.delete(addonId)
        if (!ready.done) {
          ready.done = true
          ready.reject(new Error(SIGNIN_STEP_WORDS.failed))
        }
        this.changed()
      })
    return { started: true, port: await bound }
  }

  /** A sign-in's save: under the lock, only while the run stands and the row exists, onto the values stored now. */
  private async saveSignIn(addonId: string, run: SignInRun, oauth: AddonOAuth, signedIn: boolean): Promise<void> {
    await withLock(ADDON_SERVICE, addonId, async () => {
      const row = this.deps.addons.get(addonId)
      if (run.ctl.signal.aborted || this.runs.get(addonId) !== run || !row) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const stored = this.readBlob(addonId)
      const blob: AddonGrantBlob = { v: 1, mintedBy: 'app', addonId, fields: stored?.fields ?? {}, oauth }
      coreAccounts.saveAddonGrant({ addonId, nickname: row.name, blob: JSON.stringify(blob), signedIn })
    })
  }

  cancelSignIn(addonId: string): boolean {
    const run = this.runs.get(addonId)
    if (!run) return false
    run.ctl.abort()
    this.runs.delete(addonId)
    this.changed()
    return true
  }

  // ── the view ───────────────────────────────────────────────────────────

  private readBlob(addonId: string): AddonGrantBlob | null {
    return vaultGrantSource.readSync(addonId)
  }

  private viewOf(row: AddonRow): AddonGrantView {
    const blob = this.readBlob(row.id)
    const p = profileOf(ADDON_SERVICE, row.id)
    const run = this.runs.get(row.id)
    const failed = this.failed.get(row.id)
    let refreshedBy: string | null = null
    if (p && !p.static && !ownsProfile(p) && p.owner) refreshedBy = this.deps.hostName(p.owner)
    return {
      addonId: row.id,
      fields: grantFieldNames(row.spec).map((name) => ({ name, set: !!blob?.fields[name] })),
      oauth:
        row.spec.auth === 'oauth' && blob?.oauth
          ? { signedIn: !!blob.oauth.accessToken, expiresAt: blob.oauth.expiresAt ?? null, refreshedBy, refused: this.refused.has(row.id) }
          : null,
      signIn: run
        ? { state: run.state, since: run.since, ...(run.port ? { port: run.port } : {}) }
        : failed
          ? { state: 'failed', since: failed.since, error: failed.error }
          : null,
      gaps: grantGaps(row.spec, blob)
    }
  }

  view(addonId: string): AddonGrantView | null {
    const row = this.deps.addons.get(addonId)
    return row ? this.viewOf(row) : null
  }

  /** One view per add-on row on this host that takes values or a sign-in. */
  list(): AddonGrantView[] {
    return this.deps.addons
      .list()
      .filter((row) => row.spec.auth !== 'none')
      .map((row) => this.viewOf(row))
  }

  onChange(fn: (grants: AddonGrantView[]) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Coalesced: one push per burst. */
  private changed(): void {
    if (this.pushTimer || this.closed) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      if (this.listeners.size === 0) return
      const grants = this.list()
      for (const fn of this.listeners) fn(grants)
    }, this.deps.pushMs ?? ADDON_GRANTS_PUSH_MS)
    this.pushTimer.unref?.()
  }
}

/** The six `addons.grant.*` handlers, kept out of index.ts's switch so they test without a server. */
export function grantRpc(grants: AddonGrants) {
  return {
    async handle(method: AddonGrantMethod, params: unknown): Promise<unknown> {
      const p = (params ?? {}) as { id?: string; fields?: Record<string, string | null> }
      switch (method) {
        case 'addons.grant.list':
          return { grants: grants.list() }
        case 'addons.grant.setFields':
          return { grant: await grants.setFields(p.id!, p.fields ?? {}) }
        case 'addons.grant.clear':
          return { cleared: await grants.clear(p.id!) }
        case 'addons.grant.refresh':
          return { refreshed: await grants.forceRefresh(p.id!) }
        case 'addons.grant.signIn':
          return grants.startSignIn(p.id!)
        case 'addons.grant.cancel':
          return { cancelled: grants.cancelSignIn(p.id!) }
      }
    }
  }
}

/** The running instance, for aliax.ts's onSecretSaved (set by startServer). */
export const addonGrantsHook: { current: AddonGrants | null } = { current: null }
