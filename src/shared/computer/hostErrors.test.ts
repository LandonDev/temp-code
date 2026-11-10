import { describe, expect, it } from 'vitest'
import { COMPUTER_ERROR_KINDS } from './protocol'
import { HOST_ERROR_KINDS, HOST_ERROR_WORDS, SESSION_REFUSALS, hostErrorLine, noObservationLine, noReadForTextLine, sessionRefusalWords, sessionRefusedLine } from './hostErrors'

describe('host error kinds', () => {
  it('each has words, and none but cancelled shadows a service kind', () => {
    for (const k of HOST_ERROR_KINDS) {
      expect(HOST_ERROR_WORDS[k]().length).toBeGreaterThan(0)
      expect(HOST_ERROR_WORDS[k]('a reason of some length').length, k).toBeLessThanOrEqual(200)
      expect(HOST_ERROR_WORDS[k]()).not.toContain('\n')
    }
    expect(HOST_ERROR_KINDS.filter((k) => (COMPUTER_ERROR_KINDS as readonly string[]).includes(k))).toEqual(['cancelled'])
  })
  it('carry their detail where the kind takes one', () => {
    expect(hostErrorLine('service_unavailable', 'computer use runs on a Mac')).toBe(
      'computer use is off on this host: computer use runs on a Mac; do the work another way'
    )
    expect(hostErrorLine('stopped')).toBe('stopped by the person; no more computer use this turn')
    expect(hostErrorLine('paused')).toBe('refused: the thread is paused')
    expect(hostErrorLine('denied')).toBe('denied: the person did not allow it; do not reach the same effect another way')
    expect(hostErrorLine('away')).toBe('denied: the person is away and this act spends money; finish around it and name it in your report')
    expect(hostErrorLine('cancelled', 'the thread was paused')).toBe('cancelled: the thread was paused')
    expect(hostErrorLine('invalid_args', 'actions: too big')).toBe("invalid arguments: actions: too big; see the tool's description")
    expect(hostErrorLine('no_observation', noObservationLine(12, 'TextEdit'))).toBe('[12] comes from no read of TextEdit in this thread; read the window first')
    expect(noReadForTextLine('TextEdit')).toBe("read TextEdit's window before typing into it")
    expect(noReadForTextLine('TextEdit', 'Notes')).toBe('read TextEdit\'s window "Notes" before typing into it')
  })
  it('refuse TempCode, the system prompts, and an app it could not check, each in its own words', () => {
    expect(hostErrorLine('refused_app', 'tempcode')).toBe("TempCode's own window is off limits to computer use")
    expect(hostErrorLine('refused_app', 'prompts')).toBe("macOS's password and Touch ID prompts are the person's to answer")
    expect(hostErrorLine('refused_app', 'unchecked')).toContain("couldn't check which app this is")
  })
  it('a session refusal says the tier and the reason', () => {
    for (const r of SESSION_REFUSALS) expect(sessionRefusalWords(r).length).toBeGreaterThan(0)
    expect(sessionRefusedLine('no-scheduler')).toBe(
      'needs the session tier (the real pointer and keyboard), which is not available now: nothing schedules it yet'
    )
    expect(sessionRefusedLine('skipped-earlier', 'TextEdit')).toBe(
      'needs the session tier (the real pointer and keyboard), which is not available now: the person did not choose Run now for TextEdit earlier in this turn'
    )
  })
  it("a paste that waited out the person's copies too long says to try again", () => {
    expect(hostErrorLine('clipboard_recent')).toBe(
      'the person copied something just now and a paste would swap their clipboard; try again in a minute'
    )
  })
})
