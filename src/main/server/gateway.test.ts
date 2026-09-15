import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The marker lives under $HOME/.aliax, fixed at import time: point HOME at a
// scratch dir before core loads so no test ever touches the real shim marker.
const home = mkdtempSync(join(tmpdir(), 'temp-code-gateway-home-'))
const realHome = process.env.HOME
let core: typeof import('aliax-core')
let gw: typeof import('./gateway')
let markerPath = ''

beforeAll(async () => {
  process.env.HOME = home
  core = await import('aliax-core')
  gw = await import('./gateway')
  markerPath = core.MARKER_PATH
  expect(markerPath.startsWith(home)).toBe(true)
})
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
  const g = new gw.Gateway({ claimShim: true, tickMs: 50, ...options })
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
    expect(gw.mayClaimShim({ isPackaged: true, env: {} })).toBe(true)
    expect(gw.mayClaimShim({ isPackaged: false, env: {} })).toBe(false)
    expect(gw.mayClaimShim({ isPackaged: false, env: { TEMP_CODE_USER_DATA: prod } })).toBe(true)
    expect(gw.mayClaimShim({ isPackaged: false, env: { TEMP_CODE_USER_DATA: `${prod}-dev` } })).toBe(false)
    expect(
      gw.mayClaimShim({ isPackaged: false, env: { TEMP_CODE_USER_DATA: `${prod}-dev`, TEMP_CODE_CLAIM_SHIM: '1' } })
    ).toBe(true)
    expect(gw.mayClaimShim({ isPackaged: true, env: { TEMP_CODE_USER_DATA: `${prod}-dev` } })).toBe(false)
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
    expect(await res.json()).toEqual({ ok: true, pid: process.pid, owner: 'temp-code' })
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
})
