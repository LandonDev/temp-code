import { describe, expect, it } from 'vitest'
import type { BenchReport, BenchRun } from './lib/computerBench'
import { BOX_TOTAL_RATIO, classifyFieldReport, fieldBar, type FieldExpectation } from './lib/fieldBar'

const run = (model: string, task: string, over: Partial<BenchRun> = {}): BenchRun => ({
  model,
  provider: model.startsWith('gpt') ? 'codex' : 'claude',
  task,
  taskVersion: 1,
  attempt: 1,
  outcome: 'passed',
  faultRule: model.startsWith('gpt') ? 'field-reference' : 'field',
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
  /** The round's expectation: one model, two tasks (C5: the judge CLI passes FIELD_MODELS × FIELD_TASKS). */
  const EXPECT: FieldExpectation = { models: [MODEL], tasks: ['t1', 't2'] }
  // Codex passes t1 (26 s, 8 calls), fails t2.
  const codexRuns = [run(CODEX, 't1', { wallMs: 26_000, calls: calls(8) }), run(CODEX, 't2', { outcome: 'failed', reason: 'no save panel' })]
  const codexReport = report({ mode: 'reference', round: 'r1' }, codexRuns)

  it('met: our model matches Codex, wins a task it failed, and the box stays within 15%', () => {
    const mac = report({ round: 'r1' }, [run(MODEL, 't1', { wallMs: 20_000, calls: calls(6) }), run(MODEL, 't2', { wallMs: 30_000 })])
    const box = report({ hostKind: 'box', round: 'r1' }, [run(MODEL, 't1', { wallMs: 22_000 }), run(MODEL, 't2', { wallMs: 33_000 })])
    const judged = fieldBar([mac, box, codexReport], EXPECT)
    expect(judged.misses).toEqual([])
    expect(judged.ok).toBe(true)
    expect(judged.table).toContain('round r1')
    expect(judged.table).toContain('field bar met')
  })

  it('names a parity miss where Codex passed and we failed', () => {
    const mac = report({}, [run(MODEL, 't1', { outcome: 'failed', reason: 'x' }), run(MODEL, 't2')])
    const judged = fieldBar([mac, codexReport], EXPECT)
    expect(judged.ok).toBe(false)
    expect(judged.misses).toContainEqual(expect.objectContaining({ kind: 'parity', model: MODEL, task: 't1' }))
    expect(judged.table).toContain('MISS parity')
  })

  it('names the missing win when we pass nothing Codex failed', () => {
    const mac = report({}, [run(MODEL, 't1'), run(MODEL, 't2', { outcome: 'failed', reason: 'x' })])
    const judged = fieldBar([mac, codexReport], EXPECT)
    expect(judged.misses).toEqual([expect.objectContaining({ kind: 'no-win', model: MODEL })])
  })

  it('judges the medians per task against Codex’s', () => {
    const mac = report({}, [run(MODEL, 't1', { wallMs: 40_000, calls: calls(9) }), run(MODEL, 't2')])
    const judged = fieldBar([mac, codexReport], EXPECT)
    expect(judged.misses).toContainEqual(expect.objectContaining({ kind: 'slower', model: MODEL, task: 't1' }))
    expect(judged.misses).toContainEqual(expect.objectContaining({ kind: 'more-calls', model: MODEL, task: 't1' }))
  })

  it('holds a box run to 15% over the same model’s Mac run, per model', () => {
    const mac = report({}, [run(MODEL, 't1', { wallMs: 20_000 }), run(MODEL, 't2', { wallMs: 20_000 })])
    const slow = report({ hostKind: 'box' }, [run(MODEL, 't1', { wallMs: 30_000 }), run(MODEL, 't2', { wallMs: 20_000 })])
    const judged = fieldBar([mac, slow], EXPECT)
    expect(judged.misses).toEqual([expect.objectContaining({ kind: 'box-total', model: MODEL })])
    expect(BOX_TOTAL_RATIO).toBe(1.15)
    const fine = report({ hostKind: 'box' }, [run(MODEL, 't1', { wallMs: 23_000 }), run(MODEL, 't2', { wallMs: 22_000 })])
    expect(fieldBar([mac, fine], EXPECT).ok).toBe(true)
  })

  it('a hole in a GIVEN report is a named miss: "bar met" is impossible with it (C5)', () => {
    // the Mac report lacks t2 (never ran: a skipped lane, a --tasks subset)
    const mac = report({}, [run(MODEL, 't1')])
    const judged = fieldBar([mac], EXPECT)
    expect(judged.ok).toBe(false)
    expect(judged.misses).toEqual([expect.objectContaining({ kind: 'missing', model: MODEL, task: 't2', detail: expect.stringContaining('no mac run') })])
    // a model the round expects that the Mac report never ran
    const two = fieldBar([mac], { models: [MODEL, 'claude-sonnet-5-5'], tasks: ['t1'] })
    expect(two.misses).toContainEqual(expect.objectContaining({ kind: 'missing', model: 'claude-sonnet-5-5', task: 't1' }))
    // a codex report whose task was skipped (runs exist but none ran)
    const codexHole = report({ mode: 'reference' }, [run(CODEX, 't1'), run(CODEX, 't2', { outcome: 'skipped', reason: 'another proof running' })])
    const judgedCodex = fieldBar([report({}, [run(MODEL, 't1'), run(MODEL, 't2')]), codexHole], EXPECT)
    expect(judgedCodex.misses).toContainEqual(expect.objectContaining({ kind: 'missing', model: CODEX, task: 't2', detail: expect.stringContaining('no codex run') }))
    // a box report with a hole misses too
    const boxHole = report({ hostKind: 'box' }, [run(MODEL, 't1')])
    expect(fieldBar([boxHole], EXPECT).misses).toContainEqual(expect.objectContaining({ kind: 'missing', model: MODEL, task: 't2', detail: expect.stringContaining('no box run') }))
  })

  it('a missing whole report stays a skip note, never a miss', () => {
    const mac = report({}, [run(MODEL, 't1'), run(MODEL, 't2')])
    const judged = fieldBar([mac], EXPECT)
    expect(judged.skipped.join(' ')).toContain('no Codex reference report')
    expect(judged.skipped.join(' ')).toContain('no box report')
    expect(judged.misses).toEqual([])
    expect(judged.ok).toBe(true)
  })

  it('notes a model in the box report alone, and a task compared across versions', () => {
    const mac = report({}, [run(MODEL, 't1'), run(MODEL, 't2')])
    const box = report({ hostKind: 'box' }, [run(MODEL, 't1'), run(MODEL, 't2'), run('claude-sonnet-5-5', 't1', { taskVersion: 2 })])
    const judged = fieldBar([mac, box], EXPECT)
    expect(judged.skipped.join(' ')).toContain('claude-sonnet-5-5')
    expect(judged.skipped.join(' ')).toContain('task versions 1 and 2')
  })

  it('refuses two reports of one kind, and a report that is no field report', () => {
    expect(() => fieldBar([report({}, []), report({}, [])], EXPECT)).toThrow(/two mac reports/)
    expect(() => fieldBar([report({ set: undefined }, [])], EXPECT)).toThrow(/no field report/)
  })

  it('an off-route field run fails its task in the bar too; budgets never do (C1)', () => {
    // off-route fails under the field rule, in summarize and so in the bar
    const offRoute = report({}, [run(MODEL, 't1', { otherTools: ['Bash'] }), run(MODEL, 't2')])
    const judged = fieldBar([offRoute, codexReport], EXPECT)
    expect(judged.misses).toContainEqual(expect.objectContaining({ kind: 'parity', model: MODEL, task: 't1' }))
    // calls past the recorded budget are NOT a fault in the field set: the bar compares calls instead
    const manyCalls = report({}, [run(MODEL, 't1', { calls: calls(11) }), run(MODEL, 't2')])
    const judged2 = fieldBar([manyCalls, codexReport], EXPECT)
    expect(judged2.misses.some((m) => m.kind === 'parity')).toBe(false)
    expect(judged2.misses).toContainEqual(expect.objectContaining({ kind: 'more-calls', model: MODEL, task: 't1' }))
    // and a Codex reference run that went off route fails ITS side the same way: a free win is no win
    const codexOff = report({ mode: 'reference' }, [run(CODEX, 't1', { otherTools: ['shell'] }), run(CODEX, 't2', { outcome: 'failed' })])
    const judged3 = fieldBar([report({}, [run(MODEL, 't1'), run(MODEL, 't2')]), codexOff], EXPECT)
    // codex now failed both tasks: our pass on t1 is a win, no parity misses
    expect(judged3.misses.filter((m) => m.kind === 'parity' || m.kind === 'no-win')).toEqual([])
  })
})
