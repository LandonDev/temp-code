import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeUsage,
  CodexUsage,
  parseCodexAuth,
  parseCredentials,
  tokenNeedsRefresh,
  type UsageDependencies
} from './rateLimits'

const blob = (expiresAt = 999_999_999) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt,
      subscriptionType: 'pro'
    },
    retained: true
  })
function deps(raw = blob()): UsageDependencies {
  return {
    fetch: vi.fn<typeof fetch>(),
    security: vi.fn(async () => null),
    readFile: vi.fn(async () => raw),
    writeFile: vi.fn(async () => {}),
    home: '/test-home',
    user: 'tester',
    platform: 'linux',
    now: () => 1_000_000
  }
}
describe('Claude usage', () => {
  it('parses nested/flat credentials, string expiry and rejects empty or invalid credentials', () => {
    expect(parseCredentials(blob())?.expiresAt).toBe(999_999_999)
    expect(parseCredentials('{"accessToken":" flat ","expiresAt":"42"}')?.accessToken).toBe('flat')
    expect(parseCredentials('{"accessToken":"flat","expiresAt":"42"}')?.expiresAt).toBe(42)
    for (const raw of ['no', 'null', '[]', '{"accessToken":" "}'])
      expect(parseCredentials(raw)).toBeNull()
    expect(tokenNeedsRefresh(1_300_000, 1_000_000)).toBe(true)
    expect(tokenNeedsRefresh(1_300_001, 1_000_000)).toBe(false)
    expect(tokenNeedsRefresh(null, 1_000_000)).toBe(false)
  })
  it('uses the required usage headers and returns only the DTO', async () => {
    const d = deps()
    vi.mocked(d.fetch).mockResolvedValue(
      new Response('{"five_hour":{"utilization":12}}', { status: 200 })
    )
    expect(await new ClaudeUsage(d).fetch()).toEqual({
      status: 'ok',
      httpStatus: 200,
      body: '{"five_hour":{"utilization":12}}',
      error: null
    })
    expect(d.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer access-secret',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.0'
        },
        signal: expect.any(AbortSignal),
        redirect: 'error'
      })
    )
    expect(d.writeFile).not.toHaveBeenCalled()
  })
  it('refreshes within five minutes, preserves fields and writes to the same file', async () => {
    const d = deps(blob(1_300_000))
    vi.mocked(d.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: '60',
            refresh_token_expires_in: 120
          })
        )
      )
      .mockResolvedValueOnce(new Response('{}'))
    const service = new ClaudeUsage(d)
    const [a, b] = await Promise.all([service.fetch(), service.fetch()])
    expect(a).toEqual(b)
    expect(d.fetch).toHaveBeenCalledTimes(2)
    expect(d.fetch).toHaveBeenNthCalledWith(
      1,
      'https://platform.claude.com/v1/oauth/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'refresh-secret',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
        })
      })
    )
    const [path, raw] = vi.mocked(d.writeFile).mock.calls[0]
    expect(path).toBe('/test-home/.claude/.credentials.json')
    expect(JSON.parse(raw)).toEqual({
      retained: true,
      claudeAiOauth: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 1_060_000,
        refreshTokenExpiresAt: 1_120_000,
        subscriptionType: 'pro'
      }
    })
  })
  it('retries once on 401 and never returns response errors or thrown secrets', async () => {
    const d = deps()
    vi.mocked(d.fetch)
      .mockResolvedValueOnce(new Response('access-secret', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"access_token":"new-access"}'))
      .mockResolvedValueOnce(new Response('new-access', { status: 401 }))
    expect(await new ClaudeUsage(d).fetch()).toEqual({
      status: 'error',
      httpStatus: 401,
      body: null,
      error: 'Claude sign-in expired'
    })
    expect(d.fetch).toHaveBeenCalledTimes(3)
    vi.mocked(d.fetch).mockRejectedValue(new Error('access-secret'))
    expect(JSON.stringify(await new ClaudeUsage(d).fetch())).not.toContain('access-secret')
  })
  it('finds custom keychain accounts and persists refresh to that account', async () => {
    const d = deps()
    d.platform = 'darwin'
    d.security = vi.fn(async (args) => {
      if (!args.includes('-w')) return '    "acct"<blob>="custom-user"'
      if (args.includes('custom-user')) return args[0] === 'add-generic-password' ? '' : blob(0)
      return null
    })
    vi.mocked(d.fetch)
      .mockResolvedValueOnce(new Response('{"access_token":"new-access"}'))
      .mockResolvedValueOnce(new Response('{}'))
    expect((await new ClaudeUsage(d).fetch()).status).toBe('ok')
    expect(d.readFile).not.toHaveBeenCalled()
    expect(d.security).toHaveBeenCalledWith([
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-a',
      'claude-code-user',
      '-w'
    ])
    expect(d.security).toHaveBeenCalledWith([
      'add-generic-password',
      '-U',
      '-s',
      'Claude Code-credentials',
      '-a',
      'custom-user',
      '-w',
      expect.any(String)
    ])
  })
  it('falls back to a file, reports unavailable and redacts secrets even from successful bodies', async () => {
    const d = deps()
    d.platform = 'darwin'
    vi.mocked(d.fetch).mockResolvedValue(new Response('access-secret refresh-secret'))
    expect((await new ClaudeUsage(d).fetch()).body).toBe('[redacted] [redacted]')
    expect(d.readFile).toHaveBeenCalledWith('/test-home/.claude/.credentials.json')
    expect(await new ClaudeUsage(deps('invalid')).fetch()).toEqual({
      status: 'unavailable',
      httpStatus: null,
      body: null,
      error: 'Claude not signed in'
    })
  })
})

describe('Codex usage', () => {
  const auth = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'codex-secret', account_id: 'acct-1', refresh_token: 'r' }
  })
  function codexDeps(raw: string | null = auth) {
    return {
      fetch: vi.fn<typeof fetch>(),
      readFile: vi.fn(async (path: string) => {
        if (raw === null) throw new Error(`ENOENT ${path}`)
        return raw
      }),
      home: '/test-home',
      codexHome: undefined
    }
  }
  it('is unavailable without the CLI login file or its tokens', async () => {
    for (const raw of [null, '{}', '{"tokens":{"account_id":"a"}}', 'nope']) {
      const d = codexDeps(raw)
      expect((await new CodexUsage(d).fetch()).status).toBe('unavailable')
      expect(d.fetch).not.toHaveBeenCalled()
    }
    expect(parseCodexAuth(auth)).toEqual({ accessToken: 'codex-secret', accountId: 'acct-1' })
  })
  it('reads $CODEX_HOME first, sends the account header and redacts the token', async () => {
    const d = codexDeps()
    vi.mocked(d.fetch).mockResolvedValue(
      new Response('{"rate_limit":{"primary_window":{"used_percent":5}},"t":"codex-secret"}', {
        status: 200
      })
    )
    expect(await new CodexUsage({ ...d, codexHome: '/elsewhere' }).fetch()).toEqual({
      status: 'ok',
      httpStatus: 200,
      body: '{"rate_limit":{"primary_window":{"used_percent":5}},"t":"[redacted]"}',
      error: null
    })
    expect(d.readFile).toHaveBeenCalledWith('/elsewhere/auth.json')
    expect(d.fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer codex-secret',
          'ChatGPT-Account-Id': 'acct-1',
          'User-Agent': 'codex-cli'
        },
        redirect: 'error'
      })
    )
    const home = codexDeps()
    vi.mocked(home.fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    await new CodexUsage(home).fetch()
    expect(home.readFile).toHaveBeenCalledWith('/test-home/.codex/auth.json')
  })
  it('treats an expired login as unavailable and other failures as errors', async () => {
    const d = codexDeps()
    vi.mocked(d.fetch)
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockRejectedValueOnce(new Error('offline'))
    const usage = new CodexUsage(d)
    expect((await usage.fetch()).status).toBe('unavailable')
    expect(await usage.fetch()).toMatchObject({ status: 'error', httpStatus: 500 })
    expect(await usage.fetch()).toMatchObject({ status: 'error', httpStatus: null })
  })
})
