/**
 * The interactive lane for real: one in-process server (as
 * scripts/e2e-quota-routing.ts boots it) on temp dirs, a scratch git repo
 * with changes in it, and a seeded thread of 2,000 rows. One socket says
 * `session.focus` on the thread and reads its log in a loop; a second socket
 * floods 200 `git.diffStats` (the git status read the changes panel polls)
 * against the repo in waves. The focused reads must stay fast (p95 under
 * 100 ms), every bulk request must answer, and the duplicates must join
 * runs already waiting or running: far fewer git children than 200 runs
 * would spawn. A baseline with no flood comes first for comparison.
 *
 * Run: bun run script:e2e-interactive-lane
 * Nothing here touches /Applications/TempCode.app, its userData, the real
 * Aliax vault, ~/.claude or ~/.codex, the gateway marker or the Keychain.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import { StatsHost } from '../src/main/aliax/stats/statsHost'
import { defaultRoots } from '../src/main/aliax/stats/indexer'

const root = mkdtempSync(join(tmpdir(), 'tc-lane-'))
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config')
process.env.ALIAX_CREDENTIAL_BACKEND = 'file'
process.env.CODEX_HOME = join(root, 'codex-home')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.CODEX_HOME, { recursive: true })

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── count every git child the server spawns (before the server loads) ──
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
let gitChildren = 0
for (const name of ['execFile', 'spawn'] as const) {
  const original = childProcess[name] as (...args: unknown[]) => unknown
  ;(childProcess as unknown as Record<string, unknown>)[name] = function (this: unknown, file: unknown, ...rest: unknown[]) {
    if (file === 'git') gitChildren++
    return original.call(this, file, ...rest)
  }
}
syncBuiltinESMExports()

// ── an empty vault of our own, sealed by a key file ──
const vaultDir = join(root, 'aliax')
mkdirSync(join(vaultDir, 'secrets'), { recursive: true, mode: 0o700 })
writeFileSync(join(vaultDir, 'vault.key'), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
writeFileSync(join(vaultDir, 'profiles.json'), '{}')
configure({
  dataDir: vaultDir,
  fetch: async () => {
    throw new Error('no network in this proof')
  },
  secrets: { mode: 'fileKey' },
  appName: 'temp-code-e2e'
})

// ── a scratch repo with tracked, modified and untracked files ──
const repo = join(root, 'repo')
mkdirSync(repo)
const git = (...args: string[]): void => void execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'proof@example.com')
git('config', 'user.name', 'proof')
for (let i = 0; i < 40; i++) writeFileSync(join(repo, `file-${i}.txt`), `line\n`.repeat(50))
git('add', '.')
git('commit', '-q', '-m', 'seed')
for (let i = 0; i < 10; i++) writeFileSync(join(repo, `file-${i}.txt`), `changed\n`.repeat(60))
for (let i = 0; i < 5; i++) writeFileSync(join(repo, `new-${i}.txt`), 'new\n')
const gitBefore = gitChildren

const { startServer } = await import('../src/main/server/index')
const { currentLag } = await import('../src/main/server/stalls')
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, dataDir: root })

// ── a thread of 2,000 rows to read ──
const SESSION = 'lane-focused'
server.store.insertSession({
  id: SESSION, parentId: null, projectId: null, workspaceId: null, threadType: 'chat', planPath: null, provider: 'claude',
  model: 'm', reasoning: 'medium', agentType: 'implementer', title: 'focused', cwd: repo, status: 'idle', pinned: false,
  archived: false, fast: false, ultrafast: false, context1m: false, busySince: null, pausedAt: null,
  frozenActiveElapsed: null, threadRules: null, permission: 'edits', nativeId: null, createdAt: Date.now(), updatedAt: Date.now()
})
const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(10)
for (let i = 0; i < 2_000; i++) {
  server.registry.append(SESSION, i % 10 === 0 ? { type: 'user-text', text: `turn ${i}` } : { type: 'assistant-text', text: `${i} ${filler}`, delta: false })
}

// ── sockets ──
interface Socket {
  ws: WebSocket
  request: (method: string, params?: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>
}
const open = (): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    let next = 1
    const pending = new Map<string, (frame: { ok: boolean; result?: unknown; error?: string }) => void>()
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { id?: string; ok: boolean }
      if (frame.id && pending.has(frame.id)) {
        pending.get(frame.id)!(frame)
        pending.delete(frame.id)
      }
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        ws,
        request: (method, params = {}) =>
          new Promise((r) => {
            const id = String(next++)
            pending.set(id, r)
            ws.send(JSON.stringify({ id, method, params }))
          })
      })
    )
  })

const focused = await open()
const flooder = await open()
check('session.focus is answered', (await focused.request('session.focus', { sessionId: SESSION })).ok)
check('the host counts the thread as interactive', server.isInteractive(SESSION))

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}
const fmt = (values: number[]): string =>
  `n=${values.length} p50=${percentile(values, 50).toFixed(1)}ms p95=${percentile(values, 95).toFixed(1)}ms max=${Math.max(...values).toFixed(1)}ms`

/** Read the focused thread's last turns in a loop until `until` says stop. */
async function readLoop(until: () => boolean, minSamples: number): Promise<number[]> {
  const times: number[] = []
  while (!until() || times.length < minSamples) {
    const startedAt = performance.now()
    const answer = await focused.request('session.events', { sessionId: SESSION, tail: 20 })
    times.push(performance.now() - startedAt)
    if (!answer.ok) throw new Error(`session.events failed: ${answer.error}`)
  }
  return times
}

// ── baseline: the focused reads alone ──
let baselineDone = false
setTimeout(() => (baselineDone = true), 1_500)
const baseline = await readLoop(() => baselineDone, 50)
console.log(`baseline  session.events ${fmt(baseline)}`)

// ── --stats: the stats worker asked for its bundle beside the reads (fix H 11a) ──
// The bundle used to run on this loop (3.2 to 3.5 s); through the worker the
// loop's WORST lag, not its mean, must stay under STATS_LAG_MS while the
// flood runs and the bundle is asked for at its start and its end.
const STATS = process.argv.includes('--stats')
const STATS_LAG_MS = 50
let statsHost: StatsHost | null = null
let maxLateness = 0
let latenessTimer: ReturnType<typeof setInterval> | null = null
if (STATS) {
  const statsOut = join(repoRoot, 'scripts', '.out', 'statsWorker.cjs')
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'esbuild'), [
    'src/main/aliax/stats/statsWorker.ts', '--bundle', '--platform=node', '--format=cjs', '--packages=external',
    '--alias:@shared=./src/shared', `--outfile=${statsOut}`
  ], { cwd: repoRoot, stdio: 'inherit' })
  const statsDir = mkdtempSync(join(tmpdir(), 'tc-lane-stats-'))
  statsHost = new StatsHost({ spawn: () => new Worker(statsOut, { workerData: { dbPath: join(statsDir, 'stats.db'), roots: defaultRoots() } }) })
  const indexed = await statsHost.index()
  console.log(`stats     ${indexed.filesTotal} files indexed in the worker, ${indexed.rows} rows`)
  let last = performance.now()
  latenessTimer = setInterval(() => {
    const now = performance.now()
    maxLateness = Math.max(maxLateness, now - last - 10)
    last = now
  }, 10)
  void statsHost.bundle()
}

// ── the flood: 200 git.diffStats in waves of 20 every 25 ms ──
const FLOOD = 200
let answered = 0
let refused = 0
let maxLag = 0
const lagTimer = setInterval(() => (maxLag = Math.max(maxLag, currentLag().meanMs)), 100)
const floodStartedAt = performance.now()
const bulk: Promise<void>[] = []
const floodSent = (async () => {
  for (let wave = 0; wave < FLOOD / 20; wave++) {
    for (let i = 0; i < 20; i++)
      bulk.push(
        flooder.request('git.diffStats', { cwd: repo }).then((answer) => {
          answered++
          if (!answer.ok) refused++
        })
      )
    await sleep(25)
  }
})()
const during = await readLoop(() => answered >= FLOOD, 100)
await floodSent
await Promise.all(bulk)
const floodMs = performance.now() - floodStartedAt
clearInterval(lagTimer)
const children = gitChildren - gitBefore
console.log(`flood     session.events ${fmt(during)}`)
console.log(`flood     ${FLOOD} git.diffStats answered in ${Math.round(floodMs)} ms, ${children} git children, loop mean lag max ${maxLag.toFixed(1)} ms`)

// One run alone, to say what 200 runs would have cost.
const soloBefore = gitChildren
await flooder.request('git.diffStats', { cwd: repo })
const perRun = gitChildren - soloBefore

check('the focused reads keep p95 under 100 ms during the flood', percentile(during, 95) < 100, fmt(during))
check('every bulk request answers', answered === FLOOD && refused === 0, `${answered} answered, ${refused} refused`)
check(
  'duplicates joined: far fewer git children than 200 runs',
  children < (FLOOD * perRun) / 4,
  `${children} children; one run spawns ${perRun}, so 200 runs would spawn ${FLOOD * perRun}`
)
if (statsHost) {
  const bundle = await statsHost.bundle()
  if (latenessTimer) clearInterval(latenessTimer)
  console.log(`stats     bundle of ${bundle.totals.turns} turns answered through the worker; loop lag max ${maxLateness.toFixed(1)} ms`)
  check('the stats bundle answers through the worker', bundle.unavailable === undefined, bundle.unavailable ?? '')
  check(`the loop's worst lag stays under ${STATS_LAG_MS} ms with the stats bundle asked beside the reads`, maxLateness < STATS_LAG_MS, `${maxLateness.toFixed(1)} ms`)
  await statsHost.stop()
}

focused.ws.close()
flooder.ws.close()
await sleep(100)
check('a closed socket drops its focus', !server.isInteractive(SESSION))
await server.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
