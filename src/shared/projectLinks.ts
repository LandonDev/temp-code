import { z } from 'zod'
import { nanoid } from 'nanoid'
import { AccountPinsSchema } from './contract-m3a'
import { ProjectModeSchema } from './domain'
import { ReviewSettingsSchema } from './review'
import { PlanSettingsSchema } from './plans'
import { BuildConfigSchema } from './build'
import { TurnPassSchema } from './turnpass'

/**
 * One project across hosts (CLAUDE.md "One project across hosts").
 *
 * A workspace row and a project row each carry a link id shared by their
 * copies on every host: `wl_…` for workspaces, `pl_…` for projects. The
 * linker (src/main/server/remote/projectLinks.ts) pairs rows by the pure
 * rules here and stamps the ids; nothing here touches a store or a socket.
 *
 * The rules, decided with the user on 2026-10-22:
 * - workspaces pair by GitHub repo (lowercase), else by folder name
 *   (lowercase); at most one copy per host, the oldest row when several
 *   share a key;
 * - projects pair inside paired workspaces by name (trimmed, lowercase),
 *   again the oldest per host;
 * - a side with an id gives it to the other; both set and different, the
 *   settings home's (the box's) wins; neither, mint;
 * - a link is never removed by the linker.
 */

export const newWorkspaceLinkId = (): string => `wl_${nanoid(12)}`
export const newProjectLinkId = (): string => `pl_${nanoid(12)}`

export interface LinkableWorkspace {
  id: string
  path: string
  githubRepo?: string | null
  linkId?: string | null
  createdAt: number
}

export interface LinkableProject {
  id: string
  workspaceId: string
  name: string
  linkId?: string | null
  createdAt: number
}

const strip = (path: string): string => path.replace(/\/+$/, '') || '/'
const basename = (path: string): string => strip(path).split('/').pop() ?? path

/** The key two workspaces share: the repo, else the folder name. */
export function workspaceMatchKey(ws: Pick<LinkableWorkspace, 'path' | 'githubRepo'>): string {
  const repo = ws.githubRepo?.trim().toLowerCase()
  return repo ? `repo:${repo}` : `name:${basename(ws.path).toLowerCase()}`
}

/** The key two projects of paired workspaces share. */
export const projectMatchKey = (name: string): string => name.trim().toLowerCase()

const older = <T extends { createdAt: number; id: string }>(a: T, b: T): T =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id) ? a : b

/** One row per key: the oldest when several share it. */
function oldestByKey<T extends { createdAt: number; id: string }>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T> {
  const out = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    const have = out.get(key)
    out.set(key, have ? older(have, row) : row)
  }
  return out
}

export interface Pair<T> {
  local: T
  peer: T
}

/** The workspace pairs between this host's rows and a peer's. */
export function matchWorkspaces(local: readonly LinkableWorkspace[], peer: readonly LinkableWorkspace[]): Pair<LinkableWorkspace>[] {
  const mine = oldestByKey(local, workspaceMatchKey)
  const theirs = oldestByKey(peer, workspaceMatchKey)
  const out: Pair<LinkableWorkspace>[] = []
  for (const [key, l] of mine) {
    const p = theirs.get(key)
    if (p) out.push({ local: l, peer: p })
  }
  return out
}

/** The project pairs inside paired workspaces, by name. */
export function matchProjects(
  workspacePairs: readonly Pair<LinkableWorkspace>[],
  local: readonly LinkableProject[],
  peer: readonly LinkableProject[]
): Pair<LinkableProject>[] {
  const out: Pair<LinkableProject>[] = []
  for (const ws of workspacePairs) {
    const mine = oldestByKey(
      local.filter((p) => p.workspaceId === ws.local.id),
      (p) => projectMatchKey(p.name)
    )
    const theirs = oldestByKey(
      peer.filter((p) => p.workspaceId === ws.peer.id),
      (p) => projectMatchKey(p.name)
    )
    for (const [key, l] of mine) {
      const p = theirs.get(key)
      if (p) out.push({ local: l, peer: p })
    }
  }
  return out
}

export interface LinkDecision {
  /** the id both copies carry after the decision */
  linkId: string
  /** stamp this host's row */
  local: boolean
  /** stamp the peer's row */
  peer: boolean
}

/**
 * What a pair should carry: one side's id adopted by the other, the home's
 * on a conflict (`peerIsHome`: the peer is the settings home), a fresh id
 * when neither has one. Equal ids decide nothing.
 */
export function decideLink(
  local: string | null | undefined,
  peer: string | null | undefined,
  peerIsHome: boolean,
  mint: () => string
): LinkDecision | null {
  const l = local || null
  const p = peer || null
  if (l && p) {
    if (l === p) return null
    return peerIsHome ? { linkId: p, local: true, peer: false } : { linkId: l, local: false, peer: true }
  }
  if (l) return { linkId: l, local: false, peer: true }
  if (p) return { linkId: p, local: true, peer: false }
  return { linkId: mint(), local: true, peer: true }
}

/**
 * The settings home of a link: the copy on the box, which is the host whose
 * platform is not darwin; two copies of one platform, the host whose id
 * sorts first. `platformOf` answers a host's hello `build.platform`
 * (undefined until heard: counted as not darwin, since only a Mac says so).
 */
export function settingsHomeOf(
  copies: readonly { environmentId: string }[],
  platformOf: (environmentId: string) => string | undefined
): string | null {
  if (copies.length === 0) return null
  const ids = [...new Set(copies.map((c) => c.environmentId))].sort()
  const boxes = ids.filter((id) => platformOf(id) !== 'darwin')
  return (boxes.length ? boxes : ids)[0]
}

// ── the wire shapes the link rides on ───────────────────────────────────

/** The caller's project, as a cross-host start carries it (contract-crosshost.ts). */
export const ProjectLinkFactsSchema = z.object({
  linkId: z.string().min(1).max(64),
  workspaceLinkId: z.string().min(1).max(64),
  name: z.string().min(1).max(300),
  branch: z.string().max(300).nullable(),
  mode: ProjectModeSchema,
  /** the caller's workspace folder (its host's path) */
  workspacePath: z.string().max(2_000),
  /** the caller's project cwd (its host's path) */
  cwd: z.string().max(2_000),
  /** the caller's workspace repo (owner/name), so a host whose folder sits elsewhere still finds it */
  workspaceGithubRepo: z.string().max(300).optional()
})
export type ProjectLinkFacts = z.infer<typeof ProjectLinkFactsSchema>

/** `project.ensureLinked`: find or create this host's copy of a linked project. */
export const EnsureLinkedArgsSchema = z.object({
  projectLinkId: z.string().min(1).max(64),
  workspaceLinkId: z.string().min(1).max(64),
  name: z.string().min(1).max(300),
  branch: z.string().max(300).nullable(),
  mode: ProjectModeSchema,
  /** the caller's workspace folder, mapped onto this host when no copy is linked yet */
  callerWorkspacePath: z.string().max(2_000),
  /** the caller's project cwd on its host */
  callerProjectCwd: z.string().max(2_000),
  /** the caller's work root, so `<root>/<name>` maps onto this host's */
  callerWorkRoot: z.string().max(2_000).optional(),
  /** the caller's workspace repo (owner/name): the last way to find the workspace here */
  workspaceGithubRepo: z.string().max(300).optional(),
  /** answer what would happen without creating anything */
  dryRun: z.boolean().optional()
})
export type EnsureLinkedArgs = z.infer<typeof EnsureLinkedArgsSchema>

/** `catalog.link`: the linker stamping a peer's rows. */
export const CatalogLinkArgsSchema = z.object({
  workspaces: z.array(z.object({ id: z.string().min(1), linkId: z.string().min(1).max(64) })).max(500),
  projects: z.array(z.object({ id: z.string().min(1), linkId: z.string().min(1).max(64) })).max(2_000)
})
export type CatalogLinkArgs = z.infer<typeof CatalogLinkArgsSchema>

/** Everything a project's settings home holds for it: what `project.settings.get` answers and `.set` writes whole. */
export const ProjectSettingsBundleSchema = z.object({
  name: z.string(),
  archived: z.boolean(),
  preamble: z.string().nullable(),
  preambleEnabled: z.boolean(),
  accountPins: AccountPinsSchema,
  review: ReviewSettingsSchema.nullable(),
  plans: PlanSettingsSchema.nullable(),
  build: BuildConfigSchema.nullable(),
  turnPass: TurnPassSchema.nullable(),
  /** when a setting of the project last changed on its home (ms); null when never */
  updatedAt: z.number().int().nullable()
})
export type ProjectSettingsBundle = z.infer<typeof ProjectSettingsBundleSchema>
