export const events = ['needs_you', 'finished', 'failed', 'stuck', 'host_down', 'host_up'] as const
export type EventKind = (typeof events)[number]
export interface Notice {
  event: EventKind
  hostId: string
  threadId?: string
  title: string
  body: string
  url?: string
  ts: number
}
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
}
export type Subscription = {
  id: string
  name: string
  events: EventKind[]
  hosts?: string[]
  failureCount: number
  lastError: string | null
} & (
  | { kind: 'webhook'; url: string; encryptedSecret: string }
  | { kind: 'apns' /* TODO: APNs registration, signing and delivery in the iOS push thread. */ }
)
export interface Env {
  ADMIN_KEY: string
  WEBHOOK_KEY: string
  HUB_KV: KVNamespace
  HOSTS: DurableObjectNamespace
}
