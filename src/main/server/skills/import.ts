import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { Writer } from '@shared/addons'
import type { SkillFile, SkillInput, SkillMeta } from '@shared/contract-skills'
import { SKILL_HARNESSES, SKILL_MD, SKILL_NAME_RE, skillDigest, skillProblem, type SkillHarness, type SkillHarnesses } from '@shared/skills'
import { reachableUnderHome } from '../remote/harnessSet'
import { readSkillDir } from '../skillFiles'
import { fileBytes } from '../skillStore'
import { rewriteSkillPaths, skillFileText } from './skillText'

/**
 * The one-time import of the skills the person already has (CLAUDE.md
 * "Skills: one store, materialized per host"): on the Mac, every skill under
 * ~/.claude/skills, ~/.codex/skills, ~/.agents/skills and
 * ~/.config/muse/skills goes into the store, so it starts full. The folders
 * are read only, never changed; the box's are harness-sync copies of the
 * Mac's, so it never imports. A name the store already holds stays the
 * store's.
 */

/** JSON `{ at, imported, merged, skipped }` once a run finished. */
export const SKILL_IMPORT_KEY = 'skills-imported:v1'

export const IMPORT_ROOTS = [
  { root: '.claude/skills', harnesses: ['claude'] },
  { root: '.codex/skills', harnesses: ['codex'] },
  // Read by Claude Code and Codex alike.
  { root: '.agents/skills', harnesses: ['claude', 'codex'] },
  { root: '.config/muse/skills', harnesses: ['muse'] }
] as const satisfies readonly { root: string; harnesses: readonly SkillHarness[] }[]
type ImportRoot = (typeof IMPORT_ROOTS)[number]['root']

/** The CLI's own account-synced bucket under ~/.claude/skills: never a skill. */
const CLAUDE_SYNCED = 'synced'
/** The words of a write the home refused because its one copy is out of reach (remote/storeSync.ts offlineRefusal). */
const OFFLINE = 'refused: add-ons and skills live on'
/** Placeholder for a skill's own install folder, so copies that differ only by which root they spell compare equal. */
const OWN_ROOT = '<skill-root>'

export interface ImportCandidate {
  name: string
  root: ImportRoot
  /** the real folder read */
  dir: string
  files: SkillFile[]
  /** files left out: native binaries */
  dropped: string[]
  /** newest file mtime in the tree */
  newest: number
  /** skillDigest with the skill's own-root paths normalized */
  normalDigest: string
}

export interface ImportPlan {
  rows: { name: string; harnesses: SkillHarnesses; from: string; files: SkillFile[] }[]
  merged: { name: string; kept: string; dropped: string[] }[]
  skipped: { name: string; from: string; reason: string }[]
}
export interface ImportReport extends ImportPlan {
  imported: string[]
}

const fromOf = (root: string, name: string): string => `~/${root}/${name}`

/** The skill's files with every spelling of its own install folder made one. */
function normalDigest(name: string, files: readonly SkillFile[], home: string): string {
  const encoder = new TextEncoder()
  return skillDigest(
    files.map((f) => {
      const bytes = fileBytes(f)
      const text = skillFileText({ path: f.path, bytes })
      const out = text === null ? bytes : encoder.encode(rewriteSkillPaths(text, home, (n) => (n === name ? `${OWN_ROOT}/${n}` : null)))
      return { path: f.path, bytes: out, executable: f.executable === true }
    })
  )
}

/** Every skill folder under the four roots, and what was passed over with a reason. Dot entries, Claude's synced bucket and plain files are passed over without one. */
export async function scanSkillRoots(home: string): Promise<{ candidates: ImportCandidate[]; skipped: ImportPlan['skipped'] }> {
  const candidates: ImportCandidate[] = []
  const skipped: ImportPlan['skipped'] = []
  let realHome: string
  try {
    realHome = realpathSync(home)
  } catch {
    return { candidates, skipped }
  }
  for (const { root } of IMPORT_ROOTS) {
    const base = join(home, root)
    let entries: Dirent[]
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const name = entry.name
      const from = fromOf(root, name)
      if (name.startsWith('.') || (root === '.claude/skills' && name === CLAUDE_SYNCED)) continue
      let dir = join(base, name)
      if (entry.isSymbolicLink()) {
        let real: string
        try {
          real = realpathSync(dir)
        } catch {
          continue // a dangling link carries nothing
        }
        if (!reachableUnderHome(real, realHome)) {
          skipped.push({ name, from, reason: 'link outside home' })
          continue
        }
        if (!statSync(real).isDirectory()) continue
        dir = real
      } else if (!entry.isDirectory()) continue
      if (!SKILL_NAME_RE.test(name)) {
        skipped.push({ name, from, reason: 'not a skill name (lowercase letters, digits and dashes)' })
        continue
      }
      if (!existsSync(join(dir, SKILL_MD))) {
        skipped.push({ name, from, reason: 'no SKILL.md' })
        continue
      }
      const dropped: string[] = []
      let files: SkillFile[]
      try {
        files = await readSkillDir(dir, { dropNative: dropped })
      } catch (err) {
        skipped.push({ name, from, reason: ((err as Error).message ?? String(err)).replace(/^refused: /, '') })
        continue
      }
      const problem = skillProblem(
        name,
        files.map((f) => ({ path: f.path, bytes: fileBytes(f) }))
      )
      if (problem) {
        skipped.push({ name, from, reason: problem })
        continue
      }
      let newest = 0
      for (const f of files) {
        try {
          newest = Math.max(newest, statSync(join(dir, ...f.path.split('/'))).mtimeMs)
        } catch {
          /* read a moment ago; gone since */
        }
      }
      candidates.push({ name, root, dir: realpathSync(dir), files, dropped, newest, normalDigest: normalDigest(name, files, home) })
    }
  }
  return { candidates, skipped }
}

const rootOrder = (root: string): number => IMPORT_ROOTS.findIndex((r) => r.root === root)

/** The rows to write: one per name, its CLIs every root's that had it; copies that truly differ keep the newest. A name the store holds globally stays the store's. */
export function planImport(candidates: readonly ImportCandidate[], existing: readonly Pick<SkillMeta, 'name' | 'workspaceId'>[]): ImportPlan {
  const plan: ImportPlan = { rows: [], merged: [], skipped: [] }
  const byName = new Map<string, ImportCandidate[]>()
  for (const c of [...candidates].sort((a, b) => rootOrder(a.root) - rootOrder(b.root))) byName.set(c.name, [...(byName.get(c.name) ?? []), c])
  const taken = new Set(existing.filter((s) => s.workspaceId === null).map((s) => s.name))
  for (const name of [...byName.keys()].sort()) {
    const copies = byName.get(name)!
    if (taken.has(name)) {
      plan.skipped.push({ name, from: fromOf(copies[0]!.root, name), reason: 'already in the store' })
      continue
    }
    const runs = new Set<SkillHarness>(copies.flatMap((c) => IMPORT_ROOTS.find((r) => r.root === c.root)!.harnesses))
    const harnesses: SkillHarnesses = runs.size === SKILL_HARNESSES.length ? 'all' : SKILL_HARNESSES.filter((h) => runs.has(h))
    let kept = copies[0]!
    if (new Set(copies.map((c) => c.normalDigest)).size > 1) {
      // Newest wins; a tie goes to the first root.
      for (const c of copies) if (c.newest > kept.newest) kept = c
      plan.merged.push({ name, kept: fromOf(kept.root, name), dropped: copies.filter((c) => c !== kept).map((c) => fromOf(c.root, name)) })
    }
    plan.rows.push({ name, harnesses, from: fromOf(kept.root, name), files: kept.files })
  }
  return plan
}

export interface ImportDeps {
  platform: string
  home: string
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  existing: () => SkillMeta[]
  /** The settings home when another host holds it, else null. */
  storeHome: () => { id: string; online: boolean } | null
  /** One whole follow from the home (StoreSync.syncWith). */
  follow: (homeId: string) => Promise<void>
  /** skills.set with expectUpdatedAt; a string is a refusal. */
  write: (input: SkillInput, expectUpdatedAt: number) => Promise<{ skill: SkillMeta } | string>
  log?: (line: string) => void
  now?: () => number
}

/** One run of the import: null when this is no Mac, it already ran, or the store's home is out of reach (the next link-up runs it again). */
export async function importSkills(deps: ImportDeps): Promise<ImportReport | null> {
  const log = deps.log ?? ((l: string) => console.log(`[skills] ${l}`))
  if (deps.platform !== 'darwin' || deps.store.getSetting(SKILL_IMPORT_KEY) !== null) return null
  // Know the home's rows first: a stale local copy could replace a row the home already has.
  const home = deps.storeHome()
  if (home) {
    if (!home.online) return null
    await deps.follow(home.id)
  }
  const scan = await scanSkillRoots(deps.home)
  const plan = planImport(scan.candidates, deps.existing())
  const report: ImportReport = { ...plan, skipped: [...scan.skipped, ...plan.skipped], imported: [] }
  for (const row of plan.rows) {
    const writer: Writer = { kind: 'import', from: row.from }
    const answer = await deps.write({ name: row.name, workspaceId: null, harnesses: row.harnesses, files: row.files, addedBy: writer, writtenBy: writer }, 0)
    if (typeof answer !== 'string') {
      report.imported.push(row.name)
      continue
    }
    if (answer.startsWith(OFFLINE)) {
      log(`import stopped: ${answer.replace(/^refused: /, '')}; it runs again at the next link-up`)
      return null
    }
    report.skipped.push({ name: row.name, from: row.from, reason: / changed since it was read$/.test(answer) ? 'already in the store' : answer.replace(/^refused: /, '') })
  }
  deps.store.setSetting(
    SKILL_IMPORT_KEY,
    JSON.stringify({ at: deps.now?.() ?? Date.now(), imported: report.imported.length, merged: report.merged.length, skipped: report.skipped.length })
  )
  log(importLine(report))
  return report
}

/** `imported 47 skills from ~/.claude/skills, …; merged 1 (impeccable: kept ~/.agents/skills); skipped 2 (nosk: no SKILL.md; …)` */
export function importLine(report: ImportReport): string {
  const roots = IMPORT_ROOTS.map((r) => `~/${r.root}`).join(', ')
  const parts = [`imported ${report.imported.length} ${report.imported.length === 1 ? 'skill' : 'skills'} from ${roots}`]
  if (report.merged.length) parts.push(`merged ${report.merged.length} (${report.merged.map((m) => `${m.name}: kept ${m.kept.replace(/\/[^/]+$/, '')}`).join('; ')})`)
  if (report.skipped.length) parts.push(`skipped ${report.skipped.length} (${report.skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})`)
  return parts.join('; ')
}
