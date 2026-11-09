import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accounts as coreAccounts, acquire, configure, vault } from 'aliax-core'
import { ADDON_SERVICE, AddonGrantBlobSchema, type AddonGrantBlob } from '@shared/addonGrant'
import { GRANT_NO_FIELD, GRANT_OFFLINE, GRANT_ON_MAC, GRANT_PROBE_REFUSED, SIGNIN_BUSY, SIGNIN_NEEDS_BROWSER } from '@shared/addonGrantWords'
import type { AddonGrantView } from '@shared/contract-addonGrants'
import type { AddonRow, AddonSpec } from '@shared/contract-addons'
import { AccountSync } from '../remote/accountSync'
import { ADDON_FORCE_REFRESH_MIN_MS, ADDON_REFRESH_MARGIN_MS, AddonGrants, grantRpc, type AddonGrantsDeps } from './addonGrants'
import { SignInError, type AddonOAuth, type AddonSignIn, type SignInHooks, type SignInInput } from './oauthFlow'

vi.mock('aliax-core/keychain', () => ({
  readPassword: async () => {
    throw new Error('no keychain in tests')
  },
  writePassword: async () => {}
}))

const TOKEN_URL = 'https://auth.example.com/as/token'
const MIN = 60_000
const person = { kind: 'person' } as const
const oauthSpec: AddonSpec = { transport: 'http', url: 'https://mcp.example.com/mcp', headers: ['X-Team'], auth: 'oauth' }
const keySpec: AddonSpec = { transport: 'http', url: 'https://keyed.example.com/mcp', headers: ['X-Api-Key'], auth: 'fields' }
const twoKeySpec: AddonSpec = { transport: 'http', url: 'https://keyed.example.com/mcp', headers: ['X-Api-Key', 'X-Team'], auth: 'fields' }
const rowOf = (id: string, spec: AddonSpec, workspaceId: string | null = null): AddonRow => ({
  id,
  name: id.replace(/^ad_/, ''),
  workspaceId,
  description: '',
  spec,
  enabled: true,
  addedBy: person,
  writtenBy: person,
  createdAt: 1,
  updatedAt: 1
})

const oauth = (over: Partial<AddonOAuth> = {}): AddonOAuth => ({
  clientId: 'cl_1',
  redirectPort: 51234,
  authorizationUrl: 'https://auth.example.com/as/authorize',
  tokenUrl: TOKEN_URL,
  issuer: 'https://auth.example.com/as',
  accessToken: 'AT0',
  refreshToken: 'RT0',
  expiresAt: Date.now() + 60 * MIN,
  ...over
})
const blobOf = (addonId: string, fields: Record<string, string> = {}, o: AddonOAuth | null = null): string =>
  JSON.stringify({ v: 1, mintedBy: 'app', addonId, fields, ...(o ? { oauth: o } : {}) } satisfies AddonGrantBlob)
const stored = (id: string): AddonGrantBlob | null => {
  const raw = vault.readSecret(ADDON_SERVICE, id)
  return raw ? AddonGrantBlobSchema.parse(JSON.parse(raw)) : null
}

/** The rows a host's AddonStore holds, with the follow's removal. */
function rows(initial: AddonRow[]) {
  const map = new Map(initial.map((r) => [r.id, r]))
  const listeners = new Set<() => void>()
  return {
    get: (id: string) => map.get(id) ?? null,
    list: () => [...map.values()],
    onChange: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    remove(id: string) {
      map.delete(id)
      for (const fn of listeners) fn()
    },
    add(row: AddonRow) {
      map.set(row.id, row)
      for (const fn of listeners) fn()
    }
  }
}

function fakeLink(connected = true) {
  return { connected, request: vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({})) }
}

/** A token endpoint that rotates: each answer a new pair, `expiresIn` seconds. */
function tokenEndpoint() {
  let n = 0
  const state = { expiresIn: 3600 as number | undefined, status: 200, fail: false, during: null as null | (() => Promise<void> | void) }
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url !== TOKEN_URL) throw new Error(`unexpected fetch ${url}`)
    if (state.fail) throw new Error('ECONNREFUSED')
    await state.during?.()
    if (state.status !== 200) return new Response('{"error":"invalid_grant"}', { status: state.status })
    n++
    return new Response(JSON.stringify({ access_token: `AT${n}`, refresh_token: `RT${n}`, ...(state.expiresIn ? { expires_in: state.expiresIn } : {}) }), { status: 200 })
  })
  return { fetch, state }
}

let dataDir = ''
let grants: AddonGrants | null = null
const consoleLines: string[] = []
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tc-addon-grants-'))
  consoleLines.length = 0
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(' ')))
})
afterEach(() => {
  grants?.close()
  grants = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
})

interface HostOpts {
  env?: string
  rows?: AddonRow[]
  scopeHome?: (ws: string | null) => string | null
  links?: Record<string, ReturnType<typeof fakeLink>>
  signIn?: AddonSignIn | null
  probe?: AddonGrantsDeps['probe']
  resync?: AddonGrantsDeps['resync']
  askOwner?: (service: string, name: string, owner: string) => Promise<string | null>
}
function host(opts: HostOpts = {}) {
  const env = opts.env ?? 'env_box'
  const store = rows(opts.rows ?? [])
  const token = tokenEndpoint()
  const grantsChanged = vi.fn()
  const settings = new Map<string, string>()
  let me: AddonGrants | null = null
  const sync = new AccountSync({
    environmentId: env,
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => void (v === null ? settings.delete(k) : settings.set(k, v)) },
    peers: { get: () => undefined, all: () => [] },
    nudge: () => {},
    log: () => {},
    liveAccountId: async () => null,
    onRemoved: (s, n) => s === ADDON_SERVICE && me?.onRemoved(n)
  })
  configure({
    dataDir,
    fetch: token.fetch,
    secrets: { mode: 'fileKey', path: join(dataDir, 'vault.key') },
    environmentId: env,
    hooks: {
      onSecretSaved: (s, n) => s === ADDON_SERVICE && me?.onSaved(n),
      askOwner: opts.askOwner
    }
  })
  const probe = vi.fn(opts.probe ?? (async () => 'ok' as const))
  me = grants = new AddonGrants({
    environmentId: env,
    addons: store,
    accountSync: sync,
    scopeHome: opts.scopeHome ?? (() => null),
    peers: { get: (id) => opts.links?.[id] as never },
    hostName: (id) => id.replace(/^env_/, ''),
    grantsChanged,
    signIn: opts.signIn === undefined ? null : opts.signIn,
    probe,
    resync: opts.resync,
    log: () => {},
    pushMs: 20
  })
  return { grants: me, store, token, grantsChanged, sync, probe }
}
const ownHere = (id: string, o: AddonOAuth = oauth(), fields: Record<string, string> = {}): void =>
  void coreAccounts.saveAddonGrant({ addonId: id, nickname: id, blob: blobOf(id, fields, o), signedIn: true })
const copyOf = (id: string, owner: string, o: AddonOAuth = oauth({ refreshToken: undefined }), fields: Record<string, string> = {}): void => {
  vault.upsertProfile(ADDON_SERVICE, { name: id, accountId: id, createdAt: 1, owner })
  vault.saveSecret(ADDON_SERVICE, id, blobOf(id, fields, o), 'sync')
}
const secretFiles = (): string[] => (existsSync(join(dataDir, 'secrets')) ? readdirSync(join(dataDir, 'secrets')).filter((f) => f.startsWith(`${ADDON_SERVICE}__`)) : [])
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('AddonGrants: the source', () => {
  it('reads the vault fresh, and answers null on garbage naming the add-on, never the blob', async () => {
    const { grants } = host({ rows: [rowOf('ad_k', keySpec)] })
    expect(await grants.read('ad_k')).toBeNull()
    coreAccounts.saveAddonGrant({ addonId: 'ad_k', nickname: 'k', blob: blobOf('ad_k', { 'X-Api-Key': 'v1' }) })
    expect((await grants.read('ad_k'))?.fields).toEqual({ 'X-Api-Key': 'v1' })
    vault.saveSecret(ADDON_SERVICE, 'ad_k', '{"secret":"S3CR3T-garbage"}')
    expect(await grants.read('ad_k')).toBeNull()
    expect(consoleLines.join('\n')).toContain('ad_k')
    expect(consoleLines.join('\n')).not.toContain('S3CR3T')
  })
})

describe('AddonGrants: refresh on a 401', () => {
  it('the owner forces once per 30 s; an ask inside the window runs at its end and recovers a grant with no expiry', async () => {
    vi.useFakeTimers()
    const { grants, token, grantsChanged } = host({ rows: [rowOf('ad_o', oauthSpec)] })
    ownHere('ad_o', oauth({ expiresAt: undefined }))
    await grants.refresh('ad_o')
    expect(token.fetch).toHaveBeenCalledTimes(1)
    expect(stored('ad_o')?.oauth?.accessToken).toBe('AT1')
    expect(await grants.forceRefresh('ad_o')).toBe(false)
    await grants.refresh('ad_o')
    expect(token.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(ADDON_FORCE_REFRESH_MIN_MS)
    expect(token.fetch).toHaveBeenCalledTimes(2)
    expect(stored('ad_o')?.oauth?.accessToken).toBe('AT2')
    expect(grantsChanged).toHaveBeenCalledWith('ad_o')
  })

  it("a copy asks its owner's addons.grant.refresh first, then pulls, even with a long-lived local token and the owner's push withheld", async () => {
    const order: string[] = []
    const box = fakeLink()
    box.request.mockImplementation(async (method: string) => {
      order.push(method)
      return { refreshed: true }
    })
    const askOwner = vi.fn(async (_s: string, name: string) => {
      order.push('pull')
      vault.saveSecret(ADDON_SERVICE, name, blobOf(name, {}, oauth({ accessToken: 'FRESH', refreshToken: undefined, expiresAt: Date.now() + 120 * MIN })), 'sync')
      return vault.readSecret(ADDON_SERVICE, name)
    })
    const { grants, token } = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec)], links: { env_box: box }, askOwner })
    copyOf('ad_o', 'env_box', oauth({ refreshToken: undefined, accessToken: 'REFUSED', expiresAt: Date.now() + 60 * MIN }))
    await grants.refresh('ad_o')
    expect(order).toEqual(['addons.grant.refresh', 'pull'])
    expect(box.request).toHaveBeenCalledWith('addons.grant.refresh', { id: 'ad_o' })
    expect(token.fetch).not.toHaveBeenCalled()
    expect(stored('ad_o')?.oauth?.accessToken).toBe('FRESH')
  })

  it('a values grant has nothing to refresh', async () => {
    const { grants, token } = host({ rows: [rowOf('ad_k', keySpec)] })
    coreAccounts.saveAddonGrant({ addonId: 'ad_k', nickname: 'k', blob: blobOf('ad_k', { 'X-Api-Key': 'v' }) })
    await grants.refresh('ad_k')
    expect(token.fetch).not.toHaveBeenCalled()
  })
})

describe('AddonGrants: the keeper', () => {
  it('refreshes a long token five minutes ahead and a short one a quarter of its life ahead', async () => {
    vi.useFakeTimers()
    const { grants, token } = host({ rows: [rowOf('ad_long', oauthSpec), rowOf('ad_short', oauthSpec)] })
    ownHere('ad_long', oauth({ expiresAt: Date.now() + 60 * MIN }))
    ownHere('ad_short', oauth({ expiresAt: Date.now() + 20_000 }))
    grants.start()
    await vi.advanceTimersByTimeAsync(14_000)
    expect(token.fetch).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(token.fetch).toHaveBeenCalledTimes(1)
    expect(stored('ad_short')?.oauth?.accessToken).toBe('AT1')
    token.fetch.mockClear()
    await vi.advanceTimersByTimeAsync(60 * MIN - ADDON_REFRESH_MARGIN_MS - 16_000 - 1_000)
    expect(token.fetch.mock.calls.length).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(token.fetch.mock.calls.length).toBe(1)
  })

  it('a copy asks its owner at half the lead, which the owner usually beats', async () => {
    vi.useFakeTimers()
    const askOwner = vi.fn(async () => null)
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec)], askOwner })
    copyOf('ad_o', 'env_box', oauth({ refreshToken: undefined, expiresAt: Date.now() + 60 * MIN }))
    grants.start()
    await vi.advanceTimersByTimeAsync(60 * MIN - ADDON_REFRESH_MARGIN_MS / 2 - 1_000)
    expect(askOwner).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(askOwner).toHaveBeenCalledWith(ADDON_SERVICE, 'ad_o', 'env_box')
  })

  it('a failure retries on its steps past the token end while a refresh token is held', async () => {
    vi.useFakeTimers()
    const { grants, token } = host({ rows: [rowOf('ad_o', oauthSpec)] })
    ownHere('ad_o', oauth({ expiresAt: Date.now() + 20_000 }))
    token.state.fail = true
    grants.start()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(token.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(token.fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(token.fetch).toHaveBeenCalledTimes(3)
    token.state.fail = false
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(token.fetch).toHaveBeenCalledTimes(4)
    expect(stored('ad_o')?.oauth?.accessToken).toBe('AT1')
  })

  it('a refusal stops it and marks the view until the grant is saved again; a removal stops it too', async () => {
    vi.useFakeTimers()
    const { grants, token, sync } = host({ rows: [rowOf('ad_o', oauthSpec), rowOf('ad_p', oauthSpec)] })
    ownHere('ad_o', oauth({ expiresAt: Date.now() + 20_000 }))
    ownHere('ad_p', oauth({ expiresAt: Date.now() + 40_000 }))
    token.state.status = 400
    grants.start()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(token.fetch).toHaveBeenCalledTimes(1)
    expect(grants.view('ad_o')?.oauth?.refused).toBe(true)
    await sync.deleteProfile(ADDON_SERVICE, 'ad_p')
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(token.fetch).toHaveBeenCalledTimes(1)
    // A sign-in again (a save) lifts the mark and schedules again.
    token.state.status = 200
    ownHere('ad_o', oauth({ accessToken: 'NEW', expiresAt: Date.now() + 20_000 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(grants.view('ad_o')?.oauth?.refused).toBe(false)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(token.fetch).toHaveBeenCalledTimes(2)
  })

  it('refreshes even when its timer fires a moment early by the wall clock', async () => {
    vi.useFakeTimers()
    const { grants, token } = host({ rows: [rowOf('ad_o', oauthSpec)] })
    ownHere('ad_o', oauth({ expiresAt: Date.now() + 20_000 }))
    grants.start()
    // The wall clock runs 5 ms behind the timers: the keeper wakes with a hair more than its lead left.
    vi.setSystemTime(Date.now() - 5)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(token.fetch).toHaveBeenCalledTimes(1)
    expect(stored('ad_o')?.oauth?.accessToken).toBe('AT1')
  })

  it("a grant handed here and claimed is refreshed on the owner's timing, not the copy's", async () => {
    vi.useFakeTimers()
    const askOwner = vi.fn(async () => null)
    const { grants, token } = host({ rows: [rowOf('ad_o', oauthSpec)], askOwner })
    // Landed provisionally: the row still names the sender.
    copyOf('ad_o', 'env_mac', oauth({ expiresAt: Date.now() + 20_000 }))
    grants.start()
    // The sender's release: this host refreshes it now, with no save.
    vault.upsertProfile(ADDON_SERVICE, { ...vault.profiles(ADDON_SERVICE)[0], owner: 'env_box' })
    grants.onClaimed('ad_o')
    await vi.advanceTimersByTimeAsync(15_100)
    expect(token.fetch).toHaveBeenCalledTimes(1)
    expect(askOwner).not.toHaveBeenCalled()
  })

  it('a save reschedules to the new expiry', async () => {
    vi.useFakeTimers()
    const { grants, token } = host({ rows: [rowOf('ad_o', oauthSpec)] })
    ownHere('ad_o', oauth({ expiresAt: Date.now() + 20_000 }))
    grants.start()
    ownHere('ad_o', oauth({ expiresAt: Date.now() + 60 * MIN }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(token.fetch).not.toHaveBeenCalled()
  })
})

describe('AddonGrants: writes on one host', () => {
  it("the four writer rules: this host's own refreshed grant here, another refresher there, else the scope's home, else here", () => {
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_a', oauthSpec, 'ws1'), rowOf('ad_b', oauthSpec, 'ws1'), rowOf('ad_c', keySpec, 'ws1'), rowOf('ad_d', keySpec, 'ws2')], scopeHome: (ws) => (ws === 'ws1' ? 'env_box' : null) })
    ownHere('ad_a')
    copyOf('ad_b', 'env_box')
    coreAccounts.saveAddonGrant({ addonId: 'ad_c', nickname: 'c', blob: blobOf('ad_c', { 'X-Api-Key': 'v' }) })
    expect(grants.writerOf('ad_a')).toBeNull()
    expect(grants.writerOf('ad_b')).toBe('env_box')
    expect(grants.writerOf('ad_c')).toBe('env_box')
    expect(grants.writerOf('ad_d')).toBeNull()
  })

  it("the Mac's own grant before its handoff is written here, not forwarded", async () => {
    const box = fakeLink()
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_a', oauthSpec, 'ws1')], scopeHome: () => 'env_box', links: { env_box: box } })
    ownHere('ad_a')
    await grants.setFields('ad_a', { 'X-Team': 'design' })
    expect(box.request).not.toHaveBeenCalled()
    expect(stored('ad_a')?.fields).toEqual({ 'X-Team': 'design' })
  })

  it("forwards to the writer's link and answers its view; refuses when it is offline, and names the Mac when there is no link to it", async () => {
    const box = fakeLink()
    const view: AddonGrantView = { addonId: 'ad_k', fields: [{ name: 'X-Api-Key', set: true }], oauth: null, signIn: null, gaps: [] }
    box.request.mockImplementation(async () => ({ grant: view }))
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_k', keySpec, 'ws1')], scopeHome: () => 'env_box', links: { env_box: box } })
    expect(await grants.setFields('ad_k', { 'X-Api-Key': 'v1' })).toEqual(view)
    expect(box.request).toHaveBeenCalledWith('addons.grant.setFields', { id: 'ad_k', fields: { 'X-Api-Key': 'v1' } })
    expect(stored('ad_k')).toBeNull()
    box.request.mockResolvedValueOnce({ cleared: true })
    expect(await grants.clear('ad_k')).toBe(true)
    box.connected = false
    await expect(grants.setFields('ad_k', { 'X-Api-Key': 'v2' })).rejects.toThrow(GRANT_OFFLINE('k', 'box'))

    // The box, with a grant the Mac still refreshes (a handoff not yet settled).
    const onBox = host({ env: 'env_box', rows: [rowOf('ad_o', oauthSpec)] })
    copyOf('ad_o', 'env_mac', oauth())
    await expect(onBox.grants.setFields('ad_o', { 'X-Team': 'x' })).rejects.toThrow(GRANT_ON_MAC('o'))
  })

  it('a write that waited out a handoff goes to the new owner, and leaves this vault alone', async () => {
    const box = fakeLink()
    box.request.mockImplementation(async (method: string) => (method === 'addons.grant.clear' ? { cleared: true } : { grant: { addonId: 'ad_a' } }))
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_a', oauthSpec, 'ws1')], scopeHome: () => 'env_box', links: { env_box: box } })
    ownHere('ad_a', oauth(), { 'X-Team': 'old' })
    // A handoff holds the profile lock; it commits while the write waits.
    const release = await acquire(ADDON_SERVICE, 'ad_a')
    const writing = grants.setFields('ad_a', { 'X-Team': 'new' })
    const clearing = grants.clear('ad_a')
    vault.upsertProfile(ADDON_SERVICE, { ...vault.profiles(ADDON_SERVICE)[0], owner: 'env_box' })
    vault.saveSecret(ADDON_SERVICE, 'ad_a', blobOf('ad_a', { 'X-Team': 'old' }, oauth({ refreshToken: undefined })), 'sync')
    release()
    await writing
    expect(await clearing).toBe(true)
    expect(box.request.mock.calls.map((c) => c[0])).toEqual(['addons.grant.setFields', 'addons.grant.clear'])
    expect(stored('ad_a')?.fields).toEqual({ 'X-Team': 'old' })
  })

  it('setFields checks names, clears on null or empty, probes only a whole grant that gains a value, keeps the oauth section', async () => {
    const { grants, probe } = host({ rows: [rowOf('ad_k', twoKeySpec), rowOf('ad_o', oauthSpec)] })
    await expect(grants.setFields('ad_k', { Other: 'x' })).rejects.toThrow(GRANT_NO_FIELD('k', 'Other'))
    // Not whole yet: saved with no probe.
    await grants.setFields('ad_k', { 'X-Api-Key': 'k1' })
    expect(probe).not.toHaveBeenCalled()
    expect(stored('ad_k')?.fields).toEqual({ 'X-Api-Key': 'k1' })
    // Whole: probed, and a refusal saves nothing.
    probe.mockResolvedValueOnce('refused')
    await expect(grants.setFields('ad_k', { 'X-Team': 't1' })).rejects.toThrow(GRANT_PROBE_REFUSED)
    expect(stored('ad_k')?.fields).toEqual({ 'X-Api-Key': 'k1' })
    await grants.setFields('ad_k', { 'X-Team': 't1' })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenLastCalledWith(twoKeySpec, { 'X-Api-Key': 'k1', 'X-Team': 't1' })
    // A clear needs no probe.
    await grants.setFields('ad_k', { 'X-Team': '' })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(stored('ad_k')?.fields).toEqual({ 'X-Api-Key': 'k1' })
    // The last value cleared removes the profile with a tombstone.
    await grants.setFields('ad_k', { 'X-Api-Key': null })
    expect(vault.profiles(ADDON_SERVICE).map((p) => p.name)).toEqual([])
    // An OAuth grant keeps its sign-in, and is never probed.
    ownHere('ad_o', oauth(), {})
    await grants.setFields('ad_o', { 'X-Team': 'design' })
    expect(stored('ad_o')).toMatchObject({ fields: { 'X-Team': 'design' }, oauth: { accessToken: 'AT0', refreshToken: 'RT0' } })
    expect(probe).toHaveBeenCalledTimes(2)
    // Clearing that value keeps the profile: its sign-in stands.
    await grants.setFields('ad_o', { 'X-Team': null })
    expect(stored('ad_o')).toMatchObject({ fields: {}, oauth: { accessToken: 'AT0' } })
  })

  it("a clear forwarded to the box, or the owner's removal arriving, cancels a sign-in in flight here", async () => {
    const aborts: string[] = []
    const signIn: AddonSignIn = {
      run: (input, signal, hooks) =>
        new Promise((_, reject) => {
          hooks.step({ step: 'waiting', port: 50_004 })
          signal.addEventListener('abort', () => {
            aborts.push(input.addon.id)
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
    }
    const box = fakeLink()
    box.request.mockResolvedValue({ cleared: true })
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_a', oauthSpec, 'ws1'), rowOf('ad_b', oauthSpec, 'ws1')], scopeHome: () => 'env_box', links: { env_box: box }, signIn })
    copyOf('ad_a', 'env_box')
    copyOf('ad_b', 'env_box')
    await grants.startSignIn('ad_a')
    expect(await grants.clear('ad_a')).toBe(true)
    expect(box.request).toHaveBeenCalledWith('addons.grant.clear', { id: 'ad_a' })
    await grants.startSignIn('ad_b')
    grants.onRemoved('ad_b')
    expect(aborts).toEqual(['ad_a', 'ad_b'])
  })

  it('clear on the owner leaves a tombstone and cancels a sign-in in flight', async () => {
    let aborted = false
    const signIn: AddonSignIn = {
      run: (_i, signal, hooks) =>
        new Promise((_, reject) => {
          hooks.step({ step: 'waiting', port: 50_001 })
          signal.addEventListener('abort', () => {
            aborted = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
    }
    const { grants, sync } = host({ rows: [rowOf('ad_o', oauthSpec)], signIn })
    ownHere('ad_o')
    await grants.startSignIn('ad_o')
    expect(await grants.clear('ad_o')).toBe(true)
    expect(aborted).toBe(true)
    expect(stored('ad_o')).toBeNull()
    expect(sync.tombstones().map((t) => t.accountId)).toEqual(['ad_o'])
    expect(await grants.clear('ad_o')).toBe(false)
  })
})

describe('AddonGrants: the sweep', () => {
  it("on the scope's home, a values grant and an owned one leave with a tombstone, a copy alone", async () => {
    const { grants, store, sync } = host({ rows: [rowOf('ad_k', keySpec), rowOf('ad_o', oauthSpec), rowOf('ad_c', oauthSpec)] })
    coreAccounts.saveAddonGrant({ addonId: 'ad_k', nickname: 'k', blob: blobOf('ad_k', { 'X-Api-Key': 'v' }) })
    ownHere('ad_o')
    copyOf('ad_c', 'env_mac')
    grants.start()
    for (const id of ['ad_k', 'ad_o', 'ad_c']) store.remove(id)
    expect(await grants.sweep()).toBe(3)
    expect(vault.profiles(ADDON_SERVICE)).toEqual([])
    expect(sync.tombstones().map((t) => t.accountId).sort()).toEqual(['ad_k', 'ad_o'])
  })

  it("off the home every grant leaves this vault alone: the Mac's own grant whose row the box removed, and a linked workspace the Mac dropped", async () => {
    const { grants, store, sync } = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec, 'ws1'), rowOf('ad_k', keySpec, 'ws1'), rowOf('ad_c', oauthSpec, 'ws1')], scopeHome: (ws) => (ws === 'ws1' ? 'env_box' : null) })
    ownHere('ad_o')
    coreAccounts.saveAddonGrant({ addonId: 'ad_k', nickname: 'k', blob: blobOf('ad_k', { 'X-Api-Key': 'v' }) })
    copyOf('ad_c', 'env_box')
    grants.start()
    for (const id of ['ad_o', 'ad_k', 'ad_c']) store.remove(id)
    expect(await grants.sweep()).toBe(3)
    expect(vault.profiles(ADDON_SERVICE)).toEqual([])
    expect(sync.tombstones()).toEqual([])
    // Nothing sends it back: the row is gone, so it has no home.
    expect(grants.homeOf('ad_o')).toBeNull()
  })

  it('a row that arrives with no grant here asks its home again; one with a grant, or of this host, does not', () => {
    const resync = vi.fn()
    const { grants, store } = host({ env: 'env_mac', rows: [], scopeHome: (ws) => (ws === 'ws1' ? 'env_box' : null), resync })
    grants.start()
    coreAccounts.saveAddonGrant({ addonId: 'ad_held', nickname: 'held', blob: blobOf('ad_held', { 'X-Api-Key': 'v' }) })
    store.add(rowOf('ad_held', keySpec, 'ws1'))
    store.add(rowOf('ad_local', keySpec, 'ws_mac'))
    expect(resync).not.toHaveBeenCalled()
    store.add(rowOf('ad_new', keySpec, 'ws1'))
    expect(resync).toHaveBeenCalledWith('env_box')
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it("a Mac-only workspace's grant leaves with a tombstone when its row goes", async () => {
    const { grants, store, sync, grantsChanged } = host({ env: 'env_mac', rows: [rowOf('ad_m', keySpec, 'ws_mac')], scopeHome: () => null })
    coreAccounts.saveAddonGrant({ addonId: 'ad_m', nickname: 'm', blob: blobOf('ad_m', { 'X-Api-Key': 'v' }) })
    grants.start()
    store.remove('ad_m')
    grants.onAddonRemoved('ad_m')
    await vi.waitFor(() => expect(vault.profiles(ADDON_SERVICE)).toEqual([]))
    expect(sync.tombstones().map((t) => t.accountId)).toEqual(['ad_m'])
    expect(grantsChanged).toHaveBeenCalledWith('ad_m')
  })
})

describe('AddonGrants: under the lock', () => {
  it('a refresh racing a clear leaves no secret file; one racing setFields keeps the new values', async () => {
    const { grants, token } = host({ rows: [rowOf('ad_o', oauthSpec), rowOf('ad_p', oauthSpec)] })
    ownHere('ad_o', oauth({ expiresAt: Date.now() - 1 }), { 'X-Team': 'old' })
    let clearing: Promise<boolean> | null = null
    token.state.during = () => {
      clearing = grants.clear('ad_o')
    }
    await grants.refresh('ad_o')
    await clearing
    expect(stored('ad_o')).toBeNull()
    expect(secretFiles()).toEqual([])

    ownHere('ad_p', oauth({ expiresAt: Date.now() - 1 }), { 'X-Team': 'old' })
    let writing: Promise<AddonGrantView> | null = null
    token.state.during = () => {
      writing = grants.setFields('ad_p', { 'X-Team': 'new' })
    }
    expect(await grants.forceRefresh('ad_p')).toBe(true)
    await writing
    const after = stored('ad_p')!
    expect(after.fields).toEqual({ 'X-Team': 'new' })
    expect(after.oauth?.accessToken).toMatch(/^AT\d/)
  })
})

describe('AddonGrants: the view and its push', () => {
  it('holds no value, and pushes once per burst', async () => {
    const { grants } = host({ rows: [rowOf('ad_k', keySpec), rowOf('ad_o', oauthSpec), rowOf('ad_none', { ...keySpec, auth: 'none' })] })
    const pushes: AddonGrantView[][] = []
    grants.onChange((g) => pushes.push(g))
    grants.start()
    await grants.setFields('ad_k', { 'X-Api-Key': 'SENTINEL-KEY-VALUE' })
    ownHere('ad_o', oauth({ accessToken: 'SENTINEL-AT', refreshToken: 'SENTINEL-RT', clientSecret: 'SENTINEL-CS' }), { 'X-Team': 'SENTINEL-TEAM' })
    await new Promise((r) => setTimeout(r, 60))
    expect(pushes).toHaveLength(1)
    const json = JSON.stringify(grantRpc(grants) && grants.list())
    expect(json).not.toContain('SENTINEL')
    expect(JSON.stringify(pushes)).not.toContain('SENTINEL')
    expect(grants.list().map((v) => v.addonId)).toEqual(['ad_k', 'ad_o'])
    expect(grants.view('ad_k')).toEqual({ addonId: 'ad_k', fields: [{ name: 'X-Api-Key', set: true }], oauth: null, signIn: null, gaps: [] })
    expect(grants.view('ad_o')).toMatchObject({ fields: [{ name: 'X-Team', set: true }], oauth: { signedIn: true, refreshedBy: null, refused: false }, gaps: [] })
  })

  it("pushes each sign-in step at once, so a fast sign-in still shows every step", async () => {
    let hooks!: SignInHooks
    let finish!: (o: AddonOAuth) => void
    const signIn: AddonSignIn = {
      run: (_i, _s, h) => {
        hooks = h
        return new Promise((r) => (finish = r))
      }
    }
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec)], signIn })
    const states: (string | null)[] = []
    grants.onChange((g) => states.push(g.find((v) => v.addonId === 'ad_o')?.signIn?.state ?? null))
    const started = grants.startSignIn('ad_o')
    hooks.step({ step: 'discovering' })
    hooks.step({ step: 'registering' })
    hooks.step({ step: 'waiting', port: 50_003 })
    await started
    hooks.step({ step: 'exchanging' })
    finish(oauth({ redirectPort: 50_003 }))
    await vi.waitFor(() => expect(states.at(-1)).toBeNull())
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual(['discovering', 'registering', 'waiting', 'exchanging', null])
  })

  it('names the host that refreshes a copy', () => {
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec)] })
    copyOf('ad_o', 'env_box')
    expect(grants.view('ad_o')?.oauth).toMatchObject({ signedIn: true, refreshedBy: 'box' })
  })

  it('grantRpc answers the six methods, and no value of a setFields reaches the console', async () => {
    const { grants } = host({ rows: [rowOf('ad_k', keySpec)] })
    const rpc = grantRpc(grants)
    expect(await rpc.handle('addons.grant.setFields', { id: 'ad_k', fields: { 'X-Api-Key': 'SENTINEL-RPC' } })).toMatchObject({ grant: { addonId: 'ad_k' } })
    expect(await rpc.handle('addons.grant.list', undefined)).toMatchObject({ grants: [{ addonId: 'ad_k' }] })
    expect(await rpc.handle('addons.grant.refresh', { id: 'ad_k' })).toEqual({ refreshed: false })
    expect(await rpc.handle('addons.grant.cancel', { id: 'ad_k' })).toEqual({ cancelled: false })
    await expect(rpc.handle('addons.grant.signIn', { id: 'ad_k' })).rejects.toThrow(SIGNIN_NEEDS_BROWSER)
    expect(await rpc.handle('addons.grant.clear', { id: 'ad_k' })).toEqual({ cleared: true })
    expect(consoleLines.join('\n')).not.toContain('SENTINEL')
  })
})

describe('AddonGrants: the sign-in', () => {
  /** A sign-in the test drives: it waits on `consent` and then answers. */
  function drivenSignIn() {
    const calls: { input: SignInInput; hooks: SignInHooks; signal: AbortSignal }[] = []
    let finish!: (o: AddonOAuth) => void
    let fail!: (e: Error) => void
    const signIn: AddonSignIn = {
      run: (input, signal, hooks) => {
        calls.push({ input, hooks, signal })
        hooks.step({ step: 'discovering' })
        return new Promise<AddonOAuth>((resolve, reject) => {
          finish = resolve
          fail = reject
          void hooks.registered(oauth({ accessToken: undefined, refreshToken: undefined, expiresAt: undefined, redirectPort: 50_002 }))
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }).then((o) => {
          hooks.step({ step: 'exchanging' })
          return o
        })
      }
    }
    return { signIn, calls, finish: (o: AddonOAuth) => finish(o), fail: (e: Error) => fail(e) }
  }

  it('refuses without a browser, starts once, refuses a second start, and a values save during consent is kept by the sign-in', async () => {
    const bare = host({ rows: [rowOf('ad_o', oauthSpec)] }).grants
    await expect(bare.startSignIn('ad_o')).rejects.toThrow(SIGNIN_NEEDS_BROWSER)
    bare.close()
    const driven = drivenSignIn()
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec)], signIn: driven.signIn })
    expect(await grants.startSignIn('ad_o')).toEqual({ started: true, port: 50_002 })
    await expect(grants.startSignIn('ad_o')).rejects.toThrow(SIGNIN_BUSY('o'))
    // The registered client is on file, with no token.
    await vi.waitFor(() => expect(stored('ad_o')?.oauth?.clientId).toBe('cl_1'))
    expect(stored('ad_o')?.oauth?.accessToken).toBeUndefined()
    expect(grants.view('ad_o')?.signIn).toMatchObject({ state: 'discovering' })
    await grants.setFields('ad_o', { 'X-Team': 'during' })
    driven.finish(oauth({ accessToken: 'SIGNED', refreshToken: 'RTS', redirectPort: 50_002 }))
    await vi.waitFor(() => expect(stored('ad_o')?.oauth?.accessToken).toBe('SIGNED'))
    expect(stored('ad_o')?.fields).toEqual({ 'X-Team': 'during' })
    expect(vault.profiles(ADDON_SERVICE)[0].owner).toBeUndefined()
    await vi.waitFor(() => expect(grants.view('ad_o')?.signIn).toBeNull())
  })

  it('a run cancelled after its exchange saves nothing; a failed run shows its words until the next start', async () => {
    const driven = drivenSignIn()
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec)], signIn: driven.signIn })
    await grants.startSignIn('ad_o')
    await vi.waitFor(() => expect(stored('ad_o')?.oauth?.clientId).toBe('cl_1'))
    expect(grants.cancelSignIn('ad_o')).toBe(true)
    driven.finish(oauth({ accessToken: 'LATE' }))
    await flush()
    expect(stored('ad_o')?.oauth?.accessToken).toBeUndefined()
    expect(grants.view('ad_o')?.signIn).toBeNull()

    await grants.startSignIn('ad_o')
    driven.fail(new SignInError('auth.example.com refused the exchange (HTTP 400)'))
    await vi.waitFor(() => expect(grants.view('ad_o')?.signIn).toMatchObject({ state: 'failed', error: 'auth.example.com refused the exchange (HTTP 400)' }))
    // A run that fails before it binds rejects the start with its words.
    const early: AddonSignIn = { run: async () => Promise.reject(new SignInError('mcp.example.com answered without a sign-in; set its auth to none')) }
    const other = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec)], signIn: early })
    await expect(other.grants.startSignIn('ad_o')).rejects.toThrow('answered without a sign-in')
  })

  it('tells the run when another host refreshes the stored grant', async () => {
    const driven = drivenSignIn()
    const { grants } = host({ env: 'env_mac', rows: [rowOf('ad_o', oauthSpec)], signIn: driven.signIn })
    copyOf('ad_o', 'env_box')
    await grants.startSignIn('ad_o')
    expect(driven.calls[0].input).toMatchObject({ refreshedElsewhere: true, prior: { oauth: { clientId: 'cl_1' } } })
    grants.cancelSignIn('ad_o')
  })
})
