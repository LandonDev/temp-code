import { describe, expect, it } from 'vitest'
import { cleanupStack, interrupts } from './mac/ax-reader-proof'

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

describe('the proof cleanup', () => {
  it('makes every caller wait for the run in flight, steps pushed during it included', async () => {
    const { steps, run } = cleanupStack()
    const done: string[] = []
    let release!: () => void
    steps.push(() => void done.push('first'))
    steps.push(() => new Promise<void>((r) => (release = () => (done.push('slow'), r()))))
    const watchdog = run()
    // the step loop's finally arrives while the watchdog's run waits on the slow step
    const finallyRun = run()
    steps.push(() => void done.push('late'))
    let settled = false
    void finallyRun.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    release()
    await finallyRun
    await watchdog
    expect(done).toEqual(['slow', 'late', 'first'])
    expect(steps).toEqual([])
  })
})
