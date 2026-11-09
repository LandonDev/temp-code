import { answer, Calls, type Wire } from '../gatewayWire'
import {
  ADDON_GRANT_TIMEOUT_MS,
  type AddonChildCall,
  type AddonLaunch,
  type AddonMainCall,
  type AddonStartState,
  type AddonWireMessage,
  type ResolvedGrant
} from './addonWire'
import { Downstream, errorResult, redact, type DownstreamDeps } from './downstream'

/**
 * The add-on host's side of the wire, in its utility process (plan
 * section 3): one Downstream per launch, kept in step with main's launch
 * set, each asking main for its grant over the wire. A client's fault stays
 * that client's: Downstream catches its own work, a client that throws on
 * creation reads failed, and an error that escapes everything is logged
 * redacted and ends the process (main respawns it).
 */

export type DownstreamLike = Pick<Downstream, 'start' | 'close' | 'restart' | 'grantsDropped' | 'call'>

export interface AddonChildDeps {
  /** How the process ends when main is gone. */
  exit?: () => void
  /** Checks main's pid this often; 0 turns the watch off (tests). */
  watchMainMs?: number
  /** Test seams passed to every Downstream (short backoff, a fetch). */
  downstream?: Partial<Pick<DownstreamDeps, 'backoffMs' | 'stableMs' | 'connectTimeoutMs' | 'fetch'>>
  /** Makes one client; tests replace it. */
  make?: (deps: DownstreamDeps) => DownstreamLike
}

export interface AddonChild {
  stop(): Promise<void>
  /** An error nothing caught: one redacted line; a client it names reads failed, anything else ends the process. */
  uncaught(error: unknown): void
  /** The ids running now (tests). */
  running(): string[]
}

export function runAddonChild(wire: Wire<AddonWireMessage>, deps: AddonChildDeps = {}): AddonChild {
  const exit = deps.exit ?? (() => process.exit(0))
  const calls = new Calls<AddonMainCall, AddonWireMessage>(wire, (method, ms) => new Error(`${method}_timeout: the app did not answer in ${Math.round(ms / 1000)} s`))
  const clients = new Map<string, { launch: AddonLaunch; down: DownstreamLike }>()
  const controllers = new Map<string, AbortController>()
  /** Every grant value this process was handed: an uncaught error's line is redacted with them. */
  const secrets = new Set<string>()
  let state: AddonStartState | null = null
  let label = '[addons]'

  const event = (e: Extract<AddonWireMessage, { t: 'event' }>['event']) => wire.post({ t: 'event', event: e })
  const failed = (launch: AddonLaunch, detail: string) => event({ e: 'status', addonId: launch.id, status: { state: 'failed', tools: 0, detail, at: Date.now() } })

  const askGrant = async (addonId: string): Promise<ResolvedGrant> => {
    const grant = await calls.call<ResolvedGrant>({ m: 'grant', addonId }, { timeoutMs: ADDON_GRANT_TIMEOUT_MS })
    if (grant.ok) for (const v of [...Object.values(grant.env), ...Object.values(grant.headers)]) secrets.add(v)
    return grant
  }

  const open = (launch: AddonLaunch): void => {
    const s = state!
    const made: DownstreamDeps = {
      launch,
      baseEnv: s.baseEnv,
      cwd: s.cwd,
      grant: () => askGrant(launch.id),
      status: (status) => event({ e: 'status', addonId: launch.id, status }),
      tools: (specDigest, tools) => event({ e: 'tools', addonId: launch.id, specDigest, tools }),
      unauthorized: () => event({ e: 'unauthorized', addonId: launch.id }),
      log: (line) => console.log(`${label} ${line}`),
      trace: s.trace,
      ...deps.downstream
    }
    try {
      const down = (deps.make ?? ((d) => new Downstream(d)))(made)
      clients.set(launch.id, { launch, down })
      down.start()
    } catch (error) {
      clients.delete(launch.id)
      failed(launch, `The add-on's client failed: ${redact(firstLine(error), secrets)}`)
    }
  }

  const close = (id: string): void => {
    const client = clients.get(id)
    if (!client) return
    clients.delete(id)
    void client.down.close().catch(() => {})
  }

  const reconcile = (launches: AddonLaunch[]): void => {
    const next = new Map(launches.map((l) => [l.id, l]))
    for (const [id, client] of [...clients]) {
      const want = next.get(id)
      if (!want || want.specDigest !== client.launch.specDigest) close(id)
    }
    for (const launch of launches) if (!clients.has(launch.id)) open(launch)
  }

  const start = (s: AddonStartState): void => {
    state = s
    label = `[addons:${process.pid}]`
    reconcile(s.launches)
    wire.post({ t: 'ready', pid: process.pid })
    const watchMs = deps.watchMainMs ?? 5_000
    if (watchMs > 0) {
      setInterval(() => {
        try {
          process.kill(s.mainPid, 0)
        } catch {
          exit()
        }
      }, watchMs).unref()
    }
  }

  const run = async (call: AddonChildCall): Promise<unknown> => {
    switch (call.m) {
      case 'call': {
        const client = clients.get(call.addonId)
        if (!client) return errorResult(`The add-on ${call.addonId} does not run on this host`)
        const abort = new AbortController()
        controllers.set(call.callId, abort)
        try {
          return await client.down.call(call.tool, call.arguments, { signal: abort.signal, timeoutMs: call.timeoutMs })
        } finally {
          controllers.delete(call.callId)
        }
      }
      case 'cancel':
        controllers.get(call.callId)?.abort()
        return null
      case 'restart':
        await clients.get(call.addonId)?.down.restart()
        return null
    }
  }

  wire.onMessage((message) => {
    switch (message.t) {
      case 'start':
        start(message.state)
        return
      case 'launches':
        if (state) reconcile(message.launches)
        return
      case 'grants.drop':
        for (const [id, client] of clients) if (message.addonId === null || message.addonId === id) void client.down.grantsDropped()
        return
      case 'ask':
        answer(wire, message.id, () => run(message.call as AddonChildCall))
        return
      case 'reply':
        calls.settle(message)
        return
    }
  })
  wire.onClose(exit)

  return {
    stop: async () => {
      await Promise.all([...clients.keys()].map((id) => clients.get(id)!.down.close().catch(() => {})))
      clients.clear()
    },
    uncaught: (error) => {
      const line = redact(`${(error as Error)?.stack ?? String(error)}`, secrets)
      console.error(`${label} uncaught: ${line.split('\n').slice(0, 6).join(' | ')}`)
      const named = [...clients.values()].find((c) => line.includes(c.launch.id))
      if (named) {
        clients.delete(named.launch.id)
        void named.down.close().catch(() => {})
        failed(named.launch, `The add-on's client failed: ${firstLine(line)}`)
        return
      }
      exit()
    },
    running: () => [...clients.keys()]
  }
}

const firstLine = (error: unknown): string => String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 300)
