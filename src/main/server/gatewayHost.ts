import { claim, isLive, readMarker, release, watchMarker, type ForwardHooks, type Owner, type RouteScope, type ServiceId } from 'aliax-core'
import { PROVIDER_OF } from '@shared/accounts'
import { setCodexCaCertificate } from './drivers/binaries'
import { GatewayCore, OWNER, type ControlPlane, type RoutingHooks } from './gatewayCore'
import { InProcessControl } from './gatewayControl'
import { answer, Calls, WireGone, type AccountsState, type ChildCall, type ChildEvent, type MainCall, type OutMark, type StartState, type Wire, type WireMessage } from './gatewayWire'
import { loadTls, trustHint, type TlsMaterial } from './tls'

/**
 * temp-code's loopback gateway as the rest of the app sees it. Every Claude
 * and Codex request from a child (or, once we hold the marker, from any
 * terminal via the shim) comes through it, and aliax-core's `forward` swaps
 * the Authorization header for the account the thread routes to.
 *
 * The byte path (GatewayCore: listeners, forward, SSE relay, upstream pools)
 * runs in an Electron utility process of its own when the app can start one
 * (`spawnChild`, gatewayProcess.ts): its own heap and thread, so thirty
 * streaming threads no longer share the main process's one JavaScript
 * thread with everything else. Main keeps what must stay single: the
 * marker (claimed with main's pid and the child's url), the TLS pair, the
 * vault, the Keychain, every refresh and `askOwner`, the routing hooks, and
 * mirrors of what callers read synchronously (`url()`, `status()`, the codex
 * ports, the warm map). The child's asks are answered by `InProcessControl`;
 * the accounts it reads are pushed on change. A child that exits is
 * respawned on the same ports (streams in flight are cut; the SDKs retry);
 * three exits in a minute and the gateway runs in this process instead
 * (GatewayCore + InProcessControl, today's behaviour), as it always does
 * with no spawner (tests, the in-process proofs).
 */

/** How the main process holds its child: the port to it, its pid, and its end. */
export interface GatewayChildLink {
  wire: Wire
  kill(): void
  onExit(fn: (code: number | null) => void): void
}
export type SpawnGatewayChild = () => GatewayChildLink

export interface GatewayOptions {
  /** Whether this instance may write the marker at all (rule 2). */
  claimShim: boolean
  hooks?: ForwardHooks & RoutingHooks
  /** Who answers the gateway's asks: `InProcessControl` over `hooks` by default (aliax-core's own reads); a test passes its own. */
  control?: ControlPlane
  /** Liveness tick for the marker watcher; tests shorten it. */
  tickMs?: number
  /** Where the app keeps its own certificate when Aliax has none; no TLS without it. */
  dataDir?: string
  /** Test seam: the certificate to serve instead of reading disk. */
  tls?: TlsMaterial | null
  /** Start the byte path in a process of its own (gatewayProcess.ts); in this process when absent. */
  spawnChild?: SpawnGatewayChild
  /** The accounts out of routing (AccountsService.outMarks), so the child decides `substitute` locally for every other account. */
  outMarks?: () => OutMark[]
  /** Pre-connect when the byte path runs in this process (this process's upstream pools); the child pre-connects its own. */
  preconnect?: (provider: string, account: string | null) => unknown
  /** How long a new child has to say it is listening. */
  readyTimeoutMs?: number
  /** How long a warm adoption waits for the child's word before the CLI goes on regardless. */
  adoptTimeoutMs?: number
  /** The env seams the child gets (TEMP_CODE_GATEWAY_TRACE, _FAKE_PROVIDERS, _GATEWAY_ROLE); read from this process's env by default. */
  seams?: StartState['seams']
  now?: () => number
}

export interface GatewayStatus {
  running: boolean
  port: number
  /** True while the shim routes to this process. */
  owner: boolean
  /** Who holds the marker instead of us, when someone live does. */
  standby: Owner | null
  routed: Record<string, number>
  error: string | null
  /** Whether codex threads can be given an https origin (null: no certificate). */
  tls: { caPath: string; source: TlsMaterial['source'] } | null
  /** Live per-thread https ports, thread → port. */
  scopedPorts: Record<string, number>
  /** Where the byte path runs: its own utility process (that pid, respawned `restarts` times), or this process. */
  process: { mode: 'child' | 'in-process'; pid: number; restarts: number }
}

/** Exits inside this window that send the gateway back into the main process. */
const EXIT_WINDOW_MS = 60_000
const EXITS_BEFORE_FALLBACK = 3
/** The services the gateway routes, whose accounts the child mirrors. */
const ROUTED: ServiceId[] = ['claude-code', 'codex']

interface ChildState {
  link: GatewayChildLink
  calls: Calls<ChildCall>
  /** The start message went out: later state goes as messages, not in it. */
  sent: boolean
  ready: boolean
  timer: NodeJS.Timeout | null
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  settled: boolean
}

function deferred(): Deferred {
  const d = { settled: false } as Deferred
  d.promise = new Promise<void>((resolve) => {
    d.resolve = () => {
      d.settled = true
      resolve()
    }
  })
  return d
}

/** The seams as this process honours them: the fake provider and the owner role for isolated instances only. */
export function seamsFromEnv(env: NodeJS.ProcessEnv = process.env): StartState['seams'] {
  const isolated = !!env.TEMP_CODE_USER_DATA
  return {
    trace: env.TEMP_CODE_GATEWAY_TRACE === '1',
    fakeProviders: (isolated && env.TEMP_CODE_FAKE_PROVIDERS) || null,
    role: isolated && env.TEMP_CODE_GATEWAY_ROLE === 'owner' ? 'owner' : null
  }
}

export class GatewayHost {
  private started = false
  private stopped = false
  private port = 0
  private tls: TlsMaterial | null = null
  private owner = false
  private standby: Owner | null = null
  private stopWatching: (() => void) | null = null
  private loadError: string | null = null
  private readonly control: ControlPlane
  /** The byte path when it runs in this process. */
  private local: GatewayCore | null = null
  private child: ChildState | null = null
  /** Settled while a backend (the ready child, or `local`) serves. */
  private up = deferred()
  private readonly scoped = new Map<string, { port: number; scope: RouteScope }>()
  private readonly warm = new Map<string, RouteScope | null>()
  /** Counts of children gone, and the live child's latest. */
  private routedDone: Record<string, number> = {}
  private routedLive: Record<string, number> = {}
  private childError: string | null = null
  private childPid = 0
  private restarts = 0
  private exits: number[] = []
  private lastOut = '[]'
  private accountsTimer: NodeJS.Timeout | null = null
  private readonly now: () => number

  constructor(private readonly options: GatewayOptions) {
    this.control = options.control ?? new InProcessControl(options.hooks)
    this.now = options.now ?? Date.now
  }

  /** `http://127.0.0.1:<port>/claude` and friends, for children's base URLs. Stays valid across a respawn. */
  url(service: 'claude' | 'codex'): string | null {
    return this.started && !this.stopped && this.port ? `http://127.0.0.1:${this.port}/${service}` : null
  }

  /**
   * The base URL of a warm Claude process (drivers/warm.ts): one spawned
   * before any thread exists, so its scope cannot be in its environment.
   * `/claude/~w=<id>/…` is rewritten per request into the scope the id was
   * adopted for, and goes unscoped (the pinned account) until then. Only
   * this gateway knows the id, so the URL is always its own, never the
   * shim's.
   */
  warmClaudeUrl(id: string): string | null {
    const base = this.url('claude')
    if (!base) return null
    if (!this.warm.has(id)) {
      this.warm.set(id, null)
      this.local?.setWarm(id)
      this.post({ t: 'warm.set', id })
    }
    return `${base}/~w=${encodeURIComponent(id)}`
  }

  /**
   * The warm process `id` now belongs to the thread `scope` names. Resolves
   * once the byte path rebinds it (at once in this process; on the child's
   * word otherwise), so the adopted CLI's first request is the thread's.
   */
  adoptWarm(id: string, scope: RouteScope | null): Promise<void> {
    this.warm.set(id, scope)
    if (this.local) {
      this.local.adoptWarm(id, scope)
      return Promise.resolve()
    }
    if (!this.started || this.stopped) return Promise.resolve()
    const acked = this.onBackend(
      (core) => core.adoptWarm(id, scope),
      (child) => child.calls.call<null>({ m: 'warm.adopt', id, scope })
    ).then(
      () => true,
      () => true
    )
    const limit = this.options.adoptTimeoutMs ?? 5_000
    let timer: NodeJS.Timeout | null = null
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), limit)))
    return Promise.race([acked, late]).then((inTime) => {
      if (timer) clearTimeout(timer)
      if (!inTime) console.warn(`[gateway] warm ${id}: no word from the gateway process in ${limit} ms; the CLI goes on`)
    })
  }

  /** The warm process is gone (retired, dead, or its thread's child ended): nothing maps the id any more. */
  releaseWarm(id: string): void {
    this.warm.delete(id)
    this.local?.releaseWarm(id)
    this.post({ t: 'warm.release', id })
  }

  /** Warm ids and whether each is adopted, for status. */
  warmIds(): { id: string; thread: string | null }[] {
    return [...this.warm].map(([id, scope]) => ({ id, thread: scope?.thread ?? null }))
  }

  /** The CA a codex child must trust to reach a scoped port; null without TLS. */
  caPath(): string | null {
    return this.tls?.caPath ?? null
  }

  /**
   * An https origin of the thread's own, every request on it scoped to
   * `scope` (account and pin). The same thread keeps its port across reboots
   * of its child and respawns of the gateway; a new scope for a live thread
   * re-points the port. Null without a certificate.
   */
  async scopedCodexUrl(thread: string, scope: RouteScope): Promise<string | null> {
    if (!this.url('codex') || !this.tls) return null
    try {
      const port = await this.onBackend(
        (core) => core.scopedCodexPort(thread, scope),
        (child) => child.calls.call<number | null>({ m: 'scoped.open', thread, scope })
      )
      if (port === null) return null
      this.scoped.set(thread, { port, scope })
      return `https://127.0.0.1:${port}/codex`
    } catch (e) {
      console.warn(`[gateway] codex ${thread}: no port of its own (${(e as Error).message})`)
      return null
    }
  }

  /** Close a thread's port once its child is gone. */
  async releaseScoped(thread: string): Promise<void> {
    this.scoped.delete(thread)
    if (!this.started || this.stopped) return
    await this.onBackend(
      (core) => core.releaseScoped(thread),
      (child) => child.calls.call<null>({ m: 'scoped.close', thread })
    ).catch(() => {})
  }

  /** Open the upstream socket an account's next request will ride (preconnect.ts), in whichever process the pools live. */
  async preconnect(provider: string, account: string | null): Promise<unknown> {
    if (!this.started || this.stopped) return null
    try {
      return await this.onBackend(
        () => this.options.preconnect?.(provider, account),
        (child) => child.calls.call({ m: 'preconnect', provider, account })
      )
    } catch {
      return 'failed'
    }
  }

  /** Aliax's accounts changed (a save, a pin, a usage report): the child's copy follows. */
  accountsChanged(): void {
    if (!this.child?.sent || this.accountsTimer) return
    this.accountsTimer = setTimeout(() => {
      this.accountsTimer = null
      const child = this.child
      if (!child?.sent) return
      void this.accountsState().then((state) => {
        if (this.child !== child) return
        this.lastOut = JSON.stringify(state.out)
        child.link.wire.post({ t: 'accounts', state })
      })
    }, 100)
    this.accountsTimer.unref?.()
  }

  /** A secret landed in the vault: the child asks again for that service's credentials. */
  credentialsChanged(serviceId: ServiceId | null): void {
    this.post({ t: 'credentials.drop', service: serviceId ? PROVIDER_OF[serviceId] : null })
  }

  async start(): Promise<GatewayStatus> {
    if (this.started) return this.status()
    this.started = true
    this.tls = this.options.tls !== undefined ? this.options.tls : await this.loadTls()
    setCodexCaCertificate(this.tls?.caPath ?? null)
    if (this.options.spawnChild) this.spawn()
    else await this.runHere()
    await this.up.promise
    if (this.options.claimShim && !this.stopped) {
      this.claimIfFree()
      // Rule 4: notice Aliax or another temp-code arriving or leaving, and a dead owner on the tick.
      this.stopWatching = watchMarker(() => this.claimIfFree(), { tickMs: this.options.tickMs })
    }
    return this.status()
  }

  /**
   * Rules 3 and 4: take the marker unless another live temp-code holds it.
   * Aliax always yields to us (it serves in standby); a dead or missing
   * owner is ours to replace. The marker names this process's pid and the
   * port the byte path listens on, wherever it runs. Returns whether the
   * shim routes to us now.
   */
  claimIfFree(): boolean {
    if (!this.started || this.stopped || !this.port || !this.options.claimShim) return false
    const current = readMarker()
    const was = this.standby
    if (isLive(current) && current.pid !== process.pid && current.owner === OWNER) {
      this.standby = OWNER
      this.owner = false
    } else {
      this.standby = null
      this.owner = true
      // Our own live marker needs no rewrite; that would only wake other watchers.
      if (current?.pid !== process.pid || current.port !== this.port) {
        claim(OWNER, this.port)
        console.log(`[gateway] claimed the shim on :${this.port}${current && current.pid !== process.pid ? ` (was ${current.owner} pid ${current.pid})` : ''}`)
      }
    }
    if (was !== this.standby && this.standby) console.log(`[gateway] standby: another ${this.standby} holds the shim`)
    return this.owner
  }

  /** Hand the marker back (only ever our own) and close every socket; the child goes with it. */
  async stop(): Promise<void> {
    this.stopped = true
    this.stopWatching?.()
    this.stopWatching = null
    releaseGateway()
    this.owner = false
    this.standby = null
    if (this.accountsTimer) clearTimeout(this.accountsTimer)
    this.accountsTimer = null
    const child = this.child
    this.child = null
    if (child) {
      if (child.timer) clearTimeout(child.timer)
      child.calls.failAll(new WireGone())
      child.link.kill()
      try {
        child.link.wire.close()
      } catch {
        // already closed
      }
    }
    const local = this.local
    this.local = null
    this.up.resolve()
    setCodexCaCertificate(null)
    this.port = 0
    await local?.close()
  }

  status(): GatewayStatus {
    const here = this.local?.status()
    return {
      running: this.started && !this.stopped && this.port > 0,
      port: this.port,
      owner: this.owner,
      standby: this.standby,
      routed: sum(this.routedDone, here?.routed ?? this.routedLive),
      error: here ? (here.error ?? this.loadError) : (this.childError ?? this.loadError),
      tls: this.tls ? { caPath: this.tls.caPath, source: this.tls.source } : null,
      scopedPorts: Object.fromEntries([...this.scoped].map(([t, s]) => [t, s.port])),
      process: this.local || !this.options.spawnChild ? { mode: 'in-process', pid: process.pid, restarts: this.restarts } : { mode: 'child', pid: this.childPid, restarts: this.restarts }
    }
  }

  private async loadTls(): Promise<TlsMaterial | null> {
    if (!this.options.dataDir) return null
    try {
      const tls = await loadTls(this.options.dataDir)
      if (tls?.source === 'app') {
        console.log(`[gateway] serving https with the app's own CA (${tls.caPath}); a terminal codex pointed here needs it trusted once: ${trustHint(tls.caPath)}`)
      }
      return tls
    } catch (e) {
      this.loadError = `no TLS certificate: ${(e as Error).message}`
      console.warn(`[gateway] ${this.loadError}; codex 0.158+ cannot be routed`)
      return null
    }
  }

  /** Run `here` against the in-process core, or `there` against the ready child; a child that goes away mid-ask is asked again once the next one is up. */
  private async onBackend<T>(here: (core: GatewayCore) => T | Promise<T>, there: (child: ChildState) => Promise<T>): Promise<T> {
    for (;;) {
      if (this.stopped) throw new Error('the gateway has stopped')
      await this.up.promise
      if (this.stopped) throw new Error('the gateway has stopped')
      if (this.local) return here(this.local)
      const child = this.child
      if (!child?.ready) {
        // Settled with nothing serving: the fallback could not listen either.
        if (this.up.settled) throw new Error('the gateway is not running')
        continue
      }
      try {
        return await there(child)
      } catch (e) {
        if (!(e instanceof WireGone)) throw e
      }
    }
  }

  private post(message: WireMessage): void {
    if (this.child?.sent) this.child.link.wire.post(message)
  }

  /** The byte path in this process, on the ports the child held (if it ever ran). */
  private async runHere(): Promise<void> {
    const core = new GatewayCore({ control: this.control, tls: this.tls })
    try {
      this.port = await core.listen(this.port)
    } catch (e) {
      console.warn(`[gateway] :${this.port} is taken (${(e as Error).message}); listening on a new port`)
      this.port = await core.listen(0)
    }
    for (const [id, scope] of this.warm) core.adoptWarm(id, scope)
    for (const [thread, s] of this.scoped) {
      const port = await core.scopedCodexPort(thread, s.scope, s.port).catch(() => core.scopedCodexPort(thread, s.scope, 0))
      if (port === null) this.scoped.delete(thread)
      else s.port = port
    }
    this.local = core
    this.up.resolve()
    if (this.stopWatching) this.claimIfFree()
  }

  private spawn(): void {
    let link: GatewayChildLink
    try {
      link = this.options.spawnChild!()
    } catch (e) {
      this.childGone(null, `could not start (${(e as Error).message})`)
      return
    }
    const child: ChildState = { link, calls: new Calls<ChildCall>(link.wire), sent: false, ready: false, timer: null }
    this.child = child
    link.wire.onMessage((m) => this.fromChild(child, m))
    link.onExit((code) => this.childGone(child, `exited (${code ?? 'killed'})`))
    child.timer = setTimeout(() => {
      if (child.ready) return
      link.kill()
      this.childGone(child, `did not start in ${this.options.readyTimeoutMs ?? 15_000} ms`)
    }, this.options.readyTimeoutMs ?? 15_000)
    this.startState().then(
      (state) => {
        if (this.child !== child) return
        child.sent = true
        link.wire.post({ t: 'start', state })
      },
      (e) => {
        link.kill()
        this.childGone(child, `could not be told what to serve (${(e as Error).message})`)
      }
    )
  }

  private async startState(): Promise<StartState> {
    const accounts = await this.accountsState()
    this.lastOut = JSON.stringify(accounts.out)
    return {
      port: this.port,
      scoped: [...this.scoped].map(([thread, s]) => ({ thread, port: s.port, scope: s.scope })),
      warm: [...this.warm].map(([id, scope]) => ({ id, scope })),
      tls: this.tls ? { cert: this.tls.cert.toString(), key: this.tls.key.toString() } : null,
      seams: this.options.seams ?? seamsFromEnv(),
      mainPid: process.pid,
      accounts
    }
  }

  /** What the child's forward reads of the accounts: names, pins and reports from aliax-core, the out marks from the server. */
  private async accountsState(): Promise<AccountsState> {
    const state: AccountsState = { profiles: {}, pinned: {}, reports: {}, out: this.options.outMarks?.() ?? [] }
    for (const serviceId of ROUTED) {
      try {
        const names = await this.control.profilesKnown(serviceId)
        state.profiles[serviceId] = names
        state.pinned[serviceId] = await this.control.pinned(serviceId)
        for (const name of names) {
          const report = await this.control.usageReport(serviceId, name)
          if (report) state.reports[`${serviceId}:${name}`] = report
        }
      } catch {
        // no vault to read yet: the child knows no accounts of this service until the next push
      }
    }
    return state
  }

  private fromChild(child: ChildState, m: WireMessage): void {
    if (this.child !== child) return
    switch (m.t) {
      case 'ready': {
        child.ready = true
        if (child.timer) clearTimeout(child.timer)
        child.timer = null
        this.childPid = m.pid
        if (this.port && m.port !== this.port) console.warn(`[gateway] :${this.port} was taken; the gateway now listens on :${m.port}`)
        this.port = m.port
        for (const s of m.scoped) {
          const entry = this.scoped.get(s.thread)
          if (entry && entry.port !== s.port) {
            console.warn(`[gateway] codex ${s.thread}: :${entry.port} was taken; its port is now :${s.port}`)
            entry.port = s.port
          }
        }
        this.up.resolve()
        // A port that moved goes into the marker.
        if (this.stopWatching) this.claimIfFree()
        return
      }
      case 'stats':
        this.routedLive = m.routed
        this.childError = m.error
        return
      case 'event':
        this.onEvent(m.event)
        return
      case 'ask':
        answer(child.link.wire, m.id, () => this.answerChild(m.call as MainCall))
        return
      case 'reply':
        child.calls.settle(m)
        return
    }
  }

  private async answerChild(call: MainCall): Promise<unknown> {
    switch (call.m) {
      case 'credentialFor':
        return this.control.credentialFor(call.service, call.account)
      case 'substitute':
        return this.control.substitute(call.info)
      case 'onUnauthorized': {
        const next = await this.control.onUnauthorized(call.info)
        this.pushOut()
        return next
      }
      case 'pickNext':
        return this.control.pickNext ? this.control.pickNext(call.info) : null
      case 'usage':
        return this.control.usage(call.serviceId, call.force)
    }
  }

  private onEvent(event: ChildEvent): void {
    switch (event.e) {
      case 'response':
        this.control.onResponse({ ...event.info, headers: new Headers(event.info.headers) })
        this.pushOut()
        return
      case 'routed':
        this.control.onRouted(event.info)
        return
      case 'failedOver':
        this.control.onFailedOver(event.info)
        return
      case 'error':
        this.childError = event.message
        this.control.onError(event.message)
        return
      case 'observeLimit':
        this.control.observeLimit(event.serviceId, event.name, event.limit)
        return
      case 'pin':
        void this.control.pin(event.serviceId, event.name).then(() => this.accountsChanged())
        return
    }
  }

  /** The out marks moved (a 401 marked an account, an answer lifted one): the child's substitute gate follows. */
  private pushOut(): void {
    if (!this.child?.sent || !this.options.outMarks) return
    const out = this.options.outMarks()
    const key = JSON.stringify(out)
    if (key === this.lastOut) return
    this.lastOut = key
    this.child.link.wire.post({ t: 'out', out })
  }

  private childGone(child: ChildState | null, why: string): void {
    if (child) {
      if (this.child !== child) return
      this.child = null
      if (child.timer) clearTimeout(child.timer)
      child.calls.failAll(new WireGone())
      try {
        child.link.wire.close()
      } catch {
        // already closed
      }
      this.routedDone = sum(this.routedDone, this.routedLive)
      this.routedLive = {}
    }
    if (this.stopped) return
    if (this.up.settled) this.up = deferred()
    const now = this.now()
    this.exits = [...this.exits.filter((t) => now - t < EXIT_WINDOW_MS), now]
    if (this.exits.length >= EXITS_BEFORE_FALLBACK) {
      console.warn(`[gateway] the gateway process ${why}, ${this.exits.length} times in a minute: the gateway runs in the main process from here on`)
      this.runHere().catch((e) => {
        this.loadError = `the gateway could not listen: ${(e as Error).message}`
        console.error(`[gateway] ${this.loadError}`)
        this.up.resolve()
      })
      return
    }
    this.restarts++
    console.warn(`[gateway] the gateway process${this.childPid ? ` ${this.childPid}` : ''} ${why}; respawning${this.port ? ` on :${this.port}` : ''}`)
    this.spawn()
  }
}

function sum(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v
  return out
}

let current: GatewayHost | null = null

/** The running gateway, for drivers that need its URL. */
export const gateway = (): GatewayHost | null => current

export async function startGateway(options: GatewayOptions): Promise<GatewayHost> {
  current = new GatewayHost(options)
  await current.start()
  return current
}

/**
 * Rule 5: give the marker back on the way out. Synchronous, so it fits an
 * `exit` handler; core only touches a marker that names this very process,
 * and restores Aliax's when that pid still runs.
 */
export function releaseGateway(): void {
  try {
    release(OWNER)
  } catch {
    // a stuck marker only means shells route nowhere until Aliax reclaims; not fatal on the way out
  }
}
