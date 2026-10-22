import { describe, expect, it } from 'vitest'
import { Gateway, rebindWarmPath } from './gateway'

describe('warm scope paths', () => {
  const scopes: Record<string, { thread: string; account: string; pin: boolean; model?: string } | null> = {
    adopted: { thread: 'T1', account: 'work', pin: false },
    pinned: { thread: 'T2', account: 'home', pin: true },
    modelled: { thread: 'T3', account: 'work', pin: true, model: 'claude-opus-5-5' },
    waiting: null
  }
  const lookup = (id: string) => scopes[id]

  it('rewrites an adopted warm id into the thread\'s scoped path', () => {
    expect(rebindWarmPath('/claude/~w=adopted/v1/messages', lookup)).toBe('/claude/~t=T1;a=work/v1/messages')
    expect(rebindWarmPath('/claude/~w=pinned/v1/messages?beta=true', lookup)).toBe('/claude/~t=T2;a=home;pin=1/v1/messages?beta=true')
    // The adopting thread's model rides the rebound scope, so the gateway never parses the body for it.
    expect(rebindWarmPath('/claude/~w=modelled/v1/messages', lookup)).toBe('/claude/~t=T3;a=work;pin=1;m=claude-opus-5-5/v1/messages')
  })

  it('sends an unadopted or unknown warm id unscoped', () => {
    expect(rebindWarmPath('/claude/~w=waiting/v1/messages', lookup)).toBe('/claude/v1/messages')
    expect(rebindWarmPath('/claude/~w=nobody/api/oauth/profile', lookup)).toBe('/claude/api/oauth/profile')
    expect(rebindWarmPath('/claude/~w=waiting', lookup)).toBe('/claude')
  })

  it('leaves every other path alone', () => {
    for (const url of ['/claude/v1/messages', '/claude/~t=T;a=A/v1/messages', '/__aliax', '/codex/~t=T;a=A/v1/responses', '/']) {
      expect(rebindWarmPath(url, lookup)).toBe(url)
    }
  })

  it('decodes the id the URL carries', () => {
    expect(rebindWarmPath('/claude/~w=a%2Fb/x', (id) => (id === 'a/b' ? { thread: 'T', account: 'A', pin: false } : null))).toBe('/claude/~t=T;a=A/x')
  })
})

describe('Gateway warm registry', () => {
  it('has no warm URL before it listens, and tracks adoption and release', () => {
    const gw = new Gateway({ claimShim: false, tls: null })
    expect(gw.warmClaudeUrl('w1')).toBeNull()
    gw.adoptWarm('w1', { thread: 'T', account: 'A', pin: false })
    expect(gw.warmIds()).toEqual([{ id: 'w1', thread: 'T' }])
    gw.adoptWarm('w2', null)
    expect(gw.warmIds()).toEqual([{ id: 'w1', thread: 'T' }, { id: 'w2', thread: null }])
    gw.releaseWarm('w1')
    expect(gw.warmIds()).toEqual([{ id: 'w2', thread: null }])
  })
})
