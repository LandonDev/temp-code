/**
 * The renderer soak's synthetic host: a real temp-code server in this
 * process (startServer on a temp database, the fixed-port listener on an
 * ephemeral port, as scripts/ios-client-test-server.ts boots), seeded with a
 * workspace, a project, a pinned master with sixteen batch children and a
 * running shell step, and driven by the fixed load of scripts/lib/soakLoad.ts
 * through the registry's append path. The chat scene (`startSoakHost('chat')`)
 * seeds one plain chat thread instead, with no master, batch or shell step,
 * and drives CHAT_PROFILE (the focused child's load alone):
 *
 *   meta   a child's live context grows (a meta push, no row); with no
 *          child, the master's
 *   delta  an assistant text delta; a message ends at a tool call or after
 *          100 deltas, a turn every 24 tool calls
 *   tool   a Read call and its result
 *   log    a line on the master's running shell step (a batch-delta line)
 *
 * The typing scene (`startSoakHost('typing')`) seeds the board's batch and
 * adds TYPING_PROFILE's streams:
 *
 *   settle  a child's turn completes and it goes idle: the registry
 *           re-pushes its master, and its settle report to the master is
 *           parked (no harness takes it)
 *   resume  that child is sent "Keep going" and runs again
 *   edit    a live edit owned by the master, through livediff.ts's
 *           emitLiveEdit, so the server's per-socket filter and previews
 *           lane carry it as they carry a watcher's
 *   flood   the same, burst and without a diff
 *
 * None of the edits settles, so the checkpoint listener reads no file.
 *
 * The send scene (`startSoakHost('send', { history })`) seeds the board's
 * batch with the master's history grown to `history` rows before its last
 * turn (a prompt, a reply, a Read call and its result, the turn's end: five
 * rows a turn), for the soak to send into. The scroll scene seeds the same
 * history, and grows the rail and the workspace column past a screen
 * (SCROLL_WORKSPACES more workspaces, SCROLL_PROJECTS more projects of two
 * settled chats each in the master's), for the soak to scroll.
 *
 * The switch scene (`startSoakHost('switch')`) seeds the board's batch and
 * its load, and a second workspace beside it (SWITCH_WORKSPACE: two
 * projects, six settled chats with history, one of them 400 rows long), for
 * the soak to switch between in the rail.
 *
 * No thread has a harness: the registry's boot, send and liveness sweep are
 * stood in for, so nothing spawns a CLI or flips a seeded row to stopped.
 *
 * As a process (scripts/soak-host.ts) it prints ONE JSON line on stdout with
 * the address, the seeded ids and an operate key, then runs the load until
 * SIGTERM, SIGINT or stdin closes. The key is in that line and nowhere else:
 * the soak (scripts/measure-renderer-soak.ts) moves it into its window and
 * never logs it. scripts/soak-host-check.ts proves a client socket receives
 * the declared load.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { startServer } from '../../src/main/server/index'
import { emitLiveEdit } from '../../src/main/server/livediff'
import type { AgentEvent } from '../../src/shared/events'
import { playScenarios, type ScenarioStep } from './soakScenarios'
import { batchRowMidRun, withShellLog } from './ios-seeds'
import { profileOf, startLoad, TYPING_EDIT_PATHS, TYPING_FLOOD_POOL, TYPING_FLOOD_SIZE, TYPING_SETTLERS, type BurstCadence, type SoakClock, type SoakDriver, type SoakEmit, type SoakScene } from './soakLoad'

export const SOAK_MASTER = 'soak-master'
export const SOAK_CHAT = 'soak-chat'
export const SOAK_SCENARIOS = 'soak-scenarios'
export const soakChildId = (i: number): string => `soak-child-${String(i).padStart(2, '0')}`
/** The scroll scene's rail and column: workspaces and projects past a screen of each. */
const SCROLL_WORKSPACES = 30
const SCROLL_PROJECTS = 24
/** The switch scene's two workspaces, by the names the rail shows. */
export const SOAK_WORKSPACE = 'soak'
export const SWITCH_WORKSPACE = 'client'
const SWITCH_THREADS = [
  { project: 'client app', title: 'Fix the login redirect', turns: 200 },
  { project: 'client app', title: 'Tidy the settings form', turns: 20 },
  { project: 'client app', title: 'Add the invoice export', turns: 20 },
  { project: 'client app', title: 'Explain the cache headers', turns: 10 },
  { project: 'client site', title: 'Write the pricing page', turns: 20 },
  { project: 'client site', title: 'Check the sitemap', turns: 10 }
]

const TITLES = [
  'Port the billing export to the new shell',
  'Backfill the March rollups',
  'Rename the config keys to the new scheme',
  'Move the gateway trace behind a flag',
  'Split the settings page into sections',
  'Cache the branch list per checkout',
  'Teach the search view a host filter',
  'Drop the old drawer component',
  'Bound the markdown worker queue',
  'Fix the tooltip that opens on scroll',
  'Make the board foot keyboard reachable',
  'Retry the deploy log after a restart',
  'Name the failed step in the gate notice',
  'Count the warm processes apart from the cap',
  'Let the rail fold a linked project',
  'Write the soak numbers into the docs'
]

const PROSE =
  'The listener keeps one pool per account, so a turn reuses the socket the last one opened. ' +
  'When the provider answers slowly the wait says so in the working line, and the timer above the composer keeps counting from the click. ' +
  'Nothing here needs a second store: the meta already carries the phase, and the board reads it the way the rail does. '

/** A live edit's diff body, about 2 KB: one hunk of 12 lines out and 12 in. */
const EDIT_DIFF = (() => {
  const lines = ['@@ -10,12 +10,12 @@ export function exportCsv(rows: Row[]): string {']
  for (let i = 0; i < 12; i++) lines.push(`-  const column${i} = rows.map((row) => row.cells[${i}]).filter(Boolean).join(',')`)
  for (let i = 0; i < 12; i++) lines.push(`+  const column${i} = rows.map((row) => quote(row.cells[${i}] ?? '')).join(',')`)
  return lines.join('\n') + '\n'
})()

export interface SoakHost {
  baseUrl: string
  environmentId: string
  scene: SoakScene
  /** the pinned master; empty in the chat scene */
  masterId: string
  children: string[]
  focusedId: string
  streamerIds: string[]
  projectId: string
  workspaceId: string
  keyId: string
  key: string
  /** Starts the profile's load; one driver per host. */
  startLoad(clock?: SoakClock, burst?: BurstCadence | null): SoakDriver
  /** The scenarios scene: plays the no-jerk timeline once on its chat, from now; returns a stop. */
  playScenarios(onStep?: (step: ScenarioStep) => void): () => void
  close(): Promise<void>
}

export async function startSoakHost(scene: SoakScene = 'board', opts: { history?: number } = {}): Promise<SoakHost> {
  const profile = profileOf(scene)
  const root = mkdtempSync(join(tmpdir(), 'tc-soak-host-'))
  process.env.TEMP_CODE_WARM_HARNESS = '0'
  configure({
    dataDir: join(root, 'aliax'),
    fetch: async (url) => {
      throw new Error(`unexpected fetch ${url}`)
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-soak'
  })
  const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0 })
  if (!server.remote || server.remote.port === 0) throw new Error('the remote listener did not bind')
  const registry = server.registry

  // No harness behind any thread: no boot at create, no send, no scheduler
  // pass, no liveness sweep turning a seeded running row into stopped.
  const stub = (key: string, fn: unknown): void => {
    ;(registry as unknown as Record<string, unknown>)[key] = fn
  }
  stub('handleFor', () => Promise.reject(new Error('the soak host runs no harness')))
  stub('send', async () => {})
  stub('whisper', () => {})
  stub('sweepLiveness', () => [])
  const sweep = registry as unknown as { livenessTimer?: ReturnType<typeof setInterval> | null }
  if (sweep.livenessTimer) clearInterval(sweep.livenessTimer)
  sweep.livenessTimer = null
  const scheduler = registry.scheduler as unknown as { schedule: () => void; admit: () => string }
  scheduler.schedule = () => {}
  scheduler.admit = () => 'start'

  const repo = join(root, 'soak')
  mkdirSync(repo)
  execFileSync('git', ['-C', repo, 'init', '-q'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=soak', '-c', 'user.email=soak@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
  const workspace = await registry.createWorkspace(repo, 'soak')
  const project = await registry.createProject(workspace.id, 'soak', 'local')
  const base = { provider: 'claude', model: 'claude-opus-5-5', reasoning: 'high', agentType: 'implementer', permission: 'edits', projectId: project.id } as const

  const seedThread = (id: string): void => {
    registry.append(id, { type: 'status', status: 'running' })
    registry.append(id, { type: 'assistant-text', text: PROSE.slice(0, 160), delta: false, msgId: `${id}-seed`, blockIndex: 0 })
    registry.append(id, { type: 'tool-call', callId: `${id}-seed-read`, name: 'Read', input: { file_path: 'src/index.ts' } })
    registry.append(id, { type: 'tool-result', callId: `${id}-seed-read`, output: 'export {}\n', isError: false })
  }
  let children: string[]
  let batchRow: ReturnType<typeof batchRowMidRun> | null = null
  if (scene === 'scenarios') {
    // One quiet chat the timeline plays on once the soak says go (playScenarios).
    await registry.create({ ...base, id: SOAK_SCENARIOS, threadType: 'chat', title: 'The no-jerk scenarios' })
    // A settled turn of history, so --scrolled-up has somewhere to scroll to.
    registry.append(SOAK_SCENARIOS, { type: 'user-text', text: 'Read the inbox code and tell me how it queries.' })
    for (let i = 0; i < 14; i++) {
      registry.append(SOAK_SCENARIOS, { type: 'assistant-text', text: `${PROSE} (${i + 1})`, delta: false, msgId: `history-${i}`, blockIndex: 0 })
    }
    registry.append(SOAK_SCENARIOS, { type: 'turn-complete' })
    registry.append(SOAK_SCENARIOS, { type: 'status', status: 'idle' })
    children = [SOAK_SCENARIOS]
  } else if (scene === 'chat') {
    await registry.create({ ...base, id: SOAK_CHAT, threadType: 'chat', title: TITLES[0]! })
    registry.append(SOAK_CHAT, { type: 'user-text', text: `${TITLES[0]}.` })
    seedThread(SOAK_CHAT)
    children = [SOAK_CHAT]
  } else {
  await registry.create({ ...base, id: SOAK_MASTER, threadType: 'chat', title: 'Ship the soak batch' })
  registry.setMaster(SOAK_MASTER, true)
  if (scene === 'send' || scene === 'scroll') {
    // A long-lived master: its history before the batch's turn, five rows a turn.
    for (let turn = 0; turn < Math.ceil((opts.history ?? 5_000) / 5); turn++) {
      registry.append(SOAK_MASTER, { type: 'user-text', text: `Turn ${turn + 1}: check the batch and say what landed.` })
      registry.append(SOAK_MASTER, { type: 'assistant-text', text: PROSE, delta: false, msgId: `soak-master-h${turn}`, blockIndex: 0 })
      const callId = `soak-master-h${turn}-read`
      registry.append(SOAK_MASTER, { type: 'tool-call', callId, name: 'Read', input: { file_path: `src/billing/export${turn % 12}.ts` } })
      registry.append(SOAK_MASTER, { type: 'tool-result', callId, output: 'export {}\n', isError: false })
      registry.append(SOAK_MASTER, { type: 'turn-complete' })
    }
  }
  registry.append(SOAK_MASTER, { type: 'user-text', text: 'Run the sixteen threads of the batch and land them as they finish.' })
  registry.append(SOAK_MASTER, { type: 'assistant-text', text: 'Started all sixteen; the steps run once the last one lands.', delta: false, msgId: 'soak-master-m1', blockIndex: 0 })
  registry.append(SOAK_MASTER, { type: 'turn-complete' })
  registry.append(SOAK_MASTER, { type: 'status', status: 'watching' })

  children = Array.from({ length: profile.children }, (_, i) => soakChildId(i))
  for (const [i, id] of children.entries()) {
    await registry.create({ ...base, id, threadType: 'implementation', title: TITLES[i % TITLES.length]!, masterId: SOAK_MASTER, startedBy: SOAK_MASTER })
    registry.append(id, { type: 'user-text', text: `${TITLES[i % TITLES.length]}.`, newPass: true })
    seedThread(id)
  }
  batchRow = batchRowMidRun(SOAK_MASTER, { landed: [], pending: children }, Date.now())
  server.batches.seedRow(batchRow)
  }
  if (scene === 'scroll') {
    // The rail's workspaces and the master's column of projects, each past a screen.
    for (let i = 0; i < SCROLL_WORKSPACES; i++) {
      const dir = join(root, `ws-${i}`)
      mkdirSync(dir)
      await registry.createWorkspace(dir, `${TITLES[i % TITLES.length]!.split(' ').slice(-1)[0]} ${i + 1}`)
    }
    for (let i = 0; i < SCROLL_PROJECTS; i++) {
      const projectId = (await registry.createProject(workspace.id, `project ${i + 1}`, 'local')).id
      for (let j = 0; j < 2; j++) {
        const id = `soak-scroll-${i}-${j}`
        await registry.create({ ...base, projectId, id, threadType: 'chat', title: TITLES[(i * 2 + j) % TITLES.length]! })
        registry.append(id, { type: 'user-text', text: `${TITLES[(i * 2 + j) % TITLES.length]}.` })
        registry.append(id, { type: 'status', status: 'running' })
        registry.append(id, { type: 'assistant-text', text: PROSE, delta: false, msgId: `${id}-a`, blockIndex: 0 })
        registry.append(id, { type: 'turn-complete' })
        registry.append(id, { type: 'status', status: 'idle' })
      }
    }
  }
  if (scene === 'switch') {
    // A second workspace of settled chats, each turn a question and an answer.
    const repo2 = join(root, SWITCH_WORKSPACE)
    mkdirSync(repo2)
    execFileSync('git', ['-C', repo2, 'init', '-q'])
    execFileSync('git', ['-C', repo2, '-c', 'user.name=soak', '-c', 'user.email=soak@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const ws2 = await registry.createWorkspace(repo2, SWITCH_WORKSPACE)
    const projects2 = new Map<string, string>()
    for (const name of new Set(SWITCH_THREADS.map((t) => t.project))) projects2.set(name, (await registry.createProject(ws2.id, name, 'local')).id)
    for (const [i, t] of SWITCH_THREADS.entries()) {
      const id = `soak-client-${i}`
      await registry.create({ ...base, projectId: projects2.get(t.project)!, id, threadType: 'chat', title: t.title })
      for (let turn = 0; turn < t.turns; turn++) {
        registry.append(id, { type: 'user-text', text: `${t.title}: step ${turn + 1}.` })
        registry.append(id, { type: 'status', status: 'running' })
        registry.append(id, { type: 'assistant-text', text: PROSE, delta: false, msgId: `${id}-a${turn}`, blockIndex: 0 })
        registry.append(id, { type: 'turn-complete' })
        registry.append(id, { type: 'status', status: 'idle' })
      }
    }
  }

  const created = await server.remoteAuth.createKey({ name: 'renderer-soak', audience: 'client', caps: ['operate'], createdBy: 'local' })

  // ── the load ────────────────────────────────────────────────────────────
  type Stream = { msg: number; text: string; deltas: number; tools: number; tokens: number }
  const streams = new Map<string, Stream>()
  const streamOf = (id: string): Stream => {
    let s = streams.get(id)
    if (!s) streams.set(id, (s = { msg: 0, text: '', deltas: 0, tools: 0, tokens: 40_000 }))
    return s
  }
  const append = (id: string, event: AgentEvent): void => registry.append(id, event)
  const endMessage = (id: string, s: Stream): void => {
    if (!s.text) return
    append(id, { type: 'assistant-text', text: s.text, delta: false, msgId: `${id}-m${s.msg}`, blockIndex: 0 })
    s.msg++
    s.text = ''
    s.deltas = 0
  }
  const liveEdit = (path: string, burst: boolean): void =>
    emitLiveEdit({
      push: 'live-edit',
      cwd: repo,
      sessionIds: [SOAK_MASTER],
      edit: burst ? { path, kind: 'changed', diff: null, bytes: 2_400, burst: true, ts: Date.now() } : { path, kind: 'changed', adds: 12, dels: 12, diff: EDIT_DIFF, bytes: 2_400, ts: Date.now() }
    })
  const apply = (emit: SoakEmit): void => {
    if (emit.kind === 'log') {
      if (!batchRow) return
      batchRow = withShellLog(batchRow, [`soak ${String(emit.n).padStart(5, '0')}: checking the billing page`])
      server.batches.seedRow(batchRow)
      return
    }
    if (emit.kind === 'settle' || emit.kind === 'resume') {
      const id = children[TYPING_SETTLERS[emit.n % TYPING_SETTLERS.length]!]!
      if (emit.kind === 'settle') {
        endMessage(id, streamOf(id))
        append(id, { type: 'turn-complete' })
        append(id, { type: 'status', status: 'idle' })
      } else {
        append(id, { type: 'user-text', text: 'Keep going with the next file.' })
        append(id, { type: 'status', status: 'running' })
      }
      return
    }
    if (emit.kind === 'edit') return liveEdit(`src/billing/edit${emit.n % TYPING_EDIT_PATHS}.ts`, false)
    if (emit.kind === 'flood') {
      // Each flood takes the other half of the pool, so the paths are distinct within a flood and the cap evicts across two.
      const flood = Math.floor(emit.n / TYPING_FLOOD_SIZE)
      return liveEdit(`src/generated/file${((flood % 2) * TYPING_FLOOD_SIZE + (emit.n % TYPING_FLOOD_SIZE)) % TYPING_FLOOD_POOL}.ts`, true)
    }
    const id = emit.child === null ? SOAK_MASTER : children[emit.child]!
    const s = streamOf(id)
    if (emit.kind === 'meta') {
      s.tokens += 1_337
      append(id, { type: 'context', tokens: s.tokens, window: 1_000_000 })
    } else if (emit.kind === 'delta') {
      const at = (emit.n * 7) % PROSE.length
      const chunk = PROSE.slice(at, at + 4 + (emit.n % 9))
      s.text += chunk
      s.deltas++
      append(id, { type: 'assistant-text', text: chunk, delta: true, msgId: `${id}-m${s.msg}`, blockIndex: 0 })
      if (s.deltas >= 100) endMessage(id, s)
    } else {
      endMessage(id, s)
      const callId = `${id}-read-${emit.n}`
      append(id, { type: 'tool-call', callId, name: 'Read', input: { file_path: `src/billing/export${emit.n % 12}.ts` } })
      append(id, { type: 'tool-result', callId, output: 'export function exportCsv(rows: Row[]): string {\n  return rows.map(toLine).join("\\n")\n}\n', isError: false })
      s.tools++
      if (s.tools % 24 === 0) {
        append(id, { type: 'turn-complete' })
        append(id, { type: 'user-text', text: 'Keep going with the next file.' })
        append(id, { type: 'status', status: 'running' })
      }
    }
  }
  let driver: SoakDriver | null = null

  return {
    baseUrl: `http://127.0.0.1:${server.remote.port}`,
    environmentId: server.environmentId,
    scene,
    masterId: scene === 'chat' ? '' : SOAK_MASTER,
    children,
    focusedId: children[profile.focused]!,
    streamerIds: profile.streamers.map((i) => children[i]!),
    projectId: project.id,
    workspaceId: workspace.id,
    keyId: created.key.id,
    key: created.token,
    playScenarios(onStep) {
      return playScenarios((event) => append(SOAK_SCENARIOS, event), onStep, undefined, () => registry.markStatusForProof(SOAK_SCENARIOS, 'running'))
    },
    startLoad(clock, burst) {
      if (driver) throw new Error('the load already runs')
      driver = startLoad(apply, clock, profile, burst ?? null)
      return driver
    },
    async close() {
      driver?.stop()
      await server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
