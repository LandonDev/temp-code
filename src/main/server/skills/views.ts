import { sep } from 'node:path'
import type { SkillMeta } from '@shared/contract-skills'
import { SKILL_HARNESSES, viewDigest, viewDirName, visibleSkills, type SkillHarness } from '@shared/skills'
import { realSpelling } from '../remote/fence'

/**
 * Which skills each CLI gets, as the folders the materializer writes
 * (materialize.ts): one view per provider for every workspace, and one for
 * a workspace only when what its threads get differs from the global view.
 * Pure but for `workspaceForPath`, which reads real paths.
 */

export type { SkillHarness }

export interface ViewPlan {
  provider: SkillHarness
  /** viewDirName(workspaceId): 'global' or 'ws-<workspaceId>' */
  view: string
  workspaceId: string | null
  /** enabled, run by the provider, a workspace row shadowing the global one of its name; sorted by name */
  skills: SkillMeta[]
  viewDigest: string
}

const viewOf = (rows: readonly SkillMeta[], provider: SkillHarness, workspaceId: string | null): ViewPlan => {
  const skills = visibleSkills(rows, workspaceId, provider)
  return { provider, view: viewDirName(workspaceId), workspaceId, skills, viewDigest: viewDigest(skills) }
}

/** The view a `provider` thread in `workspaceId` reads: the workspace's own when its skills differ from the global view's, else the global view. */
export function planView(rows: readonly SkillMeta[], provider: SkillHarness, workspaceId: string | null): ViewPlan {
  const global = viewOf(rows, provider, null)
  if (workspaceId === null) return global
  const own = viewOf(rows, provider, workspaceId)
  return own.viewDigest === global.viewDigest ? global : own
}

/** Every view to write: each provider's global view, empty or not, and each workspace's that differs from it. */
export function planViews(rows: readonly SkillMeta[], workspaceIds: readonly string[]): ViewPlan[] {
  const out: ViewPlan[] = []
  for (const provider of SKILL_HARNESSES) {
    out.push(viewOf(rows, provider, null))
    for (const id of [...new Set(workspaceIds)].sort()) {
      const view = planView(rows, provider, id)
      if (view.workspaceId !== null) out.push(view)
    }
  }
  return out
}

/** The deepest workspace whose folder holds `cwd`, both read through their real paths; null when none does. */
export function workspaceForPath(workspaces: readonly { id: string; path: string }[], cwd: string): string | null {
  const real = realSpelling(cwd)
  let best: { id: string; depth: number } | null = null
  for (const ws of workspaces) {
    const root = realSpelling(ws.path).replace(/\/+$/, '') || '/'
    if (real !== root && !real.startsWith(root === '/' ? '/' : root + sep)) continue
    if (!best || root.length > best.depth) best = { id: ws.id, depth: root.length }
  }
  return best?.id ?? null
}
