import {
  env,
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject
} from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { hash, seal, signature } from '../src/crypto'
import { apnsReset, JWT_LIFETIME_MS, providerToken } from '../src/apns'
import { ACTIVITY_DISMISS_S } from '../src/delivery'
import { dohResolve, guardTarget, isPrivateAddress, setResolver } from '../src/target'
import type { Env as HubEnv, Host, Subscription } from '../src/types'
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
const directory = () => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))
const hostObject = (name: string) => env.HOSTS.get(env.HOSTS.idFromName(name))
const hostRecord = (name = 'box'): Promise<Host | undefined> =>
  runInDurableObject(hostObject(name), (_instance, state) => state.storage.get<Host>('host'))
async function ageHost(): Promise<void> {
  await runInDurableObject(hostObject('box'), async (_instance, state) => {
    const h = (await state.storage.get<Host>('host'))!
    h.lastSeen = Date.now() - 180_001
    await state.storage.put('host', h)
  })
}
/** A host and a subscription as the pre-directory hub left them: full records under KV keys. */
async function legacyLayout(raw: string): Promise<{ host: Host; sub: Subscription }> {
  const host: Host = {
    hostId: 'box',
    tokenHash: await hash(raw),
    registeredAt: Date.now() - 60_000,
    lastSeen: Date.now() - 5_000,
    down: false,
    name: 'tempcode-box',
    version: 'box-scaffold',
    environmentId: 'env_box'
  }
  const sub: Subscription = {
    id: 'legacy-sub',
    name: 'Bot',
    kind: 'webhook',
    url: 'https://bot.example/hook',
    encryptedSecret: await seal('signing-secret', 'test-encryption-key'),
    events: ['finished', 'host_down'],
    failureCount: 0,
    lastError: null
  }
  await runInDurableObject(hostObject('box'), (_instance, state) => state.storage.put('host', host))
  return { host, sub }
}
beforeEach(async () => {
  vi.restoreAllMocks()
  // Webhook hosts resolve to a public address unless a test says otherwise.
  setResolver(async () => ['93.184.216.34'])
  for (const stub of [hostObject('box'), hostObject('mac'), directory()])
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll()
      await state.storage.deleteAlarm()
    })
  for (const key of (await env.HUB_KV.list()).keys) await env.HUB_KV.delete(key.name)
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
    const record = (await hostRecord())!
    expect(record.tokenHash).toBe(await hash(auth.authorization.slice(7)))
    expect(JSON.stringify(record)).not.toContain(auth.authorization.slice(7))
    expect(await env.HUB_KV.get('host:box')).toBe(JSON.stringify({ hostId: 'box' }))
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
    expect(JSON.stringify(await hostRecord())).not.toContain('private')
    expect((await call('/v1/notify', 'POST', { ...notice, event: 'unknown' }, auth)).status).toBe(
      400
    )
    expect((await call('/v1/subscriptions', 'POST', { kind: 'apns' })).status).toBe(400)
    expect((await call('/v1/hosts', 'POST', { hostId: '../bad' })).status).toBe(400)
  })
  it('refuses private, loopback and metadata targets, a host that resolves to one, and a short secret (R2 M3)', async () => {
    for (const url of [
      'https://127.0.0.1/hook',
      'https://10.0.0.1/hook',
      'https://172.16.5.5/hook',
      'https://192.168.0.10/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.100.100.200/latest/meta-data/',
      'https://[::1]/hook',
      'https://[fe80::1]/hook',
      'https://[fd00:ec2::254]/hook',
      'https://[::ffff:10.0.0.1]/hook',
      'https://localhost/hook',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://metadata/x',
      'https://2130706433/hook'
    ]) {
      const res = await call('/v1/subscriptions', 'POST', { name: 'Bot', kind: 'webhook', url, secret: 'signing-secret', events: ['finished'] })
      expect(res.status, url).toBe(400)
      expect(((await res.json()) as { error: string }).error).toMatch(/private or local/)
    }
    setResolver(async () => ['93.184.216.34', '10.0.0.5'])
    const mixed = await call('/v1/subscriptions', 'POST', { name: 'Bot', kind: 'webhook', url: 'https://bot.example/hook', secret: 'signing-secret', events: ['finished'] })
    expect(mixed.status).toBe(400)
    setResolver(async () => [])
    expect((await call('/v1/subscriptions', 'POST', { name: 'Bot', kind: 'webhook', url: 'https://bot.example/hook', secret: 'signing-secret', events: ['finished'] })).status).toBe(400)
    setResolver(async () => ['93.184.216.34'])
    const short = await call('/v1/subscriptions', 'POST', { name: 'Bot', kind: 'webhook', url: 'https://bot.example/hook', secret: 'short', events: ['finished'] })
    expect(short.status).toBe(400)
    expect(((await short.json()) as { error: string }).error).toMatch(/at least 8/)
    expect((await env.HUB_KV.list({ prefix: 'sub:' })).keys).toHaveLength(0)
    expect(await directory().subscriptions()).toEqual([])
    // The notice's own deep link is only relayed, never fetched: it is not held to the target rule.
    const auth = await register()
    expect((await call('/v1/notify', 'POST', { ...notice, url: 'https://10.0.0.1/ui' }, auth)).status).toBe(200)
  })
  it('re-checks the target at delivery and posts nothing to a host that moved inside the network', async () => {
    const auth = await register()
    await subscribe()
    setResolver(async () => ['10.0.0.5'])
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    expect(await (await call('/v1/notify', 'POST', notice, auth)).json()).toEqual({ delivered: 0, failed: 1 })
    expect(fetch).not.toHaveBeenCalled()
    expect(((await (await call('/v1/subscriptions')).json()) as object[])[0]).toMatchObject({
      failureCount: 1,
      lastError: 'Webhook target refused'
    })
  })
  it('resolves over DNS-over-HTTPS by default and judges every answer', async () => {
    const answers: Record<string, { type: number; data: string }[]> = {
      A: [{ type: 5, data: 'edge.example.' }, { type: 1, data: '93.184.216.34' }],
      AAAA: [{ type: 28, data: '2606:4700::1111' }]
    }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin + url.pathname).toBe('https://cloudflare-dns.com/dns-query')
      expect((init?.headers as Record<string, string>).accept).toBe('application/dns-json')
      return Response.json({ Answer: answers[url.searchParams.get('type')!] })
    })
    expect((await dohResolve('bot.example')).sort()).toEqual(['2606:4700::1111', '93.184.216.34'])
    expect(fetch).toHaveBeenCalledTimes(2)
    setResolver(null)
    await expect(guardTarget('bot.example')).resolves.toBeUndefined()
    answers.AAAA = [{ type: 28, data: 'fd00:ec2::254' }]
    await expect(guardTarget('bot.example')).rejects.toThrow(/private or local/)
    fetch.mockImplementation(async () => new Response('', { status: 503 }))
    await expect(guardTarget('bot.example')).rejects.toThrow(/does not resolve/)
    for (const ip of ['127.0.0.1', '169.254.169.254', '100.100.100.200', '192.0.0.192', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '', 'x'])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['93.184.216.34', '2606:4700::1111', '::ffff:93.184.216.34', '172.32.0.1']) expect(isPrivateAddress(ip), ip).toBe(false)
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
    expect(await directory().subscriptions()).toHaveLength(3)
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
  it('writes nothing to KV on a heartbeat and lists nothing on the cron or the host list', async () => {
    const auth = await register()
    await subscribe()
    // The first read seeds the directory (two lists, once); steady state starts after it.
    await call('/v1/hosts')
    const kv = ['put', 'list', 'get', 'delete'].map((name) =>
      vi.spyOn(env.HUB_KV, name as 'put')
    )
    for (let i = 0; i < 3; i++)
      expect((await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)).status).toBe(200)
    await cron()
    await cron()
    expect(((await (await call('/v1/hosts')).json()) as object[])[0]).toMatchObject({ alive: true })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    expect(await (await call('/v1/notify', 'POST', notice, auth)).json()).toEqual({
      delivered: 1,
      failed: 0
    })
    await ageHost()
    await cron()
    await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)
    expect(fetch.mock.calls.map((c) => JSON.parse(c[1]!.body as string).event)).toEqual([
      'finished',
      'host_down',
      'host_up'
    ])
    for (const spy of kv) expect(spy).not.toHaveBeenCalled()
    expect(await env.HUB_KV.get('host:box')).toBe(JSON.stringify({ hostId: 'box' }))
    // The spies do see the directory's own KV traffic: a registration mirrors one key.
    await register('mac')
    expect(kv[0]).toHaveBeenCalledTimes(1)
  })
  it('keeps the directory and its KV mirror in step with registration, deletion and subscriptions', async () => {
    await register()
    await register('mac')
    expect(await directory().hostIds()).toEqual(['box', 'mac'])
    expect((await env.HUB_KV.list({ prefix: 'host:' })).keys.map((k) => k.name)).toEqual([
      'host:box',
      'host:mac'
    ])
    expect((await call('/v1/hosts/mac', 'DELETE')).status).toBe(200)
    expect((await call('/v1/hosts/mac', 'DELETE')).status).toBe(404)
    expect(await directory().hostIds()).toEqual(['box'])
    expect(await env.HUB_KV.get('host:mac')).toBeNull()
    expect((await (await call('/v1/hosts')).json()) as object[]).toHaveLength(1)
    const subId = await subscribe()
    expect((await directory().subscriptions()).map((s) => s.id)).toEqual([subId])
    expect(await env.HUB_KV.get('sub:' + subId, 'json')).toMatchObject({ id: subId, kind: 'webhook' })
    expect((await call('/v1/subscriptions/' + subId, 'DELETE')).status).toBe(200)
    expect((await call('/v1/subscriptions/' + subId, 'DELETE')).status).toBe(404)
    expect(await directory().subscriptions()).toEqual([])
    expect((await env.HUB_KV.list({ prefix: 'sub:' })).keys).toHaveLength(0)
  })
  it('seeds the directory once from the pre-directory KV keys and keeps the old token working', async () => {
    const raw = 'a'.repeat(64)
    const { host, sub } = await legacyLayout(raw)
    await env.HUB_KV.put('host:box', JSON.stringify(host))
    await env.HUB_KV.put('sub:legacy-sub', JSON.stringify(sub))
    const list = vi.spyOn(env.HUB_KV, 'list')
    expect(await (await call('/v1/hosts')).json()).toEqual([
      expect.objectContaining({ hostId: 'box', alive: true, name: 'tempcode-box', environmentId: 'env_box' })
    ])
    expect(list).toHaveBeenCalledTimes(2)
    const auth = { authorization: 'Bearer ' + raw, 'content-type': 'application/json' }
    expect((await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)).status).toBe(200)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    expect(await (await call('/v1/notify', 'POST', notice, auth)).json()).toEqual({
      delivered: 1,
      failed: 0
    })
    const init = fetch.mock.calls[0][1]!
    expect((init.headers as Record<string, string>)['x-hub-signature-256']).toBe(
      await signature(init.body as string, 'signing-secret')
    )
    const subs = await (await call('/v1/subscriptions')).text()
    expect(JSON.parse(subs)).toEqual([expect.objectContaining({ id: 'legacy-sub', failureCount: 0 })])
    expect(subs).not.toContain('encryptedSecret')
    await cron()
    await call('/v1/hosts')
    expect(list).toHaveBeenCalledTimes(2)
    // Nothing was rewritten: the old key is still the old record, untouched by the seed.
    expect(await env.HUB_KV.get('host:box', 'json')).toEqual(host)
  })
  it('lets a pre-directory host join at its first heartbeat while the seed cannot list KV', async () => {
    const raw = 'b'.repeat(64)
    const { sub } = await legacyLayout(raw)
    const list = vi
      .spyOn(env.HUB_KV, 'list')
      .mockRejectedValue(new Error('KV LIST failed: 429 Too Many Requests'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await (await call('/v1/hosts')).json()).toEqual([])
    const auth = { authorization: 'Bearer ' + raw, 'content-type': 'application/json' }
    expect((await call('/v1/hosts/box/heartbeat', 'POST', hb, auth)).status).toBe(200)
    expect(await directory().hostIds()).toEqual(['box'])
    expect(await (await call('/v1/hosts')).json()).toEqual([
      expect.objectContaining({ hostId: 'box', alive: true })
    ])
    expect((await hostRecord())!.listed).toBe(true)
    expect(error).toHaveBeenCalled()
    expect(list.mock.calls.length).toBeGreaterThan(1)
    // Once KV lists again the seed finishes, bringing in what only KV knew.
    list.mockRestore()
    await env.HUB_KV.put('sub:legacy-sub', JSON.stringify(sub))
    expect((await directory().subscriptions()).map((s) => s.id)).toEqual(['legacy-sub'])
    expect(await directory().hostIds()).toEqual(['box'])
  })
})

// ── APNs (thread L6) ────────────────────────────────────────────────────

/** A throwaway P-256 pair: the private half as the .p8 PEM a Worker secret holds, the public half to check signatures. */
async function apnsKeys(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  let bin = ''
  for (const b of der) bin += String.fromCharCode(b)
  const body = btoa(bin).match(/.{1,64}/g)!.join('\n')
  return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey }
}
const b64url = (text: string): Uint8Array => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const decodeJwt = (jwt: string): { header: Record<string, string>; claims: Record<string, unknown>; signingInput: string; signature: Uint8Array } => {
  const [h, c, sig] = jwt.split('.')
  return {
    header: JSON.parse(new TextDecoder().decode(b64url(h))),
    claims: JSON.parse(new TextDecoder().decode(b64url(c))),
    signingInput: `${h}.${c}`,
    signature: b64url(sig)
  }
}
const TOKEN = 'ab'.repeat(32)
const apnsNotice = { ...notice, event: 'needs_you', environmentId: 'env_box', seq: 42, body: 'Permission: Bash — git push' }
/** The Worker with APNs configured for a test gateway; a fresh key id per call keeps the provider token cache honest. */
let keyN = 0
async function apnsEnv(): Promise<{ env: HubEnv; publicKey: CryptoKey }> {
  const { pem, publicKey } = await apnsKeys()
  keyN += 1
  return { env: { ...env, APNS_KEY: pem, APNS_KEY_ID: `KEY${keyN}`, APNS_TEAM_ID: 'TEAM123456', APNS_URL: 'https://apns.test' }, publicKey }
}
async function callWith(hubEnv: HubEnv, path: string, method: string, body?: unknown, headers: Record<string, string> = admin): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request('https://hub' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    hubEnv,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return response
}
const registerDevice = (hubEnv: HubEnv, auth: Record<string, string>, extra: object = {}) =>
  callWith(hubEnv, '/v1/hosts/box/devices/k1', 'PUT', { token: TOKEN, bundleId: 'dev.landon.tempcode.ios', environment: 'sandbox', events: ['needs_you', 'finished'], ...extra }, auth)

describe('APNs delivery', () => {
  beforeEach(() => apnsReset())
  it('mints an ES256 provider token once per lifetime, signed with the key and naming the team and key id', async () => {
    const { env: hubEnv, publicKey } = await apnsEnv()
    const jwt = await providerToken(hubEnv, 1_760_000_000_000)
    const { header, claims, signingInput, signature: sig } = decodeJwt(jwt)
    expect(header).toEqual({ alg: 'ES256', kid: hubEnv.APNS_KEY_ID })
    expect(claims).toEqual({ iss: 'TEAM123456', iat: 1_760_000_000 })
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(signingInput))).toBe(true)
    expect(await providerToken(hubEnv, 1_760_000_000_000 + JWT_LIFETIME_MS - 1)).toBe(jwt)
    expect(await providerToken(hubEnv, 1_760_000_000_000 + JWT_LIFETIME_MS)).not.toBe(jwt)
    await expect(providerToken({ ...hubEnv, APNS_KEY_ID: undefined })).rejects.toThrow(/not configured/)
  })
  it('takes a device only from its own host, lists it without the token, and replaces it on a rotated token', async () => {
    const { env: hubEnv } = await apnsEnv()
    const auth = await register()
    const other = await register('mac')
    expect((await registerDevice(hubEnv, other)).status).toBe(401)
    expect((await callWith(hubEnv, '/v1/hosts/box/devices/k1', 'PUT', { token: 'nothex', bundleId: 'b', environment: 'sandbox', events: ['needs_you'] }, auth)).status).toBe(400)
    expect((await callWith(hubEnv, '/v1/hosts/box/devices/k1', 'PUT', { token: TOKEN, bundleId: 'b', environment: 'staging', events: ['needs_you'] }, auth)).status).toBe(400)
    expect(await (await registerDevice(hubEnv, auth)).json()).toEqual({ ok: true, id: 'apns-box-k1' })
    const listed = await (await callWith(hubEnv, '/v1/subscriptions', 'GET')).text()
    expect(listed).not.toContain(TOKEN)
    expect(JSON.parse(listed)).toEqual([expect.objectContaining({ id: 'apns-box-k1', kind: 'apns', deviceId: 'k1', hosts: ['box'], events: ['needs_you', 'finished'], failureCount: 0 })])
    await directory().recordFailure('apns-box-k1', 'APNs 500')
    expect(await (await registerDevice(hubEnv, auth, { token: 'cd'.repeat(32) })).json()).toEqual({ ok: true, id: 'apns-box-k1' })
    const subs = await directory().subscriptions()
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ kind: 'apns', token: 'cd'.repeat(32), failureCount: 0, lastError: null })
    expect((await callWith(hubEnv, '/v1/hosts/box/devices/k1', 'DELETE', undefined, other)).status).toBe(401)
    expect((await callWith(hubEnv, '/v1/hosts/box/devices/k1', 'DELETE', undefined, auth)).status).toBe(200)
    expect((await callWith(hubEnv, '/v1/hosts/box/devices/k1', 'DELETE', undefined, auth)).status).toBe(404)
    expect(await directory().subscriptions()).toEqual([])
  })
  it('posts an alert to the sandbox gateway with the provider token, the topic and the thread to land on', async () => {
    const { env: hubEnv, publicKey } = await apnsEnv()
    const auth = await register()
    await registerDevice(hubEnv, auth)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''))
    expect(await (await callWith(hubEnv, '/v1/notify', 'POST', apnsNotice, auth)).json()).toEqual({ delivered: 1, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).toBe(`https://apns.test/3/device/${TOKEN}`)
    const init = fetch.mock.calls[0][1]!
    const headers = init.headers as Record<string, string>
    expect(headers['apns-topic']).toBe('dev.landon.tempcode.ios')
    expect(headers['apns-push-type']).toBe('alert')
    expect(headers['apns-priority']).toBe('10')
    expect(headers['apns-collapse-id']).toBe('thread-1:needs_you')
    expect(Number(headers['apns-expiration'])).toBe(Math.floor(apnsNotice.ts / 1000) + 3600)
    expect(headers['apns-id']).toMatch(/^[\da-f-]{36}$/)
    const jwt = headers.authorization.replace(/^bearer /, '')
    const { signingInput, signature: sig } = decodeJwt(jwt)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(signingInput))).toBe(true)
    expect(JSON.parse(init.body as string)).toEqual({
      aps: {
        alert: { title: 'Done', body: 'Permission: Bash — git push' },
        sound: 'default',
        'thread-id': 'thread-1',
        'summary-arg': 'Done',
        'interruption-level': 'time-sensitive',
        'relevance-score': 1,
        category: 'tc.thread'
      },
      tc: { event: 'needs_you', hostId: 'box', environmentId: 'env_box', threadId: 'thread-1', seq: 42, ts: 2000 }
    })
    // The host's subtitle, kind and requestId ride along: an approval gets the Approve/Deny category.
    fetch.mockClear()
    expect(await (await callWith(hubEnv, '/v1/notify', 'POST', { ...apnsNotice, subtitle: 'temp-code', kind: 'approval', requestId: 'a1' }, auth)).json()).toEqual({ delivered: 1, failed: 0 })
    const approval = JSON.parse(fetch.mock.calls[0][1]!.body as string)
    expect(approval.aps).toMatchObject({ alert: { title: 'Done', subtitle: 'temp-code', body: 'Permission: Bash — git push' }, 'summary-arg': 'temp-code', category: 'tc.approval' })
    expect(approval.tc).toMatchObject({ kind: 'approval', requestId: 'a1' })
    expect((await callWith(hubEnv, '/v1/notify', 'POST', { ...apnsNotice, kind: 'party' }, auth)).status).toBe(400)
    // A finished notice is not time-sensitive, lands without a sound, and the subscription did not ask for stuck.
    fetch.mockClear()
    expect(await (await callWith(hubEnv, '/v1/notify', 'POST', { ...apnsNotice, event: 'stuck' }, auth)).json()).toEqual({ delivered: 0, failed: 0 })
    expect(await (await callWith(hubEnv, '/v1/notify', 'POST', { ...apnsNotice, event: 'finished', seq: undefined }, auth)).json()).toEqual({ delivered: 1, failed: 0 })
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string)
    expect(body.aps['interruption-level']).toBe('active')
    expect(body.aps['relevance-score']).toBe(0.4)
    expect(body.aps).not.toHaveProperty('sound')
    expect(body.tc).not.toHaveProperty('seq')
  })
  it('drops a subscription Apple calls gone, counts other failures, re-mints on a refused provider token, and fails cleanly unconfigured', async () => {
    const { env: hubEnv } = await apnsEnv()
    const auth = await register()
    await registerDevice(hubEnv, auth)
    // A fresh Response per attempt: a body reads once.
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ reason: 'InternalServerError' }, { status: 500 }))
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0 }) as never)
    expect(await (await callWith(hubEnv, '/v1/notify', 'POST', apnsNotice, auth)).json()).toEqual({ delivered: 0, failed: 1 })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect((await directory().subscriptions())[0]).toMatchObject({ failureCount: 1, lastError: 'APNs 500 InternalServerError' })
    // 403 ExpiredProviderToken: one fresh token, then success.
    fetch.mockClear()
    const first = (await directory().subscriptions())[0]
    fetch.mockResolvedValueOnce(Response.json({ reason: 'ExpiredProviderToken' }, { status: 403 })).mockResolvedValueOnce(new Response(''))
    expect(await (await callWith(hubEnv, '/v1/notify', 'POST', apnsNotice, auth)).json()).toEqual({ delivered: 1, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(2)
    const tokens = fetch.mock.calls.map((c) => (c[1]!.headers as Record<string, string>).authorization)
    expect(tokens[0]).not.toBe(tokens[1])
    expect((await directory().subscriptions())[0]).toMatchObject({ failureCount: first.failureCount })
    // 410 Unregistered: the subscription is gone, its KV mirror with it.
    fetch.mockClear()
    fetch.mockImplementation(async () => Response.json({ reason: 'Unregistered' }, { status: 410 }))
    expect(await (await callWith(hubEnv, '/v1/notify', 'POST', apnsNotice, auth)).json()).toEqual({ delivered: 0, failed: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await directory().subscriptions()).toEqual([])
    expect((await env.HUB_KV.list({ prefix: 'sub:' })).keys).toEqual([])
    // Without the secrets nothing is posted and the row says so.
    await registerDevice(hubEnv, auth)
    fetch.mockClear()
    expect(await (await callWith({ ...env }, '/v1/notify', 'POST', apnsNotice, auth)).json()).toEqual({ delivered: 0, failed: 1 })
    expect(fetch).not.toHaveBeenCalled()
    expect((await directory().subscriptions())[0]).toMatchObject({ failureCount: 1, lastError: 'APNs not configured' })
  })
  it('pushes Live Activity states to the thread\'s devices and ends them with a dismissal date', async () => {
    const { env: hubEnv } = await apnsEnv()
    const auth = await register()
    const other = await register('mac')
    const put = (headers: Record<string, string>, deviceId = 'k1', token = TOKEN) =>
      callWith(hubEnv, `/v1/hosts/box/activities/thread-1/${deviceId}`, 'PUT', { token, bundleId: 'dev.landon.tempcode.ios', environment: 'production' }, headers)
    expect((await put(other)).status).toBe(401)
    expect((await put(auth)).status).toBe(200)
    expect((await put(auth, 'k2', 'cd'.repeat(32))).status).toBe(200)
    expect(Object.keys(await directory().activities('box', 'thread-1')).sort()).toEqual(['k1', 'k2'])
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''))
    const update = { hostId: 'box', environmentId: 'env_box', threadId: 'thread-1', event: 'update', state: { phase: 'working', since: 1000, ts: 5000 }, title: 'Done', threadType: 'implementation', ts: 5000 }
    expect((await callWith(hubEnv, '/v1/activity', 'POST', update, other)).status).toBe(401)
    expect(await (await callWith(hubEnv, '/v1/activity', 'POST', update, auth)).json()).toEqual({ delivered: 2, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(2)
    const urls = fetch.mock.calls.map((c) => String(c[0])).sort()
    expect(urls).toEqual([`https://apns.test/3/device/${TOKEN}`, `https://apns.test/3/device/${'cd'.repeat(32)}`])
    const init = fetch.mock.calls[0][1]!
    const headers = init.headers as Record<string, string>
    expect(headers['apns-topic']).toBe('dev.landon.tempcode.ios.push-type.liveactivity')
    expect(headers['apns-push-type']).toBe('liveactivity')
    expect(headers['apns-collapse-id']).toBe('thread-1')
    const body = JSON.parse(init.body as string)
    expect(body.aps).toMatchObject({ event: 'update', 'content-state': { phase: 'working', since: 1000, ts: 5000 }, 'relevance-score': 50 })
    expect(body.aps).not.toHaveProperty('dismissal-date')
    expect(typeof body.aps.timestamp).toBe('number')
    // The running row's fields pass through whole, and a coalesced task-line change goes at priority 5.
    fetch.mockClear()
    const rich = { ...update, state: { ...update.state, title: 'Done', task: 'Write the endpoint', done: 1, total: 3, reason: 'Needs approval: Bash — bun test' }, priority: 5 }
    expect(await (await callWith(hubEnv, '/v1/activity', 'POST', rich, auth)).json()).toEqual({ delivered: 2, failed: 0 })
    expect((fetch.mock.calls[0][1]!.headers as Record<string, string>)['apns-priority']).toBe('5')
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).aps['content-state']).toEqual(rich.state)
    expect((await callWith(hubEnv, '/v1/activity', 'POST', { ...update, priority: 7 }, auth)).status).toBe(400)
    expect((await callWith(hubEnv, '/v1/activity', 'POST', { ...update, state: { ...update.state, done: -1 } }, auth)).status).toBe(400)
    // A device Apple no longer knows is dropped from the thread; the other stays.
    fetch.mockClear()
    fetch.mockImplementation(async (input) => (String(input).endsWith(TOKEN) ? Response.json({ reason: 'BadDeviceToken' }, { status: 400 }) : new Response('')))
    expect(await (await callWith(hubEnv, '/v1/activity', 'POST', { ...update, state: { phase: 'paused', since: 1000, ts: 6000 } }, auth)).json()).toEqual({ delivered: 1, failed: 1 })
    expect(Object.keys(await directory().activities('box', 'thread-1'))).toEqual(['k2'])
    // The end carries the final state and a dismissal date, and the thread's tokens are gone after it.
    fetch.mockClear()
    fetch.mockResolvedValue(new Response(''))
    const end = { ...update, event: 'end', state: { phase: 'waiting', since: 1000, ts: 7000, seq: 42 }, ts: 7000 }
    expect(await (await callWith(hubEnv, '/v1/activity', 'POST', end, auth)).json()).toEqual({ delivered: 1, failed: 0 })
    const ended = JSON.parse(fetch.mock.calls[0][1]!.body as string)
    expect(ended.aps).toMatchObject({ event: 'end', 'content-state': { phase: 'waiting', seq: 42 }, 'relevance-score': 100 })
    expect(ended.aps['dismissal-date']).toBe(ended.aps.timestamp + ACTIVITY_DISMISS_S)
    expect(await directory().activities('box', 'thread-1')).toEqual({})
    // A phone that ended its activity itself removes its token; an unknown one is a 400.
    await put(auth)
    expect((await callWith(hubEnv, '/v1/hosts/box/activities/thread-1/k1', 'DELETE', undefined, auth)).status).toBe(200)
    expect(await directory().activities('box', 'thread-1')).toEqual({})
    expect((await callWith(hubEnv, '/v1/activity', 'POST', { ...update, state: { phase: 'resting', since: 1, ts: 2 } }, auth)).status).toBe(400)
    expect((await env.HUB_KV.list({ prefix: 'act:' })).keys).toEqual([])
  })
})
