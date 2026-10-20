import { describe, expect, it, vi } from 'vitest'
import { CONTRACT_VERSION } from '@shared/capabilities'
import {
  addEnvironment,
  HostError,
  kindOf,
  listEnvironments,
  mintTicket,
  normalizeRoute,
  originOf,
  pairEnvironment,
  parsePairingLink,
  removeEnvironment,
  updateEnvironment,
  type EnvironmentsStore
} from './environments'

function fakeStore(): EnvironmentsStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    getSetting: (key) => rows.get(key) ?? null,
    setSetting: (key, value) => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
    },
    settingsWithPrefix: (prefix) => new Map([...rows].filter(([k]) => k.startsWith(prefix)))
  }
}

const HOST_ID = 'env_' + 'a'.repeat(22)
const SELF_ID = 'env_' + 'b'.repeat(22)
const hello = (extra: object = {}) => ({ environmentId: HOST_ID, name: 'box', version: '1.0.1', contract: CONTRACT_VERSION, ...extra })
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function ctxWith(store: EnvironmentsStore, answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return answer(url, init)
  }) as unknown as typeof fetch
  return { ctx: { store, environmentId: SELF_ID, fetch: fetchImpl, timeoutMs: 1000 }, calls }
}

describe('routes', () => {
  it('turns an http(s) origin into the fixed port socket URL and keeps a ws URL', () => {
    expect(normalizeRoute('https://tempcode.example.com')).toEqual({ url: 'wss://tempcode.example.com/ws', kind: 'tunnel' })
    expect(normalizeRoute('http://192.168.1.20:7677/')).toEqual({ url: 'ws://192.168.1.20:7677/ws', kind: 'lan' })
    expect(normalizeRoute('ws://127.0.0.1:4000')).toEqual({ url: 'ws://127.0.0.1:4000', kind: 'loopback' })
    expect(normalizeRoute(' wss://h/ws?x=1#f ', 'lan')).toEqual({ url: 'wss://h/ws', kind: 'lan' })
    expect(() => normalizeRoute('ftp://h')).toThrow(HostError)
    expect(() => normalizeRoute('not a url')).toThrow(/bad-url/)
  })
  it('derives the HTTP origin from the socket URL', () => {
    expect(originOf({ url: 'wss://tempcode.example.com/ws' })).toBe('https://tempcode.example.com')
    expect(originOf({ url: 'ws://10.0.0.5:7677/ws' })).toBe('http://10.0.0.5:7677')
  })
  it('classifies hosts', () => {
    expect(kindOf('localhost')).toBe('loopback')
    expect(kindOf('10.1.2.3')).toBe('lan')
    expect(kindOf('172.20.0.1')).toBe('lan')
    expect(kindOf('mini.local')).toBe('lan')
    expect(kindOf('tempcode.example.com')).toBe('tunnel')
  })
})

describe('addEnvironment', () => {
  it('reads the host id from /api/hello with the key, saves the key for the main process only', async () => {
    const store = fakeStore()
    const { ctx, calls } = ctxWith(store, () => json(200, hello({ key: { id: 'k1', name: 'phone', caps: ['read'], audience: 'client' } })))
    const saved = await addEnvironment(ctx, { url: 'https://tempcode.example.com', key: 'tc_k1.secret' })
    expect(calls[0].url).toBe('https://tempcode.example.com/api/hello')
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tc_k1.secret')
    expect(saved).toEqual({
      id: HOST_ID,
      name: 'box',
      routes: [{ url: 'wss://tempcode.example.com/ws', kind: 'tunnel' }],
      addedAt: expect.any(Number),
      caps: ['read'],
      keyName: 'phone',
      keyId: 'k1'
    })
    expect(listEnvironments(store)).toEqual([saved])
    expect(JSON.stringify(listEnvironments(store))).not.toContain('secret')
    expect(store.rows.get(`remote.environments.${HOST_ID}`)).toContain('tc_k1.secret')
  })
  it('adding the same host over another URL appends the route and replaces the key', async () => {
    const store = fakeStore()
    const { ctx } = ctxWith(store, () => json(200, hello({ key: { id: 'k1', name: 'p' } })))
    await addEnvironment(ctx, { url: 'https://tempcode.example.com', key: 'tc_k1.one', name: 'Box' })
    const saved = await addEnvironment(ctx, { url: 'http://192.168.1.20:7677', key: 'tc_k1.two' })
    expect(saved.name).toBe('Box')
    expect(saved.routes.map((r) => r.url)).toEqual(['wss://tempcode.example.com/ws', 'ws://192.168.1.20:7677/ws'])
    expect(listEnvironments(store)).toHaveLength(1)
    expect(store.rows.get(`remote.environments.${HOST_ID}`)).toContain('tc_k1.two')
    expect(store.rows.get(`remote.environments.${HOST_ID}`)).not.toContain('tc_k1.one')
  })
  it('a key the host does not take is unauthorized; a non-host is unavailable; this machine is refused', async () => {
    const store = fakeStore()
    await expect(addEnvironment(ctxWith(store, () => json(200, hello())).ctx, { url: 'https://h', key: 'tc_x.y' })).rejects.toThrow(/^unauthorized:/)
    await expect(addEnvironment(ctxWith(store, () => json(503, {})).ctx, { url: 'https://h', key: 'tc_x.y' })).rejects.toThrow(/^unavailable:.*503/)
    await expect(addEnvironment(ctxWith(store, () => json(200, { hi: 1 })).ctx, { url: 'https://h', key: 'tc_x.y' })).rejects.toThrow(/not a temp-code host/)
    await expect(
      addEnvironment(ctxWith(store, () => json(200, hello({ environmentId: SELF_ID, key: { id: 'k', name: 'n' } }))).ctx, { url: 'https://h', key: 'tc_x.y' })
    ).rejects.toThrow(/^self:/)
    await expect(
      addEnvironment(ctxWith(store, () => Promise.reject(new TypeError('fetch failed'))).ctx, { url: 'https://h', key: 'tc_x.y' })
    ).rejects.toThrow(/^unavailable:.*fetch failed/)
    expect(listEnvironments(store)).toEqual([])
  })
  it('refuses a host on another contract version and says which side to update', async () => {
    const store = fakeStore()
    const older = ctxWith(store, () => json(200, hello({ contract: CONTRACT_VERSION - 1, key: { id: 'k', name: 'n' } }))).ctx
    await expect(addEnvironment(older, { url: 'https://h', key: 'tc_x.y' })).rejects.toThrow(/^contract:.*update the host/)
    const newer = ctxWith(store, () => json(200, hello({ contract: CONTRACT_VERSION + 1, key: { id: 'k', name: 'n' } }))).ctx
    await expect(addEnvironment(newer, { url: 'https://h', key: 'tc_x.y' })).rejects.toThrow(/^contract:.*update the app/)
    expect(listEnvironments(store)).toEqual([])
  })
})

describe('pairEnvironment', () => {
  it('reads the origin and code off a pairing link', () => {
    expect(parsePairingLink('https://tempcode.example.com/pair#ABCDE-12345')).toEqual({ origin: 'https://tempcode.example.com', code: 'ABCDE-12345' })
    expect(parsePairingLink(' http://10.0.0.5:7677/pair#abcde-fghij ')).toEqual({ origin: 'http://10.0.0.5:7677', code: 'ABCDE-FGHIJ' })
    expect(() => parsePairingLink('https://tempcode.example.com/pair')).toThrow(/^bad-link:/)
    expect(() => parsePairingLink('ABCDE-12345')).toThrow(/^bad-link:/)
  })
  it('exchanges the code for a key on the host, then saves the host with that key', async () => {
    const store = fakeStore()
    const { ctx, calls } = ctxWith(store, (url) =>
      url.endsWith('/api/pair')
        ? json(200, { key: 'tc_k9.fresh', keyId: 'k9', name: 'mac', caps: ['read', 'operate'], audience: 'client', environmentId: HOST_ID })
        : json(200, hello({ key: { id: 'k9', name: 'mac', caps: ['read', 'operate'], audience: 'client' } }))
    )
    const saved = await pairEnvironment(ctx, { link: 'https://tempcode.example.com/pair#ABCDE-12345', name: 'Box' })
    expect(calls[0].url).toBe('https://tempcode.example.com/api/pair')
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ code: 'ABCDE-12345', kind: 'key' })
    expect(calls[1].url).toBe('https://tempcode.example.com/api/hello')
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe('Bearer tc_k9.fresh')
    expect(saved).toMatchObject({ id: HOST_ID, name: 'Box', caps: ['read', 'operate'], keyName: 'mac', routes: [{ url: 'wss://tempcode.example.com/ws', kind: 'tunnel' }] })
    expect(store.rows.get(`remote.environments.${HOST_ID}`)).toContain('tc_k9.fresh')
  })
  it('a refused code is unauthorized and nothing is saved', async () => {
    const store = fakeStore()
    await expect(pairEnvironment(ctxWith(store, () => json(401, { error: 'bad code' })).ctx, { origin: 'https://h', code: 'ABCDE-12345' })).rejects.toThrow(/^unauthorized:.*pairing code/)
    await expect(pairEnvironment(ctxWith(store, () => json(200, {})).ctx, { link: 'https://h/pair#ABCDE-12345' })).rejects.toThrow(/^unavailable:.*no key/)
    await expect(pairEnvironment(ctxWith(store, () => json(200, {})).ctx, {})).rejects.toThrow(/^bad-link:/)
    expect(listEnvironments(store)).toEqual([])
  })
})

describe('mintTicket', () => {
  async function saved() {
    const store = fakeStore()
    await addEnvironment(ctxWith(store, () => json(200, hello({ key: { id: 'k1', name: 'p' } }))).ctx, { url: 'https://h.example', key: 'tc_k1.s' })
    return store
  }
  it('posts /api/ticket on the route origin with the saved key', async () => {
    const store = await saved()
    const { ctx, calls } = ctxWith(store, () => json(200, { ticket: 'tk_1', expiresIn: 30000 }))
    await expect(mintTicket(ctx, HOST_ID, 'wss://h.example/ws')).resolves.toEqual({ ticket: 'tk_1', expiresIn: 30000 })
    expect(calls[0]).toMatchObject({ url: 'https://h.example/api/ticket', init: { method: 'POST' } })
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tc_k1.s')
  })
  it('maps 401/403 to unauthorized and refuses unknown routes and environments', async () => {
    const store = await saved()
    await expect(mintTicket(ctxWith(store, () => json(401, {})).ctx, HOST_ID, 'wss://h.example/ws')).rejects.toThrow(/^unauthorized:/)
    await expect(mintTicket(ctxWith(store, () => json(500, {})).ctx, HOST_ID, 'wss://h.example/ws')).rejects.toThrow(/^unavailable:/)
    await expect(mintTicket(ctxWith(store, () => json(200, {})).ctx, HOST_ID, 'wss://h.example/ws')).rejects.toThrow(/no ticket/)
    await expect(mintTicket(ctxWith(store, () => json(200, {})).ctx, HOST_ID, 'wss://other/ws')).rejects.toThrow(/^unknown-route:/)
    await expect(mintTicket(ctxWith(store, () => json(200, {})).ctx, 'env_nope', 'wss://h.example/ws')).rejects.toThrow(/^unknown-environment:/)
  })
})

describe('update and remove', () => {
  it('renames, reorders routes and removes', async () => {
    const store = fakeStore()
    await addEnvironment(ctxWith(store, () => json(200, hello({ key: { id: 'k1', name: 'p' } }))).ctx, { url: 'https://h.example', key: 'tc_k1.s' })
    const updated = updateEnvironment(store, {
      id: HOST_ID,
      name: 'Studio',
      routes: [
        { url: 'http://10.0.0.9:7677', kind: 'lan' },
        { url: 'wss://h.example/ws', kind: 'tunnel' }
      ]
    })
    expect(updated.name).toBe('Studio')
    expect(updated.routes.map((r) => r.url)).toEqual(['ws://10.0.0.9:7677/ws', 'wss://h.example/ws'])
    expect(store.rows.get(`remote.environments.${HOST_ID}`)).toContain('tc_k1.s')
    expect(() => updateEnvironment(store, { id: 'env_x', name: 'n' })).toThrow(/^unknown-environment:/)
    expect(removeEnvironment(store, HOST_ID)).toBe(true)
    expect(removeEnvironment(store, HOST_ID)).toBe(false)
    expect(listEnvironments(store)).toEqual([])
  })
})
