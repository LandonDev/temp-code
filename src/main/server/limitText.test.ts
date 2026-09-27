import { describe, expect, it } from 'vitest'
import { limitField } from './limitText'

/** The error event's limit tag comes from aliax-core's classifier; this pins the wording that once missed. */
describe('limitField', () => {
  it('tags the Claude usage summary by its 100% line', () => {
    const summary = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 100% used · resets Sep 26 at 7:20pm (America/Chicago)',
      'Current week (all models): 37% used · resets Oct 2 at 12am (America/Chicago)',
      'Current week (Fable): 67% used · resets Oct 2 at 12am (America/Chicago)',
      '',
      "What's contributing to your limits usage?"
    ].join('\n')
    expect(limitField('claude', summary)).toEqual({ limit: { window: '5h' } })
    expect(limitField('claude', summary.replace('(Fable): 67%', '(Fable): 100%').replace('session: 100%', 'session: 40%'))).toEqual({
      limit: { window: { model: 'Fable' } }
    })
  })
  it('tags nothing for text that names no limit', () => {
    expect(limitField('claude', 'Prompt is too long')).toEqual({})
  })
})
