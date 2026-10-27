import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure, pinProfile, pinnedProfile, vault, type ServiceView, type UsageReport } from 'aliax-core'
import { HeadroomStore } from './headroom'
import { AccountsService, accountsPusher, ACCOUNTS_PUSH_MS, OUT_RETRY_MS, RESET_GRACE_MS, type AccountsDeps } from './accounts'
import type { AccountHeadroom, AccountsSnapshot } from '@shared/accounts'

/**
 * A throwaway Aliax data dir with two Claude accounts and one Codex account,
 * sealed by a fixed key so nothing touches the real Keychain or HOME.
 */
function fixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'temp-code-accounts-'))
  configure({
    dataDir: dir,
    fetch: async (url) => {
      throw new Error(`unexpected fetch ${url}`)
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-test'
  })
  vault.useFixedChromiumKey('Test Safe Storage', vault.randomChromiumKey())
  vault.upsertProfile('claude-code', { name: 'a@x.com', accountId: '1', email: 'a@x.com', createdAt: 1 })
  vault.upsertProfile('claude-code', { name: 'b@x.com', accountId: '2', email: 'b@x.com', nickname: 'B', createdAt: 2 })
  vault.upsertProfile('codex', { name: 'c@x.com', accountId: '3', email: 'c@x.com', createdAt: 3 })
  for (const [id, name] of [['claude-code', 'a@x.com'], ['claude-code', 'b@x.com'], ['codex', 'c@x.com']] as const) {
    vault.saveSecret(id, name, '{}')
  }
  pinProfile('claude-code', 'a@x.com')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** What core's listServices would say for the fixture vault, minus live detection. */
const listFromVault = async (): Promise<ServiceView[]> =>
  (['claude-code', 'codex', 'cursor'] as const).map((id) => ({
    id,
    name: id,
    installed: true,
    canAddAccount: true,
    canSaveCurrent: false,
    switchTargets: [],
    profiles: vault.profiles(id).map((p) => ({
      name: p.name,
      email: p.email,
      nickname: p.nickname,
      color: p.color,
      createdAt: p.createdAt,
      active: pinnedProfile(id) === p.name
    }))
  }))

const reportsFor = (id: string): UsageReport[] =>
  vault.profiles(id as 'codex').map((p) => ({
    profileName: p.name,
    windows: [{ label: '5h', usedPercent: 40 }]
  }))

function service(over: Partial<AccountsDeps> = {}) {
  const usage = vi.fn<AccountsDeps["usage"]>(async (id) => reportsFor(id))
  const svc = new AccountsService({
    listServices: listFromVault,
    usage,
    owner: () => 'aliax',
    live: async () => null,
    pollMs: 60_000,
    ...over
  })
  return { svc, usage }
}

let cleanup = (): void => {}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AccountsService', () => {
  it('builds one snapshot per harness id from the vault, mapping claude to claude-code', async () => {
    ;({ cleanup } = fixture())
    const { svc } = service()
    const snap = await svc.list()
    expect(Object.keys(snap.providers).sort()).toEqual(['claude', 'codex', 'cursor'])
    const claude = snap.providers.claude
    expect(claude.pinned).toBe('a@x.com')
    expect(claude.profiles.map((p) => p.name)).toEqual(['a@x.com', 'b@x.com'])
    expect(claude.reports.map((r) => r.profileName)).toEqual(['a@x.com', 'b@x.com'])
    expect(claude.owner).toBe('aliax')
    expect(snap.providers.codex.profiles.map((p) => p.name)).toEqual(['c@x.com'])
    expect(snap.providers.cursor).toMatchObject({ pinned: null, profiles: [], reports: [] })
    expect(snap.updatedAt).toBeGreaterThan(0)
  })

  it('refresh forces only the asked provider, which core forwards when standby', async () => {
    ;({ cleanup } = fixture())
    const { svc, usage } = service({ owner: () => 'aliax' })
    await svc.list()
    usage.mockClear()
    await svc.refresh('codex')
    const forced = usage.mock.calls.filter((c) => c[1] === true).map((c) => c[0])
    expect(forced).toEqual(['codex'])
  })

  it('follows a settings.json rewrite by another process', async () => {
    const { dir, cleanup: c } = fixture()
    cleanup = c
    const { svc } = service({ pollMs: 3_600_000 })
    const pins: (string | null)[] = []
    svc.onChange((s) => pins.push(s.providers.claude.pinned))
    svc.start()
    await vi.waitFor(() => expect(pins.length).toBe(1))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ proxyAccounts: { 'claude-code': 'b@x.com' } }))
    await vi.waitFor(() => expect(pins.at(-1)).toBe('b@x.com'), { timeout: 3_000 })
    svc.stop()
  })

  it('shows the live sign-in as one unnamed profile when there is no vault', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'temp-code-novault-'))
    cleanup = () => rmSync(dir, { recursive: true, force: true })
    const { svc } = service({
      vaultPresent: () => false,
      dataDir: () => dir,
      live: async (id) =>
        id === 'claude-code'
          ? {
              profile: { name: 'me@x.com', email: 'me@x.com', createdAt: 0, active: true, activeOn: ['Active'] },
              report: { profileName: 'me@x.com', windows: [{ label: '5h', usedPercent: 10 }] }
            }
          : null
    })
    const snap = await svc.list()
    expect(snap.providers.claude.pinned).toBe('me@x.com')
    expect(snap.providers.claude.profiles).toHaveLength(1)
    expect(snap.providers.codex.profiles).toHaveLength(0)
    expect(snap.providers.claude.note).toBeUndefined()
  })

  it('pickNext for a thread ignores other models and reads the model\'s own window, confirmed by a forced poll', async () => {
    ;({ cleanup } = fixture())
    const polled: string[] = []
    const { svc } = service({
      usage: async () => [
        { profileName: 'a@x.com', windows: [{ label: '5h', usedPercent: 100, resetsAt: Date.now() + 60_000 }] },
        { profileName: 'b@x.com', windows: [{ label: '5h', usedPercent: 30 }, { label: 'Fable', usedPercent: 100, resetsAt: Date.now() + 9e6 }] }
      ],
      usageOf: async (_id, name) => {
        polled.push(name)
        return null
      }
    })
    const info = { service: 'claude', serviceId: 'claude-code' as const, limit: { window: '5h' as const }, tried: ['a@x.com'], account: 'a@x.com', thread: 'T' }
    // A Sonnet thread: b's closed Fable cap is not its business.
    expect(await svc.pickNext({ ...info, model: 'claude-sonnet-5-5' })).toBe('b@x.com')
    expect(polled).toEqual(['b@x.com'])
    // A Fable thread: b is out for it.
    expect(await svc.pickNext({ ...info, model: 'claude-fable-5-1' })).toBeNull()
    // The pin (unscoped): the same rule on the weekly clock.
    expect(await svc.pickNext({ ...info, model: 'claude-sonnet-5-5', thread: undefined })).toBe('b@x.com')
  })

  it('a 429 failover never lands on an out account or one inside its cooldown', async () => {
    ;({ cleanup } = fixture())
    vault.upsertProfile('claude-code', { name: 'c@x.com', accountId: '4', email: 'c@x.com', createdAt: 4 })
    vault.saveSecret('claude-code', 'c@x.com', '{}')
    let now = 1_800_000_000_000
    const headroom = new HeadroomStore({ environmentId: 'test', now: () => now })
    const usageOf = vi.fn(async () => null)
    const { svc } = service({ headroom: () => headroom, now: () => now, usageOf })
    await svc.list()
    svc.markOut('claude-code', 'b@x.com')
    headroom.observe({ service: 'claude-code', account: 'c@x.com', model: 'claude-fable-5-1', status: 429, headers: new Headers({ 'retry-after': '45' }) })
    const info = { service: 'claude', serviceId: 'claude-code' as const, model: 'claude-fable-5-1', limit: { window: '5h' as const }, tried: ['a@x.com'], account: 'a@x.com', thread: 'T' }
    expect(await svc.pickNext(info)).toBeNull()
    expect(usageOf).not.toHaveBeenCalled()
    expect(info.tried).toEqual(['a@x.com'])
    // Opus can use the same account, from both the spawn and failover paths.
    expect(await svc.pickNext({ ...info, model: 'claude-opus-5-5' })).toBe('c@x.com')
    expect(svc.routeFor({ provider: 'claude', model: 'claude-opus-5-5', account: 'c@x.com', updatedAt: now } as never, null).current).toBe('c@x.com')
    expect(usageOf).toHaveBeenCalledTimes(1)
    expect(usageOf).toHaveBeenCalledWith('claude-code', 'c@x.com')
    now += 45_000
    expect(await svc.pickNext(info)).toBe('c@x.com')
    svc.markAnswered('claude-code', 'b@x.com')
    headroom.observe({ service: 'claude-code', account: 'c@x.com', model: 'claude-fable-5-1', status: 429, headers: new Headers({ 'retry-after': '45' }) })
    expect(await svc.pickNext(info)).toBe('b@x.com')
  })

  it('routeFor names the pin, else the sticky account, else the best pick for the model, from the cached snapshot', async () => {
    ;({ cleanup } = fixture())
    const { svc } = service({
      usage: async (id) =>
        id !== 'claude-code'
          ? []
          : [
              { profileName: 'a@x.com', windows: [{ label: 'Weekly', usedPercent: 10, resetsAt: Date.now() + 9e6 }] },
              { profileName: 'b@x.com', windows: [{ label: 'Weekly', usedPercent: 60, resetsAt: Date.now() + 1e6 }] }
            ]
    })
    await svc.list()
    const meta = { provider: 'claude', model: 'claude-opus-5-5', account: null } as never
    expect(svc.routeFor(meta, { name: 'a@x.com', level: 'project' })).toEqual({ route: { account: 'a@x.com', pin: true }, current: 'a@x.com' })
    expect(svc.routeFor({ ...(meta as object), account: 'a@x.com' } as never, null)).toEqual({ route: { account: 'a@x.com', pin: false }, current: 'a@x.com' })
    // fresh: the sticky account is ignored and the best pick for the model wins (soonest reset).
    expect(svc.routeFor({ ...(meta as object), account: 'a@x.com' } as never, null, { fresh: true })).toEqual({ route: { account: 'b@x.com', pin: false }, current: 'b@x.com' })
    expect(svc.routeFor(meta, null)).toEqual({ route: { account: 'b@x.com', pin: false }, current: 'b@x.com' })
    expect(svc.routeFor({ provider: 'cursor', model: 'x', account: null } as never, null)).toEqual({ route: null, current: null })
  })

  it('routeFor and pickNext read the live load: the emptiest account with room wins', async () => {
    ;({ cleanup } = fixture())
    const asked: string[] = []
    let load: Record<string, number> = { 'a@x.com': 2 }
    const { svc } = service({
      usage: async (id) =>
        id !== 'claude-code'
          ? []
          : [
              { profileName: 'a@x.com', windows: [{ label: '5h', usedPercent: 10 }] },
              { profileName: 'b@x.com', windows: [{ label: '5h', usedPercent: 12 }] }
            ],
      usageOf: async () => null,
      load: (provider) => {
        asked.push(provider)
        return load
      }
    })
    await svc.list()
    const meta = { provider: 'claude', model: 'claude-fable-5-1', account: null } as never
    // Same 5h bucket: a carries two threads plus the pin (a is pinned in the fixture), b none.
    expect(svc.routeFor(meta, null).current).toBe('b@x.com')
    load = { 'b@x.com': 2 }
    expect(svc.routeFor(meta, null).current).toBe('a@x.com')
    load = { 'a@x.com': 3 }
    const info = { service: 'claude', serviceId: 'claude-code' as const, model: 'claude-fable-5-1', limit: { window: '5h' as const }, tried: [], account: 'a@x.com', thread: 'T' }
    expect(await svc.pickNext(info)).toBe('b@x.com')
    expect(asked).toEqual(['claude', 'claude', 'claude'])
  })

  it('failover charges the thread\'s account, picks the next with room for its model, and never touches the pin', async () => {
    ;({ cleanup } = fixture())
    const observed: unknown[] = []
    const { svc } = service({
      usage: async () => [
        { profileName: 'a@x.com', windows: [{ label: '5h', usedPercent: 10 }] },
        { profileName: 'b@x.com', windows: [{ label: '5h', usedPercent: 30 }] }
      ],
      usageOf: async () => null,
      observeLimit: (id, name, limit) => observed.push([id, name, limit])
    })
    expect(await svc.failover('T', { provider: 'claude', model: 'claude-sonnet-5-5', window: '5h', account: 'a@x.com' })).toEqual({ from: 'a@x.com', to: 'b@x.com' })
    expect(observed).toEqual([['claude-code', 'a@x.com', { window: '5h' }]])
    expect(pinnedProfile('claude-code')).toBe('a@x.com')
    // A thread on b (say, pinned) that hits its limit moves to a; the pin still stands.
    expect(await svc.failover('U', { provider: 'claude', model: 'claude-sonnet-5-5', window: '5h', account: 'b@x.com' })).toEqual({ from: 'b@x.com', to: 'a@x.com' })
    // An unscoped thread (older owner) spent from the pin.
    expect(await svc.failover('V', { provider: 'claude', model: null, window: '5h', account: null })).toEqual({ from: 'a@x.com', to: 'b@x.com' })
  })

  it('failover returns null when no account has room, and ignores transient limits', async () => {
    ;({ cleanup } = fixture())
    const observed: string[] = []
    const { svc } = service({
      usage: async () => [
        { profileName: 'a@x.com', windows: [{ label: '5h', usedPercent: 100, resetsAt: Date.now() + 60_000 }] },
        { profileName: 'b@x.com', windows: [{ label: '5h', usedPercent: 100, resetsAt: Date.now() + 60_000 }] }
      ],
      usageOf: async () => null,
      observeLimit: (_id, name) => observed.push(name)
    })
    expect(await svc.failover('T', { provider: 'claude', model: null, window: '5h', account: 'a@x.com' })).toBeNull()
    expect(observed).toEqual(['a@x.com'])
    expect(await svc.failover('T', { provider: 'claude', model: null, window: 'transient', account: 'a@x.com' })).toBeNull()
    expect(observed).toEqual(['a@x.com'])
  })

  it('failover dedupes per thread, not per provider', async () => {
    ;({ cleanup } = fixture())
    const polled: string[] = []
    const { svc } = service({
      usage: async () => [
        { profileName: 'a@x.com', windows: [{ label: '5h', usedPercent: 10 }] },
        { profileName: 'b@x.com', windows: [{ label: '5h', usedPercent: 30 }] }
      ],
      usageOf: async (_id, name) => {
        polled.push(name)
        return null
      }
    })
    const info = { provider: 'claude' as const, model: 'claude-sonnet-5-5', window: '5h' as const, account: 'a@x.com' }
    const [first, again, other] = await Promise.all([svc.failover('T', info), svc.failover('T', info), svc.failover('U', info)])
    expect(first).toEqual({ from: 'a@x.com', to: 'b@x.com' })
    expect(again).toBe(first)
    expect(other).toEqual({ from: 'a@x.com', to: 'b@x.com' })
    expect(other).not.toBe(first)
    expect(polled).toEqual(['b@x.com', 'b@x.com'])
  })

  it('re-arms one reset timer per build and polls the reset accounts, only while Aliax is not the owner', async () => {
    ;({ cleanup } = fixture())
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const stale: string[] = []
    let owner: 'aliax' | 'temp-code' = 'temp-code'
    let reset = Date.now() + 60_000
    const usage = vi.fn<AccountsDeps['usage']>(async (id) =>
      id !== 'claude-code'
        ? []
        : [
            { profileName: 'a@x.com', windows: [{ label: '5h', usedPercent: 100, resetsAt: reset }] },
            { profileName: 'b@x.com', windows: [{ label: '5h', usedPercent: 100, resetsAt: reset + 5_000 }] }
          ]
    )
    const { svc } = service({
      usage,
      now: Date.now,
      owner: () => owner,
      markStale: (_id, name) => {
        stale.push(name)
        // The poll after a reset learns the next one.
        reset = Date.now() + 600_000
      },
      // No watcher: macOS can replay the fixture's own writes into it.
      dataDir: () => join(tmpdir(), 'temp-code-accounts-none'),
      pollMs: 3_600_000
    })
    svc.start()
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(2))
    expect(svc.nextReset()).toEqual({ at: reset + RESET_GRACE_MS, stale: [{ id: 'claude-code', name: 'a@x.com' }, { id: 'claude-code', name: 'b@x.com' }] })
    // The timer fires once, after the grace, and the rebuild it starts re-arms for the next reset.
    await vi.advanceTimersByTimeAsync(60_000 + RESET_GRACE_MS)
    expect(stale).toEqual(['a@x.com', 'b@x.com'])
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(4))
    expect(svc.nextReset()?.at).toBe(reset + RESET_GRACE_MS)
    // Aliax took the gateway: its poll feeds the cache we watch, so ours stays quiet.
    owner = 'aliax'
    await vi.advanceTimersByTimeAsync(600_000 + RESET_GRACE_MS)
    expect(stale).toHaveLength(2)
    expect(usage).toHaveBeenCalledTimes(4)
    svc.stop()
    vi.useRealTimers()
  })

  it('a 401 marks an account out until it answers again or the retry window passes', async () => {
    ;({ cleanup } = fixture())
    let now = 1_800_000_000_000
    const markStale = vi.fn()
    const { svc } = service({ now: () => now, markStale, load: () => ({}) })
    await svc.list()
    expect(svc.outFor('claude')).toEqual([])
    expect(svc.substitute('claude-code', 'a@x.com', 'claude-fable-5-1')).toBeNull()
    // Newly out: logged once, polled fresh next, and never a pick.
    expect(svc.markOut('claude-code', 'a@x.com')).toBe(true)
    expect(svc.markOut('claude-code', 'a@x.com')).toBe(false)
    expect(markStale).toHaveBeenCalledTimes(1)
    expect(svc.outFor('claude')).toEqual(['a@x.com'])
    expect(svc.substitute('claude-code', 'a@x.com', 'claude-fable-5-1')).toBe('b@x.com')
    expect(svc.substitute('claude-code', 'b@x.com', 'claude-fable-5-1')).toBeNull()
    const meta = { id: 's', provider: 'claude', model: 'claude-fable-5-1', account: 'a@x.com' } as never
    expect(svc.routeFor(meta, null)).toEqual({ route: { account: 'b@x.com', pin: false }, current: 'b@x.com' })
    // The only other account out too: nothing to substitute, the 401 surfaces.
    svc.markOut('claude-code', 'b@x.com')
    expect(svc.substitute('claude-code', 'a@x.com', 'claude-fable-5-1')).toBeNull()
    // It answered: back in at once.
    svc.markAnswered('claude-code', 'b@x.com')
    expect(svc.outFor('claude')).toEqual(['a@x.com'])
    // The window passed: one request may try it again.
    now += OUT_RETRY_MS
    expect(svc.outFor('claude')).toEqual([])
    expect(svc.markOut('claude-code', 'a@x.com')).toBe(true)
  })

  it('a report the snapshot flags expired is out without a mark', async () => {
    ;({ cleanup } = fixture())
    const { svc } = service({
      usage: async (id) => reportsFor(id).map((r) => (r.profileName === 'a@x.com' ? { ...r, expired: true } : r))
    })
    await svc.list()
    expect(svc.outFor('claude')).toEqual(['a@x.com'])
    expect(svc.substitute('claude-code', 'a@x.com', null)).toBe('b@x.com')
  })

  it('a rebuild that reads the same picture tells nobody; usage and headroom numbers move the rows, never the threads', async () => {
    ;({ cleanup } = fixture())
    let used = 40
    let room = 0.9
    let throttledUntil: number | undefined
    const now = 1_800_000_000_000
    const usage = vi.fn<AccountsDeps['usage']>(async (id) =>
      id !== 'claude-code' ? [] : vault.profiles('claude-code').map((p) => ({ profileName: p.name, windows: [{ label: '5h', usedPercent: p.name === 'a@x.com' ? used : 10 }] }))
    )
    const summary = (_id: string, names: string[]): Record<string, AccountHeadroom> =>
      Object.fromEntries(names.map((n) => [n, { room, ratePerMin: 3, ...(n === 'b@x.com' && throttledUntil ? { throttledUntil } : {}) } as AccountHeadroom]))
    const { svc } = service({ usage, now: () => now, headroom: () => ({ summary }) as never })
    const changes: AccountsSnapshot[] = []
    const picks: AccountsSnapshot[] = []
    svc.onChange((s) => changes.push(s))
    svc.onPickable((s) => picks.push(s))
    await svc.rebuildNow()
    expect([changes.length, picks.length]).toEqual([1, 1])
    // The same picture twice: nothing fires.
    await svc.rebuildNow()
    await svc.rebuildNow()
    expect([changes.length, picks.length]).toEqual([1, 1])
    // A usage window and the headroom numbers move: the rows hear it, the threads do not re-pick.
    used = 60
    room = 0.4
    await svc.rebuildNow()
    expect([changes.length, picks.length]).toEqual([2, 1])
    // The window fills: what a pick can choose changed.
    used = 100
    await svc.rebuildNow()
    expect([changes.length, picks.length]).toEqual([3, 2])
    // A 429 cooldown and a 401 mark take an account out of the picks.
    throttledUntil = now + 60_000
    await svc.rebuildNow()
    expect(picks.length).toBe(3)
    svc.markOut('codex', 'c@x.com')
    await svc.rebuildNow()
    expect(picks.length).toBe(4)
    expect(usage).toHaveBeenCalled()
  })
})

describe('accountsPusher', () => {
  const snap = (n: number): AccountsSnapshot => ({ updatedAt: n }) as AccountsSnapshot

  it('one socket hears the newest snapshot at most every 5 s, never one it already has', async () => {
    vi.useFakeTimers()
    try {
      const sent: number[] = []
      const push = accountsPusher((s) => sent.push(s.updatedAt), ACCOUNTS_PUSH_MS, () => Date.now())
      const first = snap(1)
      push.offer(first)
      expect(sent).toEqual([1])
      push.offer(first)
      // A burst inside the window: only its newest goes out, at the window's end.
      for (let i = 2; i <= 50; i++) push.offer(snap(i))
      expect(sent).toEqual([1])
      await vi.advanceTimersByTimeAsync(ACCOUNTS_PUSH_MS - 1)
      expect(sent).toEqual([1])
      await vi.advanceTimersByTimeAsync(1)
      expect(sent).toEqual([1, 50])
      // Quiet past the window: the next one goes out at once.
      await vi.advanceTimersByTimeAsync(ACCOUNTS_PUSH_MS)
      push.offer(snap(51))
      expect(sent).toEqual([1, 50, 51])
      // A closed socket hears nothing more.
      push.offer(snap(52))
      push.dispose()
      await vi.advanceTimersByTimeAsync(ACCOUNTS_PUSH_MS * 2)
      expect(sent).toEqual([1, 50, 51])
    } finally {
      vi.useRealTimers()
    }
  })
})
