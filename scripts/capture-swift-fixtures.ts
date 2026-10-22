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
 * list, icon, search and stored GitHub inbox answers, and the shapes of
 * the 2026-10-21/22 features from scripts/lib/ios-seeds.ts (a batch mid-run,
 * notes, the project plan, reviews, plans, resources, session.changes, the
 * host's own rows, notes.search, session.start and session.batch, devices,
 * deploy, the Mac bridge switch, accounts, boot-resume). Every frame is
 * parsed with src/shared/wireSchemas.ts and compared key for key with
 * what the server sent before it is written,
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
import { BatchStateSchema } from '../src/shared/contract-batch'
import { HostDevicesReportSchema } from '../src/shared/contract-hostdevices'
import { MilestoneLinkSchema, ProjectPlanStateSchema } from '../src/shared/contract-projectplan'
import { projectPlanPathFor } from '../src/shared/projectPlan'
import { PlanScopeSchema } from '../src/shared/plans'
import { ReviewScopeSchema } from '../src/shared/review'
import type { AccountsSnapshot } from '../src/shared/accounts'
import {
  accountsSnapshot,
  batchRowMidRun,
  noticesThreadRows,
  notesFive,
  projectPlanMarkdown,
  SIMULATOR_BOOTED
} from './lib/ios-seeds'

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
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
writeFileSync(join(repo, 'fixture-search.txt'), '// Search fixture\nconst fixtureNeedle = true\n')
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

record(
  'workspace-icon',
  ok(W.WorkspaceIconSchema),
  await request('workspace.icon', { workspaceId: workspace.id })
)
const search = record(
  'session-search',
  ok(W.SessionSearchResultSchema),
  await request('session.search', { query: 'hello' })
)
if (
  !search.result.hits.some((hit) => hit.sessionId === SESSION_ID && hit.role === 'user') ||
  !search.result.hits.some((hit) => hit.sessionId === SESSION_ID && hit.role === 'assistant')
)
  throw new Error('session.search did not find both seeded hello rows')
const emptySearch = record(
  'session-search-empty',
  ok(W.SessionSearchResultSchema),
  await request('session.search', { query: 'fixture-no-match-9e71c0' })
)
if (emptySearch.result.hits.length !== 0) throw new Error('session.search unexpectedly found a row')
const projectSearch = record(
  'search-project',
  ok(W.ProjectSearchResultSchema),
  await request('search.project', { options: { cwd: project.cwd, query: 'fixtureNeedle' } })
)
if (
  projectSearch.result.matches.length !== 1 ||
  projectSearch.result.matches[0].relative !== 'fixture-search.txt'
)
  throw new Error('search.project did not find the seeded file')
const inbox = record(
  'github-inbox',
  ok(W.GithubInboxSnapshotSchema),
  await request('github.inbox', {})
)
if (inbox.result.repos.length !== 0 || inbox.result.auth.state !== 'ok')
  throw new Error('github.inbox did not return the empty stored snapshot')

// ── the 2026-10-21/22 features (seeds from scripts/lib/ios-seeds.ts) ────
// Each frame goes through record() with its wire schema, so a disagreement
// between the server and wireSchemas.ts stops the capture here. Three pushes
// have no machinery behind them on a fresh capture server (boot-resume is
// sent once per boot after a real resume; accounts needs an Aliax vault), so
// they are written to the socket from their schema's parse of a literal and
// recorded as the client receives them: push-boot-resume and push-accounts.
// The admin methods (host.deployStatus, host.log) ride a second socket
// paired with the admin key.
const sendToSockets = (frame: unknown): void => {
  for (const set of server.remote?.sockets.values() ?? []) for (const socket of set) socket.send(JSON.stringify(frame))
}
const responseOf = <S extends z.ZodType>(schema: S) => ok(schema)

// A master with three children and its batch row mid-run.
const MASTER_ID = 'fixture-master'
const child = (id: string, title: string, threadType: 'implementation' | 'planning' | 'research'): Promise<unknown> =>
  server.registry.create({ id, provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', projectId: project.id, threadType, title, masterId: MASTER_ID, startedBy: MASTER_ID })
await server.registry.create({ id: MASTER_ID, provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', projectId: project.id, threadType: 'chat', title: 'Fixture master' })
server.registry.setMaster(MASTER_ID, true)
await child('fixture-child-a', 'Rebuild the writer', 'implementation')
await child('fixture-child-b', 'Backfill the rollups', 'implementation')
await child('fixture-child-c', 'Which rollups are read?', 'research')
server.registry.append('fixture-child-a', { type: 'status', status: 'done' })
const batchFrom = frames.length
server.batches.seedRow(batchRowMidRun(MASTER_ID, { landed: ['fixture-child-a'], pending: ['fixture-child-b', 'fixture-child-c'] }, Date.now()))
record('push-batch', W.BatchPushSchema, await waitFrame((f, i = frames.indexOf(f)) => i >= batchFrom && isPush(f, 'batch'), 'the batch push'))
const batch = record('batch-get', responseOf(BatchStateSchema), await request('batch.get', { masterId: MASTER_ID }))
if (!batch.result.steps.some((st) => st.kind === 'shell' && st.status === 'running' && st.log.length > 0))
  throw new Error('batch.get lacks the running shell step with its log')
const children = record('batch-children', responseOf(W.BatchChildrenSchema), await request('batch.children', { masterId: MASTER_ID }))
if (children.result.children.length !== 3) throw new Error(`batch.children answered ${children.result.children.length} children, expected 3`)

// Notes: the five-section document, read and pushed.
const notesFrom = frames.length
server.registry.notes.write(SESSION_ID, notesFive())
record('push-notes', W.NotesPushSchema, await waitFrame((f, i = frames.indexOf(f)) => i >= notesFrom && isPush(f, 'notes'), 'the notes push'))
record('session-notes-get', responseOf(W.ThreadNotesDocSchema), await request('session.notes.get', { sessionId: SESSION_ID }))

// The project plan: seven milestones, three done, pinned; and a project with none.
const planPath = projectPlanPathFor(project.cwd)
mkdirSync(join(planPath, '..'), { recursive: true })
writeFileSync(planPath, projectPlanMarkdown())
await server.registry.create({ id: 'fixture-project-plan', provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', projectId: project.id, threadType: 'project-plan', title: 'Fixture project plan', planPath })
server.projectPlans.pin(project.id, true)
const planned = record('project-plan-get', responseOf(ProjectPlanStateSchema.nullable()), await request('projectPlan.get', { projectId: project.id }))
if (planned.result?.milestones.length !== 7 || planned.result.milestones.filter((m) => m.done).length !== 3)
  throw new Error('projectPlan.get did not read seven milestones, three done')
const emptyRepo = mkdtempSync(join(tmpdir(), 'tc-swift-fixtures-empty-'))
execFileSync('git', ['-C', emptyRepo, 'init', '-q'])
const emptyWorkspace = await server.registry.createWorkspace(emptyRepo, 'fixture-empty')
const emptyProject = await server.registry.createProject(emptyWorkspace.id, 'fixture-empty', 'local')
record('project-plan-get-null', responseOf(ProjectPlanStateSchema.nullable()), await request('projectPlan.get', { projectId: emptyProject.id }))
server.projectPlans.link(SESSION_ID, { projectId: project.id, milestone: 4 })
record('project-plan-link-of', responseOf(MilestoneLinkSchema.nullable()), await request('projectPlan.linkOf', { sessionId: SESSION_ID }))

// Review and plan settings as the project sees them.
record('review-get', responseOf(ReviewScopeSchema), await request('review.get', { projectId: project.id }))
record('plans-get', responseOf(PlanScopeSchema), await request('plans.get', { projectId: project.id }))

// Resources: two worktrees here, a simulator on another host; the push, then the list.
const resourcesFrom = frames.length
server.resources.record(SESSION_ID, server.environmentId, {
  created: [
    { kind: 'worktree', identifier: join(repo, '.claude', 'worktrees', 'fixture'), label: 'fixture', branch: 'fixture' },
    { kind: 'worktree', identifier: join(repo, '.claude', 'worktrees', 'scratch'), label: 'scratch', branch: null },
    { kind: 'simulator', identifier: SIMULATOR_BOOTED, label: 'iPhone 17', branch: null }
  ],
  removed: []
})
record('push-resources', W.ResourcesPushSchema, await waitFrame((f, i = frames.indexOf(f)) => i >= resourcesFrom && isPush(f, 'resources'), 'the resources push'))
record('resources-list', responseOf(W.ResourcesListSchema), await request('resources.list', { sessionId: SESSION_ID }))

// The launch mirror's reconcile: a stale cursor resets; the head's cursor answers a delta.
const reset = record('session-changes-reset', responseOf(W.SessionChangesSchema), await request('session.changes', { afterSeq: 0, generation: 'not-this-run' }))
if (!reset.result.reset) throw new Error('session.changes with a foreign generation did not reset')
await server.registry.rename(SESSION_ID, `${RENAMED_TITLE} (again)`)
const delta = record('session-changes', responseOf(W.SessionChangesSchema), await request('session.changes', { afterSeq: reset.result.seq, generation: reset.result.generation }))
if (delta.result.reset || !delta.result.sessions?.some((m) => m.id === SESSION_ID)) throw new Error('session.changes did not answer the renamed thread')

// The host's own rows: every NoticeKind, every FailureKind, the preamble stamp, a plan hand-off.
const NOTICES_ID = 'fixture-notices'
await server.registry.create({ id: NOTICES_ID, provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', projectId: project.id, threadType: 'implementation', title: 'Fixture notices' })
for (const event of noticesThreadRows('fixture-child-b')) server.registry.append(NOTICES_ID, event)
record('session-events-notices', responseOf(W.EventsPageSchema), await request('session.events', { sessionId: NOTICES_ID, tail: 200 }))

// notes.search over an m3a note with the fixture's word.
server.notes.upsert({ id: 'fixture-note', title: 'Cutover checklist', body: 'Before the cutover: run the proofs, then grep for fixtureNeedle on both hosts.' })
const notesFound = record('notes-search', responseOf(W.NoteSearchResultSchema), await request('notes.search', { query: 'fixtureNeedle' }))
if (!JSON.stringify(notesFound.result).includes('fixture-note')) throw new Error('notes.search did not find the fixture note')

// The queue and the fleet: Start on a thread that is not queued, an archive of nothing.
const started = record('session-start', responseOf(W.SessionStartedSchema), await request('session.start', { sessionId: SESSION_ID }))
if (started.result.started) throw new Error('session.start started a thread that was not queued')
record('session-batch', responseOf(W.SessionBatchResultSchema), await request('session.batch', { action: 'archive', ids: [] }))

// Devices: the capture's host has no gatherer, so the list is empty; the shape is what matters.
record('host-devices-hosts', responseOf(z.array(W.HostDevicesHostSchema)), await request('host.devices.hosts', {}))
void HostDevicesReportSchema

// The Mac bridge's switch for a thread with no Mac.
record('mac-bridge-thread-get', responseOf(W.MacBridgeThreadStateSchema), await request('macBridge.thread.get', { sessionId: SESSION_ID }))

// Accounts: the service is stood in for (no Aliax vault here), then its snapshot is pushed.
// The phone's subset of the snapshot (thread 24's AccountsSnapshotSchema), so the server sends only keys the schema knows.
const snapshot = (): AccountsSnapshot =>
  W.AccountsSnapshotSchema.parse(accountsSnapshot({ environmentId: 'env_fixturepeer000000000000', name: 'The box', build: server.build }, Date.now())) as unknown as AccountsSnapshot
;(server.accounts as unknown as { list: () => Promise<AccountsSnapshot> }).list = async () => snapshot()
record('accounts-list', responseOf(W.AccountsSnapshotSchema), await request('accounts.list', {}))
const accountsFrom = frames.length
sendToSockets({ push: 'accounts', snapshot: snapshot() })
record('push-accounts', W.AccountsPushSchema, await waitFrame((f, i = frames.indexOf(f)) => i >= accountsFrom && isPush(f, 'accounts'), 'the accounts push'))
const bootFrom = frames.length
sendToSockets(W.BootResumePushSchema.parse({ push: 'boot-resume', count: 4, at: Date.now() }))
record('push-boot-resume', W.BootResumePushSchema, await waitFrame((f, i = frames.indexOf(f)) => i >= bootFrom && isPush(f, 'boot-resume'), 'the boot-resume push'))

// Deploy status and its log: admin, over a socket paired with the admin key.
const adminTicket = (await api('POST', '/api/ticket', { headers: { Authorization: `Bearer ${admin}` } })).body as { ticket: string }
const adminWs = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${adminTicket.ticket}`)
const adminFrames: ServerFrame[] = []
adminWs.on('message', (d) => adminFrames.push(JSON.parse(String(d)) as ServerFrame))
await new Promise<void>((resolveOpen, rejectOpen) => {
  adminWs.on('open', () => resolveOpen())
  adminWs.on('error', rejectOpen)
})
const adminRequest = async (method: string, params: unknown): Promise<ServerFrame> => {
  const id = `admin-${nextId++}`
  adminWs.send(JSON.stringify({ id, method, params }))
  for (let waited = 0; waited < 5000; waited += 20) {
    const found = adminFrames.find((f) => 'id' in f && f.id === id)
    if (found) return found
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${method}`)
}
record('host-deploy-status', responseOf(W.DeployStatusSchema), await adminRequest('host.deployStatus', {}))
record('host-log', responseOf(W.HostLogSnapshotSchema), await adminRequest('host.log', { job: 'deploy' }))
adminWs.close()

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
rmSync(emptyRepo, { recursive: true, force: true })
process.exit(0)
