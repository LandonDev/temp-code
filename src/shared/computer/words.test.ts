import { describe, expect, it } from 'vitest'
import { COMPUTER_ACTION_NAMES, NO_INPUT_ACTIONS, type ComputerAction, type ElementBrief } from './protocol'
import { actionWords, computerActivity, computerApprovalInput, computerApprovalTitle, computerToolOf, needsApproval, type TitleContext } from './words'

const book: Record<number, string> = { 14: 'button "Save"', 33: 'input "Subject" focused', 31: 'button "To"', 5: 'scroll area' }
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
    expect(needsApproval('computer_apps', {})).toBe(false)
    expect(needsApproval('computer_observe', {})).toBe(false)
  })
  it('an act asks unless its action sends no input', () => {
    for (const action of COMPUTER_ACTION_NAMES) expect(needsApproval('computer_act', { action })).toBe(!NO_INPUT_ACTIONS.includes(action))
  })
  it('a batch asks only with an acting step', () => {
    expect(needsApproval('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'wait' }, { action: 'zoom' }] })).toBe(false)
    expect(needsApproval('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'key' }] })).toBe(true)
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
