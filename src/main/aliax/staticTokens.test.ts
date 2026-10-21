import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, vault } from 'aliax-core'
import { hasRefresh, isStaticBlob } from 'aliax-core/sync'
import type { MintedToken, RefreshMintOutcome } from 'aliax-core/mint'
import type { SessionMintInput, SessionMintResult } from './staticMint'
import { StaticTokens } from './staticTokens'

// No Keychain in tests: nothing here reads the CLI's live sign-in anyway.
vi.mock('aliax-core/keychain', () => ({
  readPassword: async () => {
    throw new Error('no keychain in tests')
  },
  writePassword: async () => {}
}))

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const YEAR_S = 31_536_000
let dataDir = ''
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tc-static-tokens-'))
  configure({
    dataDir,
    fetch: async (url) => {
      throw new Error(`unexpected fetch ${url}`)
    },
    secrets: { mode: 'fileKey', path: join(dataDir, 'vault.key') },
    environmentId: 'env_mac'
  })
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const session = [{ name: 'sessionKey', value: 'sk-ant-sid01-one', domain: '.claude.ai', path: '/', secure: true, httpOnly: true }]
const grantBlob = (access = 'A1', refresh: string | null = 'R1', cookies: typeof session | null = session): string =>
  JSON.stringify({
    keychain: JSON.stringify({ claudeAiOauth: { accessToken: access, ...(refresh ? { refreshToken: refresh } : {}), expiresAt: NOW + 3_600_000, scopes: ['org:create_api_key', 'user:profile', 'user:inference'] } }),
    oauthAccount: { accountUuid: 'u1', emailAddress: 'one@x.test' },
    appSession: cookies
  })
const staticBlob = (expiresAt: number, cookies: typeof session | null = session): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OLD', expiresAt, scopes: ['user:profile', 'user:inference'] } }), oauthAccount: { accountUuid: 'u1', emailAddress: 'one@x.test' }, appSession: cookies, tokenKind: 'static' })
const seed = (name: string, blob: string, row: Partial<Parameters<typeof vault.upsertProfile>[1]> = {}): void => {
  vault.upsertProfile('claude-code', { name, accountId: row.accountId ?? 'u1', email: row.email ?? 'one@x.test', createdAt: NOW, ...row })
  vault.saveSecret('claude-code', name, blob)
}
const tokensOf = (name: string): Record<string, unknown> => JSON.parse(JSON.parse(vault.readSecret('claude-code', name)!).keychain).claudeAiOauth
const minted = (over: Partial<MintedToken> = {}): MintedToken => ({
  accessToken: 'sk-ant-oat01-new',
  refreshToken: null,
  expiresAt: NOW + YEAR_S * 1000,
  expiresInS: YEAR_S,
  scopes: ['user:profile', 'user:inference'],
  account: { uuid: 'u1', email: 'one@x.test' },
  organization: { uuid: 'org1', name: 'One' },
  ...over
})
const code = (cookies = session): SessionMintResult => ({ kind: 'code', code: 'c', state: 's', verifier: 'v', redirectUri: 'r', scopes: ['user:profile', 'user:inference'], cookies })

function make(over: Partial<ConstructorParameters<typeof StaticTokens>[0]> = {}) {
  const windows: SessionMintInput[] = []
  const deps = {
    mintInWindow: vi.fn(async (input: SessionMintInput): Promise<SessionMintResult> => {
      windows.push(input)
      return code()
    }),
    nudge: vi.fn(),
    changed: vi.fn(),
    syncAll: vi.fn(async () => {}),
    // The owner host is out of reach unless a test says otherwise.
    takeBack: vi.fn(async (): Promise<string | null> => 'env_box, which refreshes the grant, is not connected'),
    log: vi.fn(),
    now: () => NOW,
    exchange: vi.fn(async () => minted()),
    mintFromRefresh: vi.fn(async () => ({ ok: false as const, reason: 'endpoint' as const, detail: 'offline' })),
    // The CLI here is signed in with another account, still in date, unless a test says otherwise.
    cliDetected: () => true,
    liveAccountId: vi.fn(async (): Promise<string | null> => 'u-elsewhere'),
    liveCredentialExpired: vi.fn(async () => false),
    installLive: vi.fn(async (_name: string, _blob: string) => {}),
    ...over
  }
  return { tokens: new StaticTokens(deps), deps, windows }
}

describe('StaticTokens.convert', () => {
  it('takes the refresh route first when this host holds the grant, and the row state clears on success', async () => {
    seed('one', grantBlob())
    const { tokens, deps } = make({
      mintFromRefresh: vi.fn(async () => ({ ok: true as const, name: 'one', minted: { expiresAt: NOW + YEAR_S * 1000, scopes: ['user:profile', 'user:inference'], account: { uuid: 'u1', email: 'one@x.test' } } }))
    })
    const out = await tokens.convert('one')
    expect(out).toMatchObject({ ok: true, name: 'one' })
    expect(deps.mintFromRefresh).toHaveBeenCalledWith('one', expect.anything())
    expect(deps.mintInWindow).not.toHaveBeenCalled()
    expect(deps.syncAll).toHaveBeenCalledTimes(1)
    expect(tokens.progress()).toBeNull()
  })

  it('falls back to the stored claude.ai session in a hidden window, files the token and drops the grant', async () => {
    seed('one', grantBlob())
    const { tokens, deps, windows } = make()
    const out = await tokens.convert('one')
    expect(out.ok).toBe(true)
    expect(windows).toEqual([{ cookies: session, scopes: ['user:profile', 'user:inference'], visible: false }])
    expect(deps.exchange).toHaveBeenCalledWith(expect.objectContaining({ code: 'c', verifier: 'v' }), expect.anything())
    const blob = vault.readSecret('claude-code', 'one')!
    expect(isStaticBlob(blob)).toBe(true)
    expect(hasRefresh('claude-code', blob)).toBe(false)
    expect(tokensOf('one')).toEqual({ accessToken: 'sk-ant-oat01-new', expiresAt: NOW + YEAR_S * 1000, scopes: ['user:profile', 'user:inference'] })
    expect(JSON.parse(blob).appSession).toEqual(session)
    expect(vault.profiles('claude-code')[0]).toMatchObject({ name: 'one', static: true })
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('trying the stored claude.ai session'))
  })

  it('a lapsed session opens the in-app sign-in with the address pre-filled and the stored cookies when the user asked, and keeps the fresher cookies', async () => {
    seed('one', grantBlob())
    const fresh = [{ ...session[0], value: 'sk-ant-sid01-fresh' }]
    const { tokens, windows } = make({
      mintInWindow: vi.fn(async (input: SessionMintInput): Promise<SessionMintResult> => {
        windows.push(input)
        return input.visible ? code(fresh) : { kind: 'needs-sign-in', detail: 'the stored claude.ai session has lapsed' }
      })
    })
    expect((await tokens.convert('one', true)).ok).toBe(true)
    // The visible window carries the stored cookies too: a session that only failed to approve in time needs the click, not a sign-in.
    expect(windows.map((w) => [w.visible, w.loginHint, w.cookies])).toEqual([[false, undefined, session], [true, 'one@x.test', session]])
    expect(JSON.parse(vault.readSecret('claude-code', 'one')!).appSession).toEqual(fresh)
  })

  it('a renewal nobody asked for says needs-sign-in and the row carries it; a user who closes the window cancels', async () => {
    seed('one', staticBlob(NOW + 10 * DAY), { static: true })
    const { tokens, windows } = make({
      mintInWindow: vi.fn(async (input: SessionMintInput): Promise<SessionMintResult> => {
        windows.push(input)
        return input.visible ? { kind: 'closed' } : { kind: 'needs-sign-in', detail: 'the stored claude.ai session has lapsed' }
      })
    })
    expect(await tokens.convert('one', false)).toEqual({ ok: false, error: 'the stored claude.ai session has lapsed' })
    expect(tokens.progress()).toEqual({ rows: { one: { state: 'needs-sign-in', at: NOW, detail: 'the stored claude.ai session has lapsed' } }, run: null })
    expect(tokensOf('one').accessToken).toBe('OLD')
    expect(await tokens.convert('one', true)).toEqual({ ok: false, error: 'sign-in cancelled' })
    expect(tokens.progress()).toBeNull()
  })

  it('a token for another account is refused by name and nothing is filed', async () => {
    seed('one', grantBlob())
    const { tokens } = make({ exchange: vi.fn(async () => minted({ account: { uuid: 'u9', email: 'nine@x.test' } })) })
    expect(await tokens.convert('one')).toEqual({ ok: false, error: 'the token belongs to nine@x.test, not one@x.test' })
    expect(isStaticBlob(vault.readSecret('claude-code', 'one')!)).toBe(false)
    expect(tokensOf('one').refreshToken).toBe('R1')
    expect(tokens.progress()?.rows.one).toMatchObject({ state: 'failed' })
  })

  it('a short life with user:profile asks the same session for user:inference alone', async () => {
    seed('one', grantBlob())
    const exchange = vi.fn().mockResolvedValueOnce(minted({ expiresAt: NOW + 8 * 3_600_000, expiresInS: 8 * 3600 })).mockResolvedValueOnce(minted({ scopes: ['user:inference'] }))
    const { tokens, windows } = make({ exchange })
    expect((await tokens.convert('one')).ok).toBe(true)
    expect(windows.map((w) => w.scopes)).toEqual([['user:profile', 'user:inference'], ['user:inference']])
    expect(tokensOf('one').scopes).toEqual(['user:inference'])
  })

  it('a response that names no account is filed only when the session says it is this account', async () => {
    seed('one', grantBlob())
    const unnamed = vi.fn(async () => minted({ account: null }))
    const other = make({ exchange: unnamed, sessionEmail: async () => 'nine@x.test' })
    expect(await other.tokens.convert('one')).toEqual({ ok: false, error: 'the session belongs to nine@x.test, not one@x.test' })
    const same = make({ exchange: unnamed, sessionEmail: async () => 'One@X.test' })
    expect((await same.tokens.convert('one')).ok).toBe(true)
    expect(vault.profiles('claude-code')[0]).toMatchObject({ accountId: 'u1', email: 'one@x.test', static: true })
  })

  it('a grant another host refreshes is taken back over the peer link first, then minted from here', async () => {
    seed('one', grantBlob('A1', null), { owner: 'env_box' })
    const { tokens, deps } = make({
      takeBack: vi.fn(async (name: string): Promise<string | null> => {
        // What AccountSync.takeOver leaves once the owner confirmed: the grant on file, owned here.
        vault.saveSecret('claude-code', name, grantBlob('A1', 'R1'), 'sync')
        vault.upsertProfile('claude-code', { ...vault.profiles('claude-code').find((p) => p.name === name)!, owner: 'env_mac' })
        return null
      }),
      mintFromRefresh: vi.fn(async () => ({ ok: true as const, name: 'one', minted: { expiresAt: NOW + YEAR_S * 1000, scopes: ['user:profile', 'user:inference'], account: { uuid: 'u1', email: 'one@x.test' } } }))
    })
    expect(await tokens.convert('one')).toMatchObject({ ok: true, name: 'one' })
    expect(deps.takeBack).toHaveBeenCalledWith('one', 'env_box')
    expect(deps.mintFromRefresh).toHaveBeenCalledWith('one', expect.anything())
    expect(deps.mintInWindow).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith('one: took the grant back; minting from it')
  })

  it('an owner out of reach leaves the stored session to mint; when that fails too the row names the host and what to do here', async () => {
    seed('one', grantBlob('A1', null), { owner: 'env_box' })
    const reached = make()
    expect((await reached.tokens.convert('one')).ok).toBe(true)
    expect(reached.deps.mintFromRefresh).not.toHaveBeenCalled()
    expect(reached.windows).toEqual([{ cookies: session, scopes: ['user:profile', 'user:inference'], visible: false }])
    expect(vault.profiles('claude-code')[0]).toMatchObject({ name: 'one', static: true })
    expect(reached.deps.log).toHaveBeenCalledWith('one: env_box, which refreshes the grant, is not connected; trying the stored claude.ai session')
    // No session either, and nobody asked: the row says to sign in here, and why.
    seed('two', grantBlob('A2', null, null), { accountId: 'u2', email: 'two@x.test', owner: 'env_box' })
    const quiet = make()
    expect(await quiet.tokens.convert('two', false)).toEqual({ ok: false, error: 'env_box, which refreshes the grant, is not connected; no claude.ai session is stored for this account' })
    expect(quiet.tokens.progress()?.rows.two).toEqual({ state: 'needs-sign-in', at: NOW, detail: 'env_box, which refreshes the grant, is not connected; no claude.ai session is stored for this account' })
    // The user signed in here, as another account: the failure names the host and the account, never the other host's UI.
    const wrong = make({ exchange: vi.fn(async () => minted({ account: { uuid: 'u9', email: 'nine@x.test' } })) })
    expect(await wrong.tokens.convert('two', true)).toEqual({ ok: false, error: 'env_box, which refreshes the grant, is not connected; the token belongs to nine@x.test, not two@x.test' })
    expect(wrong.tokens.progress()?.rows.two).toMatchObject({ state: 'failed' })
    expect(wrong.windows.map((w) => [w.visible, w.loginHint])).toEqual([[true, 'two@x.test']])
    expect(vault.profiles('claude-code').find((p) => p.name === 'two')).toMatchObject({ owner: 'env_box' })
  })

  it('a refresh-route identity mismatch stops the attempt', async () => {
    seed('two', grantBlob(), { accountId: 'u2', email: 'two@x.test' })
    const mismatch = make({ mintFromRefresh: vi.fn(async () => ({ ok: false as const, reason: 'wrong-account' as const, detail: 'the token belongs to nine@x.test, not two@x.test' })) })
    expect(await mismatch.tokens.convert('two')).toEqual({ ok: false, error: 'the token belongs to nine@x.test, not two@x.test' })
    expect(mismatch.deps.mintInWindow).not.toHaveBeenCalled()
  })
})

describe('StaticTokens.convertAll and renewals', () => {
  it('walks every account not yet static and every static one due, one at a time, with run progress in the snapshot', async () => {
    seed('a', grantBlob(), { accountId: 'ua', email: 'a@x.test' })
    seed('b', grantBlob('B1', 'RB'), { accountId: 'ub', email: 'b@x.test' })
    seed('fresh', staticBlob(NOW + 200 * DAY), { accountId: 'uf', email: 'f@x.test', static: true })
    seed('due', staticBlob(NOW + 20 * DAY), { accountId: 'ud', email: 'd@x.test', static: true })
    const runs: ({ total: number; done: number } | null)[] = []
    const { tokens } = make({
      nudge: vi.fn(() => runs.push(tokens.progress()?.run ?? null)),
      exchange: vi.fn(async () => minted({ account: null })),
      sessionEmail: async (cookies) => (cookies[0]?.value === 'sk-ant-sid01-one' ? null : null)
    })
    expect(tokens.candidates()).toEqual(['a', 'b', 'due'])
    // Identity by the response for a and b; the unnamed token for every row fails the check, so make the exchange name each.
    ;(tokens as unknown as { deps: { exchange: unknown } }).deps.exchange = vi.fn(async () => minted({ account: { uuid: 'ua', email: 'a@x.test' } }))
    const out = await tokens.convertAll(true)
    expect(out.ok).toBe(false)
    expect(out.ok ? '' : out.error).toBe('1 of 3 converted · 2 failed')
    expect(runs.filter(Boolean).map((r) => `${r!.done}/${r!.total}`)).toEqual(expect.arrayContaining(['0/3', '1/3', '2/3', '3/3']))
    expect(tokens.progress()?.run ?? null).toBeNull()
    expect(vault.profiles('claude-code').find((p) => p.name === 'a')?.static).toBe(true)
    expect(vault.profiles('claude-code').find((p) => p.name === 'b')?.static).toBeFalsy()
  })

  it('says so when every account already holds a fresh one-year token, and refuses a second run meanwhile', async () => {
    seed('fresh', staticBlob(NOW + 200 * DAY), { static: true })
    const { tokens } = make()
    expect(await tokens.convertAll()).toEqual({ ok: true, notes: ['every Claude account already holds a one-year token'] })
    seed('one', grantBlob(), { accountId: 'u2', email: 'two@x.test' })
    let release: () => void = () => {}
    const slow = make({ mintFromRefresh: vi.fn(() => new Promise<RefreshMintOutcome>((r) => (release = () => r({ ok: false, reason: 'endpoint', detail: 'slow' })))) })
    const first = slow.tokens.convert('one')
    expect(await slow.tokens.convert('one')).toEqual({ ok: false, error: 'a conversion is already running' })
    expect(await slow.tokens.convertAll()).toEqual({ ok: false, error: 'a conversion is already running' })
    release()
    await first
  })

  it('renewDue renews only static tokens inside the 30-day window, quietly, and not again within a day after a failure', async () => {
    seed('due', staticBlob(NOW + 29 * DAY), { accountId: 'ud', email: 'd@x.test', static: true })
    seed('later', staticBlob(NOW + 40 * DAY), { accountId: 'ul', email: 'l@x.test', static: true })
    seed('grant', grantBlob(), { accountId: 'ug', email: 'g@x.test' })
    let now = NOW
    const { tokens, deps, windows } = make({
      now: () => now,
      exchange: vi.fn(async () => minted({ account: { uuid: 'ud', email: 'd@x.test' }, expiresAt: now + YEAR_S * 1000 })),
      mintInWindow: vi.fn(async (input: SessionMintInput): Promise<SessionMintResult> => {
        windows.push(input)
        return windows.length === 1 ? { kind: 'needs-sign-in', detail: 'the stored claude.ai session has lapsed' } : code()
      })
    })
    await tokens.renewDue()
    expect(windows).toEqual([{ cookies: session, scopes: ['user:profile', 'user:inference'], visible: false }])
    expect(tokens.progress()?.rows.due).toMatchObject({ state: 'needs-sign-in' })
    expect(deps.log).toHaveBeenCalledWith('due: renewal needs-sign-in (the stored claude.ai session has lapsed)')
    // An hour later: nothing is tried again.
    now = NOW + 3_600_000
    await tokens.renewDue()
    expect(windows).toHaveLength(1)
    // A day later: tried again, and this time the session answers.
    now = NOW + 25 * 3_600_000
    await tokens.renewDue()
    expect(windows).toHaveLength(2)
    expect(tokensOf('due')).toMatchObject({ accessToken: 'sk-ant-oat01-new', expiresAt: now + YEAR_S * 1000 })
    expect(tokens.progress()).toBeNull()
    expect(tokensOf('later').accessToken).toBe('OLD')
    expect(tokensOf('grant').refreshToken).toBe('R1')
    expect(deps.syncAll).toHaveBeenCalledTimes(1)
  })
})

describe('StaticTokens and the live sign-in here', () => {
  // What mintStaticFromRefresh leaves: the grant rotated server-side, the static token filed and the grant dropped.
  const refreshMint = () =>
    vi.fn(async (name: string) => {
      vault.saveSecret('claude-code', name, staticBlob(NOW + YEAR_S * 1000))
      vault.upsertProfile('claude-code', { ...vault.profiles('claude-code').find((p) => p.name === name)!, static: true })
      return { ok: true as const, name, minted: { expiresAt: NOW + YEAR_S * 1000, scopes: ['user:profile', 'user:inference'], account: { uuid: 'u1', email: 'one@x.test' } } }
    })

  it('a refresh-grant conversion of the account the CLI is signed in with installs the new token as the live sign-in', async () => {
    seed('one', grantBlob())
    const installLive = vi.fn(async (_name: string, _blob: string) => {})
    const { tokens, deps } = make({ mintFromRefresh: refreshMint(), liveAccountId: vi.fn(async () => 'u1'), installLive })
    expect(await tokens.convert('one')).toMatchObject({ ok: true, name: 'one' })
    expect(installLive).toHaveBeenCalledTimes(1)
    const [name, blob] = installLive.mock.calls[0]!
    expect(name).toBe('one')
    expect(blob).toBe(vault.readSecret('claude-code', 'one'))
    expect(isStaticBlob(blob)).toBe(true)
    expect(deps.log).toHaveBeenCalledWith('one: installed as the live sign-in here')
  })

  it('a conversion of another account leaves the live sign-in alone; with nothing live at all it installs', async () => {
    seed('one', grantBlob())
    const other = make({ mintFromRefresh: refreshMint() })
    expect((await other.tokens.convert('one')).ok).toBe(true)
    expect(other.deps.installLive).not.toHaveBeenCalled()

    seed('two', grantBlob('A2', 'R2'), { accountId: 'u2', email: 'two@x.test' })
    const none = make({
      liveAccountId: vi.fn(async () => null),
      mintFromRefresh: vi.fn(async (name: string) => {
        vault.saveSecret('claude-code', name, staticBlob(NOW + YEAR_S * 1000))
        vault.upsertProfile('claude-code', { ...vault.profiles('claude-code').find((p) => p.name === name)!, static: true })
        return { ok: true as const, name, minted: { expiresAt: NOW + YEAR_S * 1000, scopes: ['user:profile'], account: { uuid: 'u2', email: 'two@x.test' } } }
      })
    })
    expect((await none.tokens.convert('two')).ok).toBe(true)
    expect(none.deps.installLive).toHaveBeenCalledWith('two', vault.readSecret('claude-code', 'two'))
  })

  it('a failure to install is logged and the conversion still succeeds', async () => {
    seed('one', grantBlob())
    const { tokens, deps } = make({
      mintFromRefresh: refreshMint(),
      liveAccountId: vi.fn(async () => 'u1'),
      installLive: vi.fn(async () => {
        throw new Error('keychain locked')
      })
    })
    expect(await tokens.convert('one')).toMatchObject({ ok: true, name: 'one' })
    expect(deps.log).toHaveBeenCalledWith('one: could not install as the live sign-in here (keychain locked)')
    expect(deps.syncAll).toHaveBeenCalledTimes(1)
  })

  it('repairLive installs the static token when the live sign-in has lapsed and its account holds one', async () => {
    seed('one', staticBlob(NOW + 200 * DAY), { static: true })
    seed('two', grantBlob('A2', 'R2'), { accountId: 'u2', email: 'two@x.test' })
    const { tokens, deps } = make({ liveCredentialExpired: vi.fn(async () => true), liveAccountId: vi.fn(async () => 'u1') })
    expect(await tokens.repairLive()).toBe(true)
    expect(deps.installLive).toHaveBeenCalledWith('one', vault.readSecret('claude-code', 'one'))
    expect(deps.log).toHaveBeenCalledWith('one: the live sign-in here had lapsed; installed its one-year token')
  })

  it('repairLive does nothing when the live account still holds a grant, when nothing lapsed, or when its static token lapsed too', async () => {
    seed('two', grantBlob('A2', 'R2'), { accountId: 'u2', email: 'two@x.test' })
    const grant = make({ liveCredentialExpired: vi.fn(async () => true), liveAccountId: vi.fn(async () => 'u2') })
    expect(await grant.tokens.repairLive()).toBe(false)
    expect(grant.deps.installLive).not.toHaveBeenCalled()

    seed('one', staticBlob(NOW + 200 * DAY), { static: true })
    const fresh = make({ liveCredentialExpired: vi.fn(async () => false), liveAccountId: vi.fn(async () => 'u1') })
    expect(await fresh.tokens.repairLive()).toBe(false)
    expect(fresh.deps.installLive).not.toHaveBeenCalled()
    expect(fresh.deps.liveAccountId).not.toHaveBeenCalled()

    seed('one', staticBlob(NOW - DAY), { static: true })
    const dead = make({ liveCredentialExpired: vi.fn(async () => true), liveAccountId: vi.fn(async () => 'u1') })
    expect(await dead.tokens.repairLive()).toBe(false)
    expect(dead.deps.installLive).not.toHaveBeenCalled()
  })
})
