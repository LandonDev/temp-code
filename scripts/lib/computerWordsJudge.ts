/**
 * The comparison's arms, its run order and the rule that picks the words
 * each model ships with (scripts/compare-computer-words.ts; the plan's §8).
 * Pure: the runner records runs, this decides.
 */
import type { TaskId } from './computerTasks'

export type Arm = 'A' | 'C' | 'AV' | 'CV'
export type WordsShape = 'anthropic' | 'cua'
export type ToolShape = 'act' | 'per-verb'

export const ARMS: Readonly<Record<Arm, { shape: WordsShape; tools: ToolShape }>> = {
  A: { shape: 'anthropic', tools: 'act' },
  C: { shape: 'cua', tools: 'act' },
  AV: { shape: 'anthropic', tools: 'per-verb' },
  CV: { shape: 'cua', tools: 'per-verb' }
}
export const ARM_ORDER: readonly Arm[] = ['A', 'C', 'AV', 'CV']

export interface ModelUnderTest {
  model: string
  provider: string
  /** the per-verb arms run for it (Anthropic models alone) */
  perVerb: boolean
}

export interface PlannedRun {
  model: string
  provider: string
  task: TaskId
  arm: Arm
  /** 1-based run of this task, model and arm */
  run: number
  /** every computer.tiers.* row deleted and the last thread's service session closed first */
  resetTiers: true
}

/**
 * Runs of one task interleave the arms, forward for an odd run and back for
 * an even one (A, C, AV, CV then CV, AV, C, A), so neither the order nor
 * drift in the Mac or the provider favours an arm.
 */
export function runPlan(tasks: readonly TaskId[], arms: readonly Arm[], runs: number, models: readonly ModelUnderTest[]): PlannedRun[] {
  const out: PlannedRun[] = []
  for (const m of models) {
    const own = ARM_ORDER.filter((a) => arms.includes(a) && (m.perVerb || ARMS[a].tools === 'act'))
    for (const task of tasks)
      for (let run = 1; run <= runs; run++)
        for (const arm of run % 2 === 1 ? own : [...own].reverse()) out.push({ model: m.model, provider: m.provider, task, arm, run, resetTiers: true })
  }
  return out
}

// ── what a run left ─────────────────────────────────────────────────────

export type RunStatus = 'ok' | 'failed' | 'off-route' | 'inconclusive' | 'skipped'

export interface RunRecord {
  model: string
  task: TaskId
  arm: Arm
  run: number
  status: RunStatus
  detail?: string
  /** computer tool calls */
  computerCalls: number
  /** other tool calls (tool search and update_notes do not count) */
  otherCalls: number
  steps: number
  failedSteps: number
  wallMs: number
}

/** A run that counts: not skipped, and not voided by the person using the Mac three times over. */
const counted = (r: RunRecord): boolean => r.status !== 'skipped' && r.status !== 'inconclusive'
const passed = (r: RunRecord): boolean => r.status === 'ok'

function median(xs: number[]): number {
  if (!xs.length) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export interface ArmSummary {
  arm: Arm
  runs: number
  /** tasks whose every counted run passed */
  tasksPassed: number
  calls: number
  steps: number
  failedSteps: number
  wallMs: number
}

export function summarize(runs: readonly RunRecord[], model: string, arm: Arm): ArmSummary {
  const mine = runs.filter((r) => r.model === model && r.arm === arm && counted(r))
  const tasks = [...new Set(mine.map((r) => r.task))]
  return {
    arm,
    runs: mine.length,
    tasksPassed: tasks.filter((t) => mine.filter((r) => r.task === t).every(passed)).length,
    calls: median(mine.map((r) => r.computerCalls)),
    steps: median(mine.map((r) => r.steps)),
    failedSteps: median(mine.map((r) => r.failedSteps)),
    wallMs: median(mine.map((r) => r.wallMs))
  }
}

export interface Verdict {
  /** null when a cell had no counted run */
  winner: Arm | null
  reason: string
  a: ArmSummary
  b: ArmSummary
}

/**
 * The rule, in order: more tasks passed in every run; then fewer computer
 * calls, steps and failed steps (medians; a gap under one is a tie); then
 * the shorter wall time (a gap under a tenth is a tie); all even, the
 * shorter text.
 */
export function pickWinner(runs: readonly RunRecord[], model: string, a: Arm, b: Arm, textLength: Readonly<Partial<Record<Arm, number>>>): Verdict {
  const sa = summarize(runs, model, a)
  const sb = summarize(runs, model, b)
  const verdict = (winner: Arm | null, reason: string): Verdict => ({ winner, reason, a: sa, b: sb })
  if (!sa.runs || !sb.runs) return verdict(null, `skipped: ${!sa.runs ? a : b} has no counted run`)
  if (sa.tasksPassed !== sb.tasksPassed) return verdict(sa.tasksPassed > sb.tasksPassed ? a : b, 'more tasks passed')
  for (const [key, words] of [
    ['calls', 'fewer computer calls'],
    ['steps', 'fewer steps'],
    ['failedSteps', 'fewer failed steps']
  ] as const) {
    if (Math.abs(sa[key] - sb[key]) >= 1) return verdict(sa[key] < sb[key] ? a : b, words)
  }
  if (Math.abs(sa.wallMs - sb.wallMs) >= 0.1 * Math.max(sa.wallMs, sb.wallMs)) return verdict(sa.wallMs < sb.wallMs ? a : b, 'less wall time')
  const la = textLength[a] ?? Number.POSITIVE_INFINITY
  const lb = textLength[b] ?? Number.POSITIVE_INFINITY
  return verdict(la <= lb ? a : b, 'a tie: the shorter text')
}

export interface ModelDecision {
  model: string
  words: Verdict
  /** Anthropic models alone: the winner's words with the four tools against one tool per verb */
  tools?: Verdict
  ship: { shape: WordsShape; tools: ToolShape } | null
}

/** Each model's questions: A against C, then for a per-verb model the winning words' act arm against its per-verb arm; a tie keeps the four tools. */
export function decide(runs: readonly RunRecord[], m: ModelUnderTest, textLength: Readonly<Partial<Record<Arm, number>>>): ModelDecision {
  const words = pickWinner(runs, m.model, 'A', 'C', textLength)
  if (!words.winner) return { model: m.model, words, ship: null }
  const shape = ARMS[words.winner].shape
  if (!m.perVerb) return { model: m.model, words, ship: { shape, tools: 'act' } }
  const perVerbArm: Arm = shape === 'anthropic' ? 'AV' : 'CV'
  const tools = pickWinner(runs, m.model, words.winner, perVerbArm, textLength)
  const perVerbWon = tools.winner === perVerbArm && tools.reason !== 'a tie: the shorter text'
  return { model: m.model, words, tools, ship: { shape, tools: perVerbWon ? 'per-verb' : 'act' } }
}
