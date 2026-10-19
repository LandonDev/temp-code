import { signature, unseal } from './crypto'
import type { Env, Notice, Subscription } from './types'
export const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
export async function list<T>(kv: KVNamespace, prefix: string): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix, cursor })
    const values = await Promise.all(page.keys.map(k => kv.get<T>(k.name, 'json')))
    for (const value of values) if (value !== null) rows.push(value as T)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return rows
}
export async function fanOut(env: Env, notice: Notice): Promise<{ delivered: number; failed: number }> {
  const subscriptions = (await list<Subscription>(env.HUB_KV, 'sub:')).filter(s => s.events.includes(notice.event) && (!s.hosts || s.hosts.includes(notice.hostId)))
  const body = JSON.stringify(notice)
  const results = await Promise.all(subscriptions.map(async sub => {
    const deliveryId = crypto.randomUUID()
    let error = 'APNs delivery is not implemented'
    if (sub.kind === 'webhook') {
      try {
        const signed = await signature(body, await unseal(sub.encryptedSecret, env.WEBHOOK_KEY))
        // One initial attempt plus three retries; the ID stays fixed.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1)))
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5000)
          try {
            const response = await fetch(sub.url, {
              method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'content-type': 'application/json', 'x-hub-signature-256': signed, 'x-hub-delivery': deliveryId }, body
            })
            await response.body?.cancel()
            if (response.ok) return true
            error = 'Webhook HTTP ' + response.status
          } catch {
            // Do not retain fetch error text: it can contain URL secrets.
            error = controller.signal.aborted ? 'Webhook timeout' : 'Webhook network error'
          } finally { clearTimeout(timeout) }
        }
      } catch { error = 'Webhook signing failed' }
    }
    const response = await env.HOSTS.get(env.HOSTS.idFromName('subscription:' + sub.id)).fetch('https://host/failure', { method: 'POST', body: JSON.stringify({ lastError: error }) })
    if (!response.ok) throw new Error('Failed to record delivery failure')
    return false
  }))
  return { delivered: results.filter(Boolean).length, failed: results.filter(v => !v).length }
}
