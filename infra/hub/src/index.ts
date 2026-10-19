import { hash, matches, seal, token } from './crypto'
import { fanOut, json, list } from './delivery'
import { id, Invalid, kinds, notice, object, readJson, str, url } from './validation'
import type { Env, Host, Notice, Subscription } from './types'
export { HostState } from './host'

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
      const isHost = (hb && method === 'POST') || (path === '/v1/notify' && method === 'POST')
      // Missing credentials return immediately, before parsing or accessing storage.
      if (isHost) {
        if (!/^Bearer [^\s]+$/.test(request.headers.get('authorization') ?? ''))
          return json({ error: 'Unauthorized' }, 401)
      } else if (!(await admin(request, env))) return json({ error: 'Unauthorized' }, 401)
      if (hb && method === 'POST')
        return transition(await hostCall(env, id(hb[1]), 'heartbeat', request), env, ctx)
      if (path === '/v1/notify' && method === 'POST') {
        const payload = notice(await readJson(request))
        const auth = await hostCall(
          env,
          payload.hostId,
          'auth',
          new Request(request.url, { headers: request.headers })
        )
        if (!auth.ok) return auth
        return json(await fanOut(env, payload))
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
          const hosts = await list<Host>(env.HUB_KV, 'host:')
          const rows = await Promise.all(
            hosts.map(async (entry) => {
              const current = await hostCall(env, entry.hostId, 'view')
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
        if (method === 'GET') {
          const subs = await list<Subscription>(env.HUB_KV, 'sub:')
          return json(
            await Promise.all(
              subs.map(async (sub) => {
                const { encryptedSecret: _secret, ...safe } = sub as Subscription & {
                  encryptedSecret?: string
                }
                const stats = await hostCall(env, 'subscription:' + sub.id, 'stats')
                return { ...safe, ...((await stats.json()) as object) }
              })
            )
          )
        }
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
          const secret = v.secret === undefined ? token() : str(v.secret, 'secret', 512)
          const sub: Subscription = {
            id: crypto.randomUUID(),
            name: str(v.name, 'name'),
            kind: 'webhook',
            url: url(v.url),
            encryptedSecret: await seal(secret, env.WEBHOOK_KEY),
            events: kinds(v.events),
            ...(hosts ? { hosts } : {}),
            failureCount: 0,
            lastError: null
          }
          await env.HUB_KV.put('sub:' + sub.id, JSON.stringify(sub))
          const { encryptedSecret: _secret, ...safe } = sub
          return json({ ...safe, ...(v.secret === undefined ? { secret } : {}) }, 201)
        }
      }
      const sub = path.match(/^\/v1\/subscriptions\/([^/]+)$/)
      if (sub && method === 'DELETE') {
        const key = 'sub:' + id(sub[1])
        if (!(await env.HUB_KV.get(key))) return json({ error: 'Subscription not found' }, 404)
        await env.HUB_KV.delete(key)
        await hostCall(env, 'subscription:' + sub[1], 'clear')
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
    const hosts = await list<Host>(env.HUB_KV, 'host:')
    await Promise.all(
      hosts.map(async (h) => {
        const response = await hostCall(env, h.hostId, 'check')
        if (!response.ok && response.status !== 404) throw new Error('Host check failed')
        if (response.ok) await transition(response, env, ctx)
      })
    )
  }
} satisfies ExportedHandler<Env>
