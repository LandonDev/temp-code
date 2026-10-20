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
  /** Minutes a working thread may stay silent before the notifier calls it stuck. */
  stuckMinutes: number
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const CapabilitySchema = z.enum(['read', 'operate', 'approve', 'admin'])
export const AudienceSchema = z.enum(['client', 'mcp'])
const Id = z.object({ id: z.string().min(1) })
/** The notices a key's webhook may subscribe to (remote/notifier.ts). */
export const WebhookEventSchema = z.enum(['needs_you', 'finished', 'failed', 'stuck'])
export type WebhookEvent = z.infer<typeof WebhookEventSchema>
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = WebhookEventSchema.options

/** `POST /api/keys`, `remote.keys.create`, and (with ttlMinutes) pairings. */
export const NewClientSchema = z.object({
  name: z.string().min(1).max(80),
  audience: AudienceSchema,
  caps: z.array(CapabilitySchema),
  /** A webhook of the key's own: the hub payload, signed with the secret (generated when absent). */
  webhookUrl: z.string().min(1).max(500).optional(),
  webhookSecret: z.string().min(8).max(200).optional(),
  events: z.array(WebhookEventSchema).min(1).optional()
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
      publicOrigin: z.string().max(200).optional(),
      /** Minutes a working thread may stay silent before the notifier calls it stuck. */
      stuckMinutes: z.number().int().min(1).max(1440).optional()
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
  /** The key's own webhook, if it has one; the secret is never listed. */
  webhookUrl: string | null
  events: WebhookEvent[] | null
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

// ── Saved environments (thread K1, the connection runtime) ────────────────
// The desktop keeps the hosts it connects to. The raw key lives in the main
// process only (settings table, `remote.environments.<id>`); the renderer
// sees the environment without it and asks the main process for a ticket.

export const RouteKindSchema = z.enum(['loopback', 'lan', 'tunnel'])
export type RouteKind = z.infer<typeof RouteKindSchema>

/** One way to reach an environment: the WebSocket URL (`wss://host/ws`). */
export const SavedRouteSchema = z.object({
  url: z.string().min(1).max(300),
  kind: RouteKindSchema
})
export type SavedRoute = z.infer<typeof SavedRouteSchema>

export interface SavedEnvironment {
  /** The host's own environment id, read from its `/api/hello` when added. */
  id: string
  name: string
  /** Best first: the driver connects over the first route that works. */
  routes: SavedRoute[]
  addedAt: number
  /** What the saved key may do on the host, as its `/api/hello` said when added. */
  caps: z.infer<typeof CapabilitySchema>[]
  /** The key's name on the host's client list. */
  keyName: string
  /** Public key id; lets clients notice a saved credential replacement. */
  keyId?: string
}

export const EnvironmentRequestSchemas = [
  request('remote.environments.list', z.object({}).optional()),
  /** → SavedEnvironment. `url` is the host's origin (`https://host`) or socket URL. */
  request(
    'remote.environments.add',
    z.object({
      url: z.string().min(1).max(300),
      key: z.string().min(4).max(200),
      name: z.string().max(80).optional(),
      kind: RouteKindSchema.optional()
    })
  ),
  request(
    'remote.environments.update',
    z.object({
      id: z.string().min(1),
      name: z.string().min(1).max(80).optional(),
      routes: z.array(SavedRouteSchema).min(1).max(8).optional()
    })
  ),
  request('remote.environments.remove', Id),
  /** → SavedEnvironment. A pairing link (`https://host/pair#code`), or an origin and a code,
   *  exchanged for a key on the host (`POST /api/pair`, kind `key`) and saved like `add`. */
  request(
    'remote.environments.pair',
    z.object({
      link: z.string().min(1).max(400).optional(),
      origin: z.string().min(1).max(300).optional(),
      code: z.string().min(1).max(40).optional(),
      name: z.string().max(80).optional(),
      kind: RouteKindSchema.optional()
    })
  ),
  /** → { ticket, expiresIn }: a 30 s single-use ticket for `url`, minted with the saved key. */
  request('remote.environments.ticket', z.object({ id: z.string().min(1), url: z.string().min(1) }))
] as const
