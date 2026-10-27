import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accounts, configure, pinProfile } from 'aliax-core'
import { observeCodexSnapshot, observeHooks } from './gatewayObserve'

const H = 'anthropic-ratelimit-unified'
let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function setup(): { logDir: string; onObserved: ReturnType<typeof vi.fn> } {
  dir = mkdtempSync(join(tmpdir(), 'temp-code-observe-'))
  configure({
    dataDir: join(dir, 'aliax'),
    fetch: async () => {
      throw new Error('no network')
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' }
  })
  return { logDir: join(dir, 'logs'), onObserved: vi.fn() }
}

describe('observeHooks', () => {
  it('feeds the answering Claude account from unified headers and nudges the service', () => {
    const { logDir, onObserved } = setup()
    pinProfile('claude-code', 'pinned')
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onResponse!({
      service: 'claude',
      path: '/v1/messages',
      status: 200,
      headers: new Headers({ [`${H}-status`]: 'allowed', [`${H}-5h-utilization`]: '0.25', [`${H}-5h-reset`]: '1786147200', [`${H}-7d-utilization`]: '0.6' }),
      account: 'work',
      model: 'claude-opus-5-5'
    })
    const cache = JSON.parse(readFileSync(join(dir, 'aliax', 'usage-cache.json'), 'utf8'))
    expect(cache['claude-code:work'].report.windows).toEqual([
      { label: '5h', usedPercent: 25, periodMs: 5 * 3_600_000, resetsAt: 1786147200_000 },
      { label: 'Weekly', usedPercent: 60, periodMs: 7 * 86_400_000 }
    ])
    expect(cache['claude-code:pinned']).toBeUndefined()
    expect(onObserved).toHaveBeenCalledTimes(1)
    expect(existsSync(join(logDir, 'gateway-limits.jsonl'))).toBe(false)
  })

  it('ignores answers without windows, other services, and no account', () => {
    const { logDir, onObserved } = setup()
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onResponse!({ service: 'claude', path: '/v1/messages', status: 200, headers: new Headers({ [`${H}-5h-utilization`]: '0.25' }), account: null, model: null })
    hooks.onResponse!({ service: 'codex', path: '/v1/responses', status: 200, headers: new Headers({ [`${H}-5h-utilization`]: '0.25' }), account: 'work', model: null })
    hooks.onResponse!({ service: 'claude', path: '/v1/messages', status: 200, headers: new Headers({ 'request-id': 'r' }), account: 'work', model: null })
    expect(onObserved).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'aliax', 'usage-cache.json'))).toBe(false)
  })

  it('logs every 429 with its limit headers and body, nothing else', () => {
    const { logDir, onObserved } = setup()
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onResponse!({
      service: 'claude',
      path: '/v1/messages',
      status: 429,
      headers: new Headers({ [`${H}-status`]: 'rejected', [`${H}-reset`]: '1786147200', 'retry-after': '30', 'request-id': 'req_1', 'set-cookie': 'secret=1' }),
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"You have hit your session limit"}}',
      account: 'work',
      model: 'claude-fable-5-1'
    })
    const lines = readFileSync(join(logDir, 'gateway-limits.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      service: 'claude',
      path: '/v1/messages',
      status: 429,
      account: 'work',
      model: 'claude-fable-5-1',
      headers: { [`${H}-status`]: 'rejected', [`${H}-reset`]: '1786147200', 'retry-after': '30', 'request-id': 'req_1' }
    })
    expect(lines[0].headers['set-cookie']).toBeUndefined()
    expect(lines[0].body).toContain('session limit')
    expect(typeof lines[0].ts).toBe('number')
    expect('attempt' in lines[0]).toBe(false)
  })

  it('logs a 529 too, with the replay attempt when the answer carries one', () => {
    const { logDir, onObserved } = setup()
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onResponse!({
      service: 'claude',
      path: '/v1/messages',
      status: 529,
      headers: new Headers({ 'retry-after': '5', 'request-id': 'req_9' }),
      body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      account: 'work',
      model: 'claude-fable-5-1',
      attempt: 2
    } as Parameters<NonNullable<typeof hooks.onResponse>>[0])
    hooks.onResponse!({ service: 'claude', path: '/v1/messages', status: 500, headers: new Headers(), body: 'x', account: 'work', model: null })
    const lines = readFileSync(join(logDir, 'gateway-limits.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ status: 529, account: 'work', attempt: 2, headers: { 'retry-after': '5', 'request-id': 'req_9' } })
    expect(lines[0].body).toContain('Overloaded')
  })

  it('a fetch that got no answer is a network record: the path, the account hashed, the error', () => {
    const { logDir, onObserved } = setup()
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onNetwork!({ service: 'claude', path: '/~t=T1;a=work/v1/messages', account: 'work', error: 'fetch failed: ECONNRESET' })
    const lines = readFileSync(join(logDir, 'gateway-limits.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'network', service: 'claude', path: '/~t=T1;a=work/v1/messages', error: 'fetch failed: ECONNRESET' })
    expect(lines[0].account).toMatch(/^[0-9a-f]{6}$/)
    expect(lines[0].account).not.toBe('work')
    expect(typeof lines[0].ts).toBe('number')
  })
})

describe('observeHooks scoped window', () => {
  const answer = (model: string | null, account = 'work') => ({
    service: 'claude',
    path: '/v1/messages',
    status: 200,
    headers: new Headers({ [`${H}-status`]: 'allowed', [`${H}-5h-utilization`]: '0.1', [`${H}-7d-utilization`]: '0.2', [`${H}-7d_oi-utilization`]: '0.7', [`${H}-7d_oi-reset`]: '1786500000' }),
    account,
    model
  })
  it("a Fable answer's 7d_oi header lands as the Fable window; an Opus answer's does not add one", () => {
    const { logDir, onObserved } = setup()
    vi.useFakeTimers() // the shared cache persists at most every 5 s; flush so no real timer leaks into the next test
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onResponse!(answer('claude-fable-5-1'))
    hooks.onResponse!(answer('claude-opus-5-5', 'other'))
    vi.advanceTimersByTime(10_000)
    vi.useRealTimers()
    expect(accounts.cachedReport('claude-code', 'work')?.windows).toEqual([
      { label: '5h', usedPercent: 10, periodMs: 5 * 3_600_000 },
      { label: 'Weekly', usedPercent: 20, periodMs: 7 * 86_400_000 },
      { label: 'Fable', usedPercent: 70, periodMs: 7 * 86_400_000, resetsAt: 1786500000_000 }
    ])
    expect(accounts.cachedReport('claude-code', 'other')?.windows.map((w: { label: string }) => w.label)).toEqual(['5h', 'Weekly'])
    expect(existsSync(join(logDir, 'gateway-limits.jsonl'))).toBe(false)
  })
})

describe('observeCodexSnapshot', () => {
  it('feeds the Codex account (the pin by default) from an app-server rate-limit snapshot and nudges', () => {
    const { logDir, onObserved } = setup()
    vi.useFakeTimers() // the shared cache persists at most every 5 s
    observeHooks({ logDir, onObserved })
    observeCodexSnapshot({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1786147200 } } })
    expect(onObserved).not.toHaveBeenCalled() // no pin yet
    pinProfile('codex', 'personal')
    observeCodexSnapshot({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1786147200 },
        secondary: { usedPercent: 40, windowDurationMins: 10080 }
      }
    })
    observeCodexSnapshot({ rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } } }, 'work')
    vi.advanceTimersByTime(10_000) // past the throttle even when an earlier test just persisted
    vi.useRealTimers()
    const cache = JSON.parse(readFileSync(join(dir, 'aliax', 'usage-cache.json'), 'utf8'))
    expect(cache['codex:personal'].report.windows).toEqual([
      { label: '5h', usedPercent: 12, periodMs: 300 * 60_000, resetsAt: 1786147200_000 },
      { label: 'week', usedPercent: 40, periodMs: 10080 * 60_000 }
    ])
    expect(cache['codex:work'].report.windows).toEqual([{ label: '5h', usedPercent: 99, periodMs: 300 * 60_000 }])
    expect(onObserved).toHaveBeenCalledTimes(2)
  })
})

describe('observeHooks → headroom', () => {
  it('every answer with an account reaches the headroom store with its service id; a 429 lands as a throttle', () => {
    const { logDir } = setup()
    const seen: string[] = []
    const headroom = { observe: (i: { service: string; account: string; status: number }) => seen.push(`${i.service} ${i.account} ${i.status}`) }
    const hooks = observeHooks({ logDir, headroom })
    hooks.onResponse!({ service: 'claude', path: '/v1/messages', status: 200, headers: new Headers(), account: 'work', model: 'claude-opus-5-5' })
    hooks.onResponse!({ service: 'codex', path: '/responses', status: 429, headers: new Headers({ 'retry-after': '5' }), body: '{}', account: 'cx', model: null })
    hooks.onResponse!({ service: 'claude', path: '/v1/messages', status: 200, headers: new Headers(), account: null, model: null })
    hooks.onResponse!({ service: 'other', path: '/x', status: 200, headers: new Headers(), account: 'x', model: null })
    expect(seen).toEqual(['claude-code work 200', 'codex cx 429'])
  })
})
