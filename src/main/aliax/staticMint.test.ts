import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tc-static-mint-test' },
  net: { fetch: async () => new Response('') },
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) }
}))

import { authorizeRequest, codeFrom, CONSENT_SCRIPT, cookieRecords, isLoginPage } from './staticMint'
import { consentScript } from './consentScript'

describe('authorizeRequest', () => {
  it("is Claude Code's consent URL with PKCE, the static scopes and a random state; nothing but the scope differs from a sign-in", () => {
    const req = authorizeRequest()
    const url = new URL(req.url)
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize')
    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback')
    expect(url.searchParams.get('scope')).toBe('user:profile user:inference')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(req.state)
    // 32 random bytes, what `claude setup-token` and the sign-in send: the consent endpoint
    // refused a 16-byte state with "Invalid request format" (2026-10-20).
    expect(req.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.has('login_hint')).toBe(false)
    // S256: the challenge is the base64url sha256 of the verifier.
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(req.verifier).digest('base64url'))
    expect(req.redirectUri).toBe('https://platform.claude.com/oauth/code/callback')
    expect(req.scopes).toEqual(['user:profile', 'user:inference'])
  })
  it('asks for the scopes given and pre-fills the address, each request its own PKCE pair', () => {
    const a = authorizeRequest(['user:inference'], 'one@x.test')
    const b = authorizeRequest(['user:inference'], 'one@x.test')
    expect(new URL(a.url).searchParams.get('scope')).toBe('user:inference')
    expect(new URL(a.url).searchParams.get('login_hint')).toBe('one@x.test')
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.state).not.toBe(b.state)
  })
})

describe('codeFrom and isLoginPage', () => {
  it('reads the code off the landing page by path, whatever the host', () => {
    expect(codeFrom('https://platform.claude.com/oauth/code/callback?code=abc&state=s1')).toEqual({ code: 'abc', state: 's1' })
    expect(codeFrom('http://127.0.0.1:4000/oauth/code/callback?code=abc')).toEqual({ code: 'abc', state: null })
    expect(codeFrom('https://platform.claude.com/oauth/code/success?code=abc&state=s')).toEqual({ code: 'abc', state: 's' })
    expect(codeFrom('https://platform.claude.com/oauth/code/callback')).toBeNull()
    expect(codeFrom('https://claude.ai/oauth/authorize?code=true')).toBeNull()
    expect(codeFrom('not a url')).toBeNull()
  })
  it('knows a sign-in page from the consent page', () => {
    expect(isLoginPage('https://claude.ai/login?returnTo=%2Foauth%2Fauthorize')).toBe(true)
    expect(isLoginPage('https://claude.ai/login')).toBe(true)
    expect(isLoginPage('https://claude.ai/magic-link/x')).toBe(true)
    expect(isLoginPage('https://claude.ai/oauth/authorize?client_id=x')).toBe(false)
    expect(isLoginPage('https://claude.ai/oauth/consent')).toBe(false)
    expect(isLoginPage('nope')).toBe(false)
  })
  it('the consent script waits for a button whose label says approve and clicks it once; a test seam names the element instead', () => {
    expect(CONSENT_SCRIPT).toMatch(/authori\[sz\]e\|allow\|approve\|accept\|continue/)
    expect(CONSENT_SCRIPT).toMatch(/setInterval\(click, 250\)/)
    expect(CONSENT_SCRIPT).toMatch(/clearInterval\(window\.__tcConsent\)/)
    expect(CONSENT_SCRIPT).toMatch(/if \(window\.__tcConsent\) return 'armed'/)
    expect(consentScript('#approve')).toContain('document.querySelector("#approve")')
    expect(consentScript('#approve')).not.toMatch(/authori\[sz\]e/)
  })
})

describe('cookieRecords', () => {
  const stored = [
    { name: 'sessionKey', value: 'sk-ant-sid01-x', domain: '.claude.ai', path: '/', secure: true, httpOnly: true, expirationDate: 1_900_000_000, sameSite: 'lax' as const },
    { name: 'lastActiveOrg', value: 'org', domain: '.claude.ai', path: '/', secure: true, httpOnly: false }
  ]
  it('seeds the claude.ai jar with the stored cookies as they were', () => {
    const [sk] = cookieRecords(stored, 'https://claude.ai')
    expect(sk).toEqual({ url: 'https://claude.ai', name: 'sessionKey', value: 'sk-ant-sid01-x', domain: '.claude.ai', path: '/', secure: true, httpOnly: true, expirationDate: 1_900_000_000, sameSite: 'lax' })
  })
  it('against a stand-in origin the cookies are host-only and plain, so the fake provider sees them', () => {
    const [sk, org] = cookieRecords(stored, 'http://127.0.0.1:4000')
    expect(sk).toMatchObject({ url: 'http://127.0.0.1:4000', name: 'sessionKey', value: 'sk-ant-sid01-x', secure: false, httpOnly: true })
    expect(sk).not.toHaveProperty('domain')
    expect(org.secure).toBe(false)
  })
})
