import { createHmac, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { guardedLookup, resolveGuarded, type GuardOptions } from './addressGuard'
import type { Notice } from './notifier'

/**
 * Per-key webhooks: a bot that gave its key a URL gets every notice it
 * subscribed to, posted the way the hub Worker posts them (infra/hub):
 * the same body, `x-hub-signature-256: sha256=<hex>` as HMAC-SHA256 over
 * the exact bytes with the key's secret, `x-hub-delivery` shared by the
 * retries of one delivery. Best effort: one attempt plus one retry, five
 * seconds each, failures logged by key id (never the URL).
 *
 * A target is checked twice (R2 M3): when the key is made, the host is
 * resolved and refused if any answer is private, loopback, link-local or
 * unique-local (addressGuard.ts); when a notice is delivered, the socket's
 * own lookup applies the same rule, so a name that moved since cannot
 * point the POST inside the network. Redirects are never followed.
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
  /** The row the notice is about (the prompt, the error, the last row). */
  seq: number
}

export const WEBHOOK_TIMEOUT_MS = 5_000
export const WEBHOOK_ATTEMPTS = 2

/** A test harness may put its receiver on 127.0.0.1; nothing else private is ever reachable. */
export const loopbackWebhooksAllowed = (): boolean => process.env.TEMP_CODE_WEBHOOK_ALLOW_LOOPBACK === '1'

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
    ts: notice.ts,
    seq: notice.seq
  }
}

/**
 * Only https (plain http on the loopback, for a receiver under test, when
 * TEMP_CODE_WEBHOOK_ALLOW_LOOPBACK=1), never credentials in the URL, and a
 * host that resolves to public addresses only.
 */
export async function checkWebhookUrl(value: string, guard: GuardOptions = { allowLoopback: loopbackWebhooksAllowed() }): Promise<string> {
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
  await resolveGuarded(url.hostname, guard)
  return url.toString()
}

/** What a delivery needs from its transport: `fetch` fits, so does the pinned poster below. */
export type Poster = (
  url: string,
  init: { method: 'POST'; redirect: 'error'; signal: AbortSignal; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; body?: { cancel(): Promise<unknown> } | null }>

/**
 * One POST over node:http(s): the host is resolved through the guard first
 * (a private literal or name is refused before any socket opens), and the
 * socket then connects only to those checked addresses — net skips its
 * lookup for a literal, and a name gets no second, unchecked answer. A
 * 3xx is a failed status, never followed.
 */
export function pinnedPoster(guard: GuardOptions): Poster {
  return async (url, init) => {
    const target = new URL(url)
    const addresses = await resolveGuarded(target.hostname, guard)
    const pinned = guardedLookup({ ...guard, resolve: async () => addresses })
    return new Promise((resolve, reject) => {
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest
      const req = request(target, { method: 'POST', headers: init.headers, signal: init.signal, lookup: pinned as never }, (res) => {
        res.resume()
        const status = res.statusCode ?? 0
        resolve({ ok: status >= 200 && status < 300, status, body: null })
      })
      req.on('error', reject)
      req.end(init.body)
    })
  }
}

interface Dependencies {
  fetch?: Poster
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  allowLoopback?: boolean
}

/** Post one notice to every target; resolves when every delivery settled. */
export async function deliverWebhooks(
  targets: WebhookTarget[],
  payload: WebhookPayload,
  deps: Dependencies = {}
): Promise<{ delivered: number; failed: number }> {
  const post = deps.fetch ?? pinnedPoster({ allowLoopback: deps.allowLoopback ?? loopbackWebhooksAllowed() })
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
          const response = await post(target.url, {
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
