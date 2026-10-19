/**
 * Capture the Swift package's fixtures from a real server:
 *
 *   bun run script:capture-swift-fixtures
 *
 * Boots the server on a temp database with the fixed-port listener on an
 * ephemeral port (as scripts/e2e-remote.ts does), seeds one thread with
 * three turns including a tool output past the remote profile's body
 * line, pairs a key, mints a ticket, opens /ws, and records what the
 * phone will see: the hello frame, a session.list page, a session.events
 * tail with moreBefore, a session.rowBody answer, a coalesced `events`
 * frame, a `sessions` frame, a `queue` push and an error response, plus
 * the HTTP bodies of /api/hello, /api/pair and /api/ticket and a few
 * list answers. Every frame is parsed with src/shared/wireSchemas.ts and
 * compared key for key with what the server sent before it is written,
 * so a mirror that disagrees with the server stops here, not in Swift.
 * Files land in ios/TempCodeContract/Tests/Fixtures/; FixtureTests.swift
 * asserts the numbers below.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { startServer } from '../src/main/server/index'
import { isOmittedBody } from '../src/shared/wire'
import type { AgentEvent } from '../src/shared/events'
import type { ServerFrame } from '../src/shared/contract'
import * as W from '../src/shared/wireSchemas'

// FixtureTests.swift asserts these.
const SESSION_ID = 'fixture-thread'
const OUTPUT_BYTES = 6000
const OUTPUT_LINES = 100
const RENAMED_TITLE = 'Fixture thread, renamed'
const QUEUED_TEXT = 'Queued from the fixture capture'
const KEY_NAME = 'iphone'

const FIXTURES_DIR = resolve('ios/TempCodeContract/Tests/Fixtures')

const root = mkdtempSync(join(tmpdir(), 'tc-swift-fixtures-'))
configure({
  dataDir: join(root, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0 })
const base = `http://127.0.0.1:${server.remote!.port}`

const fixtures = new Map<string, unknown>()
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]])
        )
      : v
  )
/** The value parses with its schema and loses nothing in the parse (no key the schema does not know). */
function record<S extends z.ZodType>(name: string, schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new Error(`${name} does not match wireSchemas.ts:\n${z.prettifyError(parsed.error)}`)
  if (canonical(parsed.data) !== canonical(value)) {
    throw new Error(
      `${name}: the server sent keys wireSchemas.ts does not know\n  sent:   ${canonical(value).slice(0, 400)}\n  parsed: ${canonical(parsed.data).slice(0, 400)}`
    )
  }
  fixtures.set(name, value)
  console.log(`  ${name}: ${JSON.stringify(value).length} bytes`)
  return parsed.data
}
const ok = <S extends z.ZodType>(
  result: S
): z.ZodObject<{ id: z.ZodString; ok: z.ZodLiteral<true>; result: S }> =>
  z.object({ id: z.string(), ok: z.literal(true), result })
const failed = z.object({ id: z.string(), ok: z.literal(false), error: z.string() })

// ── seed: a workspace, a project, one thread with three turns ──────────
const repo = mkdtempSync(join(tmpdir(), 'tc-swift-fixtures-repo-'))
execFileSync('git', ['-C', repo, 'init', '-q'])
execFileSync('git', [
  '-C',
  repo,
  '-c',
  'user.name=fixture',
  '-c',
  'user.email=fixture@example.com',
  'commit',
  '-q',
  '--allow-empty',
  '-m',
  'init'
])
const workspace = await server.registry.createWorkspace(repo, 'fixture-workspace')
const project = await server.registry.createProject(workspace.id, 'fixture-project', 'local')
await server.registry.create({
  id: SESSION_ID,
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'edits',
  projectId: project.id,
  threadType: 'implementation',
  title: 'Fixture thread'
})

/** OUTPUT_LINES lines, OUTPUT_BYTES ASCII bytes, no trailing newline. */
const bigOutput = (): string => {
  const width = OUTPUT_BYTES / OUTPUT_LINES // 60: 59 chars + '\n', the last line 60 chars
  const line = (i: number): string => `line ${String(i).padStart(3, '0')}: `.padEnd(width - 1, 'x')
  return Array.from({ length: OUTPUT_LINES }, (_, i) =>
    i === OUTPUT_LINES - 1 ? line(i) + 'x' : line(i)
  ).join('\n')
}
const longText = (n: number): string =>
  Array.from({ length: n }, (_, i) => `const value${i} = ${i} // a line of the edited file`).join(
    '\n'
  )
const rows: AgentEvent[] = [
  {
    type: 'user-text',
    text: 'Turn 1: say hello',
    model: 'claude-sonnet-5-5',
    reasoning: 'low',
    newPass: true
  },
  { type: 'thinking', text: 'The user wants ', delta: true, msgId: 'm1', blockIndex: 0 },
  {
    type: 'thinking',
    text: 'The user wants a greeting.',
    delta: false,
    msgId: 'm1',
    blockIndex: 0
  },
  {
    type: 'assistant-text',
    text: 'Hello from the fixture thread.',
    delta: false,
    msgId: 'm1',
    blockIndex: 1
  },
  { type: 'turn-complete', costUsd: 0.0123, inputTokens: 120, outputTokens: 18 },
  { type: 'user-text', text: 'Turn 2: run a long command and edit a file' },
  {
    type: 'tool-call',
    callId: 'c1',
    name: 'Bash',
    input: { command: 'seq 1 100', description: 'Count to one hundred' }
  },
  { type: 'tool-result', callId: 'c1', output: bigOutput(), isError: false },
  {
    type: 'tool-call',
    callId: 'c2',
    name: 'Edit',
    input: { file_path: '/src/fixture.ts', old_string: longText(80), new_string: longText(90) },
    preview: {
      kind: 'write',
      path: '/src/fixture.ts',
      fileName: 'fixture.ts',
      additions: 90,
      deletions: 80,
      lines: Array.from({ length: 170 }, (_, i) => ({
        number: i + 1,
        kind: i < 80 ? ('del' as const) : ('add' as const),
        text: `const value${i} = ${i}`
      }))
    }
  },
  { type: 'tool-result', callId: 'c2', output: 'ok', isError: false },
  {
    type: 'assistant-text',
    text: 'Done: the command ran and the file is edited.',
    delta: false,
    msgId: 'm2',
    blockIndex: 0
  },
  { type: 'usage', inputTokens: 900, outputTokens: 140 },
  { type: 'turn-complete', costUsd: 0.05, inputTokens: 900, outputTokens: 140 },
  {
    type: 'user-text',
    text: 'Turn 3: anything else?',
    attachments: [{ path: '/tmp/shot.png', name: 'shot.png', mime: 'image/png', kind: 'image' }]
  },
  { type: 'assistant-text', text: 'Nothing else.', delta: false, msgId: 'm3', blockIndex: 0 },
  { type: 'turn-complete', inputTokens: 40, outputTokens: 4 }
]
for (const event of rows) server.registry.append(SESSION_ID, event)
// A working thread: queue.add waits instead of starting a harness.
server.store.updateSession(SESSION_ID, { status: 'running', busySince: Date.now() })

// ── pair, ticket, socket ────────────────────────────────────────────────
async function api(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  })
  return { status: res.status, body: await res.json() }
}
const admin = (
  await server.remoteAuth.createKey({
    name: 'desk',
    audience: 'client',
    caps: ['admin'],
    createdBy: 'local'
  })
).token
const pairing = await api('POST', '/api/pairings', {
  headers: { Authorization: `Bearer ${admin}` },
  body: { name: KEY_NAME, audience: 'client', caps: ['operate'] }
})
const code = (pairing.body as { code: string }).code
console.log('capturing')
const paired = record(
  'http-pair-key',
  W.PairKeyResponseSchema,
  (await api('POST', '/api/pair', { body: { code, kind: 'key', caps: ['operate'] } })).body
)
const bearer = { Authorization: `Bearer ${paired.key}` }
record(
  'http-hello',
  W.HelloResponseSchema,
  (await api('GET', '/api/hello', { headers: bearer })).body
)
const ticket = record(
  'http-ticket',
  W.TicketResponseSchema,
  (await api('POST', '/api/ticket', { headers: bearer })).body
)

const frames: ServerFrame[] = []
const waiters: ((f: ServerFrame) => void)[] = []
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${ticket.ticket}`)
ws.on('message', (d) => {
  const frame = JSON.parse(String(d)) as ServerFrame
  frames.push(frame)
  for (const w of waiters.splice(0)) w(frame)
})
await new Promise<void>((ok, bad) => {
  ws.on('open', () => ok())
  ws.on('error', bad)
})
const waitFrame = (
  pred: (f: ServerFrame) => boolean,
  what: string,
  timeoutMs = 5000
): Promise<ServerFrame> =>
  new Promise((resolve, reject) => {
    const prior = frames.find(pred)
    if (prior) return resolve(prior)
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs)
    const on = (f: ServerFrame): void => {
      if (pred(f)) {
        clearTimeout(timer)
        resolve(f)
      } else waiters.push(on)
    }
    waiters.push(on)
  })
let nextId = 1
const request = (method: string, params?: unknown): Promise<ServerFrame> => {
  const id = String(nextId++)
  ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }))
  return waitFrame((f) => 'id' in f && f.id === id, method)
}
const isPush = (f: ServerFrame, kind: string): boolean => 'push' in f && f.push === kind

// ── the frames ──────────────────────────────────────────────────────────
record('hello', W.HelloPushSchema, await waitFrame((f) => isPush(f, 'hello'), 'hello'))
record('workspace-list', ok(z.array(W.WorkspaceMetaSchema)), await request('workspace.list'))
record('project-list', ok(z.array(W.ProjectMetaSchema)), await request('project.list'))
record('catalog', ok(W.CatalogSchema), await request('catalog.get', {}))
const page = record('session-list', ok(W.SessionPageSchema), await request('session.list', {}))
if (!page.result.sessions.some((s) => s.id === SESSION_ID))
  throw new Error('session.list lacks the fixture thread')

// `tail` counts folded transcript blocks (db.ts tailStart), so grow it until
// the page holds turn 2's omitted output and still leaves turn 1 behind.
let events: z.infer<ReturnType<typeof ok<typeof W.EventsPageSchema>>> | null = null
for (let tail = 2; tail <= 40 && !events; tail++) {
  const frame = await request('session.events', { sessionId: SESSION_ID, tail })
  const page = ok(W.EventsPageSchema).parse(frame)
  const omits = page.result.rows.some(
    (r) => r.event.type === 'tool-result' && isOmittedBody(r.event.output)
  )
  if (omits && page.result.moreBefore)
    events = record('session-events', ok(W.EventsPageSchema), frame)
}
if (!events) throw new Error('no tail holds the omitted output with moreBefore')
const omittedRow = events.result.rows.find(
  (r) => r.event.type === 'tool-result' && isOmittedBody(r.event.output)
)
if (
  !omittedRow ||
  omittedRow.event.type !== 'tool-result' ||
  !isOmittedBody(omittedRow.event.output)
)
  throw new Error('no omitted tool output in the tail')
if (
  omittedRow.event.output.bytes !== OUTPUT_BYTES ||
  omittedRow.event.output.lines !== OUTPUT_LINES
) {
  throw new Error(
    `omitted body is ${omittedRow.event.output.bytes} bytes / ${omittedRow.event.output.lines} lines, expected ${OUTPUT_BYTES} / ${OUTPUT_LINES}`
  )
}
const edit = events.result.rows.find((r) => r.event.type === 'tool-call' && r.event.name === 'Edit')
if (!edit || edit.event.type !== 'tool-call' || !isOmittedBody(edit.event.preview?.lines))
  throw new Error('the Edit preview lines were not omitted')

const whole = record(
  'session-row-body',
  ok(z.object({ row: W.EventRowSchema })),
  await request('session.rowBody', { sessionId: SESSION_ID, seq: omittedRow.seq })
)
if (
  whole.result.row.event.type !== 'tool-result' ||
  typeof whole.result.row.event.output !== 'string' ||
  whole.result.row.event.output.length !== OUTPUT_BYTES
) {
  throw new Error('session.rowBody did not return the whole output')
}

await request('session.subscribe', { sessionId: SESSION_ID })
const liveFrom = frames.length
server.registry.append(SESSION_ID, {
  type: 'assistant-text',
  text: 'A live ',
  delta: true,
  msgId: 'm4',
  blockIndex: 0
})
server.registry.append(SESSION_ID, {
  type: 'assistant-text',
  text: 'A live row after subscribe.',
  delta: false,
  msgId: 'm4',
  blockIndex: 0
})
const eventsPush = await waitFrame(
  (f, i = frames.indexOf(f)) =>
    i >= liveFrom && isPush(f, 'events') && (f as { rows: unknown[] }).rows.length === 2,
  'a coalesced events frame'
)
record('push-events', W.EventsPushSchema, eventsPush)

await server.registry.rename(SESSION_ID, RENAMED_TITLE)
record(
  'push-sessions',
  W.SessionsPushSchema,
  await waitFrame(
    (f) =>
      isPush(f, 'sessions') &&
      (f as { sessions: { title: string }[] }).sessions.some((s) => s.title === RENAMED_TITLE),
    'the renamed meta'
  )
)

await request('queue.add', { sessionId: SESSION_ID, text: QUEUED_TEXT })
record(
  'push-queue',
  W.QueuePushSchema,
  await waitFrame(
    (f) => isPush(f, 'queue') && (f as { items: unknown[] }).items.length === 1,
    'the queue push'
  )
)
record(
  'queue-list',
  ok(z.array(W.QueuedMessageSchema)),
  await request('queue.list', { sessionId: SESSION_ID })
)

record(
  'response-error',
  failed,
  await request('session.approve', { sessionId: SESSION_ID, requestId: 'none', allow: true })
)

// ── write ───────────────────────────────────────────────────────────────
mkdirSync(FIXTURES_DIR, { recursive: true })
for (const name of readdirSync(FIXTURES_DIR))
  if (name.endsWith('.json')) rmSync(join(FIXTURES_DIR, name))
for (const [name, value] of fixtures)
  writeFileSync(join(FIXTURES_DIR, `${name}.json`), JSON.stringify(value, null, 2) + '\n')
console.log(`${fixtures.size} fixtures written to ${FIXTURES_DIR}`)

ws.close()
await server.close()
rmSync(root, { recursive: true, force: true })
rmSync(repo, { recursive: true, force: true })
process.exit(0)
