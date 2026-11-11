import type { HubActivityState, HubNoticeKind } from '../hub'

/**
 * The APNs payloads, as infra/hub/src/delivery.ts builds them: one shape
 * whichever side posts to Apple. A phone reads `tc` to land on the thread
 * and the row (and, on an approval, to decide it from the notification's
 * actions); a Live Activity reads `aps.content-state`.
 *
 * The alert is one line a person needs: the thread's title, the project or
 * workspace as the subtitle, the body the notifier wrote. Only a thread
 * that needs the person interrupts (time-sensitive, sound); a failure
 * sounds too; a finish or a stall lands quietly. Every notice of a thread
 * groups under that thread, the relevance score ranks them in the summary.
 */

export type ApnsEventKind = 'needs_you' | 'finished' | 'failed' | 'stuck' | 'host_down' | 'host_up'

export interface ApnsNotice {
  event: ApnsEventKind
  hostId: string
  environmentId?: string
  threadId?: string
  seq?: number
  title: string
  subtitle?: string
  body: string
  kind?: HubNoticeKind
  requestId?: string
  /** A computer step held for the session tier: the category is `tc.run-skip`, Run now and Skip. */
  choices?: 'run-skip'
  /** The host's name: `tc.host`, which the phone's service extension adds to the subtitle when several hosts are paired. */
  hostName?: string
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
/** The category the phone registers Approve and Deny under. */
export const APPROVAL_CATEGORY = 'tc.approval'
/** A computer step held for the Mac: the phone's Run now and Skip, under the same two actions. */
export const RUN_SKIP_CATEGORY = 'tc.run-skip'
/** Every other thread notice: the phone's Open action. */
export const THREAD_CATEGORY = 'tc.thread'

/** The phone's actions for a thread's notice: Approve and Deny, Run now and Skip, else Open. */
function categoryOf(notice: Pick<ApnsNotice, 'kind' | 'choices'>): string {
  if (notice.kind !== 'approval') return THREAD_CATEGORY
  return notice.choices === 'run-skip' ? RUN_SKIP_CATEGORY : APPROVAL_CATEGORY
}
const SOUNDED = new Set<ApnsEventKind>(['needs_you', 'failed', 'host_down'])
const RELEVANCE: Record<ApnsEventKind, number> = {
  needs_you: 1,
  failed: 0.8,
  host_down: 0.8,
  stuck: 0.6,
  finished: 0.4,
  host_up: 0.2
}

export function notificationPayload(notice: ApnsNotice): unknown {
  return {
    aps: {
      alert: {
        title: notice.title,
        ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
        body: notice.body
      },
      ...(SOUNDED.has(notice.event) ? { sound: 'default' } : {}),
      'thread-id': notice.threadId ?? notice.hostId,
      'summary-arg': notice.subtitle ?? notice.title,
      'interruption-level': notice.event === 'needs_you' ? 'time-sensitive' : 'active',
      'relevance-score': RELEVANCE[notice.event],
      ...(notice.threadId === undefined ? {} : { category: categoryOf(notice) }),
      // The phone's service extension may add the host to the subtitle when several hosts are paired.
      'mutable-content': 1
    },
    tc: {
      event: notice.event,
      hostId: notice.hostId,
      ...(notice.environmentId === undefined ? {} : { environmentId: notice.environmentId }),
      ...(notice.threadId === undefined ? {} : { threadId: notice.threadId }),
      ...(notice.seq === undefined ? {} : { seq: notice.seq }),
      ...(notice.kind === undefined ? {} : { kind: notice.kind }),
      ...(notice.requestId === undefined ? {} : { requestId: notice.requestId }),
      ...(notice.hostName === undefined ? {} : { host: notice.hostName }),
      ts: notice.ts
    }
  }
}

/** The phases a phone should rank first: the thread wants something, or ended badly. */
const URGENT_PHASES = new Set<HubActivityState['phase']>(['waiting', 'failed', 'stopped'])

export function activityPayload(update: ApnsActivityUpdate, now = Date.now()): unknown {
  const seconds = Math.floor(now / 1000)
  return {
    aps: {
      timestamp: seconds,
      event: update.event,
      'content-state': update.state,
      ...(update.event === 'end' ? { 'dismissal-date': seconds + ACTIVITY_DISMISS_S } : {}),
      'relevance-score': URGENT_PHASES.has(update.state.phase) ? 100 : 50
    }
  }
}
