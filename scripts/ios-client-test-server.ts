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
 *   POST /finish { sessionId, text? }  → ends a simulated turn: the reply, turn-complete, idle
 *   POST /ask { sessionId, kind: 'approval' | 'question' }  → a fresh card on a thread, which waits
 *   POST /quit                  → closes everything
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { configure } from 'aliax-core'
import { startServer } from '../src/main/server/index'
import { serveMedia } from '../src/main/server/media'
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
// The `/asset/file/*` mirror the phone loads attachments through: the media
// server alone (the Electron asset handler has no place under plain node).
const assets = async (request: Request): Promise<Response> =>
  new URL(request.url).host === 'file' ? serveMedia(request) : new Response('not found', { status: 404 })
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, assets })
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

const makeTyped = async (id: string, threadType: 'chat' | 'planning' | 'implementation' | 'orchestration' | 'research', title: string, extra: Record<string, unknown> = {}) =>
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
      '- The tunnel dropping mid-copy: restic resumes.',
      ''
    ].join('\n')
  )
}

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
    ['---', 'title: SQLite on the phone', 'status: complete', 'summary: GRDB on the phone, bun:sqlite on the host', '---', '# SQLite on the phone', '', 'Both wrap the same engine. The phone wants value types and a migration story; the host wants a synchronous binding with no build step.', '', '## Findings', '', '- GRDB maps rows to Codable value types [1].', '- bun:sqlite binds synchronously and ships with Bun [2].', '- WAL lets one writer and many readers share the file [3].', ''].join('\n')
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

// Keep board tasks, rounds and sources outside a cold tail for the phone's
// history proof. A single merged block keeps the board itself readable.
for (const id of [THREAD_IMPL, THREAD_RESEARCH]) {
  at(id, [
    ...Array.from({ length: 650 }, (_, i): AgentEvent => ({ type: 'thinking', msgId: 'history-padding', blockIndex: 0, delta: true, text: ` ${i}` })),
    { type: 'thinking', msgId: 'history-padding', blockIndex: 0, delta: false, text: 'Earlier history replayed.' },
    status(id === THREAD_IMPL ? 'waiting' : 'idle')
  ])
}

// ── the key, and a pairing link for the simulator rehearsal ─────────────
const created = await server.remoteAuth.createKey({ name: 'ios-test', audience: 'client', caps: [], createdBy: 'local' })
const pairing = server.remoteAuth.createPairing({ name: 'ios-sim', audience: 'client', caps: [], createdBy: 'local' })
// A second key and pairing that may act: the action tests and the proof's
// steering shots use these; the read-only ones show the disabled states.
const operate = await server.remoteAuth.createKey({ name: 'ios-test-operate', audience: 'client', caps: ['operate', 'approve'], createdBy: 'local' })
const operatePairing = server.remoteAuth.createPairing({ name: 'ios-sim-operate', audience: 'client', caps: ['operate', 'approve'], createdBy: 'local' })
// A key that operates but never approves: the forbidden path of the approval card.
const operateOnly = await server.remoteAuth.createKey({ name: 'ios-test-operate-only', audience: 'client', caps: ['operate'], createdBy: 'local' })

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
        appended++
        registry.append(sessionId, { type: 'assistant-text', text: String(body.text ?? 'Done.'), delta: false, msgId: `f${appended}`, blockIndex: 0 })
        registry.append(sessionId, { type: 'turn-complete' })
        registry.append(sessionId, { type: 'status', status: 'idle' })
        return answer(200, { finished: sessionId })
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
    operateKeyId: operate.key.id,
    operateKey: operate.token,
    operateOnlyKeyId: operateOnly.key.id,
    operateOnlyKey: operateOnly.token,
    pairingLinkOperate: `http://127.0.0.1:${server.remote.port}/pair#${operatePairing.code}`,
    planPath: plan.planPath ?? null,
    pairingLink: `http://127.0.0.1:${server.remote.port}/pair#${pairing.code}`,
    threadA: THREAD_A,
    threadB: THREAD_B,
    localPort: server.port,
    shot,
    threads: { implementation: THREAD_IMPL, planning: THREAD_PLAN, orchestration: THREAD_ORCH, research: THREAD_RESEARCH, chat: THREAD_CHAT, long: THREAD_LONG },
    projectId: project.id,
    workspaceId: workspace.id
  }) + '\n'
)
