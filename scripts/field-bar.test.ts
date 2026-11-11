import { describe, expect, it } from 'vitest'
import type { BenchReport, BenchRun } from './lib/computerBench'
import { BOX_TOTAL_RATIO, classifyFieldReport, fieldBar } from './lib/fieldBar'

const run = (model: string, task: string, over: Partial<BenchRun> = {}): BenchRun => ({
  model,
  provider: model.startsWith('gpt') ? 'codex' : 'claude',
  task,
  taskVersion: 1,
  attempt: 1,
  outcome: 'passed',
  stepBudget: 10,
  queuedMs: 0,
  wallMs: 20_000,
  thinkMs: 10_000,
  calls: Array.from({ length: 5 }, () => ({ tool: 'computer_act', hostMs: 100, rowMs: 150, steps: [], screenshotAsked: false, shots: 0, isError: false })),
  otherTools: [],
  cards: [],
  front: { before: 'a', after: 'a', bounced: false, personActive: false, benchInFront: false },
  ...over
})

const report = (over: Partial<BenchReport>, runs: BenchRun[]): BenchReport => ({
  version: 1,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_100_000,
  commit: 'abcdef1234567890',
  clean: true,
  mode: 'hand',
  set: 'field',
  runs,
  models: [],
  unrun: [],
  host: { macos: '27.2', chip: 'arm', load1: 1 },
  ...over
})

const calls = (n: number): BenchRun['calls'] => Array.from({ length: n }, () => ({ tool: 'computer_act', hostMs: 100, rowMs: 150, steps: [], screenshotAsked: false, shots: 0, isError: false }))

describe('classifyFieldReport', () => {
  it('reads the kind off the report itself', () => {
    expect(classifyFieldReport(report({ mode: 'reference' }, []))).toBe('codex')
    expect(classifyFieldReport(report({ hostKind: 'box' }, []))).toBe('box')
    expect(classifyFieldReport(report({}, []))).toBe('mac')
  })
})

describe('fieldBar', () => {
  const MODEL = 'claude-opus-5-5'
  const CODEX = 'gpt-6.1-sol'
  // Codex passes t1 (26 s, 8 calls), fails t2.
  const codexRuns = [run(CODEX, 't1', { wallMs: 26_000, calls: calls(8) }), run(CODEX, 't2', { outcome: 'failed', reason: 'no save panel' })]
  const codexReport = report({ mode: 'reference', round: 'r1' }, codexRuns)

  it('met: our model matches Codex, wins a task it failed, and the box stays within 15%', () => {
    const mac = report({ round: 'r1' }, [run(MODEL, 't1', { wallMs: 20_000, calls: calls(6) }), run(MODEL, 't2', { wallMs: 30_000 })])
    const box = report({ hostKind: 'box', round: 'r1' }, [run(MODEL, 't1', { wallMs: 22_000 }), run(MODEL, 't2', { wallMs: 33_000 })])
    const judged = fieldBar([mac, box, codexReport])
    expect(judged.misses).toEqual([])
    expect(judged.ok).toBe(true)
    expect(judged.table).toContain('round r1')
    expect(judged.table).toContain('field bar met')
  })

  it('names a parity miss where Codex passed and we failed', () => {
    const mac = report({}, [run(MODEL, 't1', { outcome: 'failed', reason: 'x' }), run(MODEL, 't2')])
    const judged = fieldBar([mac, codexReport])
    expect(judged.ok).toBe(false)
    expect(judged.misses).toContainEqual(expect.objectContaining({ kind: 'parity', model: MODEL, task: 't1' }))
    expect(judged.table).toContain('MISS parity')
  })

  it('names the missing win when we pass nothing Codex failed', () => {
    const mac = report({}, [run(MODEL, 't1'), run(MODEL, 't2', { outcome: 'failed', reason: 'x' })])
    const judged = fieldBar([mac, codexReport])
    expect(judged.misses).toEqual([expect.objectContaining({ kind: 'no-win', model: MODEL })])
  })

  it('judges the medians per task against Codex’s', () => {
    const mac = report({}, [run(MODEL, 't1', { wallMs: 40_000, calls: calls(9) }), run(MODEL, 't2')])
    const judged = fieldBar([mac, codexReport])
    expect(judged.misses).toContainEqual(expect.objectContaining({ kind: 'slower', model: MODEL, task: 't1' }))
    expect(judged.misses).toContainEqual(expect.objectContaining({ kind: 'more-calls', model: MODEL, task: 't1' }))
  })

  it('holds a box run to 15% over the same model’s Mac run, per model', () => {
    const mac = report({}, [run(MODEL, 't1', { wallMs: 20_000 }), run(MODEL, 't2', { wallMs: 20_000 })])
    const slow = report({ hostKind: 'box' }, [run(MODEL, 't1', { wallMs: 30_000 }), run(MODEL, 't2', { wallMs: 20_000 })])
    const judged = fieldBar([mac, slow])
    expect(judged.misses).toEqual([expect.objectContaining({ kind: 'box-total', model: MODEL })])
    expect(BOX_TOTAL_RATIO).toBe(1.15)
    const fine = report({ hostKind: 'box' }, [run(MODEL, 't1', { wallMs: 23_000 }), run(MODEL, 't2', { wallMs: 22_000 })])
    expect(fieldBar([mac, fine]).ok).toBe(true)
  })

  it('skips what it was not given, and never fails it', () => {
    const mac = report({}, [run(MODEL, 't1')])
    const judged = fieldBar([mac])
    expect(judged.ok).toBe(true)
    expect(judged.skipped.join(' ')).toContain('no Codex reference report')
    expect(judged.skipped.join(' ')).toContain('no box report')
  })

  it('skips a model in one report alone and a task skipped in a report', () => {
    const mac = report({}, [run(MODEL, 't1')])
    const box = report({ hostKind: 'box' }, [run('claude-sonnet-5-5', 't1')])
    const judged = fieldBar([mac, box])
    expect(judged.skipped.join(' ')).toContain('claude-sonnet-5-5')
    expect(judged.ok).toBe(true)
  })

  it('refuses two reports of one kind', () => {
    expect(() => fieldBar([report({}, []), report({}, [])])).toThrow(/two mac reports/)
  })

  it('a run over its budget or off route fails its task in the bar too', () => {
    // runFault is applied by summarize: 11 calls of 10 is a fail even though the end state passed
    const mac = report({}, [run(MODEL, 't1', { calls: calls(11) }), run(MODEL, 't2')])
    const judged = fieldBar([mac, codexReport])
    expect(judged.misses).toContainEqual(expect.objectContaining({ kind: 'parity', model: MODEL, task: 't1' }))
  })
})
