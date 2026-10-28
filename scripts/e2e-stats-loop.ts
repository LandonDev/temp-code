/**
 * Stats off the loop (CLAUDE.md "The shape that scales"), measured. The box's
 * real ~/.claude/projects and ~/.codex/sessions logs are indexed into a temp
 * database twice: once on this loop through the engine (the path the app took
 * until fix H), once through the stats worker (the path it takes now), with a
 * 10 ms timer measuring the loop's lag throughout. Prints both maxima and
 * fails when the worker's path stalls the loop past LAG_LIMIT_MS.
 * Run: bun run script:e2e-stats-loop (bun with the electron stub; the worker
 * entry is bundled with esbuild into scripts/.out first).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { StatsEngine } from '../src/main/aliax/stats/statsEngine'
import { StatsHost } from '../src/main/aliax/stats/statsHost'
import { defaultRoots } from '../src/main/aliax/stats/indexer'

const LAG_LIMIT_MS = 50
const repo = join(import.meta.dirname, '..')
const out = join(repo, 'scripts', '.out', 'statsWorker.cjs')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

execFileSync(join(repo, 'node_modules', '.bin', 'esbuild'), [
  'src/main/aliax/stats/statsWorker.ts', '--bundle', '--platform=node', '--format=cjs', '--packages=external',
  '--alias:@shared=./src/shared', `--outfile=${out}`
], { cwd: repo, stdio: 'inherit' })

/** The loop's worst lag while `run` runs: a 10 ms timer, each tick's lateness. */
async function lagDuring(run: () => Promise<void>): Promise<number> {
  let max = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    max = Math.max(max, now - last - 10)
    last = now
  }, 10)
  try {
    await run()
  } finally {
    clearInterval(timer)
  }
  return max
}

const base = mkdtempSync(join(tmpdir(), 'tc-stats-loop-'))
const roots = defaultRoots()
console.log(`\n[1] the old path: the index and the bundle on this loop`)
const engine = new StatsEngine({ dbPath: join(base, 'loop.db'), roots })
let files = 0
const t0 = performance.now()
const before = await lagDuring(async () => {
  files = (await engine.index()).filesTotal
  engine.bundle()
})
console.log(`      ${files} files indexed in ${Math.round(performance.now() - t0)} ms; loop lag max ${before.toFixed(1)} ms`)
engine.close()

console.log(`\n[2] the new path: the stats worker`)
const host = new StatsHost({ spawn: () => new Worker(out, { workerData: { dbPath: join(base, 'worker.db'), roots } }) })
const t1 = performance.now()
const after = await lagDuring(async () => {
  await host.index()
  await host.bundle()
})
console.log(`      ${host.progress().filesTotal} files indexed in ${Math.round(performance.now() - t1)} ms; loop lag max ${after.toFixed(1)} ms`)
check('the worker answered a bundle', (await host.bundle()).unavailable === undefined, host.status().unavailable ?? '')
check(`the worker keeps the loop lag under ${LAG_LIMIT_MS} ms (the loop's own path: ${before.toFixed(0)} ms)`, after < LAG_LIMIT_MS, `${after.toFixed(1)} ms`)
await host.stop()
rmSync(base, { recursive: true, force: true })
console.log(`\nbefore ${before.toFixed(1)} ms, after ${after.toFixed(1)} ms`)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
