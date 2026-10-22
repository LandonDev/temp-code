import { describe, expect, it } from 'vitest'
import {
  BatchRulesSchema,
  BatchStateSchema,
  BatchStepSchema,
  DEFAULT_BATCH_RULES,
  DEFAULT_BATCH_STEPS,
  emptyBatch,
  emptyStep,
  rulesLine,
  stepsProblem,
  withLandStep
} from './contract-batch'

const shell = { id: 'smoke', name: 'Smoke test', kind: 'shell' as const, run: 'bun run smoke', cwd: '/repo' }

describe('the batch shapes', () => {
  it("parses a sample batch with a running step's telemetry", () => {
    const sample = {
      masterId: 'm1',
      rules: { ...DEFAULT_BATCH_RULES, summary: 'Land all five, gate once, release, then tell me' },
      steps: [
        { id: 'land', name: 'Land', kind: 'land', status: 'passed', detail: '5 of 5 landed', at: 1700000000000, startedAt: 1699999990000, endedAt: 1700000000000, progress: { done: 5, total: 5 }, log: ['a landed'] },
        { id: 'gate', name: 'Gate', kind: 'gate', status: 'running', detail: 'vitest', at: 1700000001000, startedAt: 1700000001000, progress: { done: 1, total: 3, label: 'vitest' }, log: ['✓ typecheck 12s passed'] },
        { id: 'release', name: 'Release', kind: 'release', status: 'pending', detail: '', at: null, log: [] }
      ],
      landed: ['a', 'b', 'c', 'd', 'e'],
      pending: [],
      held: [],
      blocked: null,
      finishedAt: null
    }
    expect(BatchStateSchema.parse(sample)).toEqual(sample)
  })
  it('refuses a kind outside the six, a status outside the five, and a step without a log', () => {
    expect(BatchStepSchema.safeParse({ id: 'test', name: 'T', kind: 'test', status: 'pending', detail: '', at: null, log: [] }).success).toBe(false)
    expect(BatchStepSchema.safeParse({ id: 'gate', name: 'Gate', kind: 'gate', status: 'done', detail: '', at: null, log: [] }).success).toBe(false)
    expect(BatchStepSchema.safeParse({ id: 'gate', name: 'Gate', kind: 'gate', status: 'skipped', detail: '', at: null }).success).toBe(false)
  })
  it('the empty batch has the default three steps pending, the default rules and the children pending', () => {
    const b = emptyBatch('m1', ['x', 'y'])
    expect(BatchStateSchema.parse(b)).toEqual(b)
    expect(b.rules).toEqual(DEFAULT_BATCH_RULES)
    expect(b.steps).toEqual(DEFAULT_BATCH_STEPS.map(emptyStep))
    expect(b.landed).toEqual([])
    expect(b.pending).toEqual(['x', 'y'])
    expect(b.held).toEqual([])
    expect(b.blocked).toBeNull()
    expect(b.finishedAt).toBeNull()
  })
  it('the rules: the defaults, a shell step, the one-line form', () => {
    expect(DEFAULT_BATCH_RULES).toEqual({ land: 'as-they-finish', steps: [...DEFAULT_BATCH_STEPS], then: 'notify' })
    expect(BatchRulesSchema.safeParse({ ...DEFAULT_BATCH_RULES, land: 'later' }).success).toBe(false)
    expect(BatchRulesSchema.safeParse({ ...DEFAULT_BATCH_RULES, steps: [shell] }).success).toBe(true)
    expect(rulesLine(DEFAULT_BATCH_RULES)).toBe('land as they finish · Gate · Release · then notify')
    expect(
      rulesLine({
        land: 'all-at-once',
        steps: [{ id: 'build', name: 'Build', kind: 'shell', run: 'gradle build' }, { ...shell, name: 'Deploy to dev', when: 'each-landing' }],
        then: 'archive-children'
      })
    ).toBe('land all at once · Build · Deploy to dev (each landing) · then archive the children')
  })
  it("a list's problems: a bad or repeated id, two of a built-in kind, a shell step without run, a run on a built-in kind; and the land step added at the front", () => {
    expect(stepsProblem(DEFAULT_BATCH_STEPS)).toBeNull()
    expect(stepsProblem([shell])).toBeNull()
    expect(stepsProblem([{ ...shell, id: 'a b' }])).toMatch(/must be letters/)
    expect(stepsProblem([shell, shell])).toBe('step id "smoke" is used twice')
    expect(stepsProblem([DEFAULT_BATCH_STEPS[1], { ...DEFAULT_BATCH_STEPS[1], id: 'gate2' }])).toBe('two gate steps; one per built-in kind')
    expect(stepsProblem([{ ...shell, run: ' ' }])).toBe('shell step "smoke" has no run')
    expect(stepsProblem([{ ...DEFAULT_BATCH_STEPS[1], run: 'x' }])).toBe('step "gate" is gate, which takes no run')
    expect(withLandStep([shell])).toEqual([DEFAULT_BATCH_STEPS[0], shell])
    expect(withLandStep([shell, DEFAULT_BATCH_STEPS[0]])).toEqual([shell, DEFAULT_BATCH_STEPS[0]])
  })
})
