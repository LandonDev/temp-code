import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
      new Response(`asset ${request.method} ${request.url} range=${request.headers.get('range') ?? '-'}`, {
        status: request.url.includes('missing') ? 404 : 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }
      })
  })
  base = `http://127.0.0.1:${server.remote!.port}`
}, 60_000)
afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

type Reply = { status: number; headers: Headers; body: any }
/** node:http rather than fetch: fetch strips a caller's Host header, and the proxy's Host is part of what is under test. */
function call(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = init.body !== undefined ? JSON.stringify(init.body) : undefined
    const req = httpRequest(
      base + path,
      {
        method,
        headers: {
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v)
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
  return (await server.remoteAuth.createKey({ name: 'admin', audience: 'client', caps: ['admin'], createdBy: 'local' })).token
}

interface Socket {
  ws: WebSocket
  frames: any[]
  closed: Promise<{ code: number; reason: string }>
  request: (method: string, params?: unknown) => Promise<any>
}
function open(url: string, headers: Record<string, string> = {}): Promise<Socket & { status?: number }> {
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
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })))
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`upgrade ${res.statusCode}`), { status: res.statusCode })))
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
const upgradeStatus = async (url: string, headers: Record<string, string> = {}): Promise<number> => {
  try {
    const s = await open(url, headers)
    s.ws.close()
    return 101
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('public routes', () => {
  it('healthz and hello answer without a credential; hello names the environment', async () => {
    expect((await call('GET', '/healthz')).body).toBe('ok')
    const hello = await call('GET', '/api/hello')
    expect(hello.status).toBe(200)
    expect(hello.body.environmentId).toBe(server.environmentId)
    expect(hello.body.contract).toBe(1)
    expect(hello.body.key).toBeUndefined()
  })
  it('unknown paths, /lsp/ and /mcp are bare 404s', async () => {
    for (const path of ['/nope', '/lsp/x', '/dap/x', '/mcp', '/api/nope']) {
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
    expect(hello.body.key).toMatchObject({ name: 'admin', caps: ['admin', 'read'], audience: 'client' })
    expect((await call('POST', '/api/ticket', { headers: bearer('tc_nope.nope') })).status).toBe(401)
  })
  it('ticket → upgrade → hello first, then the gate', async () => {
    const { token } = await server.remoteAuth.createKey({ name: 'iphone', audience: 'client', caps: ['operate'], createdBy: 'local' })
    const minted = await call('POST', '/api/ticket', { headers: bearer(token) })
    expect(minted.status).toBe(200)
    expect(minted.body.expiresIn).toBe(30)
    const sock = await open(`${base.replace('http', 'ws')}/ws?ticket=${minted.body.ticket}`)
    await sleep(100)
    expect(sock.frames[0]).toMatchObject({ push: 'hello', environmentId: server.environmentId, contract: 1, caps: ['operate', 'read'], key: { name: 'iphone' } })
    expect((await sock.request('session.list', {})).ok).toBe(true)
    expect((await sock.request('session.approve', { sessionId: 'x', requestId: 'y', allow: true })).error).toBe('forbidden: session.approve needs approve')
    expect((await sock.request('app.listThreads', { sessionId: 'x' })).error).toBe('forbidden: app.listThreads is local-only')
    expect((await sock.request('linear.setToken', { token: 'x' })).error).toBe('forbidden: linear.setToken needs admin')
    expect((await sock.request('session.create', { permission: 'auto', cwd: root })).error).toBe('forbidden: session.create needs approve')
    expect((await sock.request('nope.nope', {})).error).toMatch(/^bad request/)
    // The same ticket never opens a second socket.
    expect(await upgradeStatus(`${base.replace('http', 'ws')}/ws?ticket=${minted.body.ticket}`)).toBe(401)
    expect(await upgradeStatus(`${base.replace('http', 'ws')}/ws`)).toBe(401)
    sock.ws.close()
  })
  it('revoking the key closes its live socket', async () => {
    const { key, token } = await server.remoteAuth.createKey({ name: 'phone2', audience: 'client', caps: [], createdBy: 'local' })
    const ticket = (await call('POST', '/api/ticket', { headers: bearer(token) })).body.ticket
    const sock = await open(`${base.replace('http', 'ws')}/ws?ticket=${ticket}`)
    expect(server.remote!.sockets.get(key.id)?.size).toBe(1)
    const admin = await adminKey()
    expect((await call('DELETE', `/api/keys/${key.id}`, { headers: bearer(admin) })).body).toEqual({ ok: true })
    expect(await sock.closed).toMatchObject({ code: 4001 })
    // The server's close handler runs a tick after the client sees the close frame.
    for (let i = 0; i < 20 && server.remote!.sockets.has(key.id); i++) await sleep(10)
    expect(server.remote!.sockets.has(key.id)).toBe(false)
    expect((await call('POST', '/api/ticket', { headers: bearer(token) })).status).toBe(401)
  })
  it('mcp keys are refused on /ws and /api/ticket', async () => {
    const { token } = await server.remoteAuth.createKey({ name: 'grok', audience: 'mcp', caps: ['operate'], createdBy: 'local' })
    expect((await call('POST', '/api/ticket', { headers: bearer(token) })).status).toBe(403)
    expect((await call('GET', '/api/keys', { headers: bearer(token) })).status).toBe(403)
  })
})

describe('pairing', () => {
  it('a code exchanges for a key once, narrowed to what was asked', async () => {
    const admin = await adminKey()
    const made = await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'iphone', audience: 'client', caps: ['operate', 'approve'] } })
    expect(made.status).toBe(200)
    expect(made.body.url).toBe(`${base}/pair#${made.body.code}`)
    expect((await call('GET', '/api/pairings', { headers: bearer(admin) })).body).toHaveLength(1)
    const over = await call('POST', '/api/pair', { body: { code: made.body.code, kind: 'key', caps: ['admin'] } })
    expect(over.status).toBe(400)
    const got = await call('POST', '/api/pair', { body: { code: made.body.code.toLowerCase(), kind: 'key', caps: ['operate'] } })
    expect(got.status).toBe(200)
    expect(got.body.key).toMatch(/^tc_[0-9A-Z]{10}\./)
    expect(got.body.caps).toEqual(['operate', 'read'])
    expect(got.body.environmentId).toBe(server.environmentId)
    expect((await call('GET', '/api/hello', { headers: bearer(got.body.key) })).body.key.name).toBe('iphone')
    expect((await call('POST', '/api/pair', { body: { code: made.body.code, kind: 'key' } })).status).toBe(401)
    expect((await call('GET', '/api/pairings', { headers: bearer(admin) })).body).toHaveLength(0)
  })
  it('a session exchange sets an HttpOnly cookie, Secure only behind https', async () => {
    const admin = await adminKey()
    const code = (await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'Chrome', audience: 'client', caps: ['operate'] } })).body.code
    const plain = await call('POST', '/api/pair', { body: { code, kind: 'session' }, headers: { 'User-Agent': 'TestBrowser/1' } })
    expect(plain.status).toBe(200)
    const cookie = plain.headers.get('set-cookie')!
    expect(cookie).toMatch(/^tc_session=[A-Z0-9]{16}\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/)
    const code2 = (await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'Safari', audience: 'client', caps: [] } })).body.code
    const secure = await call('POST', '/api/pair', { body: { code: code2, kind: 'session' }, headers: { 'X-Forwarded-Proto': 'https', Host: 'tempcode.example.com' } })
    expect(secure.headers.get('set-cookie')).toMatch(/; Secure$/)
    const sessions = (await call('GET', '/api/sessions', { headers: bearer(admin) })).body
    expect(sessions.map((s: { keyName: string }) => s.keyName).sort()).toEqual(['Chrome', 'Safari'])
    expect(sessions.find((s: { keyName: string }) => s.keyName === 'Chrome').userAgent).toBe('TestBrowser/1')
    // The learned origin is the proxy's, for pairing links.
    expect((await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'x', audience: 'client', caps: [] } })).body.url).toMatch(/^https:\/\/tempcode\.example\.com\/pair#/)
  })
  it('the cookie upgrades /ws only from its own origin; logout ends it', async () => {
    const admin = await adminKey()
    const code = (await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'Chrome', audience: 'client', caps: ['operate'] } })).body.code
    const paired = await call('POST', '/api/pair', { body: { code, kind: 'session' } })
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]
    const wsUrl = base.replace('http', 'ws') + '/ws'
    expect(await upgradeStatus(wsUrl, { Cookie: cookie, Origin: 'https://evil.example' })).toBe(403)
    const sock = await open(wsUrl, { Cookie: cookie, Origin: base })
    await sleep(50)
    expect(sock.frames[0].push).toBe('hello')
    expect(sock.frames[0].caps).toEqual(['operate', 'read'])
    expect((await sock.request('session.list', {})).ok).toBe(true)
    // A cookie caller cannot mint tickets, and a cross-site POST is refused.
    expect((await call('POST', '/api/ticket', { headers: { Cookie: cookie } })).status).toBe(400)
    expect((await call('POST', '/api/logout', { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(403)
    const out = await call('POST', '/api/logout', { headers: { Cookie: cookie, Origin: base } })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toMatch(/^tc_session=; .*Max-Age=0/)
    expect(await sock.closed).toMatchObject({ code: 4001 })
    expect(await upgradeStatus(wsUrl, { Cookie: cookie, Origin: base })).toBe(401)
  })
  it('a browser session with admin may manage keys over http', async () => {
    const admin = await adminKey()
    const code = (await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'Desk', audience: 'client', caps: ['admin'] } })).body.code
    const cookie = (await call('POST', '/api/pair', { body: { code, kind: 'session' } })).headers.get('set-cookie')!.split(';')[0]
    expect((await call('GET', '/api/keys', { headers: { Cookie: cookie } })).status).toBe(200)
    const made = await call('POST', '/api/keys', { headers: { Cookie: cookie }, body: { name: 'bot', audience: 'mcp', caps: ['operate'] } })
    expect(made.body, JSON.stringify(made.body)).toMatchObject({ key: { name: 'bot', caps: ['operate', 'read'] } })
    expect(made.body.token).toMatch(/^tc_/)
    expect((await call('POST', '/api/keys', { headers: { Cookie: cookie, Origin: 'https://evil.example' }, body: { name: 'bot', audience: 'mcp', caps: [] } })).status).toBe(403)
    expect((await call('POST', '/api/keys', { headers: { Cookie: cookie }, body: { name: 'bot', audience: 'mcp', caps: ['approve'] } })).body.error).toMatch(/mcp keys cannot hold approve/)
  })
})

describe('limits', () => {
  it('a non-admin key is 403 on management and 400 bodies are named', async () => {
    const { token } = await server.remoteAuth.createKey({ name: 'ro', audience: 'client', caps: [], createdBy: 'local' })
    expect((await call('GET', '/api/keys', { headers: bearer(token) })).status).toBe(403)
    const admin = await adminKey()
    const bad = await call('POST', '/api/keys', { headers: bearer(admin), body: { name: '', audience: 'client', caps: [] } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/^bad request: name/)
  })
  it('ten bad codes from one ip earn a 429 with Retry-After', async () => {
    const ip = { 'CF-Connecting-IP': '203.0.113.9' }
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      expect((await call('POST', '/api/pair', { headers: ip, body: { code: 'AAAAA-AAAAA', kind: 'key' } })).status).toBe(401)
    }
    const limited = await call('POST', '/api/pair', { headers: ip, body: { code: 'AAAAA-AAAAA', kind: 'key' } })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await call('POST', '/api/ticket', { headers: { ...ip, ...bearer('tc_x.y') } })).status).toBe(429)
    expect(await upgradeStatus(base.replace('http', 'ws') + '/ws?ticket=zzz', ip)).toBe(429)
    // Another address is unaffected.
    expect((await call('POST', '/api/pair', { headers: { 'CF-Connecting-IP': '203.0.113.10' }, body: { code: 'AAAAA-AAAAA', kind: 'key' } })).status).toBe(401)
  })
})

describe('/ui and /pair', () => {
  const cookieFor = async (caps: string[] = ['operate']): Promise<string> => {
    const admin = await adminKey()
    const code = (await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'Browser', audience: 'client', caps } })).body.code
    return (await call('POST', '/api/pair', { body: { code, kind: 'session' } })).headers.get('set-cookie')!.split(';')[0]
  }
  it('the sign-in page is public; the document redirects there and assets are 401 without a cookie', async () => {
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
    expect(String(index.body)).toContain(`connect-src 'self' ws://127.0.0.1:* ws://127.0.0.1:${server.remote!.port} http://127.0.0.1:${server.remote!.port}`)
    const proxied = await call('GET', '/ui/index.html', { headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https', Host: 'tempcode.example.com' } })
    expect(String(proxied.body)).toContain('wss://tempcode.example.com https://tempcode.example.com')
    const asset = await call('GET', '/ui/assets/app.js', { headers: { Cookie: cookie } })
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await call('GET', '/ui/boot.js', { headers: { Cookie: cookie } })).headers.get('cache-control')).toBe('no-cache')
  })
  it('traversal and missing files are 404; other methods fall through', async () => {
    const cookie = await cookieFor()
    for (const path of ['/ui/%2e%2e/renderer/index.html', '/ui/../out/renderer/index.html', '/ui/assets/../../../etc/passwd', '/ui/nope.js', '/ui/assets/']) {
      expect((await call('GET', path, { headers: { Cookie: cookie } })).status, path).toBe(404)
    }
    expect((await call('POST', '/ui/', { headers: { Cookie: cookie }, body: {} })).status).toBe(404)
  })
})

describe('/asset', () => {
  it('mirrors the asset scheme behind the cookie', async () => {
    expect((await call('GET', '/asset/logo/x.png')).status).toBe(401)
    const admin = await adminKey()
    const code = (await call('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'B', audience: 'client', caps: [] } })).body.code
    const cookie = (await call('POST', '/api/pair', { body: { code, kind: 'session' } })).headers.get('set-cookie')!.split(';')[0]
    const logo = await call('GET', '/asset/logo/x.png', { headers: { Cookie: cookie } })
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toBe('image/png')
    expect(logo.body).toBe('asset GET tempcode-asset://logo/x.png range=-')
    const clip = await call('GET', '/asset/file/abc/clip.mp4?v=1', { headers: { Cookie: cookie, Range: 'bytes=0-9' } })
    expect(clip.body).toBe('asset GET tempcode-asset://file/abc/clip.mp4?v=1 range=bytes=0-9')
    expect((await call('GET', '/asset/page/s/missing.html', { headers: { Cookie: cookie } })).status).toBe(404)
    expect((await call('GET', '/asset/', { headers: { Cookie: cookie } })).status).toBe(404)
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
    expect((await local.request('remote.status')).result).toMatchObject({ enabled: false, running: false, port: 0 })
    await expect(fetch(base + '/healthz')).rejects.toThrow()
    const on = await local.request('remote.settings.set', { enabled: true })
    expect(on.ok).toBe(true)
    for (let i = 0; i < 50 && !(server.remote && server.remote.port > 0); i++) await sleep(20)
    expect(server.remote!.port).toBeGreaterThan(0)
    base = `http://127.0.0.1:${server.remote!.port}`
    expect((await call('GET', '/healthz')).body).toBe('ok')
    expect((await local.request('remote.status')).result).toMatchObject({ enabled: true, running: true, port: server.remote!.port })
    local.ws.close()
  })
})
