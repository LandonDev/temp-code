import { apnsSend, type ApnsRequest } from './apns'
import { signature, unseal } from './crypto'
import { guardTarget } from './target'
import type { ActivityUpdate, ApnsDevice, Env, Notice, Subscription } from './types'
export const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
/** The one directory object: host ids and subscriptions, never KV on a hot path. */
export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))
/** How long an alert may wait for a phone that is off: an hour. */
const ALERT_TTL_S = 3600
/** An ended activity stays on the lock screen this long: the final state, briefly. */
export const ACTIVITY_DISMISS_S = 120
const URGENT = new Set<Notice['event']>(['needs_you', 'failed', 'host_down'])

/** The alert a phone shows: title and body as the host sent them, the thread and row to land on under `tc`. */
export function notificationPayload(notice: Notice): unknown {
  return {
    aps: {
      alert: { title: notice.title, body: notice.body },
      sound: 'default',
      'thread-id': notice.threadId ?? notice.hostId,
      'interruption-level': URGENT.has(notice.event) ? 'time-sensitive' : 'active'
    },
    tc: {
      event: notice.event,
      hostId: notice.hostId,
      ...(notice.environmentId === undefined ? {} : { environmentId: notice.environmentId }),
      ...(notice.threadId === undefined ? {} : { threadId: notice.threadId }),
      ...(notice.seq === undefined ? {} : { seq: notice.seq }),
      ts: notice.ts
    }
  }
}

/** The Live Activity update: the phone's ContentState under `content-state`; an end dismisses after a while. */
export function activityPayload(update: ActivityUpdate, now = Date.now()): unknown {
  const seconds = Math.floor(now / 1000)
  return {
    aps: {
      timestamp: seconds,
      event: update.event,
      'content-state': update.state,
      ...(update.event === 'end' ? { 'dismissal-date': seconds + ACTIVITY_DISMISS_S } : {}),
      'relevance-score': update.state.phase === 'waiting' || update.state.phase === 'failed' ? 100 : 50
    }
  }
}

async function deliverWebhook(env: Env, sub: Subscription & { kind: 'webhook' }, body: string, deliveryId: string): Promise<true | string> {
  let error = 'Webhook failed'
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
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)))
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
  return error
}

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
      if (sub.kind === 'webhook') {
        const outcome = await deliverWebhook(env, sub, body, deliveryId)
        if (outcome === true) return true
        await directory(env).recordFailure(sub.id, outcome)
        return false
      }
      const request: ApnsRequest = {
        token: sub.token,
        topic: sub.bundleId,
        pushType: 'alert',
        environment: sub.environment,
        payload: notificationPayload(notice),
        expiration: Math.floor(notice.ts / 1000) + ALERT_TTL_S,
        collapseId: `${notice.threadId ?? notice.hostId}:${notice.event}`,
        id: deliveryId
      }
      const result = await apnsSend(env, request)
      if (result.ok) return true
      // A token Apple no longer knows is a phone that uninstalled or re-registered: the subscription goes.
      if (result.gone) await directory(env).deleteSubscription(sub.id)
      else await directory(env).recordFailure(sub.id, result.error)
      return false
    })
  )
  return { delivered: results.filter(Boolean).length, failed: results.filter((v) => !v).length }
}

/** One liveactivity push per device watching the thread; an end drops the thread's tokens. */
export async function fanOutActivity(env: Env, update: ActivityUpdate): Promise<{ delivered: number; failed: number }> {
  const devices = Object.values(await directory(env).activities(update.hostId, update.threadId))
  const payload = activityPayload(update)
  const results = await Promise.all(
    devices.map(async (device: ApnsDevice) => {
      const result = await apnsSend(env, {
        token: device.token,
        topic: `${device.bundleId}.push-type.liveactivity`,
        pushType: 'liveactivity',
        environment: device.environment,
        payload,
        // A stale update is worth nothing; an end should still land when the phone comes back.
        expiration: Math.floor(update.ts / 1000) + (update.event === 'end' ? ALERT_TTL_S : 60),
        collapseId: update.threadId
      })
      if (result.ok) return true
      if (result.gone) await directory(env).deleteActivity(update.hostId, update.threadId, device.deviceId)
      else await directory(env).recordFailure(`apns-${update.hostId}-${device.deviceId}`, result.error)
      return false
    })
  )
  if (update.event === 'end') await directory(env).deleteActivity(update.hostId, update.threadId)
  return { delivered: results.filter(Boolean).length, failed: results.filter((v) => !v).length }
}
