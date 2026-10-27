import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { accounts, codexSnapshotToWindows, parseUnifiedHeaders, pinnedProfile, scopedCapOf, serviceIdOf, type ForwardHooks } from 'aliax-core'
import { shortHash, type NetworkInfo, type RoutingHooks } from './gatewayCore'
import type { HeadroomStore } from './headroom'

/**
 * What the gateway learns from traffic it forwards: Claude's unified headers
 * move the answering account's 5h, Weekly and (for a model with a scoped
 * cap, the 7d_oi header) Fable windows on every answer, and every 429 and
 * 529 goes to a log (status, account, model, limit headers, body, the
 * replay attempt when core says; never credentials) so the failover
 * classifier can be built from real refusals; a fetch that got no answer
 * at all is a `network` record there too (the path, the account hashed,
 * the error), so a silent provider shows up where the throttles do. Every
 * answer with an account also goes to the headroom store (headroom.ts):
 * the per-request limit headers, the request rate and any 429 or 529.
 */
let observed: (() => void) | null = null

export function observeHooks({ logDir, onObserved, headroom }: { logDir: string; onObserved?: () => void; headroom?: Pick<HeadroomStore, 'observe'> }): ForwardHooks & Pick<RoutingHooks, 'onNetwork'> {
  observed = onObserved ?? null
  return {
    onNetwork: (info) => logNetwork(logDir, info),
    onResponse: (info) => {
      const { service, path, status, headers, body, account, model } = info
      if (status === 429 || status === 529) logLimit(logDir, { service, path, status, headers, body, account, model, attempt: attemptOf(info) })
      const serviceId = serviceIdOf(service)
      if (headroom && serviceId && account) headroom.observe({ service: serviceId, account, model, status, headers })
      if (service !== 'claude') return
      const limits = parseUnifiedHeaders(headers, scopedCapOf('claude-code', model))
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
export function observeCodexSnapshot(snapshot: unknown, account: string | null = null): void {
  const name = account ?? pinnedProfile('codex')
  const windows = codexSnapshotToWindows(snapshot)
  if (!name || windows.length === 0) return
  if (accounts.observeWindows('codex', name, windows)) observed?.()
}

const KEPT_HEADERS = new Set(['retry-after', 'request-id', 'content-type'])

/** The replay attempt a hook answer carries once core says it; absent until then. */
function attemptOf(info: unknown): number | undefined {
  const attempt = (info as { attempt?: unknown }).attempt
  return typeof attempt === 'number' ? attempt : undefined
}

function logLimit(
  dir: string,
  info: { service: string; path: string; status: number; headers: Headers; body?: string; account: string | null; model: string | null; attempt?: number }
): void {
  const headers: Record<string, string> = {}
  info.headers.forEach((value, key) => {
    if (key.startsWith('anthropic-ratelimit') || key.startsWith('x-ratelimit') || KEPT_HEADERS.has(key)) headers[key] = value
  })
  const line = {
    ts: Date.now(),
    service: info.service,
    path: info.path,
    status: info.status,
    account: info.account,
    model: info.model,
    ...(info.attempt !== undefined ? { attempt: info.attempt } : {}),
    headers,
    body: info.body?.slice(0, 4000)
  }
  appendRecord(dir, line, `a ${info.status}`)
}

/** No upstream answer: the request's path, its account hashed, the fetch error. */
function logNetwork(dir: string, info: NetworkInfo): void {
  appendRecord(dir, { ts: Date.now(), kind: 'network', service: info.service, path: info.path, account: info.account ? shortHash(info.account) : null, error: info.error.slice(0, 500) }, 'a network failure')
}

function appendRecord(dir: string, line: Record<string, unknown>, what: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'gateway-limits.jsonl'), JSON.stringify(line) + '\n')
  } catch (e) {
    console.warn(`[gateway] could not log ${what}:`, (e as Error).message)
  }
}
