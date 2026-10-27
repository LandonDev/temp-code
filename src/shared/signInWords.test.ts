import { describe, expect, it } from 'vitest'
import { CANCELLED, cliInstallNote, cliRepairNote, cliTakesSignIn, exchangeRefused, holdsGrant, NO_ACCOUNT, NO_ANSWER, signInNotes, UNREACHABLE } from './signInWords'

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

describe('cliTakesSignIn', () => {
  const base = { handedOff: false, liveSignedIn: false, sameAccount: false, liveExpired: false }
  it('installs the first sign-in when the CLI is signed in nowhere', () => {
    expect(cliTakesSignIn(base)).toBe('install')
    expect(cliInstallNote({ ok: true })).toBeNull()
    expect(cliInstallNote({ ok: false, error: 'locked' })).toBe('The CLI is still signed out (locked)')
  })
  it('repairs a dead sign-in of the same account and never switches away from another', () => {
    expect(cliTakesSignIn({ ...base, liveSignedIn: true, sameAccount: true, liveExpired: true })).toBe('repair')
    expect(cliTakesSignIn({ ...base, liveSignedIn: true, sameAccount: true })).toBeNull()
    expect(cliTakesSignIn({ ...base, liveSignedIn: true })).toBeNull()
  })
  it('leaves the CLI alone while sign-ins are handed to another host', () => {
    expect(cliTakesSignIn({ ...base, handedOff: true })).toBeNull()
  })
})

describe('holdsGrant', () => {
  it('is no only when the store answers that nothing is there', async () => {
    expect(await holdsGrant(async () => null)).toBe(false)
    expect(await holdsGrant(async () => '{"claudeAiOauth":{}}')).toBe(true)
    expect(await holdsGrant(async () => { throw new Error('keychain locked') })).toBe(true)
  })
})
