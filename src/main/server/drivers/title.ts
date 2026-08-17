import { tmpdir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * One-shot, tool-less title for a thread that fell back to its sliced
 * first message. Returns null when the call fails or the model wanders —
 * callers keep the fallback, nothing breaks.
 */
export async function generateTitle(firstMessage: string): Promise<string | null> {
  try {
    const q = query({
      prompt:
        'Title this coding-assistant thread in 3 to 6 plain words. ' +
        'Reply with the title only — no quotes, no trailing punctuation.\n\n' +
        `First message:\n${firstMessage.slice(0, 600)}`,
      options: { model: 'claude-sonnet-5', maxTurns: 1, cwd: tmpdir() }
    })
    for await (const m of q) {
      if (m.type === 'result' && m.subtype === 'success') {
        const t = m.result
          .trim()
          .replace(/^["'`]+|["'`.]+$/g, '')
          .trim()
        if (t && t.length <= 60 && !t.includes('\n')) return t
      }
    }
  } catch {
    // cosmetic feature — the sliced fallback stays
  }
  return null
}
