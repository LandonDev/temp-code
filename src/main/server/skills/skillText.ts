import { createHash } from 'node:crypto'
import { remapper, stripSlash, type HistoryMapping } from '../pathMap'
import { invertMapping } from '../remote/memorySet'
import { translatable } from '../remote/harnessSet'
import type { StoredFile } from '../skillStore'

/**
 * The paths inside a skill's text, as each host writes it out (skills/
 * materialize.ts). Skills name absolute home paths, and several name their
 * own install folder (`~/.codex/skills/build-cosmic-frontend/scripts/…`):
 * harness sync rewrote those when it landed a file, and the materializer
 * does the same, so nothing is lost when harness sync retires.
 *
 * Two passes: the other host's paths become this host's (the map memory
 * sync reads, per heard peer), then `<home|~|$HOME|${HOME}>/<root>/<name>`
 * for a skill of the view becomes the view's stable folder. Anything else
 * stays as written.
 */

/** Every folder a CLI reads skills from, relative to HOME. */
export const SKILL_ROOTS = ['.claude/skills', '.codex/skills', '.agents/skills', '.config/muse/skills'] as const

export interface TextContext {
  /** this host's home */
  home: string
  /** skillTextMap(): other hosts' paths → this host's */
  textMap: HistoryMapping
  /** `<root>/<provider>/<view>/skills`: the stable symlinked path, never a generation's */
  viewSkillsDir: string
  /** the skills of this view */
  names: ReadonlySet<string>
}

/**
 * The map other hosts' text lands under: memory sync's two-way rule
 * (MemorySync.translationFor) for each peer it has heard, merged (each
 * starts at its own host's home, so they cannot clash); with no peer heard
 * yet, the base map read this host's way (forward off darwin, inverted on
 * the Mac).
 */
export function skillTextMap(input: {
  platform: string
  base: HistoryMapping
  peers: readonly { environmentId?: string; home: string; workRoot?: string }[]
  translate: (senderHome: string, senderWorkRoot?: string) => HistoryMapping
}): HistoryMapping {
  if (input.peers.length === 0) return input.platform === 'darwin' ? invertMapping(input.base) : { roots: { ...input.base.roots }, prefixes: { ...input.base.prefixes } }
  const out: HistoryMapping = { roots: {}, prefixes: {} }
  const peers = [...input.peers].sort((a, b) => ((a.environmentId ?? a.home) < (b.environmentId ?? b.home) ? -1 : 1))
  for (const peer of peers) {
    const map = input.translate(peer.home, peer.workRoot)
    for (const [from, to] of Object.entries(map.roots)) if (!(from in out.roots)) out.roots[from] = to
    for (const [from, to] of Object.entries(map.prefixes)) if (!(from in out.prefixes)) out.prefixes[from] = to
  }
  return out
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ROOTS = SKILL_ROOTS.map(escapeRe).join('|')

const pattern = (home: string): RegExp =>
  // A path boundary before the home spelling, a skill name after the root, and a boundary after the name.
  new RegExp(`(?<![A-Za-z0-9_.\\-/~$])(${escapeRe(stripSlash(home))}|~|\\$HOME|\\$\\{HOME\\})/(${ROOTS})/([a-z0-9][a-z0-9-]{0,63})(?=[/\\s"'\`)\\]]|$)`, 'g')

/** Each `<home|~|$HOME|${HOME}>/<root>/<name>` in `text` replaced by `to(name)`, or left as written when it answers null. */
export function rewriteSkillPaths(text: string, home: string, to: (name: string) => string | null): string {
  return text.replace(pattern(home), (whole, _home: string, _root: string, name: string) => to(name) ?? whole)
}

/** Every skill name the second pass could rewrite in `text`, sorted, once each. */
export function mentionedSkills(text: string, home: string): string[] {
  const names = new Set<string>()
  for (const m of text.matchAll(pattern(home))) names.add(m[3]!)
  return [...names].sort()
}

/** Both passes over one text. */
export function localizeSkillText(text: string, ctx: TextContext): string {
  return rewriteSkillPaths(remapper(ctx.textMap).text(text), ctx.home, (name) => (ctx.names.has(name) ? `${stripSlash(ctx.viewSkillsDir)}/${name}` : null))
}

/** The first 12 hex of the sha256 of what the text of a view depends on beyond its skills: the map, the home and the view's folder. */
export function textKey(ctx: Omit<TextContext, 'names'>): string {
  const sorted = (t: Record<string, string>): [string, string][] => Object.entries(t).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const key = JSON.stringify([sorted(ctx.textMap.roots), sorted(ctx.textMap.prefixes), stripSlash(ctx.home), stripSlash(ctx.viewSkillsDir)])
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

// The BOM, when there is one, stays in the string so a rewritten file keeps it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** The file's text when the rewrite reads it (translatable by name and size, valid UTF-8), else null. */
export function skillFileText(f: Pick<StoredFile, 'path' | 'bytes'>): string | null {
  if (!translatable(f.path, f.bytes.length)) return null
  try {
    return utf8.decode(f.bytes)
  } catch {
    return null
  }
}

/** One stored file as this host writes it out, and the skill names its text mentions after the first pass (the manifest keeps them). */
export function localizeSkillFile(f: StoredFile, ctx: TextContext): { file: StoredFile; mentions: string[] } {
  const text = skillFileText(f)
  if (text === null) return { file: f, mentions: [] }
  const remapped = remapper(ctx.textMap).text(text)
  const mentions = mentionedSkills(remapped, ctx.home)
  const out = rewriteSkillPaths(remapped, ctx.home, (name) => (ctx.names.has(name) ? `${stripSlash(ctx.viewSkillsDir)}/${name}` : null))
  return { file: out === text ? f : { ...f, bytes: encoder.encode(out) }, mentions }
}
