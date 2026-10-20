import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubFromEnv, startHub, type HubClient } from './hub'
const options = {
  url: 'https://hub.example',
  hostToken: 'never-log-this-token',
  hostId: 'box',
  environmentId: 'env-1',
  name: 'Box',
  version: '1.0'
}
let clients: HubClient[] = []
const heartbeat = (): Response => Response.json({ ok: true, serverTime: Date.now() })
beforeEach(() => {
  vi.useFakeTimers()
  clients = []
})
afterEach(() => {
  for (const client of clients) client.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
function start(fetch: typeof globalThis.fetch, log = vi.fn(), random = () => 0.5): HubClient {
  const client = startHub(options, { fetch, log, random })
  clients.push(client)
  return client
}
describe('host hub client', () => {
  it('stays off by default and rejects partial or unsafe config without logging credentials', () => {
    const fetch = vi.fn()
    const log = vi.fn()
    const identity = { name: 'Box', version: '1' }
    expect(hubFromEnv(identity, {}, { fetch, log })).toBeNull()
    expect(log).not.toHaveBeenCalled()
    expect(
      hubFromEnv(identity, { TEMP_CODE_HUB_TOKEN: options.hostToken }, { fetch, log })
    ).toBeNull()
    expect(
      hubFromEnv(
        identity,
        {
          TEMP_CODE_HUB_TOKEN: options.hostToken,
          TEMP_CODE_HUB_URL: 'http://remote',
          TEMP_CODE_HUB_HOST_ID: 'box'
        },
        { fetch, log }
      )
    ).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain(options.hostToken)
  })
  it('sends immediately, adds jitter, keeps startedAt fixed, and stops', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => heartbeat())
    const client = start(fetch, vi.fn(), () => 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('https://hub.example/v1/hosts/box/heartbeat')
    const first = JSON.parse(fetch.mock.calls[0][1]!.body as string)
    expect(first).toMatchObject({ environmentId: 'env-1', name: 'Box', version: '1.0' })
    await vi.advanceTimersByTimeAsync(26_999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).startedAt).toBe(first.startedAt)
    client.stop()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await client.notify({ event: 'finished', title: 'Done', body: 'Ready' })).toBeNull()
  })
  it('sends notices with host identity, filters fields, and returns fan-out counts', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(heartbeat())
      .mockResolvedValueOnce(Response.json({ delivered: 2, failed: 1 }))
    const client = start(fetch)
    const event = {
      event: 'finished' as const,
      title: 'Done',
      body: 'Ready',
      threadId: 'thread',
      transcript: 'private'
    }
    expect(await client.notify(event)).toEqual({ delivered: 2, failed: 1 })
    const [, init] = fetch.mock.calls[1]
    expect(JSON.parse(init!.body as string)).toMatchObject({
      event: 'finished',
      hostId: 'box',
      threadId: 'thread',
      title: 'Done',
      body: 'Ready',
      ts: expect.any(Number)
    })
    expect(init!.body).not.toContain('private')
    expect(init!.headers).toMatchObject({ authorization: 'Bearer ' + options.hostToken })
  })
  it('logs once per failure state, then once on recovery, with no token or fetch error text', async () => {
    let online = false
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      if (!online) throw new Error(options.hostToken)
      return heartbeat()
    })
    const log = vi.fn()
    start(fetch, log)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(log).toHaveBeenCalledTimes(1)
    online = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '[hub] heartbeat: unavailable',
      '[hub] heartbeat: ok'
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain(options.hostToken)
  })
  it('aborts a heartbeat at five seconds and prevents overlapping requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const log = vi.fn()
    start(fetch, log)
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(log).toHaveBeenCalledWith('[hub] heartbeat: timeout')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('aborts in-flight work at shutdown without a failure log or rescheduling', async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init!.signal as AbortSignal
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const log = vi.fn()
    const client = start(fetch, log)
    client.stop()
    expect(signal!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })
  it('handles malformed JSON, HTTP errors, and invalid delivery counts', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('bad JSON'))
      .mockResolvedValueOnce(new Response('secret response', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ delivered: -1, failed: 0 }))
    const log = vi.fn()
    const client = start(fetch, log)
    await vi.advanceTimersByTimeAsync(0)
    expect(await client.notify({ event: 'failed', title: 'Failed', body: 'Retry' })).toBeNull()
    expect(await client.notify({ event: 'failed', title: 'Failed', body: 'Retry' })).toBeNull()
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret response')
  })
  it('creates the configured client with the supplied environment identity', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => heartbeat())
    const client = hubFromEnv(
      { name: 'Box', version: '1', environmentId: 'stable-id' },
      {
        TEMP_CODE_HUB_URL: options.url,
        TEMP_CODE_HUB_HOST_ID: 'box',
        TEMP_CODE_HUB_TOKEN: options.hostToken
      },
      { fetch }
    )!
    clients.push(client)
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).environmentId).toBe('stable-id')
  })
})
describe('push registrations and Live Activities (thread L6)', () => {
  it('names the environment and the row in a notice, upserts and removes devices and activity tokens, and pushes activity states', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(heartbeat())
      .mockResolvedValueOnce(Response.json({ delivered: 1, failed: 0 }))
      .mockResolvedValueOnce(Response.json({ ok: true, id: 'apns-box-k1' }))
      .mockResolvedValueOnce(Response.json({ error: 'Invalid token' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ error: 'Subscription not found' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ delivered: 1, failed: 0 }))
    const log = vi.fn()
    const client = start(fetch, log)
    await vi.advanceTimersByTimeAsync(0)
    expect(await client.notify({ event: 'needs_you', title: 'Ship it', body: 'Permission: Bash', threadId: 't1', seq: 12 })).toEqual({ delivered: 1, failed: 0 })
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({ environmentId: 'env-1', threadId: 't1', seq: 12 })
    const device = { deviceId: 'k1', token: 'ab'.repeat(32), bundleId: 'dev.landon.tempcode.ios', environment: 'sandbox' as const, events: ['needs_you' as const] }
    expect(await client.registerDevice(device)).toEqual({ ok: true })
    expect(fetch.mock.calls[2][0]).toBe('https://hub.example/v1/hosts/box/devices/k1')
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(fetch.mock.calls[2][1]!.body as string)).toEqual({ token: device.token, bundleId: device.bundleId, environment: 'sandbox', events: ['needs_you'] })
    expect(await client.registerDevice(device)).toEqual({ ok: false, error: 'HTTP 400' })
    // What the hub no longer holds is removed.
    expect(await client.removeDevice('k1')).toEqual({ ok: true })
    expect(fetch.mock.calls[4][1]).toMatchObject({ method: 'DELETE' })
    expect(await client.setActivity({ deviceId: 'k1', threadId: 't1', token: device.token, bundleId: device.bundleId, environment: 'sandbox' })).toEqual({ ok: true })
    expect(fetch.mock.calls[5][0]).toBe('https://hub.example/v1/hosts/box/activities/t1/k1')
    expect(await client.removeActivity('k1', 't1')).toEqual({ ok: true })
    expect(fetch.mock.calls[6][0]).toBe('https://hub.example/v1/hosts/box/activities/t1/k1')
    expect(await client.pushActivity({ threadId: 't1', event: 'end', state: { phase: 'waiting', since: 1, ts: 2, seq: 12 }, title: 'Ship it', threadType: 'implementation' })).toEqual({ delivered: 1, failed: 0 })
    expect(fetch.mock.calls[7][0]).toBe('https://hub.example/v1/activity')
    expect(JSON.parse(fetch.mock.calls[7][1]!.body as string)).toMatchObject({ hostId: 'box', environmentId: 'env-1', threadId: 't1', event: 'end', state: { phase: 'waiting', seq: 12 }, title: 'Ship it', threadType: 'implementation' })
    for (const call of fetch.mock.calls) expect((call[1]!.headers as Record<string, string>).authorization).toBe('Bearer ' + options.hostToken)
    expect(JSON.stringify(log.mock.calls)).not.toContain(options.hostToken)
  })
})
