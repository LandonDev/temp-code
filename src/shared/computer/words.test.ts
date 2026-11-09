import { describe, expect, it } from 'vitest'
import { COMPUTER_ACTION_NAMES, NO_INPUT_ACTIONS, type ComputerAction, type ElementBrief, type StepResult } from './protocol'
import { NOT_EXECUTED_LINE, formatShotLine, formatStepLine } from './tools'
import {
  COMPUTER_SESSION_TOOL,
  actionWords,
  asFourTool,
  computerActivity,
  computerApprovalInput,
  computerApprovalTitle,
  computerPhrase,
  computerSessionAskTitle,
  computerToolOf,
  needsApproval,
  type TitleContext
} from './words'

const book: Record<number, string> = { 14: 'button "Save"', 33: 'input "Subject" focused', 31: 'button "To"', 5: 'scroll area', 12: 'password "Password"' }
const ctx = (over: Partial<TitleContext> = {}): TitleContext => ({
  appName: 'TextEdit',
  window: 'Untitled',
  element: (i): ElementBrief | null => (book[i] ? { index: i, line: book[i] } : null),
  ...over
})

describe('computerToolOf', () => {
  it('reads the app server prefix, the bare name and a per-verb name', () => {
    expect(computerToolOf('mcp__app__computer_act')).toEqual({ tool: 'computer_act' })
    expect(computerToolOf('computer_observe')).toEqual({ tool: 'computer_observe' })
    expect(computerToolOf('mcp__app__computer_left_click')).toEqual({ tool: 'computer_act', action: 'left_click' })
    expect(computerToolOf('computer_flail')).toBeNull()
    expect(computerToolOf('Read')).toBeNull()
  })
})

describe('needsApproval', () => {
  it('apps and observe never ask', () => {
    expect(needsApproval('computer_apps', {})).toEqual({ ask: false, confirm: null })
    expect(needsApproval('computer_observe', {})).toEqual({ ask: false, confirm: null })
  })
  it('an act asks in safe and edits unless its action sends no input, and never in full access unflagged', () => {
    for (const action of COMPUTER_ACTION_NAMES) {
      expect(needsApproval('computer_act', { action }).ask).toBe(!NO_INPUT_ACTIONS.includes(action))
      expect(needsApproval('computer_act', { action }, 'edits').ask).toBe(!NO_INPUT_ACTIONS.includes(action))
      expect(needsApproval('computer_act', { action }, 'auto').ask).toBe(false)
    }
  })
  it('a batch asks only with an acting step', () => {
    expect(needsApproval('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'wait' }, { action: 'zoom' }] }).ask).toBe(false)
    expect(needsApproval('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'key' }] }).ask).toBe(true)
  })
  it('a flag asks in every mode, full access included, and names the kind', () => {
    const confirm = { kind: 'send', what: 'Reply to Ana' } as const
    expect(needsApproval('computer_act', { action: 'left_click', confirm }, 'auto')).toEqual({ ask: true, confirm })
    expect(needsApproval('computer_batch', { actions: [{ action: 'left_click' }], confirm }, 'auto')).toEqual({ ask: true, confirm })
  })
  it("the host's password need asks in every mode and takes the card whole, never the model's words", () => {
    const password = { kind: 'password', what: '' } as const
    expect(needsApproval('computer_act', { action: 'type' }, 'auto', password)).toEqual({ ask: true, confirm: password })
    expect(needsApproval('computer_act', { action: 'type', confirm: { kind: 'personal_data', what: 'Sign in with hunter2' } }, 'auto', password)).toEqual({
      ask: true,
      confirm: password
    })
  })
})

describe('asFourTool', () => {
  it('makes a per-verb call computer_act with its action, keeping confirm', () => {
    const confirm = { kind: 'delete', what: 'x' }
    expect(asFourTool('mcp__app__computer_left_click', { app: 'Mail', element: 3, confirm })).toEqual({
      tool: 'computer_act',
      args: { app: 'Mail', element: 3, confirm, action: 'left_click' }
    })
    expect(asFourTool('computer_batch', { app: 'Mail' })).toEqual({ tool: 'computer_batch', args: { app: 'Mail' } })
    expect(asFourTool('Read', {})).toBeNull()
  })
})

describe('the card title', () => {
  it('names the element from the book, the app and the window', () => {
    expect(computerApprovalTitle('computer_act', { action: 'left_click', element: 14 } as ComputerAction, ctx())).toBe('Click button "Save" in TextEdit, window "Untitled"')
  })
  it('falls back to the index, and leaves out a window it does not know', () => {
    expect(computerApprovalTitle('computer_act', { action: 'left_click', element: 99 } as ComputerAction, ctx({ window: null }))).toBe('Click [99] in TextEdit')
  })
  it('types into a named input', () => {
    expect(
      computerApprovalTitle('computer_act', { action: 'type', text: 'Lunch?', element: 33 } as ComputerAction, ctx({ appName: 'Mail', window: 'New Message' }))
    ).toBe('Type "Lunch?" into input "Subject" in Mail, window "New Message"')
  })
  it('a batch counts and lists its acting steps alone', () => {
    const actions = [
      { action: 'screenshot' },
      { action: 'left_click', element: 31 },
      { action: 'type', text: 'Lunch?' },
      { action: 'wait', duration: 1 },
      { action: 'key', text: 'super+Return' }
    ] as ComputerAction[]
    const c = ctx({ appName: 'Mail', window: 'New Message' })
    expect(computerApprovalTitle('computer_batch', { actions }, c)).toBe('3 actions in Mail, window "New Message": click button "To", type "Lunch?", press super+Return')
    expect(computerApprovalInput('computer_batch', { actions }, c)).toEqual({ app: 'Mail', window: 'New Message', actions: ['click button "To"', 'type "Lunch?"', 'press super+Return'] })
  })
  it('says when the call is expected to take the pointer and keyboard', () => {
    expect(computerApprovalTitle('computer_act', { action: 'left_click', element: 14 } as ComputerAction, ctx(), null, { session: true })).toBe(
      'Click button "Save" in TextEdit, window "Untitled", using your pointer and keyboard'
    )
    const actions = [{ action: 'left_click', element: 31 }, { action: 'key', text: 'Tab' }] as ComputerAction[]
    expect(computerApprovalTitle('computer_batch', { actions }, ctx({ appName: 'Mail', window: null }), null, { session: true })).toBe(
      '2 actions in Mail, using your pointer and keyboard: click button "To", press Tab'
    )
  })
  it("names the held step's own card", () => {
    expect(COMPUTER_SESSION_TOOL).toBe('computer_session')
    expect(computerSessionAskTitle('click button "Save"', { appName: 'TextEdit', window: 'Untitled' })).toBe(
      'Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled"'
    )
    expect(computerSessionAskTitle('press Tab', { appName: 'Mail', window: null })).toBe('Use your pointer and keyboard to press Tab in Mail')
  })
  it('a batch with one acting step reads like one act', () => {
    const actions = [{ action: 'screenshot' }, { action: 'key', text: 'Tab', repeat: 4 }] as ComputerAction[]
    expect(computerApprovalTitle('computer_batch', { actions }, ctx())).toBe('Press Tab 4 times in TextEdit, window "Untitled"')
  })
})

describe('actionWords', () => {
  const words = (a: Partial<ComputerAction>): string => actionWords(a as ComputerAction, ctx())
  it('has a verb for every acting step', () => {
    expect(words({ action: 'right_click', element: 14 })).toBe('right-click button "Save"')
    expect(words({ action: 'double_click', coordinate: [5, 6] })).toBe('double-click at 5,6')
    expect(words({ action: 'triple_click' })).toBe('triple-click at the cursor')
    expect(words({ action: 'middle_click', element: 14, text: 'shift' })).toBe('middle-click button "Save" with shift')
    expect(words({ action: 'left_click_drag', start_element: 14, coordinate: [1, 2] })).toBe('drag button "Save" to 1,2')
    expect(words({ action: 'mouse_move', element: 14 })).toBe('point at button "Save"')
    expect(words({ action: 'mouse_move', coordinate: [3, 4] })).toBe('point at 3,4')
    expect(words({ action: 'left_mouse_down' })).toBe('press the mouse button')
    expect(words({ action: 'left_mouse_up' })).toBe('let go of the mouse button')
    expect(words({ action: 'scroll', scroll_direction: 'down', scroll_amount: 3, element: 5 })).toBe('scroll down 3 on scroll area')
    expect(words({ action: 'paste', text: 'hello', element: 33 })).toBe('paste "hello" into input "Subject"')
    expect(words({ action: 'hold_key', text: 'shift', duration: 2 })).toBe('hold shift for 2 s')
    expect(words({ action: 'set_value', element: 33, value: 'Hi' })).toBe('set input "Subject" to "Hi"')
    expect(words({ action: 'select_text', element: 33, text: 'Lu' })).toBe('select "Lu" in input "Subject"')
    expect(words({ action: 'select_text', element: 33, range: [0, 3] })).toBe('select 0..3 in input "Subject"')
    expect(words({ action: 'perform', element: 14, name: 'show menu' })).toBe('show menu button "Save"')
  })
  it('cuts typed text at 60 characters', () => {
    expect(words({ action: 'type', text: 'x'.repeat(80) })).toBe(`type "${'x'.repeat(60)}…"`)
  })
})

describe('computerPhrase', () => {
  const brief = (i: number): ElementBrief | null => (book[i] ? { index: i, line: book[i] } : null)
  const live = (tool: string, input: object, withBook = true) => computerPhrase(tool, input, { live: true, brief: withBook ? brief : undefined })
  const words = (p: ReturnType<typeof computerPhrase>): string => (p ? `${p.verb} ${p.object}${p.tally ? ` (${p.tally})` : ''}` : 'null')
  const header = (app: string) => `app ${JSON.stringify(app)} · window "Untitled" · 1280×800 · changes since your last read`
  const ok = (action: ComputerAction['action'], extra: object = {}): StepResult => ({ index: 0, action, status: 'ok', tier: 'ax', effect: 'changed', ...extra }) as StepResult
  /** A settled result as the host writes it: step lines, a shot line, a blank line, the observation. */
  const result = (pairs: [StepResult, ComputerAction][], app = 'TextEdit') =>
    [...pairs.map(([s, a]) => formatStepLine(s, a)), formatShotLine(1, 'observation', { path: '/w/0001.jpg', width: 1280, height: 800 }, true), '', header(app)].join('\n')
  const settled = (tool: string, input: object, text?: string) => computerPhrase(tool, input, { live: false, result: text })

  it('words the reads and the apps list both ways', () => {
    expect(words(live('mcp__app__computer_apps', {}))).toBe('Listing apps')
    expect(words(settled('computer_apps', {}, 'TextEdit (com.apple.TextEdit) · active'))).toBe('Listed apps')
    expect(words(live('computer_observe', { app: 'TextEdit' }))).toBe('Reading TextEdit')
    expect(words(settled('computer_observe', { app: 'com.apple.TextEdit' }, header('TextEdit')))).toBe('Read TextEdit')
  })

  it('names a clicked element from the book while it runs, and by its role with no name', () => {
    expect(words(live('computer_act', { app: 'TextEdit', action: 'left_click', element: 14 }))).toBe('Clicking Save in TextEdit')
    expect(words(live('computer_act', { app: 'TextEdit', action: 'left_click', element: 5 }))).toBe('Clicking a scroll area in TextEdit')
    expect(words(live('computer_act', { app: 'TextEdit', action: 'left_click', element: 33 }))).toBe('Clicking Subject in TextEdit')
    expect(words(live('computer_act', { app: 'TextEdit', action: 'left_click', element: 99 }))).toBe('Clicking in TextEdit')
    expect(words(live('computer_act', { app: 'TextEdit', action: 'left_click', element: 14 }, false))).toBe('Clicking in TextEdit')
    expect(words(live('computer_act', { app: 'TextEdit', action: 'left_click', coordinate: [5, 6] }))).toBe('Clicking in TextEdit')
    const forms: Record<string, string> = { right_click: 'Right-clicking', middle_click: 'Middle-clicking', double_click: 'Double-clicking', triple_click: 'Triple-clicking' }
    for (const [action, verb] of Object.entries(forms)) expect(words(live(`computer_${action}`, { app: 'TextEdit', element: 14 }))).toBe(`${verb} Save in TextEdit`)
  })

  it('names the element from the step line once settled, and the app from the header', () => {
    const input = { app: 'com.apple.TextEdit', action: 'left_click', element: 14 }
    const text = result([[ok('left_click', { element: { index: 14, line: 'button "Save"' } }), input as ComputerAction]])
    expect(words(settled('computer_act', input, text))).toBe('Clicked Save in TextEdit')
    expect(words(settled('computer_double_click', { app: 'TextEdit', element: 14 }, result([[ok('double_click', { element: { index: 14, line: 'button "Save"' } }), { action: 'double_click', element: 14 }]])))).toBe(
      'Double-clicked Save in TextEdit'
    )
    expect(words(settled('computer_act', { app: 'TextEdit', action: 'left_click', coordinate: [1, 2] }, result([[ok('left_click'), { action: 'left_click', coordinate: [1, 2] }]])))).toBe('Clicked in TextEdit')
    expect(words(settled('computer_act', input, 'stopped by the person'))).toBe('Clicked in com.apple.TextEdit')
  })

  it('words every row of the table, live and settled', () => {
    const rows: [Partial<ComputerAction>, StepResult, string, string][] = [
      [{ action: 'type', text: 'secret words', element: 33 }, ok('type', { element: { index: 33, line: 'input "Subject"' }, input: { via: 'ax-insert' } }), 'Typing into Subject in Mail', 'Typed into Subject in Mail'],
      [{ action: 'type', text: 'secret words' }, ok('type'), 'Typing in Mail', 'Typed in Mail'],
      [{ action: 'paste', text: 'https://example.com', element: 33 }, ok('paste', { element: { index: 33, line: 'input "Subject"' } }), 'Pasting into Subject in Mail', 'Pasted into Subject in Mail'],
      [{ action: 'key', text: 'super+Return' }, ok('key'), 'Pressing super+Return in Mail', 'Pressed super+Return in Mail'],
      [{ action: 'hold_key', text: 'shift', duration: 1 }, ok('hold_key'), 'Holding shift in Mail', 'Held shift in Mail'],
      [{ action: 'scroll', scroll_direction: 'down', scroll_amount: 3 }, ok('scroll'), 'Scrolling down in Mail', 'Scrolled down in Mail'],
      [{ action: 'left_click_drag', start_element: 14, coordinate: [1, 2] }, ok('left_click_drag'), 'Dragging in Mail', 'Dragged in Mail'],
      [{ action: 'mouse_move', element: 14 }, ok('mouse_move', { element: { index: 14, line: 'button "Save"' } }), 'Pointing at Save in Mail', 'Pointed at Save in Mail'],
      [{ action: 'mouse_move', coordinate: [1, 2] }, ok('mouse_move'), 'Moving the pointer in Mail', 'Moved the pointer in Mail'],
      [{ action: 'left_mouse_down' }, ok('left_mouse_down'), 'Pressing the mouse button in Mail', 'Pressed the mouse button in Mail'],
      [{ action: 'left_mouse_up' }, ok('left_mouse_up'), 'Letting go of the mouse button in Mail', 'Let go of the mouse button in Mail'],
      [{ action: 'set_value', element: 33, value: 'a private value' }, ok('set_value', { element: { index: 33, line: 'input "Subject"' } }), 'Setting Subject in Mail', 'Set Subject in Mail'],
      [{ action: 'select_text', element: 33, text: 'Lu' }, ok('select_text', { element: { index: 33, line: 'input "Subject"' } }), 'Selecting text in Mail', 'Selected text in Mail'],
      [{ action: 'perform', element: 9, name: 'show menu' }, ok('perform', { element: { index: 9, line: 'pop up "Font"' } }), 'Using Show Menu in Mail', 'Used Show Menu on Font in Mail'],
      [{ action: 'screenshot' }, ok('screenshot', { tier: null }), 'Looking at Mail', 'Looked at Mail'],
      [{ action: 'zoom', region: [1, 2, 3, 4] }, ok('zoom', { tier: null }), 'Zooming into Mail', 'Zoomed into Mail'],
      [{ action: 'wait', duration: 2 }, ok('wait', { tier: null }), 'Waiting on Mail', 'Waited on Mail'],
      [{ action: 'cursor_position' }, ok('cursor_position', { tier: null, text: 'X=1, Y=2' }), 'Finding the pointer in Mail', 'Found the pointer in Mail']
    ]
    for (const [action, step, now, then] of rows) {
      expect(words(live('computer_act', { app: 'Mail', ...action })), now).toBe(now)
      expect(words(settled('computer_act', { app: 'Mail', ...action }, result([[step, action as ComputerAction]], 'Mail'))), then).toBe(then)
    }
    expect(words(computerPhrase('computer_act', { app: 'Mail', action: 'type', text: 'x', element: 33 }, { live: true }))).toBe('Typing in Mail')
  })

  it('splits the verb from the object, keeping the fixed verb phrases whole', () => {
    expect(live('computer_act', { app: 'TextEdit', action: 'left_click', element: 14 })).toEqual({ verb: 'Clicking', object: 'Save in TextEdit' })
    expect(live('computer_act', { app: 'TextEdit', action: 'screenshot' })).toEqual({ verb: 'Looking at', object: 'TextEdit' })
    expect(settled('computer_act', { app: 'TextEdit', action: 'left_mouse_up' })).toEqual({ verb: 'Let go of', object: 'the mouse button in TextEdit' })
  })

  it('a batch with one acting step reads as that step, several as work in the app with a tally', () => {
    const one = { app: 'Mail', actions: [{ action: 'screenshot' }, { action: 'left_click', element: 14 }, { action: 'wait', duration: 1 }] }
    expect(words(live('computer_batch', one))).toBe('Clicking Save in Mail')
    const steps: [StepResult, ComputerAction][] = [
      [ok('screenshot', { tier: null }), { action: 'screenshot' }],
      [ok('left_click', { element: { index: 31, line: 'button "To"' } }), { action: 'left_click', element: 31 }],
      [ok('wait', { tier: null }), { action: 'wait', duration: 1 }]
    ]
    expect(words(settled('computer_batch', { app: 'Mail', actions: steps.map((p) => p[1]) }, result(steps, 'Mail')))).toBe('Clicked To in Mail')
    const many = { app: 'Mail', actions: [{ action: 'left_click', element: 31 }, { action: 'type', text: 'Lunch?' }, { action: 'key', text: 'super+Return' }] }
    expect(live('computer_batch', many)).toEqual({ verb: 'Working', object: 'in Mail', tally: '3 steps' })
    const ran: [StepResult, ComputerAction][] = [
      [ok('left_click'), many.actions[0] as ComputerAction],
      [{ index: 1, action: 'type', status: 'failed', error: { kind: 'timeout', message: 'no' } }, many.actions[1] as ComputerAction],
      [{ index: 2, action: 'key', status: 'not-run' }, many.actions[2] as ComputerAction]
    ]
    expect(result(ran)).toContain(NOT_EXECUTED_LINE)
    expect(settled('computer_batch', many, result(ran))).toEqual({ verb: 'Worked', object: 'in TextEdit', tally: '3 steps' })
    expect(words(live('computer_batch', { app: 'Mail', actions: [{ action: 'screenshot' }] }))).toBe('Looking at Mail')
  })

  it('never says typed text, a URL or a path', () => {
    const named: Record<number, string> = { 1: 'link "https://example.com/private"', 2: 'text "/Users/me/secret.txt"', 3: 'input "~/notes"' }
    for (const i of [1, 2, 3]) {
      const p = computerPhrase('computer_act', { app: 'Safari', action: 'left_click', element: i }, { live: true, brief: (k) => ({ index: k, line: named[k] }) })
      expect(words(p)).not.toMatch(/https|\/Users|~\//)
    }
    const typed = words(live('computer_act', { app: 'Mail', action: 'type', text: 'my password is hunter2', element: 33 }))
    expect(typed).not.toContain('hunter2')
  })

  it('ignores other tools and survives a call with no input yet', () => {
    expect(computerPhrase('mcp__app__update_notes', {}, { live: true })).toBeNull()
    expect(words(live('mcp__app__computer_act', undefined as unknown as object))).toBe('Using an app')
  })
})

describe('computerActivity', () => {
  it('is the live phrase joined, with the element from the host\'s book and its app name', () => {
    expect(computerActivity('mcp__app__computer_act', { app: 'textedit', action: 'left_click', element: 14 }, (i) => (book[i] ? { index: i, line: book[i] } : null), 'TextEdit')).toEqual({
      text: 'Clicking Save in TextEdit',
      kind: 'edit'
    })
    expect(computerActivity('mcp__app__computer_apps', {})).toEqual({ text: 'Listing apps', kind: 'investigate' })
    expect(computerActivity('mcp__app__computer_observe', { app: 'TextEdit' })).toEqual({ text: 'Reading TextEdit', kind: 'investigate' })
  })
  it('reads as investigate for a step that sends no input and edit for the rest, per-verb names alike', () => {
    for (const action of COMPUTER_ACTION_NAMES) {
      const a = computerActivity('mcp__app__computer_act', { app: 'TextEdit', action })
      expect(a?.kind, action).toBe(NO_INPUT_ACTIONS.includes(action) ? 'investigate' : 'edit')
      expect(computerActivity(`computer_${action}`, { app: 'TextEdit' })).toEqual(a)
    }
  })
  it('a batch edits when a step sends input', () => {
    expect(computerActivity('computer_batch', { app: 'Mail', actions: [{ action: 'key', text: 'a' }, { action: 'key', text: 'b' }] })).toEqual({ text: 'Working in Mail', kind: 'edit' })
    expect(computerActivity('computer_batch', { app: 'Mail', actions: [{ action: 'screenshot' }, { action: 'wait', duration: 1 }] })).toEqual({ text: 'Working in Mail', kind: 'investigate' })
  })
  it('survives a call with no input yet, and ignores other tools', () => {
    expect(computerActivity('mcp__app__computer_act', undefined)).toEqual({ text: 'Using an app', kind: 'edit' })
    expect(computerActivity('mcp__app__update_notes', {})).toBeNull()
  })
})

describe('a flagged card', () => {
  it('leads with the kind and keeps the step words while they fit', () => {
    const confirm = { kind: 'send' as const, what: "Reply to Ana accepting Friday's lunch" }
    const c = ctx({ appName: 'Mail', window: 'Re: Lunch' })
    expect(computerApprovalTitle('computer_act', { action: 'left_click', element: 14 } as ComputerAction, c, confirm)).toBe(
      'Send in Mail: Reply to Ana accepting Friday\'s lunch (click button "Save")'
    )
    expect(computerApprovalInput('computer_act', { action: 'left_click', element: 14 } as ComputerAction, c, confirm).confirm).toEqual({
      kind: 'send',
      label: 'Send',
      what: confirm.what
    })
  })

  it('never shows text going into a password field', () => {
    expect(actionWords({ action: 'type', text: 'hunter2', element: 12 } as ComputerAction, ctx())).toBe('type 7 characters into password "Password"')
    expect(actionWords({ action: 'set_value', value: 'hunter2', element: 12 } as ComputerAction, ctx())).toBe('set password "Password" to 7 characters')
    expect(actionWords({ action: 'paste', text: 'x' } as ComputerAction, ctx({ maskText: true }))).toBe('paste 1 character')
    expect(actionWords({ action: 'type', text: 'Lunch?', element: 33 } as ComputerAction, ctx())).toBe('type "Lunch?" into input "Subject"')
  })
})

