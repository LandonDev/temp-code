import type { AgentEvent, SessionMeta, ToolPreview } from '@shared/events'
import { BODY_OMIT_BYTES, KIB } from '@shared/wireBudgets'

/**
 * The seeded synthetic workload behind wire.perf.test.ts and
 * scripts/seed-wire.ts: a busy thread whose rows carry large tool outputs,
 * diffs, file reads, writes and html renders in the proportions the prod
 * snapshot showed on 2026-10-19, a fleet of subagents, and a shell of
 * thousands of threads. Deterministic for a seed, so numbers hold run to run.
 */

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  'the renderer folds rows into blocks while the server keeps the log and ships what the client asked for budget bytes seq tail page cursor frame deflate body omit fetch expand store diff output shell'.split(
    ' '
  )

export function words(r: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)])
  return out.join(' ')
}

/** About `bytes` of text in lines of 40 to 100 characters. */
export function body(r: () => number, bytes: number): string {
  const lines: string[] = []
  let size = 0
  while (size < bytes) {
    const line = words(r, 6 + Math.floor(r() * 10))
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

/** Log-uniform between lo and hi bytes. */
export function logUniform(r: () => number, lo: number, hi: number): number {
  return Math.round(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))))
}

/** The size of a tool output: 60% small, 25% medium, 15% large (2 KiB to
 *  200 KiB), the shape the prod snapshot showed on 2026-10-19. */
export function outputBytes(r: () => number): number {
  const p = r()
  if (p < 0.6) return Math.floor(r() * 400)
  if (p < 0.85) return 400 + Math.floor(r() * 1600)
  return logUniform(r, BODY_OMIT_BYTES, 200 * KIB)
}

export function diffLines(r: () => number, n: number): NonNullable<ToolPreview['lines']> {
  return Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    kind: r() < 0.5 ? ('add' as const) : r() < 0.3 ? ('del' as const) : ('context' as const),
    text: words(r, 4 + Math.floor(r() * 8))
  }))
}

export const meta = (id: string, patch: Partial<SessionMeta>): SessionMeta => ({
  id,
  parentId: null,
  projectId: 'p1',
  workspaceId: 'w1',
  threadType: 'implementation',
  planPath: null,
  provider: 'claude',
  model: 'claude-opus-5-5',
  reasoning: 'high',
  agentType: 'implementer',
  title: id,
  cwd: '/Users/someone/IdeaProjects/project',
  status: 'idle',
  pinned: false,
  archived: false,
  fast: false,
  ultrafast: false,
  context1m: true,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  threadRules: null,
  permission: 'edits',
  nativeId: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch
})

/** The busy thread: `count` rows of prompts, thinking, assistant text and
 *  tool calls with outputs, diffs, file reads, writes and one html render
 *  per hundred rows. */
export function busyRows(r: () => number, count: number): AgentEvent[] {
  const out: AgentEvent[] = []
  let call = 0
  let turn = 0
  while (out.length < count) {
    out.push({ type: 'user-text', text: words(r, 20 + Math.floor(r() * 40)) })
    const msg = `m${turn++}`
    for (let i = 0; i < 6; i++) out.push({ type: 'thinking', text: words(r, 8), delta: true, msgId: msg, blockIndex: 0 })
    out.push({ type: 'thinking', text: words(r, 48), delta: false, msgId: msg, blockIndex: 0 })
    const tools = 10 + Math.floor(r() * 30)
    for (let t = 0; t < tools && out.length < count - 4; t++) {
      const id = `c${call++}`
      const p = r()
      if (p < 0.45) {
        out.push({ type: 'tool-call', callId: id, name: 'Bash', input: { command: words(r, 6), description: words(r, 4) } })
        out.push({ type: 'tool-result', callId: id, output: body(r, outputBytes(r)), isError: r() < 0.05 })
      } else if (p < 0.65) {
        out.push({ type: 'tool-call', callId: id, name: 'Read', input: { file_path: `/src/${words(r, 1)}.ts` } })
        out.push({ type: 'tool-result', callId: id, output: body(r, logUniform(r, 1 * KIB, 60 * KIB)), isError: false })
      } else if (p < 0.85) {
        const lines = 2 + Math.floor(r() * 120)
        const oldText = body(r, lines * 30)
        const newText = body(r, lines * 34)
        out.push({
          type: 'tool-call',
          callId: id,
          name: 'Edit',
          input: { file_path: `/src/${words(r, 1)}.tsx`, old_string: oldText, new_string: newText },
          preview: { kind: 'write', path: `/src/x.tsx`, additions: lines, deletions: lines, lines: diffLines(r, 2 * lines) }
        })
        out.push({ type: 'tool-result', callId: id, output: 'ok', isError: false })
      } else if (p < 0.97) {
        out.push({
          type: 'tool-call',
          callId: id,
          name: 'Write',
          input: { file_path: `/src/${words(r, 1)}.ts`, content: body(r, logUniform(r, 500, 40 * KIB)) }
        })
        out.push({ type: 'tool-result', callId: id, output: 'written', isError: false })
      } else {
        out.push({
          type: 'tool-call',
          callId: id,
          name: 'mcp__app__html_render',
          input: { title: words(r, 3), height: 600, html: `<!doctype html><style>${body(r, 4 * KIB)}</style><body>${body(r, 16 * KIB)}</body>` }
        })
        out.push({ type: 'tool-result', callId: id, output: JSON.stringify({ htmlRender: { sessionId: 's', pageId: id }, message: 'shown' }), isError: false })
      }
      for (let i = 0; i < 4; i++) out.push({ type: 'assistant-text', text: words(r, 6), delta: true, msgId: `${msg}.${t}`, blockIndex: 1 })
      out.push({ type: 'assistant-text', text: words(r, 24), delta: false, msgId: `${msg}.${t}`, blockIndex: 1 })
    }
    out.push({ type: 'turn-complete', costUsd: 0.5, inputTokens: 100_000, outputTokens: 4_000 })
  }
  return out.slice(0, count)
}

