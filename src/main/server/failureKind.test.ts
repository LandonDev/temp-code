import { describe, expect, it } from 'vitest'
import { FailureKindSchema } from '@shared/events'
import { fallbackFailure } from '@shared/failureFallback'
import { UpstreamTimeout } from './upstream'
import { classifyFailure, describeFailure, failureKindOf, networkRefusalOf, refusalCodeOf, type FailureContext } from './failureKind'

const ctx = (over: Partial<FailureContext> = {}): FailureContext => ({
  message: '',
  provider: 'claude',
  model: 'claude-fable-5-1',
  account: 'landon@example.com',
  accountKnown: true,
  modelVisible: true,
  ...over
})

describe('failureKindOf on captured messages', () => {
  it('the Mac threads of 2026-10-20: the CLI could not refresh the OAuth session', () => {
    // Every This Mac thread failed with this line from the Claude CLI.
    const message = 'Failed to authenticate: OAuth session expired and could not be refreshed'
    expect(failureKindOf(ctx({ message }))).toBe('oauth_expired')
    const failure = classifyFailure(ctx({ message }))
    expect(failure.summary).toBe('Anthropic session for landon@example.com expired and could not be refreshed')
    expect(failure.cause).toMatch(/signing in again/)
    expect(failure.account).toBe('landon@example.com')
  })

  it('the box thread of 2026-10-20: the account it was routed to had been cancelled', () => {
    // The gateway had nothing to route under and the host wrote its one row;
    // the vault no longer lists the account, which explains the 401 outright.
    const message = 'Aliax account work@example.com needs sign-in'
    const failure = classifyFailure(ctx({ message, account: 'work@example.com', accountKnown: false }))
    expect(failure.kind).toBe('account_unknown')
    expect(failure.summary).toBe('Account work@example.com is no longer on file')
    // The same words with the account still on file read as a lapsed sign-in.
    expect(failureKindOf(ctx({ message, account: 'work@example.com' }))).toBe('oauth_expired')
  })

  it("codex's own 401 wording and the CLI's /login prompts are a lapsed sign-in", () => {
    for (const message of [
      'workspace routing discovery unauthorized (401)',
      'OAuth token has expired. Please obtain a new token or refresh your existing token.',
      'Invalid API key · Please run /login',
      'OAuth token revoked · Please run /login',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth authentication is currently not supported."}}'
    ]) {
      expect(failureKindOf(ctx({ message })), message).toBe('oauth_expired')
    }
  })

  it("a non-owner instance's 401 token_expired from the gateway is its own kind", () => {
    const refused = ctx({
      message: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"token expired"}}',
      gateway: { status: 401, code: 'token_expired', account: 'landon@example.com' }
    })
    expect(failureKindOf(refused)).toBe('token_expired')
    expect(classifyFailure(refused).summary).toBe('The token for landon@example.com expired on this instance')
    expect(failureKindOf(ctx({ message: 'upstream answered 401 (token_expired)' }))).toBe('token_expired')
    // A plain 401 the gateway saw, with no code, is still a dead sign-in.
    expect(failureKindOf(ctx({ message: 'request failed', gateway: { status: 401, code: null, account: null } }))).toBe('oauth_expired')
  })

  it("the drivers' limit classifier wins: windows are rate limits, credits are quota", () => {
    expect(failureKindOf(ctx({ message: "You've hit your session limit · resets 6:20am (America/Chicago)", limit: { window: '5h' } }))).toBe('rate_limited')
    expect(failureKindOf(ctx({ message: "You've hit your weekly limit · resets Tue 9am", limit: { window: 'weekly' } }))).toBe('rate_limited')
    expect(failureKindOf(ctx({ message: "You've reached your Fable limit. Switch to another model…", limit: { window: { model: 'Fable' } } }))).toBe('rate_limited')
    expect(failureKindOf(ctx({ message: "You're out of usage credits.", limit: { window: 'credits' } }))).toBe('quota')
    expect(failureKindOf(ctx({ provider: 'codex', message: "You're out of credits. Add credits to continue using Codex.", limit: { window: 'credits' } }))).toBe('quota')
    expect(failureKindOf(ctx({ provider: 'codex', message: "You've hit your usage limit. Upgrade to Pro (…)", limit: { window: '5h' } }))).toBe('rate_limited')
  })

  it('limit wording without the classifier, and a 429 from the gateway', () => {
    expect(failureKindOf(ctx({ message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}' }))).toBe('rate_limited')
    expect(failureKindOf(ctx({ message: 'Request failed', gateway: { status: 429, code: 'rate_limit_error', account: null } }))).toBe('rate_limited')
    expect(failureKindOf(ctx({ provider: 'codex', message: 'The server had an error: insufficient_quota' }))).toBe('quota')
    expect(failureKindOf(ctx({ message: 'Your credit balance is too low to access the Anthropic API.' }))).toBe('quota')
  })

  it('a model the host hides or the provider refuses', () => {
    expect(failureKindOf(ctx({ message: 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-9 not found"}}' }))).toBe('model_unavailable')
    expect(failureKindOf(ctx({ provider: 'codex', model: 'gpt-6.1-sol', message: 'codex error', modelVisible: false }))).toBe('model_unavailable')
    const failure = classifyFailure(ctx({ provider: 'codex', model: 'gpt-6.1-sol', message: 'codex error', modelVisible: false }))
    expect(failure.summary).toBe('gpt-6.1-sol is not available on this host')
    expect(failure.cause).toMatch(/0\.162\.1/)
  })

  it('the provider out of reach', () => {
    for (const message of [
      'fetch failed',
      'Connection error.',
      'connect ECONNREFUSED 127.0.0.1:8787',
      'stream disconnected before completion: error sending request',
      'getaddrinfo ENOTFOUND api.anthropic.com'
    ]) {
      expect(failureKindOf(ctx({ message })), message).toBe('network')
    }
    expect(classifyFailure(ctx({ message: 'fetch failed' })).summary).toBe('Could not reach Anthropic')
    expect(failureKindOf(ctx({ message: 'bad gateway', gateway: { status: 502, code: null, account: null } }))).toBe('network')
  })

  it('a credential deadline is network with the gateway summary, from text or its refusal code', () => {
    for (const context of [
      ctx({ message: 'API Error: 503 credential_timeout' }),
      ctx({ message: 'request failed', gateway: { status: 503, code: 'credential_timeout', account: null } })
    ]) {
      expect(classifyFailure(context)).toMatchObject({ kind: 'network', summary: 'The gateway could not get a credential in time' })
    }
    expect(refusalCodeOf('{"error":{"type":"credential_timeout"}}')).toBe('credential_timeout')
    expect(refusalCodeOf('API Error: credential_timeout')).toBe('credential_timeout')
  })

  it.each([
    ['headers', 60_000, 'No answer from the provider in 60 s'],
    ['body', 120_000, 'The provider stopped sending data for 120 s'],
    ['total', 600_000, 'The provider request took longer than 600 s']
  ] as const)('an upstream %s deadline remains network after its error crosses as text', (stage, ms, summary) => {
    const error = new UpstreamTimeout(stage, ms)
    expect(classifyFailure(ctx({ message: `Aliax could not reach codex: ${error.message}`, provider: 'codex' }))).toMatchObject({ kind: 'network', summary })
  })

  it('a Codex RPC deadline is a network failure', () => {
    expect(failureKindOf(ctx({ provider: 'codex', message: 'codex app-server turn/start timed out after 60000 ms' }))).toBe('network')
  })

  it('the harness process gone', () => {
    for (const message of [
      'harness stream ended mid-turn',
      'codex app-server exited unexpectedly (137)',
      'the harness never reported the turn done — recovered',
      'spawn claude ENOENT'
    ]) {
      expect(failureKindOf(ctx({ message })), message).toBe('harness_crashed')
    }
    expect(classifyFailure(ctx({ provider: 'codex', message: 'codex app-server exited unexpectedly (137)' })).summary).toBe('The Codex process died mid-turn')
  })

  it("a turn the CLI ended itself is turn_ended, after the deaths and the network, with the CLI's line as the cause", () => {
    expect(FailureKindSchema.options).toContain('turn_ended')
    expect(failureKindOf(ctx({ message: 'turn ended: error_during_execution' }))).toBe('turn_ended')
    expect(failureKindOf(ctx({ message: 'turn ended: error_max_turns' }))).toBe('turn_ended')
    // A real death or a network cut keeps its own kind.
    expect(failureKindOf(ctx({ message: 'turn ended: error_during_execution: process exited with code 1' }))).toBe('harness_crashed')
    expect(failureKindOf(ctx({ message: 'turn ended: error_during_execution: fetch failed' }))).toBe('network')
    expect(classifyFailure(ctx({ message: 'turn ended: error_during_execution: Invalid tool input: missing field' }))).toMatchObject({
      kind: 'turn_ended',
      account: 'landon@example.com',
      summary: 'The turn ended before it finished',
      cause: 'Invalid tool input: missing field'
    })
    expect(classifyFailure(ctx({ message: 'turn ended: error_during_execution' })).cause).toBe('Claude Code reported error_during_execution and gave no reason.')
    expect(classifyFailure(ctx({ message: 'turn ended: error_max_turns' })).cause).toBe("The CLI's turn limit was reached.")
    expect(classifyFailure(ctx({ message: 'turn ended: error_max_budget_usd' })).cause).toBe("The CLI's spend limit was reached.")
    expect(classifyFailure(ctx({ message: 'turn ended: error_max_structured_output_retries' })).cause).toBe('The CLI gave up on a structured answer.')
    expect(classifyFailure(ctx({ provider: 'codex', message: 'turn ended: error_during_execution' })).cause).toBe('Codex reported error_during_execution and gave no reason.')
  })

  it("an unknown with no reason reads as the renderer's fallback, word for word", () => {
    const failure = classifyFailure(ctx({ message: '   ' }))
    expect(failure.kind).toBe('unknown')
    expect({ summary: failure.summary, cause: failure.cause }).toEqual({ summary: fallbackFailure().summary, cause: fallbackFailure().cause })
  })

  it('anything else is unknown and keeps the words on the second line', () => {
    const failure = classifyFailure(ctx({ message: 'declined unhandled harness request: item/foo' }))
    expect(failure.kind).toBe('unknown')
    expect(failure.summary).toBe('The turn failed')
    expect(failure.cause).toBe('declined unhandled harness request: item/foo')
    const long = classifyFailure(ctx({ message: 'x'.repeat(400) })).cause
    expect(long.length).toBe(160)
    expect(long.endsWith('…')).toBe(true)
  })

  it('a missing account changes the wording, never the kind', () => {
    const none = describeFailure('oauth_expired', ctx({ account: null, message: 'Failed to authenticate: OAuth session expired and could not be refreshed' }))
    expect(none.summary).toBe('The Anthropic session expired and could not be refreshed')
    const codex = describeFailure('oauth_expired', ctx({ provider: 'codex', account: 'me@example.com' }))
    expect(codex.summary).toBe('ChatGPT sign-in for me@example.com expired and could not be refreshed')
    const limited = describeFailure('rate_limited', ctx({ account: null, limit: { window: 'weekly' } }))
    expect(limited.summary).toBe('Anthropic answered with a weekly limit')
  })

  it('says not signed in when no account exists and the CLI was never signed in', () => {
    const message = 'Not logged in · Please run /login'
    const claude = classifyFailure(ctx({ account: null, message }))
    expect(claude).toMatchObject({ kind: 'oauth_expired', summary: 'Not signed in to Claude', cause: 'No account on this host is signed in.' })
    const codex = classifyFailure(ctx({ provider: 'codex', account: null, message }))
    expect(codex).toMatchObject({ kind: 'oauth_expired', summary: 'Not signed in to ChatGPT' })
    const lapsed = describeFailure('oauth_expired', ctx({ account: 'me@example.com', message }))
    expect(lapsed.summary).toBe('Anthropic session for me@example.com expired and could not be refreshed')
  })
})

describe('refusalCodeOf', () => {
  it("reads the upstream body's code and never keeps the body", () => {
    expect(refusalCodeOf('{"type":"error","error":{"type":"authentication_error","message":"x"}}')).toBe('authentication_error')
    expect(refusalCodeOf('{"error":{"code":"token_expired","message":"token expired"}}')).toBe('token_expired')
    expect(refusalCodeOf('{"error":"token_expired"}')).toBe('token_expired')
    expect(refusalCodeOf('<html>token_expired</html>')).toBe('token_expired')
    expect(refusalCodeOf('<html>nothing</html>')).toBeNull()
    expect(refusalCodeOf(undefined)).toBeNull()
  })
})


describe('networkRefusalOf', () => {
  const info = { service: 'codex', path: '/codex/~t=thread%201;a=acct/responses', account: 'acct', error: 'Upstream headers timed out after 60000 ms' }
  it('reads the scoped thread and keeps only the timeout stage and deadline for the registry', () => {
    const result = networkRefusalOf(info)
    expect(result).toEqual({ thread: 'thread 1', refusal: { status: 502, account: 'acct', code: null, timeout: { stage: 'headers', timeoutMs: 60_000 } } })
    expect(classifyFailure(ctx({ message: 'stream ended', gateway: result!.refusal }))).toMatchObject({ kind: 'network', summary: 'No answer from the provider in 60 s' })
    expect(networkRefusalOf({ ...info, error: 'credential_timeout: host did not reply' })?.refusal.code).toBe('credential_timeout')
    expect(networkRefusalOf({ ...info, error: 'fetch failed' })?.refusal).toEqual({ status: 502, account: 'acct', code: null })
    expect(networkRefusalOf({ ...info, path: '/codex/responses' })).toBeNull()
  })
})
