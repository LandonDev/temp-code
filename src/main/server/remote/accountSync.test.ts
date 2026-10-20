import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, vault } from 'aliax-core'
import { accessExpiry, hasRefresh, refreshFingerprint, type ApplyOutcome, type Transfer } from 'aliax-core/sync'
import type { ServerPush } from '@shared/contract'
import { AccountSync, HOME_PREFIX, type ConfirmAnswer } from './accountSync'

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
  // The Codex CLI's directory, empty unless a test signs it in (aliax-core's adapter reads $CODEX_HOME).
  process.env.CODEX_HOME = join(dataDir, 'codex-home')
})
afterEach(() => {
  delete process.env.CODEX_HOME
  rmSync(dataDir, { recursive: true, force: true })
})

const codexJwt = (exp: number): string => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url')}.s`
const codexBlob = (refresh: string, exp = Date.now() + 86_400_000): string => JSON.stringify({ tokens: { access_token: codexJwt(exp), refresh_token: refresh, id_token: 'id', account_id: 'acct' }, last_refresh: 'now' })
const fpOf = (t: Transfer): string | null => refreshFingerprint(t.service, t.blob)
/** The receiver's ok for a handoff, as aliax-core answers it: the fingerprint of the grant it saved. */
const landedOk = (t: Transfer, owner: string | null = t.profile.owner): ApplyOutcome => ({ ok: true, name: t.profile.name, saved: true, owner, expiresAt: t.expiresAt, refreshFingerprint: fpOf(t) })

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
  it('a handoff lands provisionally with the fingerprint of what it saved, becomes the live sign-in on the release; an access copy lands stripped', async () => {
    const activate = vi.fn(async () => {})
    const { sync, nudge } = host('env_box', [], { activate })
    const later = Date.now() + 2 * HOUR
    const sent = transfer('handoff', 'env_box', claudeBlob(later))
    expect(await sync.handlePush('env_mac', sent)).toEqual(landedOk(sent, 'env_mac'))
    await new Promise((r) => setTimeout(r, 10))
    // The row still names the sender: nothing here refreshes or uses the grant until the sender says it stripped its copy.
    expect(activate).not.toHaveBeenCalled()
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_mac', static: false })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
    expect(sync.handleReleased('env_other', { service: 'claude-code', accountId: 'u1' })).toEqual({ ok: false, reason: 'not-held' })
    expect(sync.handleReleased('env_mac', { service: 'claude-code', accountId: 'u9' })).toEqual({ ok: false, reason: 'unknown-account' })
    expect(sync.handleReleased('env_mac', { service: 'claude-code', accountId: 'u1' })).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(activate).toHaveBeenCalledWith('claude-code', 'a@x', expect.any(String))
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box', static: false })
    expect(sync.handleReleased('env_mac', { service: 'claude-code', accountId: 'u1' })).toEqual({ ok: true })
    expect(nudge).toHaveBeenCalled()
    expect(await sync.handlePush('env_other', transfer('handoff', 'env_someone', claudeBlob(later)))).toEqual({ ok: false, reason: 'not-for-us' })
    expect(await sync.handlePush('env_mac', transfer('access', 'env_mac', claudeBlob(later + 1, 'R2'), { name: 'b@x', accountId: 'u2', email: 'b@x' }))).toMatchObject({ ok: true, saved: true, owner: 'env_mac', refreshFingerprint: null })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'b@x')!)).toBe(false)
  })

  it('an older handoff onto an access-only copy is refused as stale and changes nothing', async () => {
    const { sync } = host('env_box', [])
    const later = Date.now() + 2 * HOUR
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', createdAt: 1, owner: 'env_mac' })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later, null))
    expect(await sync.handlePush('env_mac', transfer('handoff', 'env_box', claudeBlob(later - HOUR)))).toEqual({ ok: false, reason: 'stale' })
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_mac' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(false)
    expect(sync.handleReleased('env_mac', { service: 'claude-code', accountId: 'u1' })).toEqual({ ok: false, reason: 'not-held' })
  })

  it('a pull answers access copies of what this host owns or holds statically; takeOver hands the grant out and strips only on the taker\'s confirm', async () => {
    const { sync } = host('env_box', [], { releaseTimeoutMs: 60_000 })
    const later = Date.now() + 2 * HOUR
    vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u1', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'mine', claudeBlob(later))
    vault.upsertProfile('claude-code', { name: 'theirs', accountId: 'u2', createdAt: 1, owner: 'env_mac' })
    vault.saveSecret('claude-code', 'theirs', claudeBlob(later, null))
    vault.upsertProfile('claude-code', { name: 'stat', accountId: 'u3', createdAt: 1, static: true })
    vault.saveSecret('claude-code', 'stat', JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OAT', expiresAt: later } }), oauthAccount: {}, tokenKind: 'static' }))
    const { transfers } = await sync.handlePull('env_mac', {})
    expect(transfers.map((t) => [t.profile.name, t.mode, t.profile.owner, hasRefresh('claude-code', t.blob)])).toEqual([
      ['mine', 'access', 'env_box', false],
      ['stat', 'access', null, false]
    ])
    const taken = (await sync.handlePull('env_mac', { service: 'claude-code', name: 'mine', takeOver: true })).transfers
    expect(taken).toHaveLength(1)
    expect(taken[0]).toMatchObject({ mode: 'handoff', profile: { owner: 'env_mac' } })
    expect(hasRefresh('claude-code', taken[0].blob)).toBe(true)
    // Handed out, not given up: the grant is still refreshed here until the taker confirms it saved it.
    expect(vault.profiles('claude-code').find((p) => p.name === 'mine')).toMatchObject({ owner: 'env_box' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'mine')!)).toBe(true)
    expect(sync.handleConfirm('env_other', { service: 'claude-code', accountId: 'u1', refreshFingerprint: fpOf(taken[0])! })).toEqual({ ok: false, reason: 'not-released' })
    expect(sync.handleConfirm('env_mac', { service: 'claude-code', accountId: 'u1', refreshFingerprint: 'deadbeefdeadbeef' })).toEqual({ ok: false, reason: 'fingerprint' })
    expect(sync.handleConfirm('env_mac', { service: 'claude-code', accountId: 'u9', refreshFingerprint: 'x' })).toEqual({ ok: false, reason: 'unknown-account' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'mine')!)).toBe(true)
    expect(sync.handleConfirm('env_mac', { service: 'claude-code', accountId: 'u1', refreshFingerprint: fpOf(taken[0])! })).toEqual({ ok: true })
    expect(vault.profiles('claude-code').find((p) => p.name === 'mine')).toMatchObject({ owner: 'env_mac' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'mine')!)).toBe(false)
    expect(vault.profiles('claude-code').find((p) => p.name === 'mine')?.releasedAt).toBeUndefined()
    // The same confirm again (its answer was lost) is still ok; nothing to take over twice.
    expect(sync.handleConfirm('env_mac', { service: 'claude-code', accountId: 'u1', refreshFingerprint: fpOf(taken[0])! })).toEqual({ ok: true })
    expect((await sync.handlePull('env_mac', { service: 'claude-code', name: 'mine', takeOver: true })).transfers).toEqual([])
  })

  it('a takeOver with no confirm in time keeps the grant here, and a late confirm is refused', async () => {
    const { sync, nudge } = host('env_box', [], { releaseTimeoutMs: 40 })
    const later = Date.now() + 2 * HOUR
    vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u1', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'mine', claudeBlob(later))
    const [t] = (await sync.handlePull('env_mac', { service: 'claude-code', name: 'mine', takeOver: true })).transfers
    expect(hasRefresh('claude-code', t.blob)).toBe(true)
    nudge.mockClear()
    await new Promise((r) => setTimeout(r, 80))
    expect(nudge).toHaveBeenCalled()
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'mine')!)).toBe(true)
    expect(sync.handleConfirm('env_mac', { service: 'claude-code', accountId: 'u1', refreshFingerprint: fpOf(t)! })).toEqual({ ok: false, reason: 'not-released' })
    // Handed out again: a fresh pending release replaces nothing stale.
    const [again] = (await sync.handlePull('env_mac', { service: 'claude-code', name: 'mine', takeOver: true })).transfers
    expect(sync.handleConfirm('env_mac', { service: 'claude-code', accountId: 'u1', refreshFingerprint: fpOf(again)! })).toEqual({ ok: true })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'mine')!)).toBe(false)
  })
})

describe('AccountSync as a client', () => {
  it('syncWith pulls what the peer shares, pushes access copies of its own, and hands a grant off in two phases when the peer is the home', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync, store } = host('env_mac', [box])
    const later = Date.now() + 2 * HOUR
    vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u1', createdAt: 1 })
    vault.saveSecret('claude-code', 'mine', claudeBlob(later))
    vault.upsertProfile('claude-code', { name: 'boxes', accountId: 'u9', email: 'boxes@x', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'boxes', claudeBlob(later - HOUR, null))
    vault.upsertProfile('codex', { name: 'cdx', accountId: 'acct', createdAt: 1 })
    vault.saveSecret('codex', 'cdx', codexBlob('CR'))
    store.setSetting(`${HOME_PREFIX}codex`, 'env_box')
    const shared = transfer('access', 'env_box', claudeBlob(later + 5, null), { name: 'boxes', accountId: 'u9', email: 'boxes@x' })
    const stranger = transfer('access', 'env_box', claudeBlob(later + 5, null), { name: 'planted', accountId: 'u-planted', email: 'planted@x' })
    box.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'accounts.pull') return { transfers: [shared, stranger] }
      if (method === 'accounts.push') return landedOk((params as { transfer: Transfer }).transfer, 'env_mac')
      if (method === 'accounts.released') return { ok: true }
      throw new Error(`unexpected ${method}`)
    })
    await sync.syncWith('env_box')
    // Pulled: the box's rotation of an account on file landed; the one this host never had did not.
    expect(vault.profiles('claude-code').find((p) => p.name === 'boxes')).toMatchObject({ owner: 'env_box' })
    expect(tokensOf(vault.readSecret('claude-code', 'boxes')!)).toMatchObject({ accessToken: `T${later + 5}` })
    expect(vault.profiles('claude-code').find((p) => p.accountId === 'u-planted')).toBeUndefined()
    // Pushed: claude as an access copy (home is this machine), codex as a handoff (home is the box), then the release.
    const calls = box.request.mock.calls.map((c) => [c[0], c[1]] as [string, { transfer?: Transfer; service?: string; accountId?: string }])
    const pushes = calls.filter((c) => c[0] === 'accounts.push').map((c) => c[1].transfer!)
    expect(pushes.map((t) => [t.service, t.mode, t.profile.owner, hasRefresh(t.service, t.blob)])).toEqual([
      ['claude-code', 'access', 'env_mac', false],
      ['codex', 'handoff', 'env_box', true]
    ])
    expect(calls.filter((c) => c[0] === 'accounts.released').map((c) => [c[1].service, c[1].accountId])).toEqual([['codex', 'acct']])
    expect(vault.profiles('codex')[0]).toMatchObject({ owner: 'env_box' })
    expect(vault.profiles('codex')[0].releasedAt).toBeUndefined()
    expect(hasRefresh('codex', vault.readSecret('codex', 'cdx')!)).toBe(false)
    expect(vault.profiles('claude-code').find((p) => p.name === 'mine')?.syncedAt).toBeGreaterThan(0)
    expect(box.lastSyncAt).toBeGreaterThan(0)
  })

  it('a handoff is stripped here only on an answer that echoes the fingerprint of what was sent', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync, store } = host('env_mac', [box])
    vault.upsertProfile('codex', { name: 'cdx', accountId: 'acct', createdAt: 1 })
    vault.saveSecret('codex', 'cdx', codexBlob('CR'))
    store.setSetting(`${HOME_PREFIX}codex`, 'env_box')
    const answers: ApplyOutcome[] = [
      { ok: false, reason: 'stale' },
      { ok: true, name: 'cdx', saved: false, owner: 'env_box', expiresAt: null, refreshFingerprint: 'another-grant00' },
      { ok: true, name: 'cdx', saved: true, owner: 'env_mac', expiresAt: null, refreshFingerprint: null }
    ]
    box.request.mockImplementation(async (method: string) => {
      if (method === 'accounts.pull') return { transfers: [] }
      if (method === 'accounts.push') return answers.shift()
      throw new Error(`unexpected ${method}`)
    })
    for (let i = 0; i < 3; i++) {
      await sync.syncWith('env_box')
      expect(vault.profiles('codex')[0].owner).toBeUndefined()
      expect(hasRefresh('codex', vault.readSecret('codex', 'cdx')!)).toBe(true)
    }
    expect(box.request.mock.calls.filter((c) => c[0] === 'accounts.released')).toEqual([])
    // Dropped on the wire: the same.
    box.request.mockImplementation(async (method: string) => {
      if (method === 'accounts.pull') return { transfers: [] }
      throw new Error('socket closed')
    })
    await sync.syncWith('env_box')
    expect(hasRefresh('codex', vault.readSecret('codex', 'cdx')!)).toBe(true)
    expect(vault.profiles('codex')[0].owner).toBeUndefined()
    expect(box.lastError).toBe('socket closed')
  })

  it('a release the peer did not hear is told again on the next sync', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync, store } = host('env_mac', [box])
    vault.upsertProfile('codex', { name: 'cdx', accountId: 'acct', createdAt: 1 })
    vault.saveSecret('codex', 'cdx', codexBlob('CR'))
    store.setSetting(`${HOME_PREFIX}codex`, 'env_box')
    let released = 0
    box.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'accounts.pull') return { transfers: [] }
      if (method === 'accounts.push') return landedOk((params as { transfer: Transfer }).transfer, 'env_mac')
      if (method === 'accounts.released') {
        released++
        if (released === 1) throw new Error('socket closed')
        return { ok: true }
      }
      throw new Error(`unexpected ${method}`)
    })
    await sync.syncWith('env_box')
    expect(vault.profiles('codex')[0]).toMatchObject({ owner: 'env_box' })
    expect(vault.profiles('codex')[0].releasedAt).toBeGreaterThan(0)
    expect(hasRefresh('codex', vault.readSecret('codex', 'cdx')!)).toBe(false)
    await sync.syncWith('env_box')
    expect(released).toBe(2)
    expect(vault.profiles('codex')[0].releasedAt).toBeUndefined()
    expect(box.request.mock.calls.filter((c) => c[0] === 'accounts.push')).toHaveLength(1)
  })

  it('the grant the Codex CLI here is signed in with is never handed off; a Cursor grant never is', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync, store } = host('env_mac', [box])
    vault.upsertProfile('codex', { name: 'cdx', accountId: 'acct', createdAt: 1 })
    vault.saveSecret('codex', 'cdx', codexBlob('CR-LIVE'))
    vault.upsertProfile('cursor', { name: 'cur', accountId: 'cu', createdAt: 1 })
    vault.saveSecret('cursor', 'cur', JSON.stringify({ access: codexJwt(Date.now() + HOUR), refresh: 'CUR', vscdb: {} }))
    store.setSetting(`${HOME_PREFIX}codex`, 'env_box')
    store.setSetting(`${HOME_PREFIX}cursor`, 'env_box')
    rmSync(process.env.CODEX_HOME!, { recursive: true, force: true })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(process.env.CODEX_HOME!, { recursive: true })
    writeFileSync(join(process.env.CODEX_HOME!, 'auth.json'), codexBlob('CR-LIVE'))
    box.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'accounts.pull') return { transfers: [] }
      if (method === 'accounts.push') return landedOk((params as { transfer: Transfer }).transfer, 'env_mac')
      throw new Error(`unexpected ${method}`)
    })
    await sync.syncWith('env_box')
    const pushes = () => box.request.mock.calls.filter((c) => c[0] === 'accounts.push').map((c) => (c[1] as { transfer: Transfer }).transfer)
    expect(pushes().map((t) => [t.service, t.mode, hasRefresh(t.service, t.blob)])).toEqual([
      ['codex', 'access', false],
      ['cursor', 'access', false]
    ])
    expect(hasRefresh('codex', vault.readSecret('codex', 'cdx')!)).toBe(true)
    expect(vault.profiles('codex')[0].owner).toBeUndefined()
    // The CLI rotated onto another token (or another sign-in): the stored grant is not the live one, and goes.
    writeFileSync(join(process.env.CODEX_HOME!, 'auth.json'), codexBlob('CR-ROTATED'))
    box.request.mockClear()
    box.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'accounts.pull') return { transfers: [] }
      if (method === 'accounts.push') return landedOk((params as { transfer: Transfer }).transfer, 'env_mac')
      if (method === 'accounts.released') return { ok: true }
      throw new Error(`unexpected ${method}`)
    })
    await sync.syncWith('env_box')
    expect(pushes().map((t) => [t.service, t.mode])).toEqual([
      ['codex', 'handoff'],
      ['cursor', 'access']
    ])
    expect(vault.profiles('codex')[0]).toMatchObject({ owner: 'env_box' })
    expect(hasRefresh('cursor', vault.readSecret('cursor', 'cur')!)).toBe(true)
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

  it('askOwner pulls one account from its owner and answers with the vault copy; a peer push lands a rotation of an account on file and nothing else', async () => {
    const box = fakeLink('env_box', 'box')
    const lines: string[] = []
    const { sync } = host('env_mac', [box], { log: (l) => lines.push(l) })
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
    // An account this host never had, and a copy the peer claims a third host owns: refused, and said so.
    sync.onPeerPush('env_box', { push: 'account', from: 'env_box', transfer: transfer('access', 'env_box', claudeBlob(later + HOUR, null), { name: 'planted', accountId: 'u-planted', email: 'planted@x' }) })
    sync.onPeerPush('env_box', { push: 'account', from: 'env_box', transfer: transfer('access', 'env_third', claudeBlob(later + 2 * HOUR, null)) })
    expect(vault.profiles('claude-code').map((p) => p.name)).toEqual(['a@x'])
    expect(tokensOf(vault.readSecret('claude-code', 'a@x')!)).toMatchObject({ accessToken: `T${later + HOUR}` })
    expect(lines.filter((l) => /refused/.test(l))).toEqual([
      'claude-code planted: env_box pushed an account this host never had; refused',
      'claude-code a@x: rotation from env_box refused (not-owner)'
    ])
  })

  it('moving a home back to this machine takes the grants over: saved provisionally, confirmed with the fingerprint, then owned', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync, store } = host('env_mac', [box])
    const later = Date.now() + 2 * HOUR
    store.setSetting(`${HOME_PREFIX}claude`, 'env_box')
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later, null))
    const handed = transfer('handoff', 'env_mac', claudeBlob(later))
    const confirms: unknown[] = []
    box.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'accounts.pull' && (params as { takeOver?: boolean }).takeOver) return { transfers: [handed] }
      if (method === 'accounts.pull') return { transfers: [] }
      if (method === 'accounts.confirm') {
        confirms.push(params)
        return { ok: true } satisfies ConfirmAnswer
      }
      throw new Error(`unexpected ${method}`)
    })
    await sync.setHome('claude', null)
    expect(sync.homes()).toEqual({})
    expect(confirms).toEqual([{ from: 'env_mac', service: 'claude-code', accountId: 'u1', refreshFingerprint: fpOf(handed) }])
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_mac' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
  })

  it('a takeOver whose confirm answer is lost stays provisional and settles on the next sync, either way', async () => {
    const box = fakeLink('env_box', 'box')
    const { sync, store } = host('env_mac', [box])
    const later = Date.now() + 2 * HOUR
    store.setSetting(`${HOME_PREFIX}claude`, 'env_box')
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later, null))
    const handed = transfer('handoff', 'env_mac', claudeBlob(later))
    let confirmAnswer: ConfirmAnswer | Error = new Error('socket closed')
    box.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'accounts.pull' && (params as { takeOver?: boolean }).takeOver) return { transfers: [handed] }
      if (method === 'accounts.pull') return { transfers: [] }
      if (method === 'accounts.confirm') {
        if (confirmAnswer instanceof Error) throw confirmAnswer
        return confirmAnswer
      }
      throw new Error(`unexpected ${method}`)
    })
    await sync.setHome('claude', null)
    // Provisional: the grant is here, the row still names the box, so nothing here refreshes it.
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
    // The owner timed out and kept the grant: this copy drops back to access-only.
    confirmAnswer = { ok: false, reason: 'not-released' }
    await sync.syncWith('env_box')
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(false)
    // Or the owner had stripped and only its answer was lost: the next ask makes this host the owner.
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later), 'sync')
    confirmAnswer = { ok: true }
    await sync.syncWith('env_box')
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_mac' })
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
    // The takeOver's own confirm, the one setHome's sync retried, then one per sync above.
    expect(box.request.mock.calls.filter((c) => c[0] === 'accounts.confirm')).toHaveLength(4)
  })
})

describe('a static token as the live sign-in on a host (the box)', () => {
  const YEAR = 365 * 86_400_000
  const staticBlob = (token: string, exp: number, account = { uuid: 'u1', email: 'a@x' }): string =>
    JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: exp, scopes: ['user:profile', 'user:inference'] } }), oauthAccount: { accountUuid: account.uuid, emailAddress: account.email }, tokenKind: 'static' })
  const staticTransfer = (blob: string, profile: Partial<Transfer['profile']> = {}): Transfer => transfer('access', null, blob, { static: true, owner: null, ...profile })

  it('replaces the access copy that is live, follows its own renewal, and leaves another static token alone', async () => {
    const activate = vi.fn(async () => {})
    let liveId: string | null = null
    let liveExp: number | null = null
    const { sync } = host('env_box', [], { activate, liveAccountId: async () => liveId, liveExpiry: async () => liveExp })
    const now = Date.now()
    // The box holds a@x as an access copy refreshed by the Mac, and that copy is the live sign-in.
    expect((await sync.handlePush('env_mac', transfer('access', 'env_mac', claudeBlob(now + HOUR, null)))).ok).toBe(true)
    // Nothing was live, so the copy became the sign-in; wait for that install before the clock moves on.
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1))
    liveId = 'u1'
    liveExp = now + HOUR
    activate.mockClear()
    // The Mac converted a@x: the static token lands over the copy (no owner left) and becomes the live sign-in.
    const first = await sync.handlePush('env_mac', staticTransfer(staticBlob('OAT1', now + YEAR)))
    expect(first).toMatchObject({ ok: true, saved: true, owner: null })
    await vi.waitFor(() => expect(activate).toHaveBeenCalledWith('claude-code', 'a@x', expect.stringContaining('OAT1')))
    expect(vault.profiles('claude-code').find((p) => p.name === 'a@x')).toMatchObject({ static: true })
    expect(vault.profiles('claude-code').find((p) => p.name === 'a@x')?.owner).toBeUndefined()
    liveExp = now + YEAR
    activate.mockClear()
    // Another account's static token: filed, not made live.
    expect((await sync.handlePush('env_mac', staticTransfer(staticBlob('OAT-B', now + YEAR, { uuid: 'u2', email: 'b@x' }), { name: 'b@x', accountId: 'u2', email: 'b@x' }))).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(activate).not.toHaveBeenCalled()
    // The same token again (re-saved, as any copy no older than the one held): nothing to install.
    expect(await sync.handlePush('env_mac', staticTransfer(staticBlob('OAT1', now + YEAR)))).toMatchObject({ ok: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(activate).not.toHaveBeenCalled()
    // Its renewal, a year on: installed over the live one.
    const renewed = await sync.handlePush('env_mac', staticTransfer(staticBlob('OAT2', now + 2 * YEAR)))
    expect(renewed).toMatchObject({ ok: true, saved: true })
    await vi.waitFor(() => expect(activate).toHaveBeenCalledWith('claude-code', 'a@x', expect.stringContaining('OAT2')))
  })

  it('never replaces a sign-in this host refreshes itself', async () => {
    const activate = vi.fn(async () => {})
    const { sync } = host('env_mac', [], { activate, liveAccountId: async () => 'u1' })
    const now = Date.now()
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', email: 'a@x', createdAt: 1 })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(now + HOUR))
    // A peer cannot land a static token over a grant this host owns ('static' refusal path is for the reverse); push one for another row.
    expect((await sync.handlePush('env_box', staticTransfer(staticBlob('OAT-B', now + YEAR, { uuid: 'u2', email: 'b@x' }), { name: 'b@x', accountId: 'u2', email: 'b@x' }))).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(activate).not.toHaveBeenCalled()
  })
})
