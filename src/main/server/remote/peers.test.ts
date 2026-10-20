import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { ENVIRONMENTS_PREFIX } from './environments'
import { PeerLink, Peers } from './peers'

/** A host: hello first, then every request echoed back as its result, plus whatever the test pushes. */
async function fakeHost(environmentId: string) {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const sockets = new Set<WebSocket>()
  const tickets: string[] = []
  wss.on('connection', (ws, req) => {
    const ticket = new URL(req.url ?? '/', 'http://x').searchParams.get('ticket')
    if (!ticket) return ws.close(4003, 'no ticket')
    tickets.push(ticket)
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
    ws.send(JSON.stringify({ push: 'hello', environmentId, contract: 1, caps: ['admin'] }))
    ws.on('message', (data) => {
      const req = JSON.parse(String(data)) as { id: string; method: string; params?: unknown }
      if (req.method === 'fail') ws.send(JSON.stringify({ id: req.id, ok: false, error: 'nope' }))
      else ws.send(JSON.stringify({ id: req.id, ok: true, result: { method: req.method, params: req.params } }))
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  return {
    port,
    tickets,
    push: (frame: unknown) => {
      for (const ws of sockets) ws.send(JSON.stringify(frame))
    },
    dropAll: () => {
      for (const ws of sockets) ws.close(1012, 'restart')
    },
    closeAll: (code: number, reason: string) => {
      for (const ws of sockets) ws.close(code, reason)
    },
    close: async () => {
      for (const ws of sockets) ws.terminate()
      wss.close()
      await new Promise<void>((ok) => server.close(() => ok()))
    }
  }
}

const storeWith = (rows: Record<string, string>) => ({
  getSetting: (key: string) => rows[key] ?? null,
  setSetting: (key: string, value: string | null) => {
    if (value === null) delete rows[key]
    else rows[key] = value
  },
  settingsWithPrefix: (prefix: string) => new Map(Object.entries(rows).filter(([k]) => k.startsWith(prefix)))
})

/** The ticket POST answered without a listener: the fake host does not serve /api/ticket. */
const ticketFetch = vi.fn(async (url: string) => {
  if (!url.endsWith('/api/ticket')) throw new Error(`unexpected ${url}`)
  return new Response(JSON.stringify({ ticket: `t-${ticketFetch.mock.calls.length}`, expiresIn: 30_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
})

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
  ticketFetch.mockClear()
})

describe('PeerLink', () => {
  it('connects with a ticket, checks the hello, round-trips requests, hears pushes and reconnects after a drop', async () => {
    const hostA = await fakeHost('env_a')
    cleanup.push(hostA.close)
    const env = { id: 'env_a', name: 'A', routes: [{ url: `ws://127.0.0.1:${hostA.port}/ws`, kind: 'loopback' as const }], addedAt: 1, caps: ['admin' as const], keyName: 'k' }
    const store = storeWith({ [`${ENVIRONMENTS_PREFIX}env_a`]: JSON.stringify({ ...env, key: 'tc_x.secret' }) })
    const events = { onOpen: vi.fn(), onClose: vi.fn(), onPush: vi.fn() }
    const link = new PeerLink(env, { store, environmentId: 'env_me', fetch: ticketFetch as unknown as typeof fetch }, events)
    cleanup.push(async () => link.close())
    await link.connect()
    expect(link.connected).toBe(true)
    expect(events.onOpen).toHaveBeenCalledWith('env_a')
    expect(hostA.tickets).toEqual(['t-1'])
    expect(await link.request('accounts.pull', { from: 'env_me' })).toEqual({ method: 'accounts.pull', params: { from: 'env_me' } })
    await expect(link.request('fail')).rejects.toThrow('nope')
    hostA.push({ push: 'account', from: 'env_a', transfer: { service: 'codex' } })
    await vi.waitFor(() => expect(events.onPush).toHaveBeenCalledWith('env_a', expect.objectContaining({ push: 'account' })))
    expect(link.state()).toEqual({ name: 'A', connected: true, lastSyncAt: null, error: null })
    hostA.dropAll()
    await vi.waitFor(() => expect(events.onClose).toHaveBeenCalledWith('env_a'))
    expect(link.connected).toBe(false)
    await expect(link.request('x')).rejects.toThrow('not connected')
    // Backoff is armed; an explicit retry connects again with a fresh ticket.
    expect(link.attempts).toBe(1)
    link.retry()
    await vi.waitFor(() => expect(link.connected).toBe(true), { timeout: 5_000 })
    expect(hostA.tickets).toEqual(['t-1', 't-2'])
  })

  it('refuses a host that answers under another environment id', async () => {
    const hostB = await fakeHost('env_other')
    cleanup.push(hostB.close)
    const env = { id: 'env_b', name: 'B', routes: [{ url: `ws://127.0.0.1:${hostB.port}/ws`, kind: 'loopback' as const }], addedAt: 1, caps: ['admin' as const], keyName: 'k' }
    const store = storeWith({ [`${ENVIRONMENTS_PREFIX}env_b`]: JSON.stringify({ ...env, key: 'tc_x.secret' }) })
    const link = new PeerLink(env, { store, environmentId: 'env_me', fetch: ticketFetch as unknown as typeof fetch }, {})
    cleanup.push(async () => link.close())
    await link.connect()
    expect(link.connected).toBe(false)
    expect(link.lastError).toMatch(/answered as env_other/)
  })
})

describe('Peers', () => {
  it('keeps one link per saved admin host and drops the rest on refresh', async () => {
    const hostA = await fakeHost('env_a')
    cleanup.push(hostA.close)
    const row = (id: string, caps: string[]) => JSON.stringify({ name: id, routes: [{ url: `ws://127.0.0.1:${hostA.port}/ws`, kind: 'loopback' }], addedAt: 1, caps, keyName: 'k', key: 'tc_x.s' })
    const rows: Record<string, string> = { [`${ENVIRONMENTS_PREFIX}env_a`]: row('env_a', ['read', 'admin']), [`${ENVIRONMENTS_PREFIX}env_r`]: row('env_r', ['read']) }
    const store = storeWith(rows)
    const peers = new Peers({ store, environmentId: 'env_me', fetch: ticketFetch as unknown as typeof fetch }, {}, () => {})
    cleanup.push(async () => peers.close())
    peers.refresh()
    expect(peers.all().map((l) => l.id)).toEqual(['env_a'])
    await vi.waitFor(() => expect(peers.get('env_a')?.connected).toBe(true))
    peers.refresh()
    expect(peers.all()).toHaveLength(1)
    delete rows[`${ENVIRONMENTS_PREFIX}env_a`]
    peers.refresh()
    expect(peers.all()).toEqual([])
    expect(peers.states()).toEqual({})
  })

  it('a re-pair that kept the routes but changed the key rebuilds the link', async () => {
    const hostA = await fakeHost('env_a')
    cleanup.push(hostA.close)
    const row = (key: string) => JSON.stringify({ name: 'A', routes: [{ url: `ws://127.0.0.1:${hostA.port}/ws`, kind: 'loopback' }], addedAt: 1, caps: ['read', 'admin'], keyName: 'k', key })
    const rows: Record<string, string> = { [`${ENVIRONMENTS_PREFIX}env_a`]: row('tc_old.secret') }
    const store = storeWith(rows)
    const lines: string[] = []
    const peers = new Peers({ store, environmentId: 'env_me', fetch: ticketFetch as unknown as typeof fetch }, {}, (l) => lines.push(l))
    cleanup.push(async () => peers.close())
    peers.refresh()
    const first = peers.get('env_a')!
    await vi.waitFor(() => expect(first.connected).toBe(true))
    expect(first.credential).toMatch(/^[0-9a-f]{16}$/)
    expect(first.credential).not.toContain('secret')
    // The key was revoked on the host: the link stops retrying for good.
    hostA.closeAll(4001, 'revoked')
    await vi.waitFor(() => expect(first.connected).toBe(false))
    expect(first.lastError).toBe('key revoked')
    peers.refresh()
    expect(peers.get('env_a')).toBe(first)
    // Paired again: same routes, new key. The stopped link gives way to a fresh one.
    rows[`${ENVIRONMENTS_PREFIX}env_a`] = row('tc_new.secret2')
    peers.refresh()
    const second = peers.get('env_a')!
    expect(second).not.toBe(first)
    expect(second.credential).not.toBe(first.credential)
    await vi.waitFor(() => expect(second.connected).toBe(true))
    expect(hostA.tickets).toEqual(['t-1', 't-2'])
    expect(lines).toContain('A: key changed, reconnecting')
    peers.refresh()
    expect(peers.get('env_a')).toBe(second)
  })
})
