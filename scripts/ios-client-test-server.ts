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
 *   GET  /actions               → { actions: [{ kind, sessionId, at, … }] } the sends, stops, approvals,
 *                                 answers, creates, renames, archives and pins the stubs recorded
 *   POST /actions/clear         → forgets them
 *   POST /finish { sessionId, text? }  → ends a simulated turn: the reply, turn-complete, idle (and stops a /stream)
 *   POST /stream { sessionId?, cps?, seconds?, seed? }  → plays a bursty streaming turn with a growing Edit and
 *                                 live edits into ios-streaming; 409 while one runs
 *   POST /ask { sessionId, kind: 'approval' | 'question' }  → a fresh card on a thread, which waits
 *   POST /push { frame }        → writes any push frame to every remote socket (a push with no
 *                                 machinery behind it here: macBridge.held, boot-resume, accounts)
 *   POST /batch-log { masterId, lines }  → appends lines to the master's running shell step (a streaming console)
 *   POST /notes { sessionId, text }      → writes a thread's notes.md (the `notes` push follows)
 *   POST /resources/remove { sessionId } → removes the thread's live resources; answers { results }
 *   POST /presence { environmentId, screen?, power? }  → flips a relayed host's screen or power (the relay seed)
 *   POST /quit                  → closes everything
 *
 * The seeds of the 2026-10-21/22 features (a master's batch mid-run, the
 * queued and stopped rows, a paused master, the project plan, notes, the
 * host's own rows, resources, a pinned account, a cross-host child, media,
 * a note for notes.search) come from scripts/lib/ios-seeds.ts; every id is
 * a key of the JSON line's `threads` map, which the runner exports as
 * TC_TEST_THREAD_<KEY>. The main host gets a fake MacDevices (two
 * simulators, one paired iPhone, Xcode-26, load 3.2 of 8) through
 * startServer's `devices` option, so host.devices answers on Linux.
 * scripts/ios-client-test-server.test.ts
 * checks every seeded id is used once.
 *
 * The relay seed (remote/relayLoopback.ts): four fake hosts reachable through
 * this server, one per state (Studio Mac available, locked, asleep and
 * unreachable since five minutes ago), listed in the JSON line as
 * `relayHosts`. A lane to the available or locked host
 * (`/ws?ticket=…&host=<id>`) lists this server's own seeded threads under
 * that host's id; the asleep one answers `unavailable: the Mac is asleep`;
 * the unreachable one is refused 503.
 */
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { configure } from 'aliax-core'
import { startServer } from '../src/main/server/index'
import { emitLiveEdit } from '../src/main/server/livediff'
import { MacDevices } from '../src/main/server/devices/hostDevices'
import { loadEnvironmentId } from '../src/main/server/remote/environment'
import { mediaUrl, serveMedia } from '../src/main/server/media'
import { projectPlanPathFor } from '../src/shared/projectPlan'
import type { AccountsSnapshot } from '../src/shared/accounts'
import {
  batchRowMidRun,
  fakeMacDevicesDeps,
  notesFive,
  notesTwo,
  withShellLog
} from './lib/ios-seeds'
import { openDb, Store } from '../src/main/server/db'
import { ENVIRONMENTS_PREFIX } from '../src/main/server/remote/environments'
import type { MacBridgeRequest } from '../src/shared/contract-macbridge'
import type { AgentEvent, FailureKind } from '../src/shared/events'
import type { GithubInboxItem } from '../src/shared/contract-github'
import type { ReviewNotice } from '../src/shared/review'
import { DEFAULT_PLAN_SETTINGS } from '../src/shared/plans'
import { DEFAULT_REVIEW_SETTINGS } from '../src/shared/review'
import { startLoopbackHosts } from '../src/main/server/remote/relayLoopback'

const root = mkdtempSync(join(tmpdir(), 'tc-ios-client-'))
configure({
  dataDir: join(root, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
// The `/asset/file/*` mirror the phone loads attachments through: the media
// server alone (the Electron asset handler has no place under plain node).
const assets = async (request: Request): Promise<Response> =>
  new URL(request.url).host === 'file' ? serveMedia(request) : new Response('not found', { status: 404 })
// ── a host's activity (iOS thread 21): what the host detail reads ───────
// A saved host "box" (admin caps, a route nobody answers: "not connected"
// on the sync lines, and the host the seeded Mac bridge calls belong to),
// written before boot so the peers read it with the rest. The deploy
// trigger directory holds a finished run (ref, 12 log lines, exit 0), so
// `host.deployStatus` is done and `host.log` has text.
export const SEED_BOX_ID = 'env_box_seed'
const dbPath = join(root, 'app.db')
{
  const db = openDb(dbPath)
  new Store(db).setSetting(
    `${ENVIRONMENTS_PREFIX}${SEED_BOX_ID}`,
    JSON.stringify({
      name: 'box',
      routes: [{ url: 'ws://127.0.0.1:9/ws', kind: 'lan' }],
      addedAt: Date.now() - 86_400_000,
      caps: ['read', 'operate', 'approve', 'admin'],
      keyName: 'the Mac',
      key: 'tc_seedbox.not-a-real-key'
    })
  )
  db.close()
}
const deployDir = join(root, 'deploy')
mkdirSync(deployDir, { recursive: true })
export const DEPLOY_LOG_LINES = 12
writeFileSync(join(deployDir, 'ref'), 'master\n')
writeFileSync(
  join(deployDir, 'log'),
  [
    'box-update: master requested',
    'stage 10: clone → /srv/agents/temp-code-builds/next',
    'stage 20: bun install --frozen-lockfile (node_modules hardlinked, bun.lock unchanged)',
    'stage 30: electron-vite build',
    'stage 40: trial boot on :7690',
    'stage 40: tc:ready in 2.1 s',
    'stage 50: snapshot /srv/agents/temp-code-data/app.db → VACUUM INTO',
    'stage 60: current → next',
    'stage 70: systemctl restart temp-code.service',
    'stage 80: service answered /api/hello in 4.3 s',
    'stage 85: launcher and library installed',
    'box-update: done (v1.0.312)'
  ].join('\n') + '\n'
)
writeFileSync(join(deployDir, 'exit'), '0\n')
process.env.TEMP_CODE_DEPLOY_DIR = deployDir
process.env.TEMP_CODE_E2E_SEED = '1'
// The host's id is made in its data dir before the boot, so the fake devices gatherer can carry it.
const environmentId = loadEnvironmentId(root)
const server = await startServer(dbPath, {
  claimShim: false,
  remotePort: 0,
  assets,
  devices: new MacDevices(fakeMacDevicesDeps(environmentId, { session: (id) => (id === 'ios-resources' ? { title: 'Clean up after the simulator run', status: 'idle' } : null) }))
})
if (!server.remote || server.remote.port === 0) throw new Error('the remote listener did not bind')

// ── the second host: the same project on another machine ───────────────
// Module-level state in the server (setMediaHost, the media tokens, the log
// sinks) means two startServer calls in one process would share it, so the
// second host is a child process of this script with TC_IOS_SECOND_HOST=1:
// its own temp root and database, a lighter seed, one read key and pairing.
// The workspace folder is named `ios-workspace` on both hosts, so the phone
// pairs the two copies by name (ProjectPairs), and the cross-host child the
// primary's `ios-xhost` spawned lives here with the primary's thread as its
// parent (the way the Mac runs a box thread's subagent).
const gitInit = (dir: string): void => {
  execFileSync('git', ['-C', dir, 'init', '-q'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
}
const workspaceDir = (prefix: string): string => {
  const dir = join(mkdtempSync(join(tmpdir(), prefix)), 'ios-workspace')
  mkdirSync(dir)
  return dir
}
export const THREAD_CROSS_HOST = 'ios-xhost'
export const THREAD_CROSS_HOST_CHILD = 'ios-xhost-child'
if (process.env.TC_IOS_SECOND_HOST === '1') {
  const secondRepo = workspaceDir('tc-ios-client-second-')
  gitInit(secondRepo)
  // The same file as the main host's, so a cross-host file search folds the two hits (search.project matches carry mtime).
  writeFileSync(join(secondRepo, 'fixture-search.txt'), '// Search fixture\nconst fixtureNeedle = true\n')
  const secondWorkspace = await server.registry.createWorkspace(secondRepo, 'ios-workspace')
  const secondProject = await server.registry.createProject(secondWorkspace.id, 'ios-project', 'local')
  const talk = (id: string, user: string, assistant: string): void => {
    server.registry.append(id, { type: 'user-text', text: user })
    server.registry.append(id, { type: 'assistant-text', text: assistant, delta: false, msgId: `${id}-m1`, blockIndex: 0 })
    server.registry.append(id, { type: 'turn-complete' })
  }
  await server.registry.create({ id: 'ios-second-thread', provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', projectId: secondProject.id, threadType: 'implementation', title: 'Same project, other host' })
  talk('ios-second-thread', 'Check the clone on this host', 'The clone is at the same commit.')
  await server.registry.create({ id: THREAD_CROSS_HOST_CHILD, parentId: THREAD_CROSS_HOST, provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'explorer', permission: 'edits', projectId: secondProject.id, title: 'Map the Mac build' })
  talk(THREAD_CROSS_HOST_CHILD, 'Map the Mac build', 'Xcode 26 builds the app in 40 s.')
  const secondKey = await server.remoteAuth.createKey({ name: 'ios-test-second', audience: 'client', caps: [], createdBy: 'local' })
  const secondPairing = server.remoteAuth.createPairing({ name: 'ios-sim-second', audience: 'client', caps: [], createdBy: 'local' })
  const stop = (): void => {
    void server.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stdout.write(
    JSON.stringify({
      ready: true,
      baseUrl: `http://127.0.0.1:${server.remote.port}`,
      environmentId: server.environmentId,
      keyId: secondKey.key.id,
      key: secondKey.token,
      pairingLink: `http://127.0.0.1:${server.remote.port}/pair#${secondPairing.code}`,
      threadChild: THREAD_CROSS_HOST_CHILD
    }) + '\n'
  )
  await new Promise<never>(() => {})
}
type SecondHost = { baseUrl: string; environmentId: string; keyId: string; key: string; pairingLink: string; threadChild: string }
const secondProcess = spawn(process.execPath, [process.argv[1]], { env: { ...process.env, TC_IOS_SECOND_HOST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
const second = await new Promise<SecondHost>((resolveSecond, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('the second host did not come up in 60 s')), 60_000)
  secondProcess.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const line = buffer.split('\n').find((l) => l.startsWith('{') && l.includes('"ready":true'))
    if (!line) return
    clearTimeout(timer)
    resolveSecond(JSON.parse(line) as SecondHost)
  })
  secondProcess.on('exit', (code) => reject(new Error(`the second host exited with ${code}`)))
})

// ── seed ────────────────────────────────────────────────────────────────
const repo = workspaceDir('tc-ios-client-repo-')
execFileSync('git', ['-C', repo, 'init', '-q'])
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
// One file for the phone's Files scope: the proof's `hello` query matches it through search.project.
writeFileSync(join(repo, 'README.md'), 'hello from the ios project\nsay hello to search\n')
writeFileSync(join(repo, 'fixture-search.txt'), '// Search fixture\nconst fixtureNeedle = true\n')
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

// The fleet switches, the queued and stopped roots, the paused master's
// batch and a thread with resources (thread iOS 20). Each seed is skipped
// when a sibling already made the id; the shapes are theirs then.
const has = (id: string): boolean => server.registry.get(id) !== null
if (!has('ios-master')) {
  await make('ios-master', { projectId: project.id, threadType: 'chat', title: 'Ship the stats pipeline' })
  say('ios-master', 'Run the stats batch to the end.', 'Four threads, landing as they finish.')
  server.registry.setMaster('ios-master', true)
}
if (!has('ios-queued')) {
  // A master's child waits for its `after` sibling: created, never booted. The status is appended the way
  // the paused seed appends paused; the scheduler's own line is set beside it so the row reads as the host's.
  await make('ios-queued', { projectId: project.id, threadType: 'implementation', title: 'Backfill the rollups', masterId: 'ios-master', after: 'ios-running' })
  server.registry.append('ios-queued', { type: 'user-text', text: 'Backfill the rollups once the export lands' })
  server.registry.append('ios-queued', { type: 'status', status: 'queued' })
  const lines = (server.registry as unknown as { queuedLines?: Map<string, string> }).queuedLines
  const queued = server.registry.get('ios-queued')
  if (lines && queued) {
    lines.set('ios-queued', 'Queued · waiting for Add the billing export')
    ;(server.registry as unknown as { notifyMeta: (meta: unknown) => void }).notifyMeta(queued)
  }
}
if (!has('ios-stopped')) {
  await make('ios-stopped', { projectId: project.id, threadType: 'chat', title: 'Rename the config keys again' })
  server.registry.append('ios-stopped', { type: 'user-text', text: 'Rename the config keys to the new scheme' })
  server.registry.append('ios-stopped', { type: 'status', status: 'running' })
  server.registry.append('ios-stopped', { type: 'status', status: 'stopped' })
}
if (!has('ios-master-paused')) {
  await make('ios-master-paused', { projectId: project.id, threadType: 'orchestration', agentType: 'orchestrator', title: 'Port the admin pages' })
  server.registry.setMaster('ios-master-paused', true)
  server.registry.append('ios-master-paused', { type: 'user-text', text: 'Port every admin page to the new shell' })
  server.registry.append('ios-master-paused', { type: 'status', status: 'running' })
  server.registry.append('ios-master-paused', { type: 'status', status: 'paused' })
  for (const [id, title] of [['ios-batch-a', 'Admin: users page'], ['ios-batch-b', 'Admin: billing page']] as const) {
    await make(id, { projectId: project.id, threadType: 'implementation', title, masterId: 'ios-master-paused' })
    server.registry.append(id, { type: 'user-text', text: title })
    server.registry.append(id, { type: 'status', status: 'running' })
    server.registry.append(id, { type: 'status', status: 'paused' })
  }
}
if (!has('ios-batch-a-run')) {
  // The live fleet test's own project: two running roots and one running subagent, so Pause all and
  // Resume all over it never touch the seeds the other live tests read.
  const fleetProject = await server.registry.createProject(workspace.id, 'ios-fleet-project', 'local')
  for (const [id, title] of [['ios-batch-a-run', 'Index the archive'], ['ios-batch-b-run', 'Rebuild the search']] as const) {
    await make(id, { projectId: fleetProject.id, threadType: 'implementation', title })
    server.registry.append(id, { type: 'user-text', text: title })
    server.registry.append(id, { type: 'status', status: 'running' })
  }
  await make('ios-batch-a-run-child', { parentId: 'ios-batch-a-run', projectId: fleetProject.id, agentType: 'explorer', title: 'Read the archive layout' })
  server.registry.append('ios-batch-a-run-child', { type: 'user-text', text: 'Read the archive layout' })
  server.registry.append('ios-batch-a-run-child', { type: 'status', status: 'running' })
}
if (!has('ios-resources')) {
  // Two worktrees and a simulator through the real detection path (threadResourcesParse.ts): a Bash call
  // paired with git's "Preparing worktree" line, and a simctl create paired with the UDID it printed.
  await make('ios-resources', { projectId: project.id, threadType: 'implementation', title: 'Build the share sheet' })
  server.registry.append('ios-resources', { type: 'user-text', text: 'Build the share sheet in its own worktree', newPass: true })
  server.registry.append('ios-resources', { type: 'status', status: 'running' })
  for (const [callId, branch] of [['r1', 'ios/share-a'], ['r2', 'ios/share-b']] as const) {
    server.registry.append('ios-resources', { type: 'tool-call', callId, name: 'Bash', input: { command: `git worktree add ../wt-${branch.split('/')[1]} -b ${branch}` } })
    server.registry.append('ios-resources', { type: 'tool-result', callId, output: `Preparing worktree (new branch '${branch}')\nHEAD is now at 1234abc init\n`, isError: false })
  }
  server.registry.append('ios-resources', { type: 'tool-call', callId: 'r3', name: 'Bash', input: { command: 'xcrun simctl create "TC iPhone" "iPhone 17"' } })
  server.registry.append('ios-resources', { type: 'tool-result', callId: 'r3', output: '9F1D2C3B-4A5E-4F60-8B7C-1D2E3F4A5B6C\n', isError: false })
  server.registry.append('ios-resources', { type: 'status', status: 'idle' })
  // A row on another host whose removal waits for its link: straight into the ledger, since no bridge runs here.
  const db = (server.store as unknown as { db?: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
  if (db) {
    db.prepare(
      `INSERT OR IGNORE INTO thread_resources (id, session_id, environment_id, kind, identifier, label, branch, created_at, remove_requested_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('r-mac', 'ios-resources', 'env_mac_test', 'simulator', 'A0B1C2D3-E4F5-4607-8899-AABBCCDDEEFF', 'TC iPhone (Mac)', null, Date.now(), Date.now(), 'host offline, waiting for its link')
  }
}

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

// The master, the one queued seed and the stopped root are thread 20's
// guarded seeds above (ios-master, ios-queued behind ios-running,
// ios-stopped); THREAD_QUEUED names the queued one for the board and the
// fleet hooks alike.
export const THREAD_QUEUED = 'ios-queued'
await make('ios-fleet', { projectId: project.id, threadType: 'orchestration', agentType: 'orchestrator', title: 'Port the sky plugins' })
server.registry.append('ios-fleet', { type: 'user-text', text: 'Port every sky plugin to the new core' })
server.registry.append('ios-fleet', { type: 'status', status: 'running' })
await make('ios-fleet-explorer', { parentId: 'ios-fleet', projectId: project.id, agentType: 'explorer', title: 'Map the plugin boundaries' })
server.registry.append('ios-fleet-explorer', { type: 'user-text', text: 'Map the plugin boundaries' })
server.registry.append('ios-fleet-explorer', { type: 'status', status: 'running' })
server.registry.append('ios-fleet-explorer', { type: 'tool-call', callId: 'e1', name: 'Read', input: { file_path: 'plugins/README.md' } })
await make('ios-fleet-reviewer', { parentId: 'ios-fleet', projectId: project.id, agentType: 'reviewer', model: 'claude-opus-5-5', title: 'Review the first port' })
say('ios-fleet-reviewer', 'Review the first port', 'Two findings, both minor.')
// A thread whose subagent runs on the second host (and one whose host nobody pairs).
await make(THREAD_CROSS_HOST, { projectId: project.id, threadType: 'orchestration', agentType: 'orchestrator', title: 'Build the phone on the Mac' })
server.registry.append(THREAD_CROSS_HOST, { type: 'user-text', text: 'Build the phone on the Mac and report the warnings' })
server.registry.append(THREAD_CROSS_HOST, { type: 'status', status: 'running' })
server.registry.append(THREAD_CROSS_HOST, { type: 'agent-spawned', childSessionId: THREAD_CROSS_HOST_CHILD, environmentId: second.environmentId })
server.registry.append(THREAD_CROSS_HOST, { type: 'agent-spawned', childSessionId: 'ios-ghost-child', environmentId: 'env_' + 'a'.repeat(22) })

// The thread screen's frame: a chat root with subagents, for the toolbar's agents button.
await make('ios-chat-agents', { projectId: project.id, threadType: 'chat', title: 'Find the slow query' })
server.registry.append('ios-chat-agents', { type: 'user-text', text: 'Find the query that slows the dashboard down' })
server.registry.append('ios-chat-agents', { type: 'status', status: 'running' })
await make('ios-chat-agents-explorer', { parentId: 'ios-chat-agents', projectId: project.id, agentType: 'explorer', title: 'Profile the dashboard queries' })
server.registry.append('ios-chat-agents-explorer', { type: 'user-text', text: 'Profile the dashboard queries' })
server.registry.append('ios-chat-agents-explorer', { type: 'status', status: 'running' })
server.registry.append('ios-chat-agents-explorer', { type: 'tool-call', callId: 'q1', name: 'Read', input: { file_path: 'src/dashboard/queries.ts' } })
await make('ios-chat-agents-reviewer', { parentId: 'ios-chat-agents', projectId: project.id, agentType: 'reviewer', model: 'claude-opus-5-5', title: 'Check the index plan' })
say('ios-chat-agents-reviewer', 'Check the index plan', 'The composite index covers it.')

// Chats: one in the workspace with no project, one outside every workspace; a thread in the archived project.
await make('ios-chat-workspace', { workspaceId: workspace.id, threadType: 'chat', title: 'Why is the build slow?' })
say('ios-chat-workspace', 'Why is the build slow today?', 'The cache was cold.')
await make('ios-chat-loose', { cwd: tmpdir(), threadType: 'chat', title: 'Regex for ISO dates' })
say('ios-chat-loose', 'A regex for ISO dates?', 'Use a date parser instead.')
await make('ios-retired', { projectId: retired.id, threadType: 'chat', title: 'Old migration notes' })
say('ios-retired', 'Keep these notes.', 'Kept.')
await server.registry.archiveProject(retired.id, true)
// The Search tab's notes hits: a thread's working notes (session.search answers a source: 'notes' row for "gateway") and an app note (notes.search).
server.registry.notes.write('ios-chat-workspace', '## Pointers\n\n- the gateway port is 8787\n', Date.now(), 'tool')
server.notes.upsert({ id: 'ios-note-gateway', title: 'Gateway notes', body: 'the gateway trace flag is TEMP_CODE_GATEWAY_TRACE', sourceCwd: repo })
// ── one thread per type, with realistic rows (the thread screens' proof) ──
const at = (id: string, events: AgentEvent[]): void => {
  for (const event of events) server.registry.append(id, event)
}
const todos = (callId: string, list: [string, 'pending' | 'in_progress' | 'completed'][]): AgentEvent => ({
  type: 'tool-call',
  callId,
  name: 'TodoWrite',
  input: { todos: list.map(([content, status]) => ({ content, status })) }
})
const edit = (callId: string, path: string, additions: number, deletions: number, lines: { kind: 'add' | 'del' | 'context'; text: string; number?: number }[]): AgentEvent[] => [
  {
    type: 'tool-call',
    callId,
    name: 'Edit',
    input: { file_path: path, old_string: lines.filter((l) => l.kind !== 'add').map((l) => l.text).join('\n'), new_string: lines.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n') },
    preview: { kind: 'write', path, fileName: path.split('/').pop(), additions, deletions, lines }
  },
  { type: 'tool-result', callId, output: `The file ${path} has been updated.`, isError: false }
]
const read = (callId: string, path: string, output = 'export const theme = "light"\n'): AgentEvent[] => [
  { type: 'tool-call', callId, name: 'Read', input: { file_path: path }, preview: { kind: 'read', path, fileName: path.split('/').pop() } },
  { type: 'tool-result', callId, output, isError: false }
]
const shell = (callId: string, command: string, output: string, isError = false): AgentEvent[] => [
  { type: 'tool-call', callId, name: 'Bash', input: { command, description: command }, preview: { kind: 'shell', title: command } },
  { type: 'tool-result', callId, output, isError }
]
const answer = (msgId: string, text: string): AgentEvent => ({ type: 'assistant-text', text, delta: false, msgId, blockIndex: 0 })
const think = (msgId: string, text: string): AgentEvent[] => [
  { type: 'thinking', text: text.slice(0, 12), delta: true, msgId, blockIndex: 0 },
  { type: 'thinking', text, delta: false, msgId, blockIndex: 0 }
]
const status = (s: 'idle' | 'running' | 'waiting'): AgentEvent => ({ type: 'status', status: s })

const makeTyped = async (id: string, threadType: 'chat' | 'planning' | 'project-plan' | 'implementation' | 'orchestration' | 'research', title: string, extra: Record<string, unknown> = {}) =>
  server.registry.create({ id, provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'medium', agentType: 'implementer', permission: 'edits', projectId: project.id, threadType, title, ...extra })

// Implementation: two passes, todos in every status, edits with stats, an undecided approval, a closing report.
export const THREAD_IMPL = 'ios-impl'
await makeTyped(THREAD_IMPL, 'implementation', 'Add dark mode to the settings screen')
at(THREAD_IMPL, [
  { type: 'user-text', text: 'Add dark mode to the settings screen. Follow the theme tokens in src/settings/Theme.ts.', model: 'claude-sonnet-5-5', reasoning: 'medium', newPass: true },
  ...think('i1', 'The theme file holds the tokens; the view reads them through a hook. Three steps: tokens, the toggle, tests.'),
  todos('t1', [['Add the dark palette to Theme.ts', 'in_progress'], ['Wire the toggle in SettingsView', 'pending'], ['Run the settings tests', 'pending']]),
  ...read('r1', 'src/settings/Theme.ts', 'export const light = { bg: "#fff", fg: "#111" }\nexport const theme = light\n'),
  ...edit('e1', 'src/settings/Theme.ts', 12, 3, [
    { kind: 'context', number: 1, text: 'export const light = { bg: "#fff", fg: "#111" }' },
    { kind: 'add', number: 2, text: 'export const dark = { bg: "#000", fg: "#eee" }' },
    { kind: 'del', number: 3, text: 'export const theme = light' },
    { kind: 'add', number: 3, text: 'export const theme = (mode: "light" | "dark") => (mode === "dark" ? dark : light)' }
  ]),
  answer('i2', 'The palette is in. Now the toggle.'),
  todos('t2', [['Add the dark palette to Theme.ts', 'completed'], ['Wire the toggle in SettingsView', 'in_progress'], ['Run the settings tests', 'pending']]),
  ...read('r2', 'src/settings/SettingsView.tsx'),
  ...edit('e2', 'src/settings/SettingsView.tsx', 24, 8, [
    { kind: 'context', number: 40, text: '  return (' },
    { kind: 'del', number: 41, text: '    <Section title="Appearance" />' },
    { kind: 'add', number: 41, text: '    <Section title="Appearance">' },
    { kind: 'add', number: 42, text: '      <Toggle label="Dark mode" value={mode === "dark"} onChange={toggle} />' },
    { kind: 'add', number: 43, text: '    </Section>' }
  ]),
  ...edit('e3', 'src/settings/SettingsView.tsx', 2, 0, [
    { kind: 'add', number: 1, text: 'import { Toggle } from "../ui/Toggle"' },
    { kind: 'add', number: 2, text: 'import { useTheme } from "./useTheme"' }
  ]),
  todos('t3', [['Add the dark palette to Theme.ts', 'completed'], ['Wire the toggle in SettingsView', 'completed'], ['Run the settings tests', 'in_progress']]),
  ...shell('s1', 'bun test src/settings', ' ✓ settings (4 tests) 120ms\n\n 4 pass\n 0 fail\n'),
  todos('t4', [['Add the dark palette to Theme.ts', 'completed'], ['Wire the toggle in SettingsView', 'completed'], ['Run the settings tests', 'completed']]),
  answer('i3', 'Dark mode is in.\n\n- `Theme.ts` exports a `dark` palette and `theme(mode)`\n- `SettingsView` shows the toggle under **Appearance**\n- the four settings tests pass\n\nNothing else changed.'),
  { type: 'turn-complete', costUsd: 0.42, inputTokens: 18_400, outputTokens: 2_100 },
  // The pass landed through merge_branch: the gate run and the review verdict, the board's landing rows.
  { type: 'notice', kind: 'gate', message: 'Typecheck passed on ios/dark-mode', gate: { step: 'typecheck', branch: 'ios/dark-mode', ok: true, log: '$ bun run typecheck\n✓ typecheck 14s', at: Date.now() - 90_000 } },
  { type: 'notice', kind: 'review', message: 'Reviewed by GPT-6.1 Sol: no blocking findings (1 minor)', review: { runId: 'r1', reviewerId: 'ios-impl-review', provider: 'codex', model: 'gpt-6.1-sol', outcome: 'pass', branch: 'ios/dark-mode', target: 'master', blocking: [], minor: [{ file: 'src/settings/Theme.ts', line: 3, summary: 'The mode parameter is untyped at the call site', failure_scenario: 'A caller passes "Dark" and gets the light theme', verdict: 'PLAUSIBLE' }], merged: true, pushed: true, minutes: 2.4 } },
  status('idle'),
  { type: 'user-text', text: 'Also add a "System" option that follows the OS.', newPass: true },
  todos('t5', [['Add the system option to the theme hook', 'in_progress'], ['Cover it in the settings tests', 'pending']]),
  ...edit('e4', 'src/settings/useTheme.ts', 6, 1, [
    { kind: 'del', number: 3, text: 'type Mode = "light" | "dark"' },
    { kind: 'add', number: 3, text: 'type Mode = "light" | "dark" | "system"' },
    { kind: 'add', number: 4, text: 'const system = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")' }
  ]),
  { type: 'approval-request', requestId: 'ap1', toolName: 'Bash', title: 'bun run build', input: { command: 'bun run build' } },
  status('waiting')
])

// The reviewer the review notice names, a settled child; the Reviewer pill pushes to it.
await make('ios-impl-review', { parentId: THREAD_IMPL, projectId: project.id, agentType: 'reviewer', provider: 'codex', model: 'gpt-6.1-sol', title: 'Review: ios/dark-mode → master' })
say('ios-impl-review', 'Review the diff of ios/dark-mode against master.', 'One minor finding, nothing blocking.')

// An implementation whose landing was held: a failed typecheck gate, then a
// review with one blocking finding, so the board shoots both failure rows.
export const THREAD_HELD = 'ios-held'
await makeTyped(THREAD_HELD, 'implementation', 'Rename the export flag')
at(THREAD_HELD, [
  { type: 'user-text', text: 'Rename the --csv flag to --export everywhere it is read.', newPass: true },
  todos('h1', [['Rename the flag in the parser', 'in_progress'], ['Update the two call sites', 'pending']]),
  ...edit('he1', 'src/cli/flags.ts', 2, 2, [
    { kind: 'del', number: 8, text: "  csv: { type: 'boolean' }," },
    { kind: 'add', number: 8, text: "  export: { type: 'boolean' }," }
  ]),
  todos('h2', [['Rename the flag in the parser', 'completed'], ['Update the two call sites', 'in_progress']]),
  ...edit('he2', 'src/cli/run.ts', 1, 1, [
    { kind: 'del', number: 40, text: '  if (flags.csv) exportCsv()' },
    { kind: 'add', number: 40, text: '  if (flags.export) exportCsv()' }
  ]),
  todos('h3', [['Rename the flag in the parser', 'completed'], ['Update the two call sites', 'completed']]),
  answer('h4', 'The flag is `--export` now; both call sites follow.'),
  { type: 'turn-complete', costUsd: 0.11, inputTokens: 6_200, outputTokens: 800 },
  { type: 'notice', kind: 'gate', message: 'Typecheck failed on ios/export-flag · 2 errors', gate: { step: 'typecheck', branch: 'ios/export-flag', ok: false, log: "$ bun run typecheck\nsrc/cli/report.ts(12,15): error TS2339: Property 'csv' does not exist on type 'Flags'.\nsrc/cli/report.test.ts(30,22): error TS2339: Property 'csv' does not exist on type 'Flags'.\n\nFound 2 errors in 2 files.\n", at: Date.now() - 300_000 } },
  { type: 'notice', kind: 'review', message: 'Reviewed by GPT-6.1 Sol: 1 blocking finding, merge held', review: { runId: 'r2', reviewerId: 'ios-held-review', provider: 'codex', model: 'gpt-6.1-sol', outcome: 'held', branch: 'ios/export-flag', target: 'master', blocking: [{ file: 'src/cli/report.ts', line: 12, summary: 'report.ts still reads flags.csv, so the report never exports', failure_scenario: 'Run with --export: the report step sees csv undefined and skips the write', verdict: 'CONFIRMED' }], minor: [{ file: 'docs/cli.md', line: 44, summary: 'The docs still name --csv', failure_scenario: 'A reader follows the docs and the flag is unknown' }], merged: false, pushed: false, minutes: 3.1 } },
  status('idle')
])
await make('ios-held-review', { parentId: THREAD_HELD, projectId: project.id, agentType: 'reviewer', provider: 'codex', model: 'gpt-6.1-sol', title: 'Review: ios/export-flag → master' })
say('ios-held-review', 'Review the diff of ios/export-flag against master.', 'One blocking finding: report.ts still reads flags.csv.')

// Implementation whose first edit is one big diff: 3,600 preview lines over
// 60 hunks with a long line in each, for the diff screen's virtualization,
// hunk navigation and per-hunk horizontal scroll. Past 2 KiB the host keeps
// the lines, so opening it fetches them behind the shimmer.
export const THREAD_BIG_DIFF = 'ios-big-diff'
await makeTyped(THREAD_BIG_DIFF, 'implementation', 'Rewrite the gateway router')
const bigLines: { kind: 'add' | 'del' | 'context'; text: string; number?: number }[] = []
let bigAdds = 0
let bigDels = 0
for (let h = 0; h < 60; h++) {
  for (let i = 0; i < 50; i++) {
    const n = h * 120 + i + 1
    const pick = (n * 7) % 5
    const long = i === 25 ? `  // ${'─'.repeat(120)} a long line that scrolls sideways` : ''
    if (pick === 1) {
      bigLines.push({ kind: 'del', number: n, text: `  const route${n} = legacy.match(path, ${n})${long}` })
      bigDels++
    }
    if (pick === 1 || pick === 3) {
      bigLines.push({ kind: 'add', number: n, text: `  const route${n} = router.resolve(path, { scope: ${n} })${long}` })
      bigAdds++
    } else {
      bigLines.push({ kind: 'context', number: n, text: `  forward(route${n}, request)${long}` })
    }
  }
}
at(THREAD_BIG_DIFF, [
  { type: 'user-text', text: 'Rewrite the gateway router on top of resolve().', model: 'claude-sonnet-5-5', reasoning: 'medium', newPass: true },
  todos('bt1', [['Rewrite the router', 'completed'], ['Run the gateway tests', 'in_progress']]),
  {
    type: 'tool-call',
    callId: 'be1',
    name: 'Edit',
    input: { file_path: 'src/main/server/gateway/router.ts', old_string: 'legacy.match', new_string: 'router.resolve' },
    preview: { kind: 'write', path: 'src/main/server/gateway/router.ts', fileName: 'router.ts', additions: bigAdds, deletions: bigDels, lines: bigLines }
  },
  { type: 'tool-result', callId: 'be1', output: 'The file src/main/server/gateway/router.ts has been updated.', isError: false },
  ...shell('bs1', 'bun test src/main/server/gateway', ' ✓ gateway (12 tests) 340ms\n'),
  status('running')
])

// Planning: a plan file on disk.
export const THREAD_PLAN = 'ios-plan'
const plan = await makeTyped(THREAD_PLAN, 'planning', 'Move the thread history onto the box')
at(THREAD_PLAN, [
  { type: 'user-text', text: 'Plan the move of the Mac\'s thread history onto the box, so the Mac becomes the Apple-only host.', newPass: true },
  ...think('p1', 'The history is one SQLite file plus checkpoints; the box already runs the server. Snapshot, copy, verify, cut over.'),
  answer('p2', 'The plan is written. Four tasks, with a rehearsal before the cutover.'),
  { type: 'turn-complete', costUsd: 0.11 },
  status('idle')
])
if (plan.planPath) {
  mkdirSync(dirname(plan.planPath), { recursive: true })
  writeFileSync(
    plan.planPath,
    [
      '# Move the thread history onto the box',
      '',
      'The Mac keeps the Apple-only work (signing, the simulator, Xcode). Everything else, the 4 GB database and the 17 GB of checkpoints, moves to the box, which already runs the server headless.',
      '',
      '## Overview',
      '',
      '1. Snapshot the database with `VACUUM INTO` so the live file is never copied.',
      '2. Copy the snapshot and the checkpoints over the tunnel with `restic`.',
      '3. Point the box at the restored data and run the remote proofs.',
      '',
      '| Host | Size | Keeps |',
      '| --- | ---: | --- |',
      '| Mac | 4 GB | signing, the simulator, Xcode |',
      '| Box | 17 GB | the database and the checkpoints |',
      '',
      '```sh',
      'sqlite3 app.db "VACUUM INTO \'snapshot.db\'"',
      'restic backup snapshot.db checkpoints/',
      '```',
      '',
      '## Tasks',
      '',
      '- [x] Snapshot the database with VACUUM INTO',
      '- [ ] Copy the snapshot and checkpoints to the box',
      '- [ ] Rehearse the cutover on a copy',
      '- [ ] Cut over and retire the Mac as a host',
      '',
      '## Risks',
      '',
      '- A checkpoint written during the copy: the rehearsal catches it.',
      '  - A second rehearsal if the first finds one.',
      '- The tunnel dropping mid-copy: restic resumes.',
      ''
    ].join('\n')
  )
}

// Project plan: a complete plan with seven milestones, three landed, kept as
// the project's plan; and the build that landed milestone 3, linked to it.
// The real projectPlan.* handlers serve the phone from this seed.
export const THREAD_PROJECT_PLAN = 'ios-project-plan'
const projectPlan = await makeTyped(THREAD_PROJECT_PLAN, 'project-plan', 'Project plan: the billing service')
at(THREAD_PROJECT_PLAN, [
  { type: 'user-text', text: 'Plan the billing service end to end.', newPass: true },
  ...think('pp1', 'Seven milestones: the data model first, the ledger on it, then the money paths, the admin screens and the cutover last.'),
  answer('pp2', 'The project plan is written: seven milestones, three already landed.'),
  { type: 'turn-complete', costUsd: 0.18 },
  status('idle')
])
if (projectPlan.planPath) {
  mkdirSync(dirname(projectPlan.planPath), { recursive: true })
  const milestone = (done: boolean, n: number, title: string, scope: string, deps: string, doneWhen: string): string[] => [
    `### [${done ? 'x' : ' '}] ${n}. ${title}`,
    `- Scope: ${scope}`,
    `- Dependencies: ${deps}`,
    `- Done when: ${doneWhen}`,
    ''
  ]
  writeFileSync(
    projectPlan.planPath,
    [
      '---',
      'status: complete',
      'completed: 2026-10-21T12:00:00.000Z',
      '---',
      '# The billing service — project plan',
      '',
      '## Goals',
      '',
      'Bill every account once a month from the ledger, with no hand-made invoice. Every charge and refund traces back to one ledger entry.',
      '',
      '## Current state',
      '',
      'The ledger schema and its API are in and the invoice totals land on the ledger. Nothing reaches a card yet.',
      '',
      '- Stripe is the only processor in scope.',
      '',
      '## Milestones',
      '',
      ...milestone(true, 1, 'Data model', 'accounts, ledger entries, invoices and their migrations', 'none', 'the schema tests pass on an empty database'),
      ...milestone(true, 2, 'Ledger API', 'post, reverse and list entries over the control API', '1', 'the ledger e2e passes'),
      ...milestone(true, 3, 'Invoice totals', 'the monthly roll-up of entries into an invoice per account', '1, 2', 'a generated invoice matches the fixture to the cent'),
      ...milestone(false, 4, 'Payments webhook', 'Stripe events into ledger entries, idempotent per event id', '3', 'a replayed event books nothing twice'),
      ...milestone(false, 5, 'Statements export', 'monthly statements as PDF and CSV from the invoice', '4', 'a statement renders for every seeded account'),
      ...milestone(false, 6, 'Admin screens', 'the invoice list, the ledger view and a refund button', '2, 5', 'an admin refunds a test charge from the screen'),
      ...milestone(false, 7, 'Cutover', 'the first real billing run with the old invoices frozen', '4, 5, 6', 'one month billed with no hand-made invoice'),
      '## Risks',
      '',
      '- A webhook delivered twice books a charge twice: the event id is the idempotency key.',
      '- The roll-up crosses a month boundary in the wrong zone: every date is UTC.',
      '',
      '## Open questions',
      '',
      '- Do refunds reopen a closed invoice or book a credit on the next one?',
      ''
    ].join('\n')
  )
}
export const THREAD_M3_BUILD = 'ios-m3-build'
await makeTyped(THREAD_M3_BUILD, 'implementation', 'M3 · Invoice totals')
at(THREAD_M3_BUILD, [
  { type: 'user-text', text: 'Implement the plan "M3 · Invoice totals".', newPass: true },
  todos('m3t', [['Roll entries up per account and month', 'completed'], ['Match the fixture to the cent', 'completed']]),
  answer('m3a', 'The roll-up is in and the fixture matches to the cent.'),
  { type: 'turn-complete', costUsd: 0.31 },
  status('idle')
])
// The link a landed build carries: milestone 3's tick in the file is the one that landing wrote.
server.store.setSetting(`projectPlan.milestone:${THREAD_M3_BUILD}`, JSON.stringify({ projectId: project.id, milestone: 3 }))
// Kept as the project's plan, so the chip on Home reads "Plan · 3/7".
server.store.setSetting(`projectPlan.pinned:${project.id}`, '1')

// Orchestration: three agents in different states.
export const THREAD_ORCH = 'ios-orch'
await makeTyped(THREAD_ORCH, 'orchestration', 'Ship the iOS thread screens')
at(THREAD_ORCH, [
  { type: 'user-text', text: 'Build the shell and the thread screens in parallel, then have a reviewer read both.', newPass: true },
  answer('o1', 'Spawning three agents: the shell, the screens, and a reviewer once both land.'),
  { type: 'tool-call', callId: 'sp1', name: 'mcp__orchestrator__spawn_agent', input: { agents: [{ task: 'Build the shell' }, { task: 'Build the thread screens' }, { task: 'Review both' }] } }
])
const agent = async (id: string, agentType: 'implementer' | 'reviewer' | 'explorer', title: string, events: AgentEvent[]) => {
  await server.registry.create({ id, parentId: THREAD_ORCH, provider: agentType === 'reviewer' ? 'codex' : 'claude', model: agentType === 'reviewer' ? 'gpt-6-astra' : 'claude-opus-5-5', reasoning: 'high', agentType, permission: 'edits', projectId: project.id, title })
  at(id, events)
}
await agent('ios-orch-a1', 'implementer', 'Build the shell', [
  { type: 'user-text', text: 'Build the shell: Home, Inbox, Search, Settings.' },
  todos('a1t', [['Design tokens', 'completed'], ['Home', 'in_progress'], ['Inbox and Search', 'pending']]),
  ...edit('a1e', 'ios/TempCode/Sources/Shell/HomeView.swift', 140, 0, [{ kind: 'add', number: 1, text: 'import SwiftUI' }]),
  { type: 'tool-call', callId: 'a1b', name: 'Bash', input: { command: 'xcodebuild build -scheme TempCode' }, preview: { kind: 'shell', title: 'xcodebuild build -scheme TempCode' } },
  status('running')
])
await agent('ios-orch-a2', 'reviewer', 'Review the fold', [
  { type: 'user-text', text: 'Review the fold against the desktop rules.' },
  ...read('a2r', 'ios/TempCodeClient/Sources/TempCodeClient/Rendering/ThreadFold.swift'),
  { type: 'approval-request', requestId: 'a2ap', toolName: 'Bash', title: 'rm -rf ios/TempCodeClient/.build', input: { command: 'rm -rf ios/TempCodeClient/.build' } },
  status('waiting')
])
await agent('ios-orch-a3', 'explorer', 'Find the row sizes', [
  { type: 'user-text', text: 'Find the row sizes the desktop uses.' },
  ...read('a3r', 'src/renderer/src/surfaces/threads/bits.tsx'),
  answer('a3s', 'Rows are 44 pt minimum; the status dot is 6 px.'),
  { type: 'turn-complete', costUsd: 0.03 },
  status('idle')
])
// TC_TEST_FLEET=large: nine more children, so the phone's list reads as four groups
// (Running, Waiting, Queued, Done) with twelve agents. Off by default.
if (process.env.TC_TEST_FLEET === 'large') {
  for (let n = 4; n <= 12; n++) {
    const id = `ios-orch-a${n}`
    const title = `Port module ${n}`
    if (n === 11) {
      await agent(id, 'implementer', title, [{ type: 'user-text', text: `${title}.` }, { type: 'status', status: 'queued' }])
    } else if (n === 12) {
      await agent(id, 'implementer', title, [
        { type: 'user-text', text: `${title}.` },
        answer(`${id}s`, 'Halfway through the port.'),
        { type: 'status', status: 'stopped', detail: 'The harness behind this turn is gone' }
      ])
    } else {
      await agent(id, 'implementer', title, [
        { type: 'user-text', text: `${title}.` },
        answer(`${id}s`, `Module ${n} ported.`),
        { type: 'turn-complete', costUsd: Math.round((n - 3) * 5) / 100 },
        status('idle')
      ])
    }
  }
}
at(THREAD_ORCH, [
  { type: 'tool-result', callId: 'sp1', output: 'Spawned 3 agents', isError: false },
  { type: 'tool-call', callId: 'w1', name: 'mcp__orchestrator__wait_for_agent', input: { agentIds: ['ios-orch-a1', 'ios-orch-a2', 'ios-orch-a3'], mode: 'all' } },
  status('running')
])

// Research: a report with two angles.
export const THREAD_RESEARCH = 'ios-research'
const research = await makeTyped(THREAD_RESEARCH, 'research', 'SQLite on the phone: bun:sqlite or GRDB')
for (const [id, title] of [['ios-research-a1', 'Angle: bun:sqlite'], ['ios-research-a2', 'Angle: GRDB']] as const) {
  await server.registry.create({ id, parentId: THREAD_RESEARCH, provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'explorer', permission: 'safe', projectId: project.id, title })
  at(id, [{ type: 'user-text', text: `Research ${title.slice(7)}` }, answer(`${id}s`, 'Findings written.'), { type: 'turn-complete' }, status('idle')])
}
at(THREAD_RESEARCH, [
  { type: 'user-text', text: 'Compare bun:sqlite and GRDB for the phone\'s cache: write speed, migrations, and Swift ergonomics.', newPass: true },
  answer('r1', 'Two angles: the Bun side and the Swift side.'),
  { type: 'research-source', callId: 'q1', query: 'bun sqlite write performance', agentId: 'ios-research-a1', agentLabel: 'Angle: bun:sqlite' },
  { type: 'research-source', callId: 's1', url: 'https://bun.sh/docs/api/sqlite', agentId: 'ios-research-a1', agentLabel: 'Angle: bun:sqlite', title: 'SQLite – Bun Docs' },
  { type: 'research-source', callId: 's1', url: 'https://bun.sh/docs/api/sqlite', agentId: 'ios-research-a1', agentLabel: 'Angle: bun:sqlite', claim: 'bun:sqlite ships built in and binds synchronously' },
  { type: 'research-source', callId: 'q2', query: 'GRDB swift sqlite value types', agentId: 'ios-research-a2', agentLabel: 'Angle: GRDB' },
  { type: 'research-source', callId: 's2', url: 'https://github.com/groue/GRDB.swift', agentId: 'ios-research-a2', agentLabel: 'Angle: GRDB', title: 'GRDB.swift: a toolkit for SQLite databases' },
  { type: 'research-source', callId: 'cite:1', url: 'https://github.com/groue/GRDB.swift', agentId: 'ios-research-a2', agentLabel: 'Angle: GRDB', claim: 'GRDB maps rows to Codable value types with no ORM layer' },
  { type: 'research-source', callId: 's3', url: 'https://www.sqlite.org/wal.html', agentId: 'ios-research-a2', agentLabel: 'Angle: GRDB', title: 'Write-Ahead Logging', claim: 'WAL lets one writer and many readers share the file' },
  answer('r2', 'The report is written: GRDB for the phone, bun:sqlite on the host.'),
  { type: 'turn-complete', costUsd: 0.27 },
  status('idle')
])
if (research.planPath) {
  mkdirSync(dirname(research.planPath), { recursive: true })
  writeFileSync(
    research.planPath,
    ['---', 'title: SQLite on the phone', 'status: complete', 'summary: GRDB on the phone, bun:sqlite on the host', '---', '# SQLite on the phone', '', 'Both wrap the same engine. The phone wants value types and a migration story; the host wants a synchronous binding with no build step.', '', '## Findings', '', '- GRDB maps rows to Codable value types [1].', '- bun:sqlite binds synchronously and ships with Bun [2].', '- WAL lets one writer and many readers share the file [3].', '', '## Sources', '', '1. [GRDB.swift](https://github.com/groue/GRDB.swift)', '2. [SQLite – Bun Docs](https://bun.sh/docs/api/sqlite)', '3. [Write-Ahead Logging](https://www.sqlite.org/wal.html)', ''].join('\n')
  )
}

// A real PNG for the chat's attachment: 8-bit RGB, one unfiltered IDAT.
const crc32 = (buf: Buffer): number => {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
const pngChunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const pngOf = (w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Buffer => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      const o = y * stride + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

// A chat: thinking, a long omitted tool output, a failed tool, an image, a compaction, an error.
export const THREAD_CHAT = 'ios-chat'
await makeTyped(THREAD_CHAT, 'chat', 'Why does the gateway refuse http for Codex?')
const shot = join(repo, 'shot.png')
writeFileSync(shot, pngOf(320, 200, (x, y) => [40 + Math.round((x / 320) * 120), 90 + Math.round((y / 200) * 80), 200 - Math.round((x / 320) * 60)]))
at(THREAD_CHAT, [
  { type: 'user-text', text: 'Why does the gateway refuse http for Codex? Here is what I see.', attachments: [{ name: 'shot.png', mime: 'image/png', kind: 'image', path: shot }] },
  ...think('c1', 'Codex 0.158 keeps only the origin of an https base url, so a path scope is lost; the gateway gives each codex thread its own https port instead.'),
  answer('c2', 'Codex 0.158 and later refuse an `http` base url and keep only the **origin** of an `https` one, so the `~t=` path scope is dropped.\n\nThe gateway answers with one https port per thread:\n\n```ts\nconst url = await gateway.scopedCodexUrl(threadId)\n```\n\n1. the listener rewrites `/backend-api/*` into the scoped path\n2. WebSocket upgrades get a 426 so codex falls back to its HTTP stream\n3. the certificate is trusted through `CODEX_CA_CERTIFICATE`'),
  ...shell('c3', 'TEMP_CODE_GATEWAY_TRACE=1 bun run dev 2>&1 | head -100', bigOutput),
  { type: 'tool-call', callId: 'c4', name: 'Read', input: { file_path: 'src/main/server/gateway.md' }, preview: { kind: 'read', path: 'src/main/server/gateway.md', fileName: 'gateway.md' } },
  { type: 'tool-result', callId: 'c4', output: 'ENOENT: no such file or directory', isError: true },
  answer('c9', 'The port is minted in `scopedCodexUrl`; `endpoint.ts` only reads it.'),
  // Three settled reads in a row after the prose: the phone folds them
  // behind "+2 previous tool calls" (the shell and the failed read above
  // make a pair of their own); the last one's output is long enough to be
  // omitted on the wire, so the chip opens on a shimmer.
  ...read('c6', 'src/main/server/gateway.ts'),
  ...read('c7', 'src/main/server/endpoint.ts'),
  ...read('c8', 'src/main/server/upstream.ts', Array.from({ length: 1_400 }, (_, i) => `${String(i + 1).padStart(4)}  ${line(i % 100)}`).join('\n')),
  // An edit with a write preview: the card reads +2 −1 and opens the diff.
  ...edit('c10', 'src/main/server/endpoint.ts', 2, 1, [
    { kind: 'context', text: "export function routedEndpointFor(provider: Provider): Endpoint {", number: 40 },
    { kind: 'del', text: '  if (provider === "codex") return gateway.url', number: 41 },
    { kind: 'add', text: '  if (provider === "codex") return gateway.scopedCodexUrl(threadId)', number: 41 },
    { kind: 'add', text: '  // One https port per codex thread: the port is the scope.', number: 42 }
  ]),
  // A spawn row naming a thread the fleet seeds, so the row links to it.
  { type: 'agent-spawned', childSessionId: 'ios-fleet-explorer' },
  { type: 'compaction', phase: 'start', trigger: 'auto', preTokens: 142_000 },
  { type: 'compaction', phase: 'done', trigger: 'auto', preTokens: 142_000, postTokens: 38_000, durationMs: 2_400 },
  { type: 'error', message: 'The provider answered 429: rate limited for 20 s' },
  answer('c5', 'So the fix lives in the gateway, not in codex: see `routedEndpointFor` in endpoint.ts.'),
  { type: 'turn-complete', costUsd: 0.09, inputTokens: 9_000, outputTokens: 800 },
  status('idle')
])

// A chat with 2,000 rows, for the scroll proof.
export const THREAD_LONG = 'ios-long'
await makeTyped(THREAD_LONG, 'chat', '2,000 rows')
for (let i = 0; i < 500; i++) {
  at(THREAD_LONG, [
    { type: 'user-text', text: `Turn ${i + 1}: what does row ${i * 4 + 1} say?` },
    { type: 'tool-call', callId: `l${i}`, name: 'Read', input: { file_path: `src/row-${i}.ts` }, preview: { kind: 'read', path: `src/row-${i}.ts`, fileName: `row-${i}.ts` } },
    { type: 'tool-result', callId: `l${i}`, output: `row ${i}`, isError: false },
    answer(`lm${i}`, i % 7 === 0 ? `Row ${i} holds a **bold** claim and a list:\n\n- one\n- two\n\n\`\`\`ts\nconst row = ${i}\n\`\`\`` : `Row ${i} says \`${i * 4 + 1}\` and nothing more.`)
  ])
}
at(THREAD_LONG, [{ type: 'turn-complete' }, status('idle')])

// ── the host's own rows (thread 19): every notice kind, every failure kind, a preamble, a handoff ──
export const THREAD_NOTICES = 'ios-notices'
await makeTyped(THREAD_NOTICES, 'implementation', 'Land the export endpoint')
await make('ios-notices-reviewer', { parentId: THREAD_NOTICES, projectId: project.id, agentType: 'reviewer', model: 'gpt-6.1-sol', provider: 'codex', title: 'Review: ios/export → master' })
say('ios-notices-reviewer', 'Review the branch', 'Two blocking findings, one minor.')
const finding = (file: string, line: number, summary: string, failure_scenario: string, verdict?: 'CONFIRMED' | 'PLAUSIBLE'): ReviewNotice['blocking'][number] => ({ file, line, summary, failure_scenario, ...(verdict ? { verdict } : {}) })
const review = (over: Partial<ReviewNotice>): ReviewNotice => ({ runId: 'r1', provider: 'codex', model: 'gpt-6.1-sol', outcome: 'pass', branch: 'ios/export', target: 'master', blocking: [], minor: [], merged: true, pushed: true, ...over })
at(THREAD_NOTICES, [
  { type: 'user-text', text: 'Land the export endpoint on master.', newPass: true },
  { type: 'notice', kind: 'gate', message: 'Typecheck passed on ios/export', gate: { step: 'typecheck', branch: 'ios/export', ok: true, log: '', at: Date.now() } },
  { type: 'notice', kind: 'review', message: 'Reviewed by GPT-6.1 Sol: no blocking findings (1 minor)', review: review({ runId: 'r-pass', minor: [finding('src/export.ts', 12, 'The CSV header is built on every row', 'A 10,000-row export rebuilds the header string 10,000 times.')] }) },
  { type: 'notice', kind: 'batch', message: 'Merged by the batch: ios/export → master at 1a2b3c4d5e, pushed' },
  { type: 'user-text', text: 'Now the import side.', newPass: true },
  { type: 'notice', kind: 'gate', message: 'Typecheck failed on ios/import · 3 errors', gate: { step: 'typecheck', branch: 'ios/import', ok: false, log: "src/import.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/import.ts(40,3): error TS2554: Expected 2 arguments, but got 1.\nsrc/import.ts(58,11): error TS2339: Property 'rows' does not exist on type 'Import'.\n\nFound 3 errors in 1 file.\n", at: Date.now() } },
  { type: 'notice', kind: 'review', message: 'Reviewed by GPT-6.1 Sol: 2 blocking findings, merge held', review: review({ runId: 'r-held', outcome: 'held', branch: 'ios/import', reviewerId: 'ios-notices-reviewer', merged: false, pushed: false, blocking: [finding('src/import.ts', 40, 'parseRow drops the last column when the line ends with a comma', 'A row "a,b," imports as two cells; the third, empty, is lost and every later column shifts left.', 'CONFIRMED'), finding('src/import.ts', 58, 'The import runs on the main thread', 'A 50 MB file freezes the window for the length of the parse.', 'PLAUSIBLE')], minor: [finding('src/import.ts', 3, 'Unused import of path', '')] }) },
  { type: 'notice', kind: 'review', message: 'Merged anyway: 1 blocking finding overridden', review: review({ runId: 'r-over', outcome: 'merged-anyway', branch: 'ios/import-2', blocking: [finding('src/import.ts', 9, 'Dead code after the early return', 'None at runtime; the branch is unreachable.', 'CONFIRMED')] }) },
  { type: 'notice', kind: 'review', message: 'Review by GPT-6.1 Sol timed out after 15 min, merged without it', review: review({ runId: 'r-time', outcome: 'timeout', minutes: 15 }) },
  { type: 'notice', kind: 'account-gone', account: 'work@example.com', message: 'Account work@example.com is gone from this host; routing automatically from here (09:14)' },
  status('idle')
])

export const THREAD_FAILURES = 'ios-failures'
await makeTyped(THREAD_FAILURES, 'chat', 'Every way a turn fails')
const fail = (kind: FailureKind, account: string | null, summary: string, cause: string): AgentEvent => ({ type: 'error', message: summary, failure: { kind, account, summary, cause } })
at(THREAD_FAILURES, [
  { type: 'user-text', text: 'Show me every failure kind.', newPass: true },
  fail('oauth_expired', 'landon@example.com', 'Anthropic session for landon@example.com expired and could not be refreshed', 'The stored sign-in lapsed and its refresh was refused; signing in again mints a new one.'),
  fail('account_unknown', 'work@example.com', 'Account work@example.com is no longer on file', 'The account was removed or cancelled, so there is no sign-in to route this thread under.'),
  fail('token_expired', 'landon@example.com', 'The token for landon@example.com expired on this instance', 'This instance does not own the gateway and never refreshes tokens; the owner renews it on its next use.'),
  fail('rate_limited', 'landon@example.com', 'landon@example.com hit its 5-hour limit', 'The usage window is spent until it resets; another account with room can take the thread.'),
  fail('quota', 'landon@example.com', 'landon@example.com is out of credits', 'The plan has nothing left to spend; top it up or route the thread to another account.'),
  fail('model_unavailable', null, 'gpt-6.1-sol is not available on this host', 'The installed Codex CLI is older than the model needs (0.162.1 or newer), or the provider refused the model.'),
  fail('network', null, 'Could not reach Anthropic', 'The connection dropped or was refused: a network change here, or an outage on their side.'),
  fail('harness_crashed', null, 'The Claude Code process died mid-turn', 'Its stream ended before the turn finished; the conversation can pick up from its last message.'),
  fail('unknown', null, 'The turn failed', 'The harness gave no reason.'),
  { type: 'status', status: 'error' }
])

export const THREAD_PREAMBLE = 'ios-preamble'
await makeTyped(THREAD_PREAMBLE, 'implementation', 'Rename the config keys (with rules)')
const rules = '- Work in your own git worktree: `git worktree add .claude/worktrees/rename-the-config-keys -b rename-the-config-keys master`.\n- Run typecheck and the tests you wrote; land with merge_branch.\n- Never touch /Applications/TempCode.app.'
at(THREAD_PREAMBLE, [
  { type: 'user-text', text: 'Rename every config key from camelCase to kebab-case.', preamble: { text: rules, words: rules.split(/\s+/).filter(Boolean).length }, newPass: true },
  answer('p1', 'Renamed 14 keys; the migration reads both forms for one release.'),
  { type: 'turn-complete' },
  status('idle')
])

export const THREAD_HANDOFF = 'ios-handoff'
await makeTyped(THREAD_HANDOFF, 'planning', 'Plan the passkey rollout')
await makeTyped('ios-handoff-build', 'implementation', 'Plan the passkey rollout')
say('ios-handoff-build', 'Build it from the plan.', 'Started.')
at(THREAD_HANDOFF, [
  { type: 'user-text', text: 'Plan the passkey rollout.', newPass: true },
  answer('h1', 'The plan is written.'),
  { type: 'plan-handoff', sessionId: 'ios-handoff-build', title: 'Plan the passkey rollout', how: 'auto' },
  { type: 'turn-complete' },
  status('idle')
])

// A chat for the streaming proof (POST /stream plays a turn into it): one
// settled turn of about 1,400 words, so `TC_TEST_SEGMENT=chat` opens on prose.
export const THREAD_STREAM = 'ios-streaming'
await makeTyped(THREAD_STREAM, 'chat', 'Streaming on the phone')
const streamParagraph = (n: number): string =>
  Array.from({ length: 6 }, (_, i) => `Sentence ${i + 1} of paragraph ${n} explains how the gateway forwards a request, swaps in the routed account and records the limit headers the answer carries.`).join(' ')
const streamSeedAnswer = [
  'The gateway sits between every harness and the provider. ' + streamParagraph(1),
  streamParagraph(2),
  streamParagraph(3),
  '- the plain-http port carries the thread scope on its path\n- one https port per codex thread keeps the origin\n- every answer feeds the headroom store',
  '```ts\nconst route = await gateway.scopedCodexUrl(threadId)\nconst answer = await forward(route, request)\n```',
  streamParagraph(4),
  streamParagraph(5),
  streamParagraph(6),
  streamParagraph(7),
  streamParagraph(8)
].join('\n\n')
at(THREAD_STREAM, [
  { type: 'user-text', text: 'Explain the gateway.', model: 'claude-sonnet-5-5', reasoning: 'medium', newPass: true },
  ...think('st0', 'The gateway has two listeners and a headroom store; three paragraphs each.'),
  answer('st0a', streamSeedAnswer),
  { type: 'turn-complete', costUsd: 0.12, inputTokens: 4_000, outputTokens: 1_900 },
  status('idle')
])

// Keep board tasks, rounds and sources outside a cold tail for the phone's
// history proof. A single merged block keeps the board itself readable.
for (const id of [THREAD_IMPL, THREAD_RESEARCH]) {
  at(id, [
    ...Array.from({ length: 650 }, (_, i): AgentEvent => ({ type: 'thinking', msgId: 'history-padding', blockIndex: 0, delta: true, text: ` ${i}` })),
    { type: 'thinking', msgId: 'history-padding', blockIndex: 0, delta: false, text: 'Earlier history replayed.' },
    status(id === THREAD_IMPL ? 'waiting' : 'idle')
  ])
}

// ── accounts: two Claude accounts with different headroom (thread 24's chip and menu) ──
const hour = 3_600_000
const seededAccounts: AccountsSnapshot = {
  updatedAt: Date.now(),
  providers: {
    claude: {
      pinned: null,
      owner: null,
      profiles: [
        { name: 'work@example.com', email: 'work@example.com', nickname: 'work', color: '#5b8def', createdAt: Date.now() - 30 * 24 * hour, active: true },
        { name: 'spare@example.com', email: 'spare@example.com', color: '#d97757', createdAt: Date.now() - 10 * 24 * hour, active: false }
      ],
      reports: [
        { profileName: 'work@example.com', windows: [{ label: '5h', usedPercent: 12, resetsAt: Date.now() + 3 * hour, periodMs: 5 * hour }, { label: 'Weekly', usedPercent: 40, resetsAt: Date.now() + 3 * 24 * hour, periodMs: 7 * 24 * hour }] },
        { profileName: 'spare@example.com', windows: [{ label: '5h', usedPercent: 91, resetsAt: Date.now() + 40 * 60_000, periodMs: 5 * hour }, { label: 'Weekly', usedPercent: 55, resetsAt: Date.now() + 2 * 24 * hour, periodMs: 7 * 24 * hour }] }
      ],
      headroom: {
        'work@example.com': { room: 0.8, ratePerMin: 3, seenAt: Date.now() },
        'spare@example.com': { room: 0.1, ratePerMin: 12, resetsAt: Date.now() + 40 * 60_000, seenAt: Date.now() }
      }
    },
    codex: { pinned: null, profiles: [], reports: [], owner: null },
    cursor: { pinned: null, profiles: [], reports: [], owner: null }
  }
}
// The service has no vault here: hold the seeded snapshot in place of its rebuild (the poll would empty it).
const accountsService = server.accounts as unknown as { snap: AccountsSnapshot; built: boolean; rebuild: () => Promise<void>; listeners: Set<(s: AccountsSnapshot) => void> }
accountsService.rebuild = async () => {}
accountsService.snap = seededAccounts
accountsService.built = true
server.registry.setAccount('ios-pinned', 'work@example.com') // a thread on an account
server.registry.setProjectAccounts(project2.id, { claude: 'work@example.com' }) // ios-question reads "From project billing-page"

// Thread 25: the plan flow and project settings. A complete plan with its
// build started, a complete plan waiting for Start, a project with a
// preamble of its own, a workspace default and a review override.
if (!server.registry.get('ios-plan-built')) {
  const writePlan = (meta: { planPath: string | null }, title: string): void => {
    if (!meta.planPath) throw new Error('a planning thread has no plan path')
    mkdirSync(dirname(meta.planPath), { recursive: true })
    writeFileSync(meta.planPath, `# ${title}\n\n## Overview\n\nOne paragraph.\n\n## Tasks\n\n- [ ] First task\n- [ ] Second task\n`)
  }
  // The plan is live while the build is created, so linkPlanHandoff links both ways and lands the handoff row without archiving the plan.
  const built = await makeTyped('ios-plan-built', 'planning', 'Plan: Split the billing export')
  writePlan(built, 'Split the billing export')
  say('ios-plan-built', 'Plan the split of the billing export', 'The plan is written.')
  server.registry.append('ios-plan-built', { type: 'status', status: 'running' })
  await makeTyped('ios-plan-build', 'implementation', 'Split the billing export', { planPath: built.planPath })
  server.registry.append('ios-plan-build', { type: 'user-text', text: 'Implement the plan "Split the billing export".' })
  server.registry.append('ios-plan-built', { type: 'status', status: 'idle' })
  // Its project's plans override turns auto-start off, so completePlan stamps the plan and starts nothing.
  server.registry.setPlanSettings(project2.id, { ...DEFAULT_PLAN_SETTINGS, autoImplement: false })
  const waiting = await makeTyped('ios-plan-waiting', 'planning', 'Plan: Move invoices to the ledger', { projectId: project2.id })
  writePlan(waiting, 'Move invoices to the ledger')
  say('ios-plan-waiting', 'Plan the ledger move', 'The plan is ready.')
  await server.registry.completePlan('ios-plan-waiting')
  server.registry.setProjectPreamble(project2.id, '- Work in `{{worktree}}` on {{host}}.\n- Keep {{project}} green before you merge.', true)
  server.registry.setWorkspacePreamble(workspace.id, '- Commit often, plain prose.', true)
  server.registry.setReviewSettings(project.id, { ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true, provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'medium', maxMinutes: 10 })
}

// ── the 2026-10-21/22 features (scripts/lib/ios-seeds.ts) ───────────────
// The master's batch: the master watching, four children of three types
// (one done, one running behind it, a complete plan whose build is the
// running one, an idle research), the batch row mid-run with a streaming
// shell step, and the queued child above.
export const THREAD_MASTER = 'ios-master'
server.registry.append(THREAD_MASTER, { type: 'status', status: 'watching' })
await make('ios-master-impl-a', { projectId: project.id, threadType: 'implementation', title: 'Rebuild the rollup writer', masterId: THREAD_MASTER, startedBy: THREAD_MASTER })
say('ios-master-impl-a', 'Rebuild the rollup writer.', 'Landed on master.')
server.registry.append('ios-master-impl-a', { type: 'status', status: 'done' })
await make('ios-master-impl-b', { projectId: project.id, threadType: 'implementation', title: 'Backfill the rollups', masterId: THREAD_MASTER, after: 'ios-master-impl-a', startedBy: THREAD_MASTER })
server.registry.append('ios-master-impl-b', { type: 'user-text', text: 'Backfill every rollup since March.', newPass: true })
server.registry.append('ios-master-impl-b', { type: 'status', status: 'running' })
await make('ios-master-plan', { projectId: project.id, threadType: 'planning', title: 'Plan the backfill', masterId: THREAD_MASTER, startedBy: THREAD_MASTER })
say('ios-master-plan', 'Plan the backfill.', 'The plan is complete; the build has started.')
server.store.updateSession('ios-master-plan', { planCompletedAt: Date.now() - 600_000, implementationId: 'ios-master-impl-b' })
await make('ios-master-research', { projectId: project.id, threadType: 'research', agentType: 'explorer', title: 'Which rollups are read?', masterId: THREAD_MASTER, startedBy: THREAD_MASTER })
say('ios-master-research', 'Which rollups does the dashboard read?', 'Seven of the twelve.')
const MASTER_CHILDREN = { landed: ['ios-master-impl-a', 'ios-master-research'], pending: ['ios-master-impl-b', 'ios-master-plan', THREAD_QUEUED] }
server.batches.seedRow(batchRowMidRun(THREAD_MASTER, MASTER_CHILDREN, Date.now()))
// Seeded running rows have no harness: the liveness sweep would flip them to
// `stopped` after 20 s and block the batch. The proofs assume they stay running.
const sweep = server.registry as unknown as { livenessTimer?: ReturnType<typeof setInterval> | null }
if (sweep.livenessTimer) clearInterval(sweep.livenessTimer)
sweep.livenessTimer = null

// The paused master is thread 20's guarded seed (ios-master-paused with ios-batch-a and ios-batch-b).
export const THREAD_MASTER_PAUSED = 'ios-master-paused'

// The project plan is thread 17's seed above (seven milestones, three
// landed, pinned, milestone 3's build linked); this adds the "Plan the next
// milestone" thread, linked to milestone 4.
export const PROJECT_PLAN_PATH = projectPlan.planPath ?? projectPlanPathFor(project.cwd)
await make('ios-project-plan-m4', { projectId: project.id, threadType: 'planning', title: 'M4 · Payments webhook', startedBy: THREAD_PROJECT_PLAN })
say('ios-project-plan-m4', 'Plan milestone 4: the payments webhook.', 'Four tasks.')
server.projectPlans.link('ios-project-plan-m4', { projectId: project.id, milestone: 4 })

// Notes: every section filled, and only two.
export const THREAD_NOTES_FIVE = 'ios-notes-five'
export const THREAD_NOTES_TWO = 'ios-notes-two'
await make(THREAD_NOTES_FIVE, { projectId: project.id, threadType: 'chat', title: 'Thread notes on the phone' })
say(THREAD_NOTES_FIVE, 'Keep notes as you go.', 'Notes kept.')
server.registry.notes.write(THREAD_NOTES_FIVE, notesFive())
await make(THREAD_NOTES_TWO, { projectId: project.id, threadType: 'chat', title: 'A thread that just started' })
say(THREAD_NOTES_TWO, 'Start the notes.', 'Started.')
server.registry.notes.write(THREAD_NOTES_TWO, notesTwo())

// Resources are thread 20's guarded seed (two worktrees through the real
// detection path, a simulator, a row on another host waiting for its link).
export const THREAD_RESOURCES = 'ios-resources'

// A thread on a pinned account, in a project pinned to it.
export const THREAD_PINNED_ACCOUNT = 'ios-pinned-account'
await make(THREAD_PINNED_ACCOUNT, { projectId: project.id, threadType: 'chat', title: 'On the work account' })
say(THREAD_PINNED_ACCOUNT, 'Which account is this?', 'The pinned one.')
server.registry.setAccount(THREAD_PINNED_ACCOUNT, 'work@example.com')
server.store.setProjectAccounts(project.id, { claude: 'work@example.com' })

// A note for notes.search ("fixtureNeedle"), beside the file of the same word on both hosts.
export const SEARCH_NOTE = 'ios-search-note'
server.notes.upsert({ id: SEARCH_NOTE, title: 'Cutover checklist', body: 'Before the cutover: run the proofs, then grep for fixtureNeedle on both hosts.' })

// Accounts are thread 24's seed above (two Claude accounts with different headroom, held in place of the poll).

// ── the key, and a pairing link for the simulator rehearsal ─────────────
const created = await server.remoteAuth.createKey({ name: 'ios-test', audience: 'client', caps: [], createdBy: 'local' })
const pairing = server.remoteAuth.createPairing({ name: 'ios-sim', audience: 'client', caps: [], createdBy: 'local' })
// A second key and pairing that may act: the action tests and the proof's
// steering shots use these; the read-only ones show the disabled states.
const operate = await server.remoteAuth.createKey({ name: 'ios-test-operate', audience: 'client', caps: ['operate', 'approve'], createdBy: 'local' })
const operatePairing = server.remoteAuth.createPairing({ name: 'ios-sim-operate', audience: 'client', caps: ['operate', 'approve'], createdBy: 'local' })
// A key that operates but never approves: the forbidden path of the approval card.
const operateOnly = await server.remoteAuth.createKey({ name: 'ios-test-operate-only', audience: 'client', caps: ['operate'], createdBy: 'local' })
// An admin key and pairing: the host detail's deploy row, log sheet and sync lines (iOS thread 21).
const admin = await server.remoteAuth.createKey({ name: 'ios-test-admin', audience: 'client', caps: ['operate', 'approve', 'admin'], createdBy: 'local' })
const adminPairing = server.remoteAuth.createPairing({ name: 'ios-sim-admin', audience: 'client', caps: ['operate', 'approve', 'admin'], createdBy: 'local' })

// ── the Mac bridge's calls for the host detail (iOS thread 21) ──────────
// Two of the saved host's calls past the prompt, as a Mac lists them in
// `macBridge.activity`: one running, one held on the load guard with its
// standing. Seeded rows only (TEMP_CODE_E2E_SEED); Stop on them does nothing.
const seededCall = (over: Partial<MacBridgeRequest> & Pick<MacBridgeRequest, 'id' | 'status' | 'command' | 'createdAt'>): MacBridgeRequest => ({
  environmentId: SEED_BOX_ID,
  hostName: 'box',
  sessionId: THREAD_IMPL,
  threadTitle: 'Composer, working strip, approval actions',
  kind: 'run',
  method: 'mac.run',
  cwd: '/Users/landon/IdeaProjects/temp-code',
  expiresAt: Number.MAX_SAFE_INTEGER,
  ...over
})
export const MAC_CALL_RUNNING = 'mb_seed_running'
export const MAC_CALL_HELD = 'mb_seed_held'
server.macBridge.seed([
  seededCall({ id: MAC_CALL_RUNNING, status: 'running', command: 'bun run ios:test:client', createdAt: Date.now() - 95_000 }),
  seededCall({
    id: MAC_CALL_HELD,
    status: 'held',
    command: 'xcodebuild test -scheme TempCode',
    createdAt: Date.now() - 20_000,
    sessionId: THREAD_PLAN,
    threadTitle: 'Planning thread: the plan document',
    held: { reason: 'load', position: 3, load: 12.3, limit: 8, cores: 4, maxRunning: 4, running: 4 }
  })
])

// ── the relay seed: four fake hosts, one per state ──────────────────────
const relayId = (word: string): string => `env_relay${word}`.padEnd(26, '0')
const relayRow = { platform: 'darwin', link: 'up' as const, since: Date.now(), screen: 'unlocked' as const, power: 'awake' as const, lastSeenAt: Date.now(), build: null }
const relaySeed = [
  { environmentId: relayId('Available'), name: 'Studio Mac', state: 'available', row: relayRow },
  { environmentId: relayId('Locked'), name: 'Studio Mac (locked)', state: 'locked', row: { ...relayRow, screen: 'locked' as const } },
  { environmentId: relayId('Asleep'), name: 'Studio Mac (asleep)', state: 'asleep', row: { ...relayRow, power: 'asleep' as const } },
  { environmentId: relayId('Unreachable'), name: 'Studio Mac (unreachable)', state: 'unreachable', row: { ...relayRow, link: 'down' as const, since: Date.now() - 5 * 60_000 } }
]
const relayHosts = startLoopbackHosts({
  carrierId: server.environmentId,
  carrierName: 'iOS test server',
  relay: server.relay,
  attach: (socket, principal) => server.attach(socket as never, principal),
  facade: () => ({ registry: server.registry, origin: null }),
  hosts: relaySeed
})

// ── the auth clock, shiftable for ticket expiry ─────────────────────────
let clockOffsetMs = 0
;(server.remoteAuth as unknown as { now: () => number }).now = () => Date.now() + clockOffsetMs

// ── actions: recorded, and acted out without a harness ──────────────────
// The seeded threads have no harness behind them, so the registry's action
// methods are stood in for: each one is recorded for the tests and the proof
// to read back (GET /actions), and plays out the rows a real run would push
// (the user turn and a running status, the resolved card, the stopped line).
// A simulated turn runs until /stop or POST /finish ends it. Creates,
// renames, archives and pins are the real thing, recorded on the way.
type Recorded = { kind: string; sessionId: string; at: number } & Record<string, unknown>
const actions: Recorded[] = []
const record = (kind: string, sessionId: string, extra: Record<string, unknown> = {}): void => {
  actions.push({ kind, sessionId, at: Date.now(), ...extra })
}
type Registry = typeof server.registry
const registry = server.registry
const stub = <K extends keyof Registry>(key: K, fn: Registry[K]): void => {
  ;(registry as unknown as Record<K, Registry[K]>)[key] = fn
}
const realCreate = registry.create.bind(registry)
const realRename = registry.rename.bind(registry)
const realSetArchived = registry.setArchived.bind(registry)
const realSetPinned = registry.setPinned.bind(registry)
stub('send', async (sessionId, text, opts) => {
  record('send', sessionId, { text, newPass: opts?.newPass ?? null, provider: opts?.provider ?? null, model: opts?.model ?? null, reasoning: opts?.reasoning ?? null })
  registry.append(sessionId, { type: 'user-text', text, model: opts?.model, reasoning: opts?.reasoning, newPass: opts?.newPass })
  registry.append(sessionId, { type: 'status', status: 'running' })
})
stub('stopRun', async (sessionId) => {
  record('stop', sessionId)
  registry.append(sessionId, { type: 'error', message: 'Stopped', stopped: true })
  registry.append(sessionId, { type: 'status', status: 'idle' })
})
stub('approve', async (sessionId, requestId, allow) => {
  record('approve', sessionId, { requestId, allow })
  registry.append(sessionId, { type: 'approval-resolved', requestId, allow })
  registry.append(sessionId, { type: 'status', status: 'running' })
})
stub('answer', async (sessionId, requestId, answers) => {
  record('answer', sessionId, { requestId, answers })
  registry.append(sessionId, { type: 'question-resolved', requestId, answers })
  registry.append(sessionId, { type: 'status', status: 'running' })
})
stub('pauseRun', async (sessionId) => {
  record('pause', sessionId)
  registry.append(sessionId, { type: 'status', status: 'paused' })
})
stub('resumePausedRun', async (sessionId) => {
  record('resume', sessionId)
  registry.append(sessionId, { type: 'status', status: 'running' })
})
// The seeds have no harness, so the liveness sweep would mark every running one stopped after 20 s.
stub('sweepLiveness', () => [])
stub('resumeStopped', async (sessionId) => {
  // The harness is gone: a fresh one on the same transcript, running.
  record('resume', sessionId, { stopped: true })
  registry.append(sessionId, { type: 'status', status: 'running' })
  return true
})
stub('startQueued', async (sessionId) => {
  // Start now: the queued thread's held first message goes, the user row stays, the turn runs.
  record('start', sessionId)
  registry.append(sessionId, { type: 'status', status: 'running' })
  return true
})
stub('create', async (raw) => {
  const meta = await realCreate(raw)
  record('create', meta.id, {
    threadType: raw.threadType ?? null,
    agentType: raw.agentType ?? null,
    provider: raw.provider ?? null,
    model: raw.model ?? null,
    reasoning: raw.reasoning ?? null,
    projectId: raw.projectId ?? null,
    workspaceId: raw.workspaceId ?? null,
    cwd: raw.cwd ?? null,
    planPath: raw.planPath ?? null,
    goal: raw.goal ?? null,
    title: raw.title ?? null,
    permission: raw.permission ?? null
  })
  return meta
})
stub('rename', async (sessionId, title) => {
  record('rename', sessionId, { title })
  await realRename(sessionId, title)
})
stub('setArchived', async (sessionId, archived) => {
  record('archive', sessionId, { archived })
  await realSetArchived(sessionId, archived)
})
stub('setPinned', (sessionId, pinned) => {
  record('pin', sessionId, { pinned })
  realSetPinned(sessionId, pinned)
})
// The master board's actions (iOS 16/27): the pin, and Stop on the seeded smoke step (which then reads failed).
const realSetMaster = registry.setMaster.bind(registry)
stub('setMaster', (sessionId, master) => {
  record('setMaster', sessionId, { master })
  realSetMaster(sessionId, master)
})
const realStopStep = server.batches.stopStep.bind(server.batches)
server.batches.stopStep = async (masterId, stepId) => {
  record('stopStep', masterId, { stepId })
  if (masterId !== THREAD_MASTER) return realStopStep(masterId, stepId)
  const row = batchRowMidRun(masterId, MASTER_CHILDREN, Date.now())
  const step = row.steps.find((s) => s.id === stepId)
  if (!step || step.status !== 'running') return { stopped: false }
  step.status = 'failed'
  step.detail = 'stopped after 12s'
  step.endedAt = Date.now()
  step.log = [...step.log, '✗ stopped']
  server.batches.seedRow(row)
  return { stopped: true }
}

// ── a GitHub inbox for the simulator proof ──────────────────────────────
// Two repositories' worth of pull requests and issues in every state the
// row can show, stored the way a refresh stores them (`github.inbox` reads
// SQLite only). The detail screen shells out to `gh`; TEMP_CODE_GH_BIN points
// it at a script here that answers the four calls the detail makes from
// fixtures, so the proof can screenshot a loaded pull request without a
// token. The live tests never touch any of this.
const inboxNow = Date.now()
const agoIso = (minutes: number): string => new Date(inboxNow - minutes * 60_000).toISOString()
const person = (login: string, id: number): { login: string; avatarUrl: string } => ({ login, avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4` })
const inboxItem = (
  over: Partial<GithubInboxItem> & Pick<GithubInboxItem, 'kind' | 'repo' | 'number' | 'title' | 'updatedAt'>
): GithubInboxItem => ({
  url: `https://github.com/${over.repo}/${over.kind === 'pr' ? 'pull' : 'issues'}/${over.number}`,
  state: 'open',
  draft: false,
  author: person('landon', 1),
  assignees: [],
  labels: [],
  reviewDecision: '',
  headRefName: '',
  baseRefName: '',
  checks: null,
  reviewRequested: [],
  ...over
})
export const INBOX_PR = 412
server.store.putGithubInboxRepo({
  repo: 'landon/temp-code',
  fetchedAt: inboxNow,
  error: null,
  items: [
    inboxItem({ kind: 'pr', repo: 'landon/temp-code', number: INBOX_PR, title: 'Inbox rows read like Mail: avatars, unread weight, state as color', updatedAt: agoIso(4), author: person('mira-ok', 583231), reviewDecision: 'REVIEW_REQUIRED', headRefName: 'ios/inbox', baseRefName: 'master', checks: 'SUCCESS', reviewRequested: ['landon'], labels: [{ name: 'ios', color: '1d76db' }] }),
    inboxItem({ kind: 'pr', repo: 'landon/temp-code', number: 409, title: 'Gateway: refuse WebSocket upgrades on the per-thread https port', updatedAt: agoIso(38), author: person('tobias-r', 9919), reviewDecision: 'CHANGES_REQUESTED', headRefName: 'gateway-ws', baseRefName: 'master', checks: 'SUCCESS' }),
    inboxItem({ kind: 'pr', repo: 'landon/temp-code', number: 405, title: 'Static tokens renew through the stored claude.ai session', updatedAt: agoIso(60 * 3), author: person('landon', 1), reviewDecision: 'APPROVED', headRefName: 'static-renew', baseRefName: 'master', checks: 'SUCCESS' }),
    inboxItem({ kind: 'pr', repo: 'landon/temp-code', number: 401, title: 'Box: restic snapshots the database with VACUUM INTO', updatedAt: agoIso(60 * 7), author: person('mira-ok', 583231), headRefName: 'box-backup', baseRefName: 'master', checks: 'FAILURE' }),
    inboxItem({ kind: 'pr', repo: 'landon/temp-code', number: 398, title: 'Draft: move the fold cache into the session store', updatedAt: agoIso(60 * 26), draft: true, author: person('anika', 7712), headRefName: 'fold-cache', baseRefName: 'master', checks: 'PENDING' }),
    inboxItem({ kind: 'issue', repo: 'landon/temp-code', number: 396, title: 'Search results lose their quoted row after a reconnect', updatedAt: agoIso(60 * 30), author: person('tobias-r', 9919), labels: [{ name: 'bug', color: 'd73a4a' }] }),
    inboxItem({ kind: 'pr', repo: 'landon/temp-code', number: 390, title: 'Thread header keeps its host after a relaunch', updatedAt: agoIso(60 * 52), state: 'merged', author: person('landon', 1), headRefName: 'host-chip', baseRefName: 'master', checks: 'SUCCESS' })
  ]
})
server.store.putGithubInboxRepo({
  repo: 'landon/cosmic-web',
  fetchedAt: inboxNow,
  error: null,
  items: [
    inboxItem({ kind: 'issue', repo: 'landon/cosmic-web', number: 88, title: 'Billing page: the invoice table overflows on a phone', updatedAt: agoIso(60 * 9), author: person('anika', 7712), labels: [{ name: 'design', color: 'c5def5' }] }),
    inboxItem({ kind: 'pr', repo: 'landon/cosmic-web', number: 86, title: 'Stats: ClickHouse rollups for the raid timeline', updatedAt: agoIso(60 * 24 * 3), state: 'closed', author: person('tobias-r', 9919), headRefName: 'stats-rollups', baseRefName: 'main', checks: 'SUCCESS' })
  ]
})
server.store.setSetting('github.inbox.viewer', 'landon')
server.store.setSetting('github.inbox.fetchedAt', String(inboxNow))

const ghDir = join(root, 'gh-fixtures')
mkdirSync(ghDir, { recursive: true })
const ghFixture = (name: string, value: unknown): void => writeFileSync(join(ghDir, name), typeof value === 'string' ? value : JSON.stringify(value))
ghFixture('pr-details.json', {
  body: [
    'The inbox tab reads like Mail now: an avatar with a hairline outline, the title carries the weight while a row is unread, the repository and number sit dim under it, and the state is a word in the one color that means it.',
    '',
    '## What changed',
    '',
    '- `InboxView.swift`: the row, the seen store, swipe actions, pull to refresh',
    '- `InboxItemView.swift`: the header, the conversation, the diff by file and hunk',
    '',
    'Closes #396.'
  ].join('\n'),
  author: { login: 'mira-ok' },
  baseRefName: 'master',
  headRefName: 'ios/inbox',
  reviewDecision: 'REVIEW_REQUIRED'
})
ghFixture('issue-details.json', { body: 'After the socket drops and comes back, every search hit shows its thread title but the quoted row is gone until the search runs again.\n\nSteps: search, toggle airplane mode, toggle it back.', author: { login: 'tobias-r' } })
ghFixture('pr-diff-meta.json', {
  additions: 31,
  deletions: 9,
  files: [
    { path: 'ios/TempCode/Sources/Shell/InboxView.swift', additions: 24, deletions: 6 },
    { path: 'ios/TempCode/Sources/Shell/InboxItemView.swift', additions: 7, deletions: 3 }
  ]
})
ghFixture(
  'pr-diff.patch',
  [
    'diff --git a/ios/TempCode/Sources/Shell/InboxView.swift b/ios/TempCode/Sources/Shell/InboxView.swift',
    'index 3f1c2aa..b8e0d41 100644',
    '--- a/ios/TempCode/Sources/Shell/InboxView.swift',
    '+++ b/ios/TempCode/Sources/Shell/InboxView.swift',
    '@@ -118,12 +118,30 @@ struct InboxRow: View {',
    '     let entry: InboxEntry',
    '     let showHost: Bool',
    '+    let unread: Bool',
    ' ',
    '     var body: some View {',
    '         let item = entry.item',
    '-        VStack(alignment: .leading, spacing: 3) {',
    '-            HStack(spacing: 6) {',
    '-                Image(systemName: item.kind.rawValue == "pr" ? "arrow.triangle.pull" : "circle.circle")',
    '-                    .font(.caption2)',
    '-                    .foregroundStyle(.tertiary)',
    '+        HStack(alignment: .top, spacing: 12) {',
    '+            Avatar(url: item.author?.avatarUrl, name: item.author?.login ?? "", size: 36)',
    '+            VStack(alignment: .leading, spacing: 2) {',
    '+                HStack(alignment: .firstTextBaseline, spacing: 8) {',
    '+                    Text(item.title)',
    '+                        .font(.subheadline.weight(unread ? .semibold : .regular))',
    '+                        .lineLimit(2)',
    '+                    Spacer(minLength: 0)',
    '+                    Text(TimeFormat.ago(entry.updatedMs))',
    '+                        .font(.caption)',
    '+                        .monospacedDigit()',
    '+                        .foregroundStyle(.tertiary)',
    '+                }',
    '+                InboxRowMeta(entry: entry, showHost: showHost)',
    '             }',
    '         }',
    '-        .padding(.vertical, 8)',
    '+        .padding(.vertical, 10)',
    '         .accessibilityElement(children: .combine)',
    '     }',
    ' }',
    'diff --git a/ios/TempCode/Sources/Shell/InboxItemView.swift b/ios/TempCode/Sources/Shell/InboxItemView.swift',
    'index 91ab2e0..7c4d0f3 100644',
    '--- a/ios/TempCode/Sources/Shell/InboxItemView.swift',
    '+++ b/ios/TempCode/Sources/Shell/InboxItemView.swift',
    '@@ -70,9 +70,13 @@ struct InboxItemView: View {',
    '                 if let diff {',
    '-                    ScrollView(.horizontal) {',
    '-                        Text(diff.patch)',
    '-                            .font(.caption.monospaced())',
    '+                    ForEach(PatchFile.parse(diff), id: \\.path) { file in',
    '+                        DiffFileView(file: file)',
    '                     }',
    '+                    if diff.truncated {',
    '+                        Text("The patch is too large to show; the files are listed without it.")',
    '+                            .font(.footnote)',
    '+                            .foregroundStyle(.tertiary)',
    '+                    }',
    '                 }',
    ''
  ].join('\n')
)
const ghNode = (id: string, login: string, body: string, minutesAgo: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, author: { login }, body, createdAt: agoIso(minutesAgo), url: `https://github.com/landon/temp-code/pull/${INBOX_PR}#issuecomment-${id}`, ...extra })
ghFixture('pr-thread.json', {
  data: {
    repository: {
      pullRequest: {
        reviewDecision: 'REVIEW_REQUIRED',
        baseRefName: 'master',
        headRefName: 'ios/inbox',
        comments: { totalCount: 2, nodes: [
          ghNode('c1', 'landon', 'Looks right on the 15 Pro. Does the outline hold up on a white avatar in light mode?', 52, { isMinimized: false }),
          ghNode('c2', 'mira-ok', 'Yes: black at 10 % over white reads as a hairline, and the dark mode one is white at 10 %. Screenshots in the description.', 31, { isMinimized: false })
        ] },
        reviews: { totalCount: 1, nodes: [
          { id: 'r1', author: { login: 'tobias-r' }, body: 'One question on the seen store, otherwise good.', state: 'COMMENTED', submittedAt: agoIso(20), url: `https://github.com/landon/temp-code/pull/${INBOX_PR}#pullrequestreview-r1` }
        ] },
        reviewThreads: { totalCount: 1, nodes: [
          { id: 't1', isResolved: false, path: 'ios/TempCode/Sources/Shell/InboxView.swift', comments: { totalCount: 2, nodes: [
            { id: 'rc1', author: { login: 'tobias-r' }, body: 'Should the first snapshot seed everything as seen, as the desktop does?', createdAt: agoIso(20), url: '', path: 'ios/TempCode/Sources/Shell/InboxView.swift', line: 126, originalLine: 126 },
            { id: 'rc2', author: { login: 'mira-ok' }, body: 'Everything older than a day. The last day stays unread so the first open shows what is new.', createdAt: agoIso(6), url: '', path: 'ios/TempCode/Sources/Shell/InboxView.swift', line: 126, originalLine: 126 }
          ] } }
        ] }
      }
    }
  }
})
ghFixture('issue-thread.json', {
  data: { repository: { issue: { comments: { totalCount: 1, nodes: [
    { id: 'i1', author: { login: 'landon' }, body: 'Reproduced. The resume path replays the hits without their `row` field.', createdAt: agoIso(60 * 28), url: 'https://github.com/landon/temp-code/issues/396#issuecomment-i1', isMinimized: false }
  ] } } } }
})
const ghScript = join(ghDir, 'gh')
writeFileSync(
  ghScript,
  [
    '#!/bin/sh',
    `dir='${ghDir}'`,
    'case "$1 $2" in',
    '  "repo view") echo \'{"nameWithOwner":"landon/temp-code"}\' ;;',
    '  "pr diff") cat "$dir/pr-diff.patch" ;;',
    '  "pr view") case "$*" in *files*) cat "$dir/pr-diff-meta.json" ;; *) cat "$dir/pr-details.json" ;; esac ;;',
    '  "issue view") cat "$dir/issue-details.json" ;;',
    '  "api graphql") case "$*" in *pullRequest*) cat "$dir/pr-thread.json" ;; *) cat "$dir/issue-thread.json" ;; esac ;;',
    '  *) echo "fixture gh: unknown call $*" >&2; exit 1 ;;',
    'esac',
    ''
  ].join('\n'),
  { mode: 0o755 }
)
process.env.TEMP_CODE_GH_BIN = ghScript

// ── a bursty streaming turn (POST /stream) ──────────────────────────────
// Plays a scripted turn on timers: 1.5 s of thinking deltas, then an answer
// at `cps` chars/s as a bursty stream (a delta every 7 ms of 1–5 chars, a
// 250 ms stall every 2 s, one 400 ms stall at 6 s: the shape of the desktop
// smoothText tests), a partial Edit call from 4 s whose new_string grows 12
// lines every 100 ms to 420 lines (the first three partials carry a
// truncated file_path, so the chip's target types in), a live edit for the
// same file every 100 ms (the coalescer's previews lane), then the final
// call and result, the whole answer, turn-complete and idle. The same LCG
// as smoothText.test.ts, seeded, so a run repeats.
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))
let streamRun: { sessionId: string; stopped: boolean } | null = null
const streamAnswer = (length: number): string => {
  const parts = [
    'The gateway forwards every request a harness makes and swaps in the account the thread is routed to. ' + streamParagraph(1),
    '- the plain-http port carries the thread scope\n- one https port per codex thread\n- every answer feeds the headroom store',
    '```ts\nconst url = await gateway.scopedCodexUrl(threadId)\n```',
    streamParagraph(2),
    streamParagraph(3)
  ]
  let text = ''
  for (let i = 0; text.length < length; i++) text += (i === 0 ? '' : '\n\n') + parts[i % parts.length]
  return text.slice(0, length)
}
async function playStream(sessionId: string, cps: number, seconds: number, seed: number): Promise<void> {
  const run = { sessionId, stopped: false }
  streamRun = run
  const live = (): boolean => !run.stopped
  let s = seed >>> 0
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const cwd = repo
  const path = 'src/gateway/route.ts'
  const answer = streamAnswer(Math.round(cps * seconds))
  try {
    registry.append(sessionId, { type: 'user-text', text: 'Explain the gateway in detail' })
    registry.append(sessionId, { type: 'status', status: 'running' })
    // 1. thinking for 1.5 s
    const thought = 'Two listeners, one headroom store, and the warm harness in front: describe each, then the routing.'
    for (let i = 0; i < 10 && live(); i++) {
      registry.append(sessionId, { type: 'thinking', text: thought.slice(Math.floor((i * thought.length) / 10), Math.floor(((i + 1) * thought.length) / 10)), delta: true, msgId: 'st-think', blockIndex: 0 })
      await sleep(150)
    }
    if (!live()) return
    registry.append(sessionId, { type: 'thinking', text: thought, delta: false, msgId: 'st-think', blockIndex: 0 })
    const started = Date.now()
    // 2. the answer, bursty
    const answerLoop = async (): Promise<void> => {
      let at = 0
      let owed = 0
      let nextStall = 2_000
      let longStalled = false
      while (at < answer.length && live()) {
        const elapsed = Date.now() - started
        if (!longStalled && elapsed >= 6_000) {
          longStalled = true
          await sleep(400)
        } else if (elapsed >= nextStall) {
          nextStall += 2_000
          await sleep(250)
        }
        owed += (cps * 7) / 1000
        const chars = Math.min(5, Math.max(1, Math.round(owed * (0.5 + rand()))))
        owed -= chars
        registry.append(sessionId, { type: 'assistant-text', text: answer.slice(at, at + chars), delta: true, msgId: 'st-answer', blockIndex: 0 })
        at += chars
        await sleep(7)
      }
    }
    // 3 + 4. the growing edit and its live diff, from 4 s
    const editLoop = async (): Promise<void> => {
      await sleep(Math.max(0, 4_000 - (Date.now() - started)))
      const oldString = 'export const route = (req: Request) => forward(req)'
      const lines: string[] = []
      let diff = ''
      for (let push = 0; push < 35 && live(); push++) {
        for (let i = 0; i < 12; i++) lines.push(`  const step${lines.length + 1} = await forward(req, { hop: ${lines.length + 1} })`)
        diff = `@@ -1,1 +1,${lines.length + 1} @@\n-${oldString}\n+export const route = async (req: Request) => {\n${lines.map((l) => '+' + l).join('\n')}\n`
        const filePath = push === 0 ? 'src/ga' : push === 1 ? 'src/gateway/ro' : path
        registry.append(sessionId, { type: 'tool-call', callId: 'st-edit', name: 'Edit', input: { file_path: filePath, old_string: oldString, new_string: `export const route = async (req: Request) => {\n${lines.join('\n')}` }, partial: true })
        emitLiveEdit({ push: 'live-edit', cwd, sessionIds: [sessionId], edit: { path, kind: 'changed', adds: lines.length, dels: 3, diff, settled: push === 34 || undefined, ts: Date.now() } })
        await sleep(100)
      }
      if (!live()) return
      const previewLines = [{ kind: 'del' as const, number: 1, text: oldString }, { kind: 'add' as const, number: 1, text: 'export const route = async (req: Request) => {' }, ...lines.map((text, i) => ({ kind: 'add' as const, number: i + 2, text }))]
      registry.append(sessionId, { type: 'tool-call', callId: 'st-edit', name: 'Edit', input: { file_path: path, old_string: oldString, new_string: `export const route = async (req: Request) => {\n${lines.join('\n')}` }, preview: { kind: 'write', path, fileName: 'route.ts', additions: 420, deletions: 3, lines: previewLines } })
      registry.append(sessionId, { type: 'tool-result', callId: 'st-edit', output: `The file ${path} has been updated.`, isError: false })
    }
    await Promise.all([answerLoop(), editLoop()])
    if (!live()) return
    // 5. the final row, turn-complete, idle
    registry.append(sessionId, { type: 'assistant-text', text: answer, delta: false, msgId: 'st-answer', blockIndex: 0 })
    registry.append(sessionId, { type: 'turn-complete', costUsd: 0.2, inputTokens: 6_000, outputTokens: 1_200 })
    registry.append(sessionId, { type: 'status', status: 'idle' })
  } finally {
    if (streamRun === run) streamRun = null
  }
}

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
const batchLogLines: string[] = []
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
    if (url.pathname === '/actions') return answer(200, { actions })
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
      case '/ask': {
        // A fresh card to decide: an approval or a question on a thread, which then waits.
        const sessionId = String(body.sessionId ?? THREAD_A)
        appended++
        const requestId = `ask-${appended}`
        if (body.kind === 'question') {
          registry.append(sessionId, { type: 'question-request', requestId, questions: [{ question: String(body.question ?? 'Which way?'), header: 'Choice', allowFreeform: true, options: [{ label: 'This way', description: 'The short road' }, { label: 'That way', description: 'The scenic one' }] }] })
          registry.append(sessionId, { type: 'status', status: 'waiting', detail: 'awaiting an answer' })
        } else {
          registry.append(sessionId, { type: 'approval-request', requestId, toolName: 'Bash', input: { command: String(body.command ?? 'rm -rf node_modules') }, title: String(body.title ?? 'remove node_modules'), callId: requestId })
          registry.append(sessionId, { type: 'status', status: 'waiting', detail: 'awaiting approval' })
        }
        return answer(200, { requestId })
      }
      case '/actions/clear':
        actions.length = 0
        return answer(200, { ok: true })
      case '/finish': {
        // Ends a simulated turn the way a real one ends: the reply, turn-complete, idle.
        const sessionId = String(body.sessionId ?? THREAD_A)
        if (streamRun?.sessionId === sessionId) streamRun.stopped = true
        appended++
        registry.append(sessionId, { type: 'assistant-text', text: String(body.text ?? 'Done.'), delta: false, msgId: `f${appended}`, blockIndex: 0 })
        registry.append(sessionId, { type: 'turn-complete' })
        registry.append(sessionId, { type: 'status', status: 'idle' })
        return answer(200, { finished: sessionId })
      }
      case '/accounts/headroom': {
        // A usage change on one account: the 5h window moves and the accounts push goes out.
        const name = String(body.name ?? 'work@example.com')
        const report = seededAccounts.providers.claude.reports.find((r) => r.profileName === name)
        const window = report?.windows.find((w) => w.label === '5h')
        if (!window) return answer(404, { error: `no 5h window for ${name}` })
        window.usedPercent = Number(body.usedPercent ?? window.usedPercent)
        seededAccounts.updatedAt = Date.now()
        for (const l of accountsService.listeners) l(seededAccounts)
        return answer(200, { name, usedPercent: window.usedPercent })
      }
      case '/push': {
        // Any push to every remote socket: for a push with no machinery behind it here.
        const frame = JSON.stringify(body.frame ?? {})
        let count = 0
        for (const set of server.remote?.sockets.values() ?? []) for (const ws of set) {
          ws.send(frame)
          count++
        }
        return answer(200, { sent: count })
      }
      case '/batch-log': {
        const masterId = String(body.masterId ?? THREAD_MASTER)
        const lines = Array.isArray(body.lines) ? body.lines.map(String) : [String(body.lines ?? 'smoke: still checking')]
        const row = batchRowMidRun(masterId, MASTER_CHILDREN, Date.now())
        batchLogLines.push(...lines)
        server.batches.seedRow(withShellLog(row, batchLogLines))
        return answer(200, { lines: batchLogLines.length })
      }
      case '/notes': {
        const doc = server.registry.notes.write(String(body.sessionId ?? THREAD_NOTES_FIVE), String(body.text ?? ''))
        return answer(200, { updatedAt: doc.updatedAt })
      }
      case '/resources/remove': {
        const results = await server.resources.remove(String(body.sessionId ?? THREAD_RESOURCES))
        return answer(200, { results })
      }
      case '/presence': {
        const patch: { screen?: 'locked' | 'unlocked'; power?: 'asleep' | 'awake' } = {}
        if (body.screen === 'locked' || body.screen === 'unlocked') patch.screen = body.screen
        if (body.power === 'asleep' || body.power === 'awake') patch.power = body.power
        const row = relayHosts.setPresence(String(body.environmentId ?? ''), patch)
        return row ? answer(200, row) : answer(404, { error: 'no such relayed host' })
      }
      case '/clock':
        clockOffsetMs = Number(body.offsetMs ?? 0)
        return answer(200, { clockOffsetMs })
      case '/revoke':
        return answer(200, { ok: server.remoteAuth.revokeKey(String(body.keyId ?? '')) })
      case '/stream': {
        // A bursty streaming turn into a thread; one at a time.
        if (streamRun) return answer(409, { error: `a stream is running on ${streamRun.sessionId}` })
        const sessionId = String(body.sessionId ?? THREAD_STREAM)
        void playStream(sessionId, Number(body.cps ?? 300), Number(body.seconds ?? 12), Number(body.seed ?? 1)).catch((err) => console.error('[stream]', err))
        return answer(200, { started: sessionId })
      }
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
  relayHosts.close()
  control.close()
  secondProcess.kill('SIGTERM')
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

// Thread notes (iOS 18): every section filled on the implementation thread; Goal and State alone on the waiting chat, so Home's needs-you row shows its State line.
server.registry.notes.write(
  THREAD_IMPL,
  [
    '## Goal', '', 'Dark mode on the settings screen, behind one toggle.', '',
    '## Decisions', '', '- One `theme(mode)` function, no second palette file.', '- The toggle lives under Appearance.', '',
    '## State', '', '- Done: `Theme.ts`, the toggle, four tests.', '- In flight: nothing.', '',
    '## Pointers', '', '- src/settings/Theme.ts', '- `bun test src/settings`', '',
    '## Open questions', '', '- Should the system setting win over the toggle?', ''
  ].join('\n'),
  Date.now(),
  'tool'
)
server.registry.notes.write('ios-waiting', '## Goal\n\nRun the suite and fix what fails.\n\n## State\n\n- Blocked: `bun test` needs your approval\n', Date.now(), 'tool')

// The one line the runner reads. The key appears here and nowhere else.
process.stdout.write(
  JSON.stringify({
    ready: true,
    baseUrl: `http://127.0.0.1:${server.remote.port}`,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    environmentId: server.environmentId,
    keyId: created.key.id,
    key: created.token,
    operateKeyId: operate.key.id,
    operateKey: operate.token,
    operateOnlyKeyId: operateOnly.key.id,
    operateOnlyKey: operateOnly.token,
    adminKeyId: admin.key.id,
    adminKey: admin.token,
    adminPairing: `http://127.0.0.1:${server.remote.port}/pair#${adminPairing.code}`,
    seedBoxId: SEED_BOX_ID,
    deployLogLines: DEPLOY_LOG_LINES,
    pairingLinkOperate: `http://127.0.0.1:${server.remote.port}/pair#${operatePairing.code}`,
    planPath: plan.planPath ?? null,
    pairingLink: `http://127.0.0.1:${server.remote.port}/pair#${pairing.code}`,
    threadA: THREAD_A,
    threadB: THREAD_B,
    threadCrossHost: THREAD_CROSS_HOST,
    second,
    localPort: server.port,
    shot,
    threads: {
      implementation: THREAD_IMPL,
      planning: THREAD_PLAN,
      orchestration: THREAD_ORCH,
      research: THREAD_RESEARCH,
      chat: THREAD_CHAT,
      long: THREAD_LONG,
      held: THREAD_HELD,
      queued: THREAD_QUEUED,
      stopped: 'ios-stopped',
      notices: THREAD_NOTICES,
      failures: THREAD_FAILURES,
      preamble: THREAD_PREAMBLE,
      handoff: THREAD_HANDOFF,
      streaming: THREAD_STREAM,
      master: THREAD_MASTER,
      pausedMaster: THREAD_MASTER_PAUSED,
      projectPlan: THREAD_PROJECT_PLAN,
      m3Build: THREAD_M3_BUILD,
      notesFive: THREAD_NOTES_FIVE,
      notesTwo: THREAD_NOTES_TWO,
      resources: THREAD_RESOURCES,
      pinned: THREAD_PINNED_ACCOUNT,
      crossHost: THREAD_CROSS_HOST,
      media: THREAD_CHAT,
      searchNotes: SEARCH_NOTE
    },
    masterId: THREAD_MASTER,
    projectPlanPath: PROJECT_PLAN_PATH,
    mediaUrl: mediaUrl(shot, { kind: 'image', mime: 'image/png' }, Date.now()),
    projectId: project.id,
    workspaceId: workspace.id,
    relayHosts: relaySeed.map(({ environmentId, name, state }) => ({ environmentId, name, state }))
  }) + '\n'
)
