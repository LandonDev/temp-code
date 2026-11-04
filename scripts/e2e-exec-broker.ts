/**
 * The exec broker for real, before and after: two isolated headless
 * instances of the BUILT tree, each with TEMP_CODE_E2E_BALLAST_MB resident in
 * main (700 MiB by default: the box's server), each flooded with
 * `git.diffIndex` asks spread over 24 scratch repos in rounds (a 48-row board
 * refreshing), one with every helper forked from main
 * (TEMP_CODE_EXEC_BROKER=0), one with the broker process. For each: the
 * asks' p50/p95/max, the flood's wall time, main's loop lag sampled through
 * doctor.get, and the asks that failed. In the broker run the broker is
 * SIGKILLed mid-flood: main respawns it (doctor.get: a new pid, restarts 1)
 * and the asks after it answer; stopping the instance takes the broker with it.
 *
 * Run: bun run script:e2e-exec-broker   (build first: electron-vite build)
 *   --rounds N (8)  --repos N (24)  --ballast MiB (700)  --only before|after
 * Nothing here touches /Applications/TempCode.app, its userData, the real
 * Aliax vault, ~/.claude or ~/.codex. Report: /tmp/tc-exec-broker/report.json
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, prepareEnv, sleep } from './lib/packagedApp'
import { alive, stopTree } from './lib/processTree'

prepareEnv()
const OUT = '/tmp/tc-exec-broker'
const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : fallback
}
const ROUNDS = arg('rounds', 8)
const REPOS = arg('repos', 24)
const BALLAST_MB = arg('ballast', 700)
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

if (!existsSync(join(REPO, 'out', 'main', 'execBroker.js'))) {
  console.error('out/main/execBroker.js is missing: run electron-vite build first')
  process.exit(2)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)

// ── the scratch repos: tracked, modified and untracked files, as a board's checkouts ──
const repos: string[] = []
for (let r = 0; r < REPOS; r++) {
  const dir = join(OUT, 'repos', `r${r}`)
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'proof@example.com')
  git('config', 'user.name', 'proof')
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, `file-${i}.txt`), 'line\n'.repeat(50))
  git('add', '.')
  git('commit', '-q', '-m', 'seed')
  for (let i = 0; i < 10; i++) writeFileSync(join(dir, `file-${i}.txt`), 'changed\n'.repeat(60))
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, `new-${i}.txt`), 'new\n')
  repos.push(dir)
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}
const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)

type Frame = Record<string, unknown>
interface Loop {
  meanMs: number
  maxMs: number
  ewmaMs: number
}
interface Doctor {
  loop: Loop
  gateway?: { mode: string; pid: number }
  execBroker?: { mode: 'child' | 'in-process'; pid: number; restarts: number }
}
interface Run {
  mode: 'before' | 'after'
  asks: number
  failed: number
  p50: number
  p95: number
  max: number
  totalMs: number
  loopMean: number
  loopMax: number
  samples: number
  broker: Doctor['execBroker']
  respawn?: { pidBefore: number; pidAfter: number; restarts: number; failedAcross: number }
  brokerOutlivedMain?: boolean
}

async function instance(mode: 'before' | 'after'): Promise<Run> {
  const data = join(OUT, mode, 'data')
  const vaultDir = join(data, 'aliax')
  mkdirSync(join(vaultDir, 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(join(vaultDir, 'vault.key'), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  writeFileSync(join(vaultDir, 'profiles.json'), '{}')
  const logPath = join(OUT, mode, 'instance.log')
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_WORK_ROOT: join(OUT, mode),
    TEMP_CODE_WARM_HARNESS: '0',
    TEMP_CODE_ALIAX_DATA_DIR: vaultDir,
    TEMP_CODE_E2E_BALLAST_MB: String(BALLAST_MB),
    TEMP_CODE_EXEC_BROKER: mode === 'before' ? '0' : '1',
    ALIAX_SHIM_PORT: '1',
    CLAUDE_CONFIG_DIR: join(OUT, mode, 'claude-config'),
    ALIAX_CREDENTIAL_BACKEND: 'file'
  }
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_CLAIM_SHIM
  const logFd = openSync(logPath, 'a')
  const wrapper = Bun.spawn([join(REPO, 'node_modules', '.bin', 'electron-vite'), 'preview', '--skipBuild'], { cwd: REPO, env, stdout: logFd, stderr: logFd })

  const pending = new Map<string, { ok: (v: unknown) => void; bad: (e: Error) => void }>()
  let next = 1
  let ws!: WebSocket
  let mainPid = 0
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    const id = `b${next++}`
    return new Promise<T>((ok, bad) => {
      pending.set(id, { ok: ok as (v: unknown) => void, bad })
      ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }
  const until = async (label: string, ms: number, test: () => boolean): Promise<void> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (test()) return
      await sleep(200)
    }
    throw new Error(`timed out: ${label}`)
  }
  let run: Run = { mode, asks: 0, failed: 0, p50: 0, p95: 0, max: 0, totalMs: 0, loopMean: 0, loopMax: 0, samples: 0, broker: undefined }
  let brokerPid = 0
  try {
    await until('server.json', 90_000, () => existsSync(join(data, 'server.json')))
    const file = JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number; pid: number }
    mainPid = file.pid
    ws = new WebSocket(`ws://127.0.0.1:${file.port}/`)
    await new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok())
      ws.addEventListener('error', () => bad(new Error('socket error')))
    })
    ws.addEventListener('message', (e) => {
      const frame = JSON.parse(String(e.data)) as Frame
      if (typeof frame.id === 'string' && pending.has(frame.id)) {
        const p = pending.get(frame.id)!
        pending.delete(frame.id)
        if (frame.ok) p.ok(frame.result)
        else p.bad(new Error(String(frame.error)))
      }
    })
    const doctor = (): Promise<Doctor> => request<Doctor>('doctor.get')
    const first = await doctor()
    run.broker = first.execBroker
    brokerPid = first.execBroker?.pid ?? 0
    if (mode === 'before') check('before: helpers fork from main', first.execBroker?.mode === 'in-process' && first.execBroker.pid === mainPid, JSON.stringify(first.execBroker))
    else check('after: helpers fork from the broker process', first.execBroker?.mode === 'child' && brokerPid > 0 && brokerPid !== mainPid && alive(brokerPid), JSON.stringify(first.execBroker))
    // Warm: one ask per repo, so git's own first-run costs are out of the numbers.
    await Promise.all(repos.map((cwd) => request('git.diffIndex', { cwd }).catch(() => null)))

    // The flood, with the loop sampled beside it.
    const times: number[] = []
    const loops: Loop[] = []
    let failed = 0
    let failedAcross = 0
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const d = await doctor().catch(() => null)
        if (d) loops.push(d.loop)
        await sleep(200)
      }
    })()
    const started = Date.now()
    let killedAt = -1
    for (let round = 0; round < ROUNDS; round++) {
      if (mode === 'after' && round === Math.floor(ROUNDS / 2)) {
        process.kill(brokerPid, 'SIGKILL')
        killedAt = Date.now()
        log(`broker ${brokerPid} SIGKILLed before round ${round + 1}`)
      }
      const outcomes = await Promise.all(
        repos.map(async (cwd) => {
          const t0 = performance.now()
          try {
            await request('git.diffIndex', { cwd })
            times.push(performance.now() - t0)
            return true
          } catch (e) {
            if (killedAt > 0 && Date.now() - killedAt < 5_000) failedAcross++
            else failed++
            log(`ask failed: ${(e as Error).message.split('\n')[0]}`)
            return false
          }
        })
      )
      void outcomes
    }
    const totalMs = Date.now() - started
    sampling = false
    await sampler
    const last = await doctor()
    run = {
      ...run,
      asks: times.length + failed + failedAcross,
      failed,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: Math.max(0, ...times),
      totalMs,
      loopMean: mean(loops.map((l) => l.meanMs)),
      loopMax: Math.max(0, ...loops.map((l) => l.maxMs)),
      samples: loops.length,
      broker: last.execBroker
    }
    if (mode === 'after') {
      run.respawn = { pidBefore: brokerPid, pidAfter: last.execBroker?.pid ?? 0, restarts: last.execBroker?.restarts ?? 0, failedAcross }
      check('the broker was respawned on the same instance', last.execBroker?.mode === 'child' && (last.execBroker.restarts ?? 0) >= 1 && last.execBroker.pid !== brokerPid && alive(last.execBroker.pid), JSON.stringify(run.respawn))
      check('asks after the respawn answered', failed === 0, `${failed} failed outside the kill's 5 s`)
      brokerPid = last.execBroker?.pid ?? brokerPid
    } else check('every ask answered', failed === 0, `${failed} failed`)
    log(`${mode}: ${run.asks} asks  p50 ${run.p50.toFixed(0)} ms  p95 ${run.p95.toFixed(0)} ms  max ${run.max.toFixed(0)} ms  total ${(totalMs / 1000).toFixed(1)} s  loop mean ${run.loopMean.toFixed(1)} ms  loop max ${run.loopMax.toFixed(0)} ms (${loops.length} samples)`)
  } catch (e) {
    check(`${mode} run completed`, false, (e as Error).message)
  } finally {
    ws?.close()
    const left = await stopTree([mainPid, wrapper.pid ?? 0], 15_000)
    if (mode === 'after' && brokerPid) {
      await sleep(500)
      run.brokerOutlivedMain = alive(brokerPid)
      check('stopping the instance took the broker process with it', !run.brokerOutlivedMain)
    }
    if (left.length) log(`${left.length} process(es) of the instance needed SIGKILL`)
    closeSync(logFd)
  }
  return run
}

const runs: Run[] = []
if (only !== 'after') runs.push(await instance('before'))
if (only !== 'before') runs.push(await instance('after'))

const row = (r: Run): string =>
  `| ${r.mode === 'before' ? 'forks from main' : 'exec broker'} | ${r.asks} | ${r.p50.toFixed(0)} | ${r.p95.toFixed(0)} | ${r.max.toFixed(0)} | ${(r.totalMs / 1000).toFixed(1)} | ${r.loopMean.toFixed(1)} | ${r.loopMax.toFixed(0)} | ${r.failed} |`
console.log(`\n${process.platform} ${BALLAST_MB} MiB ballast, ${REPOS} repos × ${ROUNDS} rounds of git.diffIndex`)
console.log('| helpers | asks | p50 ms | p95 ms | max ms | total s | loop mean ms | loop max ms | failed |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const r of runs) console.log(row(r))
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ platform: process.platform, ballastMb: BALLAST_MB, repos: REPOS, rounds: ROUNDS, runs }, null, 2))
console.log(`\nreport: ${join(OUT, 'report.json')}`)
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
