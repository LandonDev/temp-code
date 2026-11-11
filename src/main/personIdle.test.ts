import { beforeEach, describe, expect, it } from 'vitest'
import { OWN_SPANS_MAX, PersonIdle, type OwnSpan } from './personIdle'

// A fake Mac: `now` moves by hand, and the raw idle time is whole seconds since the last input of anyone.
let now = 0
let lastInput = 0
const raw = { getSystemIdleTime: () => Math.floor((now - lastInput) / 1000) }
let idle: PersonIdle

const T0 = 1_800_000_000_000
const input = (at: number): void => {
  lastInput = at
}
/** A session step the service ran from `armedAt` to `lastInputAt`, posting input as it went. */
const step = (armedAt: number, lastInputAt: number): OwnSpan => {
  const span = { armedAt, lastInputAt, idleAtArmMs: armedAt - lastInput }
  input(lastInputAt)
  return span
}

beforeEach(() => {
  now = T0
  lastInput = T0 - 300_000
  idle = new PersonIdle(raw, () => now)
})

describe('PersonIdle', () => {
  it('passes the raw value through with no spans', () => {
    expect(idle.getSystemIdleTime()).toBe(300)
    input(now - 4_500)
    expect(idle.getSystemIdleTime()).toBe(4)
  })

  it('reads input inside a span as the person last touching the Mac before it', () => {
    const own = idle.beginOwn()
    const span = step(T0 + 100, T0 + 900)
    now = T0 + 1_200
    own.end([span])
    expect(idle.getSystemIdleTime()).toBe(301)
    now = T0 + 60_000
    expect(idle.getSystemIdleTime()).toBe(360)
  })

  it("shows input after the span's last event plus the slack: the call's closing wait is the person's", () => {
    const own = idle.beginOwn()
    const span = step(T0 + 100, T0 + 900)
    input(T0 + 2_400)
    now = T0 + 3_000
    own.end([span])
    expect(idle.getSystemIdleTime()).toBe(0)
  })

  it("shows input in the gap between two steps of one batch", () => {
    const own = idle.beginOwn()
    const a = step(T0 + 100, T0 + 900)
    input(T0 + 3_000)
    const b = step(T0 + 5_000, T0 + 5_400)
    now = T0 + 6_000
    own.end([a, b])
    // b's arm read the person's key at T0 + 3000
    expect(idle.getSystemIdleTime()).toBe(3)
  })

  it('chains spans: the input before one span falls in an earlier span', () => {
    const own = idle.beginOwn()
    const a = step(T0 + 100, T0 + 900)
    const b = step(T0 + 1_200, T0 + 1_800)
    now = T0 + 10_000
    own.end([a, b])
    expect(idle.getSystemIdleTime()).toBe(310)
  })

  it("hides nothing for an interrupted call's end([])", () => {
    const own = idle.beginOwn()
    step(T0 + 100, T0 + 900)
    input(T0 + 1_000) // the person's touch that stopped the step
    now = T0 + 2_000
    own.end([])
    expect(idle.getSystemIdleTime()).toBe(1)
  })

  it('hides input after an open call starts, and end() replaces that with its spans', () => {
    const own = idle.beginOwn()
    const span = step(T0 + 100, T0 + 900)
    now = T0 + 1_000
    expect(idle.getSystemIdleTime()).toBe(301)
    input(T0 + 4_000) // the person, during the call's closing wait
    now = T0 + 5_000
    expect(idle.getSystemIdleTime()).toBe(305)
    own.end([span])
    expect(idle.getSystemIdleTime()).toBe(1)
  })

  it('ignores a second end of the same window', () => {
    const own = idle.beginOwn()
    const span = step(T0 + 100, T0 + 900)
    own.end([span])
    own.end([])
    now = T0 + 2_000
    expect(idle.getSystemIdleTime()).toBe(302)
  })

  it("keeps a person's mark inside a kept span, even when raw idle still reads the app's input", () => {
    const own = idle.beginOwn()
    const span = step(T0 + 100, T0 + 900)
    now = T0 + 1_200
    own.end([span])
    idle.markPerson(T0 + 500)
    now = T0 + 2_500
    expect(idle.getSystemIdleTime()).toBe(2)
    input(now)
    expect(idle.getSystemIdleTime()).toBe(0)
  })

  it("keeps a person's mark inside an open call and after its spans arrive", () => {
    const own = idle.beginOwn()
    const span = step(T0 + 100, T0 + 900)
    now = T0 + 1_200
    idle.markPerson(T0 + 500)
    now = T0 + 2_500
    expect(idle.getSystemIdleTime()).toBe(2)
    own.end([span])
    expect(idle.getSystemIdleTime()).toBe(2)
  })

  it('keeps the latest mark and ignores future and invalid marks', () => {
    idle.markPerson(T0 - 4_000)
    idle.markPerson(T0 - 10_000)
    idle.markPerson(T0 + 1_000)
    idle.markPerson(NaN)
    idle.markPerson(Infinity)
    expect(idle.getSystemIdleTime()).toBe(4)
  })

  it(`keeps the newest ${OWN_SPANS_MAX} spans`, () => {
    for (let i = 0; i <= OWN_SPANS_MAX; i++) {
      const at = T0 + i * 10_000
      now = at
      const own = idle.beginOwn()
      const span = step(at + 100, at + 900)
      now = at + 1_000
      own.end([span])
    }
    // the newest span chains back through every kept one to the dropped first span's last event, which now shows
    now = T0 + OWN_SPANS_MAX * 10_000 + 1_000
    expect(idle.getSystemIdleTime()).toBe(Math.floor((now - (T0 + 900)) / 1000))
  })

  it('drops spans an hour old', () => {
    const own = idle.beginOwn()
    const span = step(T0 + 100, T0 + 900)
    own.end([span])
    now = T0 + 3_700_000
    // a later call's end prunes; the old span no longer hides its own input
    idle.beginOwn().end([])
    expect(idle.getSystemIdleTime()).toBe(Math.floor((now - (T0 + 900)) / 1000))
  })
})
