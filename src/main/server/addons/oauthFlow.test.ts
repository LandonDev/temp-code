import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { AddonGrantBlobSchema, addonRedirectUri, type AddonGrantBlob } from '@shared/addonGrant'
import {
  SIGNIN_DENIED,
  SIGNIN_NO_ADDRESS,
  SIGNIN_NO_PKCE,
  SIGNIN_NO_REFRESH,
  SIGNIN_NO_REGISTRATION,
  SIGNIN_NOT_NEEDED,
  SIGNIN_PORT_TAKEN,
  SIGNIN_SERVER,
  SIGNIN_TIMEOUT
} from '@shared/addonGrantWords'
import type { AddonSpec } from '@shared/contract-addons'
import { startFakeOAuthServer, type FakeOAuth } from '../../../../scripts/lib/fakeOAuthServer'
import { fakeProviderRewrite } from '../upstream'
import { deniedLine, oauthFlow, scopeFor, SignInError, type AddonOAuth, type SignInHooks, type SignInStep } from './oauthFlow'

const FIXTURES = join(__dirname, 'fixtures', 'mobbin')

// The app's fetch as §6 passes it: the fake-provider rewrite works on strings (url.replace), so a URL from the SDK must arrive as one.
const rewrite = fakeProviderRewrite('http://127.0.0.1:9')
const appFetch = vi.fn((input: string, init?: RequestInit) => fetch(rewrite(input), init))
/** The e2e's browser: follow the authorize redirect to the loopback callback. */
const follow = vi.fn(async (url: string) => {
  const res = await fetch(url, { redirect: 'manual' })
  const location = res.headers.get('location')
  if (location) await fetch(location)
})

let fake: FakeOAuth
let consoleLines: string[] = []
beforeEach(async () => {
  fake = await startFakeOAuthServer()
  consoleLines = []
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void consoleLines.push(args.map(String).join(' ')))
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  appFetch.mockClear()
  follow.mockClear()
  await fake.close()
})

const httpSpec = (url = fake.mcpUrl): AddonSpec => ({ transport: 'http', url, headers: [], auth: 'oauth' })
const addon = (spec: AddonSpec = httpSpec()) => ({ id: 'ad_fake0000001', name: 'fakeoauth', spec })
function recorder() {
  const steps: SignInStep[] = []
  const registered: AddonOAuth[] = []
  const hooks: SignInHooks = {
    step: (s) => void steps.push(s),
    registered: async (o) => {
      // The browser has not been sent anywhere yet when the client is saved.
      expect(follow).not.toHaveBeenCalled()
      registered.push(o)
    }
  }
  return { steps, registered, hooks }
}
const flow = (extra: Partial<Parameters<typeof oauthFlow>[0]> = {}) => oauthFlow({ fetch: appFetch, open: follow, trace: (l) => console.log(l), ...extra })
const signal = (): AbortSignal => new AbortController().signal
const asBlob = (oauth: AddonOAuth): AddonGrantBlob => ({ v: 1, mintedBy: 'app', addonId: 'ad_fake0000001', fields: {}, oauth })

/** No secret the fake issued or saw appears in any console line. */
const noSecretLogged = (): void => {
  const all = consoleLines.join('\n')
  for (const secret of fake.issued()) expect(all.includes(secret), 'a secret reached the console').toBe(false)
}

describe('the add-on sign-in against the fake server', () => {
  it('discovers from the 401, registers a client on a fixed loopback redirect, signs in with PKCE and the resource, and hands back a whole oauth section', async () => {
    const { steps, registered, hooks } = recorder()
    const oauth = await flow().run({ addon: addon(), prior: null }, signal(), hooks)
    expect(steps.map((s) => s.step)).toEqual(['discovering', 'registering', 'waiting', 'exchanging'])
    // Every URL reached the app's fetch as a string.
    for (const call of appFetch.mock.calls) expect(typeof call[0]).toBe('string')
    const register = fake.events.filter((e) => e.kind === 'register')
    expect(register).toHaveLength(1)
    expect(register[0]).toMatchObject({ redirectUris: [addonRedirectUri(oauth.redirectPort)] })
    expect((steps.find((s) => s.step === 'waiting') as { port: number }).port).toBe(oauth.redirectPort)
    const authorize = fake.events.find((e) => e.kind === 'authorize')
    expect(authorize).toMatchObject({ ok: true, redirectUri: addonRedirectUri(oauth.redirectPort), resource: fake.mcpUrl, scope: 'mcp offline_access' })
    expect(fake.events.filter((e) => e.kind === 'token')).toEqual([expect.objectContaining({ grantType: 'authorization_code', ok: true, resource: fake.mcpUrl })])
    expect(AddonGrantBlobSchema.parse(asBlob(oauth)).oauth).toEqual(oauth)
    expect(oauth).toMatchObject({
      clientId: register[0].kind === 'register' ? register[0].clientId : '',
      issuer: fake.issuer,
      authorizationUrl: `${fake.issuer}/authorize`,
      tokenUrl: `${fake.issuer}/token`,
      resource: fake.mcpUrl,
      scope: 'mcp offline_access',
      accessToken: fake.accessTokens()[0],
      refreshToken: expect.stringMatching(/^rt_/)
    })
    expect(oauth.expiresAt).toBeGreaterThan(Date.now() + 3_500_000)
    // The client was saved before the browser opened, with no token.
    expect(registered).toHaveLength(1)
    expect(registered[0]).not.toHaveProperty('accessToken')
    expect(registered[0]).toMatchObject({ clientId: oauth.clientId, redirectPort: oauth.redirectPort, issuer: fake.issuer })
    noSecretLogged()
  })

  it('a denied consent says so; a second sign-in reuses that client and port with no new registration', async () => {
    const first = recorder()
    fake.deny({ error: 'access_denied', description: 'The person declined' })
    const err = await flow()
      .run({ addon: addon(), prior: null }, signal(), first.hooks)
      .catch((e: Error) => e)
    expect(err).toBeInstanceOf(SignInError)
    expect((err as Error).message).toBe(SIGNIN_DENIED('access_denied', 'The person declined'))
    const prior = asBlob(first.registered[0])
    const second = recorder()
    const oauth = await flow().run({ addon: addon(), prior }, signal(), second.hooks)
    expect(second.steps.map((s) => s.step)).toEqual(['discovering', 'waiting', 'exchanging'])
    expect(second.registered).toEqual([])
    expect(fake.events.filter((e) => e.kind === 'register')).toHaveLength(1)
    expect(oauth).toMatchObject({ clientId: prior.oauth!.clientId, redirectPort: prior.oauth!.redirectPort })
    expect(fake.events.filter((e) => e.kind === 'authorize').map((e) => (e.kind === 'authorize' ? e.redirectUri : ''))).toEqual([
      addonRedirectUri(prior.oauth!.redirectPort),
      addonRedirectUri(prior.oauth!.redirectPort)
    ])
    noSecretLogged()
  })

  it('a port in use refuses naming it, and registers nothing', async () => {
    const first = recorder()
    fake.deny({ error: 'access_denied' })
    await flow().run({ addon: addon(), prior: null }, signal(), first.hooks).catch(() => {})
    const port = first.registered[0].redirectPort
    const holder = createServer()
    await new Promise<void>((r) => holder.listen(port, '127.0.0.1', r))
    try {
      await expect(flow().run({ addon: addon(), prior: asBlob(first.registered[0]) }, signal(), recorder().hooks)).rejects.toThrow(SIGNIN_PORT_TAKEN(port))
      expect(fake.events.filter((e) => e.kind === 'register')).toHaveLength(1)
    } finally {
      holder.close()
    }
  })

  it('refuses a server without S256, one that lets no app register, one that needs no sign-in, and a stdio add-on', async () => {
    const host = new URL(fake.issuer).host
    fake.set({ s256: false })
    await expect(flow().run({ addon: addon(), prior: null }, signal(), recorder().hooks)).rejects.toThrow(SIGNIN_NO_PKCE(host))
    fake.set({ s256: true, registration: false })
    await expect(flow().run({ addon: addon(), prior: null }, signal(), recorder().hooks)).rejects.toThrow(SIGNIN_NO_REGISTRATION(host))
    fake.set({ registration: true, challenge: false })
    await expect(flow().run({ addon: addon(), prior: null }, signal(), recorder().hooks)).rejects.toThrow(SIGNIN_NOT_NEEDED('fakeoauth'))
    const stdio: AddonSpec = { transport: 'stdio', command: 'npx', args: [], env: ['TOKEN'], tokenEnv: 'TOKEN', auth: 'oauth' }
    await expect(flow().run({ addon: addon(stdio), prior: null }, signal(), recorder().hooks)).rejects.toThrow(SIGNIN_NO_ADDRESS('fakeoauth'))
    expect(follow).not.toHaveBeenCalled()
  })

  it('a server that gives no refresh token: fine for a grant this host owns, refused when another host refreshes the stored one', async () => {
    fake.set({ refreshTokens: false })
    const oauth = await flow().run({ addon: addon(), prior: null }, signal(), recorder().hooks)
    expect(oauth.refreshToken).toBeUndefined()
    expect(oauth.accessToken).toBeTruthy()
    await expect(flow().run({ addon: addon(), prior: asBlob(oauth), refreshedElsewhere: true }, signal(), recorder().hooks)).rejects.toThrow(
      SIGNIN_NO_REFRESH(new URL(fake.issuer).host)
    )
  })

  it('asks for offline_access only when the server offers it', async () => {
    fake.set({ offlineAccess: false })
    await flow().run({ addon: addon(), prior: null }, signal(), recorder().hooks)
    expect(fake.events.find((e) => e.kind === 'authorize')).toMatchObject({ scope: 'mcp' })
    expect(scopeFor(undefined, ['openid'], { scopes_supported: ['openid', 'offline_access'], grant_types_supported: ['authorization_code'] })).toBe('openid')
    expect(scopeFor('mcp', ['openid'], { scopes_supported: ['offline_access'], grant_types_supported: ['refresh_token'] })).toBe('mcp offline_access')
    expect(scopeFor(undefined, undefined, {})).toBeUndefined()
  })

  it('words a refused exchange by its step and status alone, never the body that echoes the code and the verifier', async () => {
    fake.set({ exchangeError: true })
    const err = (await flow()
      .run({ addon: addon(), prior: null }, signal(), recorder().hooks)
      .catch((e: Error) => e)) as Error
    expect(err.message).toBe(SIGNIN_SERVER(new URL(fake.issuer).host, 'exchange', 400))
    for (const secret of fake.issued()) expect(err.message.includes(secret)).toBe(false)
    noSecretLogged()
  })

  it("redacts a denial's description that echoes the state, and keeps only an OAuth error code", async () => {
    fake.deny({ error: 'access_denied', description: 'denied for state {state}' })
    const err = (await flow()
      .run({ addon: addon(), prior: null }, signal(), recorder().hooks)
      .catch((e: Error) => e)) as Error
    expect(err.message).toBe(SIGNIN_DENIED('access_denied', 'denied for state …'))
    expect(deniedLine('<script>', undefined, [])).toBe(SIGNIN_DENIED('access_denied'))
    expect(deniedLine('access_denied', 'line\u0007bell', [])).toBe(SIGNIN_DENIED('access_denied'))
    expect(deniedLine('access_denied', 'x'.repeat(300), [])).toBe(SIGNIN_DENIED('access_denied', `${'x'.repeat(199)}…`))
  })

  it('times out when the browser never comes back, and a cancel stops it', async () => {
    const quiet = vi.fn(async () => {})
    await expect(flow({ open: quiet, callbackTimeoutMs: 50 }).run({ addon: addon(), prior: null }, signal(), recorder().hooks)).rejects.toThrow(SIGNIN_TIMEOUT)
    const ctl = new AbortController()
    const running = flow({ open: async () => void setTimeout(() => ctl.abort(), 10) }).run({ addon: addon(), prior: null }, ctl.signal, recorder().hooks)
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe("Mobbin's recorded answers (2026-11-08)", () => {
  it('parse as a sign-in reads them: the challenge, the resource, Supabase as issuer with S256 and registration, and the scope asked', () => {
    const header = readFileSync(join(FIXTURES, 'www-authenticate.txt'), 'utf8').trim()
    const challenge = extractWWWAuthenticateParams(new Response(null, { status: 401, headers: { 'www-authenticate': header } }))
    expect(challenge.resourceMetadataUrl?.toString()).toBe('https://api.mobbin.com/.well-known/oauth-protected-resource/mcp')
    expect(challenge.scope).toBeUndefined()
    const resource = OAuthProtectedResourceMetadataSchema.parse(JSON.parse(readFileSync(join(FIXTURES, 'protected-resource.json'), 'utf8')))
    expect(resource.authorization_servers).toEqual(['https://ujasntkfphywizsdaapi.supabase.co/auth/v1'])
    expect(checkResourceAllowed({ requestedResource: 'https://api.mobbin.com/mcp', configuredResource: resource.resource })).toBe(true)
    const metadata = OAuthMetadataSchema.parse(JSON.parse(readFileSync(join(FIXTURES, 'authorization-server.json'), 'utf8')))
    expect(metadata.issuer).toBe(resource.authorization_servers![0])
    expect(metadata.code_challenge_methods_supported).toContain('S256')
    expect(metadata.registration_endpoint).toBe('https://ujasntkfphywizsdaapi.supabase.co/auth/v1/oauth/clients/register')
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none')
    expect(scopeFor(challenge.scope, resource.scopes_supported, metadata)).toBe('openid offline_access')
  })
})
