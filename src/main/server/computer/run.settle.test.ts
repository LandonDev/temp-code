import { afterEach, describe, expect, it, vi } from 'vitest'

// The words of a call's end are made by pure functions; this file makes them throw, to pin what the journal does
// when its own wording fails: nothing reaches the answer, and the entry still ends.
vi.mock('@shared/computer/historyWords', async (original) => ({
  ...(await original<typeof import('@shared/computer/historyWords')>()),
  settledSteps: () => {
    throw new Error('wording failed')
  }
}))

import { computerHarness, type ComputerHarness } from './runHarness'

const harnesses: ComputerHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})

describe('a call whose end cannot be worded', () => {
  it('answers as it would, and its entry still ends, as what was asked: no reader goes on showing it as running', async () => {
    const h = computerHarness({ history: { pictures: () => false } })
    harnesses.push(h)
    const read = await h.run('computer_observe', { app: 'TextEdit' })
    expect(read.isError).toBe(false)
    const out = await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: 21 }, { action: 'key', text: 'super+s' }] })
    expect(out.isError).toBe(false)
    await h.sessions.drained('t1')
    const calls = (await h.history!.read(['t1']))[0].calls
    expect(calls.map((c) => c.state)).toEqual(['done', 'done'])
    expect(calls[0].steps.map((s) => s.verb)).toEqual(['Read'])
    expect(calls[1].steps.map((s) => [s.verb, s.object])).toEqual([['Click', 'bold'], ['Press', '⌘S']])
    for (const step of calls[1].steps) expect(step).not.toHaveProperty('asked')
  })
})
