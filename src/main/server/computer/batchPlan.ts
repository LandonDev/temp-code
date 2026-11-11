import type { BatchResult, ComputerAction, StepResult, Tier } from '@shared/computer/protocol'

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
