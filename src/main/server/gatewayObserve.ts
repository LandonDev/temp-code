import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { accounts, codexSnapshotToWindows, parseUnifiedHeaders, pinnedProfile, type ForwardHooks } from 'aliax-core'

/**
 * What the gateway learns from traffic it forwards: Claude's unified headers
 * move the answering account's 5h and Weekly windows on every answer, and
 * every 429 goes to a log (status, limit headers, body; never credentials) so
 * the failover classifier can be built from real refusals.
 */
let observed: (() => void) | null = null

export function observeHooks({ logDir, onObserved }: { logDir: string; onObserved?: () => void }): ForwardHooks {
  observed = onObserved ?? null
  return {
    onResponse: ({ service, path, status, headers, body, account }) => {
      if (status === 429) logLimit(logDir, { service, path, status, headers, body })
      if (service !== 'claude') return
      const limits = parseUnifiedHeaders(headers)
      if (!limits || !account || limits.windows.length === 0) return
      if (accounts.observeWindows('claude-code', account, limits.windows)) onObserved?.()
    }
  }
}

/**
 * Codex has no limit headers; its app-server pushes `account/rateLimits/updated`
 * (and answers `account/rateLimits/read`). The codex driver hands those here
 * with the account its process spends from; without one they describe the pin.
 */
export function observeCodexSnapshot(snapshot: unknown, account: string | null = pinnedProfile('codex')): void {
  const windows = codexSnapshotToWindows(snapshot)
  if (!account || windows.length === 0) return
  if (accounts.observeWindows('codex', account, windows)) observed?.()
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
