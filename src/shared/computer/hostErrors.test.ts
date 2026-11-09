import { describe, expect, it } from 'vitest'
import { COMPUTER_ERROR_KINDS } from './protocol'
import { HOST_ERROR_KINDS, HOST_ERROR_WORDS, SESSION_REFUSALS, SESSION_REFUSAL_WORDS, hostErrorLine, noObservationLine, sessionRefusedLine } from './hostErrors'

describe('host error kinds', () => {
  it('each has words, and none but cancelled shadows a service kind', () => {
    for (const k of HOST_ERROR_KINDS) expect(HOST_ERROR_WORDS[k]().length).toBeGreaterThan(0)
    expect(HOST_ERROR_KINDS.filter((k) => (COMPUTER_ERROR_KINDS as readonly string[]).includes(k))).toEqual(['cancelled'])
  })
  it('carry their detail where the kind takes one', () => {
    expect(hostErrorLine('service_unavailable', 'computer use runs on a Mac')).toBe('computer use is unavailable here: computer use runs on a Mac')
    expect(hostErrorLine('stopped')).toBe('stopped by the person')
    expect(hostErrorLine('paused')).toBe('refused: the thread is paused')
    expect(hostErrorLine('denied')).toBe('denied: the person did not allow it')
    expect(hostErrorLine('away')).toBe('denied: the person is away')
    expect(hostErrorLine('cancelled', 'the thread was paused')).toBe('cancelled: the thread was paused')
    expect(hostErrorLine('no_observation', noObservationLine(12, 'TextEdit'))).toBe(
      '[12] comes from no observation of TextEdit in this thread; read the window first'
    )
  })
  it('a session refusal says the tier and the reason', () => {
    for (const r of SESSION_REFUSALS) expect(SESSION_REFUSAL_WORDS[r].length).toBeGreaterThan(0)
    expect(sessionRefusedLine('no-scheduler')).toBe(
      'needs the session tier (the real pointer and keyboard), which is not available now: nothing schedules it yet'
    )
  })
})
