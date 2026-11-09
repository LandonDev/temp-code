import { describe, expect, it } from 'vitest'
import { OwnInput, personSince } from './proofGate'

const INTERVAL = 1_000

/** Polls every interval from 0 to `until`; the first poll that reads the person, or null. */
function firstRead(own: OwnInput, lastInputAt: (now: number) => number, until = 30_000): number | null {
  for (let now = 0; now <= until; now += INTERVAL) {
    if (personSince(now, (now - lastInputAt(now)) / 1_000, 0, own)) return now
  }
  return null
}

/** Five 2 s posting calls from 1 s on, each `paced` by clearAt or 100 ms after the last. */
function calls(paced: boolean): OwnInput {
  const own = new OwnInput(500)
  let t = 1_000
  for (let i = 0; i < 5; i++) {
    if (paced) t = Math.max(t, own.clearAt(INTERVAL))
    const span = own.open(t)
    span.to = t + 2_000
    t = span.to + 100
  }
  return own
}

describe('the proof gate', () => {
  it("reads input inside a posting call, or within the margin after its answer, as the proof's own", () => {
    const own = new OwnInput(500)
    const span = own.open(1_000)
    expect(own.covers(5_000)).toBe(true) // still out
    span.to = 2_000
    expect(own.covers(1_500)).toBe(true)
    expect(own.covers(2_400)).toBe(true)
    expect(own.covers(2_600)).toBe(false)
    expect(own.covers(800)).toBe(false)
  })

  it('reads input since the try began, and none before it', () => {
    const own = new OwnInput()
    expect(personSince(10_000, 1, 5_000, own)).toBe(true)
    expect(personSince(10_000, 6, 5_000, own)).toBe(false)
  })

  it("never reads the proof's own events as the person", () => {
    const own = calls(true)
    // the proof posts half a second into each call and at its end
    const posted = own.spans.flatMap((s) => [s.from + 500, s.to!])
    expect(firstRead(own, (now) => Math.max(0, ...posted.filter((p) => p <= now)))).toBeNull()
  })

  it('reads input that keeps going across paced calls within a call, the margin and an interval', () => {
    const from = 2_500
    const read = firstRead(calls(true), (now) => (now >= from ? now : 0))
    expect(read).not.toBeNull()
    expect(read! - from).toBeLessThanOrEqual(2_000 + 500 + INTERVAL)
  })

  it('would miss it for the whole run without the pacing: spans that meet mask each other', () => {
    const from = 2_500
    const read = firstRead(calls(false), (now) => (now >= from ? now : 0))
    expect(read! - from).toBeGreaterThan(9_000)
  })

  it('lets a call go at once when none came before, or the last is still out', () => {
    const own = new OwnInput(500)
    expect(own.clearAt(INTERVAL)).toBe(0)
    own.open(1_000)
    expect(own.clearAt(INTERVAL)).toBe(0)
  })
})
