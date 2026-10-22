import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { z, ZodError } from 'zod'
import type { Principal } from '@shared/capabilities'
import type { SessionRegistry } from '../sessions'
import type { RemoteAuth } from './auth'
import { decodeAgentId, encodeAgentId } from '@shared/contract-crosshost'
import { RELAY_FACADE_MS, relayState, type RelayPrincipal } from '@shared/contract-relay'
import { FACADE_TOOLS, FacadeError, callFacade, hostRowOf, selfHostRow, type FacadeContext, type HostRow, type SessionRow } from './facade'
import { HttpError, type RequestContext } from './listener'
import type { RelayFacadeHosts } from './relay'

/**
 * `/mcp` on the fixed port: the Model Context Protocol over streamable
 * HTTP, for bots (Grok, ChatGPT) that drive threads through the facade.
 * One POST carries one JSON-RPC message (or a batch) and gets its answer
 * in the response — as JSON, or as a one-event SSE stream when the client
 * accepts only that. There is no server-initiated stream (GET answers
 * 405, as the spec allows) and no session state: the Mcp-Session-Id a
 * client gets at initialize is accepted back and never required, so a
 * connector that reconnects at will keeps working.
 *
 * Auth is a key made for bots (audience `mcp`, capped at read+operate):
 * `x-api-key: tc_…` or `Authorization: Bearer tc_…`. A `client` key is
 * refused with the reason, so a phone's key pasted into a bot explains
 * itself. Bodies are capped, calls are rate limited per key, and with
 * TEMP_CODE_REMOTE_TRACE=1 every call logs one line.
 */

export const MCP_MAX_BODY = 256 * 1024
/** Token bucket per key: this many calls a minute, refilled continuously. */
export const MCP_RATE_PER_MINUTE = 120
export const MCP_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
] as const
export const MCP_SERVER_NAME = 'temp-code'

const TRACE = process.env.TEMP_CODE_REMOTE_TRACE === '1'
const log = (line: string): void => console.log(`[remote] ${line}`)

export const INSTRUCTIONS = [
  'temp-code runs coding agents (Claude, Codex) in threads called sessions, each inside a repo.',
  'Flow: list_projects → start_session(repo, prompt) → get_session / get_transcript to watch → send_message to steer → list_pending + respond when it asks a question → get_diff to see the result → stop_session / archive_session.',
  'Status is working | waiting | failed | done. A waiting session has a pending prompt: a question you can answer with respond, or a permission request only the user can approve in the app (this key cannot; relay it instead).',
  'Transcript pages are bounded; page older with before=firstSeq and newer with after=lastSeq.',
  'Hosts: list_projects names every host reachable from here with its state; a session id of the form env_…:id lives on that host and routes there.'
].join(' ')

export interface McpHandlerOptions {
  auth: RemoteAuth
  registry: SessionRegistry
  version: string
  /** The public origin for the links in answers, resolved per call. */
  origin: () => string | null
  /** This host's environment id: stamped on every row as `host`, and what a `host` argument naming it routes to. */
  environmentId?: string
  hostName?: string
  /** The relayed hosts (remote/relay.ts): a `host` argument or an env_…:id session routes the call there; the list_* tools merge every available one. */
  relay?: RelayFacadeHosts
  now?: () => number
}

// ── routing a tool across hosts ─────────────────────────────────────────

export interface ToolDeps {
  environmentId: string
  hostName?: string
  relay?: RelayFacadeHosts
  /** The box key as a relayed host sees it. */
  principal: RelayPrincipal
  /** callFacade on this host. */
  local: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

type Target = { kind: 'local' } | { kind: 'remote'; envId: string }

/** `host` as an environment id or a row's name (case-insensitive); this host's own id or name is local. */
function resolveHost(deps: ToolDeps, host: string): Target {
  const wanted = host.trim().toLowerCase()
  if (wanted === deps.environmentId.toLowerCase() || wanted === (deps.hostName ?? '').toLowerCase()) return { kind: 'local' }
  const row = deps.relay?.list().find((h) => h.environmentId.toLowerCase() === wanted || h.name.toLowerCase() === wanted)
  if (!row) throw new FacadeError('not_found', `no host "${host}" is known here; list_projects names the hosts`)
  return { kind: 'remote', envId: row.environmentId }
}

/** Where a call goes: its `host`, else the host its session id names, else here. `args` loses `host` and gets the plain session id. */
export function routeOf(deps: ToolDeps, rawArgs: unknown): { target: Target; args: Record<string, unknown>; explicit: boolean } {
  const args = { ...((rawArgs ?? {}) as Record<string, unknown>) }
  const host = typeof args.host === 'string' ? args.host : undefined
  delete args.host
  if (host) {
    const target = resolveHost(deps, host)
    if (target.kind === 'remote' && typeof args.session === 'string') {
      const decoded = decodeId(args.session)
      if (decoded) {
        if (decoded.environmentId !== target.envId)
          throw new FacadeError('invalid', `session "${args.session}" lives on ${decoded.environmentId}, not on host "${host}"`)
        args.session = decoded.sessionId
      }
    }
    return { target, args, explicit: true }
  }
  if (typeof args.session === 'string') {
    const decoded = decodeId(args.session)
    if (decoded) {
      args.session = decoded.sessionId
      if (decoded.environmentId === deps.environmentId) return { target: { kind: 'local' }, args, explicit: false }
      if (!deps.relay?.list().some((h) => h.environmentId === decoded.environmentId))
        throw new FacadeError('not_found', `no host "${decoded.environmentId}" is known here; list_projects names the hosts`)
      return { target: { kind: 'remote', envId: decoded.environmentId }, args, explicit: false }
    }
  }
  return { target: { kind: 'local' }, args, explicit: false }
}

function decodeId(id: string): { environmentId: string; sessionId: string } | null {
  try {
    return decodeAgentId(id)
  } catch {
    return null
  }
}

/** A relayed answer as this host's caller sees it: ids prefixed with the host, `host` stamped, `url` dropped (this host's /ui cannot open it). */
export function prefixIds(result: unknown, envId: string): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const r = { ...(result as Record<string, unknown>) }
  const enc = (id: unknown): unknown => (typeof id === 'string' ? encodeAgentId(envId, id) : id)
  const row = (x: unknown): unknown => {
    if (!x || typeof x !== 'object') return x
    const o = { ...(x as Record<string, unknown>) }
    if (typeof o.id === 'string') o.id = enc(o.id)
    o.host = envId
    delete o.url
    if (Array.isArray(o.prompts)) o.prompts = o.prompts.map((p) => prompt(p))
    return o
  }
  const prompt = (x: unknown): unknown => (x && typeof x === 'object' ? { ...(x as Record<string, unknown>), session: enc((x as { session?: unknown }).session) } : x)
  if (Array.isArray(r.sessions)) r.sessions = r.sessions.map(row)
  if (Array.isArray(r.pending)) r.pending = r.pending.map(prompt)
  if (Array.isArray(r.repos)) r.repos = r.repos.map((repo) => (repo && typeof repo === 'object' ? { ...(repo as Record<string, unknown>), host: envId } : repo))
  if (typeof r.session === 'string') r.session = enc(r.session)
  if (typeof r.id === 'string' && 'status' in r) return row(r)
  if ('url' in r && typeof r.id === 'string') delete r.url
  return r
}

const MERGED = new Set(['list_projects', 'list_sessions', 'list_pending'])
const STATUS_ORDER: Record<string, number> = { working: 0, waiting: 1, failed: 2, done: 3 }

/** Working first, then the newest activity. */
export function mergeSessions(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    return s !== 0 ? s : b.lastActivity.localeCompare(a.lastActivity)
  })
}

export interface Unavailable {
  host: string
  name: string
  reason: string
}

/** One tool call, routed: a host or an env_…:id session goes to that host; the list_* tools without a host merge every relayed host in. */
export async function runTool(deps: ToolDeps, name: string, rawArgs: unknown): Promise<unknown> {
  const { target, args, explicit } = routeOf(deps, rawArgs)
  if (target.kind === 'remote') {
    const relay = deps.relay
    if (!relay) throw new FacadeError('not_found', 'no host is reachable from here')
    const out = await relay.call(target.envId, deps.principal, name, args)
    if (!out.ok) throw new FacadeError(out.code, out.message)
    const result = prefixIds(out.result, target.envId) as Record<string, unknown>
    if (name === 'list_projects') result.hosts = hostRows(deps)
    return result
  }
  const local = (await deps.local(name, args)) as Record<string, unknown>
  if (explicit || !MERGED.has(name) || !deps.relay || (name === 'list_sessions' && args.cursor !== undefined)) return local
  const relay = deps.relay
  const hosts = relay.list()
  if (hosts.length === 0) return local
  // list_projects says a host's state in its row, so it asks only hosts that answer (a locked one does);
  // the other lists ask every host and name the ones that did not answer in `unavailable`.
  const asked = name === 'list_projects' ? hosts.filter((h) => { const s = relayState(h); return s === 'available' || s === 'locked' }) : hosts
  const answers = await Promise.all(
    asked.map(async (h) => {
      try {
        const out = await withDeadline(relay.call(h.environmentId, deps.principal, name, args), RELAY_FACADE_MS)
        return { host: h, out }
      } catch (err) {
        return { host: h, out: { ok: false as const, code: 'unavailable' as const, message: err instanceof Error ? err.message : String(err) } }
      }
    })
  )
  const unavailable: Unavailable[] = []
  const got: Record<string, unknown>[] = []
  for (const { host, out } of answers) {
    if (out.ok) got.push(prefixIds(out.result, host.environmentId) as Record<string, unknown>)
    else unavailable.push({ host: host.environmentId, name: host.name, reason: out.message })
  }
  if (name === 'list_projects') {
    return { hosts: hostRows(deps), repos: [...(local.repos as unknown[]), ...got.flatMap((g) => (g.repos as unknown[]) ?? [])] }
  }
  if (name === 'list_sessions') {
    const sessions = mergeSessions([...(local.sessions as SessionRow[]), ...got.flatMap((g) => (g.sessions as SessionRow[]) ?? [])])
    return { sessions, cursor: local.cursor ?? null, ...(unavailable.length ? { unavailable } : {}) }
  }
  return { pending: [...(local.pending as unknown[]), ...got.flatMap((g) => (g.pending as unknown[]) ?? [])], ...(unavailable.length ? { unavailable } : {}) }
}

function hostRows(deps: ToolDeps): HostRow[] {
  return [selfHostRow({ environmentId: deps.environmentId, hostName: deps.hostName }), ...(deps.relay?.list() ?? []).map(hostRowOf)]
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`unavailable: the host did not answer within ${Math.round(ms / 1000)} s`)), ms)
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

type JsonRpcId = string | number | null
interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
}
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** The key token a request carries: x-api-key first, else a bearer. */
export function tokenOf(req: IncomingMessage): string | null {
  const apiKey = header(req, 'x-api-key')?.trim()
  if (apiKey) return apiKey
  const auth = header(req, 'authorization')
  const m = auth ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null
  return m ? m[1] : null
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        // Drain the rest instead of cutting the socket, so the 413 reaches the caller.
        reject(new HttpError(413, `body too large (over ${max} bytes)`, { Connection: 'close' }))
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** A tool as `tools/list` describes it: the facade's zod input as JSON Schema plus the hints a client sorts on. */
export function describeTools(): {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: Record<string, boolean>
}[] {
  return FACADE_TOOLS.map((tool) => {
    const inputSchema = { ...(z.toJSONSchema(tool.input) as Record<string, unknown>) }
    delete inputSchema.$schema
    const read = tool.needs === 'read'
    return {
      name: tool.name,
      description: tool.description,
      inputSchema,
      annotations: {
        readOnlyHint: read,
        destructiveHint: tool.name === 'stop_session' || tool.name === 'archive_session',
        idempotentHint: read || tool.name === 'archive_session' || tool.name === 'stop_session',
        openWorldHint: false
      }
    }
  })
}

class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number
  ) {}
  /** 0 when the call may run now, else the seconds to wait. */
  take(key: string): number {
    const now = this.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, at: now }
    const refill = ((now - bucket.at) / 60_000) * this.perMinute
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + refill)
    bucket.at = now
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      this.buckets.set(key, bucket)
      return 0
    }
    this.buckets.set(key, bucket)
    return Math.max(1, Math.ceil(((1 - bucket.tokens) / this.perMinute) * 60))
  }
}

export type McpHandler = (ctx: RequestContext) => Promise<boolean>

export function createMcpHandler(options: McpHandlerOptions): McpHandler {
  const now = options.now ?? Date.now
  const limiter = new RateLimiter(MCP_RATE_PER_MINUTE, now)

  const authenticate = async (ctx: RequestContext): Promise<Principal & { kind: 'remote' }> => {
    const wait = options.auth.retryAfter(ctx.ip)
    if (wait > 0)
      throw new HttpError(429, 'too many failed attempts', { 'Retry-After': String(wait) })
    const token = tokenOf(ctx.req)
    if (!token)
      throw new HttpError(
        401,
        'credential required: send the key as x-api-key or Authorization: Bearer',
        { 'WWW-Authenticate': 'Bearer' }
      )
    const principal = await options.auth.verifyToken(token)
    if (!principal) {
      options.auth.recordFailure(ctx.ip)
      throw new HttpError(401, 'invalid or revoked key', { 'WWW-Authenticate': 'Bearer' })
    }
    if (principal.audience !== 'mcp') {
      throw new HttpError(
        403,
        `this key is for the app (audience client); /mcp takes a key made for bots (audience mcp). Make one under Settings → Remote access → New key → Bot (MCP).`
      )
    }
    return principal
  }

  const call = async (
    principal: Principal & { kind: 'remote' },
    msg: JsonRpcRequest
  ): Promise<JsonRpcResponse | null> => {
    const id = msg.id ?? null
    const isRequest = msg.id !== undefined && msg.id !== null
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return isRequest || msg.id === null
        ? {
            jsonrpc: '2.0',
            id,
            error: { code: INVALID_REQUEST, message: 'not a JSON-RPC 2.0 request' }
          }
        : null
    }
    if (!isRequest) return null // notifications (initialized, cancelled, progress) need no answer
    const params = (msg.params ?? {}) as Record<string, unknown>
    switch (msg.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : '2025-06-18'
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: MCP_SERVER_NAME, version: options.version },
            instructions: INSTRUCTIONS
          }
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: describeTools() } }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const started = now()
        const facade: FacadeContext = {
          registry: options.registry,
          principal,
          origin: options.origin(),
          ...(options.environmentId ? { environmentId: options.environmentId } : {}),
          ...(options.hostName ? { hostName: options.hostName } : {}),
          ...(options.relay ? { relay: options.relay } : {})
        }
        try {
          const result = await runTool(
            {
              environmentId: options.environmentId ?? 'local',
              hostName: options.hostName,
              relay: options.relay,
              principal: { keyId: principal.keyId, name: principal.name, audience: principal.audience, caps: principal.caps },
              local: (tool, args) => callFacade(facade, tool, args)
            },
            name,
            params.arguments ?? {}
          )
          if (TRACE) log(`mcp ${principal.keyId} ${name} ${now() - started}ms ok`)
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              structuredContent: result
            }
          }
        } catch (err) {
          // Tool failures are tool results, so the model reads the reason and acts on it.
          const text =
            err instanceof FacadeError
              ? err.message
              : err instanceof ZodError
                ? `invalid arguments: ${err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
                : err instanceof Error
                  ? err.message
                  : String(err)
          if (TRACE)
            log(`mcp ${principal.keyId} ${name} ${now() - started}ms error: ${text.slice(0, 200)}`)
          if (!(err instanceof FacadeError) && !(err instanceof ZodError))
            console.error(`[remote] mcp ${name} failed`, err)
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `error: ${text}` }], isError: true }
          }
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: METHOD_NOT_FOUND, message: `method not found: ${msg.method}` }
        }
    }
  }

  return async (ctx) => {
    if (ctx.path !== '/mcp') return false
    const { req, res } = ctx
    const method = req.method ?? 'GET'
    const principal = await authenticate(ctx)
    if (method === 'GET') {
      // No server-initiated stream: the spec lets a server answer 405 here.
      res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Length': 0 })
      res.end()
      return true
    }
    if (method === 'DELETE') {
      res.writeHead(204)
      res.end()
      return true
    }
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Length': 0 })
      res.end()
      return true
    }
    const wait = limiter.take(principal.keyId)
    if (wait > 0)
      throw new HttpError(429, `rate limit: ${MCP_RATE_PER_MINUTE} calls a minute per key`, {
        'Retry-After': String(wait)
      })
    const text = await readBody(req, MCP_MAX_BODY)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return answer(ctx, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: PARSE_ERROR, message: 'body is not JSON' }
      })
    }
    const batch = Array.isArray(parsed)
    const messages = (batch ? parsed : [parsed]) as unknown[]
    if (messages.length === 0 || messages.some((m) => !m || typeof m !== 'object')) {
      return answer(ctx, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: INVALID_REQUEST, message: 'expected a JSON-RPC message or a batch of them' }
      })
    }
    const responses: JsonRpcResponse[] = []
    let initialized = false
    for (const m of messages as JsonRpcRequest[]) {
      if (m.method === 'tools/call' && (!m.params || typeof m.params !== 'object')) {
        responses.push({
          jsonrpc: '2.0',
          id: m.id ?? null,
          error: { code: INVALID_PARAMS, message: 'tools/call needs params { name, arguments }' }
        })
        continue
      }
      const out = await call(principal, m)
      if (m.method === 'initialize' && out?.result) initialized = true
      if (out) responses.push(out)
    }
    if (responses.length === 0) {
      res.writeHead(202, { 'Content-Length': 0 })
      res.end()
      return true
    }
    const headers: Record<string, string> = initialized
      ? { 'Mcp-Session-Id': randomBytes(16).toString('hex') }
      : {}
    return answer(ctx, 200, batch ? responses : responses[0], headers)
  }
}

/** JSON by default; a one-event SSE stream when the client accepts only that. */
function answer(
  ctx: RequestContext,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): true {
  const accept = header(ctx.req, 'accept') ?? ''
  const text = JSON.stringify(body)
  const sseOnly =
    accept.includes('text/event-stream') &&
    !accept.includes('application/json') &&
    !accept.includes('*/*')
  if (sseOnly && status === 200) {
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'close',
      ...headers
    })
    ctx.res.end(`event: message\ndata: ${text}\n\n`)
    return true
  }
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers
  })
  ctx.res.end(text)
  return true
}
