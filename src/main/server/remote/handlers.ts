import { hostname } from 'node:os'
import type { ClientRequest } from '@shared/contract'
import { CONTRACT_VERSION, type Capability } from '@shared/capabilities'
import type { RemoteStatus } from '@shared/contract-remote'
import type { Store } from '../db'
import type { RemoteAuth } from './auth'
import type { PushRegistry } from './push'
import { STUCK_MINUTES_DEFAULT } from './notifier'
import { addEnvironment, listEnvironments, mintTicket, pairEnvironment, removeEnvironment, updateEnvironment } from './environments'

/** The remote listener's fixed loopback port behind the Cloudflare tunnel. */
export const REMOTE_DEFAULT_PORT = 7677

/** What the settings table says about the listener. */
export interface RemoteSettings {
  enabled: boolean
  port: number
  /** The pairing link base the user typed; empty means "learn it from the proxy". */
  publicOrigin: string
  /** The last `X-Forwarded-Proto` + `Host` the proxy sent. */
  learnedOrigin: string | null
  /** Minutes a working thread may stay silent before the notifier calls it stuck. */
  stuckMinutes: number
}

const KEYS = {
  enabled: 'remote.enabled',
  port: 'remote.port',
  publicOrigin: 'remote.publicOrigin',
  learnedOrigin: 'remote.learnedOrigin',
  stuckMinutes: 'remote.stuckMinutes'
} as const

export function readRemoteSettings(store: Pick<Store, 'getSetting'>): RemoteSettings {
  const port = Number(store.getSetting(KEYS.port))
  const stuck = Number(store.getSetting(KEYS.stuckMinutes))
  return {
    enabled: store.getSetting(KEYS.enabled) !== '0',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : REMOTE_DEFAULT_PORT,
    publicOrigin: store.getSetting(KEYS.publicOrigin) ?? '',
    learnedOrigin: store.getSetting(KEYS.learnedOrigin),
    stuckMinutes: Number.isInteger(stuck) && stuck > 0 ? stuck : STUCK_MINUTES_DEFAULT
  }
}

export function writeRemoteSettings(
  store: Pick<Store, 'setSetting'>,
  patch: Partial<Pick<RemoteSettings, 'enabled' | 'port' | 'publicOrigin' | 'learnedOrigin' | 'stuckMinutes'>>
): void {
  if (patch.stuckMinutes !== undefined) store.setSetting(KEYS.stuckMinutes, String(patch.stuckMinutes))
  if (patch.enabled !== undefined) store.setSetting(KEYS.enabled, patch.enabled ? '1' : '0')
  if (patch.port !== undefined) store.setSetting(KEYS.port, String(patch.port))
  if (patch.publicOrigin !== undefined) store.setSetting(KEYS.publicOrigin, patch.publicOrigin.trim().replace(/\/+$/, '') || null)
  if (patch.learnedOrigin !== undefined) store.setSetting(KEYS.learnedOrigin, patch.learnedOrigin)
}

/** The base pairing links use: configured, else learned from the proxy, else loopback. */
export function pairingOrigin(settings: RemoteSettings, port: number): string {
  return settings.publicOrigin || settings.learnedOrigin || `http://127.0.0.1:${port || settings.port}`
}

/** What the `remote.*` RPCs reach. */
export interface RemoteContext {
  environmentId: string
  auth: RemoteAuth
  store: Store
  /** The phones' push registrations (thread L6). */
  push: PushRegistry
  /** The live listener's state; `port` is 0 while it is off. */
  status: () => { running: boolean; port: number; error: string | null }
  /** Settings changed: start, stop or move the listener. */
  onSettingsChanged?: () => void
  /** The caller's own caps; a key never widens its creator. Absent for the local socket. */
  ceiling?: Capability[]
  createdBy?: string
  /** Test seam for the calls to other hosts (hello, ticket). */
  fetch?: typeof fetch
}

type Handled = { handled: true; result: unknown } | { handled: false }
const result = (value: unknown): Handled => ({ handled: true, result: value })

export function remoteStatus(ctx: RemoteContext): RemoteStatus {
  const settings = readRemoteSettings(ctx.store)
  const live = ctx.status()
  return {
    environmentId: ctx.environmentId,
    name: hostname(),
    enabled: settings.enabled,
    port: live.running ? live.port : 0,
    configuredPort: settings.port,
    running: live.running,
    error: live.error,
    origin: pairingOrigin(settings, live.port),
    publicOrigin: settings.publicOrigin,
    learnedOrigin: settings.learnedOrigin,
    contract: CONTRACT_VERSION,
    stuckMinutes: settings.stuckMinutes
  }
}

/** The key a push call is for: the caller's own. The local socket has none. */
function pushKey(ctx: RemoteContext): string {
  if (!ctx.createdBy) throw new Error('push registration needs a paired key')
  return ctx.createdBy
}

export async function handleRemote(req: ClientRequest, ctx: RemoteContext): Promise<Handled> {
  const createdBy = ctx.createdBy ?? 'local'
  switch (req.method) {
    case 'remote.push.register':
      return result(await ctx.push.register(pushKey(ctx), req.params))
    case 'remote.push.unregister':
      return result(await ctx.push.unregister(pushKey(ctx)))
    case 'remote.push.status':
      return result(ctx.push.status(pushKey(ctx)))
    case 'remote.push.activity':
      await ctx.push.setActivity(pushKey(ctx), req.params)
      return result(null)
    case 'remote.status':
      return result(remoteStatus(ctx))
    case 'remote.keys.list':
      return result(ctx.auth.listKeys())
    case 'remote.keys.create':
      return result(await ctx.auth.createKey({ ...req.params, createdBy, ceiling: ctx.ceiling }))
    case 'remote.keys.revoke':
      return result(ctx.auth.revokeKey(req.params.id))
    case 'remote.pairings.create': {
      const { ttlMinutes, ...rest } = req.params
      const { pairing, code } = ctx.auth.createPairing({
        ...rest,
        createdBy,
        ceiling: ctx.ceiling,
        ttlMs: ttlMinutes ? ttlMinutes * 60_000 : undefined
      })
      const origin = pairingOrigin(readRemoteSettings(ctx.store), ctx.status().port)
      return result({ pairing, code, url: `${origin}/pair#${code}` })
    }
    case 'remote.pairings.list':
      return result(ctx.auth.listPairings())
    case 'remote.pairings.revoke':
      return result(ctx.auth.revokePairing(req.params.id))
    case 'remote.sessions.list':
      return result(ctx.auth.listSessions())
    case 'remote.sessions.revoke':
      return result(ctx.auth.revokeSession(req.params.id))
    case 'remote.settings.set':
      writeRemoteSettings(ctx.store, req.params)
      ctx.onSettingsChanged?.()
      return result(remoteStatus(ctx))
    case 'remote.environments.list':
      return result(listEnvironments(ctx.store))
    case 'remote.environments.add':
      return result(await addEnvironment(hostContext(ctx), req.params))
    case 'remote.environments.update':
      return result(updateEnvironment(ctx.store, req.params))
    case 'remote.environments.remove':
      return result(removeEnvironment(ctx.store, req.params.id))
    case 'remote.environments.pair':
      return result(await pairEnvironment(hostContext(ctx), req.params))
    case 'remote.environments.ticket':
      return result(await mintTicket(hostContext(ctx), req.params.id, req.params.url))
    default:
      return { handled: false }
  }
}

const hostContext = (ctx: RemoteContext) => ({
  store: ctx.store,
  environmentId: ctx.environmentId,
  ...(ctx.fetch ? { fetch: ctx.fetch } : {})
})
