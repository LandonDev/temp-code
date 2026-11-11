import { describe, expect, it } from 'vitest'
import { COMPUTER_WAIT } from '../../src/shared/computer/protocol'
import { axWaitRows, keepNewRows } from './axWaitRule'
import type { BenchCall, BenchReport, BenchRun, BenchStep } from './computerBench'

const step = (tier: BenchStep['tier'], firstChangeMs?: number, gapCounts?: number[], effect: BenchStep['effect'] = 'changed'): BenchStep => ({
  action: 'left_click',
  tier,
  effect,
  ok: true,
  wait: { waitedMs: 500, reason: 'quiet', ...(firstChangeMs !== undefined ? { firstChangeMs } : {}), ...(gapCounts ? { gapCounts } : {}) }
})
const call = (steps: BenchStep[]): BenchCall => ({ tool: 'computer_batch', hostMs: 1, rowMs: 1, steps, screenshotAsked: false, shots: 0, isError: false })
const run = (model: string, calls: BenchCall[], outcome: BenchRun['outcome'] = 'passed'): BenchRun =>
  ({ model, provider: 'claude', task: 't', taskVersion: 1, attempt: 1, outcome, stepBudget: 9, queuedMs: 0, wallMs: 1, thinkMs: 1, calls, otherTools: [], cards: [], front: { before: '', after: '', bounced: false, personActive: false, benchInFront: false } }) as BenchRun
const report = (runs: BenchRun[]): BenchReport => ({ runs }) as unknown as BenchReport
const gaps = (bucket: number, n: number): number[] => Array.from({ length: 11 }, (_, i) => (i === bucket ? n : 0))

describe('§27.3: the ax rows from measured waits', () => {
  it('stays as shipped with no ax data', () => {
    expect(axWaitRows([report([run('m', [call([step('process', 90, gaps(3, 5))])])])])).toEqual({ axAction: COMPUTER_WAIT.axAction, axStep: COMPUTER_WAIT.axStep })
  })

  it('takes the 95th percentile of first changes and the 99% gap edge, steps between apart from the last', () => {
    const firsts = Array.from({ length: 20 }, (_, i) => (i + 1) * 10)
    const calls = firsts.map((f) => call([step('ax', f, gaps(1, 4)), step('ax', f / 2, gaps(0, 4))]))
    const rows = axWaitRows([report([run('m', calls)])])
    expect(rows.axStep).toEqual({ ...COMPUTER_WAIT.axStep, minMs: 190, quietMs: 50 })
    expect(rows.axAction).toEqual({ ...COMPUTER_WAIT.axAction, minMs: 95, quietMs: 25 })
  })

  it('leaves quietMs when the 99% lies above the last edge, and counts only changed steps for minMs', () => {
    const rows = axWaitRows([report([run('m', [call([step('ax', 30, gaps(10, 3)), step('ax', 999, undefined, 'none')])])])])
    expect(rows.axStep).toEqual({ ...COMPUTER_WAIT.axStep, minMs: 30 })
    expect(rows.axAction).toEqual(COMPUTER_WAIT.axAction)
  })

  it('reads axAction only from calls whose every input step went in at ax', () => {
    const rows = axWaitRows([report([run('m', [call([step('process', 10), step('ax', 40, gaps(2, 2))])])])])
    expect(rows.axAction).toEqual(COMPUTER_WAIT.axAction)
  })
})

describe('§27.3: the A/B keeps new rows only when nothing rose', () => {
  const arm = (noChange: number, calls: number, lost: boolean): BenchReport =>
    report([run('opus', Array.from({ length: calls }, (_, i) => call([step('ax', 10, undefined, i < noChange ? 'none' : 'changed')])), lost ? 'failed' : 'passed')])

  it('keeps rows that cut calls with no rise', () => {
    expect(keepNewRows([arm(2, 5, false)], [arm(1, 4, false)]).keep).toBe(true)
  })

  it('refuses a rise in no-change steps, in calls or in tasks lost', () => {
    expect(keepNewRows([arm(1, 4, false)], [arm(2, 4, false)])).toMatchObject({ keep: false })
    expect(keepNewRows([arm(1, 4, false)], [arm(1, 5, false)]).keep).toBe(false)
    expect(keepNewRows([arm(1, 4, false)], [arm(1, 4, true)]).lines[0]).toContain('rose: lost')
  })

  it('refuses when a model has no trial runs', () => {
    expect(keepNewRows([arm(1, 4, false)], []).keep).toBe(false)
  })
})
