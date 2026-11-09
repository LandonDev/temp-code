import { andList, scopeWords, visibleRows, writerWords, type Writer } from './addons'
import { isSecretPath, validRelPath } from './secretPaths'
import { sha256Hex } from './sha256'
import type { SkillMeta } from './contract-skills'

/**
 * The skills store's pure rules (CLAUDE.md "Add-ons and skills: one store,
 * on the box"): what a skill may hold, its digest, the two frontmatter keys
 * the store reads, which skills a thread's CLI gets, the materialized
 * view's name, the cards and the words of the tools threads get. The wire
 * shapes are contract-skills.ts; the store is src/main/server/skillStore.ts.
 */

/** Claude Code's skill name rule. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const SKILL_HARNESSES = ['claude', 'codex', 'muse'] as const
export type SkillHarness = (typeof SKILL_HARNESSES)[number]
export type SkillHarnesses = 'all' | SkillHarness[]

export const SKILL_MAX_FILES = 512
export const SKILL_MAX_FILE_BYTES = 4 * 1024 * 1024
export const SKILL_MAX_BYTES = 16 * 1024 * 1024
export const SKILL_MD = 'SKILL.md'
/** A skill's per-platform binary cache, relative to the skill folder (remote/harnessSet.ts's is relative to the skills root): each host fetches its own. */
export const SKILL_BINARY_CACHE = /^scripts\/bin\//

/** ELF, Mach-O (thin, and universal told from a Java class by its arch count) or PE. */
export function isNativeBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const u32 = (at: number): number => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  const magic = u32(0)
  if (magic === 0x7f454c46) return true
  if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) return true
  if (magic === 0xcafebabe) return bytes.length >= 8 && u32(4) < 30
  if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 64) {
    // MZ, and the PE signature where the header says it is.
    const at = bytes[0x3c]! | (bytes[0x3d]! << 8) | (bytes[0x3e]! << 16) | (bytes[0x3f]! << 24)
    return at >= 0 && at + 4 <= bytes.length && bytes[at] === 0x50 && bytes[at + 1] === 0x45 && bytes[at + 2] === 0 && bytes[at + 3] === 0
  }
  return false
}

const decoder = new TextDecoder()

/**
 * Why these files cannot be the skill `name`, or null: SKILL.md at the
 * root with frontmatter giving this `name` and a `description`, every path
 * clean and no secret, nothing under the binary cache, no native binary
 * (each host fetches its own), and the limits.
 */
export function skillProblem(name: string, files: readonly { path: string; bytes: Uint8Array }[]): string | null {
  if (!SKILL_NAME_RE.test(name)) return 'name takes lowercase letters, digits and dashes, at most 64 characters'
  if (files.length === 0) return 'a skill needs its SKILL.md'
  if (files.length > SKILL_MAX_FILES) return `a skill holds at most ${SKILL_MAX_FILES} files; this one has ${files.length}`
  let total = 0
  const seen = new Set<string>()
  for (const f of files) {
    if (!validRelPath(f.path)) return `${JSON.stringify(f.path)} is not a path inside the skill folder`
    if (seen.has(f.path)) return `${f.path} is there twice`
    seen.add(f.path)
    if (isSecretPath(f.path)) return `${f.path} looks like a credential; a skill never carries one`
    if (SKILL_BINARY_CACHE.test(f.path)) return `${f.path} is in the skill's binary cache; each host fetches its own`
    if (f.bytes.length > SKILL_MAX_FILE_BYTES) return `${f.path} is ${sizeWords(f.bytes.length)}, over the ${sizeWords(SKILL_MAX_FILE_BYTES)} a file may be`
    if (isNativeBinary(f.bytes)) return `${f.path} is a native binary; each host fetches its own`
    total += f.bytes.length
  }
  if (total > SKILL_MAX_BYTES) return `the skill is ${sizeWords(total)}, over the ${sizeWords(SKILL_MAX_BYTES)} a skill may be`
  const md = files.find((f) => f.path === SKILL_MD)
  if (!md) return 'SKILL.md is missing from the skill folder\'s root'
  const front = skillFrontmatter(decoder.decode(md.bytes))
  if (!front.name || !front.description) return 'SKILL.md starts with frontmatter giving the skill\'s name and a description'
  if (front.name !== name) return `SKILL.md names the skill ${front.name}, not ${name}`
  return null
}

/** The sha256 of the sorted lines `<path>\0<0|1>\0<sha256 of content>\n`: the same whatever the order. */
export function skillDigest(files: readonly { path: string; bytes: Uint8Array; executable: boolean }[]): string {
  const lines = files.map((f) => `${f.path}\0${f.executable ? 1 : 0}\0${sha256Hex(f.bytes)}\n`)
  lines.sort()
  return sha256Hex(lines.join(''))
}

// ── frontmatter ─────────────────────────────────────────────────────────

/** A double-quoted YAML scalar's escapes; JSON's are a subset. */
function doubleQuoted(raw: string): string {
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/** A block scalar's lines (`|` literal or `>` folded), indentation and trailing newlines dropped. */
function blockScalar(style: string, lines: readonly string[]): string {
  const body = [...lines]
  while (body.length && body[body.length - 1]!.trim() === '') body.pop()
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf))
  const text = body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
  if (style === '|') return text.join('\n')
  // Folded: a line break between two text lines is a space; a blank line is a newline.
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const line = text[i]!
    if (line === '') out += '\n'
    else out += out === '' || out.endsWith('\n') ? line : ` ${line}`
  }
  return out
}

/**
 * The `name` and `description` a SKILL.md's frontmatter gives, the way
 * installed skills write them: CRLF read as LF; plain, single- and
 * double-quoted scalars; folded (`>`, `>-`) and literal (`|`, `|-`) block
 * scalars; a plain scalar continued on more-indented lines. Trailing
 * newlines are dropped whatever the chomping indicator says.
 */
export function skillFrontmatter(md: string): { name?: string; description?: string } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return {}
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'))
  if (end < 0) return {}
  const body = lines.slice(1, end)
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < body.length; i++) {
    const line = body[i]!
    const m = /^(name|description):(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] as 'name' | 'description'
    const rest = m[2]!.trim()
    // The lines indented under the key belong to its value.
    const more: string[] = []
    while (i + 1 < body.length && (body[i + 1]!.trim() === '' || indentOf(body[i + 1]!) > 0)) more.push(body[++i]!)
    let value: string
    const block = /^([|>])[+-]?\d*\s*(?:#.*)?$/.exec(rest)
    if (block) value = blockScalar(block[1]!, more)
    else if (rest.startsWith('"')) value = doubleQuoted(rest)
    else if (rest.startsWith("'")) value = rest.replace(/^'|'\s*$/g, '').replace(/''/g, "'")
    else {
      const plain = rest.replace(/\s+#.*$/, '')
      const cont = more.map((l) => l.trim()).filter(Boolean)
      value = [plain, ...cont].filter(Boolean).join(' ')
    }
    value = value.replace(/\s+$/, '')
    if (value) out[key] = value
  }
  return out
}

// ── which skills a CLI gets ─────────────────────────────────────────────

export const runsOn = (harnesses: SkillHarnesses, harness: SkillHarness): boolean => harnesses === 'all' || harnesses.includes(harness)

/** skill_write's `harnesses` argument as the row keeps it: absent, `all` or every CLI named is `all`, else the CLIs in order. */
export function harnessesFrom(arg: readonly string[] | undefined): SkillHarnesses {
  if (!arg || arg.includes('all')) return 'all'
  const picked = SKILL_HARNESSES.filter((h) => arg.includes(h))
  return picked.length === 0 || picked.length === SKILL_HARNESSES.length ? 'all' : picked
}

/** The enabled skills a `harness` thread in `workspaceId` gets: the global ones plus its workspace's, a workspace skill shadowing a global one of the same name. */
export function visibleSkills<T extends Pick<SkillMeta, 'name' | 'workspaceId' | 'enabled' | 'harnesses'>>(
  skills: readonly T[],
  workspaceId: string | null,
  harness: SkillHarness
): T[] {
  return visibleRows(skills, workspaceId).filter((s) => s.enabled && runsOn(s.harnesses, harness))
}

/** The digest of one view (what a CLI gets): sorted `<name>\0<digest>\n` lines. */
export function viewDigest(skills: readonly Pick<SkillMeta, 'name' | 'digest'>[]): string {
  const lines = skills.map((s) => `${s.name}\0${s.digest}\n`)
  lines.sort()
  return sha256Hex(lines.join(''))
}

/** A view's folder name under `<userData>/harness/<provider>/`: `global`, or `ws-<workspaceId>` for a workspace with a skill of its own. */
export const viewDirName = (workspaceId: string | null): string => (workspaceId === null ? 'global' : `ws-${workspaceId.replace(/[^A-Za-z0-9_-]/g, '_')}`)
/** One generation's folder: `<view>@<first 12 hex of digest>`, the digest the generation's whole content hash (skills/materialize.ts `generationName`). */
export const generationDirName = (view: string, digest: string): string => `${view}@${digest.slice(0, 12)}`

// ── the cards ───────────────────────────────────────────────────────────

const HARNESS_WORDS: Record<SkillHarness, string> = { claude: 'Claude', codex: 'Codex', muse: 'Muse' }
export const harnessWords = (harnesses: SkillHarnesses): string =>
  andList((harnesses === 'all' ? [...SKILL_HARNESSES] : SKILL_HARNESSES.filter((h) => harnesses.includes(h))).map((h) => HARNESS_WORDS[h]))

/** 12 KB, 2 MB: the attachment size words, rounded. */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** Whether writing over or removing a skill asks the person: when a person or an import wrote it last. A new skill never asks. */
export const skillWriteAsks = (existing: { writtenBy: Writer } | null): boolean => existing !== null && existing.writtenBy.kind !== 'thread'

/** `skill_write`'s card over a person's or an import's skill: what the new version holds, and `changes`, which of its files differ from the stored copy (skills/tools.ts `skillChanges`). */
export function skillChangeCard(
  next: { name: string; harnesses: SkillHarnesses; fileCount: number; bytes: number; changes: string },
  existing: { writtenBy: Writer },
  ctx: { workspaceName: string | null }
): { title: string; input: { where: string; harnesses: string; files: string; changes: string; writtenBy: string } } {
  return {
    title: `Change the skill ${next.name}`,
    input: {
      where: scopeWords(ctx.workspaceName),
      harnesses: harnessWords(next.harnesses),
      files: `${next.fileCount} ${next.fileCount === 1 ? 'file' : 'files'}, ${sizeWords(next.bytes)}`,
      changes: next.changes,
      writtenBy: writerWords(existing.writtenBy)
    }
  }
}

/** `skill_remove`'s card. */
export function skillRemoveCard(row: { name: string; writtenBy: Writer }, ctx: { workspaceName: string | null }): { title: string; input: { where: string; writtenBy: string } } {
  return { title: `Remove the skill ${row.name}`, input: { where: scopeWords(ctx.workspaceName), writtenBy: writerWords(row.writtenBy) } }
}

// ── the tools threads get (section 7 of the schema plan) ────────────────
// The skills store core registers these on the claude path and the bridge.

export const SKILL_LIST_TOOL = 'skill_list'
export const SKILL_LIST_DESCRIPTION =
  'List the skills in the app\'s store that apply to this thread: name, description, which CLIs get it, where it applies, version and who last wrote it.'

export const SKILL_WRITE_TOOL = 'skill_write'
export const SKILL_WRITE_DESCRIPTION =
  'Write one skill whole: its SKILL.md and every file beside it, replacing what was there. Pass `files` (text files, each path relative to the skill folder, SKILL.md at its root) or `dir` (a folder on this host holding the whole skill, binaries included), not both. SKILL.md starts with frontmatter giving the skill\'s `name` and a `description` of when to use it. Threads that start after the write see it; a running thread does not. Changing a skill a person wrote asks them first.'
export const SKILL_WRITE_PARAMS = {
  name: 'Lowercase letters, digits and dashes, at most 64 characters; SKILL.md\'s `name` must match.',
  harnesses: 'Which CLIs get it: any of claude, codex, muse, or ["all"] (default).',
  scope: 'workspace (default): threads in this thread\'s workspace. global: every thread.',
  files: 'The skill\'s text files, each { path, text, executable? }.',
  dir: 'Instead of files: a folder on this host holding the whole skill.'
} as const

export const SKILL_REMOVE_TOOL = 'skill_remove'
export const SKILL_REMOVE_DESCRIPTION = 'Remove a skill by name. Removing one a person wrote or imported asks them first.'
export const SKILL_REMOVE_PARAMS = {
  name: 'The skill\'s name.',
  scope: 'workspace (default): the one in this thread\'s workspace. global: the one every thread sees.'
} as const
