import { describe, expect, it } from 'vitest'
import {
  HELD_TIMINGS,
  LOCAL_CARD_WORDS,
  READER_WAIT_WORDS,
  UNREAD_WORDS,
  cancelledAfterStepsLine,
  cancelledPendingLine,
  heldAnswerLine,
  heldTimings,
  stillHeldLine,
  unknownHeldLine
} from './heldCalls'

const lines = [
  heldAnswerLine('c4', 20_000, 'Waiting for the Mac to be free'),
  stillHeldLine(65_000, 'Waiting for your approval'),
  cancelledPendingLine('c4', 'perform raise in TextEdit'),
  cancelledPendingLine('c4', null),
  cancelledAfterStepsLine('c4', 'click Save in TextEdit'),
  unknownHeldLine('c9'),
  READER_WAIT_WORDS,
  LOCAL_CARD_WORDS,
  UNREAD_WORDS
]

describe('held call words', () => {
  it('say what holds the call, its id and what to do', () => {
    expect(heldAnswerLine('c4', 20_000, 'Waiting for the Mac to be free')).toBe(
      'Held after 20s: Waiting for the Mac to be free. Nothing runs until you ask for it: call computer_result with id "c4". Your next other computer call cancels it.'
    )
    expect(stillHeldLine(65_000, 'Waiting for your approval')).toBe(
      'Still held, 1m 5s: Waiting for your approval. Call computer_result again, or go on: your next other computer call cancels it.'
    )
    expect(cancelledPendingLine('c4', 'perform raise in TextEdit')).toBe('Cancelled c4 (perform raise in TextEdit) before it ran.')
    expect(cancelledPendingLine('c4', null)).toBe('Cancelled c4 before it ran.')
    expect(unknownHeldLine('c9')).toBe('nothing held under "c9": its result was given, or it was cancelled')
  })

  it('are whole words, never a double space, under 300 characters', () => {
    for (const l of lines) {
      expect(l).not.toContain('  ')
      expect(l.length).toBeLessThan(300)
      expect(l).toBe(l.trim())
    }
  })
})

describe('heldTimings', () => {
  it('keeps the defaults without an isolated instance', () => {
    expect(heldTimings({ TEMP_CODE_COMPUTER_HELD_MS: '3000,3000,8000' })).toEqual(HELD_TIMINGS)
  })

  it('reads the seam on an isolated instance', () => {
    expect(heldTimings({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_COMPUTER_HELD_MS: '3000, 3000,8000' })).toEqual({ answerMs: 3000, waitMs: 3000, unreadMs: 8000 })
  })

  it('keeps the defaults for a malformed seam', () => {
    for (const raw of ['3000,3000', '3000,x,8000', '0,1,2', '1.5,2,3'])
      expect(heldTimings({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_COMPUTER_HELD_MS: raw })).toEqual(HELD_TIMINGS)
  })
})
