import { createHmac, randomUUID } from 'node:crypto'
import type { Notice } from './notifier'

/**
 * Per-key webhooks: a bot that gave its key a URL gets every notice it
 * subscribed to, posted the way the hub Worker posts them (infra/hub):
 * the same body, `x-hub-signature-256: sha256=<hex>` as HMAC-SHA256 over
 * the exact bytes with the key's secret, `x-hub-delivery` shared by the
 * retries of one delivery. Best effort: one attempt plus one retry, five
 * seconds each, failures logged by key id (never the URL).
 */

export interface WebhookTarget {
  keyId: string
  name: string
  url: string
  secret: string
}

/** The hub's notify body, as a receiver sees it. */
export interface WebhookPayload {
  event: Notice['event']
  hostId: string
  threadId: string
  title: string
  body: string
  url?: string
  ts: number
}

export const WEBHOOK_TIMEOUT_MS = 5_000
export const WEBHOOK_ATTEMPTS = 2

export const signPayload = (body: string, secret: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

export function webhookPayload(notice: Notice, hostId: string): WebhookPayload {
  return {
    event: notice.event,
    hostId,
    threadId: notice.threadId,
    title: notice.title,
    body: notice.body,
    ...(notice.url ? { url: notice.url } : {}),
    ts: notice.ts
  }
}

/** Only https, or plain http on the loopback (a receiver under test); never credentials in the URL. */
export function checkWebhookUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('webhook URL is not a URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('webhook URL must be https')
  if (url.username || url.password) throw new Error('webhook URL must not carry credentials')
  return url.toString()
}

interface Dependencies {
  fetch?: typeof globalThis.fetch
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}

/** Post one notice to every target; resolves when every delivery settled. */
export async function deliverWebhooks(
  targets: WebhookTarget[],
  payload: WebhookPayload,
  deps: Dependencies = {}
): Promise<{ delivered: number; failed: number }> {
  const fetch = deps.fetch ?? globalThis.fetch
  const log = deps.log ?? ((line) => console.log(`[notify] ${line}`))
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const body = JSON.stringify(payload)
  let delivered = 0
  let failed = 0
  await Promise.all(
    targets.map(async (target) => {
      const deliveryId = randomUUID()
      const signature = signPayload(body, target.secret)
      let error = 'unknown'
      for (let attempt = 0; attempt < WEBHOOK_ATTEMPTS; attempt++) {
        if (attempt) await sleep(250)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
        timer.unref?.()
        try {
          const response = await fetch(target.url, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              'x-hub-signature-256': signature,
              'x-hub-delivery': deliveryId
            },
            body
          })
          await response.body?.cancel()
          if (response.ok) {
            delivered++
            return
          }
          error = `HTTP ${response.status}`
        } catch (err) {
          error = controller.signal.aborted
            ? 'timeout'
            : err instanceof Error
              ? ((err as NodeJS.ErrnoException).code ?? err.name)
              : 'error'
        } finally {
          clearTimeout(timer)
        }
      }
      failed++
      log(`webhook ${target.keyId} (${target.name}) failed: ${error}`)
    })
  )
  return { delivered, failed }
}
