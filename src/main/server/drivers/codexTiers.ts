import { homedir } from 'node:os'
import { CATALOG } from '@shared/catalog'
import { harnessEnv, resolveBinary } from './binaries'
import { AppServerConn } from './codex'

/**
 * Which service tiers (priority, ultrafast) the installed codex CLI offers
 * per model on its logged-in account. The CLI is the only source: the
 * app-server's `model/list` lists `serviceTiers` for each model and
 * `account/read` names the account. The answer is cached in the settings
 * table per account, applied at boot before the first `catalog.get`, and
 * re-probed in the background (and on `catalog.get {refresh}`). A model the
 * CLI does not list keeps no tiers at all: unknown is never shown as absent.
 */

const KEY = 'codex.speedTiers'
const PROBE_TIMEOUT_MS = 8_000

export type TierCache = {
  /** the account the last probe answered for */
  last: string | null
  /** per account: model id → the tier ids the CLI listed */
  accounts: Record<string, Record<string, string[]>>
}

type SettingsStore = {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
}

/** Pure: pull `{model → tiers}` out of a `model/list` result. */
export function tiersFromModelList(result: unknown): Record<string, string[]> {
  const data = (result as { data?: unknown })?.data
  const out: Record<string, string[]> = {}
  if (!Array.isArray(data)) return out
  for (const m of data as Array<Record<string, unknown>>) {
    const id = typeof m.model === 'string' ? m.model : typeof m.id === 'string' ? m.id : null
    if (!id) continue
    const tiers = Array.isArray(m.serviceTiers) ? m.serviceTiers : []
    out[id] = tiers
      .map((t) => (t && typeof t === 'object' ? (t as { id?: unknown }).id : t))
      .filter((t): t is string => typeof t === 'string')
  }
  return out
}

/** Pure: stamp `speedTiers` onto the codex rows the CLI listed; rows it did
 *  not list lose any stale stamp (another account may have had them). */
export function applySpeedTiers(tiers: Record<string, string[]>): void {
  for (const model of CATALOG.codex.models) {
    const listed = tiers[model.id]
    if (listed) model.speedTiers = listed
    else delete model.speedTiers
  }
}

export function readTierCache(store: SettingsStore): TierCache {
  try {
    const raw = store.getSetting(KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<TierCache>) : null
    return { last: parsed?.last ?? null, accounts: parsed?.accounts ?? {} }
  } catch {
    return { last: null, accounts: {} }
  }
}

let ready: Promise<void> = Promise.resolve()
let inflight: Promise<void> | null = null

/** Apply the cached answer for the last account at once, then probe the
 *  CLI in the background. Returns when the catalog has a usable answer:
 *  immediately with a cache, else when the first probe lands (bounded). */
export function startCodexTiers(store: SettingsStore): Promise<void> {
  const cache = readTierCache(store)
  const cached = cache.last ? cache.accounts[cache.last] : undefined
  if (cached) applySpeedTiers(cached)
  const probe = probeCodexTiers(store)
  ready = cached ? Promise.resolve() : probe
  return ready
}

/** Resolves once `catalog.get` can answer with tiers (see startCodexTiers). */
export const codexTiersReady = (): Promise<void> => ready

export function probeCodexTiers(store: SettingsStore): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    const answer = await withTimeout(readTiersFromCli(), PROBE_TIMEOUT_MS)
    if (!answer) return
    const cache = readTierCache(store)
    const account = answer.account ?? ''
    cache.last = account
    cache.accounts[account] = answer.tiers
    store.setSetting(KEY, JSON.stringify(cache))
    applySpeedTiers(answer.tiers)
  })()
    .catch((err) => console.error('[catalog] codex tiers probe failed:', err instanceof Error ? err.message : err))
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function readTiersFromCli(): Promise<{ account: string | null; tiers: Record<string, string[]> } | null> {
  const binPath = await resolveBinary('codex')
  if (!binPath) return null
  const env = await harnessEnv()
  const conn = new AppServerConn(binPath, env, homedir(), () => {}, () => {}, () => {})
  try {
    await conn.request('initialize', {
      clientInfo: { name: 'temp-code', title: 'temp-code', version: '0.1.0' }
    })
    conn.notify('initialized')
    const list = await conn.request('model/list', {})
    const acct = (await conn.request('account/read', {}).catch(() => null)) as
      { account?: { email?: string } } | null
    return { account: acct?.account?.email ?? null, tiers: tiersFromModelList(list) }
  } finally {
    conn.kill()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms)
    t.unref()
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
