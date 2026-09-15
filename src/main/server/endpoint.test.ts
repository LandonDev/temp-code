import { beforeEach, describe, expect, it, vi } from 'vitest'
import { endpointFor, forgetShimAnswer, SHIM_URL } from './endpoint'

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
