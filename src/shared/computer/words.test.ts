import { describe, expect, it } from 'vitest'
import { COMPUTER_ACTION_NAMES, NO_INPUT_ACTIONS, type ComputerAction, type ElementBrief } from './protocol'
import { actionWords, asFourTool, computerActivity, computerApprovalInput, computerApprovalTitle, computerToolOf, needsApproval, type TitleContext } from './words'

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

describe('computerActivity', () => {
  it('says the two reads and the apps list', () => {
    expect(computerActivity('mcp__app__computer_apps', {})).toEqual({ text: 'Listing apps', kind: 'investigate' })
    expect(computerActivity('mcp__app__computer_observe', { app: 'TextEdit' })).toEqual({ text: 'Reading TextEdit', kind: 'investigate' })
  })
  it('words every action, reads as investigate and the rest as edit', () => {
    const expected: Record<string, string> = {
      screenshot: 'Looking at',
      zoom: 'Looking at',
      left_click: 'Clicking in',
      right_click: 'Clicking in',
      middle_click: 'Clicking in',
      double_click: 'Clicking in',
      triple_click: 'Clicking in',
      left_click_drag: 'Dragging in',
      mouse_move: 'Pointing in',
      left_mouse_down: 'Clicking in',
      left_mouse_up: 'Clicking in',
      cursor_position: 'Looking at',
      scroll: 'Scrolling in',
      type: 'Typing in',
      key: 'Pressing keys in',
      hold_key: 'Pressing keys in',
      wait: 'Waiting on',
      set_value: 'Setting a value in',
      perform: 'Using',
      select_text: 'Selecting text in',
      paste: 'Pasting in'
    }
    for (const action of COMPUTER_ACTION_NAMES) {
      const a = computerActivity('mcp__app__computer_act', { app: 'TextEdit', action })
      expect(a).toEqual({ text: `${expected[action]} TextEdit`, kind: NO_INPUT_ACTIONS.includes(action) ? 'investigate' : 'edit' })
      expect(computerActivity(`computer_${action}`, { app: 'TextEdit' })).toEqual(a)
    }
  })
  it('a batch is working in the app, a read-only one investigates', () => {
    expect(computerActivity('computer_batch', { app: 'Mail', actions: [{ action: 'key', text: 'a' }] })).toEqual({ text: 'Working in Mail', kind: 'edit' })
    expect(computerActivity('computer_batch', { app: 'Mail', actions: [{ action: 'screenshot' }] })).toEqual({ text: 'Working in Mail', kind: 'investigate' })
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

