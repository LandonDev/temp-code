import { describe, expect, it } from 'vitest'
import { BURST_STALL_EVERY_MS, BURST_STALL_MS, burstOpen, CHAT_PROFILE, declaredRates, profileOf, SOAK_PROFILE, SOAK_TICK_MS, startLoad, type SoakClock, type SoakEmit } from './lib/soakLoad'

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

  it("gives the chat scene the focused child's load alone", () => {
    expect(declaredRates(CHAT_PROFILE)).toEqual({ meta: 0.5, delta: 20, tool: 0.2, log: 0 })
    expect(CHAT_PROFILE.streams.every((s) => s.child === 0)).toBe(true)
    expect(profileOf('chat')).toBe(CHAT_PROFILE)
    expect(profileOf('board')).toBe(SOAK_PROFILE)
  })

  it('a burst cadence: the focused stream\'s owed deltas leave together about every burst, its rate kept', () => {
    const clock = fakeClock()
    const at: { t: number; emit: SoakEmit }[] = []
    let r = 0
    const driver = startLoad((emit) => at.push({ t: clock.now(), emit }), clock, CHAT_PROFILE, { everyMs: 250, random: () => (r = (r + 0.37) % 1) })
    clock.advance(30_000)
    driver.stop()
    const deltas = at.filter((a) => a.emit.kind === 'delta')
    // The stream's rate is kept: it is only regrouped.
    expect(Math.abs(deltas.length - 20 * 30)).toBeLessThanOrEqual(20)
    const releases = [...new Set(deltas.map((d) => d.t))]
    const gaps = releases.slice(1).map((t, i) => t - releases[i]!)
    // Bursts of several deltas each, 250 ms ± 30% apart (a tick's rounding on top).
    expect(deltas.length / releases.length).toBeGreaterThan(3)
    const ordinary = gaps.filter((g) => g < BURST_STALL_MS)
    expect(Math.min(...ordinary)).toBeGreaterThanOrEqual(0.7 * 250 - SOAK_TICK_MS)
    expect(Math.max(...ordinary)).toBeLessThanOrEqual(1.3 * 250 + SOAK_TICK_MS)
    // The other streams keep their own cadence (the tool calls, the metas).
    expect(at.filter((a) => a.emit.kind === 'tool').length).toBe(6)
  })

  it('a burst cadence stalls for BURST_STALL_MS every BURST_STALL_EVERY_MS, then releases what it held', () => {
    expect(burstOpen(0)).toBe(true)
    expect(burstOpen(BURST_STALL_EVERY_MS - BURST_STALL_MS - 1)).toBe(true)
    expect(burstOpen(BURST_STALL_EVERY_MS - BURST_STALL_MS)).toBe(false)
    expect(burstOpen(BURST_STALL_EVERY_MS)).toBe(true)
    const clock = fakeClock()
    const start = clock.now()
    const at: number[] = []
    const driver = startLoad((emit) => emit.kind === 'delta' && at.push(clock.now() - start), clock, CHAT_PROFILE, { everyMs: 100, random: () => 0.5 })
    clock.advance(25_000)
    driver.stop()
    // Nothing leaves inside a stall, and the release after it carries the second's deltas.
    expect(at.filter((t) => t % BURST_STALL_EVERY_MS >= BURST_STALL_EVERY_MS - BURST_STALL_MS)).toEqual([])
    const after = at.filter((t) => t === at.find((x) => x >= BURST_STALL_EVERY_MS))
    expect(after.length).toBeGreaterThanOrEqual(18)
  })

  it('no burst cadence leaves the stream as it was', () => {
    const clock = fakeClock()
    const seen: SoakEmit[] = []
    const driver = startLoad((emit) => seen.push(emit), clock, CHAT_PROFILE, null)
    clock.advance(10_000)
    driver.stop()
    expect(seen.filter((e) => e.kind === 'delta').length).toBe(200)
  })
})
