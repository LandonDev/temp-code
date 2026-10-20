import { hash, matches, seal, token } from './crypto'
import { directory, fanOut, fanOutActivity, json } from './delivery'
import { activity, device, id, Invalid, kinds, notice, object, readJson, secret as secretOf, str, webhookUrl } from './validation'
import type { Env, Notice, Subscription } from './types'
export { HostState } from './host'
export { Directory } from './directory'

export function hostCall(
  env: Env,
  hostId: string,
  action: string,
  request?: Request
): Promise<Response> {
  const headers = new Headers(request?.headers)
  headers.set('x-host-id', hostId)
  return env.HOSTS.get(env.HOSTS.idFromName(hostId)).fetch(
    new Request('https://host/' + action, { method: 'POST', headers, body: request?.body })
  )
}
async function admin(request: Request, env: Env): Promise<boolean> {
  const key = request.headers.get('x-api-key')
  return !!key && !!env.ADMIN_KEY && (await matches(key, await hash(env.ADMIN_KEY)))
}
async function transition(response: Response, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!response.ok) return response
  const result = (await response.json()) as { ok: boolean; serverTime: number; event?: Notice }
  if (result.event) ctx.waitUntil(fanOut(env, result.event))
  return json({ ok: true, serverTime: result.serverTime })
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname
      const method = request.method
      if (path === '/healthz' && method === 'GET') return json({ ok: true })
      const hb = path.match(/^\/v1\/hosts\/([^/]+)\/heartbeat$/)
      // A host's own devices and their Live Activity tokens (thread L6): the host bearer, scoped to the path's host.
      const dev = path.match(/^\/v1\/hosts\/([^/]+)\/devices\/([^/]+)$/)
      const act = path.match(/^\/v1\/hosts\/([^/]+)\/activities\/([^/]+)\/([^/]+)$/)
      const hostOwned = ((dev || act) && (method === 'PUT' || method === 'DELETE')) || (path === '/v1/activity' && method === 'POST')
      const isHost = (hb && method === 'POST') || (path === '/v1/notify' && method === 'POST') || hostOwned
      // Missing credentials return immediately, before parsing or accessing storage.
      if (isHost) {
        if (!/^Bearer [^\s]+$/.test(request.headers.get('authorization') ?? ''))
          return json({ error: 'Unauthorized' }, 401)
      } else if (!(await admin(request, env))) return json({ error: 'Unauthorized' }, 401)
      if (hb && method === 'POST')
        return transition(await hostCall(env, id(hb[1]), 'heartbeat', request), env, ctx)
      const hostAuth = (hostId: string) =>
        hostCall(env, hostId, 'auth', new Request(request.url, { headers: request.headers }))
      if (path === '/v1/notify' && method === 'POST') {
        const payload = notice(await readJson(request))
        const auth = await hostAuth(payload.hostId)
        if (!auth.ok) return auth
        return json(await fanOut(env, payload))
      }
      if (path === '/v1/activity' && method === 'POST') {
        const payload = activity(await readJson(request))
        const auth = await hostAuth(payload.hostId)
        if (!auth.ok) return auth
        return json(await fanOutActivity(env, payload))
      }
      if (dev && (method === 'PUT' || method === 'DELETE')) {
        const hostId = id(dev[1])
        const deviceId = id(dev[2])
        const auth = await hostAuth(hostId)
        if (!auth.ok) return auth
        const subId = `apns-${hostId}-${deviceId}`
        if (method === 'DELETE') {
          if (!(await directory(env).deleteSubscription(subId))) return json({ error: 'Subscription not found' }, 404)
          return json({ ok: true })
        }
        const v = object(await readJson(request))
        const registered = device(v, deviceId)
        const sub: Subscription = {
          id: subId,
          name: `Phone ${deviceId} on ${hostId}`,
          kind: 'apns',
          ...registered,
          events: kinds(v.events),
          hosts: [hostId],
          failureCount: 0,
          lastError: null
        }
        // A fresh registration (a rotated token) starts with clean counters.
        await directory(env).clearFailure(subId)
        await directory(env).putSubscription(sub)
        return json({ ok: true, id: subId })
      }
      if (act && (method === 'PUT' || method === 'DELETE')) {
        const hostId = id(act[1])
        const threadId = id(act[2])
        const deviceId = id(act[3])
        const auth = await hostAuth(hostId)
        if (!auth.ok) return auth
        if (method === 'DELETE') {
          await directory(env).deleteActivity(hostId, threadId, deviceId)
          return json({ ok: true })
        }
        await directory(env).putActivity(hostId, threadId, device(await readJson(request), deviceId))
        return json({ ok: true })
      }
      if (path === '/v1/hosts') {
        if (method === 'POST') {
          const value = object(await readJson(request))
          return hostCall(
            env,
            value.hostId === undefined ? crypto.randomUUID() : id(value.hostId),
            'register'
          )
        }
        if (method === 'GET') {
          const rows = await Promise.all(
            (await directory(env).hostIds()).map(async (hostId) => {
              const current = await hostCall(env, hostId, 'view')
              if (current.status === 404) return null
              if (!current.ok) throw new Error('Host state unavailable')
              return current.json()
            })
          )
          return json(rows.filter((row) => row !== null))
        }
      }
      const host = path.match(/^\/v1\/hosts\/([^/]+)$/)
      if (host && method === 'DELETE') return hostCall(env, id(host[1]), 'delete')
      if (path === '/v1/subscriptions') {
        if (method === 'GET')
          return json(
            (await directory(env).subscriptions()).map((sub) => {
              // Neither a webhook's ciphertext nor a phone's token is listed.
              const { encryptedSecret: _secret, token: _token, ...safe } = sub as Subscription & {
                encryptedSecret?: string
                token?: string
              }
              return safe
            })
          )
        if (method === 'POST') {
          const v = object(await readJson(request))
          if (v.kind !== 'webhook') throw new Invalid('Only webhook subscriptions are supported')
          const hosts =
            v.hosts === undefined
              ? undefined
              : (() => {
                  if (!Array.isArray(v.hosts) || v.hosts.length > 100)
                    throw new Invalid('Invalid hosts')
                  return v.hosts.map(id)
                })()
          const secret = v.secret === undefined ? token() : secretOf(v.secret)
          const sub: Subscription = {
            id: crypto.randomUUID(),
            name: str(v.name, 'name'),
            kind: 'webhook',
            url: await webhookUrl(v.url),
            encryptedSecret: await seal(secret, env.WEBHOOK_KEY),
            events: kinds(v.events),
            ...(hosts ? { hosts } : {}),
            failureCount: 0,
            lastError: null
          }
          await directory(env).putSubscription(sub)
          const { encryptedSecret: _secret, ...safe } = sub
          return json({ ...safe, ...(v.secret === undefined ? { secret } : {}) }, 201)
        }
      }
      const sub = path.match(/^\/v1\/subscriptions\/([^/]+)$/)
      if (sub && method === 'DELETE') {
        if (!(await directory(env).deleteSubscription(id(sub[1]))))
          return json({ error: 'Subscription not found' }, 404)
        return json({ ok: true })
      }
      return json({ error: 'Not found' }, 404)
    } catch (e) {
      return json(
        { error: e instanceof Invalid ? e.message : 'Hub unavailable' },
        e instanceof Invalid ? 400 : 503
      )
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // One directory call a minute, then one check per host; KV is not on this path.
    await Promise.all(
      (await directory(env).hostIds()).map(async (hostId) => {
        const response = await hostCall(env, hostId, 'check')
        if (!response.ok && response.status !== 404) throw new Error('Host check failed')
        if (response.ok) await transition(response, env, ctx)
      })
    )
  }
} satisfies ExportedHandler<Env>
