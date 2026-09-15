import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  now: () => number
}

const defaults: EndpointDeps = {
  shimInstalled: () => existsSync(SHIM_PLIST),
  fetch: (input, init) => globalThis.fetch(input, init),
  gatewayUrl: (service) => gateway()?.url(service) ?? null,
  now: Date.now
}

let last: { at: number; ok: boolean } | null = null

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

export const forgetShimAnswer = (): void => {
  last = null
}
