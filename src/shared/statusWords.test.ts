import { describe, expect, it } from 'vitest'
import {
  detailText,
  leadDetail,
  legacyActivity,
  legacyDetail,
  plainStatus,
  providerWaitWords,
  retryWords,
  sentenceStart,
  thenYourMessage
} from './statusWords'

describe('statusWords', () => {
  it('writes a state as one string with a colon, the word alone with nothing to say', () => {
    expect(plainStatus('Queued', 'Waiting for memory')).toBe('Queued: Waiting for memory')
    expect(plainStatus('Needs you', '  Approve Bash. ')).toBe('Needs you: Approve Bash')
    expect(plainStatus('Watching', '3 subagents')).toBe('Watching: 3 subagents')
    expect(plainStatus('Queued')).toBe('Queued')
    expect(plainStatus('Queued', '')).toBe('Queued')
    expect(plainStatus('Queued', ' . ')).toBe('Queued')
    expect(plainStatus('Queued', null)).toBe('Queued')
  })

  it('keeps the legacy two-space activity string for old readers', () => {
    expect(legacyActivity('Queued', '120 of 120 running')).toBe('Queued  120 of 120 running')
    expect(legacyActivity('Queued', '  waiting for memory ')).toBe('Queued  waiting for memory')
    expect(legacyActivity('Queued')).toBe('Queued')
    expect(legacyActivity('Queued', '')).toBe('Queued')
    expect(legacyActivity('Queued', null)).toBe('Queued')
  })

  it('takes a detail as written: trimmed, no trailing full stop, case untouched', () => {
    expect(detailText('  Usage cap. ')).toBe('Usage cap')
    expect(detailText('PR checks failed')).toBe('PR checks failed')
    expect(detailText('sleep 45 seconds')).toBe('sleep 45 seconds')
    expect(detailText('Rate limited, retry 3 in 32 s')).toBe('Rate limited, retry 3 in 32 s')
    expect(detailText('  ')).toBeNull()
    expect(detailText(null)).toBeNull()
  })

  it('reads an old host activity past its lead and starts it with a capital', () => {
    expect(legacyDetail('Queued  waiting for memory', 'Queued')).toBe('Waiting for memory')
    expect(legacyDetail('Queued · waiting for Plan A19', 'Queued')).toBe('Waiting for Plan A19')
    expect(legacyDetail('Queued: 3rd in line', 'Queued')).toBe('3rd in line')
    expect(legacyDetail('Queued  120 of 120 running', 'Queued')).toBe('120 of 120 running')
    expect(legacyDetail('Waiting on 3 subagents, a monitor', 'Waiting on')).toBe('3 subagents, a monitor')
    expect(legacyDetail('Waiting for the Mac, load 12.3 of 8, 3rd in line', 'Waiting for the Mac')).toBe('Load 12.3 of 8, 3rd in line')
    expect(legacyDetail('Queued  rail.tsx.', 'Queued')).toBe('rail.tsx')
    expect(legacyDetail('Thinking', 'Queued')).toBeNull()
    expect(legacyDetail(null, 'Queued')).toBeNull()
  })

  it('upper-cases a plain lower-case first word only', () => {
    expect(sentenceStart('approve Bash')).toBe('Approve Bash')
    expect(sentenceStart('Approve Bash')).toBe('Approve Bash')
    expect(sentenceStart('gh-pr.ts changed')).toBe('gh-pr.ts changed')
    expect(sentenceStart('3 subagents')).toBe('3 subagents')
    expect(sentenceStart(null)).toBeNull()
  })

  it('reads the detail past a lead, the two spaces, the old dot, a colon, a comma or a sentence space alike', () => {
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

  it('puts an unread steer behind what the turn does', () => {
    expect(thenYourMessage('Running the gate')).toBe('Running the gate, then your message')
    expect(plainStatus('Working', thenYourMessage('Compacting context'))).toBe('Working: Compacting context, then your message')
  })
})
