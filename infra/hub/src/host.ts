import { DurableObject } from 'cloudflare:workers'
import { hash, matches, token } from './crypto'
import { json } from './delivery'
import { heartbeat, Invalid, readJson } from './validation'
import type { Env, Host, Notice } from './types'

export const ALIVE_MS = 180_000
export class HostState extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    // KV has no compare-and-swap. The object serializes all lifecycle changes,
    // including overlapping cron checks and recovery heartbeats.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const action = new URL(request.url).pathname
        const hostId = request.headers.get('x-host-id')!
        if (action === '/failure') {
          const previous = await this.ctx.storage.get<{ failureCount: number }>('failure')
          const { lastError } = await request.json() as { lastError: string }
          await this.ctx.storage.put('failure', { lastError, failureCount: (previous?.failureCount ?? 0) + 1 })
          return json({ ok: true })
        }
        if (action === '/stats') return json(await this.ctx.storage.get('failure') ?? {})
        let host = await this.ctx.storage.get<Host>('host')
        if (action === '/register') {
          if (host) return json({ error: 'Host already exists' }, 409)
          const raw = token()
          host = { hostId, tokenHash: await hash(raw), registeredAt: Date.now(), lastSeen: null, down: false }
          await this.ctx.storage.put('host', host)
          await this.mirror(host)
          return json({ hostId, hostToken: raw }, 201)
        }
        if (!host) return json({ error: action === '/heartbeat' || action === '/auth' ? 'Unauthorized' : 'Host not found' }, action === '/heartbeat' || action === '/auth' ? 401 : 404)
        if (action === '/view') return json({ hostId: host.hostId, lastSeen: host.lastSeen, alive: host.lastSeen !== null && Date.now() - host.lastSeen <= ALIVE_MS, name: host.name ?? host.hostId, version: host.version ?? null, environmentId: host.environmentId ?? null })
        if (action === '/delete') {
          await this.ctx.storage.deleteAlarm()
          await this.ctx.storage.delete(['host', 'lastMirror'])
          await this.env.HUB_KV.delete('host:' + hostId)
          return json({ ok: true })
        }
        if (action === '/auth' || action === '/heartbeat') {
          const bearer = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1]
          if (!bearer || !await matches(bearer, host.tokenHash)) return json({ error: 'Unauthorized' }, 401)
          if (action === '/auth') return json({ ok: true })
        }
        const now = Date.now()
        let event: Notice | undefined
        if (action === '/heartbeat') {
          const body = heartbeat(await readJson(request))
          if (host.down) event = this.transition(host, 'host_up', now)
          host = { ...host, ...body, lastSeen: now, down: false }
        } else if (action === '/check') {
          if (host.down || now - (host.lastSeen ?? host.registeredAt) <= ALIVE_MS) return json({ ok: true })
          host.down = true
          event = this.transition(host, 'host_down', now)
        } else return json({ error: 'Not found' }, 404)
        await this.ctx.storage.put('host', host)
        await this.mirror(host)
        return json({ ok: true, serverTime: now, ...(event ? { event } : {}) })
      } catch (e) {
        return json({ error: e instanceof Invalid ? e.message : 'Host state unavailable' }, e instanceof Invalid ? 400 : 503)
      }
    })
  }
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const host = await this.ctx.storage.get<Host>('host')
      if (host) await this.mirror(host)
    })
  }
  private async mirror(host: Host): Promise<void> {
    const lastWrite = await this.ctx.storage.get<number>('lastMirror') ?? 0
    if (Date.now() - lastWrite < 1100) {
      await this.ctx.storage.setAlarm(lastWrite + 1100)
      return
    }
    await this.env.HUB_KV.put('host:' + host.hostId, JSON.stringify(host))
    await this.ctx.storage.put('lastMirror', Date.now())
  }
  private transition(host: Host, event: 'host_up' | 'host_down', ts: number): Notice {
    return { event, hostId: host.hostId, title: `${host.name ?? host.hostId} ${event === 'host_up' ? 'is back' : 'is down'}`, body: event === 'host_up' ? 'Host heartbeat resumed.' : 'No host heartbeat for over three minutes.', ts }
  }
}
