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
    // The model rides as `m=`, encoded, with the CLI's `[1m]` window suffix stripped; none without one.
    expect(routeUrl('http://127.0.0.1:5/claude', 'T', { account: 'A', pin: false }, 'claude-fable-5-1[1m]')).toBe('http://127.0.0.1:5/claude/~t=T;a=A;m=claude-fable-5-1')
    expect(routeUrl('http://127.0.0.1:5/claude', 'T', { account: 'A', pin: true }, 'x/y')).toBe('http://127.0.0.1:5/claude/~t=T;a=A;pin=1;m=x%2Fy')
    expect(routeUrl('http://127.0.0.1:5/claude', 'T', { account: 'A', pin: false }, null)).toBe('http://127.0.0.1:5/claude/~t=T;a=A')
    expect(routeUrl('http://127.0.0.1:5/claude', 'T', { account: 'A', pin: false }, '[1m]')).toBe('http://127.0.0.1:5/claude/~t=T;a=A')
  })

  it('routedEndpointFor scopes the URL only when the owner lists scoped-routes, and remembers the answer per origin', async () => {
    let now = 1_000_000
    const gatewayUrl = (s: string) => `http://127.0.0.1:5/${s}`
    const fetch = vi.fn(async (input: URL | RequestInfo) => (String(input).endsWith('/__aliax') ? json({ ok: true, features: ['scoped-routes'] }) : json({ ok: true })))
    // No certificate: codex takes the shared path like claude.
    const scopedCodexUrl = async () => null
    const deps = { shimInstalled: () => false, fetch, gatewayUrl, scopedCodexUrl, now: () => now }
    const route = { account: 'me@x.com', pin: false }
    expect(await routedEndpointFor('claude', { thread: 'T', route }, deps)).toEqual({ url: 'http://127.0.0.1:5/claude/~t=T;a=me%40x.com', account: 'me@x.com' })
    expect(await routedEndpointFor('claude', { thread: 'T', route, model: 'claude-opus-5-5[1m]' }, deps)).toEqual({ url: 'http://127.0.0.1:5/claude/~t=T;a=me%40x.com;m=claude-opus-5-5', account: 'me@x.com' })
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

  it('a codex thread with a route gets its own https origin from the gateway, even when the shim answers', async () => {
    const fetch = vi.fn(async () => json({ ok: true }))
    const scopedCodexUrl = vi.fn(async (thread: string, route: { account: string; pin: boolean }) => `https://127.0.0.1:${thread.length}${route.pin ? 1 : 0}/codex`)
    const deps = { shimInstalled: () => true, fetch, gatewayUrl: () => 'http://127.0.0.1:5/codex', scopedCodexUrl }
    expect(await routedEndpointFor('codex', { thread: 'abc', route: { account: 'me', pin: true } }, deps)).toEqual({ url: 'https://127.0.0.1:31/codex', account: 'me' })
    expect(scopedCodexUrl).toHaveBeenCalledWith('abc', { account: 'me', pin: true })
    // The thread's model reaches the port's scope.
    expect(await routedEndpointFor('codex', { thread: 'abc', route: { account: 'me', pin: true }, model: 'gpt-6.1-sol' }, deps)).toEqual({ url: 'https://127.0.0.1:31/codex', account: 'me' })
    expect(scopedCodexUrl).toHaveBeenLastCalledWith('abc', { account: 'me', pin: true }, 'gpt-6.1-sol')
    // No shim probe, no feature probe: the port is ours.
    expect(fetch).not.toHaveBeenCalled()
    // Without a route the thread shares the plain path (and the shim when it answers).
    expect(await routedEndpointFor('codex', { thread: 'abc', route: null }, deps)).toEqual({ url: `${SHIM_URL}/codex`, account: null })
    // Claude never takes a codex port.
    forgetShimAnswer()
    const claude = await routedEndpointFor('claude', { thread: 'abc', route: { account: 'me', pin: false } }, { ...deps, shimInstalled: () => false, fetch: vi.fn(async () => json({ ok: true, features: ['scoped-routes'] })), gatewayUrl: () => 'http://127.0.0.1:5/claude' })
    expect(claude.url).toBe('http://127.0.0.1:5/claude/~t=abc;a=me')
    expect(scopedCodexUrl).toHaveBeenCalledTimes(2)
  })

  it('remembers the shim answer for 30 s', async () => {
    let now = 1_000_000
    const fetch = vi.fn(async () => json({ ok: true }))
    const deps = { shimInstalled: () => true, fetch, gatewayUrl: () => null, scopedCodexUrl: async () => null, now: () => now }
    await endpointFor('claude', deps)
    now += 10_000
    await endpointFor('codex', deps)
    expect(fetch).toHaveBeenCalledTimes(1)
    now += 25_000
    await endpointFor('codex', deps)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
