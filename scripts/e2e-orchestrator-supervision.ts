/**
 * M7 exit test (docs/PLAN-2.md): orchestrator supervision. Calls the
 * orchestrator MCP tool handlers directly against a live registry — real
 * child sessions, no orchestrator model in the loop, so every check is
 * deterministic. Covers: spawn returns title; wait_for_agent returns only
 * the latest turn; check_agent shows a running child's tool trail; a
 * waiting child surfaces its pending question and answer_agent resolves
 * it; wait mode "any" returns the first finisher; interrupt_agent stops a
 * long child; agentId tools refuse non-children.
 * Run: bun run script:e2e-supervision
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import {
  latestTurnRows,
  orchestratorMcp,
  pendingOf,
  setOrchestrationRegistry,
  toolLinesOf,
  turnText
} from '../src/main/server/orchestration'
import type { EventRow, SessionMeta } from '../src/shared/events'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-sup-')), 'sup.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── pure helpers on a synthetic log ──────────────────────────────────
const row = (event: EventRow['event'], seq: number): EventRow => ({
  sessionId: 'x',
  seq,
  ts: seq,
  event
})
const synthetic: EventRow[] = [
  row({ type: 'user-text', text: 'turn one' }, 1),
  row({ type: 'assistant-text', text: 'OLD ANSWER', delta: false }, 2),
  row({ type: 'user-text', text: 'turn two' }, 3),
  row({ type: 'tool-call', callId: 'c1', name: 'Edit', input: { file_path: 'src/foo.ts' } }, 4),
  row({ type: 'tool-call', callId: 'c2', name: 'Bash', input: { command: 'npm test' } }, 5),
  row({ type: 'tool-result', callId: 'c2', output: 'boom', isError: true }, 6),
  row(
    {
      type: 'question-request',
      requestId: 'q1',
      questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]
    },
    7
  ),
  row({ type: 'assistant-text', text: 'NEW ANSWER', delta: false }, 8)
]
const turn = latestTurnRows(synthetic)
check('latestTurnRows slices after the last user-text', turn.length === 5 && turn[0].seq === 4)
check('turnText excludes earlier turns', turnText(turn) === 'NEW ANSWER')
const lines = toolLinesOf(turn)
check(
  'toolLinesOf renders paths and failures',
  lines.join('|') === 'Edit src/foo.ts|Bash: npm test (failed)',
  lines.join('|')
)
const pending = pendingOf(turn)
check(
  'pendingOf finds the unresolved question',
  pending?.kind === 'question' && pending.requestId === 'q1'
)
const resolvedLog = [
  ...synthetic,
  row({ type: 'question-resolved', requestId: 'q1', answers: [['A']] }, 9)
]
check('pendingOf clears once resolved', pendingOf(latestTurnRows(resolvedLog)) === null)

// ── live tools ───────────────────────────────────────────────────────
const cwd = mkdtempSync(join(tmpdir(), 'tc-sup-cwd-'))
// Synthetic parent: the MCP factory only needs its identity; no harness boots.
const parent: SessionMeta = {
  id: 'sup-parent',
  parentId: null,
  projectId: null,
  threadType: null,
  planPath: null,
  provider: 'claude',
  model: 'claude-sonnet-5',
  reasoning: 'low',
  agentType: 'orchestrator',
  title: 'supervisor',
  cwd,
  status: 'idle',
  archived: false,
  permission: 'edits',
  nativeId: null,
  createdAt: Date.now(),
  updatedAt: Date.now()
}

interface ToolReg {
  handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>
}
const mcp = orchestratorMcp(parent)
const tools = (mcp.instance as unknown as { _registeredTools: Record<string, ToolReg> })
  ._registeredTools
// Direct handler calls bypass zod defaults — always pass every arg.
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await tools[name].handler(args, {})
  return res.content[0].text
}
const spawn = (task: string, provider = 'claude'): Promise<string> =>
  call('spawn_agent', {
    provider,
    model: provider === 'claude' ? 'claude-sonnet-5' : undefined,
    reasoning: 'low',
    agentType: 'implementer',
    task,
    useWorktree: false
  })
const wait = (ids: string[], timeoutSeconds = 240, mode = 'any'): Promise<string> =>
  call('wait_for_agent', { agentIds: ids, mode, timeoutSeconds })

// Guard: agentId tools refuse ids that are not this session's children.
const refusal = await call('send_to_agent', { agentId: 'not-a-child', message: 'hi' })
check('send_to_agent refuses non-children', refusal.startsWith('refused'), refusal)

// Spawn → title returned; wait → reply is the latest turn only.
const s1 = JSON.parse(await spawn('Reply with exactly: ALPHA DONE 111'))
check('spawn_agent returns title', s1.title === 'Reply with exactly: ALPHA DONE 111', s1.title)
const w1 = JSON.parse(await wait([s1.agentId]))
check(
  'wait returns the reply',
  w1.agentId === s1.agentId && w1.reply.includes('ALPHA DONE 111'),
  w1.reply
)
await call('send_to_agent', {
  agentId: s1.agentId,
  message: 'Now reply with exactly: BETA DONE 222'
})
const w2 = JSON.parse(await wait([s1.agentId]))
check(
  'second wait: latest turn only',
  w2.reply.includes('BETA DONE 222') && !w2.reply.includes('ALPHA DONE 111'),
  w2.reply
)
const chk1 = JSON.parse(await call('check_agent', { agentId: s1.agentId }))
check('check_agent reports tokens', chk1.tokens.output > 0, JSON.stringify(chk1.tokens))
check('check_agent reports title/status', chk1.title === s1.title && chk1.status === 'idle')

// Waiting child: pending question surfaces; answer_agent resolves it.
const s2 = JSON.parse(
  await spawn(
    'Use the AskUserQuestion tool to ask me exactly one question: "Which color?" with options "Red" and "Blue". After I answer, reply with exactly: COLOR <my answer> END'
  )
)
const w3 = JSON.parse(await wait([s2.agentId]))
check(
  'wait surfaces waiting + pending question',
  w3.status === 'waiting' && w3.pending?.kind === 'question',
  JSON.stringify(w3).slice(0, 200)
)
const badAnswer = await call('answer_agent', {
  agentId: s2.agentId,
  requestId: 'wrong-id',
  answers: [['Red']]
})
check('answer_agent refuses a wrong requestId', badAnswer.startsWith('refused'), badAnswer)
await call('answer_agent', {
  agentId: s2.agentId,
  requestId: w3.pending.requestId,
  answers: [['Red']]
})
const w4 = JSON.parse(await wait([s2.agentId]))
check(
  'answered child completes with the answer',
  w4.status === 'idle' && /red/i.test(w4.reply),
  w4.reply
)

// mode any returns the first finisher; check_agent sees a live tool trail;
// interrupt_agent stops the straggler.
const fast = JSON.parse(await spawn('Reply with exactly: FAST-1', 'codex'))
const slow = JSON.parse(
  await spawn('Use your shell tool to run exactly `sleep 90`, then reply with exactly: SLOW-1')
)
const w5 = JSON.parse(await wait([slow.agentId, fast.agentId], 240))
check('mode any returns the first finisher', w5.agentId === fast.agentId, w5.agentId)
let trail: string[] = []
for (let i = 0; i < 120 && trail.length === 0; i++) {
  const c = JSON.parse(await call('check_agent', { agentId: slow.agentId }))
  trail = (c.currentTurn.toolCalls as string[]).filter((l) => l.includes('sleep'))
  if (trail.length === 0) await new Promise((r) => setTimeout(r, 1000))
}
check('check_agent shows the running tool trail', trail.length > 0, trail.join('|'))
await call('interrupt_agent', { agentId: slow.agentId })
const w6 = JSON.parse(await wait([slow.agentId], 60))
check(
  'interrupt settles the child',
  w6.agentId === slow.agentId && w6.status !== 'timeout',
  w6.status
)

const listed = JSON.parse(await call('list_agents', {}))
check(
  'list_agents carries title and idleForSeconds',
  listed.length === 4 &&
    listed.every((a: { title: string; idleForSeconds: number }) => a.title && a.idleForSeconds >= 0)
)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
