import { z } from 'zod'
import { lastInputEffect, stopsHere } from '@shared/computer/batchStop'
import {
  COMPUTER_WAIT,
  NO_INPUT_ACTIONS,
  WaitOptionsSchema,
  type BatchResult,
  type ComputerAction,
  type StepResult,
  type Tier,
  type WaitOptions
} from '@shared/computer/protocol'

/**
 * `action.batch` takes one `tiers` list for every step. When the steps'
 * lists differ (a class whose verdict is `session` and the gate admitted it,
 * or a retry), the host splits the batch into segments of equal lists, with
 * no change to the wire: every segment but the last reads nothing, and the
 * last carries the call's observation.
 */

export interface BatchSegment {
  /** the index of the segment's first step in the call */
  from: number
  actions: ComputerAction[]
  tiers: Tier[]
  last: boolean
  /** The read’s focus belongs to the first segment alone. */
  expectFocus?: number
}

const sameTiers = (a: Tier[], b: Tier[]): boolean => a.length === b.length && a.every((t, i) => t === b[i])

/** Consecutive steps with equal tier lists form one segment. */
export function planBatch(actions: ComputerAction[], tiersOf: (a: ComputerAction, i: number) => Tier[], expectFocus?: number): BatchSegment[] {
  const segments: BatchSegment[] = []
  actions.forEach((action, i) => {
    const tiers = tiersOf(action, i)
    const open = segments[segments.length - 1]
    if (open && sameTiers(open.tiers, tiers)) open.actions.push(action)
    else segments.push({ from: i, actions: [action], tiers, last: false, ...(i === 0 && expectFocus !== undefined ? { expectFocus } : {}) })
  })
  if (segments.length) segments[segments.length - 1].last = true
  return segments
}

/**
 * The segments' results as one BatchResult: steps renumbered from 0, every
 * step after the first failure `not-run`, the observation and wait of the
 * last segment that ran. A segment that never ran (null) is all `not-run`.
 */
export function mergeBatch(segments: BatchSegment[], results: (BatchResult | null)[]): BatchResult {
  const steps: StepResult[] = []
  let failed = false
  let closing: BatchResult | null = null
  segments.forEach((seg, s) => {
    const r = results[s] ?? null
    if (r) closing = r
    seg.actions.forEach((action, k) => {
      const index = seg.from + k
      const got = r?.steps[k]
      if (failed || !got) steps.push({ index, action: action.action, status: 'not-run' })
      else {
        steps.push({ ...got, index })
        if (got.status === 'failed') failed = true
      }
    })
  })
  const last = closing as BatchResult | null
  return {
    steps,
    ...(last?.observation ? { observation: last.observation } : {}),
    ...(last?.observationError ? { observationError: last.observationError } : {}),
    waited: last?.waited ?? { waitedMs: 0, settled: true, busy: false, reason: 'skipped' }
  }
}

/** A non-final segment failed: its batch ends there and the host reads the window once for the closing observation. */
export function needsClosingRead(segments: BatchSegment[], results: (BatchResult | null)[]): boolean {
  const ran = results.reduce((n, r, i) => (r ? i : n), -1)
  if (ran < 0 || segments[ran].last) return false
  return results[ran]!.steps.some((s) => s.status === 'failed')
}

/**
 * §27.8 at a segment boundary: the step at `at` types blind and the call's last step that sent input changed nothing.
 * Answers that step's index, or null when the step at `at` runs. `steps` are the call's, numbered as `actions`.
 */
export function stoppedBefore(actions: readonly ComputerAction[], steps: readonly StepResult[], at: number): number | null {
  const ran = steps.slice(0, at)
  if (!stopsHere(lastInputEffect(actions, ran), actions[at])) return null
  for (let i = at - 1; i >= 0; i--) if (ran[i].status === 'ok' && !NO_INPUT_ACTIONS.includes(actions[i].action)) return i
  return null
}

export interface AxWaitRows {
  axAction: WaitOptions
  axStep: WaitOptions
}

const AxWaitRowsSchema = z.object({ axAction: WaitOptionsSchema.optional(), axStep: WaitOptionsSchema.optional() }).strict()

/**
 * The ax wait rows every acting request carries (§27.3). `TEMP_CODE_COMPUTER_WAIT_AX` (JSON, either row or both) runs
 * the A/B's other arm, only on an isolated instance (TEMP_CODE_USER_DATA set); a value off the schema is ignored.
 */
export function computerAxWaits(env: Record<string, string | undefined> = process.env): AxWaitRows {
  const rows: AxWaitRows = { axAction: COMPUTER_WAIT.axAction, axStep: COMPUTER_WAIT.axStep }
  const raw = env.TEMP_CODE_COMPUTER_WAIT_AX
  if (!raw || !env.TEMP_CODE_USER_DATA) return rows
  try {
    const parsed = AxWaitRowsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? { ...rows, ...parsed.data } : rows
  } catch {
    return rows
  }
}
