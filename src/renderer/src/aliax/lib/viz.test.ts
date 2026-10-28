import { describe, expect, it } from 'vitest'
import { modelLabel } from './viz'

describe('modelLabel', () => {
  it('names a model as the rest of the app does, dated ids too', () => {
    expect(modelLabel('claude-fable-5-1')).toBe('Claude Fable 5.1')
    expect(modelLabel('claude-opus-5-5-20261001')).toBe('Claude Opus 5.5')
  })

  it('trims an id no catalog knows to read on an axis', () => {
    expect(modelLabel('claude-mystery-9')).toBe('mystery-9')
    expect(modelLabel('some-model-latest')).toBe('some-model')
  })
})
