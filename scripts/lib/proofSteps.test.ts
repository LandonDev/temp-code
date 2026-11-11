import { describe, expect, it } from 'vitest'
import { chainSkip, isSetupStep, isVoid, judgeFront, judgePointer, keepGoing, retriesVoid, VOID_RETRIES } from './proofSteps'

describe('keep-going', () => {
  it('reads the flag or the environment', () => {
    expect(keepGoing(['bun', 'x.ts', '--gate'], {})).toBe(false)
    expect(keepGoing(['bun', 'x.ts', '--gate', '--keep-going'], {})).toBe(true)
    expect(keepGoing(['bun', 'x.ts'], { TC_PROOF_KEEP_GOING: '1' })).toBe(true)
  })

  it('the gate stops a chain at its first failure', () => {
    expect(chainSkip(null, false)).toBeNull()
    expect(chainSkip({ name: 'fallbacks 3', setup: false }, false)).toBe('fallbacks 3 failed')
  })

  it('a keep-going run goes past a failed step, never past a failed setup step', () => {
    expect(chainSkip({ name: 'fallbacks 3', setup: false }, true)).toBeNull()
    expect(chainSkip({ name: 'fallbacks: launch a TC Probe with --fallbacks in the background', setup: true }, true)).toBe(
      'fallbacks: launch a TC Probe with --fallbacks in the background failed'
    )
  })

  it('tells the steps that make a leg’s target by their names', () => {
    for (const name of [
      'build tc-computer',
      'a service for the apps',
      'web: launch after 5 quiet seconds and restore the front app and window',
      'apps.launch the probe app in the background',
      'active TextEdit: a scratch TextEdit on note.txt in the background',
      'active Finder: a window of the scratch folder in the background'
    ])
      expect(isSetupStep(name)).toBe(true)
    for (const name of ['fallbacks 4: a click at the field’s fifth character puts the caret there', 'web: pick reads Team back and closes its menu', 'quit the probe app'])
      expect(isSetupStep(name)).toBe(false)
  })
})

describe('a voided step', () => {
  it('runs again at once up to three times, then is recorded void', () => {
    expect(VOID_RETRIES).toBe(3)
    expect([0, 1, 2, 3].map(retriesVoid)).toEqual([true, true, true, false])
    expect(isVoid('void: the person used the Mac during the step')).toBe(true)
    expect(isVoid('skipped: the person is active')).toBe(false)
  })
})

describe('judgeFront after a session step', () => {
  const person = { pid: 2008 }
  const probe = { pid: 74575 }
  it('names a scratch app left in front while the person used the Mac as the put-back giving way, and fails it with no input', () => {
    // active 9, 2026-11-11: save_as's Go to Folder confirm at session, the person at the Mac
    expect(judgeFront({ before: person, after: probe, scratch: [74575], personInput: true, session: true })).toEqual({ verdict: 'gave-way' })
    expect(judgeFront({ before: person, after: probe, scratch: [74575], personInput: false, session: true }).verdict).toBe('failed')
    // with no session step the service owes the front back whatever the person did
    expect(judgeFront({ before: person, after: probe, scratch: [74575], personInput: true }).verdict).toBe('failed')
  })
})

describe('judgeFront', () => {
  const person = { pid: 100, window: 7 }
  const scratch = [500, 501]

  it('passes a front left as it was', () => {
    expect(judgeFront({ before: person, after: person, scratch, personInput: false })).toEqual({ verdict: 'kept' })
    expect(judgeFront({ before: { pid: 100 }, after: { pid: 100 }, scratch, personInput: false })).toEqual({ verdict: 'kept' })
  })

  it('fails a scratch app left in front, whatever the person did', () => {
    expect(judgeFront({ before: person, after: { pid: 500, window: 9 }, scratch, personInput: true }).verdict).toBe('failed')
  })

  it('fails what the service says it could not put back', () => {
    const r = judgeFront({ before: person, after: person, scratch, report: { raised: true, restored: 'failed' }, personInput: true })
    expect(r.verdict).toBe('failed')
  })

  it('takes another app in front as the person’s or the system’s, input or not', () => {
    // the web leg on 2026-11-11: loginwindow (a screen saver) in front before, the app under it after
    expect(judgeFront({ before: { pid: 470, window: 0 }, after: { pid: 2002, window: 0 }, scratch, personInput: false })).toEqual({ verdict: 'theirs' })
    expect(judgeFront({ before: person, after: { pid: 200, window: 3 }, scratch, personInput: true })).toEqual({ verdict: 'theirs' })
  })

  it('a window change within the person’s app is theirs only with their input', () => {
    expect(judgeFront({ before: person, after: { pid: 100, window: 8 }, scratch, personInput: true })).toEqual({ verdict: 'theirs' })
    expect(judgeFront({ before: person, after: { pid: 100, window: 8 }, scratch, personInput: false }).verdict).toBe('failed')
  })

  it('passes a steal the guard restored, and says when the person chose the raised app', () => {
    expect(judgeFront({ before: person, after: person, scratch, report: { raised: true, restored: 'restored', ms: 120 }, personInput: false })).toEqual({ verdict: 'kept' })
    expect(judgeFront({ before: person, after: { pid: 500 }, scratch, report: { raised: true, restored: 'person-chose' }, personInput: true })).toEqual({ verdict: 'person-chose' })
  })
})

describe('judgePointer', () => {
  it('a pointer moves only with the person’s input', () => {
    expect(judgePointer(0, false)).toBe('still')
    expect(judgePointer(12, true)).toBe('theirs')
    expect(judgePointer(12, false)).toBe('moved')
  })
})
