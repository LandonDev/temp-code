import { describe, expect, it } from 'vitest'
import {
  BatchRulesSchema,
  BatchStateSchema,
  BatchStepSchema,
  DEFAULT_BATCH_RULES,
  emptyBatch,
  rulesLine,
  stepsFor
} from './contract-batch'

describe('the batch shapes', () => {
  it('parses a sample batch', () => {
    const sample = {
      masterId: 'm1',
      rules: { ...DEFAULT_BATCH_RULES, summary: 'Land all five, gate once, release, then tell me' },
      steps: [
        { id: 'land', status: 'running', detail: '3 of 5 branches landed', at: 1700000000000 },
        { id: 'gate', status: 'pending', detail: '', at: null },
        { id: 'release', status: 'pending', detail: '', at: null }
      ],
      landed: ['a', 'b', 'c'],
      pending: ['d', 'e'],
      held: [],
      blocked: null,
      finishedAt: null
    }
    expect(BatchStateSchema.parse(sample)).toEqual(sample)
  })
  it('refuses a step outside the four, or a status outside the four', () => {
    expect(BatchStepSchema.safeParse({ id: 'test', status: 'pending', detail: '', at: null }).success).toBe(false)
    expect(BatchStepSchema.safeParse({ id: 'gate', status: 'held', detail: '', at: null }).success).toBe(false)
  })
  it('the empty batch has every step pending, the default rules and the children pending', () => {
    const b = emptyBatch('m1', ['x', 'y'])
    expect(BatchStateSchema.parse(b)).toEqual(b)
    expect(b.rules).toEqual(DEFAULT_BATCH_RULES)
    expect(b.steps.map((s) => [s.id, s.status])).toEqual([['land', 'pending'], ['gate', 'pending'], ['release', 'pending']])
    expect(b.landed).toEqual([])
    expect(b.pending).toEqual(['x', 'y'])
    expect(b.held).toEqual([])
    expect(b.blocked).toBeNull()
    expect(b.finishedAt).toBeNull()
  })
  it('the rules: the defaults, the deploy step only when asked, the one-line form', () => {
    expect(DEFAULT_BATCH_RULES).toEqual({ land: 'as-they-finish', gate: true, release: true, deploy: 'none', then: 'notify' })
    expect(BatchRulesSchema.safeParse({ ...DEFAULT_BATCH_RULES, land: 'later' }).success).toBe(false)
    expect(stepsFor({ deploy: 'none' })).toEqual(['land', 'gate', 'release'])
    expect(stepsFor({ deploy: 'box' })).toEqual(['land', 'gate', 'release', 'deploy'])
    expect(emptyBatch('m', [], { ...DEFAULT_BATCH_RULES, deploy: 'box' }).steps.map((s) => s.id)).toEqual(['land', 'gate', 'release', 'deploy'])
    expect(rulesLine(DEFAULT_BATCH_RULES)).toBe('land as they finish · gate · release · then notify')
    expect(rulesLine({ land: 'all-at-once', gate: false, release: false, deploy: 'box', then: 'archive-children' })).toBe(
      'land all at once · no gate · no release · deploy to the box · then archive the children'
    )
  })
})
