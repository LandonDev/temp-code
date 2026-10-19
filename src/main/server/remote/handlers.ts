import { hostname } from 'node:os'
import type { ClientRequest } from '@shared/contract'
import { CONTRACT_VERSION, type Capability } from '@shared/capabilities'
import type { RemoteStatus } from '@shared/contract-remote'
import type { Store } from '../db'
import type { RemoteAuth } from './auth'

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
}

const KEYS = {
  enabled: 'remote.enabled',
  port: 'remote.port',
  publicOrigin: 'remote.publicOrigin',
  learnedOrigin: 'remote.learnedOrigin'
} as const

export function readRemoteSettings(store: Pick<Store, 'getSetting'>): RemoteSettings {
  const port = Number(store.getSetting(KEYS.port))
  return {
    enabled: store.getSetting(KEYS.enabled) !== '0',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : REMOTE_DEFAULT_PORT,
    publicOrigin: store.getSetting(KEYS.publicOrigin) ?? '',
    learnedOrigin: store.getSetting(KEYS.learnedOrigin)
  }
}

export function writeRemoteSettings(
  store: Pick<Store, 'setSetting'>,
  patch: Partial<Pick<RemoteSettings, 'enabled' | 'port' | 'publicOrigin' | 'learnedOrigin'>>
): void {
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
  /** The live listener's state; `port` is 0 while it is off. */
  status: () => { running: boolean; port: number; error: string | null }
  /** Settings changed: start, stop or move the listener. */
  onSettingsChanged?: () => void
  /** The caller's own caps; a key never widens its creator. Absent for the local socket. */
  ceiling?: Capability[]
  createdBy?: string
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
    port: settings.port,
    running: live.running,
    error: live.error,
    origin: pairingOrigin(settings, live.port),
    publicOrigin: settings.publicOrigin,
    learnedOrigin: settings.learnedOrigin,
    contract: CONTRACT_VERSION
  }
}

export async function handleRemote(req: ClientRequest, ctx: RemoteContext): Promise<Handled> {
  const createdBy = ctx.createdBy ?? 'local'
  switch (req.method) {
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
    default:
      return { handled: false }
  }
}
