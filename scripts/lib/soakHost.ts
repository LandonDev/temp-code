/**
 * The renderer soak's synthetic host: a real temp-code server in this
 * process (startServer on a temp database, the fixed-port listener on an
 * ephemeral port, as scripts/ios-client-test-server.ts boots), seeded with a
 * workspace, a project, a pinned master with sixteen batch children and a
 * running shell step, and driven by the fixed load of scripts/lib/soakLoad.ts
 * through the registry's append path:
 *
 *   meta   a child's live context grows (a meta push, no row)
 *   delta  an assistant text delta; a message ends at a tool call or after
 *          100 deltas, a turn every 24 tool calls
 *   tool   a Read call and its result
 *   log    a line on the master's running shell step (a batch-delta line)
 *
 * No thread has a harness: the registry's boot, send and liveness sweep are
 * stood in for, so nothing spawns a CLI or flips a seeded row to stopped.
 *
 * Run as a script (`bun --preload scripts/lib/electron-stub.ts
 * scripts/lib/soakHost.ts`) it prints ONE JSON line on stdout with the
 * address, the seeded ids and an operate key, then runs the load until
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
import type { AgentEvent } from '../../src/shared/events'
import { batchRowMidRun, withShellLog } from './ios-seeds'
import { SOAK_PROFILE, startLoad, type SoakClock, type SoakDriver, type SoakEmit } from './soakLoad'

export const SOAK_MASTER = 'soak-master'
export const soakChildId = (i: number): string => `soak-child-${String(i).padStart(2, '0')}`

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

export interface SoakHost {
  baseUrl: string
  environmentId: string
  masterId: string
  children: string[]
  focusedId: string
  streamerIds: string[]
  projectId: string
  workspaceId: string
  keyId: string
  key: string
  /** Starts the profile's load; one driver per host. */
  startLoad(clock?: SoakClock): SoakDriver
  close(): Promise<void>
}

export async function startSoakHost(): Promise<SoakHost> {
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

  await registry.create({ ...base, id: SOAK_MASTER, threadType: 'chat', title: 'Ship the soak batch' })
  registry.setMaster(SOAK_MASTER, true)
  registry.append(SOAK_MASTER, { type: 'user-text', text: 'Run the sixteen threads of the batch and land them as they finish.' })
  registry.append(SOAK_MASTER, { type: 'assistant-text', text: 'Started all sixteen; the steps run once the last one lands.', delta: false, msgId: 'soak-master-m1', blockIndex: 0 })
  registry.append(SOAK_MASTER, { type: 'turn-complete' })
  registry.append(SOAK_MASTER, { type: 'status', status: 'watching' })

  const children = Array.from({ length: SOAK_PROFILE.children }, (_, i) => soakChildId(i))
  for (const [i, id] of children.entries()) {
    await registry.create({ ...base, id, threadType: 'implementation', title: TITLES[i % TITLES.length]!, masterId: SOAK_MASTER, startedBy: SOAK_MASTER })
    registry.append(id, { type: 'user-text', text: `${TITLES[i % TITLES.length]}.`, newPass: true })
    registry.append(id, { type: 'status', status: 'running' })
    registry.append(id, { type: 'assistant-text', text: PROSE.slice(0, 160), delta: false, msgId: `${id}-seed`, blockIndex: 0 })
    registry.append(id, { type: 'tool-call', callId: `${id}-seed-read`, name: 'Read', input: { file_path: 'src/index.ts' } })
    registry.append(id, { type: 'tool-result', callId: `${id}-seed-read`, output: 'export {}\n', isError: false })
  }
  let batchRow = batchRowMidRun(SOAK_MASTER, { landed: [], pending: children }, Date.now())
  server.batches.seedRow(batchRow)

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
  const apply = (emit: SoakEmit): void => {
    if (emit.kind === 'log') {
      batchRow = withShellLog(batchRow, [`soak ${String(emit.n).padStart(5, '0')}: checking the billing page`])
      server.batches.seedRow(batchRow)
      return
    }
    const id = children[emit.child ?? 0]!
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
    masterId: SOAK_MASTER,
    children,
    focusedId: children[SOAK_PROFILE.focused]!,
    streamerIds: SOAK_PROFILE.streamers.map((i) => children[i]!),
    projectId: project.id,
    workspaceId: workspace.id,
    keyId: created.key.id,
    key: created.token,
    startLoad(clock) {
      if (driver) throw new Error('the load already runs')
      driver = startLoad(apply, clock)
      return driver
    },
    async close() {
      driver?.stop()
      await server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  const host = await startSoakHost()
  host.startLoad()
  // JSON drops the two functions; the rest is the line the soak reads.
  process.stdout.write(JSON.stringify({ ready: true, ...host }) + '\n')
  let closing = false
  const quit = (): void => {
    if (closing) return
    closing = true
    void host.close().finally(() => process.exit(0))
  }
  process.on('SIGTERM', quit)
  process.on('SIGINT', quit)
  process.stdin.on('end', quit)
  process.stdin.resume()
}
