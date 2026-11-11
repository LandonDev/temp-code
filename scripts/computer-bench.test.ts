import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPUTER_ACTION_NAMES,
  COMPUTER_ERROR_KINDS,
  NO_INPUT_ACTIONS,
  type ComputerAction,
  type ComputerActionName,
  type StepResult
} from '../src/shared/computer/protocol'
import { EFFECT_WORDS, NOT_EXECUTED_LINE, formatStepLine, stoppedLine } from '../src/shared/computer/tools'
import {
  BENCH_RULE,
  BENCH_TIMING,
  EMPTY_BASELINE,
  NO_BASELINE_LINE,
  benchOutcome,
  baselinePath,
  callsLimit,
  hostMsLimit,
  judgeBench,
  median,
  mergeBaseline,
  needsRerun,
  parseStepLine,
  passNeed,
  readBaseline,
  renderBenchTable,
  runFault,
  stepsOf,
  summarize,
  toolKind,
  writeBaseline,
  type Baseline,
  type BaselineRow,
  type BenchCall,
  type BenchReport,
  type BenchRun
} from './lib/computerBench'

// ── builders ────────────────────────────────────────────────────────────

const call = (over: Partial<BenchCall> = {}): BenchCall => ({
  tool: 'computer_act',
  hostMs: 100,
  rowMs: 140,
  steps: [{ action: 'left_click', tier: 'ax', effect: 'changed', ok: true }],
  screenshotAsked: false,
  shots: 0,
  isError: false,
  ...over
})

const calls = (n: number, hostMs = 100): BenchCall[] => Array.from({ length: n }, () => call({ hostMs }))

const run = (over: Partial<BenchRun> = {}): BenchRun => ({
  model: 'claude-opus-5-5',
  provider: 'claude',
  task: 'textedit-write',
  taskVersion: 1,
  attempt: 1,
  outcome: 'passed',
  stepBudget: 10,
  queuedMs: 0,
  wallMs: 12_000,
  thinkMs: 8_000,
  calls: calls(4),
  otherTools: [],
  cards: [],
  front: { before: 'com.apple.Terminal', after: 'com.apple.Terminal', bounced: false, personActive: false, benchInFront: false },
  ...over
})

const report = (runs: BenchRun[], over: Partial<BenchReport> = {}): BenchReport => ({
  version: 1,
  startedAt: Date.UTC(2026, 10, 9, 2, 0, 0),
  endedAt: Date.UTC(2026, 10, 9, 2, 6, 0),
  commit: 'abcdef0123456789',
  clean: true,
  mode: 'gate',
  host: { macos: '26.1', chip: 'Apple M4 Max', load1: 3.2 },
  models: [{ model: 'claude-opus-5-5' }],
  runs,
  unrun: [],
  ...over
})

const row = (over: Partial<BaselineRow> = {}): BaselineRow => ({
  model: 'claude-opus-5-5',
  task: 'textedit-write',
  taskVersion: 1,
  callsMedian: 4,
  hostMsMedian: 100,
  wallMsMedian: 12_000,
  thinkMsMedian: 8_000,
  commit: 'base',
  at: 1,
  ...over
})

const base = (...rows: BaselineRow[]): Baseline => ({ version: 1, rows })
const verdict = (j: ReturnType<typeof judgeBench>, what: string) => j.verdicts.find((v) => v.what.endsWith(what))

// ── the step lines ──────────────────────────────────────────────────────

/** One action of every name, as a model would send it. */
const SAMPLE: Record<ComputerActionName, ComputerAction> = {
  screenshot: { action: 'screenshot' },
  zoom: { action: 'zoom', region: [0, 0, 200, 100] },
  left_click: { action: 'left_click', element: 14 },
  right_click: { action: 'right_click', coordinate: [12, 30] },
  middle_click: { action: 'middle_click' },
  double_click: { action: 'double_click', element: 3, text: 'shift' },
  triple_click: { action: 'triple_click', element: 9 },
  left_click_drag: { action: 'left_click_drag', start_element: 2, element: 5 },
  mouse_move: { action: 'mouse_move', coordinate: [400, 300] },
  left_mouse_down: { action: 'left_mouse_down' },
  left_mouse_up: { action: 'left_mouse_up' },
  cursor_position: { action: 'cursor_position' },
  scroll: { action: 'scroll', scroll_direction: 'down', scroll_amount: 5, element: 20 },
  type: { action: 'type', text: 'Hello · world, failed: not really', element: 7 },
  key: { action: 'key', text: 'cmd+s', repeat: 2 },
  hold_key: { action: 'hold_key', text: 'shift', duration: 1 },
  wait: { action: 'wait', duration: 2 },
  set_value: { action: 'set_value', element: 7, value: 'Ana Ruiz' },
  perform: { action: 'perform', element: 11, name: 'AXPress' },
  select_text: { action: 'select_text', element: 7, text: 'world' },
  paste: { action: 'paste', text: 'Ana · Ruiz', format: 'text', element: 7 },
  save_as: { action: 'save_as', path: '~/run/note.rtf' }
} as Record<ComputerActionName, ComputerAction>

const ok = (action: ComputerAction, extra: Record<string, unknown>): StepResult =>
  ({ index: 0, action: action.action, status: 'ok', tier: null, effect: 'changed', ...extra }) as StepResult

describe('parseStepLine', () => {
  it('reads named and menu heads, an opened window after the effect, and stopped keys', () => {
    for (const head of ['left_click "Team" [52] menu item', 'left_click menu File › Save…', 'perform pick menu File › Save…']) {
      expect(parseStepLine(`${head} · ax · changed`)).toEqual({ action: head.split(' ')[0], tier: 'ax', effect: 'changed', ok: true })
      expect(parseStepLine(`${head} · ax · changed · opened window "New · Note"`)).toEqual({ action: head.split(' ')[0], tier: 'ax', effect: 'changed', ok: true })
    }
    const action: ComputerAction = { action: 'left_click', named: 'Team' }
    const line = formatStepLine(ok(action, { tier: 'ax', resolved: 52, element: { index: 52, role: 'menu item', name: 'Team' }, opened: { id: 10, title: 'New "Note"' } }), action)
    expect(parseStepLine(line)).toEqual({ action: 'left_click', tier: 'ax', effect: 'changed', ok: true })
    expect(parseStepLine(stoppedLine(2))).toEqual({ action: null, tier: null, ok: false, error: 'not run' })
    expect(parseStepLine('left_click menu File › Save… · menu · changed')).toEqual({ action: 'left_click', tier: 'ax', via: 'menu', effect: 'changed', ok: true })
    expect(parseStepLine('left_click "A · failed: fake" [52] menu item · ax · changed')).toEqual({ action: 'left_click', tier: 'ax', effect: 'changed', ok: true })
  })

  it('keeps wait reports beside their step facts after JSON round trip', () => {
    const wait = { waitedMs: 75, reason: 'quiet' as const, firstChangeMs: 25, gapCounts: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    expect(JSON.parse(JSON.stringify(stepsOf(['left_click "Team" [52] menu item · ax · changed'], [wait])))[0]).toMatchObject({ action: 'left_click', wait })
  })
  it('has a sample for every action, so a new verb fails here first', () => {
    for (const name of COMPUTER_ACTION_NAMES) expect(SAMPLE[name], name).toBeDefined()
  })

  it('round trips every tier and effect of every input action', () => {
    for (const name of COMPUTER_ACTION_NAMES) {
      if (NO_INPUT_ACTIONS.includes(name)) continue
      const action = SAMPLE[name]
      for (const tier of ['ax', 'process', 'front', 'session'] as const)
        for (const effect of Object.keys(EFFECT_WORDS) as (keyof typeof EFFECT_WORDS)[]) {
          const line = formatStepLine(ok(action, { tier, effect }), action)
          expect(parseStepLine(line), line).toEqual({ action: name, tier, effect, ok: true })
        }
    }
  })

  it('reads the way `type` went in, in the tier’s place', () => {
    const action = SAMPLE.type
    for (const via of ['ax-insert', 'ax-value', 'keys'] as const) {
      const line = formatStepLine(ok(action, { tier: 'process', input: { via } }), action)
      expect(parseStepLine(line)).toEqual({ action: 'type', tier: via === 'keys' ? null : 'ax', via, effect: 'changed', ok: true })
    }
  })

  it('reads a background route as an ax step with its via (§24.8)', () => {
    const key = formatStepLine(ok(SAMPLE.key, { tier: 'ax', input: { via: 'menu', on: 'File › Close' } }), SAMPLE.key)
    expect(parseStepLine(key)).toEqual({ action: 'key', tier: 'ax', via: 'menu', effect: 'changed', ok: true })
    const click = formatStepLine(ok(SAMPLE.left_click, { tier: 'ax', effect: 'none', input: { via: 'hit', on: 'button "Save"' } }), SAMPLE.left_click)
    expect(parseStepLine(click)).toEqual({ action: 'left_click', tier: 'ax', via: 'hit', effect: 'none', ok: true })
  })

  it('reads a front route, save_as\'s panel, the hint and the disk part (§26.12)', () => {
    expect(parseStepLine('key super+s · front menu File › Save · changed · on disk: saved ~/run/Total.txt')).toEqual({
      action: 'key',
      tier: 'front',
      via: 'menu',
      effect: 'changed',
      disk: 'saved ~/run/Total.txt',
      ok: true
    })
    expect(parseStepLine('key Return · front · on screen only, not on disk; commit it with key Return in the field')).toEqual({ action: 'key', tier: 'front', effect: 'uncommitted', ok: true })
    expect(parseStepLine('save_as ~/run/note.rtf · panel · changed · on disk: saved ~/run/note.rtf')).toMatchObject({ action: 'save_as', tier: 'front', via: 'panel', disk: 'saved ~/run/note.rtf' })
  })

  it('keeps front routes and disk facts when menu or named steps also open a window', () => {
    const action: ComputerAction = { action: 'perform', name: 'pick', menu: 'File > Save…' }
    const line = formatStepLine(ok(action, {
      tier: 'ax', input: { via: 'menu', on: 'File › Save…' },
      disk: { saved: '~/run/note.rtf' }, opened: { id: 10, title: 'New · Note' }
    }), action)
    expect(parseStepLine(line)).toEqual({ action: 'perform', tier: 'ax', via: 'menu', effect: 'changed', disk: 'saved ~/run/note.rtf', ok: true })
    expect(parseStepLine('perform pick menu File › Save… · front menu · changed · on disk: saved ~/run/note.rtf · opened window "New · Note"')).toEqual({
      action: 'perform', tier: 'front', via: 'menu', effect: 'changed', disk: 'saved ~/run/note.rtf', ok: true
    })
    expect(parseStepLine('left_click "Save" [52] button · front · changed · on disk: saved ~/run/note.rtf · opened window "New · Note"')).toEqual({
      action: 'left_click', tier: 'front', effect: 'changed', disk: 'saved ~/run/note.rtf', ok: true
    })
    expect(parseStepLine('save_as ~/run/note.rtf · panel · changed · on disk: saved ~/run/note.rtf · opened window "Note"')).toMatchObject({
      action: 'save_as', tier: 'front', via: 'panel', disk: 'saved ~/run/note.rtf'
    })
  })

  it('reads a step with no tier', () => {
    const line = formatStepLine(ok(SAMPLE.left_click, { tier: null }), SAMPLE.left_click)
    expect(parseStepLine(line)).toEqual({ action: 'left_click', tier: null, effect: 'changed', ok: true })
  })

  it('reads the no-input actions as tierless and done', () => {
    for (const name of NO_INPUT_ACTIONS) {
      const action = SAMPLE[name]
      const line = formatStepLine(ok(action, { text: 'X=512, Y=384', waited: { settled: true, waitedMs: 400 } }), action)
      expect(parseStepLine(line), line).toEqual({ action: name, tier: null, ok: true })
    }
  })

  it('reads a failed step of every action with every error kind', () => {
    for (const name of COMPUTER_ACTION_NAMES)
      for (const kind of COMPUTER_ERROR_KINDS) {
        const message = `${kind} said in a sentence · with the separator`
        const step = { index: 0, action: name, status: 'failed', error: { kind, message } } as StepResult
        const line = formatStepLine(step, SAMPLE[name])
        expect(parseStepLine(line), line).toEqual({ action: name, tier: null, ok: false, error: message })
      }
  })

  it('reads the batch’s not-run line and a session refusal', () => {
    expect(parseStepLine(NOT_EXECUTED_LINE)).toEqual({ action: null, tier: null, ok: false, error: 'not run' })
    const refused = { index: 0, action: 'left_click', status: 'failed', error: { kind: 'needs_tier', message: 'needs the session tier (the real pointer and keyboard), which is not available now: nothing schedules it yet' } } as StepResult
    const steps = stepsOf([formatStepLine(refused, SAMPLE.left_click)])
    expect(summarize([run({ calls: [call({ steps })] })])[0].sessionRefused).toBe(1)
  })

  it('keeps a line in no known shape as an unparsed failure', () => {
    expect(parseStepLine('a host line nobody wrote')).toBeNull()
    const steps = stepsOf(['a host line nobody wrote'])
    expect(steps[0]).toMatchObject({ action: null, ok: false })
    expect(summarize([run({ calls: [call({ steps })] })])[0].unparsed).toBe(1)
  })
})

// ── tools and faults ────────────────────────────────────────────────────

describe('runFault', () => {
  it('names a tool off the route, the budget passed and the front taken', () => {
    expect(toolKind('mcp__app__computer_act')).toBe('computer')
    expect(toolKind('app.computer_left_click')).toBe('computer')
    expect(toolKind('ToolSearch')).toBe('allowed')
    expect(toolKind('mcp__app__update_notes')).toBe('allowed')
    expect(toolKind('Bash')).toBe('other')
    // Muse's own reminder child session, as its driver names it (a Mac run of 2026-11-09 failed every Muse run on it)
    expect(toolKind('Reminder')).toBe('allowed')
    expect(runFault(run())).toBeNull()
    expect(runFault(run({ otherTools: ['Bash', 'Bash', 'mcp__codex__cua_repl'] }))).toBe('off-route: Bash, cua_repl')
    expect(runFault(run({ calls: calls(9), stepBudget: 6 }))).toBe('over budget: 9 calls of 6')
    expect(runFault(run({ front: { ...run().front, benchInFront: true } }))).toBe('took the front')
  })

  it('judges by the run’s own rule, so summarize and the runner say one thing (C1)', () => {
    // the gate's reference: never faulted, in either layer
    expect(runFault(run({ faultRule: 'reference', otherTools: ['Bash'], calls: calls(99), stepBudget: 6 }))).toBeNull()
    // the field set: off-route fails BOTH sides, budgets never apply, the front only for our runs
    expect(runFault(run({ faultRule: 'field', otherTools: ['Bash'] }))).toBe('off-route: Bash')
    expect(runFault(run({ faultRule: 'field-reference', otherTools: ['WebFetch'] }))).toBe('off-route: WebFetch')
    expect(runFault(run({ faultRule: 'field', calls: calls(99), stepBudget: 6 }))).toBeNull()
    expect(runFault(run({ faultRule: 'field-reference', calls: calls(99), stepBudget: 6 }))).toBeNull()
    expect(runFault(run({ faultRule: 'field', front: { ...run().front, benchInFront: true } }))).toBe('took the front')
    expect(runFault(run({ faultRule: 'field-reference', front: { ...run().front, benchInFront: true } }))).toBeNull()
    // summarize counts a faulted field run as failed, by the same rule
    const summaries = summarize([run({ faultRule: 'field', otherTools: ['Bash'], model: 'm' }), run({ faultRule: 'field-reference', calls: calls(99), stepBudget: 6, model: 'ref' })])
    expect(summaries.find((s) => s.model === 'm')?.passed).toBe(0)
    expect(summaries.find((s) => s.model === 'ref')?.passed).toBe(1)
  })
})

// ── summaries ───────────────────────────────────────────────────────────

describe('summarize', () => {
  it('takes medians of odd and even counts', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('takes host ms as the median of each run’s median', () => {
    const s = summarize([
      run({ calls: [call({ hostMs: 100 }), call({ hostMs: 300 }), call({ hostMs: 900 })] }),
      run({ attempt: 2, calls: [call({ hostMs: 50 })] }),
      run({ attempt: 3, calls: [call({ hostMs: 200 }), call({ hostMs: 220 })] })
    ])[0]
    expect(s.hostMsMedian).toBe(210)
    expect(s.callsMedian).toBe(2)
  })

  it('counts tiers, and screenshots asked apart from taken', () => {
    const s = summarize([
      run({
        calls: [
          call({ steps: [{ action: 'type', tier: null, via: 'keys', effect: 'changed', ok: true }], shots: 1 }),
          call({ screenshotAsked: true, shots: 1, steps: [{ action: 'left_click', tier: 'process', effect: 'none', ok: true }] }),
          call()
        ]
      })
    ])[0]
    expect(s.tiers).toEqual({ keys: 1, process: 1, ax: 1 })
    expect(s.shotsAskedMedian).toBe(1)
    expect(s.shotsTakenMedian).toBe(2)
  })

  it('keeps the skip’s line when every run was skipped', () => {
    const s = summarize([run({ outcome: 'skipped', reason: 'System Settings is open', calls: [] })])[0]
    expect(s).toMatchObject({ runs: 0, passed: 0, skipped: 'System Settings is open', callsMedian: null })
  })
})

// ── reruns ──────────────────────────────────────────────────────────────

describe('needsRerun', () => {
  it('reruns a failed end state, a margin broken, and nothing else', () => {
    expect(needsRerun(run(), row())).toBe(false)
    expect(needsRerun(run(), null)).toBe(false)
    expect(needsRerun(run({ outcome: 'failed', reason: 'text area holds ""' }), row())).toBe(true)
    expect(needsRerun(run({ otherTools: ['Bash'] }), null)).toBe(true)
    expect(needsRerun(run({ calls: calls(7) }), row())).toBe(true)
    expect(needsRerun(run({ calls: calls(6) }), row())).toBe(false)
    expect(needsRerun(run({ calls: calls(4, 251) }), row())).toBe(true)
    expect(needsRerun(run({ calls: calls(4, 250) }), row())).toBe(false)
    expect(needsRerun(run({ outcome: 'skipped', calls: [] }), row())).toBe(false)
  })
})

// ── judging ─────────────────────────────────────────────────────────────

describe('judgeBench', () => {
  it('passes a run at its baseline', () => {
    const j = judgeBench(report([run()]), base(row()))
    expect(j.ok).toBe(true)
    expect(verdict(j, 'end state, runs passed')).toMatchObject({ got: 1, limit: 1, ok: true })
    expect(verdict(j, 'median computer calls')).toMatchObject({ got: 4, limit: 6, ok: true })
    expect(verdict(j, 'median host ms per call')).toMatchObject({ got: 100, limit: 250, ok: true })
    expect(verdict(j, 'median wall s')).toMatchObject({ reportOnly: true })
    expect(verdict(j, 'median think s')).toMatchObject({ reportOnly: true })
  })

  it('fails an end state', () => {
    const j = judgeBench(report([run({ outcome: 'failed', reason: 'the text area holds ""' })]), base(row()))
    expect(j.ok).toBe(false)
    expect(verdict(j, 'end state, runs passed')).toMatchObject({ got: 0, ok: false })
  })

  it('takes the larger of the ratio and the plus for calls', () => {
    expect(callsLimit(4)).toBe(6)
    expect(callsLimit(10)).toBe(15)
    // past the plus while the ratio is the smaller limit
    expect(judgeBench(report([run({ calls: calls(7) })]), base(row())).ok).toBe(false)
    // past the ratio while the plus is the smaller limit
    const big = base(row({ callsMedian: 10 }))
    expect(judgeBench(report([run({ calls: calls(15), stepBudget: 20 })]), big).ok).toBe(true)
    expect(judgeBench(report([run({ calls: calls(16), stepBudget: 20 })]), big).ok).toBe(false)
  })

  it('takes the larger of the ratio and the plus for host ms', () => {
    expect(hostMsLimit(100)).toBe(250)
    expect(hostMsLimit(1000)).toBe(1300)
    expect(judgeBench(report([run({ calls: calls(4, 260) })]), base(row())).ok).toBe(false)
    const slow = base(row({ hostMsMedian: 1000 }))
    expect(judgeBench(report([run({ calls: calls(4, 1300) })]), slow).ok).toBe(true)
    expect(judgeBench(report([run({ calls: calls(4, 1310) })]), slow).ok).toBe(false)
  })

  it('judges a task with no baseline on its end state alone', () => {
    const j = judgeBench(report([run({ calls: calls(9), stepBudget: 10 })]), EMPTY_BASELINE)
    expect(j.ok).toBe(true)
    expect(verdict(j, 'median computer calls')).toBeUndefined()
    expect(verdict(j, 'median host ms per call')).toBeUndefined()
    expect(verdict(j, 'median wall s')).toBeUndefined()
  })

  it('ignores a row of another task version', () => {
    const j = judgeBench(report([run({ taskVersion: 2, calls: calls(9) })]), base(row({ taskVersion: 1 })))
    expect(j.ok).toBe(true)
    expect(verdict(j, 'median computer calls')).toBeUndefined()
  })

  it('passes two of three after reruns and fails one of three', () => {
    const fail = { outcome: 'failed' as const, reason: 'status "Submitted: Ana"' }
    const two = [run(fail), run({ attempt: 2 }), run({ attempt: 3 })]
    expect(passNeed(3)).toBe(2)
    expect(judgeBench(report(two), base(row())).ok).toBe(true)
    const one = [run(fail), run({ attempt: 2, ...fail }), run({ attempt: 3 })]
    const j = judgeBench(report(one), base(row()))
    expect(j.ok).toBe(false)
    expect(verdict(j, 'end state, runs passed')).toMatchObject({ got: 1, limit: 2 })
  })

  it('never fails a skipped lane or a skipped task', () => {
    const j = judgeBench(
      report([run({ task: 'settings-toggle', outcome: 'skipped', reason: 'System Settings is open', calls: [] })], {
        models: [{ model: 'claude-opus-5-5' }, { model: 'muse-wonder-1.0', skipped: 'not in this host’s Muse catalog' }]
      }),
      EMPTY_BASELINE
    )
    expect(j.ok).toBe(true)
    expect(j.verdicts).toEqual([])
    expect(j.skipped).toEqual(['muse-wonder-1.0: not in this host’s Muse catalog', 'claude-opus-5-5 settings-toggle: System Settings is open'])
  })

  it('fails a task the budget never reached, unless the scheduler held the runs', () => {
    const budget = judgeBench(report([run()], { unrun: [{ model: 'claude-opus-5-5', task: 'save-dialog', cause: 'budget' }] }), EMPTY_BASELINE)
    expect(budget.ok).toBe(false)
    expect(verdict(budget, "not reached before the bench's budget ran out")).toBeDefined()
    const held = judgeBench(report([run()], { unrun: [{ model: 'claude-opus-5-5', task: 'save-dialog', cause: 'scheduler' }] }), EMPTY_BASELINE)
    expect(held.ok).toBe(true)
    expect(held.skipped).toEqual(['claude-opus-5-5 save-dialog: not reached, the scheduler held the runs'])
  })

  it('fails a run that took the front, whatever its check said', () => {
    const j = judgeBench(report([run({ front: { ...run().front, after: 'com.apple.TextEdit', benchInFront: true } })]), EMPTY_BASELINE)
    expect(j.ok).toBe(false)
    expect(verdict(j, 'runs that took the front')).toMatchObject({ got: 1, ok: false })
  })

  it('fails off-route and over-budget runs on their end state', () => {
    expect(judgeBench(report([run({ otherTools: ['Bash'] })]), EMPTY_BASELINE).ok).toBe(false)
    const over = judgeBench(report([run({ calls: calls(11), stepBudget: 10 })]), EMPTY_BASELINE)
    expect(over.ok).toBe(false)
    expect(over.summaries[0].reasons).toEqual(['over budget: 11 calls of 10'])
  })
})

// ── the baseline ────────────────────────────────────────────────────────

describe('the baseline', () => {
  const dirs: string[] = []
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'computer-bench-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const passedAndFailed = report([
    run({ calls: calls(5, 120) }),
    run({ task: 'chrome-read', outcome: 'failed', reason: 'the reply lacks 41.20' }),
    run({ task: 'chrome-form', calls: calls(8) })
  ])

  it('a gate run writes only the rows it lacks, from tasks that passed', () => {
    const merged = mergeBaseline(base(row({ task: 'chrome-form', callsMedian: 6 })), passedAndFailed, { replace: false })
    expect(merged.rows.map((r) => [r.task, r.callsMedian])).toEqual([
      ['chrome-form', 6],
      ['textedit-write', 5]
    ])
    expect(merged.rows[1]).toMatchObject({ hostMsMedian: 120, commit: 'abcdef0123456789', at: passedAndFailed.endedAt })
  })

  it('replace rewrites every task that passed', () => {
    const merged = mergeBaseline(base(row({ task: 'chrome-form', callsMedian: 6 }), row({ task: 'chrome-read' })), passedAndFailed, { replace: true })
    expect(merged.rows.map((r) => [r.task, r.callsMedian])).toEqual([
      ['chrome-form', 8],
      ['chrome-read', 4],
      ['textedit-write', 5]
    ])
  })

  it('a report-only or reference run writes nothing, nor a hand run unless it replaces', () => {
    const b = base(row())
    for (const mode of ['report-only', 'reference'] as const) {
      expect(mergeBaseline(b, { ...passedAndFailed, mode }, { replace: false })).toBe(b)
      expect(mergeBaseline(b, { ...passedAndFailed, mode }, { replace: true })).toBe(b)
    }
    expect(mergeBaseline(b, { ...passedAndFailed, mode: 'hand' }, { replace: false })).toBe(b)
    expect(mergeBaseline(b, { ...passedAndFailed, mode: 'hand' }, { replace: true }).rows.map((r) => r.task)).toEqual(['chrome-form', 'textedit-write'])
  })

  it('is written by rename and read back', () => {
    const path = baselinePath(join(scratch(), 'temp-code-gate'))
    expect(path.endsWith(join('temp-code-gate', 'computer-bench', 'baseline.json'))).toBe(true)
    const b = base(row())
    writeBaseline(path, b)
    expect(readBaseline(path)).toEqual(b)
    expect(readdirSync(join(path, '..'))).toEqual(['baseline.json'])
  })

  it('reads a missing file as no rows and throws on one it cannot parse', () => {
    const dir = scratch()
    expect(readBaseline(join(dir, 'none.json'))).toEqual(EMPTY_BASELINE)
    const broken = join(dir, 'baseline.json')
    writeFileSync(broken, '{"version": 1, "rows": [')
    expect(() => readBaseline(broken)).toThrow(/--rebaseline/)
    writeFileSync(broken, JSON.stringify({ version: 1, rows: [{ model: 'x' }] }))
    expect(() => readBaseline(broken)).toThrow(broken)
    expect(existsSync(broken)).toBe(true)
  })
})

// ── the table ───────────────────────────────────────────────────────────

describe('renderBenchTable', () => {
  it('renders a recorded gate report', () => {
    const recorded = JSON.parse(readFileSync(join(__dirname, 'lib/fixtures/computer-bench/gate-report.json'), 'utf8')) as BenchReport
    const recordedBase = JSON.parse(readFileSync(join(__dirname, 'lib/fixtures/computer-bench/baseline.json'), 'utf8')) as Baseline
    const j = judgeBench(recorded, recordedBase)
    expect(renderBenchTable(recorded, j)).toMatchSnapshot()
  })
})

describe('BENCH_TIMING', () => {
  it('holds its numbers to the rule', () => {
    expect(BENCH_RULE.passOf).toBeLessThanOrEqual(1 + BENCH_RULE.reruns)
    expect(BENCH_TIMING.queueSkipMs).toBeLessThan(BENCH_TIMING.budgetMs)
  })
})

describe('benchOutcome', () => {
  it('passes a gate run with no baseline at all and has it write the first rows', () => {
    expect(benchOutcome({ mode: 'gate', ok: false, rebaseline: false, baselineRows: 0 })).toEqual({ fail: false, write: true, note: NO_BASELINE_LINE })
    expect(NO_BASELINE_LINE).toBe('no baseline, first run writes it')
    // the first rows come from the tasks that passed: mergeBaseline adds only those
    expect(mergeBaseline(EMPTY_BASELINE, report([run(), run({ task: 'chrome-read', outcome: 'failed', reason: 'x' })]), { replace: false }).rows.map((r) => r.task)).toEqual(['textedit-write'])
  })

  it('once rows exist, fails a red gate run and writes only a green one', () => {
    expect(benchOutcome({ mode: 'gate', ok: false, rebaseline: false, baselineRows: 3 })).toEqual({ fail: true, write: false, note: null })
    expect(benchOutcome({ mode: 'gate', ok: true, rebaseline: false, baselineRows: 3 })).toEqual({ fail: false, write: true, note: null })
    expect(benchOutcome({ mode: 'gate', ok: false, rebaseline: true, baselineRows: 3 })).toEqual({ fail: true, write: true, note: null })
  })

  it('a hand run fails on its verdict and writes only with --rebaseline; report-only and reference never', () => {
    expect(benchOutcome({ mode: 'hand', ok: false, rebaseline: false, baselineRows: 0 })).toEqual({ fail: true, write: false, note: null })
    expect(benchOutcome({ mode: 'hand', ok: true, rebaseline: true, baselineRows: 0 })).toEqual({ fail: false, write: true, note: null })
    for (const mode of ['report-only', 'reference'] as const)
      expect(benchOutcome({ mode, ok: false, rebaseline: false, baselineRows: 0 })).toEqual({ fail: false, write: false, note: null })
  })
})

describe('the Mac gate run of 2026-11-09, recorded', () => {
  const recorded = JSON.parse(readFileSync(join(__dirname, 'lib/fixtures/computer-bench/mac-gate-2026-11-09.json'), 'utf8')) as BenchReport

  it('reads back: Opus passed textedit-write and devapp-form, gpt-6.1-sol never reached its tools, and it failed with no baseline', () => {
    const j = judgeBench(recorded, EMPTY_BASELINE)
    const s = (model: string, task: string) => j.summaries.find((x) => x.model === model && x.task === task)!
    expect(s('claude-opus-5-5', 'textedit-write')).toMatchObject({ runs: 1, passed: 1, callsMedian: 2 })
    expect(s('claude-opus-5-5', 'devapp-form')).toMatchObject({ runs: 1, passed: 1, callsMedian: 8 })
    expect(j.summaries.filter((x) => x.model === 'gpt-6.1-sol').every((x) => x.callsMedian === 0 || x.runs === 0)).toBe(true)
    expect(j.ok).toBe(false)
    // under today's rule a first gate run with no baseline passes and writes the rows of the tasks that passed
    expect(benchOutcome({ mode: recorded.mode, ok: j.ok, rebaseline: false, baselineRows: 0 })).toMatchObject({ fail: false, write: true })
    expect(mergeBaseline(EMPTY_BASELINE, recorded, { replace: false }).rows.map((r) => `${r.model} ${r.task}`)).toEqual([
      'claude-opus-5-5 devapp-form',
      'claude-opus-5-5 textedit-write'
    ])
  })

  it('renders its table', () => {
    expect(renderBenchTable(recorded, judgeBench(recorded, EMPTY_BASELINE))).toMatchSnapshot()
  })
})
