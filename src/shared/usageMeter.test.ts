import { describe, expect, it } from 'vitest'
import type { ProfileView, UsageReport } from 'aliax-core/shared/types'
import { emptyAccounts, type AccountHeadroom, type AccountsSnapshot } from './accounts'
import { isLow, meterFor, untilShort, windowName } from './usageMeter'

const NOW = 1_000_000_000
const MIN = 60_000
const HOUR = 3_600_000

const profile = (name: string): ProfileView => ({ name, email: name, createdAt: 1, active: false })
type W = [label: string, usedPercent: number, resetsAt?: number]
const report = (name: string, windows: W[], extra: Partial<UsageReport> = {}): UsageReport => ({
  profileName: name,
  windows: windows.map(([label, usedPercent, resetsAt]) => ({ label, usedPercent, resetsAt })),
  ...extra
})
const throttle = (until: number): AccountHeadroom => ({ room: 0.5, throttledUntil: until, ratePerMin: 1, seenAt: NOW })

function snapshot(
  reports: UsageReport[],
  extra: Partial<AccountsSnapshot['providers']['claude']> = {},
  provider: 'claude' | 'codex' | 'cursor' = 'claude'
): AccountsSnapshot {
  const s = emptyAccounts()
  s.providers[provider] = { ...s.providers[provider], profiles: reports.map((r) => profile(r.profileName)), reports, ...extra }
  return s
}

describe('meterFor', () => {
  it('is null for a provider with no accounts', () => {
    expect(meterFor('claude', emptyAccounts(), NOW)).toBeNull()
  })

  it('has no share before any account reported', () => {
    const s = snapshot([])
    s.providers.claude.profiles = [profile('a'), profile('b')]
    expect(meterFor('claude', s, NOW)).toEqual({ share: null, resetsAt: null, limited: null, withRoom: 0, windows: [] })
  })

  it('reads one account’s tighter general window; a per-model cap is a row, not the share', () => {
    const s = snapshot([
      report('a', [
        ['5h', 30, NOW + 2 * HOUR],
        ['Weekly', 60, NOW + 50 * HOUR],
        ['Fable', 95, NOW + 10 * HOUR]
      ])
    ])
    const m = meterFor('claude', s, NOW)!
    expect(m.share).toBeCloseTo(0.4)
    expect(m.resetsAt).toBe(NOW + 50 * HOUR)
    expect(m.withRoom).toBe(1)
    expect(m.windows.map((w) => [w.name, Math.round(w.share * 100), w.resetsAt])).toEqual([
      ['5h', 70, NOW + 2 * HOUR],
      ['Week', 40, NOW + 50 * HOUR],
      ['Fable', 5, NOW + 10 * HOUR]
    ])
  })

  it('leaves the share alone when one of two accounts is throttled', () => {
    const s = snapshot([report('a', [['5h', 50, NOW + HOUR]]), report('b', [['5h', 50, NOW + HOUR]])], {
      headroom: { a: throttle(NOW + 3 * MIN) }
    })
    const m = meterFor('claude', s, NOW)!
    expect(m.share).toBeCloseTo(0.5)
    expect(m.withRoom).toBe(1)
    expect(m.limited).toBeNull()
  })

  it('is limited when every account is throttled, until the soonest lift', () => {
    const s = snapshot([report('a', [['5h', 50]]), report('b', [['5h', 20]])], {
      headroom: { a: throttle(NOW + 5 * MIN), b: throttle(NOW + 3 * MIN) }
    })
    const m = meterFor('claude', s, NOW)!
    expect(m.limited).toEqual({ until: NOW + 3 * MIN })
    expect(m.share).toBeCloseTo(0.65)
    expect(m.withRoom).toBe(0)
  })

  it('is limited with no time when no throttle says when', () => {
    const s = snapshot([report('a', [['5h', 50]], { rateLimit: { provider: 'claude' } })])
    expect(meterFor('claude', s, NOW)!.limited).toEqual({ until: null })
  })

  it('gives a usage-limited account no room and offers its until as a reset', () => {
    const s = snapshot([
      report('a', [['5h', 10, NOW + 4 * HOUR]], { rateLimit: { provider: 'claude', until: NOW + 20 * MIN } }),
      report('b', [['5h', 40, NOW + 2 * HOUR]])
    ])
    const m = meterFor('claude', s, NOW)!
    expect(m.share).toBeCloseTo(0.3)
    expect(m.resetsAt).toBe(NOW + 20 * MIN)
    expect(m.withRoom).toBe(1)
    expect(m.limited).toBeNull()
  })

  it('leaves expired and unreported accounts out of everything', () => {
    const s = snapshot([report('a', [['5h', 20, NOW + HOUR]]), report('c', [['5h', 0]], { expired: true })])
    s.providers.claude.profiles.push(profile('d'))
    const m = meterFor('claude', s, NOW)!
    expect(m.share).toBeCloseTo(0.8)
    expect(m.withRoom).toBe(1)
    expect(m.windows).toHaveLength(1)
  })

  it('takes the soonest binding reset below full; a full account offers none', () => {
    const s = snapshot([
      report('a', [['5h', 0, NOW + HOUR]]),
      report('b', [['5h', 30, NOW + 3 * HOUR]]),
      report('c', [['5h', 60, NOW + 2 * HOUR]])
    ])
    expect(meterFor('claude', s, NOW)!.resetsAt).toBe(NOW + 2 * HOUR)
    const full = snapshot([report('a', [['5h', 0, NOW + HOUR]])])
    expect(meterFor('claude', full, NOW)!.resetsAt).toBeNull()
  })

  it('reads a window whose reset passed as full', () => {
    const s = snapshot([report('a', [['5h', 100, NOW - 1], ['Weekly', 20, NOW + HOUR]])])
    const m = meterFor('claude', s, NOW)!
    expect(m.share).toBeCloseTo(0.8)
    expect(m.windows[0]).toEqual({ label: '5h', name: '5h', share: 1, resetsAt: null })
  })

  it('uses every window when the provider reports none of its general labels', () => {
    const s = snapshot(
      [report('a', [['Cursor models', 40, NOW + HOUR], ['other models', 90, NOW + 2 * HOUR]])],
      {},
      'cursor'
    )
    const m = meterFor('cursor', s, NOW)!
    expect(m.share).toBeCloseTo(0.1)
    expect(m.windows.map((w) => w.name)).toEqual(['Cursor models', 'other models'])
  })

  it('pools the worked example', () => {
    const s = snapshot([
      report('a', [['5h', 30, NOW + 4 * HOUR], ['Weekly', 60, NOW + 40 * HOUR]]),
      report('b', [['5h', 90, NOW + 2 * HOUR], ['Weekly', 20, NOW + 60 * HOUR]]),
      report('c', [['5h', 0], ['Weekly', 0]], { expired: true })
    ])
    const m = meterFor('claude', s, NOW)!
    expect(m.share).toBeCloseTo(0.25)
    expect(m.resetsAt).toBe(NOW + 2 * HOUR)
    expect(m.withRoom).toBe(2)
    expect(m.limited).toBeNull()
    expect(m.windows.map((w) => [w.name, Number(w.share.toFixed(2))])).toEqual([
      ['5h', 0.4],
      ['Week', 0.6]
    ])
  })
})

describe('windowName and isLow', () => {
  it('reads the weekly labels as Week and keeps the rest', () => {
    expect(windowName('Weekly')).toBe('Week')
    expect(windowName('week')).toBe('Week')
    expect(windowName('5h')).toBe('5h')
    expect(windowName('Opus')).toBe('Opus')
  })

  it('is low below a tenth', () => {
    expect(isLow(0.05)).toBe(true)
    expect(isLow(0.1)).toBe(false)
    expect(isLow(null)).toBe(false)
  })
})

describe('untilShort', () => {
  it('keeps the largest whole unit', () => {
    expect(untilShort(NOW + 30_000, NOW)).toBe('under a minute')
    expect(untilShort(NOW + 14 * MIN, NOW)).toBe('14m')
    expect(untilShort(NOW + 2.5 * HOUR, NOW)).toBe('2h')
    expect(untilShort(NOW + 76 * HOUR, NOW)).toBe('3d')
  })
})
