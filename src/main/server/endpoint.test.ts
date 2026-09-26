import { beforeEach, describe, expect, it, vi } from 'vitest'
import { endpointFor, forgetShimAnswer, routedEndpointFor, routeUrl, SHIM_URL } from './endpoint'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('endpointFor', () => {
  beforeEach(forgetShimAnswer)

  it('prefers a shim that answers, and reads its port from the fixed URL', async () => {
    const fetch = vi.fn(async () => json({ ok: true, aliax: true }))
    const url = await endpointFor('claude', { shimInstalled: () => true, fetch, gatewayUrl: () => 'http://127.0.0.1:5/claude' })
    expect(url).toBe(`${SHIM_URL}/claude`)
    expect(fetch).toHaveBeenCalledWith(`${SHIM_URL}/__shim`, expect.anything())
  })

  it('falls back to the gateway when the shim is absent, dead, or answers oddly', async () => {
    const gatewayUrl = (s: string) => `http://127.0.0.1:5/${s}`
    expect(await endpointFor('codex', { shimInstalled: () => false, fetch: vi.fn(), gatewayUrl })).toBe('http://127.0.0.1:5/codex')
    forgetShimAnswer()
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await endpointFor('codex', { shimInstalled: () => true, fetch: dead, gatewayUrl })).toBe('http://127.0.0.1:5/codex')
    forgetShimAnswer()
    const odd = vi.fn(async () => json({ ok: false }))
    expect(await endpointFor('claude', { shimInstalled: () => true, fetch: odd, gatewayUrl })).toBe('http://127.0.0.1:5/claude')
    forgetShimAnswer()
    expect(await endpointFor('claude', { shimInstalled: () => false, fetch: vi.fn(), gatewayUrl: () => null })).toBeNull()
  })

  it('routeUrl encodes the thread and account and marks a pin', () => {
    expect(routeUrl('http://127.0.0.1:5/claude', 'th 1', { account: 'me@x.com', pin: true })).toBe('http://127.0.0.1:5/claude/~t=th%201;a=me%40x.com;pin=1')
    expect(routeUrl('http://127.0.0.1:5/codex', 'T', { account: 'B', pin: false })).toBe('http://127.0.0.1:5/codex/~t=T;a=B')
  })

  it('routedEndpointFor scopes the URL only when the owner lists scoped-routes, and remembers the answer per origin', async () => {
    let now = 1_000_000
    const gatewayUrl = (s: string) => `http://127.0.0.1:5/${s}`
    const fetch = vi.fn(async (input: URL | RequestInfo) => (String(input).endsWith('/__aliax') ? json({ ok: true, features: ['scoped-routes'] }) : json({ ok: true })))
    const deps = { shimInstalled: () => false, fetch, gatewayUrl, now: () => now }
    const route = { account: 'me@x.com', pin: false }
    expect(await routedEndpointFor('claude', { thread: 'T', route }, deps)).toEqual({ url: 'http://127.0.0.1:5/claude/~t=T;a=me%40x.com', account: 'me@x.com' })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5/claude/__aliax', expect.anything())
    now += 10_000
    expect((await routedEndpointFor('codex', { thread: 'T', route }, deps)).url).toBe('http://127.0.0.1:5/codex/~t=T;a=me%40x.com')
    expect(fetch).toHaveBeenCalledTimes(1)
    // No route: unscoped, no probe.
    expect(await routedEndpointFor('claude', { thread: 'T', route: null }, deps)).toEqual({ url: 'http://127.0.0.1:5/claude', account: null })
    expect(fetch).toHaveBeenCalledTimes(1)
    // An older owner: unscoped, the CLI spends from the pin.
    forgetShimAnswer()
    const old = vi.fn(async () => json({ ok: true, pid: 1, owner: 'aliax' }))
    expect(await routedEndpointFor('claude', { thread: 'T', route }, { ...deps, fetch: old })).toEqual({ url: 'http://127.0.0.1:5/claude', account: null })
    forgetShimAnswer()
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect((await routedEndpointFor('claude', { thread: 'T', route }, { ...deps, fetch: dead })).account).toBeNull()
    forgetShimAnswer()
    expect(await routedEndpointFor('claude', { thread: 'T', route }, { ...deps, gatewayUrl: () => null })).toEqual({ url: null, account: null })
  })

  it('remembers the shim answer for 30 s', async () => {
    let now = 1_000_000
    const fetch = vi.fn(async () => json({ ok: true }))
    const deps = { shimInstalled: () => true, fetch, gatewayUrl: () => null, now: () => now }
    await endpointFor('claude', deps)
    now += 10_000
    await endpointFor('codex', deps)
    expect(fetch).toHaveBeenCalledTimes(1)
    now += 25_000
    await endpointFor('codex', deps)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
