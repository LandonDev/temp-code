/**
 * A fake MCP sign-in server for the add-on grants build (plan-8YMm3ynnFZYs.md
 * §11): an OAuth authorization server and an MCP endpoint it protects, on one
 * loopback port, shaped like Mobbin's (a Supabase authorization server behind
 * a path-suffixed protected resource). oauthFlow.test.ts and
 * scripts/e2e-addon-grants.ts start it in-process:
 *
 *   /.well-known/oauth-protected-resource/mcp     the resource's metadata (404 at the root, as Mobbin)
 *   /.well-known/oauth-authorization-server/as    RFC 8414 with path insertion: issuer <origin>/as
 *   /as/register    dynamic client registration; keeps each client's redirect URIs
 *   /as/authorize   approves at once: 302 to the redirect with code + state, or the error set by deny();
 *                   refuses a redirect_uri the client did not register, exactly, as Supabase does
 *   /as/token       authorization_code with PKCE S256 checked, and refresh_token, which rotates
 *   /mcp            Streamable HTTP MCP behind a bearer check (401 + WWW-Authenticate otherwise),
 *                   tool `whoami` answering the sha256 prefix of the bearer
 *   /keyed          the same server behind X-Api-Key
 *
 * Every registration, authorize, token and MCP request is an event (and a
 * line in `logFile`); `issued()` is every secret it handed out or saw (codes,
 * verifiers, tokens, client secrets, the key), for a proof to search logs for.
 */
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export interface FakeOAuthOptions {
  /** 0 (default): any free port */
  port?: number
  /** access token lifetime in seconds (default 3600) */
  lifetimeSec?: number
  /** list S256 in code_challenge_methods_supported (default true) */
  s256?: boolean
  /** offer a registration_endpoint (default true) */
  registration?: boolean
  /** list offline_access and the refresh_token grant (default true) */
  offlineAccess?: boolean
  /** issue refresh tokens (default true) */
  refreshTokens?: boolean
  /** /mcp answers 401 without a bearer (default true); false answers without any sign-in */
  challenge?: boolean
  /** a client_secret in each registration's answer (default false) */
  clientSecret?: boolean
  /** /keyed's X-Api-Key */
  apiKey?: string
  /** the authorization_code grant answers 400 with an error_description that echoes the code and the verifier */
  exchangeError?: boolean
  /** a strict server: a new code exchange ends every earlier refresh token of that client (default false) */
  oneGrantPerClient?: boolean
  logFile?: string
}

export type FakeOAuthEvent =
  | { at: number; kind: 'register'; clientId: string; redirectUris: string[] }
  | { at: number; kind: 'authorize'; clientId: string; redirectUri: string; scope: string | null; resource: string | null; ok: boolean; error?: string }
  | { at: number; kind: 'token'; grantType: string; clientId: string | null; ok: boolean; status: number; resource: string | null; error?: string }
  | { at: number; kind: 'mcp'; path: '/mcp' | '/keyed'; ok: boolean; prefix: string | null }

export interface FakeOAuth {
  origin: string
  port: number
  issuer: string
  mcpUrl: string
  keyedUrl: string
  resourceMetadataUrl: string
  events: FakeOAuthEvent[]
  /** Every secret handed out or received: codes, verifiers, access and refresh tokens, client secrets, the key. */
  issued(): string[]
  /** The access tokens issued so far, oldest first. */
  accessTokens(): string[]
  /** Every current access token stops working (a 401 from /mcp). */
  revokeAccess(): void
  /** Refuse every refresh_token grant with invalid_grant while on. */
  refuseRefresh(on: boolean): void
  /** The next authorize answers this error instead of a code (once); `{state}` in the description is replaced by the request's state. */
  deny(next: { error: string; description?: string } | null): void
  set(opts: Partial<FakeOAuthOptions>): void
  /** sha256 prefix of a value, as whoami answers it. */
  prefix(value: string): string
  close(): Promise<void>
}

interface Client {
  id: string
  secret?: string
  redirectUris: string[]
}
interface Code {
  clientId: string
  redirectUri: string
  challenge: string
  scope: string | null
  resource: string | null
  used: boolean
}

const token = (kind: string): string => `${kind}_${randomBytes(18).toString('base64url')}`
const sha256url = (s: string): string => createHash('sha256').update(s).digest('base64url')
const prefixOf = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12)

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body))
}

function mcpServer(whoami: string): Server {
  const server = new Server({ name: 'fake-oauth', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'whoami', description: 'Answer the sha256 prefix of the credential this server got', inputSchema: { type: 'object', properties: {} } }]
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'whoami') throw new Error(`unknown tool ${req.params.name}`)
    return { content: [{ type: 'text', text: whoami }] }
  })
  return server
}

export async function startFakeOAuthServer(initial: FakeOAuthOptions = {}): Promise<FakeOAuth> {
  const opts: Required<Omit<FakeOAuthOptions, 'apiKey' | 'logFile' | 'port'>> & Pick<FakeOAuthOptions, 'apiKey' | 'logFile'> = {
    lifetimeSec: 3600,
    exchangeError: false,
    oneGrantPerClient: false,
    s256: true,
    registration: true,
    offlineAccess: true,
    refreshTokens: true,
    challenge: true,
    clientSecret: false,
    ...initial
  }
  const events: FakeOAuthEvent[] = []
  const secrets = new Set<string>()
  const clients = new Map<string, Client>()
  const codes = new Map<string, Code>()
  /** access token → when it lapses (ms), and whether it was revoked */
  const access = new Map<string, { until: number; revoked: boolean }>()
  const accessOrder: string[] = []
  /** the refresh tokens that still work, by client */
  const refresh = new Map<string, { clientId: string; scope: string | null; resource: string | null }>()
  let refusingRefresh = false
  let denyNext: { error: string; description?: string } | null = null
  if (opts.apiKey) secrets.add(opts.apiKey)

  const note = (e: FakeOAuthEvent): void => {
    events.push(e)
    if (opts.logFile) appendFileSync(opts.logFile, JSON.stringify(e) + '\n')
  }

  let origin = ''
  const issuer = (): string => `${origin}/as`
  const scopes = (): string[] => (opts.offlineAccess ? ['mcp', 'offline_access'] : ['mcp'])

  const issueTokens = (clientId: string, scope: string | null, resource: string | null): Record<string, unknown> => {
    const at = token('at')
    secrets.add(at)
    access.set(at, { until: Date.now() + opts.lifetimeSec * 1000, revoked: false })
    accessOrder.push(at)
    const out: Record<string, unknown> = { access_token: at, token_type: 'Bearer', expires_in: opts.lifetimeSec, ...(scope ? { scope } : {}) }
    if (opts.refreshTokens) {
      const rt = token('rt')
      secrets.add(rt)
      refresh.set(rt, { clientId, scope, resource })
      out.refresh_token = rt
    }
    return out
  }

  const bearerOk = (req: IncomingMessage): string | null => {
    const auth = req.headers.authorization
    const m = typeof auth === 'string' ? /^Bearer (.+)$/.exec(auth) : null
    if (!m) return null
    const t = access.get(m[1])
    return t && !t.revoked && t.until > Date.now() ? m[1] : null
  }

  const serveMcp = async (req: IncomingMessage, res: ServerResponse, whoami: string): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const server = mcpServer(whoami)
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const path = url.pathname
    try {
      if (req.method === 'GET' && path === '/.well-known/oauth-protected-resource/mcp') {
        return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [issuer()], scopes_supported: scopes(), bearer_methods_supported: ['header'] })
      }
      if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server/as') {
        return json(res, 200, {
          issuer: issuer(),
          authorization_endpoint: `${issuer()}/authorize`,
          token_endpoint: `${issuer()}/token`,
          ...(opts.registration ? { registration_endpoint: `${issuer()}/register` } : {}),
          response_types_supported: ['code'],
          grant_types_supported: opts.offlineAccess ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
          ...(opts.s256 ? { code_challenge_methods_supported: ['S256'] } : {}),
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
          scopes_supported: ['openid', ...scopes()]
        })
      }
      if (req.method === 'POST' && path === '/as/register' && opts.registration) {
        const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] }
        const id = token('cl')
        const client: Client = { id, redirectUris: body.redirect_uris ?? [] }
        if (opts.clientSecret) {
          client.secret = token('cs')
          secrets.add(client.secret)
        }
        clients.set(id, client)
        note({ at: Date.now(), kind: 'register', clientId: id, redirectUris: client.redirectUris })
        return json(res, 201, {
          ...body,
          client_id: id,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          ...(client.secret ? { client_secret: client.secret, token_endpoint_auth_method: 'client_secret_post' } : { token_endpoint_auth_method: 'none' })
        })
      }
      if (req.method === 'GET' && path === '/as/authorize') {
        const q = url.searchParams
        const clientId = q.get('client_id') ?? ''
        const redirectUri = q.get('redirect_uri') ?? ''
        const client = clients.get(clientId)
        const event = { at: Date.now(), kind: 'authorize' as const, clientId, redirectUri, scope: q.get('scope'), resource: q.get('resource') }
        if (!client || !client.redirectUris.includes(redirectUri)) {
          note({ ...event, ok: false, error: 'redirect_uri' })
          return json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' })
        }
        const target = new URL(redirectUri)
        const state = q.get('state')
        if (state) target.searchParams.set('state', state)
        if (denyNext) {
          target.searchParams.set('error', denyNext.error)
          if (denyNext.description) target.searchParams.set('error_description', denyNext.description.replace('{state}', state ?? ''))
          note({ ...event, ok: false, error: denyNext.error })
          denyNext = null
        } else if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
          target.searchParams.set('error', 'invalid_request')
          note({ ...event, ok: false, error: 'pkce' })
        } else {
          const code = token('code')
          secrets.add(code)
          codes.set(code, { clientId, redirectUri, challenge: q.get('code_challenge')!, scope: q.get('scope'), resource: q.get('resource'), used: false })
          target.searchParams.set('code', code)
          note({ ...event, ok: true })
        }
        res.writeHead(302, { location: target.toString() }).end()
        return
      }
      if (req.method === 'POST' && path === '/as/token') {
        const form = new URLSearchParams(await readBody(req))
        const grantType = form.get('grant_type') ?? ''
        const clientId = form.get('client_id')
        const resource = form.get('resource')
        for (const v of [form.get('code'), form.get('code_verifier'), form.get('refresh_token'), form.get('client_secret')]) if (v) secrets.add(v)
        const refuse = (status: number, error: string, description?: string): void => {
          note({ at: Date.now(), kind: 'token', grantType, clientId, ok: false, status, resource, error })
          json(res, status, { error, ...(description ? { error_description: description } : {}) })
        }
        const client = clientId ? clients.get(clientId) : undefined
        if (!client) return refuse(401, 'invalid_client')
        if (client.secret && form.get('client_secret') !== client.secret) return refuse(401, 'invalid_client')
        if (resource && resource !== `${origin}/mcp`) return refuse(400, 'invalid_target')
        if (grantType === 'authorization_code') {
          if (opts.exchangeError) return refuse(400, 'invalid_grant', `code ${form.get('code')} with verifier ${form.get('code_verifier')} was refused`)
          const code = codes.get(form.get('code') ?? '')
          if (!code || code.used || code.clientId !== client.id) return refuse(400, 'invalid_grant', 'the code is not valid')
          if (form.get('redirect_uri') !== code.redirectUri) return refuse(400, 'invalid_grant', 'redirect_uri differs')
          const verifier = form.get('code_verifier') ?? ''
          if (sha256url(verifier) !== code.challenge) return refuse(400, 'invalid_grant', `PKCE failed for ${verifier}`)
          code.used = true
          if (opts.oneGrantPerClient) for (const [rt, held] of refresh) if (held.clientId === client.id) refresh.delete(rt)
          const answer = issueTokens(client.id, code.scope, code.resource)
          note({ at: Date.now(), kind: 'token', grantType, clientId, ok: true, status: 200, resource })
          return json(res, 200, answer)
        }
        if (grantType === 'refresh_token') {
          const presented = form.get('refresh_token') ?? ''
          const held = refresh.get(presented)
          if (refusingRefresh || !held || held.clientId !== client.id) return refuse(400, 'invalid_grant')
          refresh.delete(presented)
          const answer = issueTokens(client.id, held.scope, held.resource)
          note({ at: Date.now(), kind: 'token', grantType, clientId, ok: true, status: 200, resource })
          return json(res, 200, answer)
        }
        return refuse(400, 'unsupported_grant_type')
      }
      if (path === '/mcp') {
        const bearer = bearerOk(req)
        if (!bearer && opts.challenge) {
          note({ at: Date.now(), kind: 'mcp', path: '/mcp', ok: false, prefix: null })
          res
            .writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer error="invalid_token", error_description="Missing or invalid access token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`
            })
            .end('{"error":"invalid_token"}')
          return
        }
        note({ at: Date.now(), kind: 'mcp', path: '/mcp', ok: true, prefix: bearer ? prefixOf(bearer) : null })
        return await serveMcp(req, res, bearer ? prefixOf(bearer) : 'none')
      }
      if (path === '/keyed') {
        const key = req.headers['x-api-key']
        if (!opts.apiKey || key !== opts.apiKey) {
          note({ at: Date.now(), kind: 'mcp', path: '/keyed', ok: false, prefix: null })
          return json(res, 401, { error: 'unauthorized' })
        }
        note({ at: Date.now(), kind: 'mcp', path: '/keyed', ok: true, prefix: prefixOf(opts.apiKey) })
        return await serveMcp(req, res, prefixOf(opts.apiKey))
      }
      res.writeHead(404).end()
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'server_error', error_description: (err as Error).message })
    }
  })
  await new Promise<void>((resolve) => http.listen(initial.port ?? 0, '127.0.0.1', resolve))
  const port = (http.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`
  return {
    origin,
    port,
    issuer: issuer(),
    mcpUrl: `${origin}/mcp`,
    keyedUrl: `${origin}/keyed`,
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    events,
    issued: () => [...secrets],
    accessTokens: () => [...accessOrder],
    revokeAccess: () => {
      for (const t of access.values()) t.revoked = true
    },
    refuseRefresh: (on) => {
      refusingRefresh = on
    },
    deny: (next) => {
      denyNext = next
    },
    set: (next) => {
      Object.assign(opts, next)
      if (next.apiKey) secrets.add(next.apiKey)
    },
    prefix: prefixOf,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections?.()
        http.close(() => resolve())
      })
  }
}
