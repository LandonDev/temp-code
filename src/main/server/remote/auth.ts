import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  allows,
  isCapability,
  normalizeCaps,
  type Capability,
  type Principal
} from '@shared/capabilities'
import {
  WEBHOOK_EVENTS,
  type RemoteKey,
  type RemotePairing,
  type RemoteSession,
  type WebhookEvent
} from '@shared/contract-remote'
import { checkWebhookUrl, loopbackWebhooksAllowed, type WebhookTarget } from './webhooks'
import type { GuardOptions } from './addressGuard'

/**
 * Who may reach the fixed port, and how (plan 5jtfkIC45Cbr). Pure logic
 * over the three remote_* tables: keys (scrypt-hashed bearer secrets with a
 * capability set), pairings (one-time codes that exchange for a key or a
 * browser session no wider than the pairer allowed), sessions (the cookie
 * behind /ui), plus in-memory tickets, the verified-token memo and the
 * failure limiter. No http here: listener.ts turns requests into calls.
 */

export type Audience = 'client' | 'mcp'
export const AUDIENCES: readonly Audience[] = ['client', 'mcp']
export const isAudience = (v: unknown): v is Audience => v === 'client' || v === 'mcp'

/** Thrown for a caller's mistake; the listener maps `status` onto the response. */
/** The refusal of a browser session for a bot (MCP) pairing. The pair page
 *  matches it to redeem the same code as a key instead (pairPage.ts). */
export const SESSION_NEEDS_CLIENT = 'only client pairings open a browser session'

export class RemoteAuthError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export const KEY_PREFIX = 'tc_'
export const COOKIE_NAME = 'tc_session'
export const TICKET_TTL_MS = 30_000
export const PAIRING_TTL_MS = 10 * 60_000
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000
/** A session older than this since its last touch gets its 30 days again. */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60_000
export const FAILURE_LIMIT = 10
export const FAILURE_WINDOW_MS = 10 * 60_000
/** The widest set an `mcp` key may hold: bots never approve or administer. */
export const MCP_CEILING: readonly Capability[] = ['read', 'operate']

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const scryptHash = (secret: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(secret, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)))
  )

/** 10 Crockford base32 chars (50 bits): key ids and pairing codes. */
export function crockfordId(length = 10): string {
  let out = ''
  for (let i = 0; i < length; i++) out += CROCKFORD[randomInt(32)]
  return out
}

/** `XXXXX-XXXXX` as shown; case, dashes and the I/L/O look-alikes are forgiven on the way back. */
export const formatPairingCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/I|L/g, '1').replace(/O/g, '0')
}

const capsToText = (caps: Iterable<string>): string => normalizeCaps(caps).join(',')
const capsFromText = (text: string): Capability[] => normalizeCaps(text.split(',').filter(isCapability))
const intersect = (a: Capability[], b: Capability[]): Capability[] =>
  normalizeCaps(a.filter((cap) => allows(b, cap)))

/**
 * Caps a key of `audience` may hold under `ceiling` (the pairing's or the
 * creator's own caps, where admin covers all). Anything over either limit
 * is a 400, never a silent narrowing.
 */
export function checkCeiling(audience: Audience, caps: Capability[], ceiling?: Capability[], ceilingName = 'this pairing'): Capability[] {
  const normalized = normalizeCaps(caps)
  if (audience === 'mcp') {
    const over = normalized.filter((cap) => !allows(MCP_CEILING, cap))
    if (over.length > 0) throw new RemoteAuthError(400, `mcp keys cannot hold ${over.join(', ')}`)
  }
  if (ceiling) {
    const over = normalized.filter((cap) => !allows(ceiling, cap))
    if (over.length > 0) throw new RemoteAuthError(400, `${ceilingName} cannot hold ${over.join(', ')}`)
  }
  return normalized
}

interface KeyRow {
  id: string
  name: string
  audience: Audience
  caps: string
  hash: string | null
  salt: string | null
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
  created_by: string
  webhook_url: string | null
  webhook_secret: string | null
  events: string | null
}
interface PairingRow {
  id: string
  code_hash: string
  name: string
  audience: Audience
  caps: string
  created_at: number
  expires_at: number
  consumed_at: number | null
  consumed_by: string | null
}
interface SessionRow {
  id: string
  key_id: string
  secret_hash: string
  caps: string
  user_agent: string | null
  created_at: number
  last_seen_at: number
  expires_at: number
  revoked_at: number | null
}

const keyOf = (r: KeyRow): RemoteKey => ({
  id: r.id,
  name: r.name,
  audience: r.audience,
  caps: capsFromText(r.caps),
  kind: r.hash ? 'bearer' : 'browser',
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  createdBy: r.created_by,
  webhookUrl: r.webhook_url,
  events: r.events ? (r.events.split(',') as WebhookEvent[]) : null
})
const pairingOf = (r: PairingRow): RemotePairing => ({
  id: r.id,
  name: r.name,
  audience: r.audience,
  caps: capsFromText(r.caps),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  consumedAt: r.consumed_at,
  consumedBy: r.consumed_by
})

interface Ticket {
  keyId: string
  expiresAt: number
}

export interface Verified {
  principal: Principal & { kind: 'remote' }
  /** The browser session behind a cookie caller, with whether its cookie should be re-set. */
  session?: { id: string; renewed: boolean }
}

export interface RemoteAuthOptions {
  now?: () => number
  /** Test seam for the webhook target lookup (addressGuard.ts). */
  resolveHost?: GuardOptions['resolve']
}

/** The webhook columns a new key gets, and the secret made for it when the caller gave none. */
async function checkWebhook(
  input: { webhookUrl?: string; webhookSecret?: string; events?: WebhookEvent[] },
  resolve: GuardOptions['resolve']
): Promise<{
  row: { webhook_url: string | null; webhook_secret: string | null; events: string | null }
  generated: string | null
}> {
  const url = input.webhookUrl?.trim()
  if (!url) {
    if (input.webhookSecret || input.events) throw new RemoteAuthError(400, 'a webhook secret or events need a webhookUrl')
    return { row: { webhook_url: null, webhook_secret: null, events: null }, generated: null }
  }
  let checked: string
  try {
    checked = await checkWebhookUrl(url, { allowLoopback: loopbackWebhooksAllowed(), ...(resolve ? { resolve } : {}) })
  } catch (err) {
    throw new RemoteAuthError(400, (err as Error).message)
  }
  const events = input.events?.length ? input.events : [...WEBHOOK_EVENTS]
  for (const event of events) {
    if (!WEBHOOK_EVENTS.includes(event)) throw new RemoteAuthError(400, `unknown event "${event}"; events are ${WEBHOOK_EVENTS.join(', ')}`)
  }
  if (input.webhookSecret !== undefined && input.webhookSecret.length < 8) throw new RemoteAuthError(400, 'webhookSecret needs at least 8 characters')
  const generated = input.webhookSecret ? null : randomBytes(32).toString('hex')
  return {
    row: { webhook_url: checked, webhook_secret: input.webhookSecret ?? generated, events: [...new Set(events)].join(',') },
    generated
  }
}

export class RemoteAuth {
  private readonly now: () => number
  /** sha256(token) → key id, so a key pays scrypt once per process; dropped on revoke. */
  private readonly memo = new Map<string, string>()
  private readonly tickets = new Map<string, Ticket>()
  private readonly failures = new Map<string, number[]>()
  private readonly revokeListeners = new Set<(keyId: string) => void>()
  /** last_used_at is written at most once a minute per key. */
  private readonly touched = new Map<string, number>()

  constructor(
    private readonly db: DatabaseSync,
    options: RemoteAuthOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.resolveHost = options.resolveHost
  }
  private readonly resolveHost: GuardOptions['resolve']

  // ── keys ──────────────────────────────────────────────────────────────

  private keyRow(id: string): KeyRow | null {
    return (this.db.prepare(`SELECT * FROM remote_keys WHERE id = ?`).get(id) as KeyRow | undefined) ?? null
  }

  private insertKey(
    row: Omit<KeyRow, 'last_used_at' | 'revoked_at' | 'webhook_url' | 'webhook_secret' | 'events'> &
      Partial<Pick<KeyRow, 'webhook_url' | 'webhook_secret' | 'events'>>
  ): void {
    this.db
      .prepare(
        `INSERT INTO remote_keys (id, name, audience, caps, hash, salt, created_at, created_by, webhook_url, webhook_secret, events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.name, row.audience, row.caps, row.hash, row.salt, row.created_at, row.created_by, row.webhook_url ?? null, row.webhook_secret ?? null, row.events ?? null)
  }

  private freshKeyId(): string {
    for (;;) {
      const id = crockfordId()
      if (!this.keyRow(id)) return id
    }
  }

  /** A bearer key. The returned token is the only time the secret exists in the clear. */
  async createKey(input: {
    name: string
    audience: Audience
    caps: Capability[]
    createdBy: string
    /** A webhook of the key's own (remote/webhooks.ts); the secret is generated when absent and returned once. */
    webhookUrl?: string
    webhookSecret?: string
    events?: WebhookEvent[]
    /** The creator's own caps when it is not local: a key never widens its creator. */
    ceiling?: Capability[]
  }): Promise<{ key: RemoteKey; token: string; webhookSecret?: string }> {
    const name = input.name.trim()
    if (!name) throw new RemoteAuthError(400, 'name is required')
    if (!isAudience(input.audience)) throw new RemoteAuthError(400, 'audience must be client or mcp')
    const caps = checkCeiling(input.audience, input.caps, input.ceiling, 'your key')
    const id = this.freshKeyId()
    const secret = randomBytes(32).toString('base64url')
    const salt = randomBytes(16).toString('hex')
    const hash = (await scryptHash(secret, salt)).toString('hex')
    const webhook = await checkWebhook(input, this.resolveHost)
    this.insertKey({ id, name, audience: input.audience, caps: capsToText(caps), hash, salt, created_at: this.now(), created_by: input.createdBy, ...webhook.row })
    return {
      key: keyOf(this.keyRow(id)!),
      token: `${KEY_PREFIX}${id}.${secret}`,
      ...(webhook.generated ? { webhookSecret: webhook.generated } : {})
    }
  }

  /** The key row a browser session hangs off: no secret, shown as kind `browser`. */
  private createBrowserKey(input: { name: string; audience: Audience; caps: Capability[]; createdBy: string }): RemoteKey {
    const id = this.freshKeyId()
    this.insertKey({ id, name: input.name, audience: input.audience, caps: capsToText(input.caps), hash: null, salt: null, created_at: this.now(), created_by: input.createdBy })
    return keyOf(this.keyRow(id)!)
  }

  listKeys(options: { includeRevoked?: boolean } = {}): RemoteKey[] {
    const rows = this.db
      .prepare(`SELECT * FROM remote_keys ${options.includeRevoked ? '' : 'WHERE revoked_at IS NULL'} ORDER BY created_at DESC`)
      .all() as unknown as KeyRow[]
    return rows.map(keyOf)
  }

  getKey(id: string): RemoteKey | null {
    const row = this.keyRow(id)
    return row ? keyOf(row) : null
  }

  /** The live keys whose webhook wants `event`, with the secrets the notifier signs with. */
  webhookTargets(event: WebhookEvent): WebhookTarget[] {
    const rows = this.db
      .prepare(`SELECT * FROM remote_keys WHERE revoked_at IS NULL AND webhook_url IS NOT NULL AND webhook_secret IS NOT NULL`)
      .all() as unknown as KeyRow[]
    return rows
      .filter((r) => (r.events ?? '').split(',').includes(event))
      .map((r) => ({ keyId: r.id, name: r.name, url: r.webhook_url!, secret: r.webhook_secret! }))
  }

  /** Revokes the key, every session on it and every memo entry; listeners close its sockets. */
  revokeKey(id: string): boolean {
    const row = this.keyRow(id)
    if (!row || row.revoked_at) return false
    const now = this.now()
    this.db.prepare(`UPDATE remote_keys SET revoked_at = ? WHERE id = ?`).run(now, id)
    this.db.prepare(`UPDATE remote_sessions SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL`).run(now, id)
    for (const [digest, keyId] of this.memo) if (keyId === id) this.memo.delete(digest)
    for (const [digest, ticket] of this.tickets) if (ticket.keyId === id) this.tickets.delete(digest)
    for (const listener of this.revokeListeners) listener(id)
    return true
  }

  onRevoke(listener: (keyId: string) => void): () => void {
    this.revokeListeners.add(listener)
    return () => this.revokeListeners.delete(listener)
  }

  private touchKey(id: string): void {
    const now = this.now()
    if ((this.touched.get(id) ?? 0) > now - 60_000) return
    this.touched.set(id, now)
    this.db.prepare(`UPDATE remote_keys SET last_used_at = ? WHERE id = ?`).run(now, id)
  }

  private principalOf(row: KeyRow, caps = capsFromText(row.caps)): Principal & { kind: 'remote' } {
    return { kind: 'remote', keyId: row.id, name: row.name, audience: row.audience, caps }
  }

  /** `tc_<keyId>.<secret>` → the key's principal, or null. One scrypt per key per process. */
  async verifyToken(token: string): Promise<(Principal & { kind: 'remote' }) | null> {
    if (!token.startsWith(KEY_PREFIX)) return null
    const dot = token.indexOf('.')
    if (dot < 0) return null
    const id = token.slice(KEY_PREFIX.length, dot)
    const secret = token.slice(dot + 1)
    if (!id || !secret) return null
    const digest = sha256(token)
    const row = this.keyRow(id)
    if (!row || row.revoked_at || !row.hash || !row.salt) return null
    if (this.memo.get(digest) !== id) {
      const expected = Buffer.from(row.hash, 'hex')
      const actual = await scryptHash(secret, row.salt)
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
      // The row may have been revoked while scrypt ran.
      if (this.keyRow(id)?.revoked_at) return null
      this.memo.set(digest, id)
    }
    this.touchKey(id)
    return this.principalOf(row)
  }

  // ── pairings ──────────────────────────────────────────────────────────

  createPairing(input: {
    name: string
    audience: Audience
    caps: Capability[]
    createdBy: string
    ceiling?: Capability[]
    ttlMs?: number
  }): { pairing: RemotePairing; code: string } {
    const name = input.name.trim()
    if (!name) throw new RemoteAuthError(400, 'name is required')
    if (!isAudience(input.audience)) throw new RemoteAuthError(400, 'audience must be client or mcp')
    const caps = checkCeiling(input.audience, input.caps, input.ceiling, 'your key')
    const ttl = Math.min(Math.max(input.ttlMs ?? PAIRING_TTL_MS, 60_000), 24 * 60 * 60_000)
    const code = crockfordId()
    const id = crockfordId()
    const now = this.now()
    this.db
      .prepare(`INSERT INTO remote_pairings (id, code_hash, name, audience, caps, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, sha256(code), name, input.audience, capsToText(caps), now, now + ttl)
    return { pairing: pairingOf(this.pairingRow(id)!), code: formatPairingCode(code) }
  }

  private pairingRow(id: string): PairingRow | null {
    return (this.db.prepare(`SELECT * FROM remote_pairings WHERE id = ?`).get(id) as PairingRow | undefined) ?? null
  }

  /** Open pairings: not consumed, not expired. */
  listPairings(): RemotePairing[] {
    const rows = this.db
      .prepare(`SELECT * FROM remote_pairings WHERE consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC`)
      .all(this.now()) as unknown as PairingRow[]
    return rows.map(pairingOf)
  }

  revokePairing(id: string): boolean {
    return (
      this.db.prepare(`DELETE FROM remote_pairings WHERE id = ? AND consumed_at IS NULL`).run(id).changes > 0
    )
  }

  /** Drop expired and consumed rows older than a day; the listener runs it on a timer. */
  sweep(): void {
    const now = this.now()
    this.db.prepare(`DELETE FROM remote_pairings WHERE expires_at < ? OR consumed_at < ?`).run(now - 24 * 60 * 60_000, now - 24 * 60 * 60_000)
    this.db.prepare(`DELETE FROM remote_sessions WHERE expires_at < ? OR revoked_at < ?`).run(now, now - 24 * 60 * 60_000)
    for (const [digest, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(digest)
    for (const [ip, times] of this.failures) {
      const live = times.filter((t) => t > now - FAILURE_WINDOW_MS)
      if (live.length === 0) this.failures.delete(ip)
      else this.failures.set(ip, live)
    }
  }

  /** The row a code names while it is still redeemable, else null. */
  private openPairing(code: string): PairingRow | null {
    const row = this.db.prepare(`SELECT * FROM remote_pairings WHERE code_hash = ?`).get(sha256(normalizePairingCode(code))) as
      | PairingRow
      | undefined
    if (!row || row.consumed_at || row.expires_at <= this.now()) return null
    return row
  }

  /**
   * Redeem a code. `key` answers a bearer token (the one response that ever
   * carries a raw secret); `session` answers a browser session. Requested
   * caps may only narrow the pairing's; asking for more fails before the
   * code is consumed.
   */
  async exchange(
    code: string,
    request:
      | { kind: 'key'; name?: string; caps?: string[] }
      | { kind: 'session'; name?: string; caps?: string[]; userAgent?: string | null }
  ): Promise<
    | { kind: 'key'; key: RemoteKey; token: string }
    | { kind: 'session'; key: RemoteKey; session: RemoteSession; cookie: string }
  > {
    const row = this.openPairing(code)
    if (!row) throw new RemoteAuthError(401, 'invalid or expired pairing code')
    const ceiling = capsFromText(row.caps)
    const caps = request.caps ? checkCeiling(row.audience, normalizeCaps(request.caps), ceiling) : ceiling
    const name = request.name?.trim() || row.name
    const createdBy = `pairing:${row.id}`
    if (request.kind === 'session' && row.audience !== 'client')
      throw new RemoteAuthError(400, SESSION_NEEDS_CLIENT)
    // One compare-and-consume claims the code before anything is minted, so
    // N concurrent redeems answer one key and N-1 refusals (R2 M1); the
    // claim is released if minting throws.
    const claim = `claim:${randomBytes(8).toString('hex')}`
    const now = this.now()
    const claimed =
      this.db
        .prepare(`UPDATE remote_pairings SET consumed_at = ?, consumed_by = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`)
        .run(now, claim, row.id, now).changes === 1
    if (!claimed) throw new RemoteAuthError(401, 'invalid or expired pairing code')
    const stamp = (keyId: string): void => {
      this.db.prepare(`UPDATE remote_pairings SET consumed_by = ? WHERE id = ? AND consumed_by = ?`).run(keyId, row.id, claim)
    }
    try {
      if (request.kind === 'key') {
        const created = await this.createKey({ name, audience: row.audience, caps, createdBy })
        stamp(created.key.id)
        return { kind: 'key', ...created }
      }
      const key = this.createBrowserKey({ name, audience: row.audience, caps, createdBy })
      stamp(key.id)
      const session = this.createSession(key.id, caps, request.userAgent ?? null)
      return { kind: 'session', key, ...session }
    } catch (err) {
      this.db.prepare(`UPDATE remote_pairings SET consumed_at = NULL, consumed_by = NULL WHERE id = ? AND consumed_by = ?`).run(row.id, claim)
      throw err
    }
  }

  /** The key a consumed pairing became, for the proof that a code mints once. */
  consumedBy(pairingId: string): string | null {
    return this.pairingRow(pairingId)?.consumed_by ?? null
  }

  // ── sessions ──────────────────────────────────────────────────────────

  private sessionRow(id: string): SessionRow | null {
    return (this.db.prepare(`SELECT * FROM remote_sessions WHERE id = ?`).get(id) as SessionRow | undefined) ?? null
  }

  private sessionOf(r: SessionRow): RemoteSession {
    const key = this.keyRow(r.key_id)
    return {
      id: r.id,
      keyId: r.key_id,
      keyName: key?.name ?? r.key_id,
      caps: capsFromText(r.caps),
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at
    }
  }

  /** A cookie session on `keyId`; the cookie value is `<id>.<secret>`. */
  createSession(keyId: string, caps: Capability[], userAgent: string | null): { session: RemoteSession; cookie: string } {
    const key = this.keyRow(keyId)
    if (!key || key.revoked_at) throw new RemoteAuthError(401, 'unknown key')
    const id = crockfordId(16)
    const secret = randomBytes(32).toString('base64url')
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO remote_sessions (id, key_id, secret_hash, caps, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, keyId, sha256(secret), capsToText(intersect(caps, capsFromText(key.caps))), userAgent, now, now, now + SESSION_TTL_MS)
    return { session: this.sessionOf(this.sessionRow(id)!), cookie: `${id}.${secret}` }
  }

  /** The principal behind a cookie value, sliding the expiry once a day; null when it is not live. */
  verifyCookie(value: string): Verified | null {
    const dot = value.indexOf('.')
    if (dot < 0) return null
    const id = value.slice(0, dot)
    const row = this.sessionRow(id)
    const now = this.now()
    if (!row || row.revoked_at || row.expires_at <= now) return null
    const expected = Buffer.from(row.secret_hash, 'hex')
    const actual = Buffer.from(sha256(value.slice(dot + 1)), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    const key = this.keyRow(row.key_id)
    if (!key || key.revoked_at) return null
    let renewed = false
    if (now - row.last_seen_at > SESSION_RENEW_AFTER_MS) {
      renewed = true
      this.db.prepare(`UPDATE remote_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`).run(now, now + SESSION_TTL_MS, id)
    }
    this.touchKey(key.id)
    // The snapshot never exceeds the key's current caps.
    const caps = intersect(capsFromText(row.caps), capsFromText(key.caps))
    return { principal: { ...this.principalOf(key, caps), sessionId: id }, session: { id, renewed } }
  }

  listSessions(): RemoteSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM remote_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`)
      .all(this.now()) as unknown as SessionRow[]
    return rows.map((r) => this.sessionOf(r))
  }

  revokeSession(id: string): boolean {
    const row = this.sessionRow(id)
    if (!row || row.revoked_at) return false
    this.db.prepare(`UPDATE remote_sessions SET revoked_at = ? WHERE id = ?`).run(this.now(), id)
    // A browser-only key with no live session left is spent: revoke it so
    // the Clients list does not keep a row nothing can use.
    const key = this.keyRow(row.key_id)
    const live = this.db.prepare(`SELECT COUNT(*) AS n FROM remote_sessions WHERE key_id = ? AND revoked_at IS NULL AND expires_at > ?`).get(row.key_id, this.now()) as { n: number }
    if (key && !key.hash && live.n === 0) this.revokeKey(key.id)
    else for (const listener of this.revokeListeners) listener(row.key_id)
    return true
  }

  // ── tickets ───────────────────────────────────────────────────────────

  /** A 30-second single-use ticket for one WebSocket upgrade; only tickets ever ride in a URL. */
  mintTicket(principal: Principal & { kind: 'remote' }): { ticket: string; expiresIn: number } {
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(sha256(ticket), { keyId: principal.keyId, expiresAt: this.now() + TICKET_TTL_MS })
    return { ticket, expiresIn: TICKET_TTL_MS / 1000 }
  }

  /** The principal a ticket names, consuming it; the key is re-read so a revoke in the window counts. */
  consumeTicket(ticket: string): (Principal & { kind: 'remote' }) | null {
    const digest = sha256(ticket)
    const entry = this.tickets.get(digest)
    this.tickets.delete(digest)
    if (!entry || entry.expiresAt <= this.now()) return null
    const row = this.keyRow(entry.keyId)
    if (!row || row.revoked_at) return null
    this.touchKey(row.id)
    return this.principalOf(row)
  }

  // ── failure limiter ───────────────────────────────────────────────────

  /** Seconds the caller must wait, or 0 when it may try. */
  retryAfter(ip: string): number {
    const now = this.now()
    const live = (this.failures.get(ip) ?? []).filter((t) => t > now - FAILURE_WINDOW_MS)
    if (live.length < FAILURE_LIMIT) return 0
    return Math.max(1, Math.ceil((live[live.length - FAILURE_LIMIT] + FAILURE_WINDOW_MS - now) / 1000))
  }

  recordFailure(ip: string): void {
    const now = this.now()
    const live = (this.failures.get(ip) ?? []).filter((t) => t > now - FAILURE_WINDOW_MS)
    live.push(now)
    this.failures.set(ip, live)
  }

  // ── requests ──────────────────────────────────────────────────────────

  /**
   * The principal a request carries: a bearer token, else the session
   * cookie. `null` means no credential; a bad one throws 401 and counts as
   * a failure for `ip`.
   */
  async principalFor(headers: { authorization?: string; cookie?: string }, ip: string): Promise<Verified | null> {
    const auth = headers.authorization
    if (auth) {
      const m = /^Bearer\s+(\S+)$/i.exec(auth)
      const principal = m ? await this.verifyToken(m[1]) : null
      if (!principal) {
        this.recordFailure(ip)
        throw new RemoteAuthError(401, 'invalid key')
      }
      return { principal }
    }
    const cookie = readCookie(headers.cookie, COOKIE_NAME)
    if (cookie) {
      const verified = this.verifyCookie(cookie)
      if (!verified) throw new RemoteAuthError(401, 'session expired')
      return verified
    }
    return null
  }
}

/** One cookie's value out of a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}
