import { describe, expect, it } from 'vitest'
import { shortHash, traceLine } from './gatewayCore'

describe('the gateway trace lines', () => {
  const rec = { id: 12, method: 'POST', url: '/~t=T1;a=work/v1/messages', thread: 'T1', account: 'work', model: 'claude-opus-5-5' }

  it('a start line names the request number, the scope and the model, with the account hashed', () => {
    const line = traceLine('[gateway:42]', 'start', rec)
    expect(line).toBe(`[gateway:42] #12 POST /~t=T1;a=work/v1/messages start thread=T1 account=${shortHash('work')} model=claude-opus-5-5`)
    expect(line).not.toContain('account=work')
  })

  it('an unscoped request reads dashes', () => {
    expect(traceLine('[gateway]', 'start', { ...rec, thread: null, account: null, model: null })).toBe('[gateway] #12 POST /~t=T1;a=work/v1/messages start thread=- account=- model=-')
  })

  it('the finish line carries the same number, the status, the socket reuse and the duration', () => {
    expect(traceLine('[gateway]', 'finish', { ...rec, status: 200, reused: 'true', protocol: 'h2', ms: 1234 })).toBe('[gateway] #12 POST /~t=T1;a=work/v1/messages → 200 reused=true h2 1234ms')
    expect(traceLine('[gateway]', 'finish', { ...rec, status: null, reused: 'n/a', protocol: null, ms: 7 })).toBe('[gateway] #12 POST /~t=T1;a=work/v1/messages → no upstream reused=n/a 7ms')
  })

  it('shortHash is stable, six hex digits, and never the name', () => {
    expect(shortHash('work')).toBe(shortHash('work'))
    expect(shortHash('work')).toMatch(/^[0-9a-f]{6}$/)
    expect(shortHash('work')).not.toBe(shortHash('home'))
  })
})
