import { describe, expect, it } from 'vitest'
import { emptyAccounts, type AccountsSnapshot } from './accounts'
import { AccountsSnapshotSchema, RemotePushSchema, RerouteAnswerSchema } from './wireSchemas'

const hour = 3_600_000
const now = 1_700_000_000_000

/** Two Claude accounts as the desktop's snapshot carries them, extras and all. */
const snapshot = (): AccountsSnapshot => ({
  ...emptyAccounts(),
  updatedAt: now,
  providers: {
    ...emptyAccounts().providers,
    claude: {
      pinned: null,
      owner: 'temp-code',
      profiles: [
        { name: 'work@example.com', email: 'work@example.com', nickname: 'work', color: '#5b8def', createdAt: now - 30 * 24 * hour, active: true, syncedAt: now },
        { name: 'spare@example.com', email: 'spare@example.com', color: '#d97757', createdAt: now - 10 * 24 * hour, active: false, static: true }
      ],
      reports: [
        {
          profileName: 'work@example.com',
          windows: [
            { label: '5h', usedPercent: 12, resetsAt: now + 3 * hour, periodMs: 5 * hour },
            { label: 'Weekly', usedPercent: 40, resetsAt: now + 3 * 24 * hour, periodMs: 7 * 24 * hour }
          ],
          plan: { name: 'Max 20x', monthlyUsd: 200 }
        },
        { profileName: 'spare@example.com', windows: [{ label: '5h', usedPercent: 91 }], rateLimit: { provider: 'anthropic', until: now + 40 * 60_000 }, expired: false }
      ],
      headroom: {
        'work@example.com': { room: 0.8, ratePerMin: 3, seenAt: now },
        'spare@example.com': { room: 0.1, ratePerMin: 12, resetsAt: now + 40 * 60_000, throttledUntil: now + 40 * 60_000, tier: 'allowed_warning', seenAt: now }
      }
    }
  },
  homes: { claude: 'env_mac' },
  peers: { env_mac: { name: 'Mac', connected: true, lastSyncAt: now, error: null } }
})

describe('AccountsSnapshotSchema', () => {
  it('parses the empty snapshot', () => {
    expect(AccountsSnapshotSchema.parse(emptyAccounts())).toEqual({
      updatedAt: 0,
      providers: {
        claude: { pinned: null, profiles: [], reports: [] },
        codex: { pinned: null, profiles: [], reports: [] },
        cursor: { pinned: null, profiles: [], reports: [] }
      }
    })
  })

  it('keeps every field the phone reads and strips the rest', () => {
    const parsed = AccountsSnapshotSchema.parse(snapshot())
    const claude = parsed.providers.claude
    expect(claude.profiles).toEqual([
      { name: 'work@example.com', email: 'work@example.com', nickname: 'work', color: '#5b8def', active: true },
      { name: 'spare@example.com', email: 'spare@example.com', color: '#d97757', active: false, static: true }
    ])
    expect(claude.reports[0]).toEqual({
      profileName: 'work@example.com',
      windows: [
        { label: '5h', usedPercent: 12, resetsAt: now + 3 * hour, periodMs: 5 * hour },
        { label: 'Weekly', usedPercent: 40, resetsAt: now + 3 * 24 * hour, periodMs: 7 * 24 * hour }
      ]
    })
    expect(claude.reports[1]).toEqual({
      profileName: 'spare@example.com',
      windows: [{ label: '5h', usedPercent: 91 }],
      rateLimit: { provider: 'anthropic', until: now + 40 * 60_000 },
      expired: false
    })
    expect(claude.headroom).toEqual(snapshot().providers.claude.headroom)
    expect(claude).not.toHaveProperty('owner')
    expect(parsed).not.toHaveProperty('homes')
    expect(parsed).not.toHaveProperty('peers')
    expect(parsed.updatedAt).toBe(now)
  })

  it('refuses a snapshot missing a provider', () => {
    const broken = snapshot() as unknown as { providers: Record<string, unknown> }
    delete broken.providers.cursor
    expect(AccountsSnapshotSchema.safeParse(broken).success).toBe(false)
  })
})

describe('the accounts push', () => {
  it('lands on the accounts branch of RemotePushSchema', () => {
    const parsed = RemotePushSchema.parse({ push: 'accounts', snapshot: snapshot() })
    expect(parsed.push).toBe('accounts')
    if (parsed.push !== 'accounts') throw new Error('wrong branch')
    expect(parsed.snapshot.providers.claude.profiles.map((p) => p.name)).toEqual(['work@example.com', 'spare@example.com'])
  })
})

describe('RerouteAnswerSchema', () => {
  it('reads the registry answer, account or null', () => {
    expect(RerouteAnswerSchema.parse({ account: 'work@example.com', moved: true })).toEqual({ account: 'work@example.com', moved: true })
    expect(RerouteAnswerSchema.parse({ account: null, moved: false })).toEqual({ account: null, moved: false })
    expect(RerouteAnswerSchema.safeParse({ moved: false }).success).toBe(false)
  })
})
