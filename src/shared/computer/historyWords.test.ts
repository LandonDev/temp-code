import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPUTER_ABORT_WORDS, COMPUTER_EFFECT_FACTS, COMPUTER_FAILURE_WORDS, COMPUTER_REFUSAL_WORDS, COMPUTER_ROUTE_WORDS } from '../statusWords'
import { HOST_ERROR_KINDS } from './hostErrors'
import {
  READ_TEXT_MAX_BYTES,
  cutReadText,
  failureWords,
  frontFact,
  mayQuoteText,
  planWords,
  plannedSteps,
  readSummary,
  refusalWords,
  resultFacts,
  settledSteps,
  stepTargetWords,
  workingStep,
  type WordsBook
} from './historyWords'
import { COMPUTER_ERROR_KINDS, type ComputerAction, type ComputerError, type ElementBrief, type StepResult } from './protocol'
import { FALLBACK_VIAS } from './tools'

const fixtures = join(__dirname, '../../main/server/computer/fixtures')
const observation = (name: string): string => readFileSync(join(fixtures, 'observations', name), 'utf8').replace(/\n$/, '')
const appRead = (app: string, state: string): string => readFileSync(join(fixtures, 'apps', app, state, 'observation.txt'), 'utf8').replace(/\n$/, '')

/** A book of lines and parents, as ElementBook answers them. */
const lines: Record<number, { line: string; parent: number | null }> = {
  1: { line: 'window "Untitled"', parent: null },
  3: { line: 'text area = "Hello"', parent: 1 },
  5: { line: 'scroll area', parent: 1 },
  12: { line: 'password "Password"', parent: 41 },
  33: { line: 'input "Subject" focused', parent: 1 },
  41: { line: 'sheet "Save As"', parent: 1 },
  42: { line: 'group', parent: 41 },
  44: { line: 'button "Save"', parent: 42 },
  45: { line: 'button', parent: 42 }
}
const book: WordsBook = {
  brief: (i): ElementBrief | null => (lines[i] ? { index: i, line: lines[i].line } : null),
  path: (i) => {
    const out: ElementBrief[] = []
    for (let at = lines[i]?.parent ?? null; at !== null; at = lines[at]?.parent ?? null) out.push({ index: at, line: lines[at].line })
    return out
  }
}
const ctx = { app: 'TextEdit', book }
const ok = (action: ComputerAction['action'], extra: object = {}): StepResult => ({ index: 0, action, status: 'ok', tier: 'ax', effect: 'changed', ...extra }) as StepResult
const failed = (action: ComputerAction['action'], error: Partial<ComputerError> & { kind: ComputerError['kind'] }): StepResult => ({ index: 0, action, status: 'failed', error: { message: 'm', ...error } })
const target = (a: ComputerAction): string | undefined => stepTargetWords([a], 0, book)
/** The same with no book at all. */
const bookless = (a: ComputerAction): string | undefined => stepTargetWords([a], 0, undefined)

describe('stepTargetWords', () => {
  it('an element is its role and the nearest named ancestor that is not the window', () => {
    expect(target({ action: 'left_click', element: 44 })).toBe('a button in the "Save As" sheet')
    expect(target({ action: 'left_click', element: 33 })).toBe('an input')
    // an element with no name is already its role on the row: only where it sits is said
    expect(target({ action: 'left_click', element: 45 })).toBe('in the "Save As" sheet')
    expect(target({ action: 'left_click', element: 5 })).toBeUndefined()
    // an index the book lacks, or no book: nothing
    expect(target({ action: 'left_click', element: 99 })).toBeUndefined()
    expect(bookless({ action: 'left_click', element: 44 })).toBeUndefined()
  })

  it('a point, a menu path, a scroll, a drag and a save say theirs', () => {
    expect(target({ action: 'left_click', coordinate: [500, 300] })).toBe('at 500, 300')
    expect(target({ action: 'left_click', menu: 'File > Save…' })).toBe('menu File › Save…')
    expect(target({ action: 'perform', name: 'pick', menu: 'Format › Font › Bold' })).toBe('menu Format › Font › Bold')
    expect(target({ action: 'scroll', scroll_direction: 'down', scroll_amount: 3, element: 5 })).toBe('down 3')
    expect(target({ action: 'left_click_drag', start_coordinate: [100, 200], coordinate: [300, 400] })).toBe('100, 200 to 300, 400')
    expect(target({ action: 'left_click_drag', start_element: 3, element: 5 })).toBeUndefined()
    expect(target({ action: 'save_as', path: '~/run/Total.txt' })).toBe('~/run/Total.txt')
    expect(target({ action: 'right_click', element: 44 })).toBe('a button in the "Save As" sheet')
    expect(target({ action: 'perform', name: 'press', element: 44 })).toBe('a button in the "Save As" sheet')
  })

  it('a key, a wait and a look say nothing', () => {
    for (const a of [{ action: 'key', text: 'super+s' }, { action: 'hold_key', text: 'shift', duration: 1 }, { action: 'wait', duration: 1 }, { action: 'screenshot' }, { action: 'cursor_position' }] as ComputerAction[])
      expect(target(a), a.action).toBeUndefined()
  })

  it('a named target that resolved says the element it resolved to', () => {
    const a: ComputerAction = { action: 'left_click', named: 'Save' }
    expect(stepTargetWords([a], 0, book)).toBeUndefined()
    expect(stepTargetWords([a], 0, book, { index: 44, line: 'button "Save"' })).toBe('a button in the "Save As" sheet')
    // an element the book never held has no ancestors to name
    expect(stepTargetWords([a], 0, book, { index: 70, line: 'menu item "Save"' })).toBe('a menu item')
  })
})

describe('the secret rule', () => {
  const type = (extra: object): ComputerAction => ({ action: 'type', text: 'hunter2 is long', ...extra })

  it('text is written only for a field named by index that the book says is no password field', () => {
    expect(target(type({ element: 33 }))).toBe('"hunter2 is long"')
    expect(target({ action: 'paste', text: 'pasted', element: 33 })).toBe('"pasted"')
    expect(target({ action: 'set_value', value: 'Hi', element: 33 })).toBe('"Hi"')
    // a password field, a named target, no target, an index the book lacks, no book: the length alone
    expect(target(type({ element: 12 }))).toBe('15 characters')
    expect(target(type({ named: 'Subject' }))).toBe('15 characters')
    expect(target(type({}))).toBe('15 characters')
    expect(target(type({ element: 99 }))).toBe('15 characters')
    expect(bookless(type({ element: 33 }))).toBe('15 characters')
    expect(target({ action: 'set_value', value: 'x', element: 12 })).toBe('1 character')
  })

  it('text after an earlier step that sent input is a length, whatever it names', () => {
    const actions: ComputerAction[] = [{ action: 'left_click', element: 44 }, type({ element: 33 })]
    expect(mayQuoteText(actions, 1, book)).toBe(false)
    expect(stepTargetWords(actions, 1, book)).toBe('15 characters')
    // a step that sends no input before it changes nothing
    const still: ComputerAction[] = [{ action: 'screenshot' }, { action: 'wait', duration: 1 }, type({ element: 33 })]
    expect(mayQuoteText(still, 2, book)).toBe(true)
    expect(stepTargetWords(still, 2, book)).toBe('"hunter2 is long"')
  })

  it('a quoted text is cut at 60 characters', () => {
    expect(target({ action: 'type', text: 'x'.repeat(80), element: 33 })).toBe(`"${'x'.repeat(60)}…"`)
  })

  it('a bare printable key is "a key" in the planned step, the settled step and the plan', () => {
    for (const text of ['a', 'Z', '7', 'shift+a', '+', 'not a combo+']) {
      const args = { app: 'TextEdit', action: 'key', text }
      expect(plannedSteps('computer_act', args, ctx)[0], text).toMatchObject({ verb: 'Pressing', object: 'a key', inApp: 'a key in TextEdit' })
      expect(settledSteps({ tool: 'computer_act', args, ctx, results: [ok('key')] })[0], text).toMatchObject({ verb: 'Pressed', object: 'a key' })
    }
    for (const text of ['super+s', 'Return', 'ctrl+a', 'alt+x', 'Tab'])
      expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'key', text }, ctx)[0].object, text).toBe(text)
    const plan = planWords('computer_batch', { app: 'TextEdit', actions: [{ action: 'key', text: 'h' }, { action: 'key', text: 'super+Return' }] }, ctx)
    expect(plan).toEqual(['press a key', 'press super+Return'])
  })

  it('nothing a call holds reaches its steps or its plan unless the rule allows it', () => {
    const secret = 'correct horse battery'
    const args = {
      app: 'TextEdit',
      actions: [
        { action: 'left_click', element: 12 },
        { action: 'type', text: secret },
        { action: 'type', text: secret, element: 12 },
        { action: 'paste', text: secret, named: 'Password' },
        { action: 'set_value', value: secret, element: 12 },
        { action: 'key', text: 'c' }
      ]
    }
    const results = args.actions.map((a, index) => ({ ...ok(a.action as ComputerAction['action']), index }))
    const written = JSON.stringify([plannedSteps('computer_batch', args, ctx), planWords('computer_batch', args, ctx), settledSteps({ tool: 'computer_batch', args, ctx, results })])
    expect(written).not.toContain(secret)
    expect(written).not.toContain('horse')
    expect(written).toContain('21 characters')
  })
})

describe('plannedSteps and planWords', () => {
  it('one step per action, present tense, with and without the app', () => {
    const steps = plannedSteps('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 44 }, { action: 'type', text: 'Total', element: 33 }, { action: 'key', text: 'super+s' }] }, ctx)
    expect(steps).toEqual([
      { kind: 'click', verb: 'Clicking', object: 'Save', inApp: 'Save in TextEdit', target: 'a button in the "Save As" sheet', element: 44 },
      { kind: 'type', verb: 'Typing', object: 'into Subject', inApp: 'into Subject in TextEdit', target: '5 characters', element: 33 },
      { kind: 'key', verb: 'Pressing', object: 'super+s', inApp: 'super+s in TextEdit' }
    ])
  })

  it('a read, a look and the apps call are one step each', () => {
    expect(plannedSteps('computer_observe', { app: 'TextEdit' }, ctx)).toEqual([{ kind: 'read', verb: 'Reading', object: '', inApp: 'TextEdit' }])
    expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'screenshot' }, ctx)).toEqual([{ kind: 'look', verb: 'Looking at', object: '', inApp: 'TextEdit' }])
    expect(plannedSteps('computer_apps', {}, { app: '' })).toEqual([{ kind: 'app', verb: 'Listing', object: 'apps', inApp: 'apps' }])
    expect(plannedSteps('computer_apps', { launch: 'Preview', open: ['/Users/me/report.pdf'] }, { app: '' })).toEqual([
      { kind: 'app', verb: 'Opening', object: 'report.pdf in Preview', inApp: 'report.pdf in Preview' }
    ])
  })

  it("every action has a kind, and a batch's plan is the card's words", () => {
    expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'scroll', scroll_direction: 'down', scroll_amount: 3 }, ctx)[0]).toMatchObject({ kind: 'scroll', target: 'down 3' })
    expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'wait', duration: 2 }, ctx)[0].kind).toBe('wait')
    expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'save_as', path: '~/a.txt' }, ctx)[0]).toMatchObject({ kind: 'type', target: '~/a.txt' })
    const batch = { app: 'Mail', actions: [{ action: 'left_click', element: 44 }, { action: 'type', text: 'Lunch?', element: 33 }, { action: 'key', text: 'super+Return' }] }
    expect(planWords('computer_batch', batch, ctx)).toEqual(['click button "Save"', 'type 6 characters into input "Subject"', 'press super+Return'])
    // a single act and a batch of one have no plan line
    expect(planWords('computer_act', { app: 'Mail', action: 'left_click', element: 44 }, ctx)).toBeUndefined()
    expect(planWords('computer_batch', { app: 'Mail', actions: [{ action: 'left_click', element: 44 }] }, ctx)).toBeUndefined()
  })

  it('a batch as one row reads Working in its app', () => {
    expect(workingStep('Mail', true)).toEqual({ kind: 'click', verb: 'Working', object: '', inApp: 'in Mail' })
    expect(workingStep('Mail', false)).toMatchObject({ verb: 'Worked', inApp: 'in Mail' })
  })
})

describe('resultFacts', () => {
  const click: ComputerAction = { action: 'left_click', element: 44 }
  const facts = (extra: object, action: ComputerAction = click): string[] => resultFacts(ok(action.action, extra) as Extract<StepResult, { status: 'ok' }>, action)

  it('the plain case says nothing', () => {
    expect(facts({})).toEqual([])
    expect(facts({ input: { via: 'keys' } }, { action: 'type', text: 'a', element: 33 })).toEqual([])
  })

  it('each effect but changed is a fact', () => {
    expect(facts({ effect: 'none' })).toEqual(['nothing changed'])
    expect(facts({ effect: 'unknown' })).toEqual(["can't tell if it changed"])
    expect(facts({ effect: 'uncommitted', disk: { hint: 'commit it with key Return in the field' } })).toEqual(['on screen only, not on disk'])
    expect(Object.keys(COMPUTER_EFFECT_FACTS).sort()).toEqual(['none', 'uncommitted', 'unknown'])
  })

  it('the disk, an opened window and the route each say theirs', () => {
    expect(facts({ disk: { saved: '~/run/Total.txt' } })).toEqual(['saved ~/run/Total.txt'])
    expect(facts({ disk: { unknown: true } })).toEqual([])
    expect(facts({ opened: { id: 9, title: 'Untitled 2' } })).toEqual(['opened "Untitled 2"'])
    expect(facts({ input: { via: 'menu', on: 'File › Save…' } }, { action: 'key', text: 'super+s' })).toEqual(['through the menu File › Save…'])
    expect(facts({ input: { via: 'scroll-bar' } }, { action: 'scroll', scroll_direction: 'down', scroll_amount: 3 })).toEqual(['by the scroll bar'])
    expect(facts({ input: { via: 'pick' } }, { action: 'set_value', value: 'Large', element: 33 })).toEqual(['picked from its menu'])
    expect(facts({ input: { via: 'panel' }, disk: { saved: '~/a.txt' } }, { action: 'save_as', path: '~/a.txt' })).toEqual(['saved ~/a.txt', 'through the save panel'])
    // a menu target names its path already
    expect(facts({ input: { via: 'menu', on: 'File › Save…' } }, { action: 'left_click', menu: 'File > Save…' })).toEqual([])
  })

  it('every fallback route and the save panel have words', () => {
    for (const via of [...FALLBACK_VIAS, 'panel'] as const) expect(COMPUTER_ROUTE_WORDS[via as keyof typeof COMPUTER_ROUTE_WORDS]?.(), via).toMatch(/^[a-z]/)
    expect(COMPUTER_ROUTE_WORDS.menu()).toBe('through its menu item')
  })

  it('a wait that ran out says so, and a step that sends no input says nothing else', () => {
    expect(facts({ waited: { waitedMs: 1500, settled: false, busy: true, reason: 'max' } }, { action: 'wait', duration: 2 })).toEqual(['still changing after 1.5 s'])
    expect(facts({ waited: { waitedMs: 400, settled: true, busy: false, reason: 'quiet' } }, { action: 'wait', duration: 2 })).toEqual([])
    expect(facts({ effect: 'none' }, { action: 'screenshot' })).toEqual([])
  })

  it('the front guard is said to the person it happened to', () => {
    expect(frontFact('TextEdit', { raised: true, restored: 'restored', ms: 180 }, 'Safari')).toBe('TextEdit came to the front and Safari was put back')
    expect(frontFact('TextEdit', { raised: true, restored: 'restored' })).toBe('TextEdit came to the front and your app was put back')
    expect(frontFact('TextEdit', { raised: true, restored: 'person-chose' })).toBe('TextEdit came to the front because you chose it')
    expect(frontFact('TextEdit', { raised: true, restored: 'failed' })).toBe('TextEdit came to the front and could not be put back')
    expect(frontFact('TextEdit', { raised: true, restored: 'hid-app' })).toBe('TextEdit kept coming to the front and was hidden')
    expect(frontFact('TextEdit', { raised: false })).toBeNull()
    expect(frontFact('TextEdit', undefined)).toBeNull()
  })
})

describe('failureWords and refusalWords', () => {
  it('every error kind has a sentence of its own or the service’s first one', () => {
    for (const kind of COMPUTER_ERROR_KINDS) {
      const words = failureWords({ kind, message: 'the service said this; then that' })
      expect(words, kind).toMatch(/^[A-Z]/)
      expect(words, kind).not.toMatch(/[.;]$/)
      expect(words.length, kind).toBeLessThan(60)
    }
    // a kind with no line of its own reads the model's line up to its first `;`
    expect(COMPUTER_FAILURE_WORDS.not_initialized).toBeUndefined()
    expect(failureWords({ kind: 'not_initialized', message: 'x' })).toBe('The computer service is not ready')
    expect(failureWords({ kind: 'already_running', message: 'x' })).toBe('Another computer service is still stopping')
  })

  it('says the three the plan names, and what the data tells apart', () => {
    expect(failureWords({ kind: 'stale_element', message: 'm' })).toBe('The element was gone')
    expect(failureWords({ kind: 'timeout', message: 'm' })).toBe('The app did not answer')
    expect(failureWords({ kind: 'session_unavailable', message: 'm', reason: 'locked' })).toBe('The screen was locked')
    expect(failureWords({ kind: 'session_unavailable', message: 'm', reason: 'secure-input' })).toBe('A password field had the keyboard')
    expect(failureWords({ kind: 'session_unavailable', message: 'm' })).toBe('The screen could not be used')
    expect(failureWords({ kind: 'permission_missing', message: 'm', which: 'screenRecording' })).toBe('Screen Recording was off')
    expect(failureWords({ kind: 'permission_missing', message: 'm', which: 'accessibility' })).toBe('Accessibility was off')
    expect(failureWords({ kind: 'needs_tier', message: 'm', needed: 'front' })).toBe('It needed the app in front')
    expect(failureWords({ kind: 'needs_tier', message: 'm', needed: 'session' })).toBe('It needed your pointer and keyboard')
    expect(failureWords({ kind: 'named_target', message: 'm', reason: 'several' })).toBe('Several elements had that name')
    expect(failureWords({ kind: 'stale_element', message: 'm', reason: 'service-restarted' })).toBe('The computer service restarted')
    expect(failureWords({ kind: 'interrupted', message: 'm' })).toBe('Stopped when you used the mouse or keyboard')
  })

  it('every host refusal has a sentence, and a line with no kind reads its first one', () => {
    for (const kind of HOST_ERROR_KINDS) expect(refusalWords(kind), kind).toMatch(/^[A-Z][^.;]*$/)
    expect(Object.keys(COMPUTER_REFUSAL_WORDS).sort()).toEqual([...HOST_ERROR_KINDS].sort())
    expect(refusalWords('denied')).toBe("You didn't allow it")
    expect(refusalWords('service_unavailable')).toBe('Computer use was off')
    expect(refusalWords('refused_app')).toBe('That app is off limits')
    expect(refusalWords(undefined, 'only http, https and file items open; give a web page, a file or a folder')).toBe('Only http, https and file items open')
    expect(refusalWords(undefined, '')).toBe('It failed')
  })

  it('every abort reason the host words has a line', () => {
    for (const why of ['stopped', 'paused', 'interrupt', 'ended', 'settled', 'unread', 'superseded', 'cancel']) expect(COMPUTER_ABORT_WORDS[why], why).toMatch(/^[A-Z]/)
  })
})

describe('settledSteps', () => {
  const batch = { app: 'TextEdit', actions: [{ action: 'left_click', element: 44 }, { action: 'type', text: 'Total', element: 33 }, { action: 'key', text: 'super+s' }] }
  const planned = plannedSteps('computer_batch', batch, ctx)

  it('one step per action, past tense, with its tier, target and facts', () => {
    const steps = settledSteps({
      tool: 'computer_batch',
      args: batch,
      ctx,
      planned,
      results: [ok('left_click', { index: 0 }), ok('type', { index: 1, tier: 'process', effect: 'none' }), ok('key', { index: 2, tier: 'front', input: { via: 'menu', on: 'File › Save…' }, disk: { saved: '~/run/Total.txt' } })],
      waited: { waitedMs: 1500, settled: false, busy: true, reason: 'max' },
      front: { raised: true, restored: 'restored' },
      person: 'Safari'
    })
    expect(steps).toEqual([
      { kind: 'click', verb: 'Clicked', object: 'Save', inApp: 'Save in TextEdit', target: 'a button in the "Save As" sheet', element: 44, state: 'ok', tier: 'ax' },
      { kind: 'type', verb: 'Typed', object: 'into Subject', inApp: 'into Subject in TextEdit', target: '5 characters', element: 33, state: 'ok', tier: 'process', facts: ['nothing changed'] },
      {
        kind: 'key',
        verb: 'Pressed',
        object: 'super+s',
        inApp: 'super+s in TextEdit',
        state: 'ok',
        tier: 'front',
        facts: ['saved ~/run/Total.txt', 'through the menu File › Save…', 'still changing after 1.5 s', 'TextEdit came to the front and Safari was put back']
      }
    ])
  })

  it('a planned target outlives a closing read that cleared the book', () => {
    const empty: WordsBook = { brief: () => null, path: () => [] }
    const steps = settledSteps({ tool: 'computer_batch', args: batch, ctx: { app: 'TextEdit', book: empty }, planned, results: [ok('left_click')] })
    expect(steps[0].target).toBe('a button in the "Save As" sheet')
  })

  it('a failed step says why and the steps after it did not run', () => {
    const steps = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, results: [ok('left_click'), failed('type', { kind: 'stale_element' }), { index: 2, action: 'key', status: 'not-run' }] })
    expect(steps.map((s) => [s.state, s.reason])).toEqual([['ok', undefined], ['failed', 'The element was gone'], ['not-run', undefined]])
  })

  it("the person's touch stops a step", () => {
    const steps = settledSteps({ tool: 'computer_act', args: { app: 'TextEdit', action: 'left_click', element: 44 }, ctx, results: [failed('left_click', { kind: 'interrupted', by: 'person' })] })
    expect(steps[0]).toMatchObject({ state: 'stopped', reason: 'Stopped when you used the mouse or keyboard' })
  })

  it('a refused call says so on its first step and leaves the rest not run', () => {
    const denied = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, refused: { kind: 'denied', line: 'denied: the person did not allow it' } })
    expect(denied.map((s) => [s.verb, s.state, s.reason])).toEqual([
      ['Clicked', 'failed', "You didn't allow it"],
      ['Typed', 'not-run', undefined],
      ['Pressed', 'not-run', undefined]
    ])
    expect(settledSteps({ tool: 'computer_observe', args: { app: 'TextEdit' }, ctx, refused: { kind: 'service_unavailable', line: 'x' } })).toEqual([
      { kind: 'read', verb: 'Read', object: '', inApp: 'TextEdit', state: 'failed', reason: 'Computer use was off' }
    ])
    expect(settledSteps({ tool: 'computer_apps', args: { launch: 'TempCode' }, ctx: { app: '' }, refused: { kind: 'refused_app', line: 'x' } })[0]).toMatchObject({ verb: 'Listed', state: 'failed', reason: 'That app is off limits' })
    expect(settledSteps({ tool: 'computer_act', args: { app: 'TextEdit', action: 'left_click', element: 44 }, ctx, refused: { kind: 'stopped', line: 'x' } })[0]).toMatchObject({ state: 'stopped', reason: 'Stopped' })
  })

  it('a stop ends the call where it was: before any step, or after the ones that ran', () => {
    const before = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, abort: 'stopped' })
    expect(before.map((s) => [s.state, s.reason])).toEqual([['stopped', 'Stopped'], ['not-run', undefined], ['not-run', undefined]])
    const after = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, abort: 'interrupt', results: [ok('left_click'), { index: 1, action: 'type', status: 'not-run' }] })
    expect(after.map((s) => [s.state, s.reason])).toEqual([['ok', undefined], ['stopped', 'Stopped'], ['not-run', undefined]])
    // the step in flight answers cancelled: that is the stop
    const during = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, abort: 'paused', results: [ok('left_click'), failed('type', { kind: 'cancelled' })] })
    expect(during.map((s) => [s.state, s.reason])).toEqual([['ok', undefined], ['stopped', 'The thread was paused'], ['not-run', undefined]])
    // an abort that came after every step answered marks nothing
    const late = settledSteps({ tool: 'computer_act', args: { app: 'TextEdit', action: 'left_click', element: 44 }, ctx, abort: 'stopped', results: [ok('left_click')] })
    expect(late[0].state).toBe('ok')
  })

  it('a request that failed whole says the service’s kind', () => {
    const steps = settledSteps({ tool: 'computer_act', args: { app: 'TextEdit', action: 'left_click', element: 44 }, ctx, error: { kind: 'window_minimized', message: 'm' } })
    expect(steps[0]).toMatchObject({ state: 'failed', reason: 'The window was minimized' })
    // but a refusal after steps ran is not the call's end
    const ran = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, refused: { line: 'x' }, results: [ok('left_click')] })
    expect(ran.map((s) => s.state)).toEqual(['ok', 'not-run', 'not-run'])
  })

  it('a read and the apps call settle as one step', () => {
    expect(settledSteps({ tool: 'computer_observe', args: { app: 'TextEdit' }, ctx, waited: { waitedMs: 1000, settled: false, busy: false, reason: 'max' } })).toEqual([
      { kind: 'read', verb: 'Read', object: '', inApp: 'TextEdit', state: 'ok', facts: ['still changing after 1 s'] }
    ])
    expect(settledSteps({ tool: 'computer_apps', args: { launch: 'TextEdit' }, ctx: { app: '' }, launched: { launched: true, opened: false } })).toEqual([
      { kind: 'app', verb: 'Launched', object: 'TextEdit', inApp: 'TextEdit', state: 'ok' }
    ])
    expect(settledSteps({ tool: 'computer_apps', args: {}, ctx: { app: '' } })[0]).toMatchObject({ verb: 'Listed', object: 'apps', state: 'ok' })
  })

  it('a named step takes its resolved element for its target', () => {
    const args = { app: 'TextEdit', action: 'left_click', named: 'Save' }
    const steps = settledSteps({ tool: 'computer_act', args, ctx, planned: plannedSteps('computer_act', args, ctx), results: [ok('left_click', { resolved: 44, element: { index: 44, line: 'button "Save"' } })] })
    expect(steps[0]).toMatchObject({ verb: 'Clicked', object: 'Save', target: 'a button in the "Save As" sheet', element: 44 })
  })
})

describe('readSummary', () => {
  it('counts a full read’s elements, ranges included', () => {
    expect(readSummary(observation('full.txt'))).toEqual({ words: 'Read 40 elements', more: true })
  })
  it('counts a diff’s changes: each removed, changed or added group once', () => {
    expect(readSummary(observation('diff.txt'))).toEqual({ words: 'Read 5 changes', more: true })
    expect(readSummary('app "TextEdit" · window "Untitled" · 1280×1072 · changes since your last read\n~ [3] text area = "x"')).toEqual({ words: 'Read 1 change', more: true })
  })
  it('an unchanged read is its header alone', () => {
    expect(readSummary(observation('unchanged.txt'))).toEqual({ words: 'Read no changes', more: false })
  })
  it('a thin tree is the picture', () => {
    expect(readSummary(observation('thin.txt'))).toEqual({ words: 'Looked at the picture', more: true })
    expect(readSummary('app "TC Probe" · window "TC Probe" · 720×364 · no changes · thin tree, see the screenshot')).toEqual({ words: 'Looked at the picture', more: false })
  })
  it('a loading page and one not drawn say so', () => {
    expect(readSummary(observation('loading.txt')).words).toMatch(/^Read \d+ elements, still loading$/)
    expect(readSummary(appRead('chrome', 'not-drawn')).words).toMatch(/^Read \d+ elements, page not drawn$/)
  })
  it('the recorded apps read as elements', () => {
    for (const [app, state] of [['textedit', 'doc'], ['textedit', 'save-sheet'], ['chrome', 'form'], ['chrome', 'menu-open'], ['finder', 'folder']])
      expect(readSummary(appRead(app, state)).words, `${app}/${state}`).toMatch(/^Read \d+ elements$/)
  })
  it('a text off the grammar still says something', () => {
    expect(readSummary('not an observation\nat all')).toEqual({ words: 'Read the window', more: true })
    expect(readSummary('nope')).toEqual({ words: 'Read the window', more: false })
  })
})

describe('cutReadText', () => {
  it('keeps a text within the budget whole', () => {
    const text = observation('full.txt')
    expect(cutReadText(text)).toBe(text)
  })
  it('cuts at a line, on a character, and says how much it left out', () => {
    const line = '[1] text "héllo wörld — ünïcode"'
    const text = Array.from({ length: 2000 }, () => line).join('\n')
    const cut = cutReadText(text)
    const rows = cut.split('\n')
    const kept = rows.length - 1
    expect(new TextEncoder().encode(rows.slice(0, -1).join('\n')).length).toBeLessThanOrEqual(READ_TEXT_MAX_BYTES)
    for (const row of rows.slice(0, -1)) expect(row).toBe(line)
    expect(rows.at(-1)).toBe(`… cut here, ${2000 - kept} more lines`)
    expect(cut).not.toContain('�')
  })
  it('a single long line is cut inside it, never inside a character', () => {
    const cut = cutReadText('é'.repeat(10), 5)
    expect(cut.split('\n')[0]).toBe('éé')
    expect(cut).not.toContain('�')
    expect(cut.split('\n')[1]).toBe('… cut here, 1 more line')
  })
})
