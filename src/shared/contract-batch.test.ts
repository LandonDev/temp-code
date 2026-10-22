import { describe, expect, it } from 'vitest'
import {
  BatchRulesSchema,
  BatchStateSchema,
  BatchStepSchema,
  DEFAULT_BATCH_RULES,
  emptyBatch,
  emptyStep,
  rulesLine
} from './contract-batch'

describe('the batch shapes', () => {
  it("parses a sample batch with a running step's telemetry", () => {
    const sample = {
      masterId: 'm1',
      rules: { ...DEFAULT_BATCH_RULES, summary: 'Land all five, gate once, release, then tell me' },
      steps: [
        { id: 'land', status: 'passed', detail: '5 of 5 landed', at: 1700000000000, startedAt: 1699999990000, endedAt: 1700000000000, progress: { done: 5, total: 5 }, log: ['a landed'] },
        { id: 'gate', status: 'running', detail: 'vitest', at: 1700000001000, startedAt: 1700000001000, progress: { done: 1, total: 3, label: 'vitest' }, log: ['✓ typecheck 12s passed'] },
        { id: 'release', status: 'pending', detail: '', at: null, log: [] },
        { id: 'publish', status: 'pending', detail: '', at: null, log: [] },
        { id: 'deploy', status: 'pending', detail: '', at: null, log: [] }
      ],
      landed: ['a', 'b', 'c', 'd', 'e'],
      pending: [],
      held: [],
      blocked: null,
      finishedAt: null
    }
    expect(BatchStateSchema.parse(sample)).toEqual(sample)
  })
  it('refuses a step outside the five, a status outside the five, and a step without a log', () => {
    expect(BatchStepSchema.safeParse({ id: 'test', status: 'pending', detail: '', at: null, log: [] }).success).toBe(false)
    expect(BatchStepSchema.safeParse({ id: 'gate', status: 'done', detail: '', at: null, log: [] }).success).toBe(false)
    expect(BatchStepSchema.safeParse({ id: 'gate', status: 'skipped', detail: '', at: null }).success).toBe(false)
  })
  it('the empty batch has the five steps pending, the default rules and the children pending', () => {
    const b = emptyBatch('m1', ['x', 'y'])
    expect(BatchStateSchema.parse(b)).toEqual(b)
    expect(b.rules).toEqual(DEFAULT_BATCH_RULES)
    expect(b.steps).toEqual(['land', 'gate', 'release', 'publish', 'deploy'].map((id) => emptyStep(id as never)))
    expect(b.landed).toEqual([])
    expect(b.pending).toEqual(['x', 'y'])
    expect(b.held).toEqual([])
    expect(b.blocked).toBeNull()
    expect(b.finishedAt).toBeNull()
  })
  it('the rules: the defaults, publish off, the one-line form', () => {
    expect(DEFAULT_BATCH_RULES).toEqual({ land: 'as-they-finish', gate: true, release: true, publish: false, deploy: 'none', then: 'notify' })
    expect(BatchRulesSchema.safeParse({ ...DEFAULT_BATCH_RULES, land: 'later' }).success).toBe(false)
    expect(rulesLine(DEFAULT_BATCH_RULES)).toBe('land as they finish · gate · release · then notify')
    expect(rulesLine({ land: 'all-at-once', gate: false, release: false, publish: true, deploy: 'box', then: 'archive-children' })).toBe(
      'land all at once · no gate · no release · publish from the Mac · deploy to the box · then archive the children'
    )
  })
})
