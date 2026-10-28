import { describe, expect, it } from 'vitest'
import type { Failure } from './events'
import { foldContinuableError, foldFailure } from './session-lifecycle'

const failure: Failure = { kind: 'network', account: null, summary: 'Could not reach Anthropic', cause: 'The connection dropped.' }
const ended: Failure = { kind: 'turn_ended', account: null, summary: 'The turn ended before it finished', cause: "The CLI's turn limit was reached." }

describe('foldFailure', () => {
  it('a classified error sets the verdict; a stop, a wind-down note and an unclassified row leave it', () => {
    expect(foldFailure(null, { type: 'error', message: 'fetch failed', failure })).toBe(failure)
    expect(foldFailure(failure, { type: 'error', message: 'turn ended: interrupted', stopped: true })).toBe(failure)
    expect(foldFailure(failure, { type: 'error', message: 'turn ended: max_turns' })).toBe(failure)
    // A row written before the verdict existed carries none: the rail says Failed.
    expect(foldFailure(failure, { type: 'error', message: 'old row' })).toBeNull()
    // A turn the CLI ended itself carries the host's verdict and is a failure.
    expect(foldFailure(failure, { type: 'error', message: 'turn ended: error_max_turns', failure: ended })).toBe(ended)
  })

  it('a turn ended row is continuable with a verdict, a wind-down note without one, never a stop', () => {
    expect(foldContinuableError(false, { type: 'error', message: 'turn ended: error_max_turns', failure: ended })).toBe(true)
    expect(foldContinuableError(false, { type: 'error', message: 'turn ended: max_turns' })).toBe(false)
    expect(foldContinuableError(false, { type: 'error', message: 'turn ended: interrupted', stopped: true })).toBe(false)
    expect(foldContinuableError(false, { type: 'error', message: 'fetch failed', failure })).toBe(true)
  })

  it('whatever settles the error clears it; status and accounting rows do not', () => {
    for (const event of [
      { type: 'errors-cleared' as const },
      { type: 'user-text' as const, text: 'again' },
      { type: 'assistant-text' as const, text: 'ok', msgId: 'm1', blockIndex: 0 }
    ]) {
      expect(foldFailure(failure, event as Parameters<typeof foldFailure>[1])).toBeNull()
    }
    expect(foldFailure(failure, { type: 'status', status: 'error' })).toBe(failure)
    expect(foldFailure(failure, { type: 'status', status: 'idle' })).toBe(failure)
  })
})
