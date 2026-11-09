import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accounts as coreAccounts, configure, pinnedProfile, vault } from 'aliax-core'
import { accessExpiry, exportAccount, hasRefresh, refreshFingerprint, type ApplyOutcome, type Transfer } from 'aliax-core/sync'
import type { AccountRemoval, ListedAccount } from '@shared/accounts'
import { AccountSync } from './accountSync'

vi.mock('aliax-core/keychain', () => ({
  readPassword: async () => {
    throw new Error('no keychain in tests')
  },
  writePassword: async () => {}
}))

const HOUR = 3_600_000

/** A grant blob of the schema's shape (src/shared/addonGrant.ts). */
const grant = (addonId: string, oauth: Record<string, unknown> | null = {}, fields: Record<string, string> = {}): string =>
  JSON.stringify({
    v: 1,
    mintedBy: 'app',
    addonId,
    fields,
    ...(oauth
      ? {
          oauth: {
            clientId: 'cl_1',
            redirectPort: 51234,
            authorizationUrl: 'https://auth.example.com/as/authorize',
            tokenUrl: 'https://auth.example.com/as/token',
            accessToken: 'AT',
            refreshToken: 'RT',
            expiresAt: Date.now() + HOUR,
            ...oauth
          }
        }
      : {})
  })
const oauthOf = (blob: string | null): Record<string, unknown> => JSON.parse(blob!).oauth

function fakeLink(id: string, name = id) {
  return {
    id,
    env: { id, name },
    connected: true,
    lastSyncAt: null as number | null,
    lastError: null as string | null,
    request: vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({ transfers: [] }))
  }
}
type FakeLink = ReturnType<typeof fakeLink>

function memoryStore() {
  const rows = new Map<string, string>()
  return {
    getSetting: (key: string) => rows.get(key) ?? null,
    setSetting: (key: string, value: string | null) => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
    }
  }
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** One host with its own vault: the core is configured for it, so its vault is the one the calls below read and write. */
function host(environmentId: string, links: FakeLink[], extra: Partial<ConstructorParameters<typeof AccountSync>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tc-account-sync-addon-'))
  dirs.push(dataDir)
  const onRemoved = vi.fn()
  const activate = vi.fn(async () => {})
  const sync = new AccountSync({
    environmentId,
    store: memoryStore(),
    peers: { get: (id) => links.find((l) => l.id === id) as never, all: () => links as never },
    nudge: vi.fn(),
    log: () => {},
    liveAccountId: async () => null,
    activate,
    onRemoved,
    ...extra
  })
  configure({
    dataDir,
    fetch: async (url) => {
      throw new Error(`unexpected fetch ${url}`)
    },
    secrets: { mode: 'fileKey', path: join(dataDir, 'vault.key') },
    environmentId,
    hooks: { askOwner: sync.askOwner }
  })
  return { sync, onRemoved, activate }
}

const landedOk = (t: Transfer, owner: string | null): ApplyOutcome => ({
  ok: true,
  name: t.profile.name,
  saved: true,
  owner,
  expiresAt: t.expiresAt,
  refreshFingerprint: refreshFingerprint(t.service, t.blob)
})

/** The box answers the way AccountSync on a host answers: the handoff's fingerprint echoed, the release ok. */
function boxAnswering(box: FakeLink, pulled: Transfer[] = []) {
  box.request.mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'accounts.pull') return { transfers: pulled, listed: [], tombstones: [] }
    if (method === 'accounts.push') {
      const t = (params as { transfer: Transfer }).transfer
      return landedOk(t, t.mode === 'handoff' ? 'env_mac' : t.profile.owner)
    }
    if (method === 'accounts.released') return { ok: true }
    throw new Error(`unexpected ${method}`)
  })
}
const pushesOf = (link: FakeLink): Transfer[] =>
  link.request.mock.calls.filter((c) => c[0] === 'accounts.push').map((c) => (c[1] as { transfer: Transfer }).transfer)

describe('add-on grants across hosts', () => {
  it("a Mac-owned OAuth grant goes to its home as a handoff: the box holds it provisionally, the Mac strips on the echoed fingerprint, the release makes the box its owner", async () => {
    const box = fakeLink('env_box', 'box')
    boxAnswering(box)
    const mac = host('env_mac', [box], { addonHome: (id) => (id === 'ad_a' ? 'env_box' : null), addonKnown: () => true })
    coreAccounts.saveAddonGrant({ addonId: 'ad_a', nickname: 'Mobbin', blob: grant('ad_a', {}, { X: 'v' }), signedIn: true })
    await mac.sync.syncWith('env_box')
    const [sent] = pushesOf(box)
    expect(sent).toMatchObject({ service: 'addon', mode: 'handoff', profile: { name: 'ad_a', accountId: 'ad_a', owner: 'env_box', static: false } })
    expect(hasRefresh('addon', sent.blob)).toBe(true)
    expect(box.request.mock.calls.filter((c) => c[0] === 'accounts.released').map((c) => c[1])).toEqual([{ from: 'env_mac', service: 'addon', accountId: 'ad_a' }])
    // The Mac keeps an access copy that names the box, with its client and port for a sign-in again.
    const left = vault.readSecret('addon', 'ad_a')!
    expect(hasRefresh('addon', left)).toBe(false)
    expect(oauthOf(left)).toMatchObject({ clientId: 'cl_1', redirectPort: 51234, accessToken: 'AT' })
    expect(JSON.parse(left).fields).toEqual({ X: 'v' })
    expect(vault.profiles('addon')[0]).toMatchObject({ owner: 'env_box', static: false })

    // The box's side of the same exchange, in its own vault.
    const boxHost = host('env_box', [])
    expect(await boxHost.sync.handlePush('env_mac', sent)).toMatchObject({ ok: true, saved: true, owner: 'env_mac', refreshFingerprint: refreshFingerprint('addon', sent.blob) })
    expect(vault.profiles('addon')[0]).toMatchObject({ owner: 'env_mac', static: false })
    expect(boxHost.sync.handleReleased('env_mac', { service: 'addon', accountId: 'ad_a' })).toEqual({ ok: true })
    expect(vault.profiles('addon')[0]).toMatchObject({ owner: 'env_box' })
    expect(hasRefresh('addon', vault.readSecret('addon', 'ad_a')!)).toBe(true)
    // No CLI signs in with a grant: nothing was installed or pinned.
    await new Promise((r) => setTimeout(r, 10))
    expect(boxHost.activate).not.toHaveBeenCalled()
    expect(pinnedProfile('addon')).toBeNull()
  })

  it('a grant goes to no link while its home is this host, with no addonHome, or in a scope the box does not share, static or not', async () => {
    const box = fakeLink('env_box', 'box')
    boxAnswering(box)
    const mac = host('env_mac', [box], { addonHome: (id) => (id === 'ad_shared' ? 'env_box' : null) })
    coreAccounts.saveAddonGrant({ addonId: 'ad_local', nickname: 'local', blob: grant('ad_local'), signedIn: true })
    coreAccounts.saveAddonGrant({ addonId: 'ad_keys', nickname: 'keys', blob: grant('ad_keys', null, { K: 'v' }) })
    coreAccounts.saveAddonGrant({ addonId: 'ad_shared', nickname: 'shared', blob: grant('ad_shared', null, { K: 'v' }) })
    await mac.sync.syncWith('env_box')
    expect(pushesOf(box).map((t) => [t.profile.name, t.mode, t.profile.static])).toEqual([['ad_shared', 'access', true]])
    // The local OAuth grant stays this host's, refresh token and all.
    expect(hasRefresh('addon', vault.readSecret('addon', 'ad_local')!)).toBe(true)

    const lone = fakeLink('env_box', 'box')
    boxAnswering(lone)
    const bare = host('env_mac', [lone])
    coreAccounts.saveAddonGrant({ addonId: 'ad_a', nickname: 'a', blob: grant('ad_a'), signedIn: true })
    await bare.sync.syncWith('env_box')
    expect(pushesOf(lone)).toEqual([])
  })

  it('a grant registered but with no refresh token goes to the home as an access copy the Mac owns', async () => {
    const box = fakeLink('env_box', 'box')
    boxAnswering(box)
    const mac = host('env_mac', [box], { addonHome: () => 'env_box' })
    coreAccounts.saveAddonGrant({ addonId: 'ad_a', nickname: 'a', blob: grant('ad_a', { accessToken: undefined, refreshToken: undefined, expiresAt: undefined }), signedIn: true })
    await mac.sync.syncWith('env_box')
    expect(pushesOf(box).map((t) => [t.mode, t.profile.owner, t.profile.static, hasRefresh('addon', t.blob)])).toEqual([['access', 'env_mac', false, false]])
    expect(vault.profiles('addon')[0].owner).toBeUndefined()
  })

  it('no CLI holds a grant, so liveLineage is false', async () => {
    const mac = host('env_mac', [])
    expect(await mac.sync.liveLineage('addon', grant('ad_a'))).toBe(false)
  })

  it('a values grant saved on the box lands on the Mac when the add-on is known here, and is refused when it is not', async () => {
    const boxSide = host('env_box', [])
    coreAccounts.saveAddonGrant({ addonId: 'ad_k', nickname: 'keyed', blob: grant('ad_k', null, { 'X-Api-Key': 'secret-1' }) })
    const t = exportAccount('addon', 'ad_k', 'access')
    expect(t.profile.static).toBe(true)
    void boxSide

    let known = false
    const box = fakeLink('env_box', 'box')
    boxAnswering(box, [t])
    const mac = host('env_mac', [box], { addonKnown: (id) => known && id === 'ad_k' })
    await mac.sync.syncWith('env_box')
    expect(vault.profiles('addon')).toEqual([])
    known = true
    await mac.sync.syncWith('env_box')
    expect(vault.profiles('addon')[0]).toMatchObject({ name: 'ad_k', static: true })
    expect(JSON.parse(vault.readSecret('addon', 'ad_k')!).fields).toEqual({ 'X-Api-Key': 'secret-1' })
    expect(mac.sync.policyFor(t)).toBe('admin')
    expect(mac.sync.policyFor({ ...t, service: 'meta' })).toBe('peer')
  })

  it("the box's rotation, pushed to a Mac socket, lands on the Mac's access copy", async () => {
    const mac = host('env_mac', [], { addonKnown: () => true })
    vault.upsertProfile('addon', { name: 'ad_a', accountId: 'ad_a', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('addon', 'ad_a', grant('ad_a', { refreshToken: undefined, accessToken: 'AT1', expiresAt: Date.now() + 60_000 }), 'sync')
    const rotated = grant('ad_a', { refreshToken: undefined, accessToken: 'AT2', expiresAt: Date.now() + HOUR })
    const transfer: Transfer = {
      service: 'addon',
      mode: 'access',
      profile: { name: 'ad_a', accountId: 'ad_a', createdAt: 1, static: false, owner: 'env_box' },
      blob: rotated,
      expiresAt: accessExpiry('addon', rotated)
    }
    mac.sync.onPeerPush('env_box', { push: 'account', from: 'env_box', transfer })
    expect(oauthOf(vault.readSecret('addon', 'ad_a'))).toMatchObject({ accessToken: 'AT2' })
  })

  it("a box tombstone removes the Mac's values copy and the box's list without the grant removes its access copy; each removal is told to the add-on host", async () => {
    const mac = host('env_mac', [], { addonKnown: () => true })
    vault.upsertProfile('addon', { name: 'ad_k', accountId: 'ad_k', createdAt: 1, static: true })
    vault.saveSecret('addon', 'ad_k', grant('ad_k', null, { K: 'v' }), 'sync')
    vault.upsertProfile('addon', { name: 'ad_o', accountId: 'ad_o', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('addon', 'ad_o', grant('ad_o', { refreshToken: undefined }), 'sync')
    // The box's list without either: the static copy stays (absence proves nothing for it), the access copy goes.
    const listed: ListedAccount[] = []
    expect(await mac.sync.prune('env_box', listed, [])).toBe(1)
    expect(vault.profiles('addon').map((p) => p.name)).toEqual(['ad_k'])
    expect(mac.onRemoved).toHaveBeenCalledWith('addon', 'ad_o')
    const tomb: AccountRemoval = { service: 'addon', accountId: 'ad_k', name: 'ad_k', static: true, at: Date.now() }
    expect(await mac.sync.handleRemoved('env_box', { removed: [tomb] })).toEqual({ dropped: 1 })
    expect(vault.profiles('addon')).toEqual([])
    expect(mac.onRemoved).toHaveBeenCalledWith('addon', 'ad_k')
  })

  it('deleteProfile tells the add-on host and keeps a tombstone for a grant this host refreshes or holds statically', async () => {
    const box = host('env_box', [])
    coreAccounts.saveAddonGrant({ addonId: 'ad_k', nickname: 'k', blob: grant('ad_k', null, { K: 'v' }) })
    expect(await box.sync.deleteProfile('addon', 'ad_k')).toMatchObject({ ok: true })
    expect(box.onRemoved).toHaveBeenCalledWith('addon', 'ad_k')
    expect(box.sync.tombstones().map((t) => [t.service, t.accountId, t.static])).toEqual([['addon', 'ad_k', true]])
  })

  it('an access copy landing on the box installs and pins nothing', async () => {
    const box = host('env_box', [])
    const copy = grant('ad_a', { refreshToken: undefined })
    const out = await box.sync.handlePush('env_mac', {
      service: 'addon',
      mode: 'access',
      profile: { name: 'ad_a', accountId: 'ad_a', createdAt: 1, static: false, owner: 'env_mac' },
      blob: copy,
      expiresAt: accessExpiry('addon', copy)
    })
    expect(out).toMatchObject({ ok: true, saved: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(box.activate).not.toHaveBeenCalled()
    expect(pinnedProfile('addon')).toBeNull()
  })
})
