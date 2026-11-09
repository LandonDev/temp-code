import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttentionWatcher } from './attention'
import { MacPresenceWatcher } from './presence'
import { PersonIdle } from './personIdle'

let idle = 0
let presence: MacPresenceWatcher
let watcher: AttentionWatcher
let seen: boolean[]

beforeEach(() => {
  vi.useFakeTimers()
  idle = 0
  presence = new MacPresenceWatcher({ initial: { screen: 'unlocked', power: 'awake' } })
  watcher = new AttentionWatcher(presence, { getSystemIdleTime: () => idle })
  seen = []
  watcher.onChange((p) => seen.push(p))
  watcher.start()
})
afterEach(() => {
  watcher.stop()
  vi.useRealTimers()
})

describe('AttentionWatcher', () => {
  it('is present with recent input, away after two idle minutes, back on input', () => {
    expect(watcher.isPresent()).toBe(true)
    idle = 119
    vi.advanceTimersByTime(5_000)
    expect(seen).toEqual([])
    idle = 120
    vi.advanceTimersByTime(5_000)
    expect(seen).toEqual([false])
    vi.advanceTimersByTime(30_000)
    expect(seen).toEqual([false])
    idle = 1
    vi.advanceTimersByTime(5_000)
    expect(seen).toEqual([false, true])
  })
  it('a locked screen or a sleeping Mac is away at once, whatever the idle time', () => {
    presence.set({ screen: 'locked' })
    expect(seen).toEqual([false])
    presence.set({ screen: 'unlocked' })
    expect(seen).toEqual([false, true])
    presence.set({ power: 'asleep' })
    expect(watcher.isPresent()).toBe(false)
    presence.set({ power: 'awake' })
    expect(seen).toEqual([false, true, false, true])
  })
  it("stays away through the app's own session input when it reads a PersonIdle", () => {
    watcher.stop()
    const t0 = Date.now()
    let lastInput = t0 - 300_000
    const raw = { getSystemIdleTime: () => Math.floor((Date.now() - lastInput) / 1000) }
    const person = new PersonIdle(raw)
    const over = new AttentionWatcher(presence, person)
    const changes: boolean[] = []
    over.onChange((p) => changes.push(p))
    over.start()
    expect(over.isPresent()).toBe(false)
    const own = person.beginOwn()
    const armedAt = Date.now()
    const idleAtArmMs = armedAt - lastInput
    vi.advanceTimersByTime(800)
    lastInput = Date.now() // the step's own key
    own.end([{ armedAt, lastInputAt: lastInput, idleAtArmMs }])
    vi.advanceTimersByTime(30_000)
    expect(changes).toEqual([])
    lastInput = Date.now() // the person
    vi.advanceTimersByTime(5_000)
    expect(changes).toEqual([true])
    over.stop()
  })
  it('stops polling once stopped', () => {
    watcher.stop()
    idle = 500
    vi.advanceTimersByTime(60_000)
    expect(seen).toEqual([])
  })
})
