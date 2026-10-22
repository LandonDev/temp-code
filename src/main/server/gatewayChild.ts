import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, EXPIRY_MARGIN_MS, limitLabel, type Credential, type LimitInfo, type ServiceId, type UsageReport } from 'aliax-core'
import { PROVIDER_OF } from '@shared/accounts'
import { GatewayCore, type ControlPlane, type FailedOverInfo, type ResponseInfo, type ScopedRequest } from './gatewayCore'
import {
  answer,
  Calls,
  limitHeaders,
  type AccountsState,
  type ChildCall,
  type ChildEvent,
  type MainCall,
  type OutMark,
  type StartState,
  type Wire,
  type WireMessage
} from './gatewayWire'
import { preconnectAccount } from './preconnect'
import { fakeProviderRewrite, Upstream, type Fetch } from './upstream'

/**
 * The gateway's utility process (gatewayProcess.ts is its entry): the
 * GatewayCore, the upstream pools and the pre-connects, over a port to main.
 * Its ControlPlane is `PortControl`: the accounts come from main and are
 * kept here as main pushed them (the saved names, the pin, the usage
 * reports, the accounts out of routing), so the common request asks main
 * nothing; a credential is asked once and kept until its token nears its end.
 * Main keeps the vault, the Keychain, every refresh, `askOwner` and the
 * per-profile lock: this process's copy of aliax-core is configured with no
 * vault and as a standby, and the forward reads accounts only through the
 * source the core hands it.
 */

/** A credential whose token names no end is asked again after this long. */
export const CREDENTIAL_TTL_MS = 5 * 60_000

export class PortControl implements ControlPlane {
  private state: AccountsState
  private readonly credentials = new Map<string, { credential: Credential; until: number }>()
  private readonly asking = new Map<string, Promise<Credential | null>>()
  /** Bumped by every drop, so an answer that crossed a drop is not kept. */
  private generation = 0

  constructor(
    private readonly calls: Pick<Calls<MainCall>, 'call'>,
    private readonly tell: (event: ChildEvent) => void,
    state: AccountsState,
    private readonly now: () => number = Date.now
  ) {
    this.state = state
  }

  /** Main's copy changed. A moved pin forgets the unscoped credential of that service. */
  setState(state: AccountsState): void {
    for (const [serviceId, name] of Object.entries(state.pinned)) {
      if (this.state.pinned[serviceId as ServiceId] !== name) this.forget(serviceOf(serviceId as ServiceId), null)
    }
    this.state = state
  }

  setOut(out: OutMark[]): void {
    this.state = { ...this.state, out }
  }

  /** Forget the credentials of one service (`claude`, `codex`), or every one for null. */
  dropCredentials(service: string | null): void {
    this.generation++
    for (const key of [...this.credentials.keys()]) if (service === null || key.startsWith(`${service}\0`)) this.credentials.delete(key)
  }

  private forget(service: string, account: string | null): void {
    this.generation++
    this.credentials.delete(credentialKey(service, account))
  }

  async credentialFor(service: string, account: string | null): Promise<Credential | null> {
    const key = credentialKey(service, account)
    const kept = this.credentials.get(key)
    if (kept && kept.until > this.now()) return kept.credential
    const inflight = this.asking.get(key)
    if (inflight) return inflight
    const generation = this.generation
    const ask = this.calls
      .call<Credential | null>({ m: 'credentialFor', service, account })
      .then((credential) => {
        const until = credential ? keepUntil(credential, this.now()) : 0
        if (credential && until > this.now() && generation === this.generation) this.credentials.set(key, { credential, until })
        return credential
      })
      .finally(() => this.asking.delete(key))
    this.asking.set(key, ask)
    return ask
  }

  async profilesKnown(serviceId: ServiceId): Promise<string[]> {
    return this.state.profiles[serviceId] ?? []
  }

  async pinned(serviceId: ServiceId): Promise<string | null> {
    return this.state.pinned[serviceId] ?? null
  }

  async usageReport(serviceId: ServiceId, name: string): Promise<UsageReport | undefined> {
    return this.state.reports[`${serviceId}:${name}`]
  }

  usage(serviceId: ServiceId, force: boolean): Promise<UsageReport[]> {
    return this.calls.call({ m: 'usage', serviceId, force })
  }

  /** Main decides only for an account it took out of routing; any other account stays where it is without asking. */
  async substitute(info: ScopedRequest): Promise<string | null> {
    if (!this.isOut(info.serviceId, info.account)) return null
    return this.calls.call({ m: 'substitute', info })
  }

  async onUnauthorized(info: ScopedRequest): Promise<string | null> {
    return this.calls.call({ m: 'onUnauthorized', info })
  }

  pickNext(info: LimitInfo): Promise<string | null> {
    return this.calls.call({ m: 'pickNext', info })
  }

  /** Charged here at once (the next request's check reads it), and in main's usage cache. */
  observeLimit(...[serviceId, name, limit]: Parameters<ControlPlane['observeLimit']>): void {
    const label = limitLabel(serviceId, limit.window)
    if (label) {
      const key = `${serviceId}:${name}`
      const base = this.state.reports[key] ?? { profileName: name, windows: [] }
      const at = base.windows.findIndex((w) => w.label === label)
      const window = { ...(at >= 0 ? base.windows[at] : { label }), usedPercent: 100, ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}) }
      const windows = at >= 0 ? base.windows.map((w, i) => (i === at ? window : w)) : [...base.windows, window]
      this.state = { ...this.state, reports: { ...this.state.reports, [key]: { ...base, windows } } }
    }
    this.tell({ e: 'observeLimit', serviceId, name, limit })
  }

  async pin(serviceId: ServiceId, name: string): Promise<void> {
    this.state = { ...this.state, pinned: { ...this.state.pinned, [serviceId]: name } }
    this.forget(serviceOf(serviceId), null)
    this.tell({ e: 'pin', serviceId, name })
  }

  /** A 401 means the token this process holds is dead or about to be: the next request asks main again. */
  onResponse(info: ResponseInfo): void {
    if (info.status === 401) this.dropCredentials(info.service)
    this.tell({ e: 'response', info: { ...info, headers: limitHeaders(info.headers) } })
  }

  onRouted(info: Parameters<ControlPlane['onRouted']>[0]): void {
    this.tell({ e: 'routed', info })
  }

  onFailedOver(info: FailedOverInfo): void {
    this.tell({ e: 'failedOver', info })
  }

  onError(message: string): void {
    this.tell({ e: 'error', message })
  }

  private isOut(serviceId: ServiceId, name: string): boolean {
    const now = this.now()
    return this.state.out.some((m) => m.serviceId === serviceId && m.name === name && (m.until === null || m.until > now))
  }
}

const credentialKey = (service: string, account: string | null): string => `${service}\0${account ?? ''}`
const serviceOf = (serviceId: ServiceId): string => PROVIDER_OF[serviceId] ?? serviceId

/** Kept until a minute before the token's end (when main's refresh would renew it); a token with no stated end for five minutes. */
function keepUntil(credential: Credential, now: number): number {
  return credential.expiresAt ? credential.expiresAt - EXPIRY_MARGIN_MS : now + CREDENTIAL_TTL_MS
}

export interface ChildDeps {
  /** Electron's `net.fetch` in this process: Chromium's TLS, which Cloudflare lets through on chatgpt.com. */
  chromiumFetch: Fetch
  /** How the process ends when main is gone. */
  exit?: () => void
  /** Checks main's pid (the start message names it) this often; 0 turns the watch off (tests). */
  watchMainMs?: number
}

/** Stats reach main at most this often while traffic moves. */
const STATS_EVERY_MS = 250

/**
 * Serve the gateway over `wire` until main goes away. The first message is
 * `start`; every other one follows the protocol in gatewayWire.ts. `stop`
 * closes the sockets and the pools (a test's stand-in for the process dying).
 */
export function runGatewayChild(wire: Wire, deps: ChildDeps): { stop: () => Promise<void> } {
  const exit = deps.exit ?? (() => process.exit(0))
  const calls = new Calls<MainCall>(wire)
  let control: PortControl | null = null
  let core: GatewayCore | null = null
  let upstream: Upstream | null = null
  let trace = false
  let label = '[gateway]'
  let statsTimer: NodeJS.Timeout | null = null

  const sendStats = (): void => {
    if (statsTimer || !core) return
    statsTimer = setTimeout(() => {
      statsTimer = null
      if (!core) return
      const s = core.status()
      wire.post({ t: 'stats', routed: s.routed, error: s.error })
    }, STATS_EVERY_MS)
  }

  const start = async (state: StartState): Promise<void> => {
    trace = state.seams.trace
    label = `[gateway:${process.pid}]`
    upstream = new Upstream({
      chromiumFetch: deps.chromiumFetch,
      // Chromium's pool in this process: a HEAD opens the socket the next codex turn rides.
      chromiumPreconnect: (origin) =>
        void deps
          .chromiumFetch(origin, { method: 'HEAD' })
          .then((r) => r.body?.cancel())
          .catch(() => {}),
      rewrite: fakeProviderRewrite(state.seams.fakeProviders)
    })
    const pool = upstream
    // No vault, no Keychain, no refresh: the forward reads accounts only through PortControl.
    configure({
      dataDir: join(tmpdir(), 'temp-code-gateway-has-no-vault'),
      fetch: (input, init) => pool.fetch(input, init),
      secrets: { mode: 'fileKey', path: join(tmpdir(), 'temp-code-gateway-has-no-vault', 'none') },
      role: () => (state.seams.role === 'owner' ? 'owner' : 'standby')
    })
    control = new PortControl(calls, (event) => wire.post({ t: 'event', event }), state.accounts)
    core = new GatewayCore({
      control,
      tls: state.tls,
      trace,
      label,
      pid: state.mainPid
    })
    core.onStats = sendStats
    let port: number
    try {
      port = await core.listen(state.port)
    } catch (e) {
      console.warn(`${label} :${state.port} is taken (${(e as Error).message}); listening on a new port`)
      port = await core.listen(0)
    }
    for (const { id, scope } of state.warm) core.adoptWarm(id, scope)
    const scoped: { thread: string; port: number }[] = []
    for (const s of state.scoped) {
      let p: number | null
      try {
        p = await core.scopedCodexPort(s.thread, s.scope, s.port)
      } catch {
        p = await core.scopedCodexPort(s.thread, s.scope, 0)
      }
      if (p !== null) scoped.push({ thread: s.thread, port: p })
    }
    wire.post({ t: 'ready', pid: process.pid, port, scoped })
    console.log(`${label} serving on :${port}${scoped.length ? ` and ${scoped.length} codex port(s)` : ''}`)
    // The child dies with main: the port closing says so, and main's pid gone says so if the port cannot.
    const watchMs = deps.watchMainMs ?? 5_000
    if (watchMs > 0) {
      setInterval(() => {
        try {
          process.kill(state.mainPid, 0)
        } catch {
          exit()
        }
      }, watchMs).unref()
    }
  }

  const run = async (call: ChildCall): Promise<unknown> => {
    if (!core || !control || !upstream) throw new Error('the gateway has not started')
    switch (call.m) {
      case 'warm.adopt':
        core.adoptWarm(call.id, call.scope)
        return null
      case 'scoped.open':
        return core.scopedCodexPort(call.thread, call.scope)
      case 'scoped.close':
        await core.releaseScoped(call.thread)
        return null
      case 'preconnect': {
        const c = control
        return preconnectAccount(call.provider, call.account, { upstream, credential: (s, a) => c.credentialFor(s, a), trace, label })
      }
    }
  }

  wire.onMessage((message: WireMessage) => {
    switch (message.t) {
      case 'start':
        start(message.state).catch((e) => {
          console.error(`${label} could not start: ${(e as Error).message}`)
          exit()
        })
        return
      case 'accounts':
        control?.setState(message.state)
        return
      case 'out':
        control?.setOut(message.out)
        return
      case 'credentials.drop':
        control?.dropCredentials(message.service)
        return
      case 'warm.set':
        core?.setWarm(message.id)
        return
      case 'warm.release':
        core?.releaseWarm(message.id)
        return
      case 'ask':
        answer(wire, message.id, () => run(message.call as ChildCall))
        return
      case 'reply':
        calls.settle(message)
        return
    }
  })
  wire.onClose(exit)
  return {
    stop: async () => {
      if (statsTimer) clearTimeout(statsTimer)
      statsTimer = null
      const c = core
      core = null
      await Promise.all([c?.close(), upstream?.destroy()])
    }
  }
}
