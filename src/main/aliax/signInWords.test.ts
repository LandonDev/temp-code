import { describe, expect, it } from 'vitest'
import { CANCELLED, cliRepairNote, exchangeRefused, NO_ACCOUNT, NO_ANSWER, signInNotes, UNREACHABLE } from './signInWords'

describe('the words a Claude sign-in sends', () => {
  it('says only "cancelled" for a closed window or Cancel', () => {
    expect(CANCELLED).toBe('cancelled')
  })
  it('names an unreachable claude.ai and one that never painted', () => {
    expect(UNREACHABLE).toBe("Couldn't reach claude.ai")
    expect(NO_ANSWER).toBe("claude.ai didn't answer")
  })
  it('names a refused token exchange with its status', () => {
    expect(exchangeRefused(400)).toBe('Claude refused the sign-in (HTTP 400)')
  })
  it('names an answer with no account', () => {
    expect(NO_ACCOUNT).toBe("Claude's answer named no account")
  })
  it('says nothing when both halves were captured for a new account', () => {
    expect(signInNotes({ hasSession: true, alreadySaved: false })).toEqual([])
  })
  it('says when the claude.ai session was not captured', () => {
    expect(signInNotes({ hasSession: false, alreadySaved: false })).toEqual(['Saved without its claude.ai session'])
  })
  it('says an account already saved was refreshed', () => {
    expect(signInNotes({ hasSession: true, alreadySaved: true })).toEqual(['Sign-in refreshed'])
  })
  it('names the CLI repair and its failure', () => {
    expect(cliRepairNote({ ok: true })).toBe('CLI sign-in repaired')
    expect(cliRepairNote({ ok: false, error: 'locked' })).toBe("The CLI's sign-in is still expired (locked)")
  })
})
