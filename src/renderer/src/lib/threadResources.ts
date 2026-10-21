import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ThreadResource, ThreadResourceKind, ThreadResourceRemoval } from '@server/shared/contract-resources'
import { registry } from './connection/registry'
import type { EnvLink } from './connection/link'
import { macBridgeStore } from './macBridge'
import { sessionStore } from './tcserver/store'

/**
 * Thread resources in the renderer (docs/box.md "Thread resources"): the
 * ledger of what a thread created (worktrees, simulators, dev instances) on
 * its host or on the Mac, read over the thread's own link (`resources.list`)
 * and kept current by the host's `resources` push. The panel in the thread
 * header menu removes one row at a time (`resources.remove`); archiving
 * with the box checked passes `removeResources` to `session.archive`, so
 * the host removes them after the archive lands. `archiveThread` is the one
 * call every archive flow (the menu, the fleet's Archive done) goes through.
 */

type State = { bySession: Record<string, ThreadResource[]> }
const store = createStore<State>(() => ({ bySession: {} }))
export const threadResourcesStore = store

const linkOf = (sessionId: string) => sessionStore.linkFor(sessionId)

export async function loadThreadResources(sessionId: string): Promise<ThreadResource[]> {
  const link = linkOf(sessionId)
  if (!link?.connected) return store.getState().bySession[sessionId] ?? []
  try {
    const { resources } = await link.request<{ resources: ThreadResource[] }>('resources.list', { sessionId, includeRemoved: true })
    store.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: resources } }))
    return resources
  } catch {
    return store.getState().bySession[sessionId] ?? [] // an older host without the method
  }
}

/** The thread's live (unremoved) rows, as last read or pushed. */
export function useThreadResources(sessionId: string | null | undefined): ThreadResource[] {
  return useStore(store, (s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY) : EMPTY)).filter((r) => !r.removedAt)
}
const EMPTY: ThreadResource[] = []

export function liveResources(sessionId: string): ThreadResource[] {
  return (store.getState().bySession[sessionId] ?? EMPTY).filter((r) => !r.removedAt)
}

/** Remove one row (or every live row) on its host; the push brings the outcome back. */
export async function removeThreadResources(sessionId: string, ids?: string[]): Promise<ThreadResourceRemoval[]> {
  const link = linkOf(sessionId)
  if (!link) throw new Error(`unknown session: ${sessionId}`)
  const { results } = await link.request<{ results: ThreadResourceRemoval[] }>('resources.remove', { sessionId, ...(ids ? { ids } : {}) })
  return results
}

/** Archive a thread, removing its resources on their hosts when asked: the one archive call. */
export async function archiveThread(sessionId: string, opts: { removeResources?: boolean } = {}): Promise<void> {
  const link = linkOf(sessionId)
  if (sessionStore.isDraft(sessionId)) return
  if (!link) throw new Error(`unknown session: ${sessionId}`)
  await link.request('session.archive', { sessionId, archived: true, ...(opts.removeResources ? { removeResources: true } : {}) })
}

let started = false
/** Hear every host's `resources` push; idempotent. */
export function startThreadResources(): void {
  if (started) return
  started = true
  const attach = (link: EnvLink): void => {
    link.onPush((push) => {
      if (push.push !== 'resources') return
      store.setState((s) => ({ bySession: { ...s.bySession, [push.sessionId]: push.resources } }))
    })
  }
  for (const link of registry.links()) attach(link)
  registry.onLink((link, event) => {
    if (event === 'added') attach(link)
  })
}

// ── words ──────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<ThreadResourceKind, string> = {
  worktree: 'worktree',
  simulator: 'simulator',
  devInstance: 'dev instance'
}

/** The host a resource lives on, by name: "this Mac" for this machine, the saved host's name otherwise. */
export function hostName(environmentId: string): string {
  if (environmentId === macBridgeStore.getState().localId) return 'this Mac'
  return registry.environment(environmentId)?.name ?? environmentId.replace(/^env_/, '').slice(0, 6)
}

/** The clause after "Archive": "and remove 2 resources on the Mac", "and remove 3 resources on the Mac and the box". */
export function removalClause(rows: readonly ThreadResource[], nameOf: (id: string) => string = hostName): string {
  const n = rows.length
  if (n === 0) return ''
  const hosts = [...new Set(rows.map((r) => r.environmentId))].map(nameOf)
  const where = hosts.length === 1 ? hosts[0] : `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`
  return `and remove ${n} resource${n === 1 ? '' : 's'} on ${where}`
}

/** One row's state word, when it has one: waiting on an offline host, or a note from the last attempt. */
export function rowState(row: ThreadResource): string | null {
  if (row.removedAt) return row.note ?? 'removed'
  if (row.removeRequestedAt) return row.note ?? 'removing…'
  return row.note
}
