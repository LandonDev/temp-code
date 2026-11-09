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

export interface ScopeFlipDeps {
  store: ScopeStore & { onChange(fn: () => void): () => void }
  sessions: ScopeSessions & { liveIds(): Set<string> }
  rebootAtNextTurn(sessionId: string): boolean
}

export function watchScopeFlips(deps: ScopeFlipDeps): () => void {
  const scopeOf = (s: SessionMeta): string | null => workspaceIdOf(deps.sessions, s)
  // The rows as they stood before each change: what every handle spawned since the last one saw.
  let before = deps.store.list()
  return deps.store.onChange(() => {
    const prev = before
    const was = { list: () => prev, status: () => ({}), tools: () => null }
    before = deps.store.list()
    for (const id of deps.sessions.liveIds()) {
      const s = deps.sessions.get(id)
      if (!s || !BRIDGED.has(s.provider)) continue
      const workspaceId = scopeOf(s)
      if (hasAddons(was, workspaceId) !== hasAddons(deps.store, workspaceId)) deps.rebootAtNextTurn(id)
    }
  })
}
