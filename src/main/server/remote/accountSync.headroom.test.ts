import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeadroomStore } from '../headroom'
import { AccountSync, HEADROOM_PUSH_MS, type HeadroomAnswer } from './accountSync'

/**
 * The headroom picture crossing between hosts: the link holder pushes its
 * own every 30 s and within a second of a 429, the answer carries the
 * peer's, and both merge under the sender's id (headroom.ts merge).
 */
const NOW = 1_800_000_000_000
const headers = (h: Record<string, string>) => new Headers(h)
const memoryStore = () => {
  const rows = new Map<string, string>()
  return { getSetting: (k: string) => rows.get(k) ?? null, setSetting: (k: string, v: string | null) => (v === null ? rows.delete(k) : rows.set(k, v)) }
}

function host(environmentId: string, peers: { id: string; name?: string; connected?: boolean; answer: (params: { from: string; snapshot: unknown }) => HeadroomAnswer | Promise<HeadroomAnswer> }[], extra: { headroomPushMs?: number } = {}) {
  const store = new HeadroomStore({ environmentId, now: () => NOW })
  const nudge = vi.fn()
  const requests: { to: string; params: { from: string; snapshot: unknown } }[] = []
  const links = peers.map((p) => ({
    id: p.id,
    env: { id: p.id, name: p.name ?? p.id },
    connected: p.connected ?? true,
    request: vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe('accounts.headroom')
      requests.push({ to: p.id, params: params as { from: string; snapshot: unknown } })
      return p.answer(params as { from: string; snapshot: unknown })
    })
  }))
  const sync = new AccountSync({
    environmentId,
    store: memoryStore(),
    peers: { get: (id) => links.find((l) => l.id === id) as never, all: () => links as never },
    nudge,
    headroom: store,
    log: () => {},
    ...extra
  })
  return { store, sync, nudge, requests, links }
}

describe('accounts.headroom', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }))
  afterEach(() => vi.useRealTimers())

  it('the push carries this host\'s own picture and merges the answer under the peer\'s id', async () => {
    const box = new HeadroomStore({ environmentId: 'env_box', now: () => NOW })
    box.observe({ service: 'claude-code', account: 'a', model: null, status: 429, headers: headers({ 'retry-after': '40' }) })
    const mac = host('env_mac', [{ id: 'env_box', answer: () => ({ snapshot: box.own() }) }])
    mac.store.observe({ service: 'claude-code', account: 'a', model: null, status: 200, headers: headers({ 'anthropic-ratelimit-requests-limit': '10', 'anthropic-ratelimit-requests-remaining': '4' }) })
    await mac.sync.pushHeadroom()
    expect(mac.requests).toHaveLength(1)
    expect(mac.requests[0].params.from).toBe('env_mac')
    expect(mac.requests[0].params.snapshot).toEqual(mac.store.own())
    const view = mac.store.view('claude-code', 'a')
    expect(view.throttledUntil).toBe(NOW + 40_000)
    expect(view.room).toBeCloseTo(0.4)
    expect(view.ratePerMin).toBe(2)
    expect(mac.nudge).toHaveBeenCalledTimes(1)
    // The same answer again changes nothing and wakes nobody.
    await mac.sync.pushHeadroom()
    expect(mac.nudge).toHaveBeenCalledTimes(1)
    mac.sync.close()
  })

  it('the receiver merges the sender\'s picture, re-picks on a change and answers its own', () => {
    const mac = new HeadroomStore({ environmentId: 'env_mac', now: () => NOW })
    mac.observe({ service: 'codex', account: 'c', model: null, status: 529, headers: headers({}) })
    const box = host('env_box', [])
    box.store.observe({ service: 'claude-code', account: 'a', model: null, status: 200, headers: headers({}) })
    const answer = box.sync.handleHeadroom('env_mac', mac.own())
    expect(answer.snapshot).toEqual(box.store.own())
    expect(box.store.view('codex', 'c').throttledUntil).toBe(NOW + 30_000)
    expect(box.nudge).toHaveBeenCalledTimes(1)
    expect(box.sync.handleHeadroom('env_mac', mac.own()).snapshot).toEqual(box.store.own())
    expect(box.nudge).toHaveBeenCalledTimes(1)
    // A host without a store answers null and takes nothing.
    const bare = new AccountSync({ environmentId: 'env_old', store: memoryStore(), peers: { get: () => undefined, all: () => [] }, nudge: vi.fn(), log: () => {} })
    expect(bare.handleHeadroom('env_mac', mac.own())).toEqual({ snapshot: null })
    box.sync.close()
  })

  it('pushes every 30 s to every connected peer, and within a second of a 429', async () => {
    const mac = host('env_mac', [
      { id: 'env_box', answer: () => ({ snapshot: null }) },
      { id: 'env_down', connected: false, answer: () => ({ snapshot: null }) }
    ])
    expect(mac.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(HEADROOM_PUSH_MS)
    expect(mac.requests.map((r) => r.to)).toEqual(['env_box'])
    await vi.advanceTimersByTimeAsync(HEADROOM_PUSH_MS)
    expect(mac.requests).toHaveLength(2)
    mac.sync.pushHeadroomSoon()
    mac.sync.pushHeadroomSoon()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mac.requests).toHaveLength(3)
    mac.sync.close()
    await vi.advanceTimersByTimeAsync(HEADROOM_PUSH_MS * 2)
    expect(mac.requests).toHaveLength(3)
  })

  it('a peer that fails the request is logged and the rest still answer', async () => {
    const mac = host('env_mac', [
      { id: 'env_bad', answer: () => Promise.reject(new Error('timeout')) },
      { id: 'env_box', answer: () => ({ snapshot: null }) }
    ])
    await mac.sync.pushHeadroom()
    expect(mac.requests.map((r) => r.to).sort()).toEqual(['env_bad', 'env_box'])
    mac.sync.close()
  })
})
