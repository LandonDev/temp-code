import { describe, expect, it } from 'vitest'
import {
  RECENT_COPY_MS,
  SCHEDULE,
  SESSION_REFUSALS,
  askAfter,
  clipboardQuiet,
  formatHeldLine,
  freedom,
  sessionIdleMs,
  sessionRefusalWords,
  waitedWords,
  type FreedomInput
} from './scheduleRules'

const NOW = 1_800_000_000_000
const base: FreedomInput = {
  now: NOW,
  idleS: 0,
  presence: { screen: 'unlocked', power: 'awake' },
  awaySwitch: false,
  sessionIdleMs: 120_000,
  leaseFrom: null
}
const at = (patch: Partial<FreedomInput>): FreedomInput => ({ ...base, ...patch })

describe('freedom', () => {
  it('reads a present person as present', () => {
    expect(freedom(base)).toEqual({ free: false, why: 'present' })
    expect(freedom(at({ idleS: 30 }))).toEqual({ free: false, why: 'present' })
  })

  it('admits once the idle time reaches the setting, read as given', () => {
    expect(freedom(at({ idleS: 119 }))).toEqual({ free: false, why: 'present' })
    expect(freedom(at({ idleS: 120 }))).toEqual({ free: true, via: 'away' })
    expect(freedom(at({ idleS: 8, sessionIdleMs: 8_000 }))).toEqual({ free: true, via: 'away' })
  })

  it('takes the Away switch only after ten seconds of quiet', () => {
    expect(freedom(at({ awaySwitch: true, idleS: 3 }))).toEqual({ free: false, why: 'present' })
    expect(freedom(at({ awaySwitch: true, idleS: 9 }))).toEqual({ free: false, why: 'present' })
    expect(freedom(at({ awaySwitch: true, idleS: 10 }))).toEqual({ free: true, via: 'switch' })
    expect(freedom(at({ awaySwitch: true, idleS: 12 }))).toEqual({ free: true, via: 'switch' })
  })

  it('names away over the switch when both hold', () => {
    expect(freedom(at({ awaySwitch: true, idleS: 200 }))).toEqual({ free: true, via: 'away' })
  })

  it('refuses asleep before locked, and both before a lease or away', () => {
    const asleepLocked = at({ presence: { screen: 'locked', power: 'asleep' }, idleS: 999, leaseFrom: NOW })
    expect(freedom(asleepLocked)).toEqual({ free: false, why: 'asleep' })
    const locked = at({ presence: { screen: 'locked', power: 'awake' }, idleS: 999, leaseFrom: NOW, awaySwitch: true })
    expect(freedom(locked)).toEqual({ free: false, why: 'locked' })
  })

  it('reads an unknown screen and power as unlocked and awake', () => {
    expect(freedom(at({ presence: { screen: 'unknown', power: 'unknown' }, idleS: 120 }))).toEqual({ free: true, via: 'away' })
  })

  it('admits a lease before away, until the person next touches the Mac', () => {
    const leaseFrom = NOW - 20_000
    // last input 20 s ago, at the Allow's own click: inside the lease
    expect(freedom(at({ leaseFrom, idleS: 20, sessionIdleMs: 8_000 }))).toEqual({ free: true, via: 'allowed' })
    // last input 19 s ago: within the slack after the Allow
    expect(freedom(at({ leaseFrom, idleS: 19 }))).toEqual({ free: true, via: 'allowed' })
    // last input 18 s ago: 2 s after the Allow, past the 1.5 s slack, so the lease is over
    expect(freedom(at({ leaseFrom, idleS: 18 }))).toEqual({ free: false, why: 'present' })
    expect(freedom(at({ leaseFrom, idleS: 0 }))).toEqual({ free: false, why: 'present' })
  })
})

describe('sessionIdleMs', () => {
  it('reads the default when unset or junk', () => {
    expect(sessionIdleMs(null)).toBe(120_000)
    expect(sessionIdleMs('')).toBe(120_000)
    expect(sessionIdleMs('soon')).toBe(120_000)
    expect(sessionIdleMs('1.5e4')).toBe(120_000)
    expect(sessionIdleMs('-8000')).toBe(120_000)
  })

  it('refuses a value outside 5 s to an hour', () => {
    expect(sessionIdleMs('4999')).toBe(120_000)
    expect(sessionIdleMs('3600001')).toBe(120_000)
  })

  it('takes a valid value', () => {
    expect(sessionIdleMs('5000')).toBe(5_000)
    expect(sessionIdleMs(' 8000 ')).toBe(8_000)
    expect(sessionIdleMs('3600000')).toBe(3_600_000)
  })
})

describe('askAfter', () => {
  it('waits three minutes in full access and asks at once otherwise', () => {
    expect(askAfter('auto')).toBe(180_000)
    expect(askAfter('safe')).toBe(0)
    expect(askAfter('edits')).toBe(0)
    expect(askAfter('auto', 5_000)).toBe(5_000)
    expect(askAfter('safe', 5_000)).toBe(0)
  })
})

describe('clipboardQuiet', () => {
  it('counts from the last foreign change', () => {
    expect(clipboardQuiet({ foreignChangeAt: NOW - 2_000, watchingSince: NOW - 60_000 }, NOW)).toBe(false)
    expect(clipboardQuiet({ foreignChangeAt: NOW - 5_000, watchingSince: NOW - 60_000 }, NOW)).toBe(true)
  })

  it('counts the watch starting as a change, so a copy made before it still counts', () => {
    expect(clipboardQuiet({ foreignChangeAt: null, watchingSince: NOW - 1_000 }, NOW)).toBe(false)
    expect(clipboardQuiet({ foreignChangeAt: null, watchingSince: NOW - 5_000 }, NOW)).toBe(true)
    expect(clipboardQuiet({ foreignChangeAt: NOW - 60_000, watchingSince: NOW - 3_000 }, NOW)).toBe(false)
  })

  it('names the shell proof constant', () => {
    expect(RECENT_COPY_MS).toBe(5_000)
    expect(SCHEDULE.pasteWaitMaxMs).toBe(10_000)
  })
})

describe('the held line', () => {
  it('says how long and why', () => {
    expect(formatHeldLine({ waitedMs: 134_000, via: 'away' })).toBe('waited 2m 14s for the Mac to be free')
    expect(formatHeldLine({ waitedMs: 12_000, via: 'switch' })).toBe('waited 12s for the Mac to be free')
    expect(formatHeldLine({ waitedMs: 180_000, via: 'allowed' })).toBe(
      'waited 3m for the Mac to be free, then the person chose Run now'
    )
    expect(formatHeldLine({ waitedMs: 4_200, via: 'clipboard' })).toBe('waited 4s for the clipboard, the person had just copied')
  })

  it('says nothing under a second', () => {
    expect(formatHeldLine({ waitedMs: 0, via: 'away' })).toBeNull()
    expect(formatHeldLine({ waitedMs: 999, via: 'clipboard' })).toBeNull()
  })

  it('writes durations past an hour', () => {
    expect(waitedWords(3_600_000)).toBe('1h')
    expect(waitedWords(3_720_000)).toBe('1h 2m')
    expect(waitedWords(59_600)).toBe('1m')
  })
})

describe('refusal words', () => {
  it('has words for every reason', () => {
    const words = Object.fromEntries(SESSION_REFUSALS.map((r) => [r, sessionRefusalWords(r, 'TextEdit')]))
    expect(words).toEqual({
      'no-scheduler': 'nothing schedules it yet',
      'screen-locked': "the Mac's screen is locked",
      asleep: 'the Mac is asleep',
      skipped: 'the person did not choose Run now',
      'skipped-earlier': 'the person did not choose Run now for TextEdit earlier in this turn',
      cancelled: 'the call was given up'
    })
    expect(sessionRefusalWords('skipped-earlier')).toBe('the person did not choose Run now earlier in this turn')
  })
})
