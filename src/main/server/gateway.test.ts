import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The marker lives under $HOME/.aliax, fixed at import time: point HOME at a
// scratch dir before core loads so no test ever touches the real shim marker.
const home = mkdtempSync(join(tmpdir(), 'temp-code-gateway-home-'))
const realHome = process.env.HOME
let core: typeof import('aliax-core')
let gw: typeof import('./gateway')
let tls: import('./tls').TlsMaterial
let markerPath = ''

beforeAll(async () => {
  process.env.HOME = home
  core = await import('aliax-core')
  gw = await import('./gateway')
  markerPath = core.MARKER_PATH
  expect(markerPath.startsWith(home)).toBe(true)
  const tlsMod = await import('./tls')
  await tlsMod.makeCertificate(join(home, 'tls'), 'Test CA')
  tls = tlsMod.readTlsDir(join(home, 'tls'), 'app')!
}, 30_000)
afterAll(() => {
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

const readMarker = (): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}
const writeMarker = (m: Record<string, unknown>): void => writeFileSync(markerPath, JSON.stringify(m))
const DEAD_PID = 9_999_999

let running: InstanceType<typeof gw.Gateway>[] = []
const start = async (options: Partial<import('./gateway').GatewayOptions> = {}) => {
  const g = new gw.Gateway({ claimShim: true, tickMs: 50, tls: null, ...options })
  running.push(g)
  await g.start()
  return g
}
afterEach(async () => {
  for (const g of running) await g.stop()
  running = []
  rmSync(markerPath, { force: true })
})

describe('mayClaimShim', () => {
  const prod = join(home, 'Library', 'Application Support', 'temp-code')
  it('the installed app and dev:prod claim; a dev dir needs the gate', () => {
    // The Mac's paths, whichever host runs the suite.
    const mac = (o: { isPackaged: boolean; env: NodeJS.ProcessEnv }) => gw.mayClaimShim({ ...o, platform: 'darwin' })
    expect(mac({ isPackaged: true, env: {} })).toBe(true)
    expect(mac({ isPackaged: false, env: {} })).toBe(false)
    expect(mac({ isPackaged: false, env: { TEMP_CODE_USER_DATA: prod } })).toBe(true)
    expect(mac({ isPackaged: false, env: { TEMP_CODE_USER_DATA: `${prod}-dev` } })).toBe(false)
    expect(mac({ isPackaged: false, env: { TEMP_CODE_USER_DATA: `${prod}-dev`, TEMP_CODE_CLAIM_SHIM: '1' } })).toBe(true)
    expect(mac({ isPackaged: true, env: { TEMP_CODE_USER_DATA: `${prod}-dev` } })).toBe(false)
  })

  it('off macOS the prod dir follows the platform appData', () => {
    const linux = { TEMP_CODE_USER_DATA: join(home, '.config', 'temp-code') }
    expect(gw.mayClaimShim({ isPackaged: false, platform: 'linux', env: linux })).toBe(true)
    expect(gw.mayClaimShim({ isPackaged: false, platform: 'linux', env: { ...linux, XDG_CONFIG_HOME: '/srv/cfg' } })).toBe(false)
    expect(
      gw.mayClaimShim({
        isPackaged: false,
        platform: 'linux',
        env: { TEMP_CODE_USER_DATA: '/srv/cfg/temp-code', XDG_CONFIG_HOME: '/srv/cfg' }
      })
    ).toBe(true)
    expect(gw.mayClaimShim({ isPackaged: false, platform: 'linux', env: { TEMP_CODE_USER_DATA: prod } })).toBe(false)
    expect(gw.appDataDir('darwin', {}, '/Users/x')).toBe('/Users/x/Library/Application Support')
    expect(gw.appDataDir('linux', {}, '/home/x')).toBe('/home/x/.config')
    expect(gw.appDataDir('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\Users\\x')).toBe(
      'C:\\Users\\x\\AppData\\Roaming'
    )
  })
})

describe('Gateway marker', () => {
  it('listens without writing the marker when it may not claim', async () => {
    const g = await start({ claimShim: false })
    const s = g.status()
    expect(s.running).toBe(true)
    expect(s.port).toBeGreaterThan(0)
    expect(s.owner).toBe(false)
    expect(readMarker()).toBeNull()
    expect(g.url('claude')).toBe(`http://127.0.0.1:${s.port}/claude`)
  })

  it('claims an empty marker, answers /__aliax as temp-code, and deletes it on stop', async () => {
    const g = await start()
    expect(g.status().owner).toBe(true)
    expect(readMarker()).toMatchObject({ owner: 'temp-code', pid: process.pid, port: g.status().port })
    const res = await fetch(`http://127.0.0.1:${g.status().port}/__aliax`)
    expect(await res.json()).toEqual({ ok: true, pid: process.pid, owner: 'temp-code', features: ['scoped-routes'] })
    await g.stop()
    expect(readMarker()).toBeNull()
  })

  it('takes over a live Aliax and hands the marker back on stop', async () => {
    // The parent process stands in for a running Aliax.
    writeMarker({ port: 5000, pid: process.ppid, url: 'http://127.0.0.1:5000', owner: 'aliax' })
    const g = await start()
    expect(g.status()).toMatchObject({ owner: true, standby: null })
    expect(readMarker()).toMatchObject({ owner: 'temp-code', previous: { owner: 'aliax', port: 5000, pid: process.ppid } })
    await g.stop()
    expect(readMarker()).toMatchObject({ owner: 'aliax', port: 5000, pid: process.ppid })
  })

  it('stays standby behind another live temp-code and reclaims once it dies', async () => {
    writeMarker({ port: 5000, pid: process.ppid, url: 'http://127.0.0.1:5000', owner: 'temp-code' })
    const g = await start()
    expect(g.status()).toMatchObject({ owner: false, standby: 'temp-code' })
    expect(readMarker()).toMatchObject({ port: 5000 })
    // The other copy crashed: its pid is gone but its marker stayed behind.
    writeMarker({ port: 5000, pid: DEAD_PID, url: 'http://127.0.0.1:5000', owner: 'temp-code' })
    await vi.waitFor(() => expect(g.status().owner).toBe(true))
    expect(readMarker()).toMatchObject({ owner: 'temp-code', pid: process.pid })
    expect(readMarker()!.previous).toBeUndefined()
  })

  it('reclaims when Aliax clobbers the marker after us', async () => {
    const g = await start()
    writeMarker({ port: 5000, pid: process.ppid, url: 'http://127.0.0.1:5000', owner: 'aliax', claimedAt: 1 })
    await vi.waitFor(() => expect(readMarker()).toMatchObject({ owner: 'temp-code', pid: process.pid }))
    expect(g.status().owner).toBe(true)
  })

  it('releaseGateway only touches our own marker', () => {
    writeMarker({ port: 5000, pid: process.ppid, url: 'x', owner: 'aliax' })
    gw.releaseGateway()
    expect(readMarker()).toMatchObject({ port: 5000 })
  })
})

describe('Gateway forwarding', () => {
  let cleanupData = (): void => {}
  afterEach(() => cleanupData())

  it('swaps Authorization for the pinned account, streams the answer, counts it and fires hooks', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'temp-code-gateway-data-'))
    cleanupData = () => rmSync(dataDir, { recursive: true, force: true })
    const calls: { url: string; init?: RequestInit }[] = []
    core.configure({
      dataDir,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response('data: {"n":1}\n\ndata: {"n":2}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-upstream': 'yes' }
        })
      },
      secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
      appName: 'temp-code-test'
    })
    core.vault.useFixedChromiumKey('Test Safe Storage', core.vault.randomChromiumKey())
    core.vault.upsertProfile('codex', { name: 'p', accountId: 'acct-1', createdAt: 1 })
    core.vault.saveSecret('codex', 'p', JSON.stringify({ tokens: { access_token: 'PINNED', account_id: 'acct-1' } }))
    core.pinProfile('codex', 'p')

    const seen: { service: string; status: number }[] = []
    const g = await start({ claimShim: false, hooks: { onResponse: (i) => seen.push({ service: i.service, status: i.status }) } })
    const res = await fetch(`http://127.0.0.1:${g.status().port}/codex/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer CLI-TOKEN', 'x-api-key': 'k', 'sec-fetch-mode': 'cors' },
      body: '{"model":"gpt-5"}'
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-upstream')).toBe('yes')
    expect(await res.text()).toBe('data: {"n":1}\n\ndata: {"n":2}\n\n')
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/v1/responses')
    const headers = calls[0].init!.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer PINNED')
    expect(headers['chatgpt-account-id']).toBe('acct-1')
    expect(headers['x-api-key']).toBeUndefined()
    expect(seen).toEqual([{ service: 'codex', status: 200 }])
    expect(g.status().routed).toEqual({ codex: 1 })
    expect((await fetch(`http://127.0.0.1:${g.status().port}/other/x`)).status).toBe(404)
    expect(g.status().routed).toEqual({ codex: 1 })
  })

  it('gives a codex thread its own https port, scopes every request on it, and closes it on release', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'temp-code-gateway-data-'))
    cleanupData = () => rmSync(dataDir, { recursive: true, force: true })
    const calls: { url: string; headers: Record<string, string> }[] = []
    core.configure({
      dataDir,
      fetch: async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers as Record<string, string> })
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
      secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
      appName: 'temp-code-test'
    })
    core.vault.useFixedChromiumKey('Test Safe Storage', core.vault.randomChromiumKey())
    for (const [name, acct] of [['pinned', 'acct-pin'], ['mine', 'acct-mine']] as const) {
      core.vault.upsertProfile('codex', { name, accountId: acct, createdAt: 1 })
      core.vault.saveSecret('codex', name, JSON.stringify({ tokens: { access_token: `TOKEN-${name}`, account_id: acct } }))
    }
    core.pinProfile('codex', 'pinned')

    const g = await start({ claimShim: false, tls })
    expect(g.status().tls).toEqual({ caPath: tls.caPath, source: 'app' })
    const url = await g.scopedCodexUrl('thread-1', { thread: 'thread-1', account: 'mine', pin: true })
    expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/codex$/)
    const port = Number(new URL(url!).port)
    expect(port).not.toBe(g.status().port)
    expect(g.status().scopedPorts).toEqual({ 'thread-1': port })
    // The same thread keeps its port; a second thread gets another.
    expect(await g.scopedCodexUrl('thread-1', { thread: 'thread-1', account: 'mine', pin: false })).toBe(url)
    const other = await g.scopedCodexUrl('thread-2', { thread: 'thread-2', account: 'pinned', pin: false })
    expect(other).not.toBe(url)

    const tlsFetch = (path: string, method = 'POST'): Promise<{ status: number; body: string }> =>
      new Promise((ok, bad) => {
        const req = httpsRequest(
          { host: '127.0.0.1', port, path, method, rejectUnauthorized: false, headers: { authorization: 'Bearer CLI', 'content-type': 'application/json' } },
          (res) => {
            let body = ''
            res.on('data', (c) => (body += c))
            res.on('end', () => ok({ status: res.statusCode ?? 0, body }))
          }
        )
        req.on('error', bad)
        req.end(method === 'POST' ? '{"model":"gpt-6-sol"}' : undefined)
      })
    // Codex 0.158+ addresses the origin: /backend-api/codex/responses and /backend-api/wham/*.
    expect((await tlsFetch('/backend-api/codex/responses')).status).toBe(200)
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0].headers.authorization).toBe('Bearer TOKEN-mine')
    expect(calls[0].headers['chatgpt-account-id']).toBe('acct-mine')
    // The base's own path survives on the account calls: /codex/api/codex/… maps onto /wham.
    expect((await tlsFetch('/codex/api/codex/accounts/check', 'GET')).status).toBe(200)
    expect(calls[1].url).toBe('https://chatgpt.com/backend-api/wham/accounts/check')
    expect(calls[1].headers.authorization).toBe('Bearer TOKEN-mine')
    expect((await tlsFetch('/backend-api/wham/settings/user', 'GET')).status).toBe(200)
    expect(calls[2].url).toBe('https://chatgpt.com/backend-api/wham/settings/user')
    expect(g.status().routed).toEqual({ codex: 3 })
    // A WebSocket attempt (codex 0.162's first transport) is refused at once.
    const upgrade = await new Promise<string>((ok, bad) => {
      const req = httpsRequest({ host: '127.0.0.1', port, path: '/backend-api/codex/responses', method: 'GET', rejectUnauthorized: false, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
      req.on('upgrade', () => bad(new Error('upgraded')))
      req.on('response', (res) => ok(`${res.statusCode}`))
      req.on('error', bad)
      req.end()
    })
    expect(upgrade).toBe('426')
    // Control paths answer on the scoped port too, unscoped.
    const ctl = await tlsFetch('/__aliax', 'GET')
    expect(ctl.status).toBe(200)
    expect(JSON.parse(ctl.body).owner).toBe('temp-code')
    // The plain port still serves the shim's rewritten path under the pin.
    const plain = await fetch(`http://127.0.0.1:${g.status().port}/codex/codex/responses`, { method: 'POST', headers: { authorization: 'Bearer CLI' }, body: '{}' })
    expect(plain.status).toBe(200)
    expect(calls[3].headers.authorization).toBe('Bearer TOKEN-pinned')

    await g.releaseScoped('thread-1')
    expect(g.status().scopedPorts).toEqual({ 'thread-2': Number(new URL(other!).port) })
    await expect(tlsFetch('/backend-api/codex/responses')).rejects.toThrow()
    await g.releaseScoped('thread-1') // idempotent
  })

  it('reads the model off the scope or the body prefix, never by parsing the body, and forwards the bytes as they came', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'temp-code-gateway-data-'))
    cleanupData = () => rmSync(dataDir, { recursive: true, force: true })
    const bodies: string[] = []
    core.configure({
      dataDir,
      fetch: async (_url, init) => {
        bodies.push(init?.body ? Buffer.from(init.body as Uint8Array).toString() : '')
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
      secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
      appName: 'temp-code-test'
    })
    core.vault.useFixedChromiumKey('Test Safe Storage', core.vault.randomChromiumKey())
    core.vault.upsertProfile('codex', { name: 'p', accountId: 'acct-1', createdAt: 1 })
    core.vault.saveSecret('codex', 'p', JSON.stringify({ tokens: { access_token: 'TOKEN', account_id: 'acct-1' } }))
    core.pinProfile('codex', 'p')
    core.clearRoutes()
    const models: (string | null)[] = []
    const g = await start({ claimShim: false, hooks: { substitute: () => null, onResponse: (i) => models.push(i.model) } })
    const port = g.status().port
    const post = (segment: string, body: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/codex/${segment}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer CLI' }, body })
    // The scope's model when the body names none; the body's first bytes when it does (a side call on another model).
    expect((await post('~t=t1;a=p;m=gpt-6.1-sol', '{"input":"hi"}')).status).toBe(200)
    expect((await post('~t=t1;a=p;m=gpt-6.1-sol', '{"model":"gpt-6-astra","input":"hi"}')).status).toBe(200)
    // A model past the first 1,024 bytes with no scope model is unknown: the body is never parsed whole.
    const far = JSON.stringify({ input: 'x'.repeat(2048), model: 'gpt-6-astra' })
    expect((await post('~t=t1;a=p', far)).status).toBe(200)
    expect(models).toEqual(['gpt-6.1-sol', 'gpt-6-astra', null])
    expect(bodies).toEqual(['{"input":"hi"}', '{"model":"gpt-6-astra","input":"hi"}', far])
  })

  it('moves a scoped request off an account that answers 401, replays it once, and keeps the thread there', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'temp-code-gateway-data-'))
    cleanupData = () => rmSync(dataDir, { recursive: true, force: true })
    const calls: { url: string; auth: string; body: string }[] = []
    const dead = new Set(['TOKEN-dead'])
    core.configure({
      dataDir,
      fetch: async (url, init) => {
        const headers = init?.headers as Record<string, string>
        calls.push({ url: String(url), auth: headers.authorization, body: init?.body ? Buffer.from(init.body as Uint8Array).toString() : '' })
        if (dead.has(headers.authorization.replace('Bearer ', ''))) {
          return new Response('{"detail":{"code":"token_expired"}}', { status: 401, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
      secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
      appName: 'temp-code-test'
    })
    core.vault.useFixedChromiumKey('Test Safe Storage', core.vault.randomChromiumKey())
    for (const name of ['dead', 'alive', 'spare']) {
      core.vault.upsertProfile('codex', { name, accountId: `acct-${name}`, createdAt: 1 })
      core.vault.saveSecret('codex', name, JSON.stringify({ tokens: { access_token: `TOKEN-${name}`, account_id: `acct-${name}` } }))
    }
    core.pinProfile('codex', 'alive')
    core.clearRoutes()

    const out = new Set<string>()
    const unauthorized: string[] = []
    const routed: string[] = []
    const g = await start({
      claimShim: false,
      tls,
      hooks: {
        substitute: (i) => (out.has(i.account) ? [...['alive', 'spare']].find((n) => !out.has(n)) ?? null : null),
        onUnauthorized: (i) => {
          unauthorized.push(`${i.thread}:${i.account}:${i.model}`)
          out.add(i.account)
          return ['alive', 'spare'].find((n) => !out.has(n)) ?? null
        },
        onRouted: (i) => routed.push(`${i.thread}→${i.account}`)
      }
    })
    const port = Number(new URL((await g.scopedCodexUrl('t1', { thread: 't1', account: 'dead', pin: false }))!).port)
    const send = (path: string, method = 'POST'): Promise<{ status: number; body: string }> =>
      new Promise((ok, bad) => {
        const req = httpsRequest({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false, headers: { authorization: 'Bearer CLI', 'content-type': 'application/json' } }, (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => ok({ status: res.statusCode ?? 0, body }))
        })
        req.on('error', bad)
        req.end(method === 'POST' ? '{"model":"gpt-6-astra","input":"hi"}' : undefined)
      })
    // First request: the dead account answers 401, the same bytes replay under the substitute, the client sees 200.
    expect(await send('/backend-api/codex/responses')).toEqual({ status: 200, body: '{"ok":true}' })
    expect(calls.map((c) => c.auth)).toEqual(['Bearer TOKEN-dead', 'Bearer TOKEN-alive'])
    expect(calls[1].body).toBe('{"model":"gpt-6-astra","input":"hi"}')
    expect(unauthorized).toEqual(['t1:dead:gpt-6-astra'])
    expect(routed).toEqual(['t1→alive'])
    // Later requests go straight to the substitute; the row is told once.
    expect((await send('/codex/api/codex/accounts/check', 'GET')).status).toBe(200)
    expect(calls[2].auth).toBe('Bearer TOKEN-alive')
    expect(routed).toEqual(['t1→alive'])
    // The plain port's claude-style scoped path takes the same route.
    const plain = await fetch(`http://127.0.0.1:${g.status().port}/codex/~t=t2;a=dead/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer CLI' }, body: '{}' })
    expect(plain.status).toBe(200)
    expect(calls[3].auth).toBe('Bearer TOKEN-alive')
    expect(routed).toEqual(['t1→alive', 't2→alive'])
    // The account answers again: the thread returns to its own scope, and the row follows.
    out.clear()
    dead.delete('TOKEN-dead')
    expect((await send('/backend-api/codex/responses')).status).toBe(200)
    expect(calls[4].auth).toBe('Bearer TOKEN-dead')
    expect(routed).toEqual(['t1→alive', 't2→alive', 't1→dead'])
    // Nothing left to name: the 401 goes through as it came, once.
    dead.add('TOKEN-dead').add('TOKEN-alive').add('TOKEN-spare')
    const last = await send('/backend-api/codex/responses')
    expect(last.status).toBe(401)
    expect(JSON.parse(last.body)).toEqual({ detail: { code: 'token_expired' } })
    expect(calls.slice(5).map((c) => c.auth)).toEqual(['Bearer TOKEN-dead', 'Bearer TOKEN-alive'])
    expect(unauthorized.slice(1)).toEqual(['t1:dead:gpt-6-astra', 't1:alive:gpt-6-astra'])
    expect(g.status().routed).toEqual({ codex: 5 })
    core.clearRoutes()
  })

  it('has no https origin without a certificate', async () => {
    const g = await start({ claimShim: false, tls: null })
    expect(g.status().tls).toBeNull()
    expect(await g.scopedCodexUrl('t', { thread: 't', account: 'a', pin: false })).toBeNull()
  })
})

describe('scopedCodexPath', () => {
  const scope = { thread: 'th 1', account: 'me@x.com', pin: true }
  const seg = '~t=th%201;a=me%40x.com;pin=1'
  it('rewrites what codex 0.158+ sends an origin into the scoped core path', () => {
    expect(gw.scopedCodexPath('/backend-api/codex/responses', scope)).toBe(`/codex/${seg}/codex/responses`)
    expect(gw.scopedCodexPath('/backend-api/wham/accounts/check', scope)).toBe(`/codex/${seg}/wham/accounts/check`)
    expect(gw.scopedCodexPath('/codex/api/codex/settings/user', scope)).toBe(`/codex/${seg}/api/codex/settings/user`)
    expect(gw.scopedCodexPath('/codex', { ...scope, pin: false })).toBe('/codex/~t=th%201;a=me%40x.com')
    expect(gw.scopedCodexPath('/api/codex/ps/mcp', scope)).toBe(`/codex/${seg}/api/codex/ps/mcp`)
  })
  it('leaves an existing scope and control paths alone', () => {
    expect(gw.scopedCodexPath('/codex/~t=T;a=A/codex/responses', scope)).toBe('/codex/~t=T;a=A/codex/responses')
    expect(gw.scopedCodexPath('/__aliax', scope)).toBe('/__aliax')
    expect(gw.scopedCodexPath('/__aliax/usage?service=codex', scope)).toBe('/__aliax/usage?service=codex')
  })
  it('rescope swaps the scope segment and leaves an unscoped path alone', () => {
    expect(gw.rescope('/codex/~t=T;a=A/codex/responses', scope)).toBe(`/codex/${seg}/codex/responses`)
    expect(gw.rescope('/claude/~t=T;a=A;pin=1/v1/messages', { ...scope, pin: false })).toBe('/claude/~t=th%201;a=me%40x.com/v1/messages')
    expect(gw.rescope('/codex/~t=T;a=A', scope)).toBe(`/codex/${seg}`)
    expect(gw.rescope('/codex/v1/responses', scope)).toBe('/codex/v1/responses')
  })
})
