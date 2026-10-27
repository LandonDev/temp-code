import { describe, expect, it } from 'vitest'
import { blockedWords } from './batchWords'

describe('blockedWords', () => {
  it('says every reason in words', () => {
    const say = (why: Parameters<typeof blockedWords>[0]['why'], host?: string) =>
      blockedWords({ sessionId: 's', why }, 'Inbox', host)
    expect(say('errored')).toBe('Blocked: Inbox errored')
    expect(say('stopped')).toBe('Blocked: Inbox stopped')
    expect(say('failed')).toBe('Blocked: Inbox failed')
    expect(say('paused')).toBe('Blocked: Inbox paused')
    expect(say('no-turn')).toBe('Blocked: Inbox ended its turn without completing')
    expect(say('unreachable', 'box')).toBe('Blocked: Inbox is out of reach on box')
    expect(say('unreachable')).toBe('Blocked: Inbox is out of reach on another host')
  })

  it('names an untitled thread "a thread"', () => {
    expect(blockedWords({ sessionId: 's', why: 'errored' }, '  ')).toBe('Blocked: a thread errored')
    expect(blockedWords({ sessionId: 's', why: 'errored' }, null)).toBe('Blocked: a thread errored')
  })
})
