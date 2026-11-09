/**
 * The computer task benchmark's judge (scripts/e2e-computer-bench.ts;
 * docs/computer-protocol.md "The benchmark"). What a run records, the step
 * line parser, the per-task summaries, BENCH_RULE over them against the
 * baseline in the gate dir, and the report's table. Pure but for the
 * baseline's read and write.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  COMPUTER_ACTION_NAMES,
  NO_INPUT_ACTIONS,
  type ComputerActionName,
  type InputVia,
  type StepEffect,
  type Tier
} from '../../src/shared/computer/protocol'
import { EFFECT_WORDS, NOT_EXECUTED_LINE, STEP_SEPARATOR } from '../../src/shared/computer/tools'
import type { Verdict } from './soakJudge'

// ── what a run records ──────────────────────────────────────────────────

export type BenchProvider = 'claude' | 'codex' | 'muse'
export type BenchMode = 'gate' | 'report-only' | 'hand' | 'reference'

/** One step line of a call's result, read back (parseStepLine). */
export interface BenchStep {
  /** null for the batch's "Not executed" line, which names no action */
  action: ComputerActionName | null
  /** null for a step that sends no input, or a `type` whose line names how it went in */
  tier: Tier | null
  /** how a `type` went in, said in the tier's place */
  via?: InputVia
  effect?: StepEffect
  ok: boolean
  error?: string
}

export interface BenchCall {
  /** computer_act, computer_left_click, … */
  tool: string
  /** the rig's wrapper: entering ComputerSessions.run to its outcome, the thread's queue wait inside; null for a call refused before it reached the host */
  hostMs: number | null
  /** tool-call row to tool-result row: the harness's path included */
  rowMs: number | null
  steps: BenchStep[]
  /** observe's `screenshot: true`, or a screenshot or zoom step */
  screenshotAsked: boolean
  /** pictures the result carried, asked or thin-tree */
  shots: number
  isError: boolean
}

export interface BenchRun {
  model: string
  provider: BenchProvider
  task: string
  taskVersion: number
  /** 1-based: a gate run's reruns are 2 and 3, a hand run's `--runs n` 1 to n */
  attempt: number
  outcome: 'passed' | 'failed' | 'skipped'
  /** the check's detail, `off-route: Bash`, `over budget: 9 calls of 6`, `timed out`, `took the front`, a skip's line */
  reason?: string
  /** the task's budget of computer calls when it ran */
  stepBudget: number
  queuedMs: number
  /** the first `running` to the last settle */
  wallMs: number
  /** send → first call, each result row → the next call row, the last result → the settle */
  thinkMs: number
  calls: BenchCall[]
  /** tool calls that are no computer tool and none of ALLOWED_TOOLS */
  otherTools: string[]
  cards: { kind: string | null; title: string }[]
  tokens?: { input: number; output: number }
  /** the front app before and after; `benchInFront` when one of the bench's scratch apps was left in front */
  front: { before: string; after: string; bounced: boolean; personActive: boolean; benchInFront: boolean }
}

export interface BenchReport {
  version: 1
  startedAt: number
  endedAt: number
  commit: string
  clean: boolean
  mode: BenchMode
  /** run with TC_BENCH_UNGATED=1: no idle wait, by the person's leave */
  ungated?: boolean
  host: { macos: string; chip: string; load1: number }
  models: { model: string; skipped?: string }[]
  runs: BenchRun[]
  /** gate tasks a lane never reached: the bench's own budget ran out, or the scheduler held its runs */
  unrun: { model: string; task: string; cause: 'budget' | 'scheduler' }[]
}

// ── the rule ────────────────────────────────────────────────────────────

export const BENCH_RULE = {
  name: 'computer-bench',
  /** median computer calls per task may reach max(1.5 × base, base + 2) */
  calls: { ratio: 1.5, plus: 2 },
  /** median host ms per call may reach max(1.3 × base, base + 150) */
  hostMs: { ratio: 1.3, plus: 150 },
  /** a breach on the first run earns two more */
  reruns: 2,
  /** with reruns, the end state must pass in 2 of 3 */
  passOf: 2
} as const
export type BenchRule = typeof BENCH_RULE

export const BENCH_TIMING = {
  /** the script's own deadline: one minute inside the gate's cap to report and clean up */
  budgetMs: 14 * 60_000,
  /** a run still queued past it is skipped with the scheduler's line */
  queueSkipMs: 5 * 60_000,
  /** a scratch app launches only after this long with no input */
  launchQuietMs: 5_000,
  /** the hand run's session tier: the Mac idle at least this long */
  idleSessionS: 120
} as const

/** Tool calls a run may make beside the computer tools without going off route; `Reminder` is Muse's own reminder child session (museProtocol.ts `reminderChild`), the harness's, not the model's. */
export const ALLOWED_TOOLS: readonly string[] = ['ToolSearch', 'update_notes', 'TodoWrite', 'update_plan', 'Reminder']

/** `mcp__app__computer_act` or `app.computer_act` → `computer_act`. */
export const bareToolName = (name: string): string => name.replace(/^.*(?:__|\.)/, '')

export function toolKind(name: string): 'computer' | 'allowed' | 'other' {
  const bare = bareToolName(name)
  if (bare.startsWith('computer_')) return 'computer'
  return ALLOWED_TOOLS.includes(bare) ? 'allowed' : 'other'
}

/** What fails a run whatever its check said: off route, over its budget, the front taken. */
export function runFault(run: Pick<BenchRun, 'otherTools' | 'calls' | 'stepBudget' | 'front'>): string | null {
  if (run.otherTools.length) return `off-route: ${[...new Set(run.otherTools.map(bareToolName))].join(', ')}`
  if (run.calls.length > run.stepBudget) return `over budget: ${run.calls.length} calls of ${run.stepBudget}`
  if (tookFront(run.front)) return 'took the front'
  return null
}

export const tookFront = (front: BenchRun['front']): boolean => front.benchInFront

const runPassed = (run: BenchRun): boolean => run.outcome === 'passed' && runFault(run) === null

// ── the step lines ──────────────────────────────────────────────────────

const TIERS: readonly string[] = ['ax', 'process', 'session']
const VIAS: readonly string[] = ['ax-insert', 'ax-value', 'keys', 'paste']
const EFFECTS = new Map(Object.entries(EFFECT_WORDS).map(([effect, words]) => [words, effect as StepEffect]))
const FAILED = `${STEP_SEPARATOR}failed: `
/** The host's line for a step the session tier's gate refused (hostErrors.ts `session_refused`). */
export const SESSION_REFUSED_PREFIX = 'needs the session tier'

const actionOf = (head: string): ComputerActionName | null => {
  const word = head.split(' ', 1)[0]
  return (COMPUTER_ACTION_NAMES as readonly string[]).includes(word) ? (word as ComputerActionName) : null
}

/**
 * One step line back into its facts: the inverse of formatStepLine in
 * src/shared/computer/tools.ts (the verb and its target, the tier or the way
 * `type` went in, what the service saw; `failed: …`; the batch's "Not
 * executed" line). Null for a line in no shape it knows.
 */
export function parseStepLine(line: string): BenchStep | null {
  if (line === NOT_EXECUTED_LINE) return { action: null, tier: null, ok: false, error: 'not run' }
  const failedAt = line.indexOf(FAILED)
  if (failedAt > 0) {
    const action = actionOf(line.slice(0, failedAt))
    return action ? { action, tier: null, ok: false, error: line.slice(failedAt + FAILED.length) } : null
  }
  const action = actionOf(line)
  if (!action) return null
  if (NO_INPUT_ACTIONS.includes(action)) return { action, tier: null, ok: true }
  // The target may hold the separator inside its quotes: read from the end.
  const parts = line.split(STEP_SEPARATOR)
  if (parts.length < 3) return null
  const effect = EFFECTS.get(parts[parts.length - 1])
  const how = parts[parts.length - 2]
  if (!effect) return null
  if (TIERS.includes(how)) return { action, tier: how as Tier, effect, ok: true }
  if (VIAS.includes(how)) return { action, tier: how.startsWith('ax-') ? 'ax' : null, via: how as InputVia, effect, ok: true }
  if (how === 'no tier') return { action, tier: null, effect, ok: true }
  return null
}

const UNPARSED = 'unparsed: '

/** A call's step lines as the report keeps them; a line in no known shape is kept as an unparsed failure. */
export const stepsOf = (lines: readonly string[]): BenchStep[] =>
  lines.map((line) => parseStepLine(line) ?? { action: null, tier: null, ok: false, error: UNPARSED + line })

export const isSessionRefusal = (s: BenchStep): boolean => !s.ok && (s.error ?? '').startsWith(SESSION_REFUSED_PREFIX)

// ── summaries ───────────────────────────────────────────────────────────

const nums = (xs: (number | null | undefined)[]): number[] => xs.filter((x): x is number => typeof x === 'number')

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** A run's median host ms per computer call; null with no calls. */
export const runHostMs = (run: BenchRun): number | null => median(nums(run.calls.map((c) => c.hostMs)))

/** Runs that must pass their end state: 1 of 1, 2 of 3. */
export const passNeed = (runs: number, rule: BenchRule = BENCH_RULE): number =>
  runs <= 1 ? runs : Math.ceil((runs * rule.passOf) / (1 + rule.reruns))

export interface TaskSummary {
  model: string
  provider: BenchProvider
  task: string
  taskVersion: number
  /** runs that ran (skips left out) */
  runs: number
  passed: number
  /** the skip's line when every run of the task was skipped */
  skipped: string | null
  callsMedian: number | null
  /** the median of each run's median host ms per call */
  hostMsMedian: number | null
  wallMsMedian: number | null
  thinkMsMedian: number | null
  queuedMsMedian: number | null
  shotsAskedMedian: number | null
  shotsTakenMedian: number | null
  tokensMedian: { input: number; output: number } | null
  /** steps by the tier they ran at, or the way `type` went in when its line names no tier */
  tiers: Record<string, number>
  /** the failed runs' reasons, in run order */
  reasons: string[]
  tookFront: number
  sessionRefused: number
  /** step lines in no shape parseStepLine knows */
  unparsed: number
}

/** One summary per model, task and task version, in the order the runs came. */
export function summarize(runs: readonly BenchRun[]): TaskSummary[] {
  const groups = new Map<string, BenchRun[]>()
  for (const r of runs) {
    const key = `${r.model}\0${r.task}\0${r.taskVersion}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups.values()].map((group) => {
    const ran = group.filter((r) => r.outcome !== 'skipped')
    const steps = ran.flatMap((r) => r.calls.flatMap((c) => c.steps))
    const tiers: Record<string, number> = {}
    for (const s of steps) {
      const k = s.tier ?? s.via
      if (k && s.ok) tiers[k] = (tiers[k] ?? 0) + 1
    }
    const withTokens = ran.filter((r) => r.tokens)
    return {
      model: group[0].model,
      provider: group[0].provider,
      task: group[0].task,
      taskVersion: group[0].taskVersion,
      runs: ran.length,
      passed: ran.filter(runPassed).length,
      skipped: ran.length ? null : (group[0].reason ?? 'skipped'),
      callsMedian: median(ran.map((r) => r.calls.length)),
      hostMsMedian: median(nums(ran.map(runHostMs))),
      wallMsMedian: median(ran.map((r) => r.wallMs)),
      thinkMsMedian: median(ran.map((r) => r.thinkMs)),
      queuedMsMedian: median(ran.map((r) => r.queuedMs)),
      shotsAskedMedian: median(ran.map((r) => r.calls.filter((c) => c.screenshotAsked).length)),
      shotsTakenMedian: median(ran.map((r) => r.calls.reduce((n, c) => n + c.shots, 0))),
      tokensMedian: withTokens.length
        ? { input: median(withTokens.map((r) => r.tokens!.input))!, output: median(withTokens.map((r) => r.tokens!.output))! }
        : null,
      tiers,
      reasons: ran.filter((r) => !runPassed(r)).map((r) => runFault(r) ?? r.reason ?? 'failed'),
      tookFront: ran.filter((r) => tookFront(r.front)).length,
      sessionRefused: steps.filter(isSessionRefusal).length,
      unparsed: steps.filter((s) => (s.error ?? '').startsWith(UNPARSED)).length
    }
  })
}

// ── the baseline ────────────────────────────────────────────────────────

const BaselineRowSchema = z.object({
  model: z.string().min(1),
  task: z.string().min(1),
  taskVersion: z.number().int(),
  callsMedian: z.number().nonnegative(),
  hostMsMedian: z.number().nonnegative(),
  /** shown beside the run's, never judged */
  wallMsMedian: z.number().nonnegative(),
  thinkMsMedian: z.number().nonnegative(),
  commit: z.string(),
  at: z.number()
})
const BaselineSchema = z.object({ version: z.literal(1), rows: z.array(BaselineRowSchema) })
export type BaselineRow = z.infer<typeof BaselineRowSchema>
export type Baseline = z.infer<typeof BaselineSchema>

export const EMPTY_BASELINE: Baseline = { version: 1, rows: [] }

/** `<gateDir>/computer-bench/baseline.json`, in the checkout that publishes. */
export const baselinePath = (gateDir: string): string => join(gateDir, 'computer-bench', 'baseline.json')

/**
 * A missing file reads as no rows. One that exists but cannot be read or
 * parsed throws, naming the path and `--rebaseline`: a broken file never lets
 * a regression through, nor is it overwritten unasked.
 */
export function readBaseline(path: string): Baseline {
  if (!existsSync(path)) return EMPTY_BASELINE
  let why: string
  try {
    const parsed = BaselineSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data
    why = parsed.error.issues[0]?.message ?? 'not a baseline'
  } catch (err) {
    why = err instanceof Error ? err.message : String(err)
  }
  throw new Error(`the computer bench's baseline ${path} cannot be read (${why}); fix it, or run the bench with --rebaseline to write it anew`)
}

/** Written beside its place and renamed in, in the gate dir, so it never dirties the tree. */
export function writeBaseline(path: string, b: Baseline): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(b, null, 2) + '\n')
  renameSync(tmp, path)
}

export const findBase = (b: Baseline, model: string, task: string, taskVersion: number): BaselineRow | null =>
  b.rows.find((r) => r.model === model && r.task === task && r.taskVersion === taskVersion) ?? null

/**
 * A gate run adds the rows it lacks from tasks whose end state passed;
 * `replace` (`--rebaseline`) replaces the rows of every task that passed. A
 * report-only or reference run never writes, nor a hand run unless asked to
 * replace. Rows are keyed by model, task and task version.
 */
export function mergeBaseline(b: Baseline, report: BenchReport, opts: { replace: boolean }, rule: BenchRule = BENCH_RULE): Baseline {
  if (report.mode === 'report-only' || report.mode === 'reference') return b
  if (report.mode === 'hand' && !opts.replace) return b
  const rows = [...b.rows]
  for (const s of summarize(report.runs)) {
    if (!s.runs || s.passed < passNeed(s.runs, rule)) continue
    if (s.callsMedian === null || s.hostMsMedian === null || s.wallMsMedian === null || s.thinkMsMedian === null) continue
    const at = rows.findIndex((r) => r.model === s.model && r.task === s.task && r.taskVersion === s.taskVersion)
    if (at >= 0 && !opts.replace) continue
    const row: BaselineRow = {
      model: s.model,
      task: s.task,
      taskVersion: s.taskVersion,
      callsMedian: s.callsMedian,
      hostMsMedian: Math.round(s.hostMsMedian),
      wallMsMedian: Math.round(s.wallMsMedian),
      thinkMsMedian: Math.round(s.thinkMsMedian),
      commit: report.commit,
      at: report.endedAt
    }
    if (at >= 0) rows[at] = row
    else rows.push(row)
  }
  rows.sort((x, y) => x.model.localeCompare(y.model) || x.task.localeCompare(y.task) || x.taskVersion - y.taskVersion)
  return { version: 1, rows }
}

/** A gate run that finds no baseline at all: the person's rule of 2026-11-09, the step passes and the run writes the first rows. */
export const NO_BASELINE_LINE = 'no baseline, first run writes it'

/**
 * What a run does with its verdict: whether it fails its exit, whether it
 * writes the baseline (replacing rows with --rebaseline), and the line it
 * ends with. A gate run with no baseline rows at all passes and writes the
 * rows of the tasks that passed; after that a gate run writes the rows it
 * lacks only when green. Report-only and reference runs never fail or write.
 */
export function benchOutcome(o: { mode: BenchMode; ok: boolean; rebaseline: boolean; baselineRows: number }): { fail: boolean; write: boolean; note: string | null } {
  const judged = o.mode === 'gate' || o.mode === 'hand'
  const firstRun = o.mode === 'gate' && o.baselineRows === 0
  return {
    fail: judged && !o.ok && !firstRun,
    write: (o.mode === 'gate' && (o.ok || firstRun)) || (judged && o.rebaseline),
    note: firstRun ? NO_BASELINE_LINE : null
  }
}

// ── judging ─────────────────────────────────────────────────────────────

export const callsLimit = (base: number, rule: BenchRule = BENCH_RULE): number => Math.max(rule.calls.ratio * base, base + rule.calls.plus)
export const hostMsLimit = (base: number, rule: BenchRule = BENCH_RULE): number => Math.max(rule.hostMs.ratio * base, base + rule.hostMs.plus)

const round1 = (n: number): number => Math.round(n * 10) / 10

/** True when the first run failed its end state or broke either margin: the lane runs the task twice more. */
export function needsRerun(first: BenchRun, base: BaselineRow | null, rule: BenchRule = BENCH_RULE): boolean {
  if (first.outcome === 'skipped') return false
  if (!runPassed(first)) return true
  if (!base) return false
  if (first.calls.length > callsLimit(base.callsMedian, rule)) return true
  const host = runHostMs(first)
  return host !== null && host > hostMsLimit(base.hostMsMedian, rule)
}

export interface BenchJudgement {
  ok: boolean
  verdicts: Verdict[]
  summaries: TaskSummary[]
  /** lanes and tasks left out, never failed */
  skipped: string[]
}

/**
 * Each task's end state, its median computer calls and its median host ms
 * per call against the baseline (a task with no row is judged on its end
 * state alone); wall and think time beside the baseline's, reported only. A
 * gate task the bench's own budget never reached fails, unless the scheduler
 * held the runs; a skipped lane or task never fails.
 */
export function judgeBench(report: BenchReport, baseline: Baseline, rule: BenchRule = BENCH_RULE): BenchJudgement {
  const verdicts: Verdict[] = []
  const skipped: string[] = report.models.filter((m) => m.skipped).map((m) => `${m.model}: ${m.skipped}`)
  const summaries = summarize(report.runs)
  for (const s of summaries) {
    const name = `${s.model} ${s.task}`
    if (!s.runs) {
      skipped.push(`${name}: ${s.skipped}`)
      continue
    }
    const need = passNeed(s.runs, rule)
    verdicts.push({ what: `${name}: end state, runs passed`, got: s.passed, limit: need, ok: s.passed >= need })
    if (s.tookFront) verdicts.push({ what: `${name}: runs that took the front`, got: s.tookFront, limit: 0, ok: false })
    const base = findBase(baseline, s.model, s.task, s.taskVersion)
    if (base && s.callsMedian !== null) {
      const limit = round1(callsLimit(base.callsMedian, rule))
      verdicts.push({ what: `${name}: median computer calls`, got: s.callsMedian, limit, ok: s.callsMedian <= limit })
    }
    if (base && s.hostMsMedian !== null) {
      const limit = Math.round(hostMsLimit(base.hostMsMedian, rule))
      verdicts.push({ what: `${name}: median host ms per call`, got: Math.round(s.hostMsMedian), limit, ok: s.hostMsMedian <= limit })
    }
    // Beside the baseline's, reported only; with no row the table already says them.
    if (base && s.wallMsMedian !== null) {
      const got = round1(s.wallMsMedian / 1000)
      const limit = round1(base.wallMsMedian / 1000)
      verdicts.push({ what: `${name}: median wall s`, got, limit, ok: got <= limit, reportOnly: true })
    }
    if (base && s.thinkMsMedian !== null) {
      const got = round1(s.thinkMsMedian / 1000)
      const limit = round1(base.thinkMsMedian / 1000)
      verdicts.push({ what: `${name}: median think s`, got, limit, ok: got <= limit, reportOnly: true })
    }
  }
  for (const u of report.unrun) {
    const name = `${u.model} ${u.task}`
    if (u.cause === 'scheduler') skipped.push(`${name}: not reached, the scheduler held the runs`)
    else verdicts.push({ what: `${name}: not reached before the bench's budget ran out`, got: 0, limit: 1, ok: false })
  }
  return { ok: verdicts.every((v) => v.ok || v.reportOnly), verdicts, summaries, skipped }
}

// ── the table ───────────────────────────────────────────────────────────

const cell = (n: number | null, scale = 1, digits = 0): string => (n === null ? '–' : (n / scale).toFixed(digits))
const tierCell = (tiers: Record<string, number>): string =>
  Object.entries(tiers)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ') || '–'

/** The report as markdown: per model a line per task, then the verdicts and what was skipped. */
export function renderBenchTable(report: BenchReport, judged: BenchJudgement): string {
  const out: string[] = [
    `# Computer bench (${report.mode})`,
    '',
    `${new Date(report.startedAt).toISOString()}, ${Math.round((report.endedAt - report.startedAt) / 1000)} s, commit ${report.commit.slice(0, 8)}${report.clean ? '' : ' (dirty)'}`,
    `macOS ${report.host.macos}, ${report.host.chip}, load ${report.host.load1.toFixed(1)}${report.ungated ? ', no idle wait (TC_BENCH_UNGATED)' : ''}`
  ]
  const models = [...new Set(judged.summaries.map((s) => s.model))]
  for (const model of models) {
    out.push(
      '',
      `## ${model}`,
      '',
      '| task | passed | calls | host ms/call | wall s | think s | queued s | shots asked | shots taken | tiers | failures |',
      '|---|---|---|---|---|---|---|---|---|---|---|'
    )
    for (const s of judged.summaries.filter((x) => x.model === model)) {
      if (!s.runs) {
        out.push(`| ${s.task} | skipped | | | | | | | | | ${s.skipped} |`)
        continue
      }
      out.push(
        `| ${s.task} | ${s.passed}/${s.runs} | ${cell(s.callsMedian, 1, s.callsMedian !== null && s.callsMedian % 1 ? 1 : 0)} | ${cell(s.hostMsMedian)} | ${cell(s.wallMsMedian, 1000, 1)} | ${cell(s.thinkMsMedian, 1000, 1)} | ${cell(s.queuedMsMedian, 1000, 1)} | ${cell(s.shotsAskedMedian)} | ${cell(s.shotsTakenMedian)} | ${tierCell(s.tiers)} | ${s.reasons.join('; ')} |`
      )
    }
  }
  out.push('', '## Verdicts', '', '| what | got | limit | |', '|---|---|---|---|')
  for (const v of judged.verdicts) out.push(`| ${v.what} | ${v.got} | ${v.limit} | ${v.ok ? 'pass' : v.reportOnly ? 'over, reported' : 'FAIL'} |`)
  if (judged.skipped.length) out.push('', '## Skipped', '', ...judged.skipped.map((s) => `- ${s}`))
  out.push('', judged.ok ? 'computer bench passed' : `computer bench failed: ${judged.verdicts.filter((v) => !v.ok && !v.reportOnly).map((v) => v.what).join('; ')}`)
  return out.join('\n') + '\n'
}
