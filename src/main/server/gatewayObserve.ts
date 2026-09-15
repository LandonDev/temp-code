import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { accounts, parseUnifiedHeaders, pinnedProfile, type ForwardHooks } from 'aliax-core'

/**
 * What the gateway learns from traffic it forwards: Claude's unified headers
 * move the pinned account's 5h and Weekly windows on every answer, and every
 * 429 goes to a log (status, limit headers, body; never credentials) so the
 * failover classifier can be built from real refusals.
 */
export function observeHooks({ logDir, onObserved }: { logDir: string; onObserved?: () => void }): ForwardHooks {
  return {
    onResponse: ({ service, path, status, headers, body }) => {
      if (status === 429) logLimit(logDir, { service, path, status, headers, body })
      if (service !== 'claude') return
      const limits = parseUnifiedHeaders(headers)
      const pinned = pinnedProfile('claude-code')
      if (!limits || !pinned || limits.windows.length === 0) return
      if (accounts.observeWindows('claude-code', pinned, limits.windows)) onObserved?.()
    }
  }
}

const KEPT_HEADERS = new Set(['retry-after', 'request-id', 'content-type'])

function logLimit(
  dir: string,
  info: { service: string; path: string; status: number; headers: Headers; body?: string }
): void {
  const headers: Record<string, string> = {}
  info.headers.forEach((value, key) => {
    if (key.startsWith('anthropic-ratelimit') || key.startsWith('x-ratelimit') || KEPT_HEADERS.has(key)) headers[key] = value
  })
  const line = { ts: Date.now(), service: info.service, path: info.path, status: info.status, headers, body: info.body?.slice(0, 4000) }
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'gateway-limits.jsonl'), JSON.stringify(line) + '\n')
  } catch (e) {
    console.warn('[gateway] could not log a 429:', (e as Error).message)
  }
}
