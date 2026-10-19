import { z } from 'zod'

// Remote access (plan 5jtfkIC45Cbr): the `remote.*` RPCs the desktop
// settings pane uses. All admin; the loopback socket is implicitly admin.

export interface RemoteStatus {
  environmentId: string
  name: string
  enabled: boolean
  /** The port the listener is on now (0 while off): the setting, or TEMP_CODE_REMOTE_PORT's override. */
  port: number
  /** The remote.port setting the pane edits. */
  configuredPort: number
  running: boolean
  /** Why the listener is not running, when it should be. */
  error: string | null
  /** The pairing link base: configured, else learned from the proxy, else loopback. */
  origin: string
  publicOrigin: string
  learnedOrigin: string | null
  contract: number
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const CapabilitySchema = z.enum(['read', 'operate', 'approve', 'admin'])
export const AudienceSchema = z.enum(['client', 'mcp'])
const Id = z.object({ id: z.string().min(1) })
/** `POST /api/keys`, `remote.keys.create`, and (with ttlMinutes) pairings. */
export const NewClientSchema = z.object({
  name: z.string().min(1).max(80),
  audience: AudienceSchema,
  caps: z.array(CapabilitySchema)
})
const NewClient = NewClientSchema
export const NewPairingSchema = NewClientSchema.extend({ ttlMinutes: z.number().int().min(1).max(1440).optional() })
/** `POST /api/pair`: redeem a code for a key or a browser session. */
export const PairBodySchema = z.object({
  code: z.string().min(1).max(40),
  kind: z.enum(['key', 'session']),
  name: z.string().max(80).optional(),
  caps: z.array(CapabilitySchema).optional()
})

export const RemoteRequestSchemas = [
  request('remote.status', z.object({}).optional()),
  request('remote.keys.list', z.object({}).optional()),
  /** → { key, token }: the only time the secret is readable. */
  request('remote.keys.create', NewClient),
  request('remote.keys.revoke', Id),
  /** → { pairing, code, url }. */
  request('remote.pairings.create', NewPairingSchema),
  request('remote.pairings.list', z.object({}).optional()),
  request('remote.pairings.revoke', Id),
  request('remote.sessions.list', z.object({}).optional()),
  request('remote.sessions.revoke', Id),
  request(
    'remote.settings.set',
    z.object({
      enabled: z.boolean().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      publicOrigin: z.string().max(200).optional()
    })
  )
] as const

export type RemoteAudience = 'client' | 'mcp'

/** One row of the Clients list: a phone, a bot or a browser. */
export interface RemoteKey {
  id: string
  name: string
  audience: RemoteAudience
  caps: import('./capabilities').Capability[]
  /** `bearer` holds a hashed secret; `browser` rows exist only to anchor cookie sessions. */
  kind: 'bearer' | 'browser'
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  createdBy: string
}

export interface RemotePairing {
  id: string
  name: string
  audience: RemoteAudience
  caps: import('./capabilities').Capability[]
  createdAt: number
  expiresAt: number
  consumedAt: number | null
  consumedBy: string | null
}

export interface RemoteSession {
  id: string
  keyId: string
  keyName: string
  caps: import('./capabilities').Capability[]
  userAgent: string | null
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}
