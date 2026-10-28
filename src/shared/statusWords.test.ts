import { describe, expect, it } from 'vitest'
import { joinFacts, leadDetail, providerWaitWords, retryWords } from './statusWords'

describe('statusWords', () => {
  it('joins a state word and its detail with two spaces, the word alone with nothing to say', () => {
    expect(joinFacts('Queued', '120 of 120 running')).toBe('Queued  120 of 120 running')
    expect(joinFacts('Queued', '  waiting for memory ')).toBe('Queued  waiting for memory')
    expect(joinFacts('Queued')).toBe('Queued')
    expect(joinFacts('Queued', '')).toBe('Queued')
    expect(joinFacts('Queued', null)).toBe('Queued')
  })

  it('reads the detail past a lead, the new two spaces, the old dot, a colon, a comma or a sentence space alike', () => {
    expect(leadDetail('Queued  120 of 120 running', 'Queued')).toBe('120 of 120 running')
    expect(leadDetail('Queued · waiting for Plan A19', 'Queued')).toBe('waiting for Plan A19')
    expect(leadDetail('Queued: 3rd in line', 'Queued')).toBe('3rd in line')
    expect(leadDetail('Waiting for the Mac, load 12.3 of 8, 3rd in line', 'Waiting for the Mac')).toBe('load 12.3 of 8, 3rd in line')
    expect(leadDetail('Waiting on 3 subagents', 'Waiting on')).toBe('3 subagents')
    expect(leadDetail('  Queued  x  ', 'Queued ')).toBe('x')
    // Not the lead, or nothing past it.
    expect(leadDetail('Queued', 'Queued')).toBeNull()
    expect(leadDetail('Queued  ', 'Queued')).toBeNull()
    expect(leadDetail('Queuedx', 'Queued')).toBeNull()
    expect(leadDetail('Thinking', 'Queued')).toBeNull()
    expect(leadDetail(null, 'Queued')).toBeNull()
    expect(leadDetail('', 'Queued')).toBeNull()
  })

  it('words a retry with a comma: the wait, the count of tries, or neither', () => {
    expect(retryWords({ why: 'rate-limited', attempt: 3, delayMs: 32_000 })).toBe('Rate limited, retry 3 in 32 s')
    expect(retryWords({ why: 'overloaded', attempt: 2, delayMs: 8_000 })).toBe('Provider overloaded, retry 2 in 8 s')
    expect(retryWords({ why: 'reconnecting', attempt: 2, of: 5 })).toBe('Reconnecting, retry 2 of 5')
    expect(retryWords({ why: 'reconnecting', attempt: 2, of: '5' })).toBe('Reconnecting, retry 2 of 5')
    expect(retryWords({ why: 'retrying', attempt: 4 })).toBe('Retrying, retry 4')
    expect(retryWords({ why: 'retrying', attempt: 1, delayMs: 400 })).toBe('Retrying, retry 1 in 1 s')
  })

  it('words the provider wait with a comma', () => {
    expect(providerWaitWords(25)).toBe('Waiting for the provider, 25 s')
  })
})
