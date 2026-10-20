import type { HubActivityState } from '../hub'

/**
 * The APNs payloads, as infra/hub/src/delivery.ts builds them: one shape
 * whichever side posts to Apple. A phone reads `tc` to land on the thread
 * and the row; a Live Activity reads `aps.content-state`.
 */

export type ApnsEventKind = 'needs_you' | 'finished' | 'failed' | 'stuck' | 'host_down' | 'host_up'

export interface ApnsNotice {
  event: ApnsEventKind
  hostId: string
  environmentId?: string
  threadId?: string
  seq?: number
  title: string
  body: string
  ts: number
}

export interface ApnsActivityUpdate {
  threadId: string
  event: 'update' | 'end'
  state: HubActivityState
  ts: number
}

/** An ended activity stays on the lock screen this long: the final state, briefly. */
export const ACTIVITY_DISMISS_S = 120
/** How long an alert may wait for a phone that is off: an hour. */
export const ALERT_TTL_S = 3600
const URGENT = new Set<ApnsEventKind>(['needs_you', 'failed', 'host_down'])

export function notificationPayload(notice: ApnsNotice): unknown {
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

export function activityPayload(update: ApnsActivityUpdate, now = Date.now()): unknown {
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
