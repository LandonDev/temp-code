/**
 * M1 verification: dump the raw Agent SDK stream for a prompt that triggers
 * text + a tool call, so the driver mapping is checked against reality,
 * not against type declarations. Run: bun run script:sdk-dump
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = mkdtempSync(join(tmpdir(), 'tc-sdk-'))
writeFileSync(join(cwd, 'test.txt'), 'the secret word is PLUM\n')

function trim(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + `…(${v.length})` : v
  if (Array.isArray(v)) return v.map((x) => trim(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = trim(val, depth + 1)
    return out
  }
  return v
}

async function* prompts(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Read test.txt in your cwd with the Read tool, then reply with exactly: "word: <the secret word>". Nothing else.'
        }
      ]
    },
    parent_tool_use_id: null,
    session_id: ''
  }
}

const q = query({
  prompt: prompts(),
  options: {
    model: 'claude-sonnet-5',
    cwd,
    effort: 'low',
    includePartialMessages: true,
    permissionMode: 'acceptEdits'
  }
})

for await (const msg of q) {
  console.log(JSON.stringify(trim(msg)))
  if (msg.type === 'result') break
}
process.exit(0)
