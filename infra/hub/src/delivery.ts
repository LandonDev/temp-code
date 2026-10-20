import { signature, unseal } from './crypto'
import { guardTarget } from './target'
import type { Env, Notice } from './types'
export const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
/** The one directory object: host ids and subscriptions, never KV on a hot path. */
export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))
export async function fanOut(
  env: Env,
  notice: Notice
): Promise<{ delivered: number; failed: number }> {
  const subscriptions = (await directory(env).subscriptions()).filter(
    (s) => s.events.includes(notice.event) && (!s.hosts || s.hosts.includes(notice.hostId))
  )
  const body = JSON.stringify(notice)
  const results = await Promise.all(
    subscriptions.map(async (sub) => {
      const deliveryId = crypto.randomUUID()
      let error = 'APNs delivery is not implemented'
      if (sub.kind === 'webhook') {
        try {
          const signed = await signature(body, await unseal(sub.encryptedSecret, env.WEBHOOK_KEY))
          // The host is checked again now: a name that moved inside the
          // network since the subscription was made gets nothing (R2 M3).
          let allowed = true
          try {
            await guardTarget(new URL(sub.url).hostname)
          } catch {
            allowed = false
            error = 'Webhook target refused'
          }
          // One initial attempt plus three retries; the ID stays fixed.
          for (let attempt = 0; allowed && attempt < 4; attempt++) {
            if (attempt)
              await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)))
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            try {
              const response = await fetch(sub.url, {
                method: 'POST',
                redirect: 'error',
                signal: controller.signal,
                headers: {
                  'content-type': 'application/json',
                  'x-hub-signature-256': signed,
                  'x-hub-delivery': deliveryId
                },
                body
              })
              await response.body?.cancel()
              if (response.ok) return true
              error = 'Webhook HTTP ' + response.status
            } catch {
              // Do not retain fetch error text: it can contain URL secrets.
              error = controller.signal.aborted ? 'Webhook timeout' : 'Webhook network error'
            } finally {
              clearTimeout(timeout)
            }
          }
        } catch {
          error = 'Webhook signing failed'
        }
      }
      await directory(env).recordFailure(sub.id, error)
      return false
    })
  )
  return { delivered: results.filter(Boolean).length, failed: results.filter((v) => !v).length }
}
