import { describe, expect, it } from 'vitest'
import { BootResumePushSchema, RemotePushSchema, SessionChangesSchema } from './wireSchemas'

describe('session.changes on the wire', () => {
  it('parses the reset answer and the delta answer with one flat schema', () => {
    const reset = SessionChangesSchema.parse({ reset: true, seq: 12, generation: 'g1' })
    expect(reset).toEqual({ reset: true, seq: 12, generation: 'g1' })
    const delta = SessionChangesSchema.parse({
      reset: false,
      seq: 13,
      generation: 'g1',
      sessions: [],
      removed: ['s9']
    })
    expect(delta.sessions).toEqual([])
    expect(delta.removed).toEqual(['s9'])
    expect(() => SessionChangesSchema.parse({ reset: false, seq: 1.5, generation: 'g1' })).toThrow()
  })
})

describe('the boot-resume push', () => {
  it('is a remote push with its count and the boot time', () => {
    const frame = { push: 'boot-resume', count: 3, at: 1_700_000_000_000 }
    expect(BootResumePushSchema.parse(frame)).toEqual(frame)
    const parsed = RemotePushSchema.parse(frame)
    expect(parsed.push).toBe('boot-resume')
    expect(() => RemotePushSchema.parse({ push: 'boot-resume', count: 3 })).toThrow()
  })
})
