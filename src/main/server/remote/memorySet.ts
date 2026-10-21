import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { HistoryMapping } from '../pathMap'
import { stripSlash } from '../pathMap'
import { buildManifest, isSecretPath, validRelPath, type HashCache, type Manifest, type SetRule } from './harnessSet'

/**
 * What the memory sync carries (docs/box.md "Memory: synced both ways"):
 * the notes the harnesses write for themselves, relative to each host's
 * HOME. Unlike the harness config (harnessSet.ts, one way, the Mac's copy
 * wins) every host writes these, so the leg is two-way (memorySync.ts).
 *
 *  - Claude Code's per-project memory: `.claude/projects/<encoded cwd>/memory/**`
 *    (MEMORY.md plus one file per memory). The encoded dir names the cwd
 *    with every non-alphanumeric character as `-`, so it differs per host
 *    and is translated through the path map (translateEncodedDir).
 *  - `.claude/plans/**` (plan mode's documents), `.claude/CLAUDE.md` (the
 *    user-level instructions; the project ones are in git).
 *  - Codex's `.codex/memories/**` (memory_summary.md, MEMORY.md,
 *    rollout_summaries/, skills/; its `.git` baseline stays per host) and
 *    `.codex/AGENTS.md`.
 *
 * Never: transcripts (the `.jsonl` files and the per-session dirs beside
 * `memory/`), anything harnessSet.ts calls a secret, `.git`, files over
 * 1 MiB. A project's own `.claude/` notes live in the checkout and are
 * not touched.
 */

export const MEMORY_MAX_BYTES = 1024 * 1024

/** The fixed part of the set; the per-project memory dirs are found at walk time (memoryRules). */
export const MEMORY_FIXED_RULES: readonly SetRule[] = [
  { kind: 'tree', root: '.claude/plans', label: 'Claude plans' },
  { kind: 'file', path: '.claude/CLAUDE.md', label: 'Claude instructions' },
  { kind: 'tree', root: '.codex/memories', label: 'Codex memories' },
  { kind: 'file', path: '.codex/AGENTS.md', label: 'Codex instructions' }
]

export const PROJECTS_DIR = '.claude/projects'
const ENCODED_DIR = /^[A-Za-z0-9-]+$/
const PROJECT_MEMORY = /^\.claude\/projects\/([A-Za-z0-9-]+)\/memory\/(.+)$/
/** The one file that is merged rather than taken whole: Claude Code's memory index. */
export const MEMORY_INDEX = /^\.claude\/projects\/[A-Za-z0-9-]+\/memory\/MEMORY\.md$/
/** A conflict copy: `<stem>.conflict-<host>-<time><ext>`. */
export const CONFLICT_RE = /\.conflict-([^./]+)-(\d{8}T\d{6})(\.[^./]*)?$/

/** The rules of the set as it is on this host now: the fixed ones plus every `.claude/projects/<enc>/memory` that exists. */
export function memoryRules(home: string): SetRule[] {
  const rules: SetRule[] = []
  // A conflict copy beside a single-file rule's file (`.claude/CLAUDE.conflict-box-….md`) is in the set too.
  const copies: SetRule[] = []
  for (const rule of MEMORY_FIXED_RULES) {
    if (rule.kind !== 'file') continue
    const dir = join(home, posix.dirname(rule.path))
    const base = posix.basename(rule.path)
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names.sort()) if (name !== base && stripConflict(name) === base) copies.push({ kind: 'file', path: `${posix.dirname(rule.path)}/${name}`, label: rule.label })
  }
  const projects = join(home, PROJECTS_DIR)
  if (existsSync(projects)) {
    let names: string[] = []
    try {
      names = readdirSync(projects).sort()
    } catch {
      names = []
    }
    for (const name of names) {
      if (!ENCODED_DIR.test(name)) continue
      const memory = join(projects, name, 'memory')
      try {
        if (statSync(memory).isDirectory()) rules.push({ kind: 'tree', root: `${PROJECTS_DIR}/${name}/memory`, label: 'Claude memory' })
      } catch {
        /* no memory dir for this project */
      }
    }
  }
  return [...rules, ...MEMORY_FIXED_RULES, ...copies]
}

/** A file name without its `.conflict-<host>-<time>` part (the name as it was, for a copy; unchanged otherwise). */
export const stripConflict = (name: string): string => name.replace(/\.conflict-[^./]+-\d{8}T\d{6}(?=(\.[^./]*)?$)/, '')

/** The memory files on this host: harnessSet's walk over memoryRules (symlink policy, secrets and the budget included). */
export function listMemory(home: string, opts: { cache?: HashCache } = {}): Manifest {
  const m = buildManifest(home, { rules: memoryRules(home), cache: opts.cache, maxBytes: MEMORY_MAX_BYTES })
  return { entries: m.entries.filter((e) => inMemorySet(e.relPath)), skipped: m.skipped }
}

/** The rule root a wire relPath lands under, or null when it is outside the set (a secret, a transcript, a bad path). */
export function memoryRoot(relPath: string): string | null {
  if (!validRelPath(relPath) || isSecretPath(relPath)) return null
  const segs = relPath.split('/')
  if (segs.some((s) => s === '.git') || segs[segs.length - 1] === '.DS_Store') return null
  if (relPath.endsWith('.jsonl')) return null
  const project = PROJECT_MEMORY.exec(relPath)
  if (project) return `${PROJECTS_DIR}/${project[1]}/memory`
  for (const rule of MEMORY_FIXED_RULES) {
    if (rule.kind === 'file') {
      const dir = posix.dirname(rule.path)
      if (relPath === rule.path || (posix.dirname(relPath) === dir && stripConflict(posix.basename(relPath)) === posix.basename(rule.path))) return dir
    } else if (relPath.startsWith(rule.root + '/')) return rule.root
  }
  return null
}

export const inMemorySet = (relPath: string): boolean => memoryRoot(relPath) !== null

/** Text files whose paths are translated on landing (the rest is copied byte for byte). */
export const memoryTranslatable = (relPath: string): boolean => /\.(md|txt|json|toml|yaml|yml)$/i.test(relPath)

// ── the encoded project dir ──────────────────────────────────────────────

/** Claude Code's name for a project's dir under ~/.claude/projects: the cwd with every other character as `-`. */
export const encodeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/**
 * The encoded dir as the other host spells it: the longest mapped path
 * (roots, then prefixes) whose encoding starts the name on a `-` boundary
 * is swapped for its counterpart's encoding. A name no mapping covers is
 * kept: the project exists on one host only, and its memory still lands.
 */
export function translateEncodedDir(encoded: string, mapping: HistoryMapping): string {
  const pairs = [...Object.entries(mapping.roots), ...Object.entries(mapping.prefixes)]
    .map(([from, to]): [string, string] => [encodeProjectDir(stripSlash(from)), encodeProjectDir(stripSlash(to))])
    .filter(([from]) => from.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
  for (const [from, to] of pairs) {
    if (encoded === from) return to
    if (encoded.startsWith(from + '-')) return to + encoded.slice(from.length)
  }
  return encoded
}

/** A wire relPath as it lands here: a project memory path with its encoded dir translated; anything else as it is. */
export function translateMemoryPath(relPath: string, mapping: HistoryMapping): string {
  const m = PROJECT_MEMORY.exec(relPath)
  if (!m) return relPath
  return `${PROJECTS_DIR}/${translateEncodedDir(m[1], mapping)}/memory/${m[2]}`
}

/** `roots` and `prefixes` the other way round, for a receiver whose map was written for the sender's direction. */
export function invertMapping(mapping: HistoryMapping): HistoryMapping {
  const flip = (table: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [from, to] of Object.entries(table)) if (!(to in out)) out[to] = from
    return out
  }
  return { roots: flip(mapping.roots), prefixes: flip(mapping.prefixes) }
}

/** Whether the shipped map (Mac → box) reads forward for a sender at `senderHome` received by `myHome`: its sources live under the sender's home (or its destinations under mine). */
export function mappingReadsForward(mapping: HistoryMapping, senderHome: string, myHome: string): boolean {
  const under = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith('/') ? root : root + '/')
  const from = stripSlash(senderHome)
  const mine = stripSlash(myHome)
  const sources = [...Object.keys(mapping.roots), ...Object.keys(mapping.prefixes)]
  const targets = [...Object.values(mapping.roots), ...Object.values(mapping.prefixes)]
  if (sources.some((s) => under(s, from)) || targets.some((t) => under(t, mine))) return true
  if (sources.some((s) => under(s, mine)) || targets.some((t) => under(t, from))) return false
  return true
}

/** `<stem>.conflict-<host>-<yyyymmddThhmmss><ext>` beside the file; the host name reduced to what a file name takes. */
export function conflictName(relPath: string, host: string, at: number): string {
  const dir = posix.dirname(relPath)
  const base = posix.basename(relPath)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  const safeHost = host.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'host'
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  const name = `${stem}.conflict-${safeHost}-${stamp}${ext}`
  return dir === '.' ? name : `${dir}/${name}`
}

/** The host and time a conflict copy's name carries, or null for an ordinary file. */
export function parseConflictName(relPath: string): { host: string; at: number } | null {
  const m = CONFLICT_RE.exec(posix.basename(relPath))
  if (!m) return null
  const s = m[2]
  const at = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15))
  return { host: m[1], at }
}
