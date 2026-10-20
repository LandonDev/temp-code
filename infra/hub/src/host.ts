import { DurableObject } from 'cloudflare:workers'
import { hash, matches, token } from './crypto'
import { json } from './delivery'
import { heartbeat, Invalid, readJson } from './validation'
import type { Env, Host, Notice } from './types'

export const ALIVE_MS = 180_000
export class HostState extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    // The object serializes all lifecycle changes, including overlapping cron
    // checks and recovery heartbeats. Liveness lives here and nowhere else.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const action = new URL(request.url).pathname
        const hostId = request.headers.get('x-host-id')!
        let host = await this.ctx.storage.get<Host>('host')
        if (action === '/register') {
          if (host) return json({ error: 'Host already exists' }, 409)
          const raw = token()
          host = {
            hostId,
            tokenHash: await hash(raw),
            registeredAt: Date.now(),
            lastSeen: null,
            down: false,
            listed: true
          }
          await this.ctx.storage.put('host', host)
          try {
            await this.directory().addHost(hostId)
          } catch (e) {
            // Not in the directory means invisible to the cron and the list: undo, so a retry works.
            await this.ctx.storage.delete('host')
            throw e
          }
          return json({ hostId, hostToken: raw }, 201)
        }
        if (!host)
          return json(
            {
              error:
                action === '/heartbeat' || action === '/auth' ? 'Unauthorized' : 'Host not found'
            },
            action === '/heartbeat' || action === '/auth' ? 401 : 404
          )
        if (action === '/view')
          return json({
            hostId: host.hostId,
            lastSeen: host.lastSeen,
            alive: host.lastSeen !== null && Date.now() - host.lastSeen <= ALIVE_MS,
            name: host.name ?? host.hostId,
            version: host.version ?? null,
            environmentId: host.environmentId ?? null
          })
        if (action === '/delete') {
          await this.directory().removeHost(hostId)
          await this.ctx.storage.deleteAlarm()
          await this.ctx.storage.delete(['host', 'lastMirror'])
          return json({ ok: true })
        }
        if (action === '/auth' || action === '/heartbeat') {
          const bearer = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1]
          if (!bearer || !(await matches(bearer, host.tokenHash)))
            return json({ error: 'Unauthorized' }, 401)
          if (action === '/auth') return json({ ok: true })
        }
        const now = Date.now()
        let event: Notice | undefined
        if (action === '/heartbeat') {
          const body = heartbeat(await readJson(request))
          // A host registered before the directory existed joins it once, here.
          if (!host.listed) await this.directory().addHost(hostId)
          if (host.down) event = this.transition(host, 'host_up', now)
          host = { ...host, ...body, lastSeen: now, down: false, listed: true }
        } else if (action === '/check') {
          if (host.down || now - (host.lastSeen ?? host.registeredAt) <= ALIVE_MS)
            return json({ ok: true })
          host.down = true
          event = this.transition(host, 'host_down', now)
        } else return json({ error: 'Not found' }, 404)
        await this.ctx.storage.put('host', host)
        return json({ ok: true, serverTime: now, ...(event ? { event } : {}) })
      } catch (e) {
        return json(
          { error: e instanceof Invalid ? e.message : 'Host state unavailable' },
          e instanceof Invalid ? 400 : 503
        )
      }
    })
  }
  /** Builds before the directory throttled a KV mirror through an alarm; a live object may still have one pending. */
  async alarm(): Promise<void> {
    await this.ctx.storage.delete('lastMirror')
  }
  private directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory'))
  }
  private transition(host: Host, event: 'host_up' | 'host_down', ts: number): Notice {
    return {
      event,
      hostId: host.hostId,
      title: `${host.name ?? host.hostId} ${event === 'host_up' ? 'is back' : 'is down'}`,
      body:
        event === 'host_up'
          ? 'Host heartbeat resumed.'
          : 'No host heartbeat for over three minutes.',
      ts
    }
  }
}
