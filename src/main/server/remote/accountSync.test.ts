import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, vault } from 'aliax-core'
import { accessExpiry, hasRefresh, type Transfer } from 'aliax-core/sync'
import type { ServerPush } from '@shared/contract'
import { AccountSync, HOME_PREFIX } from './accountSync'

// No Keychain in tests: the adapters' live reads say "not signed in".
vi.mock('aliax-core/keychain', () => ({
  readPassword: async () => {
    throw new Error('no keychain in tests')
  },
  writePassword: async () => {}
}))

const HOUR = 3_600_000
const claudeBlob = (exp: number, refresh: string | null = `R${exp}`): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: `T${exp}`, ...(refresh ? { refreshToken: refresh } : {}), expiresAt: exp } }), oauthAccount: { accountUuid: 'u1' } })
const tokensOf = (blob: string): Record<string, unknown> => JSON.parse(JSON.parse(blob).keychain).claudeAiOauth

/** A peer link as the sync sees it: connected, answering what the test scripts. */
function fakeLink(id: string, name = id) {
  const link = {
    id,
    env: { id, name },
    connected: true,
    lastSyncAt: null as number | null,
    lastError: null as string | null,
    request: vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({ transfers: [] }))
  }
  return link
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

let dataDir = ''
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tc-account-sync-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

function host(environmentId: string, links: FakeLink[], extra: Partial<ConstructorParameters<typeof AccountSync>[0]> = {}) {
  const store = memoryStore()
  const nudge = vi.fn()
  const sync = new AccountSync({
    environmentId,
    store,
    peers: { get: (id) => links.find((l) => l.id === id) as never, all: () => links as never },
    nudge,
    log: () => {},
    liveAccountId: async () => null,
    activate: vi.fn(async () => {}),
    ...extra
  })
  // The core's vault hooks reach the sync the way aliax.ts wires them in the app.
  configure({
    dataDir,
    fetch: async (url) => {
      throw new Error(`unexpected fetch ${url}`)
    },
    secrets: { mode: 'fileKey', path: join(dataDir, 'vault.key') },
    environmentId,
    hooks: { onSecretSaved: sync.onSecretSaved, askOwner: sync.askOwner }
  })
  return { sync, store, nudge }
}

const transfer = (mode: Transfer['mode'], owner: string | null, blob: string, profile: Partial<Transfer['profile']> = {}): Transfer => ({
  service: 'claude-code',
  mode,
  profile: { name: 'a@x', accountId: 'u1', email: 'a@x', createdAt: 1, static: false, owner, ...profile },
  blob,
  expiresAt: accessExpiry('claude-code', blob)
})

describe('AccountSync as a host', () => {
  it('a handoff makes this host the owner and the live sign-in when it had none; an access copy lands stripped', async () => {
    const activate = vi.fn(async () => {})
    const { sync, nudge } = host('env_box', [], { activate })
    const later = Date.now() + 2 * HOUR
    expect(sync.handlePush('env_mac', transfer('handoff', 'env_box', claudeBlob(later)))).toMatchObject({ ok: true, saved: true, owner: 'env_box' })
    await new Promise((r) => setTimeout(r, 10))
    expect(activate).toHaveBeenCalledWith('claude-code', 'a@x', expect.any(String))
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box', static: false })
    expect(nudge).toHaveBeenCalled()
    expect(sync.handlePush('env_other', transfer('handoff', 'env_someone', claudeBlob(later)))).toEqual({ ok: false, reason: 'not-for-us' })
    expect(sync.handlePush('env_mac', transfer('access', 'env_mac', claudeBlob(later + 1, 'R2'), { name: 'b@x', accountId: 'u2', email: 'b@x' }))).toMatchObject({ ok: true, saved: true, owner: 'env_mac' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'b@x')!)).toBe(false)
  })

  it('a pull answers access copies of what this host owns or holds statically, never a copy owned elsewhere; takeOver hands the grant out', () => {
    const { sync } = host('env_box', [])
    const later = Date.now() + 2 * HOUR
    vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u1', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'mine', claudeBlob(later))
    vault.upsertProfile('claude-code', { name: 'theirs', accountId: 'u2', createdAt: 1, owner: 'env_mac' })
    vault.saveSecret('claude-code', 'theirs', claudeBlob(later, null))
    vault.upsertProfile('claude-code', { name: 'stat', accountId: 'u3', createdAt: 1, static: true })
    vault.saveSecret('claude-code', 'stat', JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OAT', expiresAt: later } }), oauthAccount: {}, tokenKind: 'static' }))
    const { transfers } = sync.handlePull('env_mac', {})
    expect(transfers.map((t) => [t.profile.name, t.mode, t.profile.owner, hasRefresh('claude-code', t.blob)])).toEqual([
      ['mine', 'access', 'env_box', false],
      ['stat', 'access', null, false]
    ])
    const taken = sync.handlePull('env_mac', { service: 'claude-code', name: 'mine', takeOver: true }).transfers
    expect(taken).toHaveLength(1)
    expect(taken[0]).toMatchObject({ mode: 'handoff', profile: { owner: 'env_mac' } })
    expect(hasRefresh('claude-code', taken[0].blob)).toBe(true)
    expect(vault.profiles('claude-code').find((p) => p.name === 'mine')).toMatchObject({ owner: 'env_mac' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'mine')!)).toBe(false)
    // Nothing to take over twice.
    expect(sync.handlePull('env_mac', { service: 'claude-code', name: 'mine', takeOver: true }).transfers).toEqual([])
  })
})

describe('AccountSync as a client', () => {
  it('syncWith pulls what the peer shares, pushes access copies of its own, and hands a grant off when the peer is the home', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync, store } = host('env_mac', [box])
    const later = Date.now() + 2 * HOUR
    vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u1', createdAt: 1 })
    vault.saveSecret('claude-code', 'mine', claudeBlob(later))
    vault.upsertProfile('codex', { name: 'cdx', accountId: 'acct', createdAt: 1 })
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + 86_400_000) / 1000) })).toString('base64url')}.s`
    vault.saveSecret('codex', 'cdx', JSON.stringify({ tokens: { access_token: jwt, refresh_token: 'CR', account_id: 'acct' } }))
    store.setSetting(`${HOME_PREFIX}codex`, 'env_box')
    const shared = transfer('access', 'env_box', claudeBlob(later + 5, null), { name: 'boxes', accountId: 'u9', email: 'boxes@x' })
    box.request.mockImplementation(async (method: string) => (method === 'accounts.pull' ? { transfers: [shared] } : { ok: true, name: 'x', saved: true, owner: null, expiresAt: null }))
    await sync.syncWith('env_box')
    // Pulled: the box's copy landed as a consumer copy.
    expect(vault.profiles('claude-code').find((p) => p.name === 'boxes')).toMatchObject({ owner: 'env_box' })
    // Pushed: claude as an access copy (home is this machine), codex as a handoff (home is the box).
    const pushes = box.request.mock.calls.filter((c) => c[0] === 'accounts.push').map((c) => (c[1] as { transfer: Transfer }).transfer)
    expect(pushes.map((t) => [t.service, t.mode, t.profile.owner, hasRefresh(t.service, t.blob)])).toEqual([
      ['claude-code', 'access', 'env_mac', false],
      ['codex', 'handoff', 'env_box', true]
    ])
    expect(vault.profiles('codex')[0]).toMatchObject({ owner: 'env_box' })
    expect(hasRefresh('codex', vault.readSecret('codex', 'cdx')!)).toBe(false)
    expect(vault.profiles('claude-code').find((p) => p.name === 'mine')?.syncedAt).toBeGreaterThan(0)
    expect(box.lastSyncAt).toBeGreaterThan(0)
  })

  it('a local vault write goes to subscribers as an account push and to every connected peer; a sync write does not', async () => {
    vi.useFakeTimers()
    try {
      const box = fakeLink('env_box', 'box')
      const { sync } = host('env_mac', [box])
      const got: ServerPush[] = []
      sync.subscribe((p) => got.push(p))
      const later = Date.now() + 2 * HOUR
      vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u1', createdAt: 1 })
      vault.saveSecret('claude-code', 'mine', claudeBlob(later), 'sync')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(got).toEqual([])
      vault.saveSecret('claude-code', 'mine', claudeBlob(later + 1))
      vault.saveSecret('claude-code', 'mine', claudeBlob(later + 2))
      await vi.advanceTimersByTimeAsync(1_500)
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ push: 'account', from: 'env_mac', transfer: { mode: 'access', profile: { owner: 'env_mac' } } })
      expect(hasRefresh('claude-code', (got[0] as { transfer: Transfer }).transfer.blob)).toBe(false)
      expect(box.request).toHaveBeenCalledTimes(1)
      expect(box.request.mock.calls[0][0]).toBe('accounts.push')
    } finally {
      vi.useRealTimers()
    }
  })

  it('askOwner pulls one account from its owner and answers with the vault copy; a peer push lands a rotation', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync } = host('env_mac', [box])
    const later = Date.now() + 2 * HOUR
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later - HOUR, null))
    box.request.mockImplementation(async () => ({ transfers: [transfer('access', 'env_box', claudeBlob(later, null))] }))
    const out = await sync.askOwner('claude-code', 'a@x', 'env_box')
    expect(box.request).toHaveBeenCalledWith('accounts.pull', { from: 'env_mac', service: 'claude-code', name: 'a@x' })
    expect(tokensOf(out!)).toMatchObject({ accessToken: `T${later}` })
    expect(await sync.askOwner('claude-code', 'a@x', 'env_unknown')).toBeNull()
    box.connected = false
    expect(await sync.askOwner('claude-code', 'a@x', 'env_box')).toBeNull()
    sync.onPeerPush('env_box', { push: 'account', from: 'env_box', transfer: transfer('access', 'env_box', claudeBlob(later + HOUR, null)) })
    expect(tokensOf(vault.readSecret('claude-code', 'a@x')!)).toMatchObject({ accessToken: `T${later + HOUR}` })
  })

  it('moving a home back to this machine takes the grants over', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync, store } = host('env_mac', [box])
    const later = Date.now() + 2 * HOUR
    store.setSetting(`${HOME_PREFIX}claude`, 'env_box')
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later, null))
    box.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'accounts.pull' && (params as { takeOver?: boolean }).takeOver) return { transfers: [transfer('handoff', 'env_mac', claudeBlob(later))] }
      if (method === 'accounts.pull') return { transfers: [] }
      return { ok: true, name: 'a@x', saved: true, owner: 'env_mac', expiresAt: later }
    })
    await sync.setHome('claude', null)
    expect(sync.homes()).toEqual({})
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_mac' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
  })
})
