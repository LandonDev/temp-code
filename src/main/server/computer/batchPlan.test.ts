import { describe, expect, it } from 'vitest'
import type { BatchResult, ComputerAction, Observation, StepResult, Tier } from '@shared/computer/protocol'
import { mergeBatch, needsClosingRead, planBatch } from './batchPlan'

const A = (action: ComputerAction['action']): ComputerAction => ({ action }) as ComputerAction
const ok = (index: number, action: ComputerAction['action']): StepResult => ({ index, action, status: 'ok', tier: 'process', effect: 'changed' })
const waited = { waitedMs: 5, settled: true, busy: false, reason: 'quiet' as const }
const obs = { kind: 'diff', seq: 3 } as unknown as Observation

describe('planBatch', () => {
  it('equal lists make one segment', () => {
    const segs = planBatch([A('left_click'), A('type'), A('key')], () => ['ax', 'process'])
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ from: 0, last: true, tiers: ['ax', 'process'] })
    expect(segs[0]).not.toHaveProperty('expectFocus')
  })
  it('splits at every change of list', () => {
    const lists: Tier[][] = [['ax', 'process'], ['ax', 'process'], ['ax', 'process', 'session'], ['ax', 'process']]
    const segs = planBatch([A('left_click'), A('type'), A('hold_key'), A('key')], (_, i) => lists[i], 9)
    expect(segs.map((s) => s.expectFocus)).toEqual([9, undefined, undefined])
    expect(segs.map((s) => [s.from, s.actions.length, s.last])).toEqual([
      [0, 2, false],
      [2, 1, false],
      [3, 1, true]
    ])
  })
})

describe('mergeBatch', () => {
  const segs = planBatch([A('left_click'), A('type'), A('hold_key'), A('key')], (_, i) => (i === 2 ? ['ax', 'session'] : ['ax', 'process']))
  it('renumbers the steps and takes the last segment observation', () => {
    const r1: BatchResult = { steps: [ok(0, 'left_click'), ok(1, 'type')], waited }
    const r2: BatchResult = { steps: [ok(0, 'hold_key')], waited }
    const r3: BatchResult = { steps: [ok(0, 'key')], observation: obs, waited }
    const merged = mergeBatch(segs, [r1, r2, r3])
    expect(merged.steps.map((s) => [s.index, s.action, s.status])).toEqual([
      [0, 'left_click', 'ok'],
      [1, 'type', 'ok'],
      [2, 'hold_key', 'ok'],
      [3, 'key', 'ok']
    ])
    expect(merged.observation).toBe(obs)
  })
  it('ends at the first failure: the rest are not-run, and a closing read is due', () => {
    const failed: StepResult = { index: 0, action: 'hold_key', status: 'failed', error: { kind: 'needs_tier', message: 'needs session', needed: 'session' } }
    const r1: BatchResult = { steps: [ok(0, 'left_click'), ok(1, 'type')], waited }
    const r2: BatchResult = { steps: [failed], waited }
    const results = [r1, r2, null]
    const merged = mergeBatch(segs, results)
    expect(merged.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'failed', 'not-run'])
    expect(merged.steps[2].index).toBe(2)
    expect(merged.observation).toBeUndefined()
    expect(needsClosingRead(segs, results)).toBe(true)
    expect(needsClosingRead(segs, [r1, { steps: [ok(0, 'hold_key')], waited }, { steps: [ok(0, 'key')], observation: obs, waited }])).toBe(false)
  })
})
