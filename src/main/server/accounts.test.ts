import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure, pinProfile, pinnedProfile, vault, type ServiceView, type UsageReport } from 'aliax-core'
import { AccountsService, RESET_GRACE_MS, type AccountsDeps } from './accounts'

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
  const activate = vi.fn(async () => ({ ok: true as const, notes: ['switched'] }))
  const svc = new AccountsService({
    listServices: listFromVault,
    usage,
    activate,
    owner: () => 'aliax',
    live: async () => null,
    pollMs: 60_000,
    ...over
  })
  return { svc, usage, activate }
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

  it('rejects a switch to the name already pinned', async () => {
    ;({ cleanup } = fixture())
    const { svc, activate } = service()
    const r = await svc.switch('claude', 'a@x.com')
    expect(r).toEqual({ ok: false, error: 'a@x.com is already the pinned account' })
    expect(activate).not.toHaveBeenCalled()
  })

  it('a switch activates in core, then pins, then pushes the new snapshot', async () => {
    const { dir, cleanup: c } = fixture()
    cleanup = c
    const { svc, activate } = service()
    const seen: string[] = []
    svc.onChange((s) => seen.push(String(s.providers.claude.pinned)))
    const r = await svc.switch('claude', 'b@x.com')
    expect(r.ok).toBe(true)
    expect(activate).toHaveBeenCalledWith('claude-code', 'b@x.com')
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(settings.proxyAccounts['claude-code']).toBe('b@x.com')
    expect(seen).toEqual(['b@x.com'])
  })

  it('a failed switch leaves the pin alone', async () => {
    ;({ cleanup } = fixture())
    const { svc } = service({ activate: async () => ({ ok: false, error: 'switch did not land' }) })
    const r = await svc.switch('claude', 'b@x.com')
    expect(r.ok).toBe(false)
    expect(pinnedProfile('claude-code')).toBe('a@x.com')
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
    expect(await svc.pickNext({ ...info, model: 'claude-sonnet-5' })).toBe('b@x.com')
    expect(polled).toEqual(['b@x.com'])
    // A Fable thread: b is out for it.
    expect(await svc.pickNext({ ...info, model: 'claude-fable-5-1' })).toBeNull()
    // The pin (unscoped): the same rule on the weekly clock.
    expect(await svc.pickNext({ ...info, model: 'claude-sonnet-5', thread: undefined })).toBe('b@x.com')
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
    expect(svc.routeFor(meta, null)).toEqual({ route: { account: 'b@x.com', pin: false }, current: 'b@x.com' })
    expect(svc.routeFor({ provider: 'cursor', model: 'x', account: null } as never, null)).toEqual({ route: null, current: null })
  })

  it('failover charges the thread\'s account, picks the next with room for its model, and never touches the pin', async () => {
    ;({ cleanup } = fixture())
    const observed: unknown[] = []
    const { svc, activate } = service({
      usage: async () => [
        { profileName: 'a@x.com', windows: [{ label: '5h', usedPercent: 10 }] },
        { profileName: 'b@x.com', windows: [{ label: '5h', usedPercent: 30 }] }
      ],
      usageOf: async () => null,
      observeLimit: (id, name, limit) => observed.push([id, name, limit])
    })
    expect(await svc.failover('T', { provider: 'claude', model: 'claude-sonnet-5', window: '5h', account: 'a@x.com' })).toEqual({ from: 'a@x.com', to: 'b@x.com' })
    expect(observed).toEqual([['claude-code', 'a@x.com', { window: '5h' }]])
    expect(pinnedProfile('claude-code')).toBe('a@x.com')
    expect(activate).not.toHaveBeenCalled()
    // A thread on b (say, pinned) that hits its limit moves to a; the pin still stands.
    expect(await svc.failover('U', { provider: 'claude', model: 'claude-sonnet-5', window: '5h', account: 'b@x.com' })).toEqual({ from: 'b@x.com', to: 'a@x.com' })
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
    const info = { provider: 'claude' as const, model: 'claude-sonnet-5', window: '5h' as const, account: 'a@x.com' }
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
})
