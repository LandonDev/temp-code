import { describe, expect, it } from 'vitest'
import {
  ADDON_GRANT_MANAGED,
  GRANT_NO_ADDON,
  GRANT_NO_FIELD,
  GRANT_OFFLINE,
  GRANT_ON_MAC,
  GRANT_PROBE_REFUSED,
  SIGNIN_BUSY,
  SIGNIN_DENIED,
  SIGNIN_ISSUER,
  SIGNIN_NEEDS_BROWSER,
  SIGNIN_NO_ADDRESS,
  SIGNIN_NO_PKCE,
  SIGNIN_NO_REFRESH,
  SIGNIN_NO_REGISTRATION,
  SIGNIN_NO_SERVER,
  SIGNIN_NOT_NEEDED,
  SIGNIN_PORT_TAKEN,
  SIGNIN_SERVER,
  SIGNIN_STEP_WORDS,
  SIGNIN_TIMEOUT,
  SIGNIN_UNREACHABLE
} from './addonGrantWords'

describe('the add-on grant words', () => {
  it('say each refusal in one line, naming what the person can act on', () => {
    expect(ADDON_GRANT_MANAGED).toBe('Add-on grants are managed on Settings → Add-ons')
    expect(SIGNIN_NEEDS_BROWSER).toBe('Sign in on the Mac: this host has no browser')
    expect(SIGNIN_NO_ADDRESS('github')).toBe('github runs over stdio and names no address to sign in at')
    expect(SIGNIN_NOT_NEEDED('mobbin')).toBe('mobbin answered without a sign-in; set its auth to none')
    expect(SIGNIN_NO_PKCE('auth.example.com')).toBe('auth.example.com does not offer PKCE, so the app will not sign in to it')
    expect(SIGNIN_NO_REGISTRATION('auth.example.com')).toBe('auth.example.com does not let apps register, so the app cannot sign in to it yet')
    expect(SIGNIN_ISSUER('auth.example.com')).toBe('auth.example.com answered for another sign-in server')
    expect(SIGNIN_NO_SERVER('api.example.com')).toBe('api.example.com names no sign-in server')
    expect(SIGNIN_PORT_TAKEN(53682)).toBe('Port 53682 is in use on this Mac; close what holds it, then sign in again')
    expect(SIGNIN_TIMEOUT).toBe('The sign-in timed out after 5 minutes')
    expect(SIGNIN_DENIED('access_denied')).toBe('The sign-in was refused: access_denied')
    expect(SIGNIN_DENIED('access_denied', 'The user declined')).toBe('The sign-in was refused: The user declined')
    expect(SIGNIN_SERVER('auth.example.com', 'exchange', 400)).toBe('auth.example.com refused the exchange (HTTP 400)')
    expect(SIGNIN_UNREACHABLE('auth.example.com', 'discovery')).toBe('auth.example.com could not be reached for the discovery')
    expect(SIGNIN_NO_REFRESH('auth.example.com')).toBe('auth.example.com gave no refresh token this time; remove the grant, then sign in again')
    expect(SIGNIN_BUSY('mobbin')).toBe('refused: mobbin is already signing in')
    expect(GRANT_OFFLINE('keyed', 'box')).toBe('refused: grants of keyed live on box; it is offline')
    expect(GRANT_ON_MAC('mobbin')).toBe("refused: mobbin's sign-in is still on the Mac; it moves here at the next sync")
    expect(GRANT_PROBE_REFUSED).toBe('The server refused these values')
    expect(GRANT_NO_ADDON('ad_1')).toBe('refused: no add-on ad_1')
    expect(GRANT_NO_FIELD('keyed', 'X-Other')).toBe('refused: keyed takes no value named X-Other')
  })

  it('name every sign-in step, with no dashes or trailing dots', () => {
    expect(Object.keys(SIGNIN_STEP_WORDS)).toEqual(['discovering', 'registering', 'waiting', 'exchanging', 'failed'])
    for (const words of Object.values(SIGNIN_STEP_WORDS)) expect(words).toMatch(/^[A-Z][a-z-]*( [a-z-]+)*$/)
  })
})
