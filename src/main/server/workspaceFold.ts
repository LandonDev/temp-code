import { realpathSync } from 'node:fs'
import type { WorkspaceMeta } from '@shared/domain'
import type { Store } from './db'

export const WORKSPACE_FOLD_KEY = 'workspaces-folded:v1'

export function stripWorkspaceTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, '') || (path.startsWith('/') ? '/' : path)
}

/** Missing folders still match by spelling, without trailing slashes. */
export function workspacePathKey(path: string): string {
  if (!path) return path
  try {
    return stripWorkspaceTrailingSlashes(realpathSync(path))
  } catch {
    return stripWorkspaceTrailingSlashes(path)
  }
}

/** Pure grouping rule; callers supply paths that are already normalized.
 *  The oldest row leads each group; equal dates keep input order. */
export function groupWorkspaceDuplicates(workspaces: readonly WorkspaceMeta[]): WorkspaceMeta[][] {
  const groups = new Map<string, WorkspaceMeta[]>()
  for (const workspace of [...workspaces].sort((a, b) => a.createdAt - b.createdAt)) {
    const group = groups.get(workspace.path) ?? []
    group.push(workspace)
    groups.set(workspace.path, group)
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

/** One boot pass per host database. Each merge moves references and deletes
 *  duplicates in one transaction; a failed pass can resume without its marker. */
export function foldWorkspaces(
  store: Pick<Store, 'getSetting' | 'setSetting' | 'listWorkspaces' | 'mergeWorkspaceRows'>
): { removed: number; projectsMoved: boolean } {
  const result = { removed: 0, projectsMoved: false }
  if (store.getSetting(WORKSPACE_FOLD_KEY) !== null) return result
  const groups = groupWorkspaceDuplicates(
    store.listWorkspaces().map((workspace) => ({
      ...workspace,
      path: workspacePathKey(workspace.path)
    }))
  )
  for (const [keeper, ...others] of groups) {
    const linkId = keeper.linkId ?? others.find((workspace) => workspace.linkId)?.linkId ?? null
    const moved = store.mergeWorkspaceRows(
      keeper.id,
      others.map((workspace) => workspace.id),
      linkId
    )
    result.removed += others.length
    result.projectsMoved ||= moved
  }
  store.setSetting(WORKSPACE_FOLD_KEY, String(Date.now()))
  return result
}
