import { describe, expect, it } from 'vitest'
import { COMPUTER_ERROR_WORDS, ERROR_LINE_MAX, errorLine } from './errorWords'
import { COMPUTER_ERROR_KINDS, type ComputerAction, type ComputerError, type ComputerErrorKind } from './protocol'

const SERVICE = 'the service said so'
const err = (kind: ComputerErrorKind, data: Partial<ComputerError> = {}): ComputerError => ({ kind, message: SERVICE, ...data })

/** The richest data each kind carries on the wire. */
const SAMPLES: Record<ComputerErrorKind, Partial<ComputerError>> = {
  not_initialized: {},
  open_refused: { reason: 'executable' },
  protocol_mismatch: {},
  permission_missing: { which: 'accessibility' },
  unknown_session: {},
  app_not_found: { candidates: ['Xcode', 'Xcode-beta'] },
  window_not_found: { candidates: ['Inbox', 'New Message'] },
  window_minimized: {},
  stale_element: { element: 12, reason: 'gone' },
  no_such_element: { element: 12 },
  action_unsupported: { element: 12, available: ['show menu', 'press'] },
  needs_tier: { needed: 'session' },
  out_of_bounds: { coordinate: [1400, 300], space: { width: 1280, height: 800, scale: 2 } },
  invalid_key: {},
  interrupted: { by: 'person' },
  app_busy: {},
  cancelled: {},
  clipboard_busy: {},
  capture_failed: {},
  timeout: {},
  text_not_found: { element: 12 },
  key_window_unavailable: { keyWindow: { id: 4, title: 'Inbox' } },
  session_unavailable: { reason: 'locked' },
  already_running: {},
  value_not_taken: { element: 19, value: 'Choose a plan' },
  focus_moved: { element: 9, reason: 'browser-field', focused: { index: 9, line: 'input "Address and search bar"' } },
  tab_in_use: {},
  named_target: { reason: 'several', elementCandidates: [{ index: 52, line: 'menu item "Team"' }, { index: 9, line: 'button "Team"' }] },
}

describe('the error words', () => {
  it('word every kind of the wire as one line within the budget, never the service’s message', () => {
    for (const kind of COMPUTER_ERROR_KINDS) {
      expect(COMPUTER_ERROR_WORDS[kind], kind).toBeTypeOf('function')
      for (const data of [{}, SAMPLES[kind]]) {
        const line = errorLine(err(kind, data), { app: 'Mail', window: 'Draft', action: { action: 'key', text: 'Enter2' } })
        expect(line, kind).not.toContain('\n')
        expect(line.length, kind).toBeLessThanOrEqual(ERROR_LINE_MAX)
        if (kind === 'action_unsupported' && !('available' in data)) expect(line).toBe(SERVICE)
        else expect(line, kind).not.toBe(SERVICE)
      }
    }
  })

  it('word the web content kinds (§25)', () => {
    expect(errorLine(err('value_not_taken', SAMPLES.value_not_taken))).toBe(
      '[19] still reads "Choose a plan"; nothing after it ran. On a pop up, click it and perform pick on the item; on a field, type with element'
    )
    expect(errorLine(err('focus_moved', SAMPLES.focus_moved))).toBe(
      'the keys would go to [9] input "Address and search bar", not the page; name the element they are for'
    )
    expect(errorLine(err('focus_moved', { ...SAMPLES.focus_moved, reason: 'moved' }))).toBe(
      'the focus moved to [9] input "Address and search bar" since your read; name the element the keys are for'
    )
    expect(errorLine(err('tab_in_use'), { app: 'Google Chrome' })).toBe(
      "the person has Google Chrome's window in front on another tab, so a read won't switch it; switch tabs with an act, which waits for the Mac to be free"
    )
  })

  it('fall back to the service’s message for a kind the table lacks', () => {
    expect(errorLine({ kind: 'brand_new' as ComputerErrorKind, message: SERVICE })).toBe(SERVICE)
  })

  it('read the draft table', () => {
    expect(errorLine(err('stale_element', { element: 12, reason: 'gone' }))).toBe('[12] is gone from the window; read it again and use the new index')
    expect(errorLine(err('stale_element', { element: 12, reason: 'service-restarted' }))).toBe(
      'the computer service restarted, so every index is stale; read the window again'
    )
    expect(errorLine(err('no_such_element', { element: 12 }))).toBe("[12] was never in this window's tree; read it again")
    expect(errorLine(err('out_of_bounds', SAMPLES.out_of_bounds))).toBe("1400,300 is outside the window's 1280×800 picture; aim inside it or take a new screenshot")
    expect(errorLine(err('permission_missing', { which: 'screenRecording' }))).toContain('Screen Recording')
    expect(errorLine(err('session_unavailable', { reason: 'secure-input' }))).toContain('secure input is on')
  })

  it('take the query, the window, the key and the text from the call', () => {
    expect(errorLine(err('app_not_found', SAMPLES.app_not_found), { app: 'Xcod' })).toBe(
      'no app matches "Xcod"; close names: Xcode, Xcode-beta (computer_apps lists them all)'
    )
    expect(errorLine(err('window_not_found', SAMPLES.window_not_found), { app: 'Mail', window: 'Draft' })).toBe(
      'no window of Mail matches "Draft"; its windows: "Inbox", "New Message"'
    )
    // a window that closed, or an app that quit, says so in the service's own words (§22.6)
    expect(errorLine({ kind: 'window_not_found', message: 'TC Probe quit.', reason: 'gone' }, { app: 'TC Probe' })).toBe('TC Probe quit.')
    expect(errorLine({ kind: 'window_not_found', message: 'TextEdit has no window open.', candidates: [], reason: 'gone' }, { app: 'TextEdit' })).toBe(
      'TextEdit has no window open.'
    )
    expect(errorLine(err('invalid_key'), { action: { action: 'key', text: 'Enter2' } })).toBe(
      'no key named "Enter2"; use xdotool names such as Return, Tab, Escape, super+c'
    )
    const select = { action: 'select_text', element: 12, text: 'Friday' } as ComputerAction
    expect(errorLine(err('text_not_found'), { action: select })).toBe('no "Friday" in [12]; read its text with computer_observe element 12')
    const perform = { action: 'perform', element: 12, name: 'expand' } as ComputerAction
    expect(errorLine(err('action_unsupported', SAMPLES.action_unsupported), { action: perform })).toBe('[12] can\'t do "expand"; it lists: show menu, press')
    expect(errorLine(err('timeout'), { app: 'Mail' })).toBe('Mail did not answer within 2 s and may be hung; try again, or work in another window')
  })

  it('cut a long list of names to fit', () => {
    const candidates = Array.from({ length: 40 }, (_, i) => `Some App Number ${i}`)
    const line = errorLine(err('app_not_found', { candidates }), { app: 'Some' })
    expect(line.length).toBeLessThanOrEqual(ERROR_LINE_MAX)
    expect(line).toContain('…')
    expect(line).toMatch(/\(computer_apps lists them all\)$/)
  })
})

describe('fewer calls (§27)', () => {
  const field = { index: 6, line: 'text field "Name"' }
  const lines = (): string[] => [
    errorLine(err('focus_moved', { element: 6, reason: 'unplanned', focused: field })),
    errorLine(err('window_not_found', { candidates: ['Other'] }), { app: 'Renamey', window: 'Other', step: true }),
    errorLine(err('focus_moved', { reason: 'unplanned' })),
    errorLine(err('focus_moved', { element: 12, reason: 'secure', focused: { index: 12, line: 'password "Password"' } })),
    errorLine(err('focus_moved', { element: 12, reason: 'secure' })),
    errorLine(err('named_target', { reason: 'no-match' }), { action: { action: 'left_click', named: 'Team' } as ComputerAction }),
    errorLine(err('named_target', SAMPLES.named_target), { action: { action: 'left_click', named: 'Team' } as ComputerAction }),
    errorLine(err('named_target', { reason: 'no-match' }), { action: { action: 'left_click', menu: 'File > Save…' } as ComputerAction })
  ]

  it('word a focus no step aimed at, a step’s window the thread did not read, a password field and a named target', () => {
    expect(lines()).toEqual([
      '[6] text field "Name" has the focus, which no step of this batch aimed at; name the element the text is for',
      'read Renamey\'s window "Other" before typing into it',
      'another element has the focus, which no step of this batch aimed at; name the element the text is for',
      '[12] password "Password" can only be typed into by its element, so the person can be asked; send the step again with element 12',
      '[12] can only be typed into by its element, so the person can be asked; send the step again with element 12',
      'nothing named "Team" in the window or what this call opened; read the window and use an element',
      'several elements are named "Team"; use element: [52] menu item "Team", [9] button "Team"',
      'the menu bar has no item "File > Save…"; read it with menus: true and use an element'
    ])
  })

  it('keep every line whole: within the budget, no double space, a long candidate cut at a word', () => {
    const long = Array.from({ length: 5 }, (_, i) => ({ index: 60 + i, line: `menu item "${'Export to a very long format name '.repeat(2)}${i}"` }))
    const all = [...lines(), errorLine(err('named_target', { reason: 'several', elementCandidates: long }), { action: { action: 'left_click', named: 'Export' } as ComputerAction })]
    for (const line of all) {
      expect(line.length, line).toBeLessThanOrEqual(ERROR_LINE_MAX)
      expect(line, line).not.toMatch(/ {2}/)
      expect(line, line).not.toMatch(/^ | $/)
    }
    expect(all.at(-1)).toMatch(/, …$|…"$/)
  })
})

describe('a disabled menu item (§24.2)', () => {
  it('in the background waits for the Mac; with the app in front it says to try another way', () => {
    const background = err('needs_tier', { needed: 'session', menu: ['File', 'Close'] })
    expect(errorLine(background, { app: 'TextEdit' })).toBe('File › Close is disabled while TextEdit is in the background; it runs when the Mac is free')
    expect(errorLine(err('action_unsupported', { menu: ['Edit', 'Select All'] }))).toBe('Edit › Select All is disabled now; try another way')
    // long titles stay inside a line
    const long = err('needs_tier', { needed: 'session', menu: ['x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100)] })
    expect(errorLine(long, { app: 'a'.repeat(30) }).length).toBeLessThanOrEqual(ERROR_LINE_MAX)
  })
})

describe('open_refused', () => {
  it('names the one item the call opened, and words a refusal of several without one', () => {
    const open = (reason: ComputerError['reason'], items: string[]): string => errorLine(err('open_refused', { reason }), { open: items })
    expect(open('executable', ['/Users/me/deploy.command'])).toBe('deploy.command is a program; open only opens documents, folders and web pages')
    expect(open('executable', ['/a.txt', '/b.command'])).toBe('an item is a program; open only opens documents, folders and web pages')
    expect(open('missing', ['/tmp/gone.pdf'])).toBe('no file at "/tmp/gone.pdf" on the Mac; check the path')
    expect(open('missing', [])).toBe('an item is not on the Mac; check the path')
    expect(open('scheme', ['ftp://x'])).toBe('only http, https and file items open; give a web page, a file or a folder')
  })
})
