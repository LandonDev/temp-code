/**
 * The iPhone performance proof's fixtures (docs/IOS-DESIGN.md "Performance",
 * `TC_PROOF_SET=perf`): a long agent thread's mix of rows as events, made
 * from a seed so every run measures the same thread. Pure: the test server
 * appends what `perfThread` answers (scripts/ios-client-test-server.ts,
 * under TC_TEST_PERF_SEEDS=1), and scripts/ios-perf-seeds.test.ts holds the
 * counts and the mix.
 *
 * One event is one wire row. A turn is the person's message, then groups of
 * 3 to 40 tool calls (reads, shell commands with output up to 2 KiB, edits
 * of 20 to 400 lines, each call and its result two rows) with a thought, a
 * todo update or a subagent's spawn and report between them, a reply of
 * 300 to 4,000 bytes after each group (code fences, tables and lists among
 * them), and `turn-complete`.
 */
import type { AgentEvent } from '../../src/shared/events'

/** The LCG the stream and the desktop's smoothText tests use: the same seed plays the same thread. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export interface PerfThread {
  /** Wire rows, exactly. */
  rows: number
  turns: number
  seed: number
}

/** The threads the perf set opens, by the title part its launch names. */
export const PERF_THREADS = {
  build: { id: 'ios-perf-build', title: 'Perf build, 12,000 rows', type: 'implementation', rows: 12_000, turns: 6, seed: 11 },
  chat: { id: 'ios-perf-chat', title: 'Perf chat, 2,600 rows', type: 'chat', rows: 2_600, turns: 40, seed: 12 },
  short: { id: 'ios-perf-short', title: 'Perf short, 600 rows', type: 'implementation', rows: 600, turns: 2, seed: 13 },
  rest: { id: 'ios-perf-rest', title: 'Perf rest, 300 rows', type: 'chat', rows: 300, turns: 3, seed: 14 },
  master: { id: 'ios-perf-master', title: 'Perf master, 8 children', type: 'chat', rows: 800, turns: 8, seed: 15 }
} as const

/** The master's batch children, the sessions outside the shown project that `/load` moves, and the shown project's sibling. */
export const PERF_CHILDREN = Array.from({ length: 8 }, (_, i) => `ios-perf-child-${i + 1}`)
export const PERF_LOAD = Array.from({ length: 12 }, (_, i) => `ios-perf-load-${i + 1}`)
export const PERF_SIBLING = 'ios-perf-sibling'

const FILES = ['src/main/server/sessions.ts', 'src/main/server/gateway.ts', 'src/renderer/src/lib/tcserver/fold.ts', 'src/shared/events.ts', 'ios/TempCodeClient/Sources/TempCodeClient/Rendering/ThreadFold.swift', 'scripts/gate.ts', 'docs/box.md', 'src/main/server/remote/listener.ts']
const COMMANDS = ['bun run typecheck', 'NODE_ENV=test bunx vitest run src/main/server/sessions.test.ts', 'git status --short', 'rg -n "busySince" src', 'git diff --stat', 'bun scripts/gate.ts commit']
const SENTENCES = [
  'The registry folds each event into the session row before the push leaves.',
  'A meta that did not change is dropped at the coalescer, so the phone hears nothing.',
  'The fold keeps one index per call id; a late result finds its call without a scan.',
  'Every page is asked from the cursor the cache kept, never from the top.',
  'The gate ran green on the merged tree, with the two flaky rows repeated once.',
  'Nothing in the transcript moves when a row lands above the reader.'
]

/** `bytes` of prose: paragraphs, and now and then a list, a table or a code fence. */
function reply(rand: () => number, bytes: number): string {
  const parts: string[] = []
  let size = 0
  while (size < bytes) {
    const kind = rand()
    let part: string
    if (kind < 0.12) {
      part = '```ts\n' + Array.from({ length: 3 + Math.floor(rand() * 10) }, (_, i) => `const step${i} = await forward(request, { hop: ${i} })`).join('\n') + '\n```'
    } else if (kind < 0.2) {
      part = '| File | Change | Lines |\n| --- | --- | --- |\n' + Array.from({ length: 2 + Math.floor(rand() * 4) }, (_, i) => `| \`${FILES[(i + Math.floor(rand() * 8)) % FILES.length]}\` | the ${i % 2 ? 'fold' : 'push'} path | ${10 + Math.floor(rand() * 200)} |`).join('\n')
    } else if (kind < 0.35) {
      part = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => `- ${SENTENCES[Math.floor(rand() * SENTENCES.length)]}`).join('\n')
    } else {
      part = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => SENTENCES[Math.floor(rand() * SENTENCES.length)]).join(' ').replace('registry', '**registry**').replace('cursor', '`cursor`')
    }
    parts.push(part)
    size += part.length + 2
  }
  return parts.join('\n\n')
}

/** A tool call and its result: a read, a shell command or an edit. */
function call(rand: () => number, id: string): AgentEvent[] {
  const kind = rand()
  const path = FILES[Math.floor(rand() * FILES.length)]!
  const fileName = path.split('/').pop()
  if (kind < 0.5) {
    return [
      { type: 'tool-call', callId: id, name: 'Read', input: { file_path: path }, preview: { kind: 'read', path, fileName } },
      { type: 'tool-result', callId: id, output: Array.from({ length: 4 + Math.floor(rand() * 20) }, (_, i) => `export const line${i} = ${i}`).join('\n'), isError: false }
    ]
  }
  if (kind < 0.85) {
    const command = COMMANDS[Math.floor(rand() * COMMANDS.length)]!
    // Up to 2 KiB of output, most of it short.
    const bytes = Math.floor(2_048 * rand() ** 2)
    const lines: string[] = []
    for (let size = 0; size < bytes; size += 64) lines.push(` ✓ src/main/server/row-${lines.length}.test.ts (${1 + Math.floor(rand() * 40)} tests) ${Math.floor(rand() * 900)}ms`)
    return [
      // Backgrounded: the host's process guard leaves these calls alone. In the
      // foreground, the thread's closing idle ended some 2,800 of them at once,
      // and each end read every process on the Mac, for an hour.
      { type: 'tool-call', callId: id, name: 'Bash', input: { command, description: command, run_in_background: true }, preview: { kind: 'shell', title: command } },
      { type: 'tool-result', callId: id, output: lines.join('\n') || 'ok', isError: rand() < 0.04 }
    ]
  }
  // 20 to 400 lines, most of them near 20.
  const count = 20 + Math.floor(380 * rand() ** 3)
  const lines = Array.from({ length: count }, (_, i) => ({ kind: (i % 9 === 0 ? 'del' : i % 5 === 0 ? 'context' : 'add') as 'add' | 'del' | 'context', number: i + 1, text: `  const value${i} = await store.read(${i})` }))
  const additions = lines.filter((l) => l.kind === 'add').length
  const deletions = lines.filter((l) => l.kind === 'del').length
  return [
    {
      type: 'tool-call',
      callId: id,
      name: 'Edit',
      input: { file_path: path, old_string: lines.filter((l) => l.kind !== 'add').map((l) => l.text).join('\n'), new_string: lines.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n') },
      preview: { kind: 'write', path, fileName, additions, deletions, lines }
    },
    { type: 'tool-result', callId: id, output: `The file ${path} has been updated.`, isError: false }
  ]
}

/** `rows` events in `turns` turns, the last one closed and the thread idle. */
export function perfThread(id: string, { rows, turns, seed }: PerfThread): AgentEvent[] {
  const rand = lcg(seed)
  const out: AgentEvent[] = []
  let calls = 0
  let messages = 0
  const tasks = ['Read the fold', 'Move the trim', 'Index the calls', 'Write the tests', 'Run the gate']
  for (let turn = 0; turn < turns; turn++) {
    // Each turn ends at its share of the rows; the last one leaves a row for the idle status.
    const end = Math.floor((rows * (turn + 1)) / turns) - (turn === turns - 1 ? 1 : 0)
    const room = (): number => end - 2 - out.length
    out.push({ type: 'user-text', text: `Turn ${turn + 1}: ${SENTENCES[turn % SENTENCES.length]}`, ...(turn === 0 ? { newPass: true } : {}) })
    while (room() > 0) {
      const pick = rand()
      if (pick < 0.08 && room() >= 2) {
        const text = SENTENCES[Math.floor(rand() * SENTENCES.length)]!
        out.push({ type: 'thinking', text: text.slice(0, 12), delta: true, msgId: `${id}-t${messages}`, blockIndex: 0 }, { type: 'thinking', text, delta: false, msgId: `${id}-t${messages++}`, blockIndex: 0 })
      } else if (pick < 0.14) {
        const done = Math.floor(rand() * tasks.length)
        out.push({ type: 'tool-call', callId: `${id}-todo${calls++}`, name: 'TodoWrite', input: { todos: tasks.map((content, i) => ({ content, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' })) } })
      } else if (pick < 0.18 && room() >= 3) {
        const callId = `${id}-spawn${calls++}`
        out.push(
          { type: 'tool-call', callId, name: 'mcp__orchestrator__spawn_agent', input: { title: 'Map the push path', task: 'Read the listener and say where a push is coalesced.' } },
          { type: 'tool-result', callId, output: JSON.stringify({ agentId: `${id}-agent${calls}`, title: 'Map the push path' }), isError: false },
          { type: 'agent-report', agentId: `${id}-agent${calls}`, title: 'Map the push path', status: 'done' }
        )
      } else if (room() >= 7) {
        // A group of 3 to 40 calls, then what the agent says about it.
        const size = Math.min(3 + Math.floor(37 * rand() ** 2), Math.floor((room() - 1) / 2))
        for (let i = 0; i < size; i++) out.push(...call(rand, `${id}-c${calls++}`))
        out.push({ type: 'assistant-text', text: reply(rand, 300 + Math.floor(3_700 * rand() ** 2)), delta: false, msgId: `${id}-m${messages++}`, blockIndex: 0 })
      } else {
        out.push({ type: 'assistant-text', text: reply(rand, 300), delta: false, msgId: `${id}-m${messages++}`, blockIndex: 0 })
      }
    }
    out.push({ type: 'assistant-text', text: reply(rand, 300 + Math.floor(3_700 * rand() ** 2)), delta: false, msgId: `${id}-m${messages++}`, blockIndex: 0 })
    out.push({ type: 'turn-complete', costUsd: 0.4, inputTokens: 40_000, outputTokens: 6_000 })
  }
  out.push({ type: 'status', status: 'idle' })
  return out
}
