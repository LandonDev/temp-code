import { describe, expect, it } from 'vitest'
import { headroomLook } from './headroom'

const now = 1_800_000_000_000
const MIN = 60_000

describe('headroomLook', () => {
  it('no answer yet: an empty bar and a muted word', () => {
    expect(headroomLook(undefined, now)).toMatchObject({ percent: 0, text: 'no answer yet', tone: 'muted' })
    expect(headroomLook({ room: null, ratePerMin: 0, seenAt: null }, now)).toMatchObject({ percent: 0, tone: 'muted' })
  })
  it('a 429 cooldown: an empty bar, the time left, and the pick-again moment on hover', () => {
    const look = headroomLook({ room: 0.8, ratePerMin: 3, seenAt: now, throttledUntil: now + 5 * MIN }, now)
    expect(look).toMatchObject({ percent: 0, text: 'rate limited · 5m', tone: 'limited' })
    expect(look.title).toMatch(/^Rate limited · picks again .* \(in 5m\)\n3 answers in the last minute, every host$/)
    // Lifted: back to what is left.
    expect(headroomLook({ room: 0.8, ratePerMin: 3, seenAt: now, throttledUntil: now - 1 }, now)).toMatchObject({ percent: 80, text: '80% left', tone: 'ok' })
  })
  it('room left: the fill, the percent, and the refill on hover; low under a quarter', () => {
    const look = headroomLook({ room: 0.62, ratePerMin: 1, seenAt: now, resetsAt: now + 90_000, tier: 'allowed_warning' }, now)
    expect(look).toMatchObject({ percent: 62, text: '62% left', tone: 'ok' })
    expect(look.title).toMatch(/^Refills .* \(in 1m\)\n1 answer in the last minute, every host\nProvider says allowed_warning$/)
    expect(headroomLook({ room: 0.1, ratePerMin: 0, seenAt: now }, now)).toMatchObject({ percent: 10, tone: 'low', title: 'No reset announced' })
    // A reset already past says nothing.
    expect(headroomLook({ room: 0.5, ratePerMin: 0, seenAt: now, resetsAt: now - 1 }, now).title).toBe('No reset announced')
  })
})
