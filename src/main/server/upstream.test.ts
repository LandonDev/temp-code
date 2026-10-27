import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Upstream, UpstreamTimeout, authKey, newTrace, upstreamTrace, type UpstreamTrace } from './upstream'

/** A keep-alive origin that counts sockets and remembers each request's line and auth. */
function origin(): Promise<{ server: Server; url: string; connections: number; requests: { method: string; url: string; auth: string | null }[] }> {
  const state = { server: null as unknown as Server, url: '', connections: 0, requests: [] as { method: string; url: string; auth: string | null }[] }
  const server = createServer((req, res) => {
    state.requests.push({ method: req.method ?? '', url: req.url ?? '', auth: (req.headers.authorization as string | undefined) ?? null })
    res.setHeader('content-type', 'application/json')
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }))
  })
  server.keepAliveTimeout = 10_000
  server.on('connection', () => state.connections++)
  state.server = server
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      ok(state)
    })
  )
}

/**
 * A traced request. undici marks a socket free one tick after its response
 * body ends, so a request fired on the very same tick as the previous one's
 * end would open a second socket; real turns are spaced by model time, and
 * the helper yields that tick.
 */
const traced = async (up: Upstream, url: string, init?: RequestInit): Promise<UpstreamTrace> => {
  await new Promise((ok) => setImmediate(ok))
  const trace = newTrace()
  const res = await upstreamTrace.run(trace, () => up.fetch(url, init))
  await res.arrayBuffer()
  return trace
}

describe('upstream pools', () => {
  let a: Awaited<ReturnType<typeof origin>>
  let ups: Upstream[] = []
  const make = (opts: Partial<ConstructorParameters<typeof Upstream>[0]> = {}): Upstream => {
    const up = new Upstream({
      chromiumFetch: () => Promise.reject(new Error('chromium fetch must not be used for a pooled origin')),
      pooled: () => true,
      ...opts
    })
    ups.push(up)
    return up
  }
  beforeEach(async () => {
    a = await origin()
  })
  afterEach(async () => {
    await Promise.all(ups.map((u) => u.close()))
    ups = []
    vi.unstubAllEnvs()
    a.server.closeAllConnections()
    await new Promise((ok) => a.server.close(ok))
  })

  it('reuses one account\'s socket across requests and says so in the trace', async () => {
    const up = make()
    const auth = { authorization: 'Bearer one' }
    const first = await traced(up, `${a.url}/v1/messages`, { method: 'POST', headers: auth, body: '{}' })
    const second = await traced(up, `${a.url}/v1/messages`, { method: 'POST', headers: auth, body: '{}' })
    expect(first).toMatchObject({ reused: false, protocol: 'http', queued: false })
    expect(second).toMatchObject({ reused: true, protocol: 'http', queued: false })
    expect(first.pool).toBe(`${a.url}|${authKey(auth)}`)
    expect(a.connections).toBe(1)
    expect(a.requests.map((r) => r.auth)).toEqual(['Bearer one', 'Bearer one'])
  })

  it('keeps a pool per account: another token opens its own socket', async () => {
    const up = make()
    await traced(up, `${a.url}/v1/messages`, { headers: { authorization: 'Bearer one' } })
    const other = await traced(up, `${a.url}/v1/messages`, { headers: { authorization: 'Bearer two' } })
    expect(other.reused).toBe(false)
    expect(a.connections).toBe(2)
    expect(up.status().map((p) => p.connected)).toEqual([1, 1])
    expect(up.status().map((p) => p.key)).not.toContain('Bearer')
  })

  it('drops a free socket after the TTL and opens a new one', async () => {
    const up = make({ freeSocketTtlMs: 250 })
    const auth = { authorization: 'Bearer one' }
    await traced(up, `${a.url}/a`, { headers: auth })
    await new Promise((ok) => setTimeout(ok, 600))
    const later = await traced(up, `${a.url}/b`, { headers: auth })
    expect(later.reused).toBe(false)
    expect(a.connections).toBe(2)
  })

  it('sends an unpooled origin through Chromium\'s fetch, rewritten, with no reuse verdict', async () => {
    const calls: string[] = []
    const up = make({
      pooled: (o) => o === 'https://api.anthropic.com',
      rewrite: (u) => u.replace('https://chatgpt.com', a.url),
      chromiumFetch: async (u) => {
        calls.push(u)
        return new Response('{}')
      }
    })
    const trace = await traced(up, 'https://chatgpt.com/backend-api/codex/responses')
    expect(calls).toEqual([`${a.url}/backend-api/codex/responses`])
    expect(trace).toMatchObject({ reused: null, pool: null })
  })

  it('pools the original origin even when the fake provider stands in', async () => {
    const up = make({ pooled: undefined, rewrite: (u) => u.replace('https://api.anthropic.com', a.url) })
    const trace = await traced(up, 'https://api.anthropic.com/v1/messages', { headers: { authorization: 'Bearer one' } })
    expect(trace.reused).toBe(false)
    expect(a.requests[0]?.url).toBe('/v1/messages')
  })

  it('pre-connects an account once a minute: open, throttled, then refresh', async () => {
    let now = 1_000_000
    const up = make({ now: () => now })
    expect(await up.preconnect(a.url, 'Bearer one')).toBe('opened')
    expect(a.requests).toEqual([{ method: 'GET', url: '/', auth: 'Bearer one' }])
    expect(await up.preconnect(a.url, 'Bearer one')).toBe('throttled')
    expect(a.requests).toHaveLength(1)
    now += 59_000
    expect(await up.preconnect(a.url, 'Bearer one')).toBe('throttled')
    now += 2_000
    await new Promise((ok) => setImmediate(ok))
    expect(await up.preconnect(a.url, 'Bearer one')).toBe('refreshed')
    expect(a.connections).toBe(1)
    // Another account is its own throttle and its own socket.
    expect(await up.preconnect(a.url, 'Bearer two')).toBe('opened')
    expect(a.connections).toBe(2)
    // The turn that follows rides the pre-connected socket.
    await new Promise((ok) => setImmediate(ok))
    const turn = await traced(up, `${a.url}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer one' }, body: '{}' })
    expect(turn.reused).toBe(true)
  })

  it('asks Chromium to pre-connect an origin off the pools, under the same throttle', async () => {
    let now = 5_000_000
    const asked: string[] = []
    const up = make({ now: () => now, pooled: () => false, chromiumPreconnect: (o) => asked.push(o) })
    expect(await up.preconnect('https://chatgpt.com', 'Bearer one')).toBe('chromium')
    expect(asked).toEqual(['https://chatgpt.com'])
    expect(await up.preconnect('https://chatgpt.com', 'Bearer one')).toBe('throttled')
    now += 60_000
    expect(await up.preconnect('https://chatgpt.com', 'Bearer one')).toBe('chromium')
    expect(asked).toHaveLength(2)
    expect(a.connections).toBe(0)
  })

  it('reports a failed pre-connect and keeps the throttle', async () => {
    let now = 9_000_000
    const up = make({ now: () => now, freeSocketTtlMs: 1_000 })
    expect(await up.preconnect('http://127.0.0.1:1', 'Bearer one')).toBe('failed')
    expect(await up.preconnect('http://127.0.0.1:1', 'Bearer one')).toBe('throttled')
    now += 60_000
    expect(await up.preconnect('http://127.0.0.1:1', 'Bearer one')).toBe('failed')
  })

  it('closes a pool nobody used for a while and nothing runs on', async () => {
    let now = 2_000_000
    const up = make({ now: () => now, idlePoolMs: 1_000 })
    await traced(up, `${a.url}/a`, { headers: { authorization: 'Bearer one' } })
    expect(up.sweep()).toBe(0)
    expect(up.status()).toHaveLength(1)
    now += 1_500
    expect(up.sweep()).toBe(1)
    expect(up.status()).toHaveLength(0)
  })

  it('the pooled path honours the header and body-idle env deadlines with typed errors', async () => {
    vi.stubEnv('TEMP_CODE_UPSTREAM_HEADERS_MS', '30')
    vi.stubEnv('TEMP_CODE_UPSTREAM_BODY_IDLE_MS', '30')
    const up = make()
    a.server.removeAllListeners('request')
    a.server.on('request', (_req, res) => {
      res.on('error', () => {})
      if (_req.url === '/body') res.write('first')
    })
    await expect(up.fetch(`${a.url}/headers`)).rejects.toMatchObject({ name: 'UpstreamTimeout', stage: 'headers', timeoutMs: 30 })
    const res = await up.fetch(`${a.url}/body`)
    await expect(res.text()).rejects.toMatchObject({ name: 'UpstreamTimeout', stage: 'body', timeoutMs: 30 })
  })

  it('never puts the token in a pool key', () => {
    expect(authKey({ authorization: 'Bearer secret-token' })).toMatch(/^[0-9a-f]{12}$/)
    expect(authKey(new Headers({ Authorization: 'Bearer secret-token' }))).toBe(authKey({ authorization: 'Bearer secret-token' }))
    expect(authKey(undefined)).toBe('anon')
  })
})


describe('upstream Chromium deadlines', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('no headers in time aborts with the stage, even if Chromium ignores the signal', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const up = new Upstream({
      chromiumFetch: async (_url, init) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      },
      headersTimeoutMs: 10
    })
    const failed = expect(up.fetch('https://chatgpt.com/')).rejects.toMatchObject({ name: 'UpstreamTimeout', stage: 'headers', timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    await failed
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBeInstanceOf(UpstreamTimeout)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a body idle past the limit aborts and cancels the provider body', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const cancelled = vi.fn()
    const up = new Upstream({
      chromiumFetch: async (_url, init) => {
        signal = init?.signal ?? undefined
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('first')) },
          cancel: cancelled
        }))
      },
      bodyIdleMs: 12
    })
    const res = await up.fetch('https://chatgpt.com/')
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    const failed = expect(reader.read()).rejects.toMatchObject({ stage: 'body', timeoutMs: 12 })
    await vi.advanceTimersByTimeAsync(12)
    await failed
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ stage: 'body' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('each chunk renews the idle deadline, while the total deadline still bounds a live stream', async () => {
    vi.useFakeTimers()
    let source!: ReadableStreamDefaultController<Uint8Array>
    const up = new Upstream({
      chromiumFetch: async () => new Response(new ReadableStream({ start(c) { source = c } })),
      bodyIdleMs: 10,
      requestTimeoutMs: 25
    })
    const res = await up.fetch('https://chatgpt.com/')
    const reader = res.body!.getReader()
    for (let n = 0; n < 3; n++) {
      await vi.advanceTimersByTimeAsync(8)
      source.enqueue(new Uint8Array([n]))
      expect((await reader.read()).value).toEqual(new Uint8Array([n]))
    }
    const failed = expect(reader.read()).rejects.toMatchObject({ stage: 'total', timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(vi.getTimerCount()).toBe(0)
  })

  it('body completion, a bodyless answer and reader cancellation clear every deadline', async () => {
    vi.useFakeTimers()
    const up = new Upstream({ chromiumFetch: async () => new Response('done', { status: 201, headers: { 'x-provider': 'yes' } }) })
    const res = await up.fetch('https://chatgpt.com/')
    expect(res.status).toBe(201)
    expect(res.headers.get('x-provider')).toBe('yes')
    expect(await res.text()).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
    const bodyless = new Upstream({ chromiumFetch: async () => new Response(null, { status: 204 }) })
    expect((await bodyless.fetch('https://chatgpt.com/')).status).toBe(204)
    expect(vi.getTimerCount()).toBe(0)
    const cancelled = vi.fn()
    const streaming = new Upstream({ chromiumFetch: async () => new Response(new ReadableStream({ cancel: cancelled })) })
    const streamingRes = await streaming.fetch('https://chatgpt.com/')
    await streamingRes.body!.cancel('downstream gone')
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honours a caller abort before headers and during the body', async () => {
    vi.useFakeTimers()
    const waiting = new Upstream({ chromiumFetch: async () => new Promise<Response>(() => {}) })
    const before = new AbortController()
    before.abort(new Error('already stopped'))
    await expect(waiting.fetch('https://chatgpt.com/', { signal: before.signal })).rejects.toThrow('already stopped')
    const during = new AbortController()
    const streaming = new Upstream({ chromiumFetch: async () => new Response(new ReadableStream()) })
    const response = await streaming.fetch('https://chatgpt.com/', { signal: during.signal })
    const failed = expect(response.text()).rejects.toThrow('caller stopped')
    during.abort(new Error('caller stopped'))
    await failed
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a late response after a header timeout', async () => {
    vi.useFakeTimers()
    let finish!: (res: Response) => void
    const cancelled = vi.fn()
    const up = new Upstream({ chromiumFetch: async () => new Promise<Response>((resolve) => { finish = resolve }), headersTimeoutMs: 5 })
    const failed = expect(up.fetch('https://chatgpt.com/')).rejects.toMatchObject({ stage: 'headers' })
    await vi.advanceTimersByTimeAsync(5)
    await failed
    finish(new Response(new ReadableStream({ cancel: cancelled })))
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
