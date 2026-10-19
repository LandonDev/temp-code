/** Optional off-host status relay. Never send transcript or tool content here. */
export type HubEventKind = 'needs_you' | 'finished' | 'failed' | 'stuck' | 'host_down' | 'host_up'
export interface HubEvent {
  event: HubEventKind
  threadId?: string
  title: string
  body: string
  url?: string
  ts?: number
}
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
    if (stopped) return null
    const controller = new AbortController()
    pending.add(controller)
    const deadline = setTimeout(() => controller.abort(), timeout)
    deadline.unref?.()
    try {
      const response = await fetch(base + path, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: 'Bearer ' + options.hostToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      })
      if (!response.ok) {
        await response.body?.cancel()
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
      state(channel, controller.signal.aborted ? 'timeout' : 'unavailable')
      return null
    } finally {
      clearTimeout(deadline)
      pending.delete(controller)
    }
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
          ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
          ...(event.url === undefined ? {} : { url: event.url })
        },
        'notify',
        25_000
      )
      if (result === null) return null
      const value = result as HubResult
      if (
        !Number.isSafeInteger(value.delivered) ||
        value.delivered < 0 ||
        !Number.isSafeInteger(value.failed) ||
        value.failed < 0
      ) {
        state('notify', 'invalid response')
        return null
      }
      state('notify', value.failed ? 'delivery failed' : 'ok')
      return { delivered: value.delivered, failed: value.failed }
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
