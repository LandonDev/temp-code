import type { SessionMeta } from '@shared/events'
import { hasAddons, workspaceIdOf, type ScopeSessions, type ScopeStore } from './scope'

/**
 * The bridge lists addon_find and addon_call only when the thread's scope
 * held an enabled add-on at spawn (TEMP_CODE_ADDONS, apptools.ts
 * bridgeMcpConfig). A scope that gains its first or loses its last marks
 * every live codex and Muse handle in it to reboot at its next turn start,
 * so the fresh harness lists the right tools. Claude threads follow live
 * (exposure.ts) and are never marked.
 */

const BRIDGED = new Set(['codex', 'muse'])
const keyOf = (workspaceId: string | null): string => workspaceId ?? ''

export interface ScopeFlipDeps {
  store: ScopeStore & { onChange(fn: () => void): () => void }
  sessions: ScopeSessions & { liveIds(): Set<string> }
  rebootAtNextTurn(sessionId: string): boolean
}

export function watchScopeFlips(deps: ScopeFlipDeps): () => void {
  const had = new Map<string, boolean>()
  const scopeOf = (s: SessionMeta): string | null => workspaceIdOf(deps.sessions, s)
  const known = (workspaceId: string | null): boolean => {
    const key = keyOf(workspaceId)
    if (!had.has(key)) had.set(key, hasAddons(deps.store, workspaceId))
    return had.get(key)!
  }
  // What every live bridged thread's scope holds now, before anything changes.
  for (const id of deps.sessions.liveIds()) {
    const s = deps.sessions.get(id)
    if (s && BRIDGED.has(s.provider)) known(scopeOf(s))
  }
  return deps.store.onChange(() => {
    const now = new Map<string, boolean>()
    for (const id of deps.sessions.liveIds()) {
      const s = deps.sessions.get(id)
      if (!s || !BRIDGED.has(s.provider)) continue
      const workspaceId = scopeOf(s)
      const key = keyOf(workspaceId)
      const before = known(workspaceId)
      if (!now.has(key)) now.set(key, hasAddons(deps.store, workspaceId))
      if (now.get(key) !== before) deps.rebootAtNextTurn(id)
    }
    for (const key of had.keys()) had.set(key, now.get(key) ?? hasAddons(deps.store, key === '' ? null : key))
  })
}
