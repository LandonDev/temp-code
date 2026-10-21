import { describe, expect, it } from 'vitest'
import { BatchStateSchema, BatchStepSchema, emptyBatch } from './contract-batch'

describe('the batch shapes', () => {
  it('parses a sample batch', () => {
    const sample = {
      masterId: 'm1',
      steps: [
        { id: 'land', status: 'running', detail: '3 of 5 branches landed', at: 1700000000000 },
        { id: 'gate', status: 'pending', detail: '', at: null },
        { id: 'release', status: 'pending', detail: '', at: null }
      ],
      landed: ['a', 'b', 'c'],
      pending: ['d', 'e']
    }
    expect(BatchStateSchema.parse(sample)).toEqual(sample)
  })
  it('refuses a step outside the three, or a status outside the four', () => {
    expect(BatchStepSchema.safeParse({ id: 'test', status: 'pending', detail: '', at: null }).success).toBe(false)
    expect(BatchStepSchema.safeParse({ id: 'gate', status: 'held', detail: '', at: null }).success).toBe(false)
  })
  it('the empty batch has every step pending and the children pending', () => {
    const b = emptyBatch('m1', ['x', 'y'])
    expect(BatchStateSchema.parse(b)).toEqual(b)
    expect(b.steps.map((s) => [s.id, s.status])).toEqual([['land', 'pending'], ['gate', 'pending'], ['release', 'pending']])
    expect(b.landed).toEqual([])
    expect(b.pending).toEqual(['x', 'y'])
  })
})
