/**
 * M10 exit test (docs/PLAN-2.md): app tools. Direct handler calls against
 * a live server: app_list_threads sees siblings; a planning thread starts
 * a codex implementation thread from its own plan (zero-config planPath)
 * whose reply quotes the plan's codeword; a chat starts a planning thread
 * seeded from two chats and the kickoff reply quotes both facts; a bad
 * model id is refused. Bridge: the stdio bridge speaks MCP and forwards to
 * the WS server; a real codex thread calls app_list_threads through it.
 * Run: bun run script:e2e-app-tools
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/main/server/index'
import { appToolsMcp } from '../src/main/server/apptools'
import type { AgentEvent, EventRow, SessionMeta } from '../src/shared/events'

const server = await startServer(join(mkdtempSync(join(tmpdir(), 'tc-app-')), 'app.db'))
const registry = server.registry

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function waitFor(
  sessionId: string,
  pred: (e: AgentEvent) => boolean,
  timeoutMs = 300_000
): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, 0).find((r) => pred(r.event))
    if (prior) return resolve(prior.event)
    const timer = setTimeout(() => {
      off()
      reject(new Error('timeout'))
    }, timeoutMs)
    const off = registry.subscribe(sessionId, (row: EventRow) => {
      if (pred(row.event)) {
        clearTimeout(timer)
        off()
        resolve(row.event)
      }
    })
  })
}
const settled = (id: string): Promise<AgentEvent> =>
  waitFor(id, (e) => e.type === 'turn-complete' || e.type === 'error')
const finalText = (id: string): string =>
  registry
    .eventsAfter(id, 0)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')

interface ToolReg {
  handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>
}
const toolsOf = (meta: SessionMeta): Record<string, ToolReg> =>
  (appToolsMcp(meta).instance as unknown as { _registeredTools: Record<string, ToolReg> })
    ._registeredTools
// Direct handler calls bypass zod defaults — pass every arg explicitly.
async function call(
  meta: SessionMeta,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const res = await toolsOf(meta)[name].handler(args, {})
  return res.content[0].text
}

const ws = await registry.createWorkspace(mkdtempSync(join(tmpdir(), 'tc-app-ws-')), 'app-ws')
const project = await registry.createProject(ws.id, 'Gamma', 'local')
const mk = (
  over: Partial<Parameters<typeof registry.create>[0]>
): ReturnType<typeof registry.create> =>
  registry.create({
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'edits',
    projectId: project.id,
    threadType: 'chat',
    parentId: null,
    ...over
  })

// ── list + read ──────────────────────────────────────────────────────
const chat1 = await mk({ title: 'main chat' })
const chat2 = await mk({ title: 'other chat' })
const listed = JSON.parse(await call(chat1, 'app_list_threads', { allProjects: false }))
check(
  'app_list_threads sees the siblings',
  listed.length === 2 && listed.some((t: { threadId: string }) => t.threadId === chat2.id),
  JSON.stringify(listed.map((t: { title: string }) => t.title))
)
await registry.send(chat2.id, 'Reply with exactly: APPLE-11 is the first fact')
await settled(chat2.id)
const digest = await call(chat1, 'app_read_thread', { threadId: chat2.id })
check('app_read_thread returns the digest inline', digest.includes('APPLE-11'), digest.slice(0, 80))
const missing = await call(chat1, 'app_read_thread', { threadId: 'nope' })
check('app_read_thread refuses unknown ids', missing.startsWith('refused'), missing)

// ── refusals ─────────────────────────────────────────────────────────
const badModel = await call(chat1, 'app_start_thread', {
  threadType: 'chat',
  provider: 'claude',
  model: 'gpt-nope',
  firstMessage: 'hi'
})
check('bad model id refused with correction', badModel.startsWith('refused'), badModel.slice(0, 90))
const badEffort = await call(chat1, 'app_start_thread', {
  threadType: 'chat',
  provider: 'codex',
  model: 'gpt-5.5',
  reasoning: 'ultra',
  firstMessage: 'hi'
})
check('off-ladder reasoning refused', badEffort.startsWith('refused'), badEffort.slice(0, 90))

// ── planning → codex implementation from its own plan ────────────────
const plan = await mk({ threadType: 'planning', title: 'gamma plan' })
writeFileSync(
  plan.planPath!,
  '# Gamma plan\n\n## Overview\n\nTest plan.\n\n## Tasks\n\n- [ ] say the codeword TASK-CODE-77\n'
)
const startedRaw = await call(plan, 'app_start_thread', {
  threadType: 'implementation',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  reasoning: 'low',
  firstMessage:
    'Read the plan file named in your instructions and reply with exactly the codeword in its Tasks section. Do not edit anything.'
})
const started = JSON.parse(startedRaw)
const impl = registry.list().find((s) => s.id === started.threadId)
check('implementation thread created', !!impl, startedRaw.slice(0, 120))
check(
  'right type/provider/planPath',
  impl?.threadType === 'implementation' &&
    impl?.provider === 'codex' &&
    impl?.planPath === plan.planPath
)
await settled(started.threadId)
check(
  'implementation read the plan (seed reached codex)',
  finalText(started.threadId).includes('TASK-CODE-77'),
  finalText(started.threadId).slice(-120)
)

// ── chat → planning seeded from two chats ────────────────────────────
const chat3 = await mk({ title: 'third chat' })
await registry.send(chat3.id, 'Reply with exactly: BANANA-22 is the second fact')
await settled(chat3.id)
const seededRaw = await call(chat1, 'app_start_thread', {
  threadType: 'planning',
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  seedThreadIds: [chat2.id, chat3.id],
  firstMessage:
    'Do not write a plan document. From the two referenced thread digests, reply with the two codewords they contain, then stop.'
})
const seeded = JSON.parse(seededRaw)
await settled(seeded.threadId)
const seededReply = finalText(seeded.threadId)
check(
  'seeded planning thread got both digests',
  seededReply.includes('APPLE-11') && seededReply.includes('BANANA-22'),
  seededReply.slice(-160)
)

// ── the stdio bridge speaks MCP and reaches the app ──────────────────
const bridge = spawn(process.execPath, ['scripts/app-mcp-bridge.mjs'], {
  env: {
    ...process.env,
    TEMP_CODE_PORT: String(server.port),
    TEMP_CODE_SESSION: chat1.id
  },
  stdio: ['pipe', 'pipe', 'inherit']
})
const bridgeLines: ((line: string) => void)[] = []
createInterface({ input: bridge.stdout! }).on('line', (l) => bridgeLines.shift()?.(l))
const bridgeCall = (msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge timeout')), 15_000)
    bridgeLines.push((line) => {
      clearTimeout(timer)
      resolve(JSON.parse(line))
    })
    bridge.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  })
const init = await bridgeCall({
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26' }
})
check(
  'bridge: initialize',
  (init.result as { serverInfo?: { name?: string } })?.serverInfo?.name === 'temp-code-app'
)
const toolList = await bridgeCall({ id: 2, method: 'tools/list' })
check('bridge: three tools listed', (toolList.result as { tools: unknown[] })?.tools.length === 3)
const viaBridge = await bridgeCall({
  id: 3,
  method: 'tools/call',
  params: { name: 'app_list_threads', arguments: { allProjects: false } }
})
const bridgeText = (viaBridge.result as { content: { text: string }[] })?.content?.[0]?.text ?? ''
check(
  'bridge: app_list_threads round-trips over WS',
  JSON.parse(bridgeText).some((t: { threadId: string }) => t.threadId === chat2.id),
  bridgeText.slice(0, 80)
)
bridge.kill()

// ── a real codex thread reaches the tools through the bridge ─────────
const codexThread = await mk({ provider: 'codex', model: 'gpt-5.6-sol', threadType: 'chat' })
await registry.send(
  codexThread.id,
  'Call the tool mcp__app__app_list_threads with {"allProjects": false} right now and reply with exactly: THREADS <number of entries in its output>. Do not describe the tool — call it.'
)
await settled(codexThread.id)
const codexRows = registry.eventsAfter(codexThread.id, 0)
const codexCalled = codexRows.some(
  (r) => r.event.type === 'tool-call' && r.event.name.includes('app_list_threads')
)
const codexResult = codexRows.find(
  (r) => r.event.type === 'tool-result' && !r.event.isError && r.event.output.includes('threadId')
)
const codexReply = finalText(codexThread.id)
check('codex actually invoked the bridge tool', codexCalled)
check('bridge returned real thread rows to codex', !!codexResult)
check(
  'codex reported a non-zero thread count',
  /THREADS\s+[1-9]\d*/.test(codexReply),
  codexReply.slice(-120)
)

await registry.disposeAll()
await server.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
