import { describe, expect, it } from 'vitest'
import { declaredRates, SOAK_PROFILE, SOAK_TICK_MS, startLoad, type SoakClock, type SoakEmit } from './lib/soakLoad'

function fakeClock(): SoakClock & { advance(ms: number, step?: number): void } {
  let now = 1_000_000
  const timers = new Set<() => void>()
  return {
    now: () => now,
    every: (_ms, fn) => {
      timers.add(fn)
      return () => timers.delete(fn)
    },
    advance(ms, step = SOAK_TICK_MS) {
      for (let t = 0; t < ms; t += step) {
        now += step
        for (const fn of timers) fn()
      }
    }
  }
}

describe('soak load', () => {
  it('declares the box-shaped rates', () => {
    expect(declaredRates()).toEqual({ meta: 8, delta: 30, tool: 0.2, log: 5 })
    expect(SOAK_PROFILE.children).toBe(16)
  })

  it('produces the declared rates over 60 s of fake time', () => {
    const clock = fakeClock()
    const seen: SoakEmit[] = []
    const driver = startLoad((emit) => seen.push(emit), clock)
    clock.advance(60_000)
    driver.stop()
    const rates = declaredRates()
    const counts = driver.counts()
    for (const kind of ['meta', 'delta', 'tool', 'log'] as const) {
      expect(Math.abs(counts[kind] - rates[kind] * 60)).toBeLessThanOrEqual(SOAK_PROFILE.streams.filter((s) => s.kind === kind).length)
    }
    expect(seen.length).toBe(counts.meta + counts.delta + counts.tool + counts.log)
    // every child's meta changes, each at its own rate
    for (let child = 0; child < 16; child++) {
      const n = seen.filter((e) => e.kind === 'meta' && e.child === child).length
      expect(n === 30 || n === 31).toBe(true)
    }
    // the focused child carries the fast stream and the tool calls
    expect(seen.filter((e) => e.kind === 'delta' && e.child === 0).length).toBe(1200)
    expect(seen.filter((e) => e.kind === 'tool' && e.child === 0).length).toBe(12)
  })

  it('catches up after a slow tick instead of drifting', () => {
    const clock = fakeClock()
    const driver = startLoad(() => {}, clock)
    clock.advance(10_000, 2_500)
    expect(driver.counts().delta).toBe(300)
    driver.stop()
  })

  it('spreads the metas over their period', () => {
    const clock = fakeClock()
    const seen: SoakEmit[] = []
    const driver = startLoad((emit) => seen.push(emit), clock)
    clock.advance(2_000)
    driver.stop()
    const children = new Set(seen.filter((e) => e.kind === 'meta').map((e) => e.child))
    expect(children.size).toBe(16)
  })
})
