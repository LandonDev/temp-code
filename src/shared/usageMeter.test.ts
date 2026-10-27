import { describe, expect, it } from 'vitest'
import type { ProfileView, UsageReport } from 'aliax-core/shared/types'
import { emptyAccounts, type AccountsSnapshot } from './accounts'
import { meterFor, untilShort } from './usageMeter'

const NOW = 1_000_000_000
const HOUR = 3_600_000

const profile = (name: string): ProfileView => ({ name, email: name, createdAt: 1, active: false })
const report = (name: string, windows: [number, number?][], extra: Partial<UsageReport> = {}): UsageReport => ({
  profileName: name,
  windows: windows.map(([usedPercent, resetsAt], i) => ({ label: `w${i}`, usedPercent, resetsAt })),
  ...extra
})

function snapshot(reports: UsageReport[], extra: Partial<AccountsSnapshot['providers']['claude']> = {}): AccountsSnapshot {
  const s = emptyAccounts()
  s.providers.claude = { ...s.providers.claude, profiles: reports.map((r) => profile(r.profileName)), reports, ...extra }
  return s
}

describe('meterFor', () => {
  it('is null for a provider with no accounts', () => {
    expect(meterFor('claude', emptyAccounts(), NOW)).toBeNull()
  })

  it('reads the least room among one account’s windows and when it resets', () => {
    const s = snapshot([report('a', [[30, NOW + 5 * HOUR], [60, NOW + 2 * HOUR]])])
    expect(meterFor('claude', s, NOW)).toEqual({ room: 0.4, resetsAt: NOW + 2 * HOUR })
  })

  it('treats a window whose reset has passed as refilled', () => {
    const s = snapshot([report('a', [[100, NOW - 1], [20]])])
    expect(meterFor('claude', s, NOW)).toEqual({ room: 0.8, resetsAt: null })
  })

  it('takes the best account and gives a throttled one no room', () => {
    const s = snapshot([report('a', [[10, NOW + HOUR]]), report('b', [[50, NOW + 3 * HOUR]])], {
      headroom: { a: { room: 0.9, throttledUntil: NOW + 60_000, ratePerMin: 4, seenAt: NOW } }
    })
    expect(meterFor('claude', s, NOW)).toEqual({ room: 0.5, resetsAt: NOW + 3 * HOUR })
  })

  it('says when the first account frees when every account is out', () => {
    const s = snapshot([
      report('a', [[10]], { rateLimit: { provider: 'claude', until: NOW + 10 * 60_000 } }),
      report('b', [[0]], { expired: true })
    ])
    expect(meterFor('claude', s, NOW)).toEqual({ room: 0, resetsAt: NOW + 10 * 60_000 })
  })

  it('has no room figure before any account reported', () => {
    const s = snapshot([])
    s.providers.claude.profiles = [profile('a')]
    expect(meterFor('claude', s, NOW)).toEqual({ room: null, resetsAt: null })
  })
})

describe('untilShort', () => {
  it('keeps the largest whole unit', () => {
    expect(untilShort(NOW + 30_000, NOW)).toBe('under a minute')
    expect(untilShort(NOW + 14 * 60_000, NOW)).toBe('14m')
    expect(untilShort(NOW + 2.5 * HOUR, NOW)).toBe('2h')
    expect(untilShort(NOW + 76 * HOUR, NOW)).toBe('3d')
  })
})
