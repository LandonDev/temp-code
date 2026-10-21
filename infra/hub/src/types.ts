import type { Directory } from './directory'
export const events = ['needs_you', 'finished', 'failed', 'stuck', 'host_down', 'host_up'] as const
export type EventKind = (typeof events)[number]
export const pushEnvironments = ['sandbox', 'production'] as const
export type PushEnvironment = (typeof pushEnvironments)[number]
export interface Notice {
  event: EventKind
  hostId: string
  /** The host's own environment id: what a phone's saved host is keyed by. */
  environmentId?: string
  threadId?: string
  /** The row a phone lands on when the notification is tapped. */
  seq?: number
  title: string
  /** The project or workspace the thread is in. */
  subtitle?: string
  body: string
  url?: string
  ts: number
  /** What the notice is about: the phone's category (Approve and Deny on an approval). */
  kind?: NoticeKind
  /** The approval a phone may decide from the notification (kind `approval`). */
  requestId?: string
}
export const noticeKinds = ['approval', 'question', 'plan', 'waiting', 'finished', 'failed', 'stuck'] as const
export type NoticeKind = (typeof noticeKinds)[number]
export interface Heartbeat {
  environmentId: string
  name: string
  version: string
  startedAt: number
  load?: Record<string, number | boolean | string>
}
export interface Host extends Partial<Heartbeat> {
  hostId: string
  tokenHash: string
  registeredAt: number
  lastSeen: number | null
  down: boolean
  /** In the directory. Hosts registered before it existed join at their next heartbeat. */
  listed?: boolean
}
/** A phone's APNs registration, one per device per host (`PUT /v1/hosts/:id/devices/:deviceId`). */
export interface ApnsDevice {
  deviceId: string
  token: string
  bundleId: string
  environment: PushEnvironment
}
export type Subscription = {
  id: string
  name: string
  events: EventKind[]
  hosts?: string[]
  failureCount: number
  lastError: string | null
} & ({ kind: 'webhook'; url: string; encryptedSecret: string } | ({ kind: 'apns' } & ApnsDevice))
/** The Live Activity tokens held for one thread, by device. */
export type Activities = Record<string, ApnsDevice>
export const activityPhases = ['working', 'paused', 'waiting', 'finished', 'failed'] as const
export type ActivityPhase = (typeof activityPhases)[number]
/** The Live Activity's `content-state`, keys as the phone's ContentState: the clock runs from `since`, the rest is the desktop's running row. */
export interface ActivityState {
  phase: ActivityPhase
  since: number
  ts: number
  seq?: number
  title?: string
  task?: string
  done?: number
  total?: number
  reason?: string
}
/** `POST /v1/activity`: one state for every device watching the thread. */
export interface ActivityUpdate {
  hostId: string
  environmentId?: string
  threadId: string
  event: 'update' | 'end'
  state: ActivityState
  title?: string
  threadType?: string
  /** 5 for a coalesced task-line change, 10 (the default) for everything else. */
  priority?: 5 | 10
  ts: number
}
export interface Env {
  ADMIN_KEY: string
  WEBHOOK_KEY: string
  /** APNs token auth (wrangler secret put): the .p8 contents, its key id, the team id. */
  APNS_KEY?: string
  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  /** A gateway for both environments (a test receiver); unset means Apple's. */
  APNS_URL?: string
  HUB_KV: KVNamespace
  HOSTS: DurableObjectNamespace
  DIRECTORY: DurableObjectNamespace<Directory>
}
