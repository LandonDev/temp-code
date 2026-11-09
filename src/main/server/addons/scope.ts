import { visibleRows } from '@shared/addons'
import type { AddonRow, AddonStatus, AddonTool } from '@shared/contract-addons'
import type { ProjectMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'

/**
 * Which add-ons a thread sees (plan section 7): its root's workspace (the
 * project's, else the thread's own), every global row plus that
 * workspace's, a workspace row shadowing the global one of its name.
 */

export interface ScopeSessions {
  get(id: string): SessionMeta | null
  getProject(id: string): ProjectMeta | null
}

export interface ScopeStore {
  list(): AddonRow[]
  status(): Record<string, AddonStatus>
  tools(id: string): { tools: AddonTool[] } | null
}

/** The workspace a thread's add-ons come from: its root's project's, else the root's own. */
export function workspaceIdOf(sessions: ScopeSessions, session: SessionMeta): string | null {
  let root = session
  for (let i = 0; root.parentId && i < 32; i++) {
    const parent = sessions.get(root.parentId)
    if (!parent) break
    root = parent
  }
  return (root.projectId ? sessions.getProject(root.projectId)?.workspaceId : null) ?? root.workspaceId ?? null
}

/** The visible rows, disabled ones included (a disabled workspace row still shadows its global namesake). */
export const visibleAddons = (store: ScopeStore, workspaceId: string | null): AddonRow[] => visibleRows(store.list(), workspaceId)

/** Whether the scope holds an enabled add-on: the bridge lists addon_find and addon_call only then. */
export const hasAddons = (store: ScopeStore, workspaceId: string | null): boolean => visibleAddons(store, workspaceId).some((r) => r.enabled)

export interface VisibleTool {
  row: AddonRow
  tool: AddonTool
}

/** Each visible, enabled, ready add-on's tools as this host last listed them. */
export function visibleTools(store: ScopeStore, workspaceId: string | null): VisibleTool[] {
  const status = store.status()
  const out: VisibleTool[] = []
  for (const row of visibleAddons(store, workspaceId)) {
    if (!row.enabled || status[row.id]?.state !== 'ready') continue
    for (const tool of store.tools(row.id)?.tools ?? []) out.push({ row, tool })
  }
  return out
}
