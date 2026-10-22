import { hostname } from 'node:os'
import type { RouteKind, SavedEnvironment, SavedRoute } from '@shared/contract-remote'
import { CONTRACT_VERSION, type Capability } from '@shared/capabilities'
import type { Store } from '../db'
import { ENVIRONMENT_ID } from './environment'

/**
 * The hosts this desktop connects to (thread K1, the connection runtime).
 * One settings row per environment, `remote.environments.<id>`, holding the
 * routes and the raw bearer key; the key never crosses to the renderer,
 * which asks `remote.environments.ticket` for a 30 s ticket instead. The id
 * is the host's own environment id, read from its `/api/hello` when the
 * environment is added, so it survives restarts and endpoint changes.
 */

export const ENVIRONMENTS_PREFIX = 'remote.environments.'
export const HOST_TIMEOUT_MS = 8_000

export type EnvironmentsStore = Pick<Store, 'getSetting' | 'setSetting' | 'settingsWithPrefix'>

export interface HostContext {
  store: EnvironmentsStore
  /** This machine's own id: adding it as a remote is refused. */
  environmentId: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export type HostFailure =
  | 'unauthorized'
  | 'unavailable'
  | 'self'
  | 'unknown-environment'
  | 'unknown-route'
  | 'bad-url'
  | 'contract'
  | 'bad-link'

/** The message is `<reason>: <detail>`, which the renderer reads back. */
export class HostError extends Error {
  constructor(
    public readonly reason: HostFailure,
    detail: string
  ) {
    super(`${reason}: ${detail}`)
    this.name = 'HostError'
  }
}

type Row = SavedEnvironment & { key: string }

const rowKey = (id: string): string => `${ENVIRONMENTS_PREFIX}${id}`

function parseRow(id: string, raw: string | null): Row | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<Row>
    if (typeof value.key !== 'string' || !Array.isArray(value.routes)) return null
    return {
      id,
      name: typeof value.name === 'string' ? value.name : id,
      routes: value.routes,
      addedAt: typeof value.addedAt === 'number' ? value.addedAt : 0,
      caps: Array.isArray(value.caps) ? (value.caps as Capability[]) : [],
      keyName: typeof value.keyName === 'string' ? value.keyName : '',
      ...(typeof value.platform === 'string' && value.platform ? { platform: value.platform } : {}),
      key: value.key
    }
  } catch {
    return null
  }
}

const readRow = (store: EnvironmentsStore, id: string): Row | null => parseRow(id, store.getSetting(rowKey(id)))

function writeRow(store: EnvironmentsStore, row: Row): void {
  const { id, ...rest } = row
  store.setSetting(rowKey(id), JSON.stringify(rest))
}

const withoutKey = ({ key, ...env }: Row): SavedEnvironment => ({
  ...env,
  keyId: /^tc_([A-Za-z0-9_-]+)\./.exec(key)?.[1]
})

/** Every saved environment without its key, oldest first. */
export function listEnvironments(store: EnvironmentsStore): SavedEnvironment[] {
  const out: SavedEnvironment[] = []
  for (const [key, raw] of store.settingsWithPrefix(ENVIRONMENTS_PREFIX)) {
    const row = parseRow(key.slice(ENVIRONMENTS_PREFIX.length), raw)
    if (row) out.push(withoutKey(row))
  }
  return out.sort((a, b) => a.addedAt - b.addedAt)
}

/**
 * Remember the platform a host's hello named (`build.platform`) on its saved
 * row, so the next launch draws the host's glyph from the mirror before any
 * socket is up. Writes only when it changed; false for an unknown host.
 */
export function rememberPlatform(store: EnvironmentsStore, id: string, platform: string | undefined): boolean {
  if (!platform) return false
  const row = readRow(store, id)
  if (!row || row.platform === platform) return false
  writeRow(store, { ...row, platform })
  return true
}

export function removeEnvironment(store: EnvironmentsStore, id: string): boolean {
  if (!readRow(store, id)) return false
  store.setSetting(rowKey(id), null)
  return true
}

export function updateEnvironment(
  store: EnvironmentsStore,
  patch: { id: string; name?: string; routes?: SavedRoute[] }
): SavedEnvironment {
  const row = readRow(store, patch.id)
  if (!row) throw new HostError('unknown-environment', patch.id)
  const next: Row = {
    ...row,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.routes ? { routes: patch.routes.map((r) => normalizeRoute(r.url, r.kind)) } : {})
  }
  writeRow(store, next)
  return withoutKey(next)
}

const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|localhost$|.*\.local$)/i

/** loopback for this machine, lan for private addresses and `.local` names, tunnel otherwise. */
export function kindOf(hostname: string): RouteKind {
  const host = hostname.toLowerCase()
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') return 'loopback'
  return PRIVATE_HOST.test(host) ? 'lan' : 'tunnel'
}

/** `https://host` or `wss://host/ws` → the saved route; an http(s) origin
 *  means the fixed port's `/ws`, a ws(s) URL is kept as typed. */
export function normalizeRoute(input: string, kind?: RouteKind): SavedRoute {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new HostError('bad-url', input)
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws'
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new HostError('bad-url', `${input} is not an http(s) or ws(s) URL`)
  }
  url.hash = ''
  url.search = ''
  // URL serialises an empty path as '/'; a root socket URL stays as typed.
  const text = url.toString()
  return { url: url.pathname === '/' ? text.slice(0, -1) : text, kind: kind ?? kindOf(url.hostname) }
}

/** The HTTP origin behind a route: `wss://host/ws` → `https://host`. */
export function originOf(route: Pick<SavedRoute, 'url'>): string {
  const url = new URL(route.url)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return url.origin
}

export interface HostHello {
  environmentId: string
  name: string
  contract: number
  key?: { id: string; name: string; caps: Capability[] }
  build?: import('@shared/deployDrift').BuildFacts
}

async function hostFetch(ctx: HostContext, url: string, init: RequestInit): Promise<Response> {
  const doFetch = ctx.fetch ?? fetch
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), ctx.timeoutMs ?? HOST_TIMEOUT_MS)
  ;(deadline as { unref?: () => void }).unref?.()
  try {
    return await doFetch(url, { ...init, redirect: 'error', signal: controller.signal })
  } catch (err) {
    throw new HostError(
      'unavailable',
      controller.signal.aborted ? `${url} did not answer in time` : `${url}: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    clearTimeout(deadline)
  }
}

/** `GET /api/hello` with the key: who the host is and whether it takes the key. */
export async function fetchHello(ctx: HostContext, route: SavedRoute, key: string): Promise<HostHello> {
  const origin = originOf(route)
  const response = await hostFetch(ctx, `${origin}/api/hello`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' }
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new HostError('unavailable', `${origin} answered HTTP ${response.status}`)
  }
  const hello = (await response.json().catch(() => null)) as Partial<HostHello> | null
  if (!hello || typeof hello.environmentId !== 'string' || !ENVIRONMENT_ID.test(hello.environmentId))
    throw new HostError('unavailable', `${origin} is not a temp-code host`)
  const contract = typeof hello.contract === 'number' ? hello.contract : 0
  if (contract !== CONTRACT_VERSION) {
    throw new HostError(
      'contract',
      `${origin} speaks contract v${contract} and this app speaks v${CONTRACT_VERSION}; update the ${contract < CONTRACT_VERSION ? 'host' : 'app'}`
    )
  }
  // A rejected key still gets the public answer: no `key` block in it.
  if (!hello.key) throw new HostError('unauthorized', `${origin} rejected this key`)
  return {
    environmentId: hello.environmentId,
    name: typeof hello.name === 'string' && hello.name ? hello.name : hello.environmentId,
    contract,
    key: { id: hello.key.id, name: hello.key.name, caps: Array.isArray(hello.key.caps) ? hello.key.caps : [] },
    ...(hello.build && typeof hello.build === 'object' ? { build: hello.build } : {})
  }
}

/** Validate the key against the host, then save (or extend) the environment. */
export async function addEnvironment(
  ctx: HostContext,
  input: { url: string; key: string; name?: string; kind?: RouteKind }
): Promise<SavedEnvironment> {
  const route = normalizeRoute(input.url, input.kind)
  const key = input.key.trim()
  const hello = await fetchHello(ctx, route, key)
  if (hello.environmentId === ctx.environmentId) throw new HostError('self', `${originOf(route)} is this machine`)
  const existing = readRow(ctx.store, hello.environmentId)
  const routes = existing ? existing.routes.filter((r) => r.url !== route.url) : []
  routes.push(route)
  const row: Row = {
    id: hello.environmentId,
    name: input.name?.trim() || existing?.name || hello.name,
    routes,
    addedAt: existing?.addedAt ?? Date.now(),
    caps: hello.key?.caps ?? [],
    keyName: hello.key?.name ?? '',
    ...(hello.build?.platform ? { platform: hello.build.platform } : existing?.platform ? { platform: existing.platform } : {}),
    key
  }
  writeRow(ctx.store, row)
  return withoutKey(row)
}

/** `https://host/pair#CODE` (what Settings → Remote access hands out) → its parts. */
export function parsePairingLink(link: string): { origin: string; code: string } {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new HostError('bad-link', 'paste the whole pairing link, https://host/pair#code')
  }
  const code = (url.hash.replace(/^#/, '') || url.pathname.replace(/^\/pair\/?/, '')).trim()
  if (!/^[A-Z0-9]{5}-[A-Z0-9]{5}$/i.test(code)) throw new HostError('bad-link', `${link.trim()} carries no pairing code`)
  return { origin: url.origin, code: code.toUpperCase() }
}

/**
 * Exchange a pairing code for a key on the host (`POST /api/pair`, kind
 * `key`), then save the host like `addEnvironment`. The key is named after
 * this machine on the host's client list.
 */
export async function pairEnvironment(
  ctx: HostContext,
  input: { link?: string; origin?: string; code?: string; name?: string; kind?: RouteKind }
): Promise<SavedEnvironment> {
  const parsed = input.link ? parsePairingLink(input.link) : input.origin && input.code ? parsePairingLink(`${input.origin}/pair#${input.code}`) : null
  if (!parsed) throw new HostError('bad-link', 'a pairing link, or an origin and a code, is needed')
  const response = await hostFetch(ctx, `${parsed.origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code: parsed.code, kind: 'key', name: hostname() })
  })
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel()
    throw new HostError('unauthorized', `${parsed.origin} refused the pairing code (expired, used, or mistyped)`)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new HostError('unavailable', `${parsed.origin} answered HTTP ${response.status}`)
  }
  const body = (await response.json().catch(() => null)) as { key?: unknown } | null
  if (!body || typeof body.key !== 'string') throw new HostError('unavailable', `${parsed.origin} sent no key`)
  return addEnvironment(ctx, { url: parsed.origin, key: body.key, name: input.name, kind: input.kind })
}

/** `POST /api/ticket` on the route's origin with the saved key. */
export async function mintTicket(ctx: HostContext, id: string, url: string): Promise<{ ticket: string; expiresIn: number }> {
  const row = readRow(ctx.store, id)
  if (!row) throw new HostError('unknown-environment', id)
  const route = row.routes.find((r) => r.url === url)
  if (!route) throw new HostError('unknown-route', `${url} is not a route of ${id}`)
  const origin = originOf(route)
  const response = await hostFetch(ctx, `${origin}/api/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${row.key}`, accept: 'application/json' }
  })
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    throw new HostError('unauthorized', `${origin} rejected the key for ${row.name}`)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new HostError('unavailable', `${origin} answered HTTP ${response.status}`)
  }
  const body = (await response.json().catch(() => null)) as { ticket?: unknown; expiresIn?: unknown } | null
  if (!body || typeof body.ticket !== 'string') throw new HostError('unavailable', `${origin} sent no ticket`)
  return { ticket: body.ticket, expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : 30_000 }
}
