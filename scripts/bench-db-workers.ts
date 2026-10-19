/**
 * Headless proof for dbWorkers.ts (.temp-code/plan-YmWxF4BuCgjo.md): the
 * streaming write shape, an archive drain and session search against a
 * COPY of a real database, with the SQLite workers on or off, under the
 * app's own SQLite (Electron as Node).
 *
 *   mkdir -p /tmp/tc-bench && cp -c "$HOME/Library/Application Support/temp-code-dev/temp-code.db" \
 *     "$HOME/Library/Application Support/temp-code-dev/temp-code-cold.db" /tmp/tc-bench/
 *   bun run script:bench-db-workers -- /tmp/tc-bench/temp-code.db --workers off
 *
 * Re-clone before each run so both modes start from the same bytes. The
 * script refuses any path inside an app data dir: a second writer on the
 * installed app's database freezes the user's live threads.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { ColdMover } from '../src/main/server/cold'
import { startCheckpointWorker } from '../src/main/server/dbWorkers'
import { setStallLog, startStallMonitor, STALL_MS } from '../src/main/server/stalls'
import type { SessionMeta } from '../src/shared/events'

const args = process.argv.slice(2)
const dbArg = args.find((a) => !a.startsWith('--'))
const workers = args[args.indexOf('--workers') + 1]
if (!dbArg || (workers !== 'on' && workers !== 'off')) {
  console.error('usage: bench-db-workers <path to a COPY of temp-code.db> --workers on|off')
  process.exit(2)
}
const dbPath = resolve(dbArg)
if (/Application Support\/(TempCode|temp-code)/.test(dbPath)) {
  console.error(`refusing an app data dir: ${dbPath}; clone it with cp -c into /tmp first`)
  process.exit(2)
}
if (!existsSync(dbPath)) {
  console.error(`no such file: ${dbPath}`)
  process.exit(2)
}

// The workers are unref'd (a checkpoint in progress never holds the app
// open); this script has nothing else alive across an await.
const keepAlive = setInterval(() => {}, 1000)
const logDir = join(dirname(dbPath), `logs-${workers}`)
rmSync(logDir, { recursive: true, force: true })
setStallLog(logDir)
const stopMonitor = startStallMonitor()

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`
const ms = (n: number): string => `${n.toFixed(1)}ms`
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n))
const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}
const summary = (label: string, xs: number[]): void => {
  const slow = xs.filter((x) => x >= STALL_MS).length
  console.log(
    `${label.padEnd(14)} n=${xs.length} max=${ms(Math.max(0, ...xs))} p99=${ms(percentile(xs, 0.99))} p50=${ms(percentile(xs, 0.5))} >=${STALL_MS}ms: ${slow}`
  )
}

console.log(`db       ${dbPath} (${mb(statSync(dbPath).size)}), workers ${workers}`)
const db = openDb(dbPath)
const noop = (schema: 'main' | 'cold'): { log: number; checkpointed: number } =>
  db.prepare(`PRAGMA ${schema}.wal_checkpoint(NOOP)`).get() as unknown as { log: number; checkpointed: number }
const autocheckpoint = (): number => (db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint
const workerCheckpoints: { schema: string; frames: number; ms: number }[] = []
const checkpointWorker =
  workers === 'on'
    ? startCheckpointWorker(db, dbPath, {
        onCheckpoint: (schema, frames, took) => workerCheckpoints.push({ schema, frames, ms: took })
      })
    : null
if (checkpointWorker) console.log(`worker   ready=${await checkpointWorker.ready}`)
console.log(`writer   wal_autocheckpoint=${autocheckpoint()} sqlite=${(db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v}`)
const store = new Store(db)

// Every flush that had rows to land, timed from the outside.
const flushes: number[] = []
const flushEvents = store.flushEvents.bind(store)
store.flushEvents = () => {
  const pending = (store as unknown as { pendingEvents: unknown[] }).pendingEvents.length
  const at = performance.now()
  flushEvents()
  if (pending > 0) flushes.push(performance.now() - at)
}

const RUN = `bench-${Date.now().toString(36)}`
const meta = (id: string): SessionMeta =>
  ({
    id, parentId: null, projectId: null, workspaceId: null, threadType: 'chat', planPath: null,
    provider: 'claude', model: 'bench', reasoning: 'medium', agentType: 'implementer', title: id, cwd: '/tmp',
    status: 'idle', pinned: false, archived: false, fast: false, ultrafast: false, context1m: false,
    busySince: null, pausedAt: null, frozenActiveElapsed: null, threadRules: null, permission: 'edits',
    nativeId: null, createdAt: Date.now(), updatedAt: Date.now()
  }) as unknown as SessionMeta
const payload = (i: number): string => `bench ${RUN} row ${i} `.padEnd(400, 'x')

/** The longest gap between 1 ms ticks while `run` is in flight: how long
 *  the loop was held by whatever `run` did on this thread. */
async function loopHeld<T>(run: () => Promise<T>): Promise<{ result: T; heldMs: number }> {
  let last = performance.now()
  let heldMs = 0
  const ticker = setInterval(() => {
    const now = performance.now()
    heldMs = Math.max(heldMs, now - last)
    last = now
  }, 1)
  try {
    const result = await run()
    await sleep(5)
    return { result, heldMs }
  } finally {
    clearInterval(ticker)
  }
}

// ── write load: 200k deltas, 8 sessions, 50 per tick ────────────────────
{
  const sessions = Array.from({ length: 8 }, (_, i) => `${RUN}-w${i}`)
  for (const id of sessions) store.insertSession(meta(id))
  const before = noop('main')
  let peakWal = 0
  const at = performance.now()
  for (let i = 0; i < 200_000; i += 50) {
    for (let j = 0; j < 50; j++) {
      store.appendEvent(sessions[(i + j) % sessions.length], {
        type: 'assistant-text', text: payload(i + j), delta: true, msgId: 'm', blockIndex: 0
      })
    }
    await tick()
    if (i % 1000 === 0) {
      const { log, checkpointed } = noop('main')
      peakWal = Math.max(peakWal, log - checkpointed)
    }
  }
  store.flushEvents()
  const took = performance.now() - at
  console.log(`\nwrite    200000 rows in ${(took / 1000).toFixed(1)}s; wal before=${JSON.stringify(before)} after=${JSON.stringify(noop('main'))} peak unchecked frames=${peakWal}`)
  summary('flush', flushes)
}

// ── cold drain: one 40k-row session archived, moved in 5k batches ───────
{
  const flushAt = flushes.length
  const coldId = `${RUN}-cold`
  store.insertSession(meta(coldId))
  for (let i = 0; i < 40_000; i += 50) {
    for (let j = 0; j < 50; j++) {
      store.appendEvent(coldId, { type: 'assistant-text', text: payload(i + j), delta: true, msgId: 'm', blockIndex: 0 })
    }
    await tick()
  }
  store.flushEvents()
  // Let the worker catch up with the 40k rows before the drain is timed.
  if (checkpointWorker) await sleep(500)
  db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(coldId)
  const moves: number[] = []
  const moveToCold = store.moveToCold.bind(store)
  store.moveToCold = (id, limit) => {
    const at = performance.now()
    const out = moveToCold(id, limit)
    moves.push(performance.now() - at)
    return out
  }
  const before = noop('cold')
  const at = performance.now()
  await new ColdMover(store).kick()
  console.log(`\ncold     40000 rows drained in ${(performance.now() - at) / 1000}s; cold wal before=${JSON.stringify(before)} after=${JSON.stringify(noop('cold'))}`)
  summary('move batch', moves)
  summary('flush', flushes.slice(flushAt))
}

// ── search: ten calls each, hot only and hot + cold ─────────────────────
{
  for (const archived of [false, true]) {
    const times: number[] = []
    const held: number[] = []
    let hits = 0
    for (let i = 0; i < 10; i++) {
      const at = performance.now()
      const { result, heldMs } = await loopHeld(async () => store.searchEvents({ query: 'the', archived, limit: 200 }))
      times.push(performance.now() - at)
      held.push(heldMs)
      hits = result.hits.length
    }
    console.log(`\nsearch   archived=${archived} hits=${hits}`)
    summary('search call', times)
    summary('loop held', held)
  }
}

// ── stalls.log and worker checkpoints ───────────────────────────────────
await sleep(1200)
stopMonitor()
if (checkpointWorker) {
  const bySchema = new Map<string, { n: number; frames: number; ms: number; max: number }>()
  for (const c of workerCheckpoints) {
    const row = bySchema.get(c.schema) ?? { n: 0, frames: 0, ms: 0, max: 0 }
    row.n += 1
    row.frames += c.frames
    row.ms += c.ms
    row.max = Math.max(row.max, c.ms)
    bySchema.set(c.schema, row)
  }
  console.log(`\nworker checkpoints:`)
  for (const [schema, row] of bySchema) {
    console.log(`  ${schema.padEnd(5)} n=${row.n} frames=${row.frames} total=${ms(row.ms)} max=${ms(row.max)}`)
  }
  if (bySchema.size === 0) console.log('  none')
  await checkpointWorker.stop()
}
console.log(`\nstalls.log (${logDir}):`)
try {
  const lines = readFileSync(join(logDir, 'stalls.log'), 'utf8')
    .split('\n')
    .filter((l) => /\b(loop|timed|checkpoint)\b/.test(l))
    .map((l) => l.replace(/ inflight=.*$/, ''))
  const counts = new Map<string, number>()
  for (const l of lines) {
    const kind = l.split(' ')[1]
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  console.log(`  ${[...counts].map(([k, n]) => `${k}=${n}`).join(' ') || 'no lines'}`)
  for (const l of lines.slice(0, 40)) console.log(`  ${l}`)
  if (lines.length > 40) console.log(`  … ${lines.length - 40} more`)
} catch {
  console.log('  (no stalls.log written)')
}
store.flushEvents()
db.close()
clearInterval(keepAlive)
