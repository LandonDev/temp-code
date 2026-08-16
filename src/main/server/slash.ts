import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProviderId } from '@shared/catalog'
import { listCommands } from './commands'

/**
 * Skill references work anywhere in a message, any number of them. The
 * harnesses don't do this themselves — claude parses only a LEADING
 * /command, codex and cursor parse none — so every /name token that names
 * a real skill/command/prompt is expanded here before the driver sends.
 * The transcript keeps the /name the user typed (sessions.ts logs first).
 */

const TOKEN = /(?<=^|\s)\/([\w-]+)(?=$|\s)/g

export async function expandSlashRefs(
  provider: ProviderId,
  cwd: string,
  text: string
): Promise<string> {
  if (!text.includes('/')) return text
  const commands = await listCommands(provider, cwd).catch(() => [])
  if (!commands.length) return text
  const byName = new Map(commands.map((c) => [c.name, c] as const))

  const seen = new Set<string>()
  const blocks: string[] = []
  for (const m of text.matchAll(TOKEN)) {
    const c = byName.get(m[1])
    if (!c || seen.has(c.name)) continue
    // Addons (plugins / MCP servers) have no file to inline — the tools
    // are already live in the harness; the model just needs pointing.
    if (c.source === 'plugin' || c.source === 'mcp') {
      seen.add(c.name)
      blocks.push(
        c.source === 'plugin'
          ? `Where the message says /${c.name}: use your "${c.name}" plugin (its tools are available to you) for that part of the request.`
          : `Where the message says /${c.name}: use the tools of your "${c.name}" MCP server for that part of the request.`
      )
      continue
    }
    if (!c.path) continue
    seen.add(c.name)
    // claude runs a leading /command natively — expanding it too would
    // invoke it twice.
    if (provider === 'claude' && m.index === 0) continue
    if (provider === 'claude' && c.source === 'skill') {
      // The Agent SDK loads skills properly (base dir, resources) through
      // its Skill tool — point at it instead of inlining.
      blocks.push(
        `Where the message says /${c.name}: invoke your "${c.name}" skill and follow it for that part of the request.`
      )
      continue
    }
    const body = await readFile(c.path, 'utf8').catch(() => null)
    if (!body) continue
    const baseNote =
      c.source === 'skill'
        ? `\n\n(Skill base directory: ${dirname(c.path)} — resolve relative paths against it.)`
        : ''
    blocks.push(
      `Where the message says /${c.name}, follow these instructions:\n\n<${c.name}>\n${body}\n</${c.name}>${baseNote}`
    )
  }
  return blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text
}
