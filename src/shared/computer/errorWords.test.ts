import { describe, expect, it } from 'vitest'
import { COMPUTER_ERROR_WORDS, ERROR_LINE_MAX, errorLine } from './errorWords'
import { COMPUTER_ERROR_KINDS, type ComputerAction, type ComputerError, type ComputerErrorKind } from './protocol'

const SERVICE = 'the service said so'
const err = (kind: ComputerErrorKind, data: Partial<ComputerError> = {}): ComputerError => ({ kind, message: SERVICE, ...data })

/** The richest data each kind carries on the wire. */
const SAMPLES: Record<ComputerErrorKind, Partial<ComputerError>> = {
  not_initialized: {},
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
  already_running: {}
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
