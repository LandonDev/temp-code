import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type {
  MacBridgeHostPolicy,
  MacBridgeLoad,
  MacBridgeRequest,
  MacBridgeThreadState
} from '@server/shared/contract-macbridge'
export { heldFacts, heldLine, heldParts } from '@server/shared/contract-macbridge'
import type { MacDecideRemember } from '@server/shared/contract-macbridge-rules'
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, registry } from './connection/registry'
import { isWebMode } from './nativeWeb'

/**
 * The Mac bridge in the renderer (docs/box.md "The Mac bridge"). Two sides:
 *
 *  - This Mac's own server pushes `macBridge.request` when a box thread
 *    wants a path outside what this Mac shares, or any command; the cards
 *    (MacBridgeCards) answer with `macBridge.decide` on the LOCAL link. Only
 *    this window can answer: the method is local-only on the server. Only a
 *    request that waits for a decision is a card; once running, a call is a
 *    row of the thread's Activity section (lib/activity.ts) and of the host's
 *    Mac bridge list on Settings → Hosts, with Stop (useMacBridgeRunning).
 *  - The cards never fill the screen: `queueOf` keeps one waiting card per
 *    host (the oldest, decided first) with a count of the rest.
 *  - A held request (allowed, waiting its turn on the load guard; docs/box.md
 *    "The load guard") is never a card either: it is a row in the same lists
 *    as the running ones, with its place ("Waiting for the Mac · load 12.3 of
 *    8 · 3rd in line") and Stop, which takes it out of the line.
 *  - A box thread's switch (`macBridge.thread.get/set`) lives on the box and
 *    is reached over the thread's own link; "on" names this Mac's real
 *    environment id.
 *  - A paused box thread holds its commands, jobs and writes on the box
 *    (macPause.ts); the box lists them here as requests with status
 *    `paused`: rows of the running lists with "Paused" where Stop would be,
 *    never a card. The box's own `macBridge.held` push (on the thread's
 *    link) carries how many a root's tree holds, for the paused strip.
 */

type State = {
  /** Requests waiting (or commands running), keyed by id. */
  requests: Record<string, MacBridgeRequest>
  /** A box thread's switch, by session id, as last read. */
  threads: Record<string, MacBridgeThreadState>
  /** This Mac's policy per saved host, as last read. */
  hosts: MacBridgeHostPolicy[]
  /** This Mac's real environment id (the local link answers "local" by alias). */
  localId: string | null
  /** The Mac's load as the guard last sampled it (macBridge.load.get), once read. */
  load: MacBridgeLoad | null
  /** Mac calls a paused root thread's tree holds on its host, by root session id (0 rows are dropped). */
  held: Record<string, number>
}

const store = createStore<State>(() => ({
  requests: {},
  threads: {},
  hosts: [],
  localId: null,
  load: null,
  held: {}
}))
export const macBridgeStore = store

const local = () => registry.link(LOCAL_ENVIRONMENT_ID)

async function loadLocal(): Promise<void> {
  const link = local()
  if (!link?.connected) return
  try {
    const [pending, hosts, status, load] = await Promise.all([
      link.request<MacBridgeRequest[]>('macBridge.pending', {}),
      link.request<MacBridgeHostPolicy[]>('macBridge.policy.get', {}),
      link.request<{ environmentId: string }>('remote.status', {}),
      link.request<MacBridgeLoad>('macBridge.load.get', {}).catch(() => null)
    ])
    store.setState({
      requests: Object.fromEntries(pending.map((r) => [r.id, r])),
      hosts,
      localId: status.environmentId,
      load
    })
  } catch {
    // An older server without the bridge: nothing to show.
  }
}

let started = false
/** Listen on the local link (desktop only); idempotent. */
export function startMacBridge(): void {
  if (started || isWebMode()) return
  started = true
  const attach = (link: NonNullable<ReturnType<typeof local>>) => {
    link.onOpen(() => void loadLocal())
    link.onPush((push) => {
      if (push.push === 'macBridge.request') {
        store.setState((s) => ({ requests: { ...s.requests, [push.request.id]: push.request } }))
      } else if (push.push === 'macBridge.resolved') {
        store.setState((s) => {
          if (!s.requests[push.id]) return s
          const rest = { ...s.requests }
          delete rest[push.id]
          return { requests: rest }
        })
      }
    })
    if (link.connected) void loadLocal()
  }
  const now = local()
  if (now) attach(now)
  else
    registry.onLink((link, event) => {
      if (event === 'added' && link.environmentId === LOCAL_ENVIRONMENT_ID)
        attach(link as NonNullable<ReturnType<typeof local>>)
    })
  startHeldCounts()
}

let heldStarted = false
/** Every link (a box thread's host sends its own count): `macBridge.held` lands by session id. */
function startHeldCounts(): void {
  if (heldStarted) return
  heldStarted = true
  registry.onLink((link, event) => {
    if (event !== 'added') return
    link.onPush((push) => {
      if (push.push === 'macBridge.held') setHeld(push.sessionId, push.held)
    })
  })
}

function setHeld(sessionId: string, held: number): void {
  store.setState((s) => {
    if ((s.held[sessionId] ?? 0) === held) return s
    const next = { ...s.held }
    if (held > 0) next[sessionId] = held
    else delete next[sessionId]
    return { held: next }
  })
}

/** How many Mac calls the given root threads hold between them while paused (macPause.ts on their host). */
export function useMacHeldTotal(sessionIds: readonly string[]): number {
  const held = useStore(store, (s) => s.held)
  return heldTotal(held, sessionIds)
}

export const heldTotal = (held: Record<string, number>, sessionIds: readonly string[]): number =>
  sessionIds.reduce((n, id) => n + (held[id] ?? 0), 0)

/** The paused strip's suffix: "Build is paused" + heldSuffix(2) → "…, and 2 Mac jobs with it". */
export function heldSuffix(held: number): string {
  if (held <= 0) return ''
  return `, and ${held} Mac ${held === 1 ? 'job' : 'jobs'} with it`
}

export function decideMacBridge(
  id: string,
  allow: boolean,
  remember: MacDecideRemember = false
): Promise<unknown> {
  const link = local()
  if (!link) return Promise.reject(new Error('not connected'))
  return link.request('macBridge.decide', { id, allow, remember })
}

/** Stop every running and held command in a list (decide false is Stop, or leaves the line); one failure does not stop the rest. */
export async function stopMacBridgeAll(requests: MacBridgeRequest[]): Promise<void> {
  const results = await Promise.allSettled(
    requests.filter((r) => r.status !== 'pending').map((r) => decideMacBridge(r.id, false))
  )
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
}

const byAge = (a: MacBridgeRequest, b: MacBridgeRequest): number => a.createdAt - b.createdAt

/** Requests that get a card: those waiting for a decision. Running, held and paused calls are rows of the Activity section and the Hosts page, never cards. */
export const shownRequests = (requests: Iterable<MacBridgeRequest>): MacBridgeRequest[] =>
  [...requests].filter((r) => r.status === 'pending' && !r.quiet).sort(byAge)

/**
 * Every command running on this Mac, or allowed and waiting its turn, for a
 * host or a thread, quiet ones included: the running ones first, oldest
 * first, then the held ones in line order, then the calls a paused thread
 * holds on its host (status `paused`, nothing to stop here), oldest first
 * (the host's Mac bridge on Settings → Hosts, the thread's Mac approvals dialog).
 */
export function inFlightRequests(
  requests: Iterable<MacBridgeRequest>,
  match: { environmentId?: string; sessionId?: string } = {}
): MacBridgeRequest[] {
  const mine = [...requests].filter(
    (r) =>
      (r.status === 'running' || r.status === 'held' || r.status === 'paused') &&
      (match.environmentId === undefined || r.environmentId === match.environmentId) &&
      (match.sessionId === undefined || r.sessionId === match.sessionId)
  )
  const running = mine.filter((r) => r.status === 'running').sort(byAge)
  const held = mine
    .filter((r) => r.status === 'held')
    .sort((a, b) => (a.held?.position ?? 0) - (b.held?.position ?? 0) || byAge(a, b))
  const paused = mine.filter((r) => r.status === 'paused').sort(byAge)
  return [...running, ...held, ...paused]
}

/** Requests of one box thread that get a card, oldest first. */
export function useMacBridgeRequests(environmentId: string, sessionId: string): MacBridgeRequest[] {
  const requests = useStore(store, (s) => s.requests)
  return shownRequests(Object.values(requests)).filter(
    (r) => r.environmentId === environmentId && r.sessionId === sessionId
  )
}

/** Every request that gets a card, oldest first. */
export function useAllMacBridgeRequests(): MacBridgeRequest[] {
  const requests = useStore(store, (s) => s.requests)
  return shownRequests(Object.values(requests))
}

/** Every command running on this Mac, or held for its turn, for a host or a thread, quiet ones included (inFlightRequests). */
export function useMacBridgeRunning(match: {
  environmentId?: string
  sessionId?: string
}): MacBridgeRequest[] {
  const requests = useStore(store, (s) => s.requests)
  return inFlightRequests(Object.values(requests), match)
}

/** What the cards draw: one waiting card per host and a count of the rest. */
export interface MacBridgeQueue {
  /** The oldest waiting request of each host, in age order: decided first. */
  pending: MacBridgeRequest[]
  /** Waiting beyond the card, by environment id (absent when none). */
  more: Record<string, number>
}

/**
 * The cap on the cards (docs/box.md "The Mac bridge"): from the requests of
 * one thread, or of every thread off screen, at most one waiting card per
 * host (the oldest; the next shows once it is decided) with "and N more".
 */
export function queueOf(requests: Iterable<MacBridgeRequest>): MacBridgeQueue {
  const pending: MacBridgeRequest[] = []
  const more: Record<string, number> = {}
  for (const r of shownRequests(requests)) {
    if (pending.some((p) => p.environmentId === r.environmentId)) more[r.environmentId] = (more[r.environmentId] ?? 0) + 1
    else pending.push(r)
  }
  return { pending, more }
}

// ── the policy (Settings → Hosts) ────────────────────────────

export async function refreshMacBridgeHosts(): Promise<MacBridgeHostPolicy[]> {
  const link = local()
  if (!link) return []
  const hosts = await link.request<MacBridgeHostPolicy[]>('macBridge.policy.get', {})
  store.setState({ hosts })
  return hosts
}

export async function setMacBridgePolicy(
  environmentId: string,
  policy: MacBridgeHostPolicy['policy']
): Promise<void> {
  const hosts = await local()!.request<MacBridgeHostPolicy[]>('macBridge.policy.set', {
    environmentId,
    policy
  })
  store.setState({ hosts })
}

export async function setMacBridgeShared(environmentId: string, folders: string[]): Promise<void> {
  const hosts = await local()!.request<MacBridgeHostPolicy[]>('macBridge.shared.set', {
    environmentId,
    folders
  })
  store.setState({ hosts })
}

export function useMacBridgeHosts(): MacBridgeHostPolicy[] {
  return useStore(store, (s) => s.hosts)
}

// ── the load guard (docs/box.md "The load guard") ──────────────────────

/** A host's caps on concurrent commands and jobs, and on Mac-local threads; null puts one back to its default. */
export async function setMacBridgeLimits(
  environmentId: string,
  limits: { maxRunning?: number | null; maxThreads?: number | null }
): Promise<void> {
  const hosts = await local()!.request<MacBridgeHostPolicy[]>('macBridge.limits.set', {
    environmentId,
    ...limits
  })
  store.setState({ hosts })
}

export async function refreshMacBridgeLoad(): Promise<MacBridgeLoad | null> {
  const link = local()
  if (!link) return null
  const load = await link.request<MacBridgeLoad>('macBridge.load.get', {})
  store.setState({ load })
  return load
}

/** The one-minute load over which new commands and jobs wait; null follows the cores again (2 × cores). */
export async function setMacBridgeLoadLimit(limit: number | null): Promise<void> {
  const load = await local()!.request<MacBridgeLoad>('macBridge.loadLimit.set', { limit })
  store.setState({ load })
}

export function useMacBridgeLoad(): MacBridgeLoad | null {
  return useStore(store, (s) => s.load)
}

// ── a box thread's switch ─────────────────────────────────────────────

/** Whether a thread runs on another host this Mac could bridge to. */
export function bridgeableEnvironment(environmentId: string | undefined): boolean {
  return (
    !!environmentId &&
    environmentId !== LOCAL_ENVIRONMENT_ID &&
    environmentId !== WEB_ENVIRONMENT_ID &&
    !isWebMode()
  )
}

export async function loadThreadBridge(
  environmentId: string,
  sessionId: string
): Promise<MacBridgeThreadState | null> {
  if (!bridgeableEnvironment(environmentId)) return null
  try {
    const state = await registry
      .linkOf(environmentId)
      .request<MacBridgeThreadState>('macBridge.thread.get', { sessionId })
    store.setState((s) => ({ threads: { ...s.threads, [sessionId]: state } }))
    if (state.held !== undefined) setHeld(sessionId, state.held)
    return state
  } catch {
    return null // an older host, or a key without the method
  }
}

export async function setThreadBridge(
  environmentId: string,
  sessionId: string,
  on: boolean
): Promise<MacBridgeThreadState> {
  if (on && !store.getState().localId) await loadLocal()
  const macPeer = on ? store.getState().localId : null
  if (on && !macPeer) throw new Error("this Mac's environment id is not known yet")
  const state = await registry
    .linkOf(environmentId)
    .request<MacBridgeThreadState>('macBridge.thread.set', { sessionId, macPeer })
  store.setState((s) => ({ threads: { ...s.threads, [sessionId]: state } }))
  return state
}

export function useThreadBridge(sessionId: string | null | undefined): MacBridgeThreadState | null {
  return useStore(store, (s) => (sessionId ? (s.threads[sessionId] ?? null) : null))
}

/**
 * A thread this Mac just created on a host: the bridge comes on with it when
 * this Mac's policy for that host is not off. Awaited before the first send
 * so the first spawn already carries the tools; never fails the create.
 */
export async function bridgeNewThread(environmentId: string, sessionId: string): Promise<void> {
  if (!bridgeableEnvironment(environmentId)) return
  try {
    const hosts = store.getState().hosts.length
      ? store.getState().hosts
      : await refreshMacBridgeHosts()
    const policy = hosts.find((h) => h.environmentId === environmentId)?.policy ?? 'off'
    if (policy === 'off') return
    await setThreadBridge(environmentId, sessionId, true)
  } catch {
    // An older host: the thread runs without the bridge.
  }
}

/** argv as a shell would need it typed: what the person is agreeing to, exactly. */
export function quoteArgv(argv: string[]): string {
  return argv
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ')
}
