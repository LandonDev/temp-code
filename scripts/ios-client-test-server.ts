/**
 * A real temp-code server for the iOS client's live tests (bun run
 * ios:test:client, scripts/ios-client-test.ts). Boots on a temp database
 * with the fixed-port listener on an ephemeral port, as scripts/e2e-remote.ts
 * does, seeds a workspace, a project and two threads (one with a tool output
 * past the remote profile's body line), makes one read-only app key, and
 * prints ONE JSON line on stdout with what the Swift tests need. The key is
 * in that line and nowhere else: the runner moves it into the test process
 * environment and never logs it.
 *
 * A second loopback http server is the tests' control panel:
 *   GET  /state                 → { sockets: [{ keyId, extensions }], clockOffsetMs }
 *   POST /drop                  → terminates every live remote socket (a dropped link)
 *   POST /append { sessionId, count, big? }  → appends rows to a thread; answers { appended }
 *   POST /clock  { offsetMs }   → shifts the auth clock (31_000 expires every ticket)
 *   POST /revoke { keyId }      → revokes a key (the listener closes its sockets with 4001)
 *   POST /quit                  → closes everything
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { startServer } from '../src/main/server/index'
import type { AgentEvent } from '../src/shared/events'

const root = mkdtempSync(join(tmpdir(), 'tc-ios-client-'))
configure({
  dataDir: join(root, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0 })
if (!server.remote || server.remote.port === 0) throw new Error('the remote listener did not bind')

// ── seed ────────────────────────────────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'tc-ios-client-repo-'))
execFileSync('git', ['-C', repo, 'init', '-q'])
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
const workspace = await server.registry.createWorkspace(repo, 'ios-workspace')
const project = await server.registry.createProject(workspace.id, 'ios-project', 'local')
export const THREAD_A = 'ios-thread-a'
export const THREAD_B = 'ios-thread-b'
for (const [id, title] of [[THREAD_A, 'Thread A, with a long tool output'], [THREAD_B, 'Thread B, short']] as const) {
  await server.registry.create({
    id,
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'edits',
    projectId: project.id,
    threadType: 'implementation',
    title
  })
}
const line = (i: number): string => `line ${String(i).padStart(3, '0')}: ${'x'.repeat(48)}`
const bigOutput = Array.from({ length: 100 }, (_, i) => line(i)).join('\n')
const seed: AgentEvent[] = [
  { type: 'user-text', text: 'Turn 1: say hello', model: 'claude-sonnet-5-5', reasoning: 'low', newPass: true },
  { type: 'thinking', text: 'A greeting is wanted.', delta: false, msgId: 'm1', blockIndex: 0 },
  { type: 'assistant-text', text: 'Hello from the live test server.', delta: false, msgId: 'm1', blockIndex: 1 },
  { type: 'turn-complete', costUsd: 0.01, inputTokens: 100, outputTokens: 12 },
  { type: 'user-text', text: 'Turn 2: run a long command' },
  { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'seq 1 100', description: 'Count to one hundred' } },
  { type: 'tool-result', callId: 'c1', output: bigOutput, isError: false },
  { type: 'assistant-text', text: 'Done.', delta: false, msgId: 'm2', blockIndex: 0 },
  { type: 'turn-complete', inputTokens: 300, outputTokens: 20 }
]
for (const event of seed) server.registry.append(THREAD_A, event)
server.registry.append(THREAD_B, { type: 'user-text', text: 'Only one turn here' })
server.registry.append(THREAD_B, { type: 'assistant-text', text: 'And one short answer.', delta: false, msgId: 'b1', blockIndex: 0 })
server.registry.append(THREAD_B, { type: 'turn-complete' })

// ── a fuller shell for the simulator proof ──────────────────────────────
// Two workspaces, a project with live and archived threads, chats without a
// project, a pinned thread, a running thread with tasks, a subagent fleet,
// threads waiting on an approval and on a question, a failed one, a paused
// one, and an archived project. The live tests rely on THREAD_A and THREAD_B
// only, so everything here is extra.
const repo2 = mkdtempSync(join(tmpdir(), 'tc-ios-client-repo2-'))
execFileSync('git', ['-C', repo2, 'init', '-q'])
execFileSync('git', ['-C', repo2, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
const workspace2 = await server.registry.createWorkspace(repo2, 'cosmic-web')
const project2 = await server.registry.createProject(workspace2.id, 'billing-page', 'local')
const retired = await server.registry.createProject(workspace.id, 'old-migration', 'local')
type CreateInput = Parameters<typeof server.registry.create>[0]
const base = { provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits' } as const
const make = (id: string, extra: Partial<CreateInput>): Promise<unknown> => server.registry.create({ ...base, ...extra, id } as CreateInput)
const say = (id: string, user: string, assistant: string): void => {
  server.registry.append(id, { type: 'user-text', text: user })
  server.registry.append(id, { type: 'assistant-text', text: assistant, delta: false, msgId: `${id}-m1`, blockIndex: 0 })
  server.registry.append(id, { type: 'turn-complete' })
}

// Settled roots in the first project: one pinned, two archived.
await make('ios-pinned', { projectId: project.id, threadType: 'research', title: 'Compare vector databases' })
say('ios-pinned', 'Which vector database fits a 10M-row corpus?', 'Three candidates stand out.')
server.registry.setPinned('ios-pinned', true)
for (const [id, title] of [['ios-archived-1', 'Rename the config keys'], ['ios-archived-2', 'Drop the legacy importer']] as const) {
  await make(id, { projectId: project.id, threadType: 'implementation', title })
  say(id, 'Do it.', 'Done.')
  await server.registry.setArchived(id, true)
}

// A failed planning thread and a paused orchestration.
await make('ios-failed', { projectId: project.id, threadType: 'planning', title: 'Plan the move to passkeys' })
server.registry.append('ios-failed', { type: 'user-text', text: 'Plan the move to passkeys' })
server.registry.append('ios-failed', { type: 'status', status: 'running' })
server.registry.append('ios-failed', { type: 'error', message: 'The provider answered 429: rate limited\nRetry in a minute.' })
server.registry.append('ios-failed', { type: 'status', status: 'error' })
await make('ios-paused', { projectId: project.id, threadType: 'orchestration', agentType: 'orchestrator', title: 'Migrate the stats pipeline' })
server.registry.append('ios-paused', { type: 'user-text', text: 'Migrate every stats job to ClickHouse' })
server.registry.append('ios-paused', { type: 'status', status: 'running' })
server.registry.append('ios-paused', { type: 'status', status: 'paused' })

// A chat waiting on an approval, and in the other project one waiting on a question.
await make('ios-waiting', { projectId: project.id, threadType: 'chat', title: 'Run the test suite' })
server.registry.append('ios-waiting', { type: 'user-text', text: 'Run the tests and fix what fails' })
server.registry.append('ios-waiting', { type: 'status', status: 'running' })
server.registry.append('ios-waiting', { type: 'approval-request', requestId: 'seed-approval', toolName: 'Bash', input: { command: 'bun test' }, title: 'run bun test', callId: 'c7' })
server.registry.append('ios-waiting', { type: 'status', status: 'waiting', detail: 'awaiting approval' })
await make('ios-question', { projectId: project2.id, threadType: 'implementation', title: 'Fix the invoice totals' })
server.registry.append('ios-question', { type: 'user-text', text: 'Invoices round the wrong way', newPass: true })
server.registry.append('ios-question', { type: 'status', status: 'running' })
server.registry.append('ios-question', { type: 'question-request', requestId: 'seed-question', questions: [{ question: 'Round half up or to even?', header: 'Rounding', options: [{ label: 'Half up' }, { label: 'To even' }] }] })
server.registry.append('ios-question', { type: 'status', status: 'waiting', detail: 'awaiting an answer' })

// A running implementation with tasks, and an orchestration fleet with a working explorer and a settled reviewer.
await make('ios-running', { projectId: project.id, threadType: 'implementation', title: 'Add the billing export' })
server.registry.append('ios-running', { type: 'user-text', text: 'Add a CSV export to the billing page', newPass: true })
server.registry.append('ios-running', { type: 'status', status: 'running' })
server.registry.append('ios-running', { type: 'tool-call', callId: 't1', name: 'TodoWrite', input: { todos: [
  { content: 'Read the billing page', status: 'completed', activeForm: 'Reading the billing page' },
  { content: 'Write the export endpoint', status: 'in_progress', activeForm: 'Writing the export endpoint' },
  { content: 'Add tests', status: 'pending', activeForm: 'Adding tests' }
] } })
server.registry.append('ios-running', { type: 'tool-result', callId: 't1', output: 'ok', isError: false })
server.registry.append('ios-running', { type: 'tool-call', callId: 't2', name: 'Edit', input: { file_path: 'src/billing/export.ts' } })
await make('ios-fleet', { projectId: project.id, threadType: 'orchestration', agentType: 'orchestrator', title: 'Port the sky plugins' })
server.registry.append('ios-fleet', { type: 'user-text', text: 'Port every sky plugin to the new core' })
server.registry.append('ios-fleet', { type: 'status', status: 'running' })
await make('ios-fleet-explorer', { parentId: 'ios-fleet', projectId: project.id, agentType: 'explorer', title: 'Map the plugin boundaries' })
server.registry.append('ios-fleet-explorer', { type: 'user-text', text: 'Map the plugin boundaries' })
server.registry.append('ios-fleet-explorer', { type: 'status', status: 'running' })
server.registry.append('ios-fleet-explorer', { type: 'tool-call', callId: 'e1', name: 'Read', input: { file_path: 'plugins/README.md' } })
await make('ios-fleet-reviewer', { parentId: 'ios-fleet', projectId: project.id, agentType: 'reviewer', model: 'claude-opus-5-5', title: 'Review the first port' })
say('ios-fleet-reviewer', 'Review the first port', 'Two findings, both minor.')

// Chats: one in the workspace with no project, one outside every workspace; a thread in the archived project.
await make('ios-chat-workspace', { workspaceId: workspace.id, threadType: 'chat', title: 'Why is the build slow?' })
say('ios-chat-workspace', 'Why is the build slow today?', 'The cache was cold.')
await make('ios-chat-loose', { cwd: tmpdir(), threadType: 'chat', title: 'Regex for ISO dates' })
say('ios-chat-loose', 'A regex for ISO dates?', 'Use a date parser instead.')
await make('ios-retired', { projectId: retired.id, threadType: 'chat', title: 'Old migration notes' })
say('ios-retired', 'Keep these notes.', 'Kept.')
await server.registry.archiveProject(retired.id, true)

// ── the key, and a pairing link for the simulator rehearsal ─────────────
const created = await server.remoteAuth.createKey({ name: 'ios-test', audience: 'client', caps: [], createdBy: 'local' })
const pairing = server.remoteAuth.createPairing({ name: 'ios-sim', audience: 'client', caps: [], createdBy: 'local' })

// ── the auth clock, shiftable for ticket expiry ─────────────────────────
let clockOffsetMs = 0
;(server.remoteAuth as unknown as { now: () => number }).now = () => Date.now() + clockOffsetMs

// ── control ─────────────────────────────────────────────────────────────
const readJson = (req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
  })
let appended = 0
const control = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://x')
    const answer = (status: number, body: unknown): void => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
      res.end(text)
    }
    if (url.pathname === '/state') {
      const sockets: { keyId: string; extensions: string }[] = []
      for (const [keyId, set] of server.remote?.sockets ?? []) for (const ws of set) sockets.push({ keyId, extensions: ws.extensions })
      return answer(200, { sockets, clockOffsetMs })
    }
    if (req.method !== 'POST') return answer(404, { error: 'not found' })
    const body = await readJson(req)
    switch (url.pathname) {
      case '/drop': {
        let count = 0
        for (const set of server.remote?.sockets.values() ?? []) for (const ws of set) {
          ws.terminate()
          count++
        }
        return answer(200, { dropped: count })
      }
      case '/append': {
        const sessionId = String(body.sessionId ?? THREAD_A)
        const count = Number(body.count ?? 1)
        for (let i = 0; i < count; i++) {
          appended++
          const text = body.big ? `appended ${appended}\n${bigOutput}` : `appended ${appended}`
          server.registry.append(sessionId, { type: 'assistant-text', text, delta: false, msgId: `a${appended}`, blockIndex: 0 })
        }
        return answer(200, { appended: count })
      }
      case '/clock':
        clockOffsetMs = Number(body.offsetMs ?? 0)
        return answer(200, { clockOffsetMs })
      case '/revoke':
        return answer(200, { ok: server.remoteAuth.revokeKey(String(body.keyId ?? '')) })
      case '/quit':
        answer(200, { ok: true })
        setTimeout(() => void shutdown(), 50)
        return
      default:
        return answer(404, { error: 'not found' })
    }
  })().catch((err) => {
    res.writeHead(500)
    res.end(String(err))
  })
})
await new Promise<void>((ok) => control.listen(0, '127.0.0.1', ok))
const controlPort = (control.address() as { port: number }).port

async function shutdown(): Promise<void> {
  control.close()
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

// The one line the runner reads. The key appears here and nowhere else.
process.stdout.write(
  JSON.stringify({
    ready: true,
    baseUrl: `http://127.0.0.1:${server.remote.port}`,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    environmentId: server.environmentId,
    keyId: created.key.id,
    key: created.token,
    pairingLink: `http://127.0.0.1:${server.remote.port}/pair#${pairing.code}`,
    threadA: THREAD_A,
    threadB: THREAD_B,
    projectId: project.id,
    workspaceId: workspace.id
  }) + '\n'
)
