import { describe, expect, it } from 'vitest'
import { scenarioTimeline, uniqueScenarioIds } from './lib/soakScenarios'

describe('uniqueScenarioIds', () => {
  const events = scenarioTimeline().flatMap((step) => step.events)

  it('keeps the first play as written', () => {
    for (const event of events) expect(uniqueScenarioIds(event, 1)).toBe(event)
  })

  it('gives a later play ids of its own, so it never folds into the first', () => {
    const ids = (play: number): Set<string> =>
      new Set(
        events.flatMap((event) => {
          const e = uniqueScenarioIds(event, play) as unknown as Record<string, unknown>
          return ['msgId', 'callId', 'steerId', 'requestId'].flatMap((k) => (typeof e[k] === 'string' ? [String(e[k])] : []))
        }),
      )
    const first = ids(1)
    const second = ids(2)
    expect(second.size).toBe(first.size)
    for (const id of second) expect(first.has(id)).toBe(false)
  })

  it('changes nothing else in an event', () => {
    const call = events.find((e) => e.type === 'tool-call')!
    expect({ ...uniqueScenarioIds(call, 3), callId: undefined }).toEqual({ ...call, callId: undefined })
  })
})
