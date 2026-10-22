/** Optional off-host status relay. Never send transcript or tool content here. */
export type HubEventKind = 'needs_you' | 'finished' | 'failed' | 'stuck' | 'host_down' | 'host_up'
export interface HubEvent {
  event: HubEventKind
  threadId?: string
  title: string
  body: string
  url?: string
  ts?: number
  /** The row a phone lands on when the notification is tapped (thread L6). */
  seq?: number
  /** The project or workspace the thread is in: the notification's subtitle. */
  subtitle?: string
  /** What the notice is about, for the phone's category and actions. */
  kind?: HubNoticeKind
  /** The approval a phone's Approve or Deny decides (kind `approval`). */
  requestId?: string
  /** This host's name: the payload's `tc.host`, which the phone adds to the subtitle when several hosts are paired. */
  hostName?: string
  /** Another host's thread: a relayed host's notice (remote/relay.ts); default this host's own id. */
  environmentId?: string
}
export type HubNoticeKind = 'approval' | 'question' | 'plan' | 'waiting' | 'finished' | 'failed' | 'stuck' | 'batch' | 'stopped'
/** A phone's APNs registration, forwarded as the hub's `apns` subscription for this host. */
export interface HubDevice {
  /** The key id on this host: one subscription per key, replaced on a rotated token. */
  deviceId: string
  token: string
  bundleId: string
  environment: 'sandbox' | 'production'
  events: HubEventKind[]
}
/**
 * The Live Activity's `content-state`; keys match the phone's ContentState
 * (ios/TempCode/Activity/Shared/ThreadActivity.swift). The clock runs on
 * the device from `since`; everything else is what the desktop's running
 * row shows: the title, the task in progress, the tally, and why the
 * thread waits.
 */
export interface HubActivityState {
  phase: 'working' | 'paused' | 'waiting' | 'finished' | 'failed' | 'stopped'
  since: number
  ts: number
  seq?: number
  /** The thread's title at this state, so a rename shows without a restart. */
  title?: string
  /** The in-progress task of the thread's list, else what it is doing right now. */
  task?: string
  /** The list's tally, when the thread has one; a watching master's batch, children done of total. */
  done?: number
  total?: number
  /** What done/total count; absent means tasks. */
  unit?: 'tasks' | 'threads'
  /** Why the thread waits: the needs-you line. */
  reason?: string
}
export type HubAck = { ok: true } | { ok: false; error: string }
export interface HubOptions {
  url: string
  hostToken: string
  hostId: string
  environmentId: string
  name: string
  version: string
}
export interface HubResult {
  delivered: number
  failed: number
}
export interface HubClient {
  notify(event: HubEvent): Promise<HubResult | null>
  /** `PUT /v1/hosts/:id/devices/:deviceId`: the hub holds one apns subscription per device. */
  registerDevice(device: HubDevice): Promise<HubAck>
  removeDevice(deviceId: string): Promise<HubAck>
  /** The Live Activity token a phone holds for a thread; the hub pushes `liveactivity` updates to it. */
  setActivity(activity: { deviceId: string; threadId: string; token: string; bundleId: string; environment: 'sandbox' | 'production' }): Promise<HubAck>
  removeActivity(deviceId: string, threadId: string): Promise<HubAck>
  /** `POST /v1/activity`: one state for every device watching the thread; `end` drops them on the hub. */
  pushActivity(activity: { threadId: string; event: 'update' | 'end'; state: HubActivityState; title?: string; threadType?: string; priority?: 5 | 10 }): Promise<HubResult | null>
  stop(): void
}
interface Dependencies {
  fetch?: typeof globalThis.fetch
  random?: () => number
  log?: (message: string) => void
}
function baseUrl(value: string): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid hub URL')
  return url.toString().replace(/\/$/, '')
}
export function startHub(options: HubOptions, dependencies: Dependencies = {}): HubClient {
  const base = baseUrl(options.url)
  if (
    !options.hostToken ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(options.hostId) ||
    !options.environmentId ||
    !options.name ||
    !options.version
  )
    throw new Error('Invalid hub configuration')
  const fetch = dependencies.fetch ?? globalThis.fetch
  const random = dependencies.random ?? Math.random
  const log = dependencies.log ?? console.error
  const startedAt = Date.now()
  const pending = new Set<AbortController>()
  const states = new Map<string, string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function state(channel: string, next: string): void {
    const previous = states.get(channel)
    if (next === previous || stopped) return
    states.set(channel, next)
    if (next !== 'ok' || (previous !== undefined && previous !== 'ok'))
      log(`[hub] ${channel}: ${next}`)
  }
  async function post(
    path: string,
    payload: object,
    channel: string,
    timeout: number
  ): Promise<unknown | null> {
    return send('POST', path, payload, channel, timeout)
  }
  /** The last failure of a channel, as the device calls report it ("HTTP 404", "timeout", "unavailable"). */
  const failures = new Map<string, string>()
  async function send(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload: object | null,
    channel: string,
    timeout: number
  ): Promise<unknown | null> {
    if (stopped) return null
    const controller = new AbortController()
    pending.add(controller)
    const deadline = setTimeout(() => controller.abort(), timeout)
    deadline.unref?.()
    try {
      const response = await fetch(base + path, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: 'Bearer ' + options.hostToken,
          ...(payload === null ? {} : { 'content-type': 'application/json' })
        },
        ...(payload === null ? {} : { body: JSON.stringify(payload) })
      })
      if (!response.ok) {
        await response.body?.cancel()
        failures.set(channel, 'HTTP ' + response.status)
        state(channel, 'HTTP ' + response.status)
        return null
      }
      const result: unknown = await response.json()
      if (stopped) return null
      if (!result || typeof result !== 'object') {
        state(channel, 'invalid response')
        return null
      }
      return result
    } catch {
      failures.set(channel, controller.signal.aborted ? 'timeout' : 'unavailable')
      state(channel, controller.signal.aborted ? 'timeout' : 'unavailable')
      return null
    } finally {
      clearTimeout(deadline)
      pending.delete(controller)
    }
  }
  const hostPath = '/v1/hosts/' + encodeURIComponent(options.hostId)
  /** A device call: the hub's `{ ok: true }`, or the channel's last failure. */
  async function ack(method: 'PUT' | 'DELETE', path: string, payload: object | null, channel: string): Promise<HubAck> {
    failures.delete(channel)
    const result = await send(method, path, payload, channel, 10_000)
    if (result !== null && (result as { ok?: boolean }).ok === true) {
      state(channel, 'ok')
      return { ok: true }
    }
    // A delete of what the hub no longer has is done.
    if (method === 'DELETE' && failures.get(channel) === 'HTTP 404') return { ok: true }
    if (result !== null) state(channel, 'invalid response')
    return { ok: false, error: failures.get(channel) ?? (stopped ? 'stopped' : 'invalid response') }
  }
  const counts = (channel: string, result: unknown | null): HubResult | null => {
    if (result === null) return null
    const value = result as HubResult
    if (
      !Number.isSafeInteger(value.delivered) ||
      value.delivered < 0 ||
      !Number.isSafeInteger(value.failed) ||
      value.failed < 0
    ) {
      state(channel, 'invalid response')
      return null
    }
    state(channel, value.failed ? 'delivery failed' : 'ok')
    return { delivered: value.delivered, failed: value.failed }
  }
  async function beat(): Promise<void> {
    const result = await post(
      '/v1/hosts/' + encodeURIComponent(options.hostId) + '/heartbeat',
      {
        environmentId: options.environmentId,
        name: options.name,
        version: options.version,
        startedAt
      },
      'heartbeat',
      5000
    )
    if (result !== null)
      state('heartbeat', (result as { ok?: boolean }).ok === true ? 'ok' : 'invalid response')
    if (!stopped) {
      timer = setTimeout(
        () => {
          void beat()
        },
        27_000 + Math.floor(random() * 6000)
      )
      timer.unref?.()
    }
  }
  void beat()
  return {
    async notify(event) {
      // Pick fields explicitly: even an over-wide caller cannot leak thread data.
      const result = await post(
        '/v1/notify',
        {
          event: event.event,
          hostId: options.hostId,
          title: event.title,
          body: event.body,
          ts: event.ts ?? Date.now(),
          environmentId: event.environmentId ?? options.environmentId,
          ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
          ...(event.url === undefined ? {} : { url: event.url }),
          ...(event.seq === undefined ? {} : { seq: event.seq }),
          ...(event.subtitle === undefined ? {} : { subtitle: event.subtitle }),
          ...(event.kind === undefined ? {} : { kind: event.kind }),
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          ...(event.hostName === undefined ? {} : { hostName: event.hostName })
        },
        'notify',
        25_000
      )
      return counts('notify', result)
    },
    registerDevice(device) {
      return ack(
        'PUT',
        `${hostPath}/devices/${encodeURIComponent(device.deviceId)}`,
        { token: device.token, bundleId: device.bundleId, environment: device.environment, events: device.events },
        'devices'
      )
    },
    removeDevice(deviceId) {
      return ack('DELETE', `${hostPath}/devices/${encodeURIComponent(deviceId)}`, null, 'devices')
    },
    setActivity(activity) {
      return ack(
        'PUT',
        `${hostPath}/activities/${encodeURIComponent(activity.threadId)}/${encodeURIComponent(activity.deviceId)}`,
        { token: activity.token, bundleId: activity.bundleId, environment: activity.environment },
        'activities'
      )
    },
    removeActivity(deviceId, threadId) {
      return ack('DELETE', `${hostPath}/activities/${encodeURIComponent(threadId)}/${encodeURIComponent(deviceId)}`, null, 'activities')
    },
    async pushActivity(activity) {
      const result = await post(
        '/v1/activity',
        {
          hostId: options.hostId,
          environmentId: options.environmentId,
          threadId: activity.threadId,
          event: activity.event,
          state: activity.state,
          ts: Date.now(),
          ...(activity.title === undefined ? {} : { title: activity.title }),
          ...(activity.threadType === undefined ? {} : { threadType: activity.threadType }),
          ...(activity.priority === undefined ? {} : { priority: activity.priority })
        },
        'activity',
        15_000
      )
      return counts('activity', result)
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      for (const controller of pending) controller.abort()
      pending.clear()
    }
  }
}

export function hubFromEnv(
  identity: { environmentId?: string; name: string; version: string },
  env: NodeJS.ProcessEnv = process.env,
  dependencies: Dependencies = {}
): HubClient | null {
  const url = env.TEMP_CODE_HUB_URL
  const hostId = env.TEMP_CODE_HUB_HOST_ID
  const hostToken = env.TEMP_CODE_HUB_TOKEN
  if (!url && !hostId && !hostToken) return null
  const log = dependencies.log ?? console.error
  if (!url || !hostId || !hostToken) {
    log(
      '[hub] disabled: set TEMP_CODE_HUB_URL, TEMP_CODE_HUB_HOST_ID and TEMP_CODE_HUB_TOKEN together'
    )
    return null
  }
  try {
    return startHub(
      { url, hostId, hostToken, ...identity, environmentId: identity.environmentId ?? hostId },
      dependencies
    )
  } catch {
    log('[hub] disabled: invalid configuration')
    return null
  }
}
