import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type {
  MacBridgeHostPolicy,
  MacBridgeRequest,
  MacBridgeThreadState
} from '@server/shared/contract-macbridge'
import type { MacDecideRemember } from '@server/shared/contract-macbridge-rules'
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, registry } from './connection/registry'
import { isWebMode } from './nativeWeb'

/**
 * The Mac bridge in the renderer (docs/box.md "The Mac bridge"). Two sides:
 *
 *  - This Mac's own server pushes `macBridge.request` when a box thread
 *    wants a path outside what this Mac shares, or any command; the cards
 *    (MacBridgeCards) answer with `macBridge.decide` on the LOCAL link. Only
 *    this window can answer: the method is local-only on the server. A
 *    request marked `quiet` (admitted without a prompt while the host's
 *    "Show running commands" is off) never reaches a card: it is listed, with
 *    Stop, in Settings → Remote access → Mac bridge only (useMacBridgeRunning).
 *  - The cards never fill the screen: `queueOf` keeps one waiting card per
 *    host (the oldest, decided first) with a count of the rest, and folds
 *    the running ones into one line per host with Stop all.
 *  - A box thread's switch (`macBridge.thread.get/set`) lives on the box and
 *    is reached over the thread's own link; "on" names this Mac's real
 *    environment id.
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
}

const store = createStore<State>(() => ({ requests: {}, threads: {}, hosts: [], localId: null }))
export const macBridgeStore = store

const local = () => registry.link(LOCAL_ENVIRONMENT_ID)

async function loadLocal(): Promise<void> {
  const link = local()
  if (!link?.connected) return
  try {
    const [pending, hosts, status] = await Promise.all([
      link.request<MacBridgeRequest[]>('macBridge.pending', {}),
      link.request<MacBridgeHostPolicy[]>('macBridge.policy.get', {}),
      link.request<{ environmentId: string }>('remote.status', {})
    ])
    store.setState({
      requests: Object.fromEntries(pending.map((r) => [r.id, r])),
      hosts,
      localId: status.environmentId
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

/** Stop every running command in a list (a running request's decide false is Stop); one failure does not stop the rest. */
export async function stopMacBridgeAll(requests: MacBridgeRequest[]): Promise<void> {
  const results = await Promise.allSettled(
    requests.filter((r) => r.status === 'running').map((r) => decideMacBridge(r.id, false))
  )
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
}

const byAge = (a: MacBridgeRequest, b: MacBridgeRequest): number => a.createdAt - b.createdAt

/** Requests that get a card: never a quiet one. */
export const shownRequests = (requests: Iterable<MacBridgeRequest>): MacBridgeRequest[] =>
  [...requests].filter((r) => !r.quiet).sort(byAge)

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

/** Every command running on this Mac for a host or a thread, quiet ones included, oldest first (the Remote access pane, the thread's Mac approvals dialog). */
export function useMacBridgeRunning(match: {
  environmentId?: string
  sessionId?: string
}): MacBridgeRequest[] {
  const requests = useStore(store, (s) => s.requests)
  return Object.values(requests)
    .filter(
      (r) =>
        r.status === 'running' &&
        (match.environmentId === undefined || r.environmentId === match.environmentId) &&
        (match.sessionId === undefined || r.sessionId === match.sessionId)
    )
    .sort(byAge)
}

/** One host's running commands, folded into a line. */
export interface MacBridgeRunningGroup {
  environmentId: string
  hostName: string
  requests: MacBridgeRequest[]
}

/** What the cards draw: one waiting card per host and a count of the rest; the running ones one line per host. */
export interface MacBridgeQueue {
  /** The oldest waiting request of each host, in age order: decided first. */
  pending: MacBridgeRequest[]
  /** Waiting beyond the card, by environment id (absent when none). */
  more: Record<string, number>
  running: MacBridgeRunningGroup[]
}

/**
 * The cap on the cards (docs/box.md "The Mac bridge"): from the requests of
 * one thread, or of every thread off screen, at most one waiting card per
 * host (the oldest; the next shows once it is decided) with "and N more",
 * and the running commands folded into one line per host with Stop all.
 * Quiet requests are left out first: they never reach a card.
 */
export function queueOf(requests: Iterable<MacBridgeRequest>): MacBridgeQueue {
  const shown = shownRequests(requests)
  const pending: MacBridgeRequest[] = []
  const more: Record<string, number> = {}
  const running = new Map<string, MacBridgeRunningGroup>()
  for (const r of shown) {
    if (r.status === 'running') {
      const group = running.get(r.environmentId) ?? {
        environmentId: r.environmentId,
        hostName: r.hostName,
        requests: []
      }
      group.requests.push(r)
      running.set(r.environmentId, group)
    } else if (pending.some((p) => p.environmentId === r.environmentId)) {
      more[r.environmentId] = (more[r.environmentId] ?? 0) + 1
    } else {
      pending.push(r)
    }
  }
  return { pending, more, running: [...running.values()] }
}

// ── the policy (Settings → Remote access) ────────────────────────────

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

/** Whether commands admitted without a prompt show as running cards (off by default under full access). */
export async function setMacBridgeShowRunning(environmentId: string, show: boolean): Promise<void> {
  const hosts = await local()!.request<MacBridgeHostPolicy[]>('macBridge.showRunning.set', {
    environmentId,
    show
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
