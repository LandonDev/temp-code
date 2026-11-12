import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPUTER_ABORT_WORDS, COMPUTER_EFFECT_FACTS, COMPUTER_FAILURE_WORDS, COMPUTER_REFUSAL_WORDS, COMPUTER_ROUTE_WORDS } from '../statusWords'
import { HOST_ERROR_KINDS } from './hostErrors'
import { cutValue } from './observation'
import {
  READ_TEXT_MAX_BYTES,
  cutReadText,
  failureWords,
  frontFact,
  maskedTexts,
  mayQuoteText,
  planWords,
  plannedSteps,
  readSummary,
  refusalWords,
  resultFacts,
  scrubReadText,
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
    expect(target({ action: 'left_click', coordinate: [500, 300] })).toBe('at (500, 300)')
    expect(target({ action: 'left_click', menu: 'File > Save…' })).toBe('menu File › Save…')
    expect(target({ action: 'perform', name: 'pick', menu: 'Format › Font › Bold' })).toBe('menu Format › Font › Bold')
    expect(target({ action: 'scroll', scroll_direction: 'down', scroll_amount: 3, element: 5 })).toBe('down 3')
    expect(target({ action: 'left_click_drag', start_coordinate: [100, 200], coordinate: [300, 400] })).toBe('(100, 200) to (300, 400)')
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
    // into a field the book knows is a password field, not even its length
    expect(target(type({ element: 12 }))).toBe('a password')
    expect(target(type({ named: 'Subject' }))).toBe('15 characters')
    expect(target(type({}))).toBe('15 characters')
    expect(target(type({ element: 99 }))).toBe('15 characters')
    expect(bookless(type({ element: 33 }))).toBe('15 characters')
    expect(target({ action: 'set_value', value: 'x', element: 12 })).toBe('a password')
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
    // a combo is said in the Mac's own marks, a named key by its name
    for (const [text, said] of [['super+s', '⌘S'], ['Return', 'Return'], ['ctrl+a', '⌃A'], ['alt+x', '⌥X'], ['Tab', 'Tab'], ['super+shift+Return', '⇧⌘Return']])
      expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'key', text }, ctx)[0].object, text).toBe(said)
    const keys = { app: 'TextEdit', actions: [{ action: 'key', text: 'h' }, { action: 'key', text: 'super+Return' }] }
    expect(planWords('computer_batch', plannedSteps('computer_batch', keys, ctx))).toEqual(['Press a key', 'Press ⌘Return'])
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
        { action: 'select_text', text: secret, element: 3 },
        { action: 'key', text: 'c' }
      ]
    }
    const results = args.actions.map((a, index) => ({ ...ok(a.action as ComputerAction['action']), index }))
    const planned = plannedSteps('computer_batch', args, ctx)
    const written = JSON.stringify([planned, planWords('computer_batch', planned), settledSteps({ tool: 'computer_batch', args, ctx, results })])
    expect(written).not.toContain(secret)
    expect(written).not.toContain('horse')
    expect(written).toContain('21 characters')
    // every one of them is a text the kept read must not show either
    expect(maskedTexts('computer_batch', args, ctx)).toEqual([secret, secret, secret, secret, secret])
  })

  it('a selected text follows the rule: quoted for a known field with no input before it, else its length', () => {
    const select = { action: 'select_text', text: 'Hello', element: 3 } as ComputerAction
    expect(stepTargetWords([select], 0, book)).toBe('"Hello"')
    const after = [{ action: 'left_click', element: 44 } as ComputerAction, select]
    expect(stepTargetWords(after, 1, book)).toBe('5 characters')
    // a plan line is a row's words, which hold no text at all
    expect(planWords('computer_batch', plannedSteps('computer_batch', { app: 'TextEdit', actions: after }, ctx))).toEqual(['Click Save', 'Select text'])
    expect(maskedTexts('computer_batch', { app: 'TextEdit', actions: after }, ctx)).toEqual(['Hello'])
    expect(maskedTexts('computer_act', { app: 'TextEdit', ...select }, ctx)).toEqual([])
  })
})

describe('plannedSteps and planWords', () => {
  it('one step per action, present tense, with and without the app', () => {
    const steps = plannedSteps('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 44 }, { action: 'type', text: 'Total', element: 33 }, { action: 'key', text: 'super+s' }] }, ctx)
    expect(steps.map(({ asked: _asked, done: _done, ...step }) => step)).toEqual([
      { kind: 'click', verb: 'Clicking', object: 'Save', inApp: 'Save in TextEdit', target: 'a button in the "Save As" sheet', element: 44 },
      { kind: 'type', verb: 'Typing', object: 'into Subject', inApp: 'into Subject in TextEdit', target: '5 characters', element: 33 },
      { kind: 'key', verb: 'Pressing', object: '⌘S', inApp: '⌘S in TextEdit' }
    ])
    // the same rows as asked and as done, made now, from the book the model acted on
    expect(steps.map((step) => [step.asked.verb, step.done.verb])).toEqual([['Click', 'Clicked'], ['Type', 'Typed'], ['Press', 'Pressed']])
    expect(steps[0].asked).toEqual({ verb: 'Click', object: 'Save', inApp: 'Save in TextEdit' })
  })

  it('a read, a look and the apps call are one step each', () => {
    expect(plannedSteps('computer_observe', { app: 'TextEdit' }, ctx)).toMatchObject([{ kind: 'read', verb: 'Reading', object: '', inApp: 'TextEdit', asked: { verb: 'Read' }, done: { verb: 'Read' } }])
    expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'screenshot' }, ctx)).toMatchObject([{ kind: 'look', verb: 'Looking at', object: '', inApp: 'TextEdit', asked: { verb: 'Look at' } }])
    expect(plannedSteps('computer_apps', {}, { app: '' })).toMatchObject([{ kind: 'app', verb: 'Listing', object: 'apps', inApp: 'apps', asked: { verb: 'List', object: 'apps' } }])
    expect(plannedSteps('computer_apps', { launch: 'Preview', open: ['/Users/me/report.pdf'] }, { app: '' })).toMatchObject([
      { kind: 'app', verb: 'Opening', object: 'report.pdf in Preview', inApp: 'report.pdf in Preview', asked: { verb: 'Open', object: 'report.pdf in Preview' } }
    ])
    // what was asked of a bare launch is the launch
    expect(plannedSteps('computer_apps', { launch: 'TextEdit' }, { app: '' })[0]).toMatchObject({ verb: 'Listing', asked: { verb: 'Launch', object: 'TextEdit' } })
  })

  it("every action has a kind, and a batch's plan is its rows as asked", () => {
    expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'scroll', scroll_direction: 'down', scroll_amount: 3 }, ctx)[0]).toMatchObject({ kind: 'scroll', target: 'down 3' })
    expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'wait', duration: 2 }, ctx)[0].kind).toBe('wait')
    expect(plannedSteps('computer_act', { app: 'TextEdit', action: 'save_as', path: '~/a.txt' }, ctx)[0]).toMatchObject({ kind: 'type', target: '~/a.txt' })
    const batch = { app: 'Mail', actions: [{ action: 'left_click', element: 44 }, { action: 'type', text: 'Lunch?', element: 33 }, { action: 'key', text: 'super+Return' }] }
    // the plan is the rows the batch settles into, as what is asked: the list never says one step two ways
    const planned = plannedSteps('computer_batch', batch, ctx)
    expect(planWords('computer_batch', planned)).toEqual(['Click Save', 'Type into Subject', 'Press ⌘Return'])
    expect(planWords('computer_batch', planned)).toEqual(planned.map((step) => `${step.asked.verb} ${step.asked.object}`))
    // a single act and a batch of one have no plan line
    expect(planWords('computer_act', plannedSteps('computer_act', { app: 'Mail', action: 'left_click', element: 44 }, ctx))).toBeUndefined()
    expect(planWords('computer_batch', plannedSteps('computer_batch', { app: 'Mail', actions: [{ action: 'left_click', element: 44 }] }, ctx))).toBeUndefined()
  })

  it('a batch as one row reads Working in its app', () => {
    expect(workingStep('Mail', 'live')).toEqual({ kind: 'click', verb: 'Working', object: '', inApp: 'in Mail' })
    expect(workingStep('Mail', 'done')).toMatchObject({ verb: 'Worked', inApp: 'in Mail' })
    expect(workingStep('Mail', 'asked')).toMatchObject({ verb: 'Work', inApp: 'in Mail' })
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
        object: '⌘S',
        inApp: '⌘S in TextEdit',
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

  it('a step keeps the name its element had when the model acted, whatever the act renamed it to', () => {
    const renamed: WordsBook = { brief: (i) => (i === 44 ? { index: 44, line: 'button "Saved"' } : book.brief(i)), path: book.path }
    const steps = settledSteps({ tool: 'computer_batch', args: batch, ctx: { app: 'TextEdit', book: renamed }, planned, results: [ok('left_click')] })
    expect(steps[0]).toMatchObject({ verb: 'Clicked', object: 'Save' })
    // with no start record to go by, the words are made from the book as it is
    expect(settledSteps({ tool: 'computer_batch', args: batch, ctx: { app: 'TextEdit', book: renamed }, results: [ok('left_click')] })[0].object).toBe('Saved')
  })

  it('a step named by its name gets its element and its target from the result', () => {
    const args = { app: 'TextEdit', action: 'left_click', named: 'Save' }
    const steps = settledSteps({ tool: 'computer_act', args, ctx, planned: plannedSteps('computer_act', args, ctx), results: [ok('left_click', { resolved: 44, element: { index: 44, line: 'button "Save"' } })] })
    expect(steps[0]).toMatchObject({ verb: 'Clicked', object: 'Save', element: 44, target: 'a button in the "Save As" sheet' })
  })

  it('a failed step says why and the steps after it did not run: each reads as what was asked, never as done', () => {
    const steps = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, results: [ok('left_click'), failed('type', { kind: 'stale_element' }), { index: 2, action: 'key', status: 'not-run' }] })
    expect(steps.map((s) => [s.verb, s.state, s.reason])).toEqual([['Clicked', 'ok', undefined], ['Type', 'failed', 'The element was gone'], ['Press', 'not-run', undefined]])
  })

  it("the person's touch stops a step", () => {
    const steps = settledSteps({ tool: 'computer_act', args: { app: 'TextEdit', action: 'left_click', element: 44 }, ctx, results: [failed('left_click', { kind: 'interrupted', by: 'person' })] })
    expect(steps[0]).toMatchObject({ verb: 'Click', state: 'stopped', reason: 'Stopped when you used the mouse or keyboard' })
  })

  it('a refused call says so on its first step and leaves the rest not run', () => {
    const denied = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, refused: { kind: 'denied', line: 'denied: the person did not allow it' } })
    // the person's own no is a stop, never the red; nothing was clicked, so nothing reads as clicked
    expect(denied.map((s) => [s.verb, s.state, s.reason])).toEqual([
      ['Click', 'stopped', "You didn't allow it"],
      ['Type', 'not-run', undefined],
      ['Press', 'not-run', undefined]
    ])
    expect(settledSteps({ tool: 'computer_observe', args: { app: 'TextEdit' }, ctx, refused: { kind: 'service_unavailable', line: 'x' } })).toEqual([
      { kind: 'read', verb: 'Read', object: '', inApp: 'TextEdit', state: 'failed', reason: 'Computer use was off' }
    ])
    expect(settledSteps({ tool: 'computer_apps', args: { launch: 'TempCode' }, ctx: { app: '' }, refused: { kind: 'refused_app', line: 'x' } })[0]).toMatchObject({ verb: 'Launch', object: 'TempCode', state: 'failed', reason: 'That app is off limits' })
    const one = { app: 'TextEdit', action: 'left_click', element: 44 }
    expect(settledSteps({ tool: 'computer_act', args: one, ctx, refused: { kind: 'stopped', line: 'x' } })[0]).toMatchObject({ verb: 'Click', state: 'stopped', reason: 'Stopped' })
    // a pause, a cancel and the Away refusal are the thread's or the person's doing too
    for (const [kind, reason] of [['paused', COMPUTER_REFUSAL_WORDS.paused], ['cancelled', COMPUTER_REFUSAL_WORDS.cancelled], ['away', COMPUTER_REFUSAL_WORDS.away]] as const)
      expect(settledSteps({ tool: 'computer_act', args: one, ctx, refused: { kind, line: 'x' } })[0], kind).toMatchObject({ state: 'stopped', reason })
    // the host's own refusals are failures
    for (const kind of ['service_unavailable', 'refused_app', 'no_observation', 'session_refused'] as const)
      expect(settledSteps({ tool: 'computer_act', args: one, ctx, refused: { kind, line: 'x' } })[0].state, kind).toBe('failed')
  })

  it('a stop ends the call where it was: before any step, or after the ones that ran', () => {
    const before = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, abort: 'stopped' })
    expect(before.map((s) => [s.state, s.reason])).toEqual([['stopped', 'Stopped'], ['not-run', undefined], ['not-run', undefined]])
    const after = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, abort: 'interrupt', results: [ok('left_click'), { index: 1, action: 'type', status: 'not-run' }] })
    expect(after.map((s) => [s.state, s.reason])).toEqual([['ok', undefined], ['stopped', 'Stopped'], ['not-run', undefined]])
    // the step in flight answers cancelled: that is the stop
    const during = settledSteps({ tool: 'computer_batch', args: batch, ctx, planned, abort: 'paused', results: [ok('left_click'), failed('type', { kind: 'cancelled' })] })
    expect(during.map((s) => [s.state, s.reason])).toEqual([['ok', undefined], ['stopped', 'The thread was paused'], ['not-run', undefined]])
    // only the model's own cancel is the model's: an abort with no reason of its own reads as a plain cancel
    const one = { app: 'TextEdit', action: 'left_click', element: 44 }
    expect(settledSteps({ tool: 'computer_act', args: one, ctx, abort: 'cancel' })[0]).toMatchObject({ state: 'stopped', reason: 'The model cancelled it' })
    expect(settledSteps({ tool: 'computer_act', args: one, ctx, abort: 'aborted' })[0]).toMatchObject({ state: 'stopped', reason: 'Cancelled' })
    // a step still held for the Mac, or for the clipboard, when the call is stopped answers as the hold's own
    // refusal: it was stopped, and never reads as the one red with a reason that is not what happened
    const heldForMac = settledSteps({ tool: 'computer_act', args: one, ctx, abort: 'stopped', results: [failed('left_click', { kind: 'needs_tier', needed: 'session' })] })
    expect(heldForMac[0]).toMatchObject({ verb: 'Click', state: 'stopped', reason: 'Stopped' })
    const heldForCopy = settledSteps({ tool: 'computer_act', args: { app: 'TextEdit', action: 'paste', text: 'x', element: 33 }, ctx, abort: 'paused', results: [failed('paste', { kind: 'clipboard_busy', reason: 'recent-copy' })] })
    expect(heldForCopy[0]).toMatchObject({ state: 'stopped', reason: 'The thread was paused' })
    // with no abort the same refusals are what they say
    expect(settledSteps({ tool: 'computer_act', args: one, ctx, results: [failed('left_click', { kind: 'needs_tier', needed: 'session' })] })[0]).toMatchObject({ state: 'failed', reason: 'It needed your pointer and keyboard' })
    // Skip on the Run-now card is the person's own no
    const refusedBy = (reason: string) => settledSteps({ tool: 'computer_act', args: one, ctx, gate: { 0: reason }, results: [failed('left_click', { kind: 'needs_tier', needed: 'session' })] })[0]
    expect(refusedBy('skipped')).toMatchObject({ verb: 'Click', state: 'stopped', reason: 'Run now was not chosen' })
    expect(refusedBy('skipped-earlier')).toMatchObject({ state: 'stopped', reason: 'Run now was not chosen' })
    // the gate's reason is said as what it was: a locked screen, a sleeping Mac, are not "it needed your pointer"
    expect(refusedBy('screen-locked')).toMatchObject({ state: 'failed', reason: 'The screen was locked' })
    expect(refusedBy('asleep')).toMatchObject({ state: 'failed', reason: 'The Mac was asleep' })
    expect(refusedBy('no-scheduler')).toMatchObject({ state: 'failed', reason: 'It needed your pointer and keyboard' })
    // a step the gate refused before anything of it ran (the browser tab's hold) has no result of its own
    const batch2 = { app: 'TextEdit', actions: [{ action: 'left_click', element: 44 }, { action: 'key', text: 'super+s' }] }
    const tab = settledSteps({ tool: 'computer_batch', args: batch2, ctx, gate: { 1: 'skipped' }, results: [ok('left_click')], refused: { line: 'x' } })
    expect(tab.map((x) => [x.verb, x.state, x.reason])).toEqual([['Clicked', 'ok', undefined], ['Press', 'stopped', 'Run now was not chosen']])
    const alone = settledSteps({ tool: 'computer_act', args: one, ctx, gate: { 0: 'screen-locked' }, refused: { line: 'needs the session tier' } })
    expect(alone[0]).toMatchObject({ state: 'failed', reason: 'The screen was locked' })
    // an abort that came after every step answered marks nothing
    const late = settledSteps({ tool: 'computer_act', args: { app: 'TextEdit', action: 'left_click', element: 44 }, ctx, abort: 'stopped', results: [ok('left_click')] })
    expect(late[0].state).toBe('ok')
  })

  it('a focus that stopped a text step says which of its reasons it was: only one is a focus that moved', () => {
    const typed = { app: 'TextEdit', action: 'type', text: 'hunter2-long', named: 'Password' }
    const why = (reason: string): string | undefined =>
      settledSteps({ tool: 'computer_act', args: typed, ctx, results: [failed('type', { kind: 'focus_moved', reason } as never)] })[0].reason
    expect(why('secure')).toBe('A password field takes text only by its element')
    expect(why('browser-field')).toBe("The keys would have gone to the browser's own field")
    expect(why('unplanned')).toBe('Another field had the focus')
    expect(why('moved')).toBe(COMPUTER_FAILURE_WORDS.focus_moved)
  })

  it('a password field found only when the step ran keeps not even the length its plan had', () => {
    const typed = { app: 'TextEdit', action: 'type', text: 'hunter2-long', named: 'Password' }
    const planned = plannedSteps('computer_act', typed, ctx)
    // named by name, the book cannot know the field: the plan is a length
    expect(planned[0].target).toBe('12 characters')
    // the service refuses it as a password field and names the field: the row says a password
    const refused = settledSteps({ tool: 'computer_act', args: typed, ctx, planned, results: [failed('type', { kind: 'focus_moved', reason: 'secure', focused: { index: 12, line: 'password "Password"' } } as never)] })
    expect(refused[0]).toMatchObject({ state: 'failed', target: 'a password' })
    // and so does one that ran into it
    const ran = settledSteps({ tool: 'computer_act', args: typed, ctx, planned, results: [ok('type', { resolved: 12, element: { index: 12, line: 'password "Password"' } })] })
    expect(ran[0]).toMatchObject({ state: 'ok', target: 'a password' })
    // a plain field found the same way keeps its length
    const plain = settledSteps({ tool: 'computer_act', args: { ...typed, named: 'Subject' }, ctx, planned, results: [ok('type', { resolved: 33, element: { index: 33, line: 'input "Subject"' } })] })
    expect(plain[0].target).toBe('12 characters')
  })

  it('a later request of a split batch that fails leaves the steps the service already answered as they ran', () => {
    const three = { app: 'TextEdit', actions: [{ action: 'left_click', element: 44 }, { action: 'key', text: 'super+s' }, { action: 'key', text: 'Return' }] }
    // the first request answered; the app was gone before the second
    const steps = settledSteps({ tool: 'computer_batch', args: three, ctx, planned: plannedSteps('computer_batch', three, ctx), results: [ok('left_click')], error: { kind: 'window_minimized', message: 'm' } })
    expect(steps.map((x) => [x.verb, x.state])).toEqual([['Clicked', 'ok'], ['Press', 'failed'], ['Press', 'not-run']])
    expect(steps[1].reason).toBeTruthy()
  })

  it('results are read by their place: a step with no answer between one that ran and one the gate refused takes the call’s end', () => {
    const three = { app: 'TextEdit', actions: [{ action: 'left_click', element: 44 }, { action: 'key', text: 'super+s' }, { action: 'key', text: 'Return' }] }
    const base = { tool: 'computer_batch' as const, args: three, ctx, planned: plannedSteps('computer_batch', three, ctx) }
    const held = [ok('left_click'), { index: 1, action: 'key', status: 'not-run' }, failed('key', { kind: 'needs_tier', needed: 'session' })] as StepResult[]
    // the gate said no to the third before anything ran; the first answered; the second's request failed whole
    const steps = settledSteps({ ...base, results: held, gate: { 2: 'skipped' }, error: { kind: 'window_minimized', message: 'm' } })
    expect(steps.map((x) => [x.verb, x.state, x.reason])).toEqual([
      ['Clicked', 'ok', undefined],
      ['Press', 'failed', 'The window was minimized'],
      ['Press', 'stopped', 'Run now was not chosen']
    ])
    // a call that threw with no service error (the service went): the host's refusal ends the step with no answer
    const gone = settledSteps({ ...base, results: held.slice(0, 2), refused: { kind: 'service_restarted', line: 'x' }, threw: true })
    expect(gone.map((x) => [x.state, x.reason])).toEqual([['ok', undefined], ['failed', 'The computer service restarted'], ['not-run', undefined]])
    // without the throw a refusal after steps ran is still not the call's end
    expect(settledSteps({ ...base, results: held.slice(0, 2), refused: { kind: 'service_restarted', line: 'x' } }).map((x) => x.state)).toEqual(['ok', 'not-run', 'not-run'])
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
  it('a thin tree is the picture only when a picture reached the model; else it is the few elements it read', () => {
    expect(readSummary(observation('thin.txt'), true)).toEqual({ words: 'Looked at the picture', more: true })
    expect(readSummary('app "TC Probe" · window "TC Probe" · 720×364 · no changes · thin tree, see the screenshot', true)).toEqual({ words: 'Looked at the picture', more: false })
    expect(readSummary(observation('thin.txt')).words).toMatch(/^Read \d+ elements?$/)
    expect(readSummary('app "TC Probe" · window "TC Probe" · 720×364 · no changes · thin tree, see the screenshot')).toEqual({ words: 'Read no changes', more: false })
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

describe('scrubReadText', () => {
  const read = 'app "Chrome" · window "Keys"\n[48] input "API key" = "sk-live-1234"\n[49] text = "say \\"hi\\" twice"\n[50] text = "sk-live-1234 again"'
  it('a text the steps held back reads as its length wherever it stands', () => {
    expect(scrubReadText(read, ['sk-live-1234'])).toBe('app "Chrome" · window "Keys"\n[48] input "API key" = "‹12 characters›"\n[49] text = "say \\"hi\\" twice"\n[50] text = "‹12 characters› again"')
  })
  it('finds a text as the observation escapes it', () => {
    expect(scrubReadText(read, ['say "hi" twice'])).toContain('[49] text = "‹14 characters›"')
  })
  it('leaves the text alone with nothing held back, and never takes out a text of three characters or fewer', () => {
    expect(scrubReadText(read, [])).toBe(read)
    expect(scrubReadText(read, ['API', 'sk'])).toBe(read)
  })
  it('a long value the service cut goes whole too: its first characters are the start of the text held back', () => {
    const secret = `tok_${'a1b2c3d4'.repeat(25)}`
    // the service prints a value's first 160 scalars and how many more it has (observation.ts cutValue)
    const cut = cutValue(secret)
    expect(cut).toBe(`${secret.slice(0, 160)}…(+${secret.length - 160} chars)`)
    const read = `app "Chrome" · window "Keys"\n[48] input "Token" = ${JSON.stringify(cut)} focused\n[49] text = "kept"`
    const scrubbed = scrubReadText(read, [secret])
    expect(scrubbed).not.toContain('tok_')
    expect(scrubbed).not.toContain('a1b2c3d4')
    expect(scrubbed).toBe(`app "Chrome" · window "Keys"\n[48] input "Token" = "‹${secret.length} characters›" focused\n[49] text = "kept"`)
    // over its budget the service cuts shorter: any cut that is the text's start, with the count that fits, goes
    const short = `${secret.slice(0, 8)}…(+${secret.length - 8} chars)`
    expect(scrubReadText(`[48] input "Token" = ${JSON.stringify(short)}`, [secret])).toBe(`[48] input "Token" = "‹${secret.length} characters›"`)
    // with a quote or a newline in it the cut is still found, as the observation escapes it
    const odd = `say "hi"\n${'x'.repeat(200)}`
    expect(scrubReadText(`[9] text = ${JSON.stringify(cutValue(odd))}`, [odd])).toBe(`[9] text = "‹${[...odd].length} characters›"`)
    // a cut name ends in the ellipsis alone, and goes when it shows enough to be the text
    expect(scrubReadText(`[7] button ${JSON.stringify(`${secret.slice(0, 80)}…`)}`, [secret])).toBe(`[7] button "‹${secret.length} characters›"`)
    // a cut of some other text, or one whose count does not fit, is not the text held back
    const other = `[5] text = ${JSON.stringify(cutValue('z'.repeat(300)))}`
    expect(scrubReadText(other, [secret])).toBe(other)
    const wrong = `[5] text = ${JSON.stringify(`${secret.slice(0, 20)}…(+3 chars)`)}`
    expect(scrubReadText(wrong, [secret])).toBe(wrong)
    expect(scrubReadText('[6] button "Sa…"', ['Save for later'])).toBe('[6] button "Sa…"')
  })

  it('takes the longer text first, so one that holds another goes whole', () => {
    expect(scrubReadText('value = "abcdefgh"', ['abcd', 'abcdefgh'])).toBe('value = "‹8 characters›"')
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
