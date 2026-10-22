import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure } from 'aliax-core'
import { request as httpRequest } from 'node:http'
import { WebSocket } from 'ws'
import type { RunningServer } from '../index'
import { FAILURE_LIMIT } from './auth'

/**
 * The fixed port end to end against a real startServer on a temp database
 * (remotePort 0 → ephemeral). Covers the plan's route table: public and
 * authenticated hello, pair → key, pair → session cookie (Secure only
 * behind https), ticket → upgrade → the gate, cookie upgrades and the
 * Origin check, reuse and failure limits, admin routes and audiences,
 * revoke closing live sockets.
 */
let root: string
let server: RunningServer
let base: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-listener-'))
  configure({
    dataDir: join(root, 'aliax'),
    fetch: async () => {
      throw new Error('no network in tests')
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-test'
  })
  // A stand-in for the built renderer: the ui handler serves <appPath>/out/renderer.
  mkdirSync(join(root, 'out', 'renderer', 'assets'), { recursive: true })
  writeFileSync(
    join(root, 'out', 'renderer', 'index.html'),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws://127.0.0.1:*" /></head><body><script src="./assets/app.js"></script></body></html>`
  )
  writeFileSync(join(root, 'out', 'renderer', 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'out', 'renderer', 'boot.js'), 'void 0')
  const { startServer } = await import('../index')
  server = await startServer(join(root, 'app.db'), {
    claimShim: false,
    remotePort: 0,
    appPath: root,
    // A stand-in for the asset protocol handler: echoes what it was asked.
    assets: async (request) =>
      new Response(
        `asset ${request.method} ${request.url} range=${request.headers.get('range') ?? '-'}`,
        {
          status: request.url.includes('missing') ? 404 : 200,
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }
        }
      )
  })
  base = `http://127.0.0.1:${server.remote!.port}`
}, 60_000)
afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

type Reply = { status: number; headers: Headers; body: any }
/** node:http rather than fetch: fetch strips a caller's Host header, and the proxy's Host is part of what is under test. */
function call(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = init.body !== undefined ? JSON.stringify(init.body) : undefined
    const req = httpRequest(
      base + path,
      {
        method,
        headers: {
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...init.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = text
          try {
            body = JSON.parse(text)
          } catch {
            /* text */
          }
          const headers = new Headers()
          for (const [k, v] of Object.entries(res.headers))
            if (typeof v === 'string') headers.set(k, v)
            else if (Array.isArray(v)) for (const item of v) headers.append(k, item)
          resolve({ status: res.statusCode ?? 0, headers, body })
        })
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

/** An admin bearer key made on the local side, as the desktop pane would. */
async function adminKey(): Promise<string> {
  return (
    await server.remoteAuth.createKey({
      name: 'admin',
      audience: 'client',
      caps: ['admin'],
      createdBy: 'local'
    })
  ).token
}

interface Socket {
  ws: WebSocket
  frames: any[]
  closed: Promise<{ code: number; reason: string }>
  request: (method: string, params?: unknown) => Promise<any>
}
function open(
  url: string,
  headers: Record<string, string> = {}
): Promise<Socket & { status?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    const frames: any[] = []
    let next = 1
    const pending = new Map<string, (frame: any) => void>()
    ws.on('message', (d) => {
      const frame = JSON.parse(String(d))
      frames.push(frame)
      pending.get(frame.id)?.(frame)
    })
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      ws.on('close', (code, reason) => r({ code, reason: String(reason) }))
    )
    ws.on('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error(`upgrade ${res.statusCode}`), { status: res.statusCode }))
    )
    ws.on('error', (e) => reject(e))
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        closed,
        request: (method, params = {}) =>
          new Promise((r) => {
            const id = String(next++)
            pending.set(id, r)
            ws.send(JSON.stringify({ id, method, params }))
          })
      })
    )
  })
}
const upgradeStatus = async (
  url: string,
  headers: Record<string, string> = {}
): Promise<number> => {
  try {
    const s = await open(url, headers)
    s.ws.close()
    return 101
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** The hello frame, however loaded the test worker is. */
const firstFrame = async (sock: Socket): Promise<any> => {
  for (let i = 0; i < 200 && sock.frames.length === 0; i++) await sleep(25)
  return sock.frames[0]
}

describe('public routes', () => {
  it('healthz and hello answer without a credential; hello names the environment', async () => {
    expect((await call('GET', '/healthz')).body).toBe('ok')
    const hello = await call('GET', '/api/hello')
    expect(hello.status).toBe(200)
    expect(hello.body.environmentId).toBe(server.environmentId)
    expect(hello.body.contract).toBe(1)
    expect(hello.body.key).toBeUndefined()
    // The hostname and version are not for an anonymous caller (R2 L2).
    expect(hello.body.name).toBeUndefined()
    expect(hello.body.version).toBeUndefined()
    const known = await call('GET', '/api/hello', { headers: bearer(await adminKey()) })
    expect(typeof known.body.name).toBe('string')
    expect(known.body.version).toMatch(/^\d+\.\d+\.\d+/)
    // What the host runs, for the deploy-drift mark (buildInfo.ts): the release number matches the version.
    expect(known.body.build).toMatchObject({ release: expect.any(Number), version: known.body.version, platform: process.platform })
    expect(`1.0.${known.body.build.release}`).toBe(known.body.version)
    expect(hello.body.build).toBeUndefined()
  })
  it('unknown paths and /lsp/ are bare 404s; /mcp without a key is a bare 401', async () => {
    const mcp = await call('GET', '/mcp')
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get('www-authenticate')).toBe('Bearer')
    for (const path of ['/nope', '/lsp/x', '/dap/x', '/api/nope']) {
      const r = await call('GET', path)
      expect(r.status, path).toBe(404)
      expect(String(r.body)).not.toMatch(/temp|code/i)
    }
    expect(await upgradeStatus(base.replace('http', 'ws') + '/lsp/x')).toBe(404)
  })
})

describe('bearer keys', () => {
  it('hello with a key reports it; a bad key is 401 and counts', async () => {
    const token = await adminKey()
    const hello = await call('GET', '/api/hello', { headers: bearer(token) })
    expect(hello.body.key).toMatchObject({
      name: 'admin',
      caps: ['admin', 'read'],
      audience: 'client'
    })
    expect((await call('POST', '/api/ticket', { headers: bearer('tc_nope.nope') })).status).toBe(
      401
    )
  })
  it('ticket → upgrade → hello first, then the gate', async () => {
    const { token } = await server.remoteAuth.createKey({
      name: 'iphone',
      audience: 'client',
      caps: ['operate'],
      createdBy: 'local'
    })
    const minted = await call('POST', '/api/ticket', { headers: bearer(token) })
    expect(minted.status).toBe(200)
    expect(minted.body.expiresIn).toBe(30)
    const sock = await open(`${base.replace('http', 'ws')}/ws?ticket=${minted.body.ticket}`)
    expect(await firstFrame(sock)).toMatchObject({
      push: 'hello',
      environmentId: server.environmentId,
      contract: 1,
      caps: ['operate', 'read'],
      key: { name: 'iphone' }
    })
    expect((await sock.request('session.list', {})).ok).toBe(true)
    expect(
      (await sock.request('session.approve', { sessionId: 'x', requestId: 'y', allow: true })).error
    ).toBe('forbidden: session.approve needs approve')
    expect((await sock.request('app.listThreads', { sessionId: 'x' })).error).toBe(
      'forbidden: app.listThreads is local-only'
    )
    expect((await sock.request('linear.setToken', { token: 'x' })).error).toBe(
      'forbidden: linear.setToken needs admin'
    )
    expect((await sock.request('session.create', { permission: 'auto', cwd: root })).error).toBe(
      'forbidden: session.create needs approve'
    )
    expect((await sock.request('nope.nope', {})).error).toMatch(/^bad request/)
    // The same ticket never opens a second socket.
    expect(
      await upgradeStatus(`${base.replace('http', 'ws')}/ws?ticket=${minted.body.ticket}`)
    ).toBe(401)
    expect(await upgradeStatus(`${base.replace('http', 'ws')}/ws`)).toBe(401)
    sock.ws.close()
  })
  it('a key names paths only inside the app-managed roots; the local socket is not fenced (R2 H1/H2)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'tc-fence-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'tc-fence-out-'))
    writeFileSync(join(ws, 'inside.txt'), 'inside')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'link'))
    await server.registry.createWorkspace(ws, 'fenced')
    const socketFor = async (caps: string[]): Promise<Socket> => {
      const { token } = await server.remoteAuth.createKey({ name: 'k', audience: 'client', caps: caps as never, createdBy: 'local' })
      const minted = await call('POST', '/api/ticket', { headers: bearer(token) })
      return open(`${base.replace('http', 'ws')}/ws?ticket=${minted.body.ticket}`)
    }
    const refused = (method: string): string => `forbidden: ${method} is outside app-managed roots`
    const reader = await socketFor([])
    expect((await reader.request('fs.readText', { path: join(ws, 'inside.txt') })).result).toBe('inside')
    expect((await reader.request('fs.readText', { path: join(outside, 'secret.txt') })).error).toBe(refused('fs.readText'))
    expect((await reader.request('fs.readText', { path: join(ws, 'link') })).error).toBe(refused('fs.readText'))
    expect((await reader.request('fs.listPath', { path: outside })).error).toBe(refused('fs.listPath'))
    expect((await reader.request('fs.statFiles', { paths: [join(ws, 'inside.txt'), join(outside, 'secret.txt')] })).error).toBe(refused('fs.statFiles'))
    expect((await reader.request('git.log', { cwd: outside })).error).toBe(refused('git.log'))
    expect((await reader.request('search.project', { options: { cwd: outside, query: 'secret' } })).error).toBe(refused('search.project'))
    expect((await reader.request('search.project', { options: { cwd: ws, query: 'inside' } })).result.matches).toHaveLength(1)
    // The capability gate still runs first.
    expect((await reader.request('fs.writeText', { path: join(ws, 'x.txt'), content: 'x' })).error).toBe('forbidden: fs.writeText needs operate')
    const operator = await socketFor(['operate'])
    expect((await operator.request('fs.writeText', { path: join(outside, 'x.txt'), content: 'x' })).error).toBe(refused('fs.writeText'))
    expect((await operator.request('fs.createPath', { parent: ws, name: '../escape', isDir: true })).error).toBe(refused('fs.createPath'))
    expect((await operator.request('workspace.create', { path: outside })).error).toBe(refused('workspace.create'))
    expect((await operator.request('git.clone', { url: 'https://example.invalid/r.git', parent: outside })).error).toBe(refused('git.clone'))
    expect((await operator.request('fs.writeText', { path: join(ws, 'x.txt'), content: 'x' })).ok).toBe(true)
    expect(readFileSync(join(ws, 'x.txt'), 'utf8')).toBe('x')
    // The desktop renderer's loopback socket keeps the whole disk.
    const local = await open(`ws://127.0.0.1:${server.port}/`)
    expect((await local.request('fs.readText', { path: join(outside, 'secret.txt') })).result).toBe('secret')
    for (const s of [reader, operator, local]) s.ws.close()
    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  it('revoking the key closes its live socket', async () => {
    const { key, token } = await server.remoteAuth.createKey({
      name: 'phone2',
      audience: 'client',
      caps: [],
      createdBy: 'local'
    })
    const ticket = (await call('POST', '/api/ticket', { headers: bearer(token) })).body.ticket
    const sock = await open(`${base.replace('http', 'ws')}/ws?ticket=${ticket}`)
    expect(server.remote!.sockets.get(key.id)?.size).toBe(1)
    const admin = await adminKey()
    expect((await call('DELETE', `/api/keys/${key.id}`, { headers: bearer(admin) })).body).toEqual({
      ok: true
    })
    expect(await sock.closed).toMatchObject({ code: 4001 })
    // The server's close handler runs a tick after the client sees the close frame.
    for (let i = 0; i < 20 && server.remote!.sockets.has(key.id); i++) await sleep(10)
    expect(server.remote!.sockets.has(key.id)).toBe(false)
    expect((await call('POST', '/api/ticket', { headers: bearer(token) })).status).toBe(401)
  })
  it('mcp keys are refused on /ws and /api/ticket', async () => {
    const { token } = await server.remoteAuth.createKey({
      name: 'grok',
      audience: 'mcp',
      caps: ['operate'],
      createdBy: 'local'
    })
    expect((await call('POST', '/api/ticket', { headers: bearer(token) })).status).toBe(403)
    expect((await call('GET', '/api/keys', { headers: bearer(token) })).status).toBe(403)
  })
})

describe('pairing', () => {
  it('a code exchanges for a key once, narrowed to what was asked', async () => {
    const admin = await adminKey()
    const made = await call('POST', '/api/pairings', {
      headers: bearer(admin),
      body: { name: 'iphone', audience: 'client', caps: ['operate', 'approve'] }
    })
    expect(made.status).toBe(200)
    expect(made.body.url).toBe(`${base}/pair#${made.body.code}`)
    expect((await call('GET', '/api/pairings', { headers: bearer(admin) })).body).toHaveLength(1)
    const over = await call('POST', '/api/pair', {
      body: { code: made.body.code, kind: 'key', caps: ['admin'] }
    })
    expect(over.status).toBe(400)
    const got = await call('POST', '/api/pair', {
      body: { code: made.body.code.toLowerCase(), kind: 'key', caps: ['operate'] }
    })
    expect(got.status).toBe(200)
    expect(got.body.key).toMatch(/^tc_[0-9A-Z]{10}\./)
    expect(got.body.caps).toEqual(['operate', 'read'])
    expect(got.body.environmentId).toBe(server.environmentId)
    expect((await call('GET', '/api/hello', { headers: bearer(got.body.key) })).body.key.name).toBe(
      'iphone'
    )
    expect(
      (await call('POST', '/api/pair', { body: { code: made.body.code, kind: 'key' } })).status
    ).toBe(401)
    expect((await call('GET', '/api/pairings', { headers: bearer(admin) })).body).toHaveLength(0)
  })
  it('a session exchange sets an HttpOnly cookie, Secure only behind https', async () => {
    const admin = await adminKey()
    const code = (
      await call('POST', '/api/pairings', {
        headers: bearer(admin),
        body: { name: 'Chrome', audience: 'client', caps: ['operate'] }
      })
    ).body.code
    const plain = await call('POST', '/api/pair', {
      body: { code, kind: 'session' },
      headers: { 'User-Agent': 'TestBrowser/1' }
    })
    expect(plain.status).toBe(200)
    const cookie = plain.headers.get('set-cookie')!
    expect(cookie).toMatch(
      /^tc_session=[A-Z0-9]{16}\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/
    )
    const code2 = (
      await call('POST', '/api/pairings', {
        headers: bearer(admin),
        body: { name: 'Safari', audience: 'client', caps: [] }
      })
    ).body.code
    const secure = await call('POST', '/api/pair', {
      body: { code: code2, kind: 'session' },
      headers: { 'X-Forwarded-Proto': 'https', Host: 'tempcode.example.com' }
    })
    expect(secure.headers.get('set-cookie')).toMatch(/; Secure$/)
    const sessions = (await call('GET', '/api/sessions', { headers: bearer(admin) })).body
    expect(sessions.map((s: { keyName: string }) => s.keyName).sort()).toEqual(['Chrome', 'Safari'])
    expect(sessions.find((s: { keyName: string }) => s.keyName === 'Chrome').userAgent).toBe(
      'TestBrowser/1'
    )
    // The learned origin comes only from an admin's own request (R2 L1): the
    // session exchange above, unauthenticated behind a chosen Host, taught nothing.
    const link = async (): Promise<string> =>
      (await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'x', audience: 'client', caps: [] } })).body.url
    expect(await link()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pair#/)
    await call('GET', '/api/keys', { headers: { ...bearer(admin), 'X-Forwarded-Proto': 'https', Host: 'tempcode.example.com' } })
    expect(await link()).toMatch(/^https:\/\/tempcode\.example\.com\/pair#/)
    // A spoofed Host on an anonymous or non-admin loopback request cannot move it.
    await call('GET', '/api/hello', { headers: { 'X-Forwarded-Proto': 'https', Host: 'evil.example' } })
    const { token: nonAdmin } = await server.remoteAuth.createKey({ name: 'plain', audience: 'client', caps: ['operate'], createdBy: 'local' })
    await call('GET', '/api/hello', { headers: { ...bearer(nonAdmin), 'X-Forwarded-Proto': 'https', Host: 'evil.example' } })
    await call('POST', '/api/pair', { body: { code: 'AAAAA-AAAAA', kind: 'key' }, headers: { 'X-Forwarded-Proto': 'https', Host: 'evil.example' } })
    expect(await link()).toMatch(/^https:\/\/tempcode\.example\.com\/pair#/)
  })
  it('the cookie upgrades /ws only from its own origin; logout ends it', async () => {
    const admin = await adminKey()
    const code = (
      await call('POST', '/api/pairings', {
        headers: bearer(admin),
        body: { name: 'Chrome', audience: 'client', caps: ['operate'] }
      })
    ).body.code
    const paired = await call('POST', '/api/pair', { body: { code, kind: 'session' } })
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]
    const wsUrl = base.replace('http', 'ws') + '/ws'
    expect(await upgradeStatus(wsUrl, { Cookie: cookie, Origin: 'https://evil.example' })).toBe(403)
    const sock = await open(wsUrl, { Cookie: cookie, Origin: base })
    const hello = await firstFrame(sock)
    expect(hello.push).toBe('hello')
    expect(hello.caps).toEqual(['operate', 'read'])
    expect((await sock.request('session.list', {})).ok).toBe(true)
    // A cookie caller cannot mint tickets, and a cross-site POST is refused.
    expect((await call('POST', '/api/ticket', { headers: { Cookie: cookie } })).status).toBe(400)
    expect(
      (
        await call('POST', '/api/logout', {
          headers: { Cookie: cookie, Origin: 'https://evil.example' }
        })
      ).status
    ).toBe(403)
    const out = await call('POST', '/api/logout', { headers: { Cookie: cookie, Origin: base } })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toMatch(/^tc_session=; .*Max-Age=0/)
    expect(await sock.closed).toMatchObject({ code: 4001 })
    expect(await upgradeStatus(wsUrl, { Cookie: cookie, Origin: base })).toBe(401)
  })
  it('a browser session with admin may manage keys over http', async () => {
    const admin = await adminKey()
    const code = (
      await call('POST', '/api/pairings', {
        headers: bearer(admin),
        body: { name: 'Desk', audience: 'client', caps: ['admin'] }
      })
    ).body.code
    const cookie = (await call('POST', '/api/pair', { body: { code, kind: 'session' } })).headers
      .get('set-cookie')!
      .split(';')[0]
    expect((await call('GET', '/api/keys', { headers: { Cookie: cookie } })).status).toBe(200)
    const made = await call('POST', '/api/keys', {
      headers: { Cookie: cookie },
      body: { name: 'bot', audience: 'mcp', caps: ['operate'] }
    })
    expect(made.body, JSON.stringify(made.body)).toMatchObject({
      key: { name: 'bot', caps: ['operate', 'read'] }
    })
    expect(made.body.token).toMatch(/^tc_/)
    expect(
      (
        await call('POST', '/api/keys', {
          headers: { Cookie: cookie, Origin: 'https://evil.example' },
          body: { name: 'bot', audience: 'mcp', caps: [] }
        })
      ).status
    ).toBe(403)
    expect(
      (
        await call('POST', '/api/keys', {
          headers: { Cookie: cookie },
          body: { name: 'bot', audience: 'mcp', caps: ['approve'] }
        })
      ).body.error
    ).toMatch(/mcp keys cannot hold approve/)
  })
})

describe('limits', () => {
  it('a non-admin key is 403 on management and 400 bodies are named', async () => {
    const { token } = await server.remoteAuth.createKey({
      name: 'ro',
      audience: 'client',
      caps: [],
      createdBy: 'local'
    })
    expect((await call('GET', '/api/keys', { headers: bearer(token) })).status).toBe(403)
    const admin = await adminKey()
    const bad = await call('POST', '/api/keys', {
      headers: bearer(admin),
      body: { name: '', audience: 'client', caps: [] }
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/^bad request: name/)
  })
  it('ten bad codes from one ip earn a 429 with Retry-After', async () => {
    const ip = { 'CF-Connecting-IP': '203.0.113.9' }
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      expect(
        (
          await call('POST', '/api/pair', {
            headers: ip,
            body: { code: 'AAAAA-AAAAA', kind: 'key' }
          })
        ).status
      ).toBe(401)
    }
    const limited = await call('POST', '/api/pair', {
      headers: ip,
      body: { code: 'AAAAA-AAAAA', kind: 'key' }
    })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(
      (await call('POST', '/api/ticket', { headers: { ...ip, ...bearer('tc_x.y') } })).status
    ).toBe(429)
    expect(await upgradeStatus(base.replace('http', 'ws') + '/ws?ticket=zzz', ip)).toBe(429)
    // Another address is unaffected.
    expect(
      (
        await call('POST', '/api/pair', {
          headers: { 'CF-Connecting-IP': '203.0.113.10' },
          body: { code: 'AAAAA-AAAAA', kind: 'key' }
        })
      ).status
    ).toBe(401)
  })
})

describe('/ui and /pair', () => {
  const cookieFor = async (caps: string[] = ['operate']): Promise<string> => {
    const admin = await adminKey()
    const code = (
      await call('POST', '/api/pairings', {
        headers: bearer(admin),
        body: { name: 'Browser', audience: 'client', caps }
      })
    ).body.code
    return (await call('POST', '/api/pair', { body: { code, kind: 'session' } })).headers
      .get('set-cookie')!
      .split(';')[0]
  }
  it('the sign-in page is public; the document redirects there and assets are 401 without a cookie', async () => {
    const pairPage = await call('GET', '/pair')
    const nonce = /script-src 'nonce-([^']+)'/.exec(pairPage.body)?.[1]
    expect(nonce).toBeTruthy()
    expect(pairPage.body).toContain(`<script nonce="${nonce}">`)
    expect(pairPage.body).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(/script-src 'nonce-([^']+)'/.exec((await call('GET', '/pair')).body)?.[1]).not.toBe(nonce)
    const page = await call('GET', '/pair')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/text\/html/)
    expect(String(page.body)).toContain('Pair this browser')
    const doc = await call('GET', '/ui')
    expect(doc.status).toBe(302)
    expect(doc.headers.get('location')).toBe('/pair')
    expect((await call('GET', '/ui/')).status).toBe(302)
    expect((await call('GET', '/ui/assets/app.js')).status).toBe(401)
    // A bearer key is not a browser session.
    const admin = await adminKey()
    expect((await call('GET', '/ui/', { headers: bearer(admin) })).status).toBe(302)
  })
  it('with a cookie: /ui → /ui/, index is no-store with the host in connect-src, assets are immutable', async () => {
    const cookie = await cookieFor()
    const bare = await call('GET', '/ui', { headers: { Cookie: cookie } })
    expect(bare.status).toBe(302)
    expect(bare.headers.get('location')).toBe('/ui/')
    const index = await call('GET', '/ui/', { headers: { Cookie: cookie } })
    expect(index.status).toBe(200)
    expect(index.headers.get('cache-control')).toBe('no-store')
    expect(String(index.body)).toContain(
      `connect-src 'self' ws://127.0.0.1:* ws://127.0.0.1:${server.remote!.port} http://127.0.0.1:${server.remote!.port}`
    )
    const proxied = await call('GET', '/ui/index.html', {
      headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https', Host: 'tempcode.example.com' }
    })
    expect(String(proxied.body)).toContain(
      'wss://tempcode.example.com https://tempcode.example.com'
    )
    const asset = await call('GET', '/ui/assets/app.js', { headers: { Cookie: cookie } })
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(
      (await call('GET', '/ui/boot.js', { headers: { Cookie: cookie } })).headers.get(
        'cache-control'
      )
    ).toBe('no-cache')
  })
  it('traversal and missing files are 404; other methods fall through', async () => {
    const cookie = await cookieFor()
    for (const path of [
      '/ui/%2e%2e/renderer/index.html',
      '/ui/../out/renderer/index.html',
      '/ui/assets/../../../etc/passwd',
      '/ui/nope.js',
      '/ui/assets/'
    ]) {
      expect((await call('GET', path, { headers: { Cookie: cookie } })).status, path).toBe(404)
    }
    expect((await call('POST', '/ui/', { headers: { Cookie: cookie }, body: {} })).status).toBe(404)
  })
})

describe('/asset', () => {
  it('mirrors the asset scheme behind the cookie', async () => {
    expect((await call('GET', '/asset/logo/x.png')).status).toBe(401)
    const admin = await adminKey()
    const code = (
      await call('POST', '/api/pairings', {
        headers: bearer(admin),
        body: { name: 'B', audience: 'client', caps: [] }
      })
    ).body.code
    const cookie = (await call('POST', '/api/pair', { body: { code, kind: 'session' } })).headers
      .get('set-cookie')!
      .split(';')[0]
    const logo = await call('GET', '/asset/logo/x.png', { headers: { Cookie: cookie } })
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toBe('image/png')
    expect(logo.body).toBe('asset GET tempcode-asset://logo/x.png range=-')
    const clip = await call('GET', '/asset/file/abc/clip.mp4?v=1', {
      headers: { Cookie: cookie, Range: 'bytes=0-9' }
    })
    expect(clip.body).toBe('asset GET tempcode-asset://file/abc/clip.mp4?v=1 range=bytes=0-9')
    expect(
      (await call('GET', '/asset/page/s/missing.html', { headers: { Cookie: cookie } })).status
    ).toBe(404)
    expect((await call('GET', '/asset/', { headers: { Cookie: cookie } })).status).toBe(404)
  })
  it('answers an app key sent as the bearer and refuses a bot key', async () => {
    const admin = await adminKey()
    const code = (
      await call('POST', '/api/pairings', {
        headers: bearer(admin),
        body: { name: 'phone', audience: 'client', caps: [] }
      })
    ).body.code
    const phone = (await call('POST', '/api/pair', { body: { code, kind: 'key' } })).body.key as string
    const logo = await call('GET', '/asset/logo/x.png', { headers: bearer(phone) })
    expect(logo.status).toBe(200)
    expect(logo.body).toBe('asset GET tempcode-asset://logo/x.png range=-')
    const bot = (
      await server.remoteAuth.createKey({ name: 'bot', audience: 'mcp', caps: ['read'], createdBy: 'local' })
    ).token
    expect((await call('GET', '/asset/logo/x.png', { headers: bearer(bot) })).status).toBe(401)
    expect((await call('GET', '/asset/logo/x.png', { headers: bearer('tc_NOPE.nope') })).status).toBe(401)
    // The document is still the cookie's alone.
    expect((await call('GET', '/ui/', { headers: bearer(phone) })).status).toBe(302)
  })
})

// Last: it stops the listener every other test talks to.
describe('remote.settings.set', () => {
  it('enabled off closes the port; on brings it back', async () => {
    const local = await open(`ws://127.0.0.1:${server.port}`)
    const off = await local.request('remote.settings.set', { enabled: false })
    expect(off.ok).toBe(true)
    for (let i = 0; i < 50 && server.remote !== null; i++) await sleep(20)
    expect(server.remote).toBeNull()
    expect((await local.request('remote.status')).result).toMatchObject({
      enabled: false,
      running: false,
      port: 0
    })
    await expect(fetch(base + '/healthz')).rejects.toThrow()
    const on = await local.request('remote.settings.set', { enabled: true })
    expect(on.ok).toBe(true)
    for (let i = 0; i < 50 && !(server.remote && server.remote.port > 0); i++) await sleep(20)
    expect(server.remote!.port).toBeGreaterThan(0)
    base = `http://127.0.0.1:${server.remote!.port}`
    expect((await call('GET', '/healthz')).body).toBe('ok')
    expect((await local.request('remote.status')).result).toMatchObject({
      enabled: true,
      running: true,
      port: server.remote!.port
    })
    local.ws.close()
  })
})

describe('the relay (remote/relay.ts): a lane to another host through this one', () => {
  const MAC = 'env_relayMac000000000000a'
  const wsBase = (): string => base.replace('http', 'ws')
  const ticketFor = async (token: string): Promise<string> => (await call('POST', '/api/ticket', { headers: bearer(token) })).body.ticket
  const until = async (test: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !test(); i++) await sleep(25)
  }

  it('refuses a lane to a host that is not registered with 503, and names hosts in /api/hello to a known caller only', async () => {
    const { token } = await server.remoteAuth.createKey({ name: 'phone-relay-0', audience: 'client', caps: ['operate'], createdBy: 'local' })
    expect(await upgradeStatus(`${wsBase()}/ws?ticket=${await ticketFor(token)}&host=${MAC}`)).toBe(503)
    expect((await call('GET', '/api/hello')).body.hosts).toBeUndefined()
    expect(Array.isArray((await call('GET', '/api/hello', { headers: bearer(token) })).body.hosts)).toBe(true)
  })

  it('carries a phone to a registered host: the hello under its id, frames both ways, presence, revoke and the drop', async () => {
    // The "Mac": an admin link that registers with the relay offer and serves relay.* peer calls.
    const mac = await open(`${wsBase()}/ws?ticket=${await ticketFor(await adminKey())}`)
    await firstFrame(mac)
    const lanes: string[] = []
    const answered: unknown[] = []
    mac.ws.on('message', (d) => {
      const frame = JSON.parse(String(d))
      if (frame.push !== 'peer.call') return
      const { callId, method, params } = frame
      const reply = (result: unknown): void => void mac.request('peer.reply', { callId, ok: true, result })
      if (method === 'relay.open') {
        lanes.push(params.args.socketId)
        reply({ ok: true, contract: 1 })
      } else if (method === 'relay.frame') {
        answered.push(params.args.frame)
        reply({ ok: true })
        void mac.request('relay.frames', { from: MAC, socketId: params.args.socketId, frames: [{ id: params.args.frame.id, ok: true, result: `answered ${params.args.frame.method} on the Mac` }] })
      } else reply({ ok: true })
    })
    expect(
      (await mac.request('peer.register', { from: MAC, offers: ['mac-bridge', 'relay'], name: 'Studio', presence: { screen: 'unlocked', power: 'awake', at: 1 }, build: { release: 9, version: '1.0.9', sha: null, platform: 'darwin' } })).ok
    ).toBe(true)
    const { key, token } = await server.remoteAuth.createKey({ name: 'phone-relay', audience: 'client', caps: ['operate'], createdBy: 'local' })
    expect((await call('GET', '/api/hello', { headers: bearer(token) })).body.hosts).toEqual([
      expect.objectContaining({ environmentId: MAC, name: 'Studio', platform: 'darwin', link: 'up', screen: 'unlocked', power: 'awake' })
    ])
    // A direct lane's hello names the host too.
    const direct = await open(`${wsBase()}/ws?ticket=${await ticketFor(token)}`)
    expect((await firstFrame(direct)).hosts).toEqual([expect.objectContaining({ environmentId: MAC, link: 'up' })])

    const phone = await open(`${wsBase()}/ws?ticket=${await ticketFor(token)}&host=${MAC}`)
    expect(await firstFrame(phone)).toMatchObject({
      push: 'hello',
      environmentId: MAC,
      via: server.environmentId,
      caps: ['operate', 'read'],
      key: { id: key.id, name: 'phone-relay' },
      build: { version: '1.0.9' },
      presence: { environmentId: MAC, link: 'up' }
    })
    await until(() => lanes.length === 1)
    expect(await phone.request('session.list', {})).toEqual({ id: expect.any(String), ok: true, result: 'answered session.list on the Mac' })
    expect(answered).toEqual([{ id: expect.any(String), method: 'session.list', params: {} }])
    // The box's own gate and the relay's refusals never cross.
    expect((await phone.request('app.listThreads', { sessionId: 'x' })).error).toBe('forbidden: app.listThreads is local-only')
    expect((await phone.request('remote.keys.list', {})).error).toBe('forbidden: remote.keys.list needs admin')
    expect((await phone.request('doctor.get', {})).error).toBe('forbidden: doctor.get does not relay to another host')
    expect((await phone.request('remote.push.status', {})).ok).toBe(true)
    expect(answered).toHaveLength(1)

    // The Mac locks: every remote socket hears it; the screen method is refused, the rest runs.
    await mac.request('peer.presence', { from: MAC, presence: { screen: 'locked', power: 'awake', at: 2 } })
    await until(() => phone.frames.some((f) => f.push === 'presence'))
    expect(phone.frames.find((f) => f.push === 'presence').hosts[0]).toMatchObject({ environmentId: MAC, screen: 'locked' })
    await until(() => direct.frames.some((f) => f.push === 'presence'))
    expect((await phone.request('host.device.openXcode', { udid: 'U' })).error).toBe('unavailable: the Mac is locked')
    // A host may speak only for itself, on its own socket.
    expect((await direct.request('peer.presence', { from: MAC, presence: { screen: 'unlocked', power: 'awake', at: 3 } })).error).toMatch(/^forbidden: /)

    // Revoking the key closes its relayed lane with every other socket.
    expect(server.remoteAuth.revokeKey(key.id)).toBe(true)
    expect(await phone.closed).toMatchObject({ code: 4001 })
    expect(await direct.closed).toMatchObject({ code: 4001 })

    // The Mac's link drops: the host is listed down, and a new lane is refused 503.
    mac.ws.close()
    await mac.closed
    const { token: again } = await server.remoteAuth.createKey({ name: 'phone-relay-2', audience: 'client', caps: ['operate'], createdBy: 'local' })
    await until(() => server.relay.presenceOf(MAC)?.link === 'down')
    expect((await call('GET', '/api/hello', { headers: bearer(again) })).body.hosts[0]).toMatchObject({ environmentId: MAC, link: 'down' })
    expect(await upgradeStatus(`${wsBase()}/ws?ticket=${await ticketFor(again)}&host=${MAC}`)).toBe(503)
  })
})
