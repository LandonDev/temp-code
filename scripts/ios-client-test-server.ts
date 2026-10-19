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

// ── the key ─────────────────────────────────────────────────────────────
const created = await server.remoteAuth.createKey({ name: 'ios-test', audience: 'client', caps: [], createdBy: 'local' })

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
    threadA: THREAD_A,
    threadB: THREAD_B,
    projectId: project.id,
    workspaceId: workspace.id
  }) + '\n'
)
