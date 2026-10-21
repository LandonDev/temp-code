import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ProviderId } from '@shared/catalog'
import type { SlashCommand } from '@shared/domain'

/**
 * Slash-command discovery: what `/name` means to each harness, read from
 * the same directories the harnesses themselves scan. User-level and
 * project-level sources both count; project wins on a name collision.
 *
 *   claude: ~/.claude/skills/<name>/SKILL.md + <cwd>/.claude/skills,
 *           ~/.claude/skills/synced/<bucket>/<name>/SKILL.md (account-synced
 *           skills, named `anthropic-skills:<name>` as the CLI names them),
 *           ~/.claude/commands/*.md + <cwd>/.claude/commands
 *   codex:  ~/.codex/skills/<name>/SKILL.md + ~/.codex/skills/.system/<name>,
 *           ~/.codex/prompts/*.md
 *   cursor: ~/.cursor/commands/*.md + <cwd>/.cursor/commands
 *
 * Every layout has a fixed depth; nothing here recurses. Dot-entries
 * (`.system` aside, read on purpose) are bookkeeping: `.bucket-…`,
 * `.last-complete-round`, `.trash`, `.codex-system-skills.marker`.
 *
 * Claude plugins (~/.claude/plugins) are not read: there is no
 * installed-plugins layout to key off on either host, only the CLI's
 * directory cache and an empty synced bucket.
 */

export type { SlashCommand }

/** description: from YAML frontmatter, else the first non-frontmatter line. */
function describe(md: string): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---/)
  const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]
  if (desc) return desc.replace(/^["']|["']$/g, '').trim()
  const body = fm ? md.slice(fm[0].length) : md
  return (
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'))
      ?.slice(0, 120) ?? ''
  )
}

/** `name:` from YAML frontmatter, unquoted. */
function frontmatterName(md: string): string | undefined {
  const fm = md.match(/^---\n([\s\S]*?)\n---/)
  const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]
  return name ? name.replace(/^["']|["']$/g, '').trim() || undefined : undefined
}

/** The prefix Claude Code gives account-synced skills; the bare name is
 *  not always accepted (the CLI drops it when it cannot rule out a
 *  collision), the prefixed one always is. */
export const SYNCED_SKILL_PREFIX = 'anthropic-skills:'

type SkillLayout = {
  /** Claude: also read `<dir>/synced/<bucket>/<name>/SKILL.md`. */
  synced?: boolean
  /** Codex: also read `<dir>/.system/<name>/SKILL.md`. */
  system?: boolean
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  // Skill dirs are often symlinks (e.g. ~/.codex/skills → ~/.agents) —
  // don't gate on dirent type beyond "not a plain file"; the read decides.
  return entries.filter((e) => !e.isFile() && !e.name.startsWith('.')).map((e) => e.name)
}

async function flatSkillsIn(dir: string, scope: SlashCommand['scope']): Promise<SlashCommand[]> {
  const out: SlashCommand[] = []
  for (const name of await subdirs(dir)) {
    const path = join(dir, name, 'SKILL.md')
    const md = await readFile(path, 'utf8').catch(() => null)
    if (md !== null) out.push({ name, description: describe(md), source: 'skill', scope, path })
  }
  return out
}

type ManifestSkill = { skillId?: unknown; name?: unknown; description?: unknown }

/** A synced bucket's manifest.json, keyed by skillId and by name. */
async function bucketManifest(bucket: string): Promise<Map<string, ManifestSkill>> {
  const byKey = new Map<string, ManifestSkill>()
  const raw = await readFile(join(bucket, 'manifest.json'), 'utf8').catch(() => null)
  if (!raw) return byKey
  try {
    const parsed = JSON.parse(raw) as { skills?: unknown }
    if (!Array.isArray(parsed.skills)) return byKey
    for (const s of parsed.skills as ManifestSkill[]) {
      if (!s || typeof s !== 'object') continue
      if (typeof s.skillId === 'string') byKey.set(s.skillId, s)
      if (typeof s.name === 'string' && !byKey.has(s.name)) byKey.set(s.name, s)
    }
  } catch {
    // A torn manifest falls back to each SKILL.md's frontmatter.
  }
  return byKey
}

/** `<dir>/<bucket>/<name>/SKILL.md`: exactly two levels, never deeper. */
async function syncedSkillsIn(dir: string, scope: SlashCommand['scope']): Promise<SlashCommand[]> {
  const out: SlashCommand[] = []
  for (const bucketName of await subdirs(dir)) {
    const bucket = join(dir, bucketName)
    const manifest = await bucketManifest(bucket)
    for (const entry of await subdirs(bucket)) {
      const path = join(bucket, entry, 'SKILL.md')
      const md = await readFile(path, 'utf8').catch(() => null)
      if (md === null) continue
      const meta = manifest.get(entry)
      const name =
        (typeof meta?.name === 'string' && meta.name.trim()) || frontmatterName(md) || entry
      const description =
        (typeof meta?.description === 'string' && meta.description.trim()) || describe(md)
      out.push({ name: `${SYNCED_SKILL_PREFIX}${name}`, description, source: 'skill', scope, path })
    }
  }
  return out
}

async function skillsIn(
  dir: string,
  scope: SlashCommand['scope'],
  layout: SkillLayout = {}
): Promise<SlashCommand[]> {
  const groups = await Promise.all([
    flatSkillsIn(dir, scope),
    layout.synced ? syncedSkillsIn(join(dir, 'synced'), scope) : [],
    layout.system ? flatSkillsIn(join(dir, '.system'), scope) : []
  ])
  // The plain directory comes first, so a user's own skill shadows a
  // system skill of the same name (first one wins in listCommands).
  return groups.flat()
}

async function mdFilesIn(
  dir: string,
  source: SlashCommand['source'],
  scope: SlashCommand['scope']
): Promise<SlashCommand[]> {
  const entries = await readdir(dir).catch(() => [])
  const out: SlashCommand[] = []
  for (const f of entries) {
    if (!f.endsWith('.md')) continue
    const path = join(dir, f)
    const md = await readFile(path, 'utf8').catch(() => null)
    if (md !== null) {
      out.push({ name: basename(f, '.md'), description: describe(md), source, scope, path })
    }
  }
  return out
}

/** Addons the provider itself has configured: codex plugins + MCP
 *  servers (config.toml), claude MCP servers (~/.claude.json). Minimal
 *  parses — names and enablement only, never the full config. */
async function codexAddons(): Promise<SlashCommand[]> {
  const toml = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8').catch(() => '')
  const out: SlashCommand[] = []
  // Section-scan: header then flags until the next header.
  const sections = toml.split(/^\[/m)
  for (const sec of sections) {
    const disabled = /^enabled\s*=\s*false/m.test(sec)
    const plugin = sec.match(/^plugins\."([^"@]+)(?:@[^"]*)?"\]/)
    if (plugin && !disabled) {
      out.push({ name: plugin[1], description: 'Codex plugin', source: 'plugin', scope: 'user' })
      continue
    }
    const mcp = sec.match(/^mcp_servers\.([\w."-]+?)\]/)
    if (mcp && !disabled && !mcp[1].includes('.')) {
      const name = mcp[1].replace(/"/g, '')
      out.push({ name, description: 'MCP server', source: 'mcp', scope: 'user' })
    }
  }
  return out
}

async function claudeAddons(): Promise<SlashCommand[]> {
  const raw = await readFile(join(homedir(), '.claude.json'), 'utf8').catch(() => null)
  if (!raw) return []
  try {
    const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    return Object.keys(cfg.mcpServers ?? {}).map((name) => ({
      name,
      description: 'MCP server',
      source: 'mcp' as const,
      scope: 'user' as const
    }))
  } catch {
    return []
  }
}

const cache = new Map<string, { at: number; commands: SlashCommand[] }>()
const CACHE_MS = 30_000

export async function listCommands(provider: ProviderId, cwd: string): Promise<SlashCommand[]> {
  const key = `${provider}:${cwd}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.commands

  const home = homedir()
  const groups = await Promise.all(
    provider === 'claude'
      ? [
          skillsIn(join(home, '.claude', 'skills'), 'user', { synced: true }),
          skillsIn(join(cwd, '.claude', 'skills'), 'project'),
          mdFilesIn(join(home, '.claude', 'commands'), 'command', 'user'),
          mdFilesIn(join(cwd, '.claude', 'commands'), 'command', 'project'),
          claudeAddons()
        ]
      : provider === 'codex'
        ? [
            skillsIn(join(home, '.codex', 'skills'), 'user', { system: true }),
            mdFilesIn(join(home, '.codex', 'prompts'), 'prompt', 'user'),
            codexAddons()
          ]
        : [
            mdFilesIn(join(home, '.cursor', 'commands'), 'command', 'user'),
            mdFilesIn(join(cwd, '.cursor', 'commands'), 'command', 'project')
          ]
  )
  // Project scope shadows user scope on the same name.
  const byName = new Map<string, SlashCommand>()
  for (const c of groups.flat()) {
    const cur = byName.get(c.name)
    if (!cur || (cur.scope === 'user' && c.scope === 'project')) byName.set(c.name, c)
  }
  const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  cache.set(key, { at: Date.now(), commands })
  return commands
}
