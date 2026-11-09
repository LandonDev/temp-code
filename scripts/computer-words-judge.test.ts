import { describe, expect, it } from 'vitest'
import type { TaskId } from './lib/computerTasks'
import { decide, pickWinner, runPlan, type Arm, type ModelUnderTest, type RunRecord, type RunStatus } from './lib/computerWordsJudge'

const OPUS: ModelUnderTest = { model: 'claude-opus-5-5', provider: 'claude', perVerb: true }
const SOL: ModelUnderTest = { model: 'gpt-6.1-sol', provider: 'codex', perVerb: false }
const TASKS: TaskId[] = ['textedit-write', 'chrome-read', 'chrome-form']

function runs(model: string, arm: Arm, over: Partial<RunRecord> = {}, status: RunStatus = 'ok'): RunRecord[] {
  return TASKS.flatMap((task) =>
    [1, 2].map((run) => ({ model, task, arm, run, status, computerCalls: 4, otherCalls: 0, steps: 8, failedSteps: 0, wallMs: 60_000, ...over }))
  )
}

describe('runPlan', () => {
  it('interleaves the arms forward then back, per task, and resets the tiers before every run', () => {
    const plan = runPlan(['chrome-read'], ['A', 'C', 'AV', 'CV'], 2, [OPUS])
    expect(plan.map((p) => `${p.arm}${p.run}`)).toEqual(['A1', 'C1', 'AV1', 'CV1', 'CV2', 'AV2', 'C2', 'A2'])
    expect(plan.every((p) => p.resetTiers)).toBe(true)
  })

  it('runs the per-verb arms for a per-verb model alone: 48 runs in all', () => {
    const plan = runPlan(TASKS, ['A', 'C', 'AV', 'CV'], 2, [OPUS, SOL, { model: 'muse-wonder-1.0', provider: 'claude', perVerb: false }])
    expect(plan.filter((p) => p.model === 'gpt-6.1-sol').map((p) => p.arm)).not.toContain('AV')
    expect(plan.filter((p) => p.model === 'claude-opus-5-5')).toHaveLength(24)
    expect(plan).toHaveLength(48)
  })
})

describe('pickWinner', () => {
  it('passes first', () => {
    const r = [...runs('m', 'A', { computerCalls: 12 }), ...runs('m', 'C', {}, 'failed')]
    expect(pickWinner(r, 'm', 'A', 'C', {}).winner).toBe('A')
  })

  it('counts an off-route run as failed', () => {
    const r = [...runs('m', 'A'), ...runs('m', 'C').map((x, i) => (i === 0 ? { ...x, status: 'off-route' as const } : x))]
    expect(pickWinner(r, 'm', 'A', 'C', {})).toMatchObject({ winner: 'A', reason: 'more tasks passed' })
  })

  it('then fewer calls, a gap under one being a tie', () => {
    expect(pickWinner([...runs('m', 'A', { computerCalls: 6 }), ...runs('m', 'C', { computerCalls: 4 })], 'm', 'A', 'C', {})).toMatchObject({
      winner: 'C',
      reason: 'fewer computer calls'
    })
    expect(pickWinner([...runs('m', 'A', { computerCalls: 4.5, steps: 6 }), ...runs('m', 'C', { steps: 9 })], 'm', 'A', 'C', {})).toMatchObject({
      winner: 'A',
      reason: 'fewer steps'
    })
  })

  it('then failed steps, then wall time, then the shorter text', () => {
    expect(pickWinner([...runs('m', 'A', { failedSteps: 2 }), ...runs('m', 'C')], 'm', 'A', 'C', {}).winner).toBe('C')
    expect(pickWinner([...runs('m', 'A', { wallMs: 90_000 }), ...runs('m', 'C')], 'm', 'A', 'C', {}).reason).toBe('less wall time')
    expect(pickWinner([...runs('m', 'A'), ...runs('m', 'C')], 'm', 'A', 'C', { A: 9000, C: 8000 })).toMatchObject({
      winner: 'C',
      reason: 'a tie: the shorter text'
    })
  })

  it('leaves out skipped and inconclusive runs, and calls a cell with none skipped', () => {
    const r = [...runs('m', 'A'), ...runs('m', 'C', {}, 'skipped')]
    expect(pickWinner(r, 'm', 'A', 'C', {})).toMatchObject({ winner: null })
    expect(pickWinner(r, 'm', 'A', 'C', {}).reason).toMatch(/^skipped/)
    const mixed = [...runs('m', 'A', { computerCalls: 9 }), ...runs('m', 'C', { computerCalls: 3 }, 'inconclusive'), ...runs('m', 'C').slice(0, 2)]
    expect(pickWinner(mixed, 'm', 'A', 'C', {}).b.runs).toBe(2)
  })
})

describe('decide', () => {
  it('asks a per-verb model a second question on the winning words', () => {
    const r = [...runs(OPUS.model, 'A'), ...runs(OPUS.model, 'C', {}, 'failed'), ...runs(OPUS.model, 'AV', { computerCalls: 2 }), ...runs(OPUS.model, 'CV')]
    const d = decide(r, OPUS, {})
    expect(d.words.winner).toBe('A')
    expect(d.tools?.winner).toBe('AV')
    expect(d.ship).toEqual({ shape: 'anthropic', tools: 'per-verb' })
  })

  it('keeps the four tools on a tie', () => {
    const r = [...runs(OPUS.model, 'A'), ...runs(OPUS.model, 'C', {}, 'failed'), ...runs(OPUS.model, 'AV')]
    expect(decide(r, OPUS, { A: 9000, AV: 100 }).ship).toEqual({ shape: 'anthropic', tools: 'act' })
  })

  it('ships the words alone for any other model, and nothing when a cell was skipped', () => {
    expect(decide([...runs(SOL.model, 'A', { computerCalls: 8 }), ...runs(SOL.model, 'C')], SOL, {}).ship).toEqual({ shape: 'cua', tools: 'act' })
    expect(decide(runs(SOL.model, 'A'), SOL, {}).ship).toBeNull()
  })
})
