import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountRoute } from '@shared/accounts'
import { gateway } from './gateway'

export type Service = 'claude' | 'codex'

/** Aliax's shim: a launchd service on a fixed port that follows the marker to whoever owns the gateway. */
export const SHIM_URL = `http://127.0.0.1:${process.env.ALIAX_SHIM_PORT ?? '8787'}`
const SHIM_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.aliax.shim.plist')
const RECHECK_MS = 30_000

export interface EndpointDeps {
  shimInstalled: () => boolean
  fetch: typeof globalThis.fetch
  gatewayUrl: (service: Service) => string | null
  /** Our gateway's https origin for one codex thread, scoped to its route; null without TLS. */
  scopedCodexUrl: (thread: string, route: AccountRoute) => Promise<string | null>
  now: () => number
}

const defaults: EndpointDeps = {
  shimInstalled: () => existsSync(SHIM_PLIST),
  fetch: (input, init) => globalThis.fetch(input, init),
  gatewayUrl: (service) => gateway()?.url(service) ?? null,
  scopedCodexUrl: (thread, route) => gateway()?.scopedCodexUrl(thread, { thread, ...route }) ?? Promise.resolve(null),
  now: Date.now
}

let last: { at: number; ok: boolean } | null = null
/** Whether the gateway behind each origin understands scoped routes, per origin. */
const features = new Map<string, { at: number; ok: boolean }>()

async function shimAnswers(d: EndpointDeps): Promise<boolean> {
  if (!d.shimInstalled()) return false
  if (last && d.now() - last.at < RECHECK_MS) return last.ok
  let ok = false
  try {
    const res = await d.fetch(`${SHIM_URL}/__shim`, { signal: AbortSignal.timeout(1500) })
    ok = res.ok && ((await res.json()) as { ok?: boolean })?.ok === true
  } catch {
    ok = false
  }
  last = { at: d.now(), ok }
  return ok
}

/**
 * Where a CLI child should send provider traffic: the shim when it answers
 * (it reaches whoever holds the marker, us included), else our own gateway,
 * else null and the CLI keeps its default.
 */
export async function endpointFor(service: Service, deps: Partial<EndpointDeps> = {}): Promise<string | null> {
  const d = { ...defaults, ...deps }
  if (await shimAnswers(d)) return `${SHIM_URL}/${service}`
  return d.gatewayUrl(service)
}

/**
 * The per-thread scope segment, appended to the service base:
 *   <endpoint>/~t=<thread>;a=<account>[;pin=1]
 * Only a gateway that lists `scoped-routes` honours it; anything older would
 * pass the segment upstream as part of the path.
 */
export function routeUrl(endpoint: string, thread: string, route: AccountRoute): string {
  return `${endpoint}/~t=${encodeURIComponent(thread)};a=${encodeURIComponent(route.account)}${route.pin ? ';pin=1' : ''}`
}

/**
 * Whether the owner behind `endpoint` reads scope segments. Probed under the
 * service prefix (`/claude/__aliax`): the shim forwards only service paths.
 */
async function scopedRoutesAt(endpoint: string, d: EndpointDeps): Promise<boolean> {
  const origin = new URL(endpoint).origin
  const known = features.get(origin)
  if (known && d.now() - known.at < RECHECK_MS) return known.ok
  let ok = false
  try {
    const res = await d.fetch(`${endpoint}/__aliax`, { signal: AbortSignal.timeout(1500) })
    const body = res.ok ? ((await res.json()) as { features?: unknown }) : null
    ok = Array.isArray(body?.features) && body.features.includes('scoped-routes')
  } catch {
    ok = false
  }
  features.set(origin, { at: d.now(), ok })
  return ok
}

export interface RoutedEndpoint {
  url: string | null
  /** The account the URL names; null when it is unscoped (no route, or an owner too old to read one). */
  account: string | null
}

/**
 * The base URL for one thread's child: `endpointFor`, plus the thread's
 * account when it has one and the owner behind the endpoint can read it.
 *
 * A codex thread with a route goes to our own gateway's https port for that
 * thread instead: codex 0.158+ refuses an http base and keeps only the
 * origin of an https one, so neither the shim's path nor its fixed TLS port
 * can carry a scope. The port is the scope, and only this process allocates
 * it, so no owner probe is needed. Without a certificate the thread falls
 * back to the shared path (unscoped on a new codex, scoped on an old one).
 */
export async function routedEndpointFor(
  service: Service,
  scope: { thread: string; route: AccountRoute | null },
  deps: Partial<EndpointDeps> = {}
): Promise<RoutedEndpoint> {
  const d = { ...defaults, ...deps }
  if (service === 'codex' && scope.route) {
    const url = await d.scopedCodexUrl(scope.thread, scope.route)
    if (url) {
      console.log(`[gateway] codex ${scope.thread}: ${scope.route.account}${scope.route.pin ? ' (pinned)' : ''} on ${url}`)
      return { url, account: scope.route.account }
    }
  }
  const endpoint = await endpointFor(service, d)
  if (!endpoint || !scope.route) return { url: endpoint, account: null }
  if (!(await scopedRoutesAt(endpoint, d))) {
    console.log(`[gateway] ${service} ${scope.thread}: owner has no scoped routes, sending unscoped`)
    return { url: endpoint, account: null }
  }
  console.log(`[gateway] ${service} ${scope.thread}: ${scope.route.account}${scope.route.pin ? ' (pinned)' : ''}`)
  return { url: routeUrl(endpoint, scope.thread, scope.route), account: scope.route.account }
}

export const forgetShimAnswer = (): void => {
  last = null
  features.clear()
}
