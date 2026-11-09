import { describe, expect, it } from 'vitest'
import { interrupts } from './mac/ax-reader-proof'

// The live proof's watch (scripts/mac/ax-reader-proof.ts): the person's rule of
// 2026-11-09 is that a step is aborted the moment their input resumes, and
// only once its own five-minute idle gate has passed.
describe('the proof watch', () => {
  it('leaves the idle wait alone, guards the step once its gate passed, and fires once', () => {
    const step = 'chrome'
    // active while the step still waits for its gate: the wait's business, not an interruption
    expect(interrupts(step, { cameBack: '', gateOpen: '', idle: 0.3 })).toBe(false)
    // the gate passed and the person is away
    expect(interrupts(step, { cameBack: '', gateOpen: step, idle: 312 })).toBe(false)
    // input resumes mid-step
    expect(interrupts(step, { cameBack: '', gateOpen: step, idle: 0.4 })).toBe(true)
    // already interrupted: nothing more to do
    expect(interrupts(step, { cameBack: step, gateOpen: step, idle: 0.4 })).toBe(false)
    // another step's gate never arms this one
    expect(interrupts(step, { cameBack: '', gateOpen: 'textedit', idle: 0.4 })).toBe(false)
  })
})
