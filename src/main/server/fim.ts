import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * AI ghost text (docs/PLAN-3.md M14): fill-in-the-middle through the Claude
 * Agent SDK against the user's existing auth — the app holds no
 * credentials. One implementation behind a provider-shaped interface; the
 * renderer debounces (≥400 ms idle) and cancels on keystroke, so this side
 * is a plain request with a small cache.
 */

const CACHE_MAX = 200
const cache = new Map<string, string | null>()

const hash = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Bound the context: the model needs the neighborhood, not the file. */
const tail = (s: string, n: number): string => (s.length > n ? s.slice(s.length - n) : s)
const head = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

export async function fimComplete(
  cwd: string,
  path: string,
  prefix: string,
  suffix: string
): Promise<string | null> {
  const key = `${path}:${hash(tail(prefix, 2000))}:${hash(head(suffix, 1000))}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const prompt = `Complete the code at <CURSOR>. Reply with ONLY the text to insert — no prose, no markdown fences, no repetition of the surrounding code. Keep it short: finish the current statement or block, at most ~6 lines. If nothing useful fits, reply with the single word NONE.

File: ${path}
\`\`\`
${tail(prefix, 2000)}<CURSOR>${head(suffix, 1000)}
\`\`\``
  let text = ''
  try {
    const q = query({
      prompt,
      options: {
        cwd,
        model: 'claude-sonnet-5-5',
        maxTurns: 1,
        allowedTools: [],
        systemPrompt: 'You are a code completion engine. Output only code.',
        settingSources: []
      }
    })
    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') text = msg.result
    }
  } catch {
    return null // ghost text is a bonus — never an error surface
  }
  let out: string | null = text.trim()
  if (!out || out === 'NONE') out = null
  // Strip a fence if the model ignored instructions.
  if (out?.startsWith('```')) {
    out = out.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
  }
  if (cache.size > CACHE_MAX) cache.clear()
  cache.set(key, out)
  return out
}
