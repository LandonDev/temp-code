import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { z, ZodError } from 'zod'
import type { Principal } from '@shared/capabilities'
import type { SessionRegistry } from '../sessions'
import type { RemoteAuth } from './auth'
import { FACADE_TOOLS, FacadeError, callFacade, type FacadeContext } from './facade'
import { HttpError, type RequestContext } from './listener'

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

const INSTRUCTIONS = [
  'temp-code runs coding agents (Claude, Codex) in threads called sessions, each inside a repo.',
  'Flow: list_projects → start_session(repo, prompt) → get_session / get_transcript to watch → send_message to steer → list_pending + respond when it asks a question → get_diff to see the result → stop_session / archive_session.',
  'Status is working | waiting | failed | done. A waiting session has a pending prompt: a question you can answer with respond, or a permission request only the user can approve in the app (this key cannot; relay it instead).',
  'Transcript pages are bounded; page older with before=firstSeq and newer with after=lastSeq.'
].join(' ')

export interface McpHandlerOptions {
  auth: RemoteAuth
  registry: SessionRegistry
  version: string
  /** The public origin for the links in answers, resolved per call. */
  origin: () => string | null
  now?: () => number
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
          origin: options.origin()
        }
        try {
          const result = await callFacade(facade, name, params.arguments ?? {})
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
