/**
 * The release gate: `bun run gate [--tier commit|publish|all] [--since <ref>]
 * [--full] [--only a,b] [--skip a,b] [--verbose]`.
 *
 * One implementation for both callers. The post-commit train
 * (scripts/release.ts) runs the `commit` tier, plus the `publish` tier when
 * the commits since the last release touch a path that tier guards
 * (TIER_PATHS below), so a contract change still cannot land stale Swift.
 * scripts/release-publish.sh runs the `publish` tier before signing.
 *
 * STEPS is the one list both tiers read; a sibling change adds a row there
 * (the bundle-size check after `build`, say) and nothing else. Steps in one
 * lane run in array order, one at a time; different lanes run at once, with
 * one status line while they do and a per-step time table when they finish.
 * On the first failure nothing more starts, the running steps are stopped,
 * and the failed step's log tail is printed. Every step's output lands in
 * <git-dir>/temp-code-gate/logs/<step>.log; the last run's times in
 * <git-dir>/temp-code-gate/last-run.json.
 *
 * Caches. vitest keeps its cache in node_modules/.vite/vitest and SwiftPM
 * its build under each package's .build; the gate never cleans either.
 * typecheck is skipped when no .ts, .tsx, .json or generated Swift file
 * changed since the last green run (the tree hash of that set is stored in
 * <git-dir>/temp-code-gate/typecheck); `--full` runs it regardless.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type Tier = 'commit' | 'publish'

export interface Step {
  /** The name in the status line, the log file and `--only`/`--skip`. */
  name: string
  tier: Tier
  cmd: string
  args: string[]
  /** Steps in one lane run in array order, one at a time; lanes run at once. */
  lane: string
  /** Extra environment for the child. */
  env?: Record<string, string>
  /** The step writes vitest's JSON report beside its log, and the report
   *  decides when the step's exit and its output disagree (judgeReport). */
  json?: boolean
  /** What the step guards, for the report and the docs. */
  why: string
  /** True for the one step the tree hash may skip (see typecheckHash). */
  hashSkip?: boolean
  /** Runs only on macOS (Xcode's Swift, the simulator, the hub's installed
   *  tree): skipped elsewhere with a note, since release:publish runs the
   *  publish tier on the Mac before anything ships. */
  mac?: boolean
}

/**
 * The gate, in one array. `commit` runs in the post-commit hook on every
 * commit on master; `publish` runs before signing in release-publish.sh and
 * on a commit whose paths hit TIER_PATHS. A proof that boots an instance
 * belongs in `publish`.
 */
export const STEPS: Step[] = [
  {
    name: 'typecheck',
    tier: 'commit',
    cmd: 'bun',
    args: ['run', 'typecheck'],
    lane: 'tsc',
    why: 'tsc for node and web, and the Swift contract check',
    hashSkip: true
  },
  {
    name: 'vitest',
    tier: 'commit',
    cmd: 'bunx',
    args: ['vitest', 'run'],
    lane: 'vitest',
    env: { NODE_ENV: 'test' },
    json: true,
    why: 'the unit tests (src/**/*.test.ts, scripts/**/*.test.ts); vitest.config.ts bounds the pool, and the JSON report decides when the reporter dies'
  },
  {
    name: 'build',
    tier: 'commit',
    cmd: 'bunx',
    args: ['electron-vite', 'build'],
    lane: 'build',
    why: 'the real electron-vite build into out/'
  },
  {
    name: 'bundle-size',
    tier: 'commit',
    cmd: 'bun',
    args: ['scripts/check-bundle-size.ts'],
    lane: 'build',
    why: "the renderer's index chunk against its budget, after the build (scripts/check-bundle-size.ts)"
  },
  {
    name: 'e2e-remote-fence',
    tier: 'publish',
    cmd: 'bun',
    args: ['run', 'script:e2e-remote-fence'],
    lane: 'e2e',
    why: 'the remote fence, pairing, webhook and hello rules against a real server (boots an instance)'
  },
  {
    name: 'hub',
    tier: 'publish',
    cmd: 'bun',
    args: ['run', 'hub:test'],
    lane: 'hub',
    why: 'the Cloudflare hub worker tests (infra/hub)',
    mac: true
  },
  {
    name: 'ios',
    tier: 'publish',
    cmd: 'bun',
    args: ['run', 'ios:test'],
    lane: 'swift',
    why: 'the iOS contract package (swift build + test)',
    mac: true
  },
  {
    name: 'ios-client',
    tier: 'publish',
    cmd: 'bun',
    args: ['run', 'ios:test:client'],
    lane: 'swift',
    why: 'the iOS client package against a live test server (boots an instance)',
    mac: true
  }
]

/** The steps a host off macOS skips, with the note the report carries. */
export function macOnlySkips(steps: readonly Step[], platform: NodeJS.Platform = process.platform): Map<string, string> {
  const out = new Map<string, string>()
  if (platform === 'darwin') return out
  for (const s of steps) if (s.mac) out.set(s.name, 'needs the Mac; release:publish runs it there')
  return out
}

/**
 * Which paths pull a tier into a commit's gate. A commit that touches one of
 * these runs that tier in the hook as well; everything else runs `commit`
 * only and leaves the rest to publish.
 */
export const TIER_PATHS: { pattern: string; tier: Tier; why: string }[] = [
  { pattern: 'ios/**', tier: 'publish', why: 'the Swift packages and the app' },
  { pattern: 'scripts/gen-swift-contract.ts', tier: 'publish', why: 'the Swift contract generator' },
  { pattern: 'src/shared/wireSchemas.ts', tier: 'publish', why: 'the zod the Swift contract is generated from' },
  { pattern: 'src/shared/contract*.ts', tier: 'publish', why: 'the wire contract the phone and the fence read' },
  { pattern: 'src/main/server/remote/**', tier: 'publish', why: 'the remote listener, fence and pairing' },
  { pattern: 'infra/hub/**', tier: 'publish', why: 'the hub worker' },
  { pattern: 'scripts/e2e-remote-fence.ts', tier: 'publish', why: 'the fence proof itself' },
  { pattern: 'scripts/ios-*', tier: 'publish', why: 'the iOS test runners' }
]

/** The files whose change makes typecheck run again (see typecheckHash). */
export const TYPECHECK_INPUTS = ['*.ts', '*.tsx', '*.json', 'ios/TempCodeContract/Sources/TempCodeContract/Generated/*']

// ---------------------------------------------------------------- selection

/** A small glob: `**` any depth, `*` within one segment, `?` one char. */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function matchPath(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path)
}

/** The tiers the changed paths pull in, with the rule that pulled each. */
export function tiersForPaths(
  paths: readonly string[],
  rules: readonly { pattern: string; tier: Tier }[] = TIER_PATHS
): Map<Tier, string[]> {
  const out = new Map<Tier, string[]>()
  for (const path of paths) {
    const rule = rules.find((r) => matchPath(r.pattern, path))
    if (!rule) continue
    const hits = out.get(rule.tier) ?? []
    hits.push(path)
    out.set(rule.tier, hits)
  }
  return out
}

export interface Selection {
  tiers: Set<Tier>
  only?: string[]
  skip?: string[]
}

/** The steps a run performs, in array order. Unknown names in only/skip throw. */
export function selectSteps(selection: Selection, steps: readonly Step[] = STEPS): Step[] {
  const names = new Set(steps.map((s) => s.name))
  for (const n of [...(selection.only ?? []), ...(selection.skip ?? [])]) {
    if (!names.has(n)) throw new Error(`no gate step named ${n} (steps: ${[...names].join(', ')})`)
  }
  return steps.filter(
    (s) =>
      selection.tiers.has(s.tier) &&
      (!selection.only || selection.only.includes(s.name)) &&
      !(selection.skip ?? []).includes(s.name)
  )
}

export function parseTier(value: string | undefined): Set<Tier> {
  switch (value ?? 'commit') {
    case 'commit':
      return new Set(['commit'])
    case 'publish':
      return new Set(['publish'])
    case 'all':
      return new Set(['commit', 'publish'])
    default:
      throw new Error(`--tier must be commit, publish or all (got ${value})`)
  }
}

// ---------------------------------------------------------------- git state

// The post-commit hook exports GIT_AUTHOR_*, GIT_INDEX_FILE and friends.
// Leaked into the gate they make every git command in a test act as the
// hook's own commit (gitops.test.ts saw the wrong author), so children
// get a plain environment.
export function plainEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.startsWith('GIT_')) out[k] = v
  return out
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: plainEnv(), stdio: ['ignore', 'pipe', 'inherit'] })
}

/** The per-worktree state dir: <git-dir>/temp-code-gate. */
export function gateDir(repo: string): string {
  const dir = resolve(repo, git(repo, ['rev-parse', '--git-dir']).trim())
  return join(dir, 'temp-code-gate')
}

/** Paths changed between `since` and the working tree (the commits and any uncommitted edits). */
export function changedPathsSince(repo: string, since: string): string[] {
  const lines = git(repo, ['diff', '--name-only', since]).split('\n')
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n')
  return [...new Set([...lines, ...untracked].map((l) => l.trim()).filter(Boolean))].sort()
}

/**
 * A hash of every typecheck input as it is in the working tree: the index's
 * blob ids for the clean files, the file's own hash for a modified one, and
 * the path for a deleted one. Equal hashes mean tsc would say the same thing.
 */
export function typecheckHash(repo: string, inputs: readonly string[] = TYPECHECK_INPUTS): string {
  const globs = inputs.map((p) => (p.includes('/') ? p : `**/${p}`))
  const matches = (path: string): boolean => globs.some((g) => matchPath(g, path))
  const indexed = new Map<string, string>()
  for (const line of git(repo, ['ls-files', '-s']).split('\n')) {
    if (!line) continue
    // "<mode> <sha> <stage>\t<path>"
    const tab = line.indexOf('\t')
    const path = line.slice(tab + 1)
    if (matches(path)) indexed.set(path, line.slice(0, tab).split(' ')[1])
  }
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all']).split('\n')
  for (const line of status) {
    if (!line) continue
    const path = line.slice(3).split(' -> ').pop()!
    if (!matches(path)) continue
    const abs = join(repo, path)
    indexed.set(path, existsSync(abs) ? git(repo, ['hash-object', '--', path]).trim() : 'deleted')
  }
  const h = createHash('sha256')
  for (const path of [...indexed.keys()].sort()) h.update(`${indexed.get(path)} ${path}\n`)
  return h.digest('hex')
}

export function readStoredHash(dir: string): string | undefined {
  const file = join(dir, 'typecheck')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined
}

export function storeHash(dir: string, hash: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'typecheck'), hash + '\n')
}

/** Skip only when not forced and the tree's hash equals the last green run's. */
export function shouldSkipTypecheck(opts: { full: boolean; hash: string; stored: string | undefined }): boolean {
  return !opts.full && opts.stored !== undefined && opts.stored === opts.hash
}

// ---------------------------------------------------------------- the runner

export type Outcome = 'passed' | 'failed' | 'stopped' | 'not run' | 'skipped'

export interface StepResult {
  name: string
  outcome: Outcome
  ms: number
  exitCode?: number | null
  /** The last lines of the step's output, kept for the failure report. */
  tail?: string
  note?: string
}

export interface Report {
  ok: boolean
  ms: number
  results: StepResult[]
}

export interface RunnerEvents {
  onStart?: (step: Step) => void
  onFinish?: (result: StepResult) => void
}

export type RunOne = (step: Step, signal: AbortSignal) => Promise<{ exitCode: number | null; tail: string }>

/**
 * Runs the steps lane by lane: each lane in array order, all lanes at once.
 * The first failure stops the gate: nothing more starts, the running steps
 * are aborted and reported as `stopped`, the rest as `not run`.
 */
export async function runSteps(
  steps: readonly Step[],
  runOne: RunOne,
  events: RunnerEvents = {},
  skipped: Map<string, string> = new Map()
): Promise<Report> {
  const t0 = Date.now()
  const results = new Map<string, StepResult>()
  const controller = new AbortController()
  let failed = false
  const lanes = new Map<string, Step[]>()
  for (const step of steps) {
    if (skipped.has(step.name)) {
      const r: StepResult = { name: step.name, outcome: 'skipped', ms: 0, note: skipped.get(step.name) }
      results.set(step.name, r)
      events.onFinish?.(r)
      continue
    }
    lanes.set(step.lane, [...(lanes.get(step.lane) ?? []), step])
  }
  const runLane = async (queue: Step[]): Promise<void> => {
    for (const step of queue) {
      if (failed) {
        results.set(step.name, { name: step.name, outcome: 'not run', ms: 0 })
        continue
      }
      events.onStart?.(step)
      const start = Date.now()
      let result: StepResult
      try {
        const { exitCode, tail } = await runOne(step, controller.signal)
        const ms = Date.now() - start
        if (exitCode === 0) result = { name: step.name, outcome: 'passed', ms }
        else if (controller.signal.aborted && failed) result = { name: step.name, outcome: 'stopped', ms, exitCode, tail }
        else result = { name: step.name, outcome: 'failed', ms, exitCode, tail }
      } catch (err) {
        result = {
          name: step.name,
          outcome: controller.signal.aborted && failed ? 'stopped' : 'failed',
          ms: Date.now() - start,
          exitCode: null,
          tail: err instanceof Error ? err.message : String(err)
        }
      }
      if (result.outcome === 'failed' && !failed) {
        failed = true
        controller.abort()
      }
      results.set(step.name, result)
      events.onFinish?.(result)
    }
  }
  await Promise.all([...lanes.values()].map(runLane))
  const ordered = steps.map((s) => results.get(s.name)!).filter(Boolean)
  return { ok: !failed, ms: Date.now() - t0, results: ordered }
}

/** The command line a step runs: a `json` step adds vitest's JSON reporter beside the default one. */
export function stepArgs(step: Step, logDir: string): { args: string[]; jsonFile: string | null } {
  if (!step.json) return { args: step.args, jsonFile: null }
  const jsonFile = join(logDir, `${step.name}.json`)
  return { args: [...step.args, '--reporter=default', '--reporter=json', `--outputFile=${jsonFile}`], jsonFile }
}

/** What the gate reads of vitest's JSON report. */
export interface JsonReport {
  success?: boolean
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
  testResults?: { name?: string; assertionResults?: { fullName?: string; status?: string }[] }[]
}

export function readJsonReport(file: string | null): JsonReport | null {
  if (!file) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JsonReport
  } catch {
    return null
  }
}

/**
 * A step with a JSON report (vitest): the report decides when the reporter
 * died before its summary and the exit and the output disagree. An output
 * that ends in vitest's own summary stands as it is: the JSON report's
 * `success` counts failed tests alone, never an unhandled error, so a run
 * that printed "Errors 1 error" keeps its exit 1. On the box (2026-10-27) `vitest run` exited
 * 1 with nothing printed while the same files passed under another reporter
 * or pool: a report saying every test passed makes the step pass and the
 * tail say so; a report with failures names them when the output did not;
 * no report and no output names the one cause that leaves both empty, the
 * workers never started (the host's pids cap). A green exit is itself.
 */
export function judgeReport(exitCode: number | null, tail: string, report: JsonReport | null): { exitCode: number | null; tail: string } {
  if (exitCode === 0) return { exitCode, tail }
  // The reporter lived to print its summary: the exit is vitest's own word
  // (failed tests, or an unhandled error the JSON report does not count).
  if (/\bTest Files\b/.test(tail)) return { exitCode, tail }
  if (report?.success === true) {
    const n = report.numPassedTests ?? report.numTotalTests ?? 0
    const note = `vitest exited ${exitCode ?? 'by signal'} after the tests ran; its JSON report says all ${n} passed, so the step passes`
    return { exitCode: 0, tail: tail.trim() ? `${tail}\n${note}` : note }
  }
  if (report?.success === false) {
    if (tail.trim()) return { exitCode, tail }
    const failed = (report.testResults ?? []).flatMap((f) =>
      (f.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => `FAIL ${f.name ?? ''} > ${a.fullName ?? ''}`)
    )
    return { exitCode, tail: [`vitest printed nothing; its JSON report lists ${report.numFailedTests ?? failed.length} failed`, ...failed.slice(0, 20)].join('\n') }
  }
  if (!tail.trim()) return { exitCode: exitCode ?? 1, tail: 'vitest printed nothing and wrote no report: its workers never started (the host at its pids cap, or the pool could not spawn)' }
  return { exitCode, tail }
}

/** Spawns one step, streams its output to a log file (and stdout when verbose), keeps the tail. */
export function spawnStep(opts: { repo: string; logDir: string; verbose: boolean; tailLines?: number }): RunOne {
  const tailLines = opts.tailLines ?? 60
  return (step, signal) =>
    new Promise((resolvePromise) => {
      mkdirSync(opts.logDir, { recursive: true })
      const logFile = join(opts.logDir, `${step.name}.log`)
      const { args, jsonFile } = stepArgs(step, opts.logDir)
      if (jsonFile) rmSync(jsonFile, { force: true })
      writeFileSync(logFile, `$ ${step.cmd} ${args.join(' ')}\n`)
      // Its own process group, so stopping a step stops what it spawned
      // (bun run → npm → tsc) and not just the first process.
      const child = spawn(step.cmd, args, {
        cwd: opts.repo,
        env: { ...plainEnv(), ...step.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })
      const kill = (sig: NodeJS.Signals): void => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig)
          else child.kill(sig)
        } catch {
          /* already gone */
        }
      }
      const lines: string[] = []
      let partial = ''
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString()
        appendFileSync(logFile, text)
        if (opts.verbose) for (const l of text.split('\n').filter(Boolean)) process.stdout.write(`[${step.name}] ${l}\n`)
        partial += text
        const parts = partial.split('\n')
        partial = parts.pop() ?? ''
        lines.push(...parts)
        if (lines.length > tailLines) lines.splice(0, lines.length - tailLines)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      const onAbort = (): void => {
        kill('SIGTERM')
        setTimeout(() => kill('SIGKILL'), 5000).unref()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise({ exitCode: null, tail: `${err.message}\n(log: ${logFile})` })
      })
      child.on('close', (code, sig) => {
        signal.removeEventListener('abort', onAbort)
        if (partial) lines.push(partial)
        const judged = judgeReport(code ?? (sig ? 1 : null), lines.slice(-tailLines).join('\n'), readJsonReport(jsonFile))
        resolvePromise({ exitCode: judged.exitCode, tail: `${judged.tail}\n(full log: ${logFile})` })
      })
    })
}

// ---------------------------------------------------------------- reporting

export function fmtMs(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
}

const MARK: Record<Outcome, string> = { passed: '✓', failed: '✗', stopped: '■', 'not run': '·', skipped: '–' }

/** The per-step table and, on failure, the failed step's log tail. */
export function formatReport(report: Report): string {
  const width = Math.max(...report.results.map((r) => r.name.length), 4)
  const lines = report.results.map((r) => {
    const time = r.outcome === 'not run' || r.outcome === 'skipped' ? '' : fmtMs(r.ms).padStart(6)
    const note = r.note ? `  ${r.note}` : r.exitCode != null && r.outcome !== 'passed' ? `  exit ${r.exitCode}` : ''
    return `  ${MARK[r.outcome]} ${r.name.padEnd(width)} ${time.padStart(6)}  ${r.outcome}${note}`
  })
  const failed = report.results.filter((r) => r.outcome === 'failed')
  for (const r of failed) {
    if (r.tail) lines.push('', `--- ${r.name} (last lines) ---`, r.tail, `--- end ${r.name} ---`)
  }
  lines.push('', `${report.ok ? 'gate passed' : `gate failed: ${failed.map((r) => r.name).join(', ')}`} in ${fmtMs(report.ms)}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- the CLI

export interface GateOptions {
  repo: string
  tiers: Set<Tier>
  since?: string
  full: boolean
  only?: string[]
  skip?: string[]
  verbose: boolean
}

export function parseArgs(argv: string[]): Omit<GateOptions, 'repo'> {
  const opts: Omit<GateOptions, 'repo'> = { tiers: parseTier(undefined), full: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--tier') opts.tiers = parseTier(value())
    else if (a.startsWith('--tier=')) opts.tiers = parseTier(a.slice(7))
    else if (a === '--since') opts.since = value()
    else if (a.startsWith('--since=')) opts.since = a.slice(8)
    else if (a === '--full') opts.full = true
    else if (a === '--verbose' || a === '-v') opts.verbose = true
    else if (a === '--only') opts.only = value().split(',').filter(Boolean)
    else if (a === '--skip') opts.skip = value().split(',').filter(Boolean)
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: bun run gate [--tier commit|publish|all] [--since <ref>] [--full] [--only a,b] [--skip a,b] [--verbose]'
      )
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  return opts
}

const stamp = (): string => new Date().toTimeString().slice(0, 8)

export async function gate(opts: GateOptions): Promise<Report> {
  const tiers = new Set(opts.tiers)
  if (opts.since) {
    const changed = changedPathsSince(opts.repo, opts.since)
    for (const [tier, hits] of tiersForPaths(changed)) {
      if (tiers.has(tier)) continue
      tiers.add(tier)
      console.log(`${stamp()} + ${tier} tier: ${hits.length === 1 ? hits[0] : `${hits[0]} and ${hits.length - 1} more`} changed since ${opts.since}`)
    }
  }
  const steps = selectSteps({ tiers, only: opts.only, skip: opts.skip })
  const dir = gateDir(opts.repo)
  const skipped = macOnlySkips(steps)
  let hash: string | undefined
  const hashStep = steps.find((s) => s.hashSkip)
  if (hashStep) {
    hash = typecheckHash(opts.repo)
    if (shouldSkipTypecheck({ full: opts.full, hash, stored: readStoredHash(dir) })) {
      skipped.set(hashStep.name, 'no .ts/.tsx/.json change since the last green run (--full to force)')
    }
  }
  console.log(`${stamp()} gate: ${[...tiers].join('+')} tier${tiers.size > 1 ? 's' : ''}, ${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps.map((s) => s.name).join(', ')}`)
  const tty = Boolean(process.stdout.isTTY) && !opts.verbose
  const running = new Map<string, number>()
  let ticker: NodeJS.Timeout | undefined
  const clear = (): void => {
    if (tty) process.stdout.write('\x1b[2K\r')
  }
  const draw = (): void => {
    if (!tty || running.size === 0) return
    const now = Date.now()
    clear()
    process.stdout.write(`› running: ${[...running].map(([n, t]) => `${n} ${fmtMs(now - t)}`).join(' · ')}`)
  }
  if (tty) ticker = setInterval(draw, 1000)
  const report = await runSteps(
    steps,
    spawnStep({ repo: opts.repo, logDir: join(dir, 'logs'), verbose: opts.verbose }),
    {
      onStart: (step) => {
        running.set(step.name, Date.now())
        if (!tty) console.log(`${stamp()} › ${step.name}`)
        draw()
      },
      onFinish: (r) => {
        running.delete(r.name)
        clear()
        const time = r.outcome === 'not run' || r.outcome === 'skipped' ? '' : ` ${fmtMs(r.ms)}`
        console.log(`${stamp()} ${MARK[r.outcome]} ${r.name}${time} ${r.outcome}${r.note ? `: ${r.note}` : ''}`)
        draw()
      }
    },
    skipped
  )
  if (ticker) clearInterval(ticker)
  clear()
  console.log(formatReport(report))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'last-run.json'),
    JSON.stringify({ at: new Date().toISOString(), tiers: [...tiers], ok: report.ok, ms: report.ms, steps: report.results.map(({ tail: _t, ...r }) => r) }, null, 2) + '\n'
  )
  if (report.ok && hash && hashStep && (report.results.find((r) => r.name === hashStep.name)?.outcome === 'passed')) {
    storeHash(dir, hash)
  }
  return report
}

if (import.meta.main) {
  const repo = resolve(import.meta.dir, '..')
  let opts: Omit<GateOptions, 'repo'>
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
  gate({ repo, ...opts }).then(
    (report) => process.exit(report.ok ? 0 : 1),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(2)
    }
  )
}
