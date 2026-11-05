import { describe, expect, it } from 'vitest'
import {
  BURST_STALL_EVERY_MS,
  BURST_STALL_MS,
  burstOpen,
  CHAT_PROFILE,
  declaredRates,
  owedAt,
  profileOf,
  SOAK_PROFILE,
  SOAK_TICK_MS,
  startLoad,
  TYPING_FLOOD_EVERY_MS,
  TYPING_FLOOD_SIZE,
  TYPING_PROFILE,
  TYPING_SETTLERS,
  type SoakClock,
  type SoakEmit
} from './lib/soakLoad'

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
    expect(declaredRates()).toEqual({ meta: 8, delta: 30, tool: 0.2, log: 5, settle: 0, resume: 0, edit: 0, flood: 0 })
    expect(SOAK_PROFILE.children).toBe(16)
  })

  it("the typing scene: the board's load, the master's churn and its live edits", () => {
    expect(profileOf('typing')).toBe(TYPING_PROFILE)
    expect(declaredRates(TYPING_PROFILE)).toEqual({ meta: 8.1, delta: 30, tool: 0.2, log: 5, settle: 0.5, resume: 0.5, edit: 10, flood: 40 })
    // The settlers never include a child whose transcript streams.
    expect(TYPING_SETTLERS).toHaveLength(13)
    expect(TYPING_SETTLERS.some((i) => i === SOAK_PROFILE.focused || SOAK_PROFILE.streamers.includes(i))).toBe(false)
  })

  it('the typing streams keep their rates over 60 s of fake time', () => {
    const clock = fakeClock()
    const seen: { t: number; emit: SoakEmit }[] = []
    const start = clock.now()
    const driver = startLoad((emit) => seen.push({ t: clock.now() - start, emit }), clock, TYPING_PROFILE)
    clock.advance(60_000)
    driver.stop()
    const counts = driver.counts()
    const rates = declaredRates(TYPING_PROFILE)
    for (const kind of ['settle', 'resume', 'edit', 'flood'] as const) expect(Math.abs(counts[kind] - rates[kind] * 60)).toBeLessThanOrEqual(1)
    expect(seen.filter((s) => s.emit.kind === 'meta' && s.emit.child === null)).toHaveLength(6)
    // Each settle comes a second before its resume.
    const settles = seen.filter((s) => s.emit.kind === 'settle')
    const resumes = seen.filter((s) => s.emit.kind === 'resume')
    for (const [i, s] of settles.entries()) if (resumes[i]) expect(resumes[i]!.t - s.t).toBeCloseTo(1_000, -2)
    // The floods: 400 edits inside the first second of every ten, nothing between.
    const floods = seen.filter((s) => s.emit.kind === 'flood')
    expect(floods.every((f) => f.t % TYPING_FLOOD_EVERY_MS <= 1_000 + SOAK_TICK_MS)).toBe(true)
    expect(floods.filter((f) => f.t < TYPING_FLOOD_EVERY_MS)).toHaveLength(TYPING_FLOOD_SIZE)
  })

  it('a windowed stream owes nothing between its windows', () => {
    const flood = TYPING_PROFILE.streams.find((s) => s.kind === 'flood')!
    expect(owedAt(flood, 500)).toBe(200)
    expect(owedAt(flood, 1_000)).toBe(400)
    expect(owedAt(flood, 9_999)).toBe(400)
    expect(owedAt(flood, 10_500)).toBe(600)
  })

  it('a pause holds every stream, and a resume carries on without paying the pause', () => {
    const clock = fakeClock()
    const driver = startLoad(() => {}, clock, TYPING_PROFILE)
    clock.advance(5_000)
    const before = driver.counts()
    driver.pause()
    clock.advance(20_000)
    expect(driver.counts()).toEqual(before)
    driver.resume()
    clock.advance(5_000)
    driver.stop()
    const after = driver.counts()
    // Ten seconds of load in all: one flood, a hundred steady edits.
    expect(after.flood).toBe(TYPING_FLOOD_SIZE)
    expect(Math.abs(after.edit - 100)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.delta - 300)).toBeLessThanOrEqual(3)
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
    expect(declaredRates(CHAT_PROFILE)).toEqual({ meta: 0.5, delta: 20, tool: 0.2, log: 0, settle: 0, resume: 0, edit: 0, flood: 0 })
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
