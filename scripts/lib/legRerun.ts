/**
 * The gate's safety net for e2e-tc-computer's legs (docs/release-gate.md "The store and computer
 * proofs"): under `--gate` a leg with a failed step runs once more from a clean launch. A rerun that
 * passes each step the first run failed makes those failures flakes, named in the report and the gate
 * log; a rerun that fails again, or skips them, is red. No bound changes: the rerun is judged by the
 * same checks.
 */

export interface LegStep {
  name: string
  outcome: 'passed' | 'failed' | 'skipped'
  why?: string
}

export interface Flake {
  leg: string
  step: string
  why: string
}

/** The line each flake prints, which the gate reads back from the step's log (`flakesInLog`). */
export const FLAKE_PREFIX = 'flake: '

/** Whether a leg's first run earns its one rerun: under --gate, a failed step, and no abort by the person. */
export const needsLegRerun = (steps: readonly LegStep[], gate: boolean, aborted: boolean): boolean =>
  gate && !aborted && steps.some((s) => s.outcome === 'failed')

/**
 * After the rerun: red when it failed a step too, or when a step the first run failed did not pass on the rerun
 * (skipped, or not reached), since a skip proves nothing; else the first run's failures as flakes.
 */
export function legRerunVerdict(leg: string, first: readonly LegStep[], second: readonly LegStep[]): { red: boolean; flakes: Flake[] } {
  const failed = first.filter((s) => s.outcome === 'failed')
  const passedAgain = new Set(second.filter((s) => s.outcome === 'passed').map((s) => s.name))
  if (second.some((s) => s.outcome === 'failed') || failed.some((s) => !passedAgain.has(s.name))) return { red: true, flakes: [] }
  return { red: false, flakes: failed.map((s) => ({ leg, step: s.name, why: s.why ?? '' })) }
}

export const flakeLine = (f: Flake): string => `${FLAKE_PREFIX}${f.leg} leg, ${f.step}: ${f.why}`

/** The flake lines a step's log holds, for the gate's summary and last-run.json. */
export const flakesInLog = (log: string): string[] =>
  log.split('\n').filter((l) => l.startsWith(FLAKE_PREFIX)).map((l) => l.slice(FLAKE_PREFIX.length))

/**
 * A proof run whose only shortfalls are checks it voided (the person's input moved the pointer or the front, the
 * window never went still, the screen went away): under --gate it runs once more at once, and a rerun that passes
 * names the voided checks as flakes. A failed check is never rerun; a rerun that voids again stays inconclusive,
 * which the gate counts as red. The preview proof's rule (e2e-computer-preview, 2026-11-11: two VOIDs while the
 * person moved the pointer during the full publish gate).
 */
export const needsVoidRerun = (o: { failed: number; voided: number; gate: boolean; rerun: boolean }): boolean =>
  o.gate && !o.rerun && o.failed === 0 && o.voided > 0
