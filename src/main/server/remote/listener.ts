import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { hostname } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import { remoteDeflateOptions } from '../wire'
import { ZodError } from 'zod'
import { CONTRACT_VERSION, allows, type Principal } from '@shared/capabilities'
import { NewClientSchema, NewPairingSchema, PairBodySchema } from '@shared/contract-remote'
import type { Store } from '../db'
import { COOKIE_NAME, RemoteAuth, RemoteAuthError, SESSION_TTL_MS, type Verified } from './auth'
import { pairingOrigin, readRemoteSettings, writeRemoteSettings } from './handlers'

/**
 * The fixed loopback port behind the Cloudflare tunnel (plan 5jtfkIC45Cbr).
 * TLS ends at Cloudflare; everything here is plain http on 127.0.0.1, and
 * the proxy's `CF-Connecting-IP` / `X-Forwarded-Proto` are believed only
 * because the socket itself is loopback. The route table is the plan's:
 * hello and pairing are public, tickets take a bearer key, management
 * takes admin, the WebSocket upgrade takes a ticket or the session cookie,
 * and `/ui`, `/pair`, `/asset/*` go to the ui handler (ui.ts).
 */

/** TEMP_CODE_REMOTE_TRACE=1: one log line per request on top of the auth decisions. */
const TRACE = process.env.TEMP_CODE_REMOTE_TRACE === '1'
const MAX_BODY = 1024 * 1024
const PING_MS = 30_000
const MISSED_PONGS = 2

const log = (line: string): void => console.log(`[remote] ${line}`)

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  /** Path without the query. */
  path: string
  query: URLSearchParams
  /** The caller as the proxy reports it, else the socket's address. */
  ip: string
  /** `https` when the proxy says so, else `http`. */
  proto: 'http' | 'https'
  host: string
  /** `<proto>://<host>`: what a same-site Origin header must equal. */
  origin: string
  /** The cookie or bearer principal, resolved once per request. A bad credential throws 401. */
  principal: () => Promise<Verified | null>
  /** Set-Cookie for a session value (or clear it with null). */
  setCookie: (value: string | null) => void
}

/** The ui handler's contract (ui.ts): true when it answered the request. */
export type UiHandler = (ctx: RequestContext) => Promise<boolean>

export interface RemoteListenerOptions {
  /** 0 asks for an ephemeral port (tests). */
  port: number
  auth: RemoteAuth
  store: Store
  environmentId: string
  version: string
  attach: (ws: WebSocket, principal: Principal) => void
  ui?: UiHandler
}

export interface RemoteListener {
  /** The bound port; 0 when the listener failed to bind. */
  port: number
  error: string | null
  /** Live contract sockets, by key id. */
  sockets: Map<string, Set<WebSocket>>
  close: () => Promise<void>
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message)
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const isLoopbackHost = (host: string): boolean => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** The parts of a request every route reads, with the proxy headers trusted only from loopback. */
export function describeRequest(req: IncomingMessage, fallbackPort: number): Omit<RequestContext, 'res' | 'principal' | 'setCookie'> {
  const url = new URL(req.url ?? '/', 'http://x')
  const fromLoopback = LOOPBACK.has(req.socket.remoteAddress ?? '')
  const cfIp = fromLoopback ? header(req, 'cf-connecting-ip') : undefined
  const forwardedProto = fromLoopback ? header(req, 'x-forwarded-proto') : undefined
  const host = header(req, 'host') || `127.0.0.1:${fallbackPort}`
  const proto: 'http' | 'https' = forwardedProto?.split(',')[0].trim() === 'https' ? 'https' : 'http'
  return {
    req,
    path: url.pathname,
    query: url.searchParams,
    ip: cfIp?.trim() || req.socket.remoteAddress || 'unknown',
    proto,
    host,
    origin: `${proto}://${host}`
  }
}

export function sessionCookie(value: string | null, secure: boolean): string {
  const base = `${COOKIE_NAME}=${value ?? ''}; Path=/; HttpOnly; SameSite=Lax`
  const age = value === null ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  return `${base}; ${age}${secure ? '; Secure' : ''}`
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

/** A bare 404: nothing that names the app. */
export function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 9 })
  res.end('not found')
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HttpError(400, 'body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

export async function startRemoteListener(options: RemoteListenerOptions): Promise<RemoteListener> {
  const { auth, store, attach } = options
  const sockets = new Map<string, Set<WebSocket>>()
  // Every socket here is a remote client: permessage-deflate as wire.ts
  // sizes it, and attach() gives the principal the remote profile.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: remoteDeflateOptions() })
  let boundPort = 0

  /** The proxy's view of this host, remembered for pairing links. */
  const learnOrigin = (ctx: Pick<RequestContext, 'host' | 'origin' | 'req'>): void => {
    if (!LOOPBACK.has(ctx.req.socket.remoteAddress ?? '') || isLoopbackHost(ctx.host)) return
    if (!header(ctx.req, 'x-forwarded-proto')) return
    if (readRemoteSettings(store).learnedOrigin !== ctx.origin) writeRemoteSettings(store, { learnedOrigin: ctx.origin })
  }

  const refuseLimited = (ctx: Pick<RequestContext, 'ip'>): void => {
    const wait = auth.retryAfter(ctx.ip)
    if (wait > 0) throw new HttpError(429, 'too many failed attempts', { 'Retry-After': String(wait) })
  }

  /** The caller must be same-site when it rides on the ambient cookie. */
  const checkOrigin = (ctx: RequestContext, verified: Verified | null): void => {
    if (!verified?.session) return
    const origin = header(ctx.req, 'origin')
    if (origin !== undefined && origin !== ctx.origin) throw new HttpError(403, 'cross-site request refused')
  }

  const requireClient = (verified: Verified | null): Verified => {
    if (!verified) throw new HttpError(401, 'credential required')
    if (verified.principal.audience !== 'client') throw new HttpError(403, 'mcp keys use /mcp')
    return verified
  }
  const requireAdmin = async (ctx: RequestContext): Promise<Verified> => {
    refuseLimited(ctx)
    const verified = requireClient(await ctx.principal())
    if (ctx.req.method !== 'GET') checkOrigin(ctx, verified)
    if (!allows(verified.principal.caps, 'admin')) throw new HttpError(403, 'admin required')
    return verified
  }

  const route = async (ctx: RequestContext): Promise<void> => {
    const { req, res, path } = ctx
    const method = req.method ?? 'GET'
    if (path === '/healthz' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 2, 'Cache-Control': 'no-store' })
      return void res.end('ok')
    }
    if (path === '/api/hello' && method === 'GET') {
      let verified: Verified | null = null
      try {
        verified = await ctx.principal()
      } catch {
        /* a bad credential still gets the public answer */
      }
      const p = verified?.principal
      return json(res, 200, {
        environmentId: options.environmentId,
        name: hostname(),
        version: options.version,
        contract: CONTRACT_VERSION,
        ...(p ? { key: { id: p.keyId, name: p.name, caps: p.caps, audience: p.audience } } : {})
      })
    }
    if (path === '/api/pair' && method === 'POST') {
      refuseLimited(ctx)
      const body = PairBodySchema.parse(await readJson(req))
      let out
      try {
        out = await auth.exchange(body.code, { ...body, userAgent: header(req, 'user-agent') ?? null })
      } catch (err) {
        if (err instanceof RemoteAuthError && err.status === 401) auth.recordFailure(ctx.ip)
        throw err
      }
      if (out.kind === 'key') {
        log(`pair: key ${out.key.id} (${out.key.name}, ${out.key.caps.join(',')}) issued to ${ctx.ip}`)
        return json(res, 200, { key: out.token, keyId: out.key.id, name: out.key.name, caps: out.key.caps, audience: out.key.audience, environmentId: options.environmentId })
      }
      log(`pair: session ${out.session.id} on key ${out.key.id} (${out.key.name}) for ${ctx.ip}`)
      ctx.setCookie(out.cookie)
      return json(res, 200, { caps: out.session.caps, environmentId: options.environmentId })
    }
    if (path === '/api/ticket' && method === 'POST') {
      refuseLimited(ctx)
      const verified = requireClient(await ctx.principal())
      if (verified.session) throw new HttpError(400, 'tickets are for bearer keys; the cookie upgrades /ws directly')
      return json(res, 200, auth.mintTicket(verified.principal))
    }
    if (path === '/api/logout' && method === 'POST') {
      const verified = await ctx.principal()
      checkOrigin(ctx, verified)
      if (verified?.session) auth.revokeSession(verified.session.id)
      ctx.setCookie(null)
      return json(res, 200, { ok: true })
    }
    if (path.startsWith('/api/keys')) {
      const verified = await requireAdmin(ctx)
      const id = path.slice('/api/keys/'.length)
      if (path === '/api/keys' && method === 'GET') return json(res, 200, auth.listKeys())
      if (path === '/api/keys' && method === 'POST') {
        const body = NewClientSchema.parse(await readJson(req))
        const created = await auth.createKey({ ...body, createdBy: verified.principal.keyId, ceiling: verified.principal.caps })
        log(`key ${created.key.id} (${body.name}, ${created.key.caps.join(',')}) created by ${verified.principal.keyId}`)
        return json(res, 200, created)
      }
      if (id && method === 'DELETE') {
        const ok = auth.revokeKey(id)
        if (ok) log(`key ${id} revoked by ${verified.principal.keyId}`)
        return json(res, ok ? 200 : 404, { ok })
      }
    }
    if (path.startsWith('/api/pairings')) {
      const verified = await requireAdmin(ctx)
      const id = path.slice('/api/pairings/'.length)
      if (path === '/api/pairings' && method === 'GET') return json(res, 200, auth.listPairings())
      if (path === '/api/pairings' && method === 'POST') {
        const { ttlMinutes, ...body } = NewPairingSchema.parse(await readJson(req))
        const { pairing, code } = auth.createPairing({ ...body, createdBy: verified.principal.keyId, ceiling: verified.principal.caps, ttlMs: ttlMinutes ? ttlMinutes * 60_000 : undefined })
        const origin = pairingOrigin(readRemoteSettings(store), boundPort)
        return json(res, 200, { pairing, code, url: `${origin}/pair#${code}`, expiresAt: pairing.expiresAt })
      }
      if (id && method === 'DELETE') return json(res, 200, { ok: auth.revokePairing(id) })
    }
    if (path.startsWith('/api/sessions')) {
      await requireAdmin(ctx)
      const id = path.slice('/api/sessions/'.length)
      if (path === '/api/sessions' && method === 'GET') return json(res, 200, auth.listSessions())
      if (id && method === 'DELETE') return json(res, 200, { ok: auth.revokeSession(id) })
    }
    if (options.ui && (await options.ui(ctx))) return
    notFound(res)
  }

  const server = createServer((req, res) => {
    const base = describeRequest(req, boundPort)
    let verified: Promise<Verified | null> | null = null
    const ctx: RequestContext = {
      ...base,
      res,
      principal: () => (verified ??= auth.principalFor({ authorization: header(req, 'authorization'), cookie: header(req, 'cookie') }, base.ip)),
      setCookie: (value) => res.setHeader('Set-Cookie', sessionCookie(value, base.proto === 'https'))
    }
    learnOrigin(ctx)
    if (TRACE) log(`${req.method} ${base.path} from ${base.ip} (${base.origin})`)
    void route(ctx)
      .then(async () => {
        // A cookie that slid past its daily mark goes back out renewed.
        const v = verified ? await verified.catch(() => null) : null
        if (v?.session?.renewed && !res.headersSent) ctx.setCookie(header(req, 'cookie')!.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))?.[1] ?? null)
      })
      .catch((err: unknown) => {
        if (res.headersSent) return res.end()
        if (err instanceof HttpError) {
          if (err.status === 401 || err.status === 429) log(`${err.status} ${req.method} ${base.path} from ${base.ip}: ${err.message}`)
          return json(res, err.status, { error: err.message }, err.headers)
        }
        if (err instanceof RemoteAuthError) {
          if (err.status === 401) log(`401 ${req.method} ${base.path} from ${base.ip}: ${err.message}`)
          return json(res, err.status, { error: err.message })
        }
        if (err instanceof ZodError) return json(res, 400, { error: `bad request: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` })
        console.error('[remote] request failed', err)
        json(res, 500, { error: err instanceof Error ? err.message : 'internal error' })
      })
  })

  const refuseUpgrade = (socket: Duplex, status: number, text: string): void => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  server.on('upgrade', (req, socket, head) => {
    const base = describeRequest(req, boundPort)
    void (async () => {
      if (base.path !== '/ws') return refuseUpgrade(socket, 404, 'Not Found')
      if (auth.retryAfter(base.ip) > 0) return refuseUpgrade(socket, 429, 'Too Many Requests')
      let principal: (Principal & { kind: 'remote' }) | null = null
      const ticket = base.query.get('ticket')
      if (ticket) {
        principal = auth.consumeTicket(ticket)
        if (!principal) auth.recordFailure(base.ip)
      } else {
        let verified: Verified | null = null
        try {
          verified = await auth.principalFor({ cookie: header(req, 'cookie') }, base.ip)
        } catch {
          verified = null
        }
        if (verified?.session) {
          const origin = header(req, 'origin')
          if (origin !== undefined && origin !== base.origin) {
            log(`upgrade refused from ${base.ip}: origin ${origin} is not ${base.origin}`)
            return refuseUpgrade(socket, 403, 'Forbidden')
          }
          principal = verified.principal
        }
      }
      if (!principal) {
        log(`upgrade refused from ${base.ip}: no valid ticket or session`)
        return refuseUpgrade(socket, 401, 'Unauthorized')
      }
      if (principal.audience !== 'client') return refuseUpgrade(socket, 403, 'Forbidden')
      wss.handleUpgrade(req, socket, head, (ws) => {
        const keyId = principal.keyId
        let set = sockets.get(keyId)
        if (!set) sockets.set(keyId, (set = new Set()))
        set.add(ws)
        let missed = 0
        ws.on('pong', () => (missed = 0))
        const timer = setInterval(() => {
          if (missed >= MISSED_PONGS) return ws.terminate()
          missed++
          ws.ping()
        }, PING_MS)
        ws.on('close', () => {
          clearInterval(timer)
          set.delete(ws)
          if (set.size === 0) sockets.delete(keyId)
          log(`socket closed: key ${keyId} (${principal.name})`)
        })
        log(`socket open: key ${keyId} (${principal.name}, ${principal.caps.join(',')}) from ${base.ip}`)
        attach(ws, principal)
      })
    })().catch((err) => {
      console.error('[remote] upgrade failed', err)
      refuseUpgrade(socket, 500, 'Internal Server Error')
    })
  })

  const offRevoke = auth.onRevoke((keyId) => {
    for (const ws of sockets.get(keyId) ?? []) ws.close(4001, 'key revoked')
  })
  const sweep = setInterval(() => auth.sweep(), 60_000)
  sweep.unref()

  const close = async (): Promise<void> => {
    offRevoke()
    clearInterval(sweep)
    for (const set of sockets.values()) for (const ws of set) ws.terminate()
    sockets.clear()
    if (boundPort === 0) return
    await new Promise<void>((ok) => server.close(() => ok()))
    server.closeAllConnections?.()
  }

  server.requestTimeout = 0
  server.headersTimeout = 0
  server.setTimeout(0)
  try {
    await new Promise<void>((ok, bad) => {
      server.once('error', bad)
      server.listen(options.port, '127.0.0.1', ok)
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const error = code === 'EADDRINUSE' ? `port ${options.port} is in use` : (err as Error).message
    log(`not listening: ${error}`)
    return { port: 0, error, sockets, close }
  }
  const address = server.address()
  boundPort = typeof address === 'object' && address ? address.port : 0
  log(`listening on 127.0.0.1:${boundPort}`)
  return { port: boundPort, error: null, sockets, close }
}
