import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { SCOPE_DIR } from './materialize'
import { scopeKeyOf, type ScopeKey, type SkillPointers } from './pointers'

/**
 * Claude Code reads the skills store, and only the store (CLAUDE.md "Skills:
 * written out on every host"): each scope has a config dir the app owns,
 * handed to the CLI as CLAUDE_CONFIG_DIR.
 *
 *   <userData>/harness/claude-config/<scope>/
 *     skills/<name>   → <scope pointer>/skills/<name>, one link per store skill
 *     skills/synced   → the person's skills/synced (the CLI's account-synced bucket)
 *     .claude.json    → the person's
 *     <every other entry of the person's dir> → the person's entry
 *
 * The CLI so lists the store's skills under their own names, the project's
 * .claude/skills and its synced bucket, and never the person's
 * ~/.claude/skills or ~/.agents/skills. Transcripts and memory land in the
 * person's projects/ through its link; what the CLI makes for itself
 * (sessions/, backups/, lock files) stays in the scope's dir. The sign-in
 * rides the gateway: a routed thread holds `CLAUDE_CODE_OAUTH_TOKEN=routed`,
 * which the gateway replaces with the thread's account.
 */

export const CLAUDE_ROOTS = 'claude-config'
/** The placeholder the gateway replaces with the thread's account. */
export const ROUTED_OAUTH = 'routed'
/** The name Claude Code keeps under skills/ for its account-synced skills. */
export const SYNCED_SKILLS = 'synced'
const CLAUDE_JSON = '.claude.json'
/** linkTo's tmp name, left behind only by a process that died between its two calls. */
const LEFTOVER_RE = /\.lnk-\d+$/

/** The person's Claude config dir: $CLAUDE_CONFIG_DIR of this process, else ~/.claude (sessionMove.ts claudeConfigDir). */
export function personClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Where the person's .claude.json lives: <personClaudeDir>/.claude.json when CLAUDE_CONFIG_DIR is set, else ~/.claude.json. */
export function personClaudeJson(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, CLAUDE_JSON) : join(homedir(), CLAUDE_JSON)
}

export interface ClaudeRootDeps {
  /** <userData>/harness */
  root: string
  scope: ScopeKey
  /** The scope's pointer (pointers.ts): <root>/claude/scope/<scope>. */
  pointer: string
  personDir?: string
  personJson?: string
  log?: (line: string) => void
}

const defaultLog = (line: string): void => console.log(`[skills] ${line}`)

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function readLink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

/** `path` is a link to `target`, made or re-pointed; a real entry in its place is left alone (false). */
function linkTo(path: string, target: string): boolean {
  const st = lstatOrNull(path)
  if (st && !st.isSymbolicLink()) return false
  if (st && readLink(path) === target) return true
  const tmp = `${path}.lnk-${process.pid}`
  rmSync(tmp, { force: true })
  symlinkSync(target, tmp)
  renameSync(tmp, path)
  return true
}

/** <root>/claude-config/<scope>/, made or refreshed, about thirty readdir and lstat calls. */
export function ensureClaudeRoot(deps: ClaudeRootDeps): string {
  const personDir = deps.personDir ?? personClaudeDir()
  const personJson = deps.personJson ?? personClaudeJson()
  const log = deps.log ?? defaultLog
  const dir = join(deps.root, CLAUDE_ROOTS, deps.scope)
  mkdirSync(dir, { recursive: true })
  // Transcripts and memory always land in the person's dir: its projects/ is made first when missing.
  mkdirSync(join(personDir, 'projects'), { recursive: true })

  // .claude.json: the person's. A regular file here means the CLI replaced the link by a rename.
  const json = join(dir, CLAUDE_JSON)
  const jst = lstatOrNull(json)
  if (jst && !jst.isSymbolicLink()) {
    renameSync(json, `${json}.diverged`)
    log(`${json} was a file of its own (the CLI replaced the link); set aside as ${CLAUDE_JSON}.diverged and linked again`)
  }
  linkTo(json, personJson)

  // Every other entry of the person's dir, linked by its name.
  const theirs = new Set<string>()
  for (const name of readdirSync(personDir)) {
    if (name === 'skills' || name === CLAUDE_JSON) continue
    theirs.add(name)
    linkTo(join(dir, name), join(personDir, name))
  }
  // A link to an entry the person's dir no longer has goes; what the CLI made here stays.
  for (const name of readdirSync(dir)) {
    if (name === 'skills' || name === CLAUDE_JSON || theirs.has(name)) continue
    const path = join(dir, name)
    if (LEFTOVER_RE.test(name) && lstatOrNull(path)?.isSymbolicLink()) {
      rmSync(path, { force: true })
      continue
    }
    const target = lstatOrNull(path)?.isSymbolicLink() ? readLink(path) : null
    if (target !== null && target === join(personDir, name)) rmSync(path, { force: true })
  }

  relinkClaudeSkills(dir, deps.pointer, personDir, log)
  return dir
}

/** Store rows named `synced` already said once (a peer's put never meets skillProblem). */
const syncedSaid = new Set<string>()

/**
 * Re-link `<scope root>/skills/` to the pointer's current skill names: one
 * link per skill through the pointer (an edited skill is reached at once; a
 * skill added or removed needs this), plus the person's synced bucket. A
 * scope with no root yet is left alone: its first spawn makes it.
 */
export function relinkClaudeSkills(rootDir: string, pointer: string, personDir = personClaudeDir(), log: (line: string) => void = defaultLog): void {
  if (!existsSync(rootDir)) return
  const skillsDir = join(rootDir, 'skills')
  const st = lstatOrNull(skillsDir)
  if (st && !st.isDirectory()) rmSync(skillsDir, { force: true })
  mkdirSync(skillsDir, { recursive: true })
  const wanted = new Map<string, string>()
  let names: string[] = []
  try {
    names = readdirSync(join(pointer, 'skills'))
  } catch {
    // the pointer names nothing yet: no store skills
  }
  for (const name of names) {
    if (name === SYNCED_SKILLS) {
      if (!syncedSaid.has(rootDir)) log(`a store skill named ${SYNCED_SKILLS} is not linked for Claude Code: that name is its own skills folder`)
      syncedSaid.add(rootDir)
      continue
    }
    wanted.set(name, join(pointer, 'skills', name))
  }
  const synced = join(personDir, 'skills', SYNCED_SKILLS)
  if (isDir(synced)) wanted.set(SYNCED_SKILLS, synced)
  for (const [name, target] of wanted) linkTo(join(skillsDir, name), target)
  for (const name of readdirSync(skillsDir)) {
    if (wanted.has(name)) continue
    const path = join(skillsDir, name)
    if (lstatOrNull(path)?.isSymbolicLink()) rmSync(path, { force: true })
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ── the driver's seam ───────────────────────────────────────────────────

export interface ClaudeSkillRootsConfig {
  /** The workspace a thread reads skills for (views.ts workspaceOfThread of the thread itself). */
  scopeOf: (session: { workspaceId: string | null; projectId: string | null; cwd: string }) => string | null
  pointers: Pick<SkillPointers, 'path' | 'current' | 'onMoved'>
  /** <userData>/harness */
  root: string
  log?: (line: string) => void
}

let configured: (ClaudeSkillRootsConfig & { off: () => void }) | null = null

/** Point every Claude thread at its scope's owned root; null is today's spawn exactly (tests, a host without the store). */
export function configureClaudeSkillRoots(cfg: ClaudeSkillRootsConfig | null): void {
  configured?.off()
  configured = null
  if (!cfg) return
  // A move re-links the scope's root before any thread reloads: a skill added or removed in the store needs a link.
  const off = cfg.pointers.onMoved((provider, scope) => {
    if (provider !== 'claude') return
    try {
      relinkClaudeSkills(join(cfg.root, CLAUDE_ROOTS, scope), join(cfg.root, 'claude', SCOPE_DIR, scope), undefined, cfg.log)
    } catch (err) {
      ;(cfg.log ?? defaultLog)(`claude ${scope}: relink failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  configured = { ...cfg, off }
}

export interface ClaudeSkillRoot {
  /** CLAUDE_CONFIG_DIR for the CLI */
  dir: string
  workspaceId: string | null
}

/** The owned root a thread's CLI runs under, made or refreshed now; null when unconfigured. */
export function claudeSkillRootFor(session: { workspaceId: string | null; projectId: string | null; cwd: string }): ClaudeSkillRoot | null {
  if (!configured) return null
  const workspaceId = configured.scopeOf(session)
  const pointer = configured.pointers.path('claude', workspaceId)
  const dir = ensureClaudeRoot({ root: configured.root, scope: scopeKeyOf(workspaceId), pointer, log: configured.log })
  return { dir, workspaceId }
}

/** The generation a scope's pointer names now; null when unconfigured. */
export function claudeSkillsGeneration(workspaceId: string | null): string | null {
  return configured ? configured.pointers.current('claude', workspaceId).generation : null
}

/** The generation the scope of an owned root (a spec's CLAUDE_CONFIG_DIR) names now; null for any other dir. */
export function claudeGenerationOfRoot(configDir: string | undefined): string | null {
  if (!configured || !configDir) return null
  if (join(configured.root, CLAUDE_ROOTS, basename(configDir)) !== configDir) return null
  const scope = basename(configDir)
  return claudeSkillsGeneration(scope === 'global' ? null : scope.startsWith('ws-') ? scope.slice(3) : null)
}
