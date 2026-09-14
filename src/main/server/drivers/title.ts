import { tmpdir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { harnessEnv, resolveClaude } from './binaries'
import { oneShotBudget } from '../spawnBudget'

/**
 * One-shot, tool-less text from the Claude SDK: thread titles, commit
 * messages, PR bodies, branch names. Returns null when the call fails —
 * callers keep their fallback, nothing breaks. `cwd` lets the model see
 * the project's CLAUDE.md conventions; default is a scratch directory.
 * No MCP servers: the user's configured servers would each boot for a
 * call that uses no tools. Two of these run at a time (`oneShotBudget`).
 */
export function generateText(
  prompt: string,
  opts: { cwd?: string; model?: string } = {}
): Promise<string | null> {
  return oneShotBudget.run(() => generateNow(prompt, opts))
}

async function generateNow(
  prompt: string,
  opts: { cwd?: string; model?: string }
): Promise<string | null> {
  try {
    const cli = await resolveClaude()
    const q = query({
      prompt,
      options: {
        ...(cli.path ? { pathToClaudeCodeExecutable: cli.path } : {}),
        env: await harnessEnv(),
        model: opts.model ?? 'claude-sonnet-5',
        maxTurns: 1,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        cwd: opts.cwd ?? tmpdir()
      }
    })
    for await (const m of q) {
      if (m.type === 'result' && m.subtype === 'success') {
        const t = m.result.trim()
        return t || null
      }
    }
  } catch {
    // cosmetic features — the caller's fallback stays
  }
  return null
}

/**
 * Title for a thread that fell back to its sliced first message. Null
 * when the model wanders (too long, multi-line).
 */
export async function generateTitle(firstMessage: string): Promise<string | null> {
  const raw = await generateText(
    'Title this coding-assistant thread in 3 to 6 plain words. ' +
      'Reply with the title only — no quotes, no trailing punctuation.\n\n' +
      `First message:\n${firstMessage.slice(0, 600)}`
  )
  if (!raw) return null
  const t = raw.replace(/^["'`]+|["'`.]+$/g, '').trim()
  return t && t.length <= 60 && !t.includes('\n') ? t : null
}
