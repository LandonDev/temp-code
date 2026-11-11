/**
 * The ax wait rows from measured waits (docs/computer-protocol.md §27.3), and the A/B that decides whether they are
 * kept. Pure: reads saved field or bench reports (computerBench.ts), writes nothing.
 *
 * `minMs` is the 95th percentile of the first change time over ax steps that changed; `quietMs` the upper edge of the
 * bucket in which the summed gap counts of ax steps reach 99%. A step with fewer than two changes adds no gap; with no
 * gaps at all, or the 99% in the bucket above the last edge, `quietMs` stays. `axStep` reads the steps before a call's
 * last, `axAction` the last steps of calls whose every input step went in at ax.
 */
import { COMPUTER_WAIT, WAIT_GAP_EDGES_MS, type WaitOptions } from '../../src/shared/computer/protocol'
import type { BenchReport, BenchStep } from './computerBench'

export interface AxWaitRows {
  axAction: WaitOptions
  axStep: WaitOptions
}

/** The 95th percentile by nearest rank. */
function p95(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

/** The upper edge of the bucket where the summed counts reach 99%, or undefined past the last edge or with none. */
function quietEdge(counts: number[]): number | undefined {
  const total = counts.reduce((a, b) => a + b, 0)
  if (!total) return undefined
  let sum = 0
  for (let i = 0; i < counts.length; i++) {
    sum += counts[i]
    if (sum >= total * 0.99) return WAIT_GAP_EDGES_MS[i]
  }
  return undefined
}

function rowFrom(base: WaitOptions, steps: BenchStep[]): WaitOptions {
  const first = steps.filter((s) => s.effect === 'changed' && s.wait?.firstChangeMs !== undefined).map((s) => s.wait!.firstChangeMs!)
  const gaps = new Array<number>(WAIT_GAP_EDGES_MS.length + 1).fill(0)
  for (const s of steps) s.wait?.gapCounts?.forEach((n, i) => (gaps[i] += n))
  const minMs = p95(first)
  const quietMs = quietEdge(gaps)
  return {
    ...base,
    ...(minMs !== undefined ? { minMs: Math.min(minMs, base.maxMs) } : {}),
    ...(quietMs !== undefined ? { quietMs } : {})
  }
}

/** The rows §27.3's rule sets from the reports' ax steps; a row with no data stays as it ships. */
export function axWaitRows(reports: BenchReport[]): AxWaitRows {
  const between: BenchStep[] = []
  const last: BenchStep[] = []
  for (const report of reports)
    for (const run of report.runs)
      for (const call of run.calls) {
        const input = call.steps.filter((s) => s.tier !== null)
        if (!input.length) continue
        input.slice(0, -1).forEach((s) => s.tier === 'ax' && between.push(s))
        if (input.every((s) => s.tier === 'ax')) last.push(input[input.length - 1])
      }
  return { axAction: rowFrom(COMPUTER_WAIT.axAction, last), axStep: rowFrom(COMPUTER_WAIT.axStep, between) }
}

export interface ArmTally {
  noChange: number
  calls: number
  lost: number
}

/** Per model: steps that read `no change seen`, computer calls, and runs that did not pass. */
export function armTally(reports: BenchReport[]): Map<string, ArmTally> {
  const out = new Map<string, ArmTally>()
  for (const report of reports)
    for (const run of report.runs) {
      if (run.outcome === 'skipped') continue
      const t = out.get(run.model) ?? { noChange: 0, calls: 0, lost: 0 }
      t.calls += run.calls.length
      t.noChange += run.calls.flatMap((c) => c.steps).filter((s) => s.effect === 'none').length
      if (run.outcome !== 'passed') t.lost++
      out.set(run.model, t)
    }
  return out
}

/** §27.3's bar: the new rows are kept only when no model shows a rise in no-change steps, calls or tasks lost. */
export function keepNewRows(shipped: BenchReport[], trial: BenchReport[]): { keep: boolean; lines: string[] } {
  const a = armTally(shipped)
  const b = armTally(trial)
  const lines: string[] = []
  let keep = a.size > 0
  for (const [model, before] of a) {
    const after = b.get(model)
    if (!after) {
      lines.push(`${model}: no trial runs`)
      keep = false
      continue
    }
    const rose = (['noChange', 'calls', 'lost'] as const).filter((k) => after[k] > before[k])
    lines.push(`${model}: no change ${before.noChange} → ${after.noChange}, calls ${before.calls} → ${after.calls}, lost ${before.lost} → ${after.lost}${rose.length ? ` (rose: ${rose.join(', ')})` : ''}`)
    if (rose.length) keep = false
  }
  return { keep, lines }
}
