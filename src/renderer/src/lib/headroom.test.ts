import { describe, expect, it } from 'vitest'
import { headroomLook } from './headroom'

const now = 1_800_000_000_000
const MIN = 60_000

describe('headroomLook', () => {
  it('no answer yet: an empty bar and a muted word', () => {
    expect(headroomLook(undefined, now)).toMatchObject({ percent: 0, text: 'No answer yet', until: null, tone: 'muted' })
    expect(headroomLook({ room: null, ratePerMin: 0, seenAt: null }, now)).toMatchObject({ percent: 0, tone: 'muted' })
  })
  it('a 429 cooldown: an empty bar, Limited with the time left, and the pick-again moment on hover', () => {
    const look = headroomLook({ room: 0.8, ratePerMin: 3, seenAt: now, throttledUntil: now + 5 * MIN }, now)
    expect(look).toMatchObject({ percent: 0, text: 'Limited', until: '5m', tone: 'limited' })
    expect(look.lines).toHaveLength(2)
    expect(look.lines[0]).toMatch(/^Picks again .*, in 5m$/)
    expect(look.lines[1]).toBe('3 answers in the last minute, every host')
    // Lifted: back to what is left.
    expect(headroomLook({ room: 0.8, ratePerMin: 3, seenAt: now, throttledUntil: now - 1 }, now)).toMatchObject({ percent: 80, text: '80% left', tone: 'ok' })
  })
  it('room left: the fill, the percent, and the refill on hover; low under a quarter', () => {
    const look = headroomLook({ room: 0.62, ratePerMin: 1, seenAt: now, resetsAt: now + 90_000, tier: 'allowed_warning' }, now)
    expect(look).toMatchObject({ percent: 62, text: '62% left', until: null, tone: 'ok' })
    expect(look.lines[0]).toMatch(/^Refills .*, in 1m$/)
    expect(look.lines.slice(1)).toEqual(['1 answer in the last minute, every host', 'Provider says allowed_warning'])
    expect(headroomLook({ room: 0.1, ratePerMin: 0, seenAt: now }, now)).toMatchObject({ percent: 10, tone: 'low', lines: ['No reset announced'] })
    // A reset already past says nothing.
    expect(headroomLook({ room: 0.5, ratePerMin: 0, seenAt: now, resetsAt: now - 1 }, now).lines).toEqual(['No reset announced'])
  })
  it('never joins its words with a middle dot or a line break', () => {
    const looks = [
      headroomLook({ room: 0.8, ratePerMin: 3, seenAt: now, throttledUntil: now + 5 * MIN }, now),
      headroomLook({ room: 0.62, ratePerMin: 1, seenAt: now, resetsAt: now + 90_000, tier: 'x' }, now)
    ]
    for (const look of looks) for (const s of [look.text, ...look.lines]) expect(s).not.toMatch(/·|\n/)
  })
})
