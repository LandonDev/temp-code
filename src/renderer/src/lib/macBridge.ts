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
 *    this window can answer: the method is local-only on the server.
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

/** Requests for one box thread, oldest first. */
export function useMacBridgeRequests(environmentId: string, sessionId: string): MacBridgeRequest[] {
  const requests = useStore(store, (s) => s.requests)
  return Object.values(requests)
    .filter((r) => r.environmentId === environmentId && r.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function useAllMacBridgeRequests(): MacBridgeRequest[] {
  const requests = useStore(store, (s) => s.requests)
  return Object.values(requests).sort((a, b) => a.createdAt - b.createdAt)
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
