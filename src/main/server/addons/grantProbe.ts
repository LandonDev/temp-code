import type { AddonSpec } from '@shared/contract-addons'

/**
 * The health call an add-on's typed values are presented to once before they
 * are saved (plan-8YMm3ynnFZYs.md §8), as a Meta key is presented to
 * `/v1/models`: one POST of a JSON-RPC `initialize` to an http add-on's url
 * with the headers its values name, 10 s. A 2xx says the values work; a 401
 * or 403 that the server refused them (nothing is saved); any other answer
 * or a network failure says nothing, and the values are saved anyway, as
 * saveApiKey saves on a 429. A stdio add-on has no health call. Runs on the
 * grant's writer (the box for a shared scope).
 */

export type ProbeAnswer = 'ok' | 'refused' | 'unknown'
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export const PROBE_TIMEOUT_MS = 10_000

export async function probeFields(spec: AddonSpec, fields: Record<string, string>, fetch: Fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeAnswer> {
  if (spec.transport !== 'http') return 'unknown'
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const name of spec.headers) if (fields[name] !== undefined) headers[name] = fields[name]
  try {
    const res = await fetch(spec.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'TempCode', version: '1' } } }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    await res.body?.cancel().catch(() => {})
    if (res.status === 401 || res.status === 403) return 'refused'
    return res.ok ? 'ok' : 'unknown'
  } catch {
    return 'unknown'
  }
}
