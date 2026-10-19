import {
  env,
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject
} from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { hash, signature } from '../src/crypto'
import type { Env as HubEnv, Host } from '../src/types'
declare global {
  namespace Cloudflare {
    interface Env extends HubEnv {}
  }
}
const admin = { 'x-api-key': 'test-admin', 'content-type': 'application/json' }
const hb = { environmentId: 'env-1', name: 'Linux box', version: '1.0', startedAt: 1000 }
const notice = {
  event: 'finished',
  hostId: 'box',
  threadId: 'thread-1',
  title: 'Done',
  body: 'Ready',
  ts: 2000
}
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = admin
): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request('https://hub' + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return response
}
async function register(hostId = 'box'): Promise<Record<string, string>> {
  const data = (await (await call('/v1/hosts', 'POST', { hostId })).json()) as { hostToken: string }
  return { authorization: 'Bearer ' + data.hostToken, 'content-type': 'application/json' }
}
async function subscribe(extra: object = {}): Promise<string> {
  const res = await call('/v1/subscriptions', 'POST', {
    name: 'Bot',
    kind: 'webhook',
    url: 'https://bot.example/hook',
    secret: 'signing-secret',
    events: ['finished', 'host_down', 'host_up'],
    ...extra
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}
async function cron(): Promise<void> {
  const ctx = createExecutionContext()
  await worker.scheduled({} as ScheduledController, env, ctx)
  await waitOnExecutionContext(ctx)
}
async function ageHost(): Promise<void> {
  await runInDurableObject(env.HOSTS.get(env.HOSTS.idFromName('box')), async (_instance, state) => {
    const h = (await state.storage.get<Host>('host'))!
    h.lastSeen = Date.now() - 180_001
    await state.storage.put('host', h)
    await env.HUB_KV.put('host:box', JSON.stringify(h))
  })
}
beforeEach(async () => {
  vi.restoreAllMocks()
  for (const name of ['box', 'mac'])
    await runInDurableObject(
      env.HOSTS.get(env.HOSTS.idFromName(name)),
      async (_instance, state) => {
        await state.storage.deleteAll()
        await state.storage.deleteAlarm()
      }
    )
  const keys = (await env.HUB_KV.list()).keys
  for (const key of keys) {
    const name = key.name.startsWith('host:')
      ? key.name.slice(5)
      : key.name.startsWith('sub:')
        ? 'subscription:' + key.name.slice(4)
        : null
    if (name)
      await runInDurableObject(
        env.HOSTS.get(env.HOSTS.idFromName(name)),
        async (_instance, state) => {
          await state.storage.deleteAll()
          await state.storage.deleteAlarm()
        }
      )
    await env.HUB_KV.delete(key.name)
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})
describe('hub', () => {
  it('health is public; missing and incorrect credentials fail', async () => {
    expect((await SELF.fetch('https://hub/healthz')).status).toBe(200)
    expect((await call('/healthz', 'GET', undefined, {})).status).toBe(200)
    for (const path of ['/v1/hosts', '/v1/subscriptions']) {
      expect((await call(path, 'GET', undefined, {})).status).toBe(401)
      expect((await call(path, 'GET', undefined, { 'x-api-key': 'wrong' })).status).toBe(401)
    }
    expect((await call('/v1/notify', 'POST', {}, {})).status).toBe(401)
    expect((await call('/v1/hosts/box/heartbeat', 'POST', hb, {})).status).toBe(401)
    expect(
      (await call('/v1/hosts/box/heartbeat', 'POST', hb, { authorization: 'Bearer wrong' })).status
    ).toBe(401)
  })
  it('stores only a token hash, enforces host scope, reports liveness, deletes hosts', async () => {
    const auth = await register()
    const record = (await env.HUB_KV.get<Host>('host:box', 'json'))!
    expect(record.tokenHash).toBe(await hash(auth.authorization.slice(7)))
    expect(JSON.stringify(record)).not.toContain(auth.authorization.slice(7))
    expect((await call('/v1/hosts', 'POST', { hostId: 'box' })).status).toBe(409)
    expect(((await (await call('/v1/hosts')).json()) as Host[])[0]).toMatchObject({ alive: false })
    expect((await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)).status).toBe(200)
    const hosts = (await (await call('/v1/hosts')).json()) as Host[]
    expect(hosts[0]).toMatchObject({ alive: true, environmentId: 'env-1', name: 'Linux box' })
    expect(hosts[0]).not.toHaveProperty('tokenHash')
    await register('mac')
    expect((await call('/v1/notify', 'POST', { ...notice, hostId: 'mac' }, auth)).status).toBe(401)
    expect((await call('/v1/hosts/box', 'DELETE')).status).toBe(200)
    expect((await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)).status).toBe(401)
  })
  it('validates and strips unrecognized fields; never stores thread data', async () => {
    const auth = await register()
    expect(
      (await call('/v1/hosts/box/heartbeat', 'POST', { ...hb, load: { nested: {} } }, auth)).status
    ).toBe(400)
    await call('/v1/hosts/box/heartbeat', 'POST', { ...hb, transcript: 'private' }, auth)
    expect(await env.HUB_KV.get('host:box')).not.toContain('private')
    expect((await call('/v1/notify', 'POST', { ...notice, event: 'unknown' }, auth)).status).toBe(
      400
    )
    expect((await call('/v1/subscriptions', 'POST', { kind: 'apns' })).status).toBe(400)
    expect((await call('/v1/hosts', 'POST', { hostId: '../bad' })).status).toBe(400)
  })
  it('fans out in parallel, filters, signs exact bytes, and hides encrypted secrets', async () => {
    const auth = await register()
    await subscribe()
    await subscribe({ hosts: ['mac'] })
    await subscribe({ events: ['stuck'] })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    expect(
      await (await call('/v1/notify', 'POST', { ...notice, transcript: 'never send' }, auth)).json()
    ).toEqual({ delivered: 1, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(1)
    const init = fetch.mock.calls[0][1]!
    expect(JSON.parse(init.body as string)).toEqual(notice)
    const headers = init.headers as Record<string, string>
    expect(headers['x-hub-signature-256']).toBe(
      await signature(init.body as string, 'signing-secret')
    )
    expect(headers['x-hub-delivery']).toMatch(/^[\da-f-]{36}$/)
    const subs = await (await call('/v1/subscriptions')).text()
    expect(subs).not.toContain('signing-secret')
    expect(subs).not.toContain('encryptedSecret')
    expect((await env.HUB_KV.list({ prefix: 'sub:' })).keys).toHaveLength(3)
  })
  it('retries three times, preserves delivery ID, records terminal failure and can delete subscriptions', async () => {
    const auth = await register()
    const subId = await subscribe()
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('', { status: 500 }))
    expect(await (await call('/v1/notify', 'POST', notice, auth)).json()).toEqual({
      delivered: 0,
      failed: 1
    })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(
      new Set(
        fetch.mock.calls.map((c) => (c[1]!.headers as Record<string, string>)['x-hub-delivery'])
      ).size
    ).toBe(1)
    expect(((await (await call('/v1/subscriptions')).json()) as object[])[0]).toMatchObject({
      failureCount: 1,
      lastError: 'Webhook HTTP 500'
    })
    await call('/v1/subscriptions/' + subId, 'DELETE')
    expect(await (await call('/v1/subscriptions')).json()).toEqual([])
  })
  it('recovers from a transient network failure', async () => {
    const auth = await register()
    await subscribe()
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response('ok'))
    expect(await (await call('/v1/notify', 'POST', notice, auth)).json()).toEqual({
      delivered: 1,
      failed: 0
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('matches a known HMAC-SHA256 vector', async () => {
    expect(await signature('The quick brown fox jumps over the lazy dog', 'key')).toBe(
      'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
    )
  })
  it('aborts each attempt at the 5-second deadline', async () => {
    const auth = await register()
    await subscribe()
    const realTimer = globalThis.setTimeout
    const timer = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void, ms: number) =>
        realTimer(fn, ms === 5000 ? 1 : ms)) as typeof setTimeout)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    expect(await (await call('/v1/notify', 'POST', notice, auth)).json()).toEqual({
      delivered: 0,
      failed: 1
    })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(timer.mock.calls.filter((c) => c[1] === 5000)).toHaveLength(4)
    expect(((await (await call('/v1/subscriptions')).json()) as object[])[0]).toMatchObject({
      lastError: 'Webhook timeout'
    })
  })
  it('starts matching subscriptions together', async () => {
    const auth = await register()
    await subscribe()
    await subscribe({ name: 'Second bot' })
    let started = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (++started === 2) release()
      await barrier
      return new Response('ok')
    })
    expect(await (await call('/v1/notify', 'POST', notice, auth)).json()).toEqual({
      delivered: 2,
      failed: 0
    })
  })
  it('preserves failure counts across concurrent notices', async () => {
    const auth = await register()
    await subscribe()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }))
    await Promise.all([
      call('/v1/notify', 'POST', notice, auth),
      call('/v1/notify', 'POST', notice, auth)
    ])
    expect(((await (await call('/v1/subscriptions')).json()) as object[])[0]).toMatchObject({
      failureCount: 2
    })
  })
  it('marks a registered host down even if it never sends a heartbeat', async () => {
    await register()
    await subscribe()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    await cron()
    expect(fetch).not.toHaveBeenCalled()
    await runInDurableObject(
      env.HOSTS.get(env.HOSTS.idFromName('box')),
      async (_instance, state) => {
        const host = (await state.storage.get<Host>('host'))!
        host.registeredAt = Date.now() - 180_001
        await state.storage.put('host', host)
      }
    )
    await cron()
    await cron()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('emits down and up once across concurrent cron runs and heartbeats', async () => {
    const auth = await register()
    await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)
    await subscribe()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    await cron()
    expect(fetch).not.toHaveBeenCalled()
    await ageHost()
    expect(((await (await call('/v1/hosts')).json()) as object[])[0]).toMatchObject({
      alive: false
    })
    await Promise.all([cron(), cron()])
    await cron()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).event).toBe('host_down')
    await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)
    await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).event).toBe('host_up')
  })
})
