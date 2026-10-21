import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { delimiter, dirname, join, posix, sep } from 'node:path'
import type { HarnessClaudeJson, HarnessEntry } from '@shared/contract-harness'

/**
 * What the harness config sync carries (docs/box.md "Harness config: synced
 * from the Mac"), relative to each host's HOME, and the checks both ends run
 * on it. The set is a list of rules; whatever the rules say, a secret
 * (isSecretPath) never enters a manifest and never lands.
 */

export type SetRule =
  /** Every file under `root`, minus the `exclude` dirs (relative to root) and the files `skip` matches (relative to root). */
  | { kind: 'tree'; root: string; exclude?: string[]; skip?: RegExp }
  | { kind: 'file'; path: string }

export const HARNESS_SET: readonly SetRule[] = [
  // skills/synced is the CLI's own account-synced bucket: neither side touches it.
  { kind: 'tree', root: '.claude/skills', exclude: ['synced'] },
  { kind: 'tree', root: '.claude/commands' },
  { kind: 'tree', root: '.claude/agents' },
  { kind: 'file', path: '.claude/settings.json' },
  // The installed plugin trees and their records; the directory cache (2.7 MB, rebuilt by the CLI) stays per host.
  { kind: 'tree', root: '.claude/plugins', exclude: ['synced'], skip: /^plugin-directory-cache[^/]*\.json$/ },
  { kind: 'tree', root: '.codex/skills', exclude: ['.system'] },
  { kind: 'tree', root: '.codex/prompts' },
  { kind: 'file', path: '.codex/config.toml' },
  { kind: 'tree', root: '.agents/skills' }
]

/** The one file outside the set whose keys cross (HARNESS_CLAUDE_KEYS), merged into the receiver's own. */
export const CLAUDE_JSON = '.claude.json'
export const HARNESS_CLAUDE_KEYS = ['enabledPlugins', 'mcpServers'] as const

/** Per-file budget: a bigger file stays where it is and the sender counts it as skipped. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024
/** Text files under this size have their paths translated on landing. */
export const MAX_TEXT_BYTES = 1024 * 1024
const TEXT_EXT = /\.(md|json|toml|sh|mjs)$/i
/** Dirs never walked inside any rule: a repo's object store is useless piecemeal and a skipped pack would corrupt it. */
const SKIP_DIRS = new Set(['.git'])
const SKIP_NAMES = new Set(['.DS_Store'])

const SECRET_NAMES = new Set(['.credentials.json', 'auth.json', 'settings.local.json', '.claude.json'])
const SECRET_EXT = /\.(pem|key|p8|p12|pfx)$/i

/** Credentials and keys: excluded from every manifest and refused on landing, whatever the rules say. */
export function isSecretPath(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath
  return SECRET_NAMES.has(base) || SECRET_EXT.test(base)
}

/** A relPath as the wire may carry it: posix, normalized, relative, no `..`, no `.`, no empty segment. */
export function validRelPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1024) return false
  if (relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/')) return false
  if (posix.normalize(relPath) !== relPath) return false
  return relPath.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** The rule a relPath falls under, or null when it is outside the set (or a secret, or a bad path). */
export function ruleFor(relPath: string, rules: readonly SetRule[] = HARNESS_SET): SetRule | null {
  if (!validRelPath(relPath) || isSecretPath(relPath)) return null
  for (const rule of rules) {
    if (rule.kind === 'file') {
      if (relPath === rule.path) return rule
      continue
    }
    if (!relPath.startsWith(rule.root + '/')) continue
    const inner = relPath.slice(rule.root.length + 1)
    const segs = inner.split('/')
    if (segs.slice(0, -1).some((s) => SKIP_DIRS.has(s))) return null
    if (SKIP_NAMES.has(segs[segs.length - 1])) return null
    if (rule.exclude?.some((ex) => inner === ex || inner.startsWith(ex + '/'))) return null
    if (rule.skip?.test(inner)) return null
    return rule
  }
  return null
}

export const inSet = (relPath: string, rules: readonly SetRule[] = HARNESS_SET): boolean => ruleFor(relPath, rules) !== null

/** The dir a rule's files live under (a file rule: its parent), relative to HOME. */
export const ruleRoot = (rule: SetRule): string => (rule.kind === 'tree' ? rule.root : posix.dirname(rule.path))

/** Whether a landed file is text to translate: by extension and size; the bytes must also decode as UTF-8. */
export const translatable = (relPath: string, size: number): boolean => TEXT_EXT.test(relPath) && size <= MAX_TEXT_BYTES

const utf8 = new TextDecoder('utf-8', { fatal: true })
/** The text of a buffer, or null when it is not valid UTF-8. */
export function decodeText(buf: Buffer): string | null {
  try {
    return utf8.decode(buf)
  } catch {
    return null
  }
}

export const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

// ── the sender: the manifest of what is on disk ──────────────────────────

/** Under the sender's HOME, where a symlinked skill may point; anything else is out of reach. */
const SENSITIVE_UNDER_HOME = ['.ssh', '.gnupg', '.aws', '.config/gh', '.docker', '.kube', 'Library/Keychains', '.aliax']

export interface HashCache {
  get(key: string): { size: number; mtimeMs: number; ino: number; sha: string } | undefined
  set(key: string, value: { size: number; mtimeMs: number; ino: number; sha: string }): void
}

export interface Skipped {
  relPath: string
  reason: 'too-large' | 'symlink-out-of-reach' | 'symlink-loop' | 'unreadable'
}

export interface Manifest {
  entries: HarnessEntry[]
  skipped: Skipped[]
  claudeJson?: HarnessClaudeJson
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Walk the set under `home`. A symlink is followed (a skill linked in from
 * a checkout is the usual case) only when its real target is inside HOME
 * and outside the credential dirs; a dir reached twice is a loop and is
 * walked once. Hashes are cached by real path, size, mtime and inode.
 */
export function buildManifest(home: string, opts: { rules?: readonly SetRule[]; cache?: HashCache; maxBytes?: number } = {}): Manifest {
  const rules = opts.rules ?? HARNESS_SET
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
  const entries: HarnessEntry[] = []
  const skipped: Skipped[] = []
  let realHome: string
  try {
    realHome = realpathSync(home)
  } catch {
    return { entries, skipped }
  }
  const sensitive = SENSITIVE_UNDER_HOME.map((d) => join(realHome, d))
  const reachable = (real: string): boolean => within(real, realHome) && !sensitive.some((s) => within(real, s))

  const addFile = (relPath: string, abs: string, st: Stats): void => {
    if (!inSet(relPath, rules)) return
    if (st.size > maxBytes) {
      skipped.push({ relPath, reason: 'too-large' })
      return
    }
    let real: string
    try {
      real = realpathSync(abs)
    } catch {
      skipped.push({ relPath, reason: 'unreadable' })
      return
    }
    const hit = opts.cache?.get(real)
    let sha: string
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) sha = hit.sha
    else {
      try {
        sha = sha256(readFileSync(abs))
      } catch {
        skipped.push({ relPath, reason: 'unreadable' })
        return
      }
      opts.cache?.set(real, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, sha })
    }
    entries.push({ relPath, size: st.size, sha256: sha, mode: st.mode & 0o777, mtime: Math.floor(st.mtimeMs) })
  }

  /** stat through a symlink when its target is reachable; null (and a skipped row) otherwise. */
  const follow = (relPath: string, abs: string): Stats | null => {
    let lst: Stats
    try {
      lst = lstatSync(abs)
    } catch {
      return null
    }
    if (!lst.isSymbolicLink()) return lst
    try {
      const real = realpathSync(abs)
      if (!reachable(real)) {
        skipped.push({ relPath, reason: 'symlink-out-of-reach' })
        return null
      }
      return statSync(abs)
    } catch {
      skipped.push({ relPath, reason: 'unreadable' })
      return null
    }
  }

  const walk = (relDir: string, absDir: string, seen: Set<string>): void => {
    let real: string
    try {
      real = realpathSync(absDir)
    } catch {
      return
    }
    if (seen.has(real)) {
      skipped.push({ relPath: relDir, reason: 'symlink-loop' })
      return
    }
    seen.add(real)
    let names: string[]
    try {
      names = readdirSync(absDir).sort()
    } catch {
      skipped.push({ relPath: relDir, reason: 'unreadable' })
      return
    }
    for (const name of names) {
      const relPath = `${relDir}/${name}`
      const abs = join(absDir, name)
      const st = follow(relPath, abs)
      if (!st) continue
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        // An excluded dir (skills/synced, plugins/synced, .codex/skills/.system) is never entered.
        if (!rules.some((r) => r.kind === 'tree' && (relPath === r.root || relPath.startsWith(r.root + '/')) && !r.exclude?.some((ex) => relPath === `${r.root}/${ex}`))) continue
        walk(relPath, abs, new Set(seen))
      } else if (st.isFile()) addFile(relPath, abs, st)
    }
  }

  for (const rule of rules) {
    if (rule.kind === 'file') {
      const abs = join(home, rule.path)
      const st = follow(rule.path, abs)
      if (st?.isFile()) addFile(rule.path, abs, st)
      continue
    }
    const abs = join(home, rule.root)
    const st = follow(rule.root, abs)
    if (st?.isDirectory()) walk(rule.root, abs, new Set())
  }
  // A tree nested in another (never in HARNESS_SET, possible in a widened set) lists a file once.
  const unique = new Map(entries.map((e) => [e.relPath, e]))
  const claudeJson = readClaudeJsonKeys(join(home, CLAUDE_JSON))
  return { entries: [...unique.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)), skipped, ...(claudeJson ? { claudeJson } : {}) }
}

/**
 * The crossing keys of a ~/.claude.json: every key absent when the file is
 * (nothing to carry), undefined when it cannot be read or parsed (the CLI
 * mid-write: leave the receiver's alone this round).
 */
export function readClaudeJsonKeys(path: string): HarnessClaudeJson | undefined {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const out: HarnessClaudeJson = {}
    for (const key of HARNESS_CLAUDE_KEYS) if (key in parsed) out[key] = parsed[key]
    return out
  } catch {
    return undefined
  }
}

// ── the receiver: hooks that cannot run here ─────────────────────────────

const SHELL_BUILTINS = new Set(['cd', 'echo', 'exit', 'true', 'false', 'test', '[', 'exec', 'source', '.', 'export', 'printf', 'read', 'set', 'unset', 'eval', ':'])

/** The executable a hook command line starts with: past `VAR=value` words, quotes stripped. */
export function commandExecutable(command: string): string | null {
  const words = command.trim().match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g) ?? []
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    return word.replace(/["']/g, '') || null
  }
  return null
}

/** Every `command` string under settings.json's `hooks`. */
export function hookCommands(settings: unknown): string[] {
  const out: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit)
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'command' && typeof v === 'string') out.push(v)
        else visit(v)
      }
    }
  }
  if (settings && typeof settings === 'object') visit((settings as { hooks?: unknown }).hooks)
  return out
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The hook executables of a settings.json text that this host cannot find (absolute, `~/`, or on PATH). */
export function missingHookExecutables(settingsText: string, env: { PATH?: string; home: string }): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(settingsText)
  } catch {
    return []
  }
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const missing = new Set<string>()
  for (const command of hookCommands(parsed)) {
    const exe = commandExecutable(command)
    if (!exe || SHELL_BUILTINS.has(exe) || exe.includes('$')) continue
    const path = exe.startsWith('~/') ? join(env.home, exe.slice(2)) : exe
    const found = path.includes('/') ? executable(path) : dirs.some((d) => executable(join(d, path)))
    if (!found) missing.add(exe)
  }
  return [...missing]
}

/** Remove the dirs a delete left empty, up to (not including) `stop`. */
export function pruneEmptyDirs(fromDir: string, stop: string, rmdir: (dir: string) => void): void {
  let dir = fromDir
  while (within(dir, stop) && dir !== stop) {
    try {
      if (readdirSync(dir).length > 0) return
      rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}
