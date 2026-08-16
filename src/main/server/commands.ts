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
 *           ~/.claude/commands/*.md + <cwd>/.claude/commands
 *   codex:  ~/.codex/skills/<name>/SKILL.md, ~/.codex/prompts/*.md
 *   cursor: ~/.cursor/commands/*.md + <cwd>/.cursor/commands
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

async function skillsIn(dir: string, scope: SlashCommand['scope']): Promise<SlashCommand[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: SlashCommand[] = []
  for (const e of entries) {
    // Skill dirs are often symlinks (e.g. ~/.codex/skills → ~/.agents) —
    // don't gate on dirent type, just try the read.
    if (e.isFile()) continue
    const path = join(dir, e.name, 'SKILL.md')
    const md = await readFile(path, 'utf8').catch(() => null)
    if (md !== null) {
      out.push({ name: e.name, description: describe(md), source: 'skill', scope, path })
    }
  }
  return out
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
          skillsIn(join(home, '.claude', 'skills'), 'user'),
          skillsIn(join(cwd, '.claude', 'skills'), 'project'),
          mdFilesIn(join(home, '.claude', 'commands'), 'command', 'user'),
          mdFilesIn(join(cwd, '.claude', 'commands'), 'command', 'project'),
          claudeAddons()
        ]
      : provider === 'codex'
        ? [
            skillsIn(join(home, '.codex', 'skills'), 'user'),
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
