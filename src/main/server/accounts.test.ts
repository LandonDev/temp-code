import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure, pinProfile, pinnedProfile, vault, type ServiceView, type UsageReport } from 'aliax-core'
import { AccountsService, type AccountsDeps } from './accounts'

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
})
