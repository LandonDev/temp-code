import { DurableObject } from 'cloudflare:workers'
import type { Env, Subscription } from './types'

interface Failure {
  failureCount: number
  lastError: string | null
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The directory: the set of host ids and the subscriptions, in one SQLite-backed
 * object. Everything the cron, the host list and the fan-out need is read from
 * here, so no per-minute or per-heartbeat path touches KV. Changes happen under
 * `blockConcurrencyWhile`, which is the compare-and-swap KV never had.
 *
 * KV keeps a cold mirror (`host:<id>`, `sub:<id>`), written only when an entry
 * is added or removed and never read again, except once: the first read after
 * the upgrade seeds this object from the pre-directory layout, where those keys
 * were the directory. A seed that cannot list (the daily quota is spent) is
 * retried on the next read; a host also announces itself at its next heartbeat
 * (host.ts), so a live host is never held up by the seed.
 */
export class Directory extends DurableObject<Env> {
  async hostIds(): Promise<string[]> {
    await this.seed()
    const keys = [...(await this.ctx.storage.list({ prefix: 'host:' })).keys()]
    return keys.map((key) => key.slice(5)).sort()
  }
  async addHost(hostId: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('host:' + hostId)) return
      await this.ctx.storage.put('host:' + hostId, true)
      await this.mirror(() => this.env.HUB_KV.put('host:' + hostId, JSON.stringify({ hostId })))
    })
  }
  async removeHost(hostId: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.delete('host:' + hostId)
      await this.mirror(() => this.env.HUB_KV.delete('host:' + hostId))
    })
  }
  /** Every subscription with its failure counters merged in; secrets stay sealed. */
  async subscriptions(): Promise<Subscription[]> {
    await this.seed()
    const failures = await this.ctx.storage.list<Failure>({ prefix: 'failure:' })
    const rows = await this.ctx.storage.list<Subscription>({ prefix: 'sub:' })
    return [...rows.values()].map((sub) => ({ ...sub, ...failures.get('failure:' + sub.id) }))
  }
  async putSubscription(sub: Subscription): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put('sub:' + sub.id, sub)
      await this.mirror(() => this.env.HUB_KV.put('sub:' + sub.id, JSON.stringify(sub)))
    })
  }
  /** Removes the subscription and its counters; false when it was not there. */
  async deleteSubscription(id: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existed = (await this.ctx.storage.delete(['sub:' + id, 'failure:' + id])) > 0
      if (existed) await this.mirror(() => this.env.HUB_KV.delete('sub:' + id))
      return existed
    })
  }
  async recordFailure(id: string, lastError: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const previous = await this.ctx.storage.get<Failure>('failure:' + id)
      await this.ctx.storage.put('failure:' + id, {
        lastError,
        failureCount: (previous?.failureCount ?? 0) + 1
      })
    })
  }
  /** The mirror is never read in steady state, so a failed write is logged, not fatal. */
  private async mirror(write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (e) {
      console.error('[directory] KV mirror write failed: ' + message(e))
    }
  }
  private async seed(): Promise<void> {
    if (await this.ctx.storage.get('seeded')) return
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('seeded')) return
      try {
        for (const key of await this.keys('host:'))
          if (!(await this.ctx.storage.get(key))) await this.ctx.storage.put(key, true)
        for (const key of await this.keys('sub:')) {
          if (await this.ctx.storage.get(key)) continue
          const sub = await this.env.HUB_KV.get<Subscription>(key, 'json')
          if (sub && typeof sub === 'object') await this.ctx.storage.put(key, { ...sub, id: key.slice(4) })
        }
        await this.ctx.storage.put('seeded', true)
      } catch (e) {
        console.error('[directory] seed from KV failed, retrying on the next read: ' + message(e))
      }
    })
  }
  private async keys(prefix: string): Promise<string[]> {
    const names: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.env.HUB_KV.list({ prefix, cursor })
      for (const key of page.keys) names.push(key.name)
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    return names
  }
}
