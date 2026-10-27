import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HeadroomStore,
  OVERLOADED_MS,
  RATE_WINDOW_MS,
  THROTTLE_DEFAULT_MS,
  mergeViews,
  parseGoDuration,
  parseLimitHeaders,
  parseRetryAfter,
  throttleUntil,
  type HostObservation
} from './headroom'

const NOW = 1_800_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()
const headers = (h: Record<string, string>): Pick<Headers, 'get'> => new Headers(h)

const anthropic = (remaining: number, limit = 50, resetMs = NOW + 30_000) =>
  headers({
    'anthropic-ratelimit-requests-limit': String(limit),
    'anthropic-ratelimit-requests-remaining': String(remaining),
    'anthropic-ratelimit-requests-reset': iso(resetMs),
    'anthropic-ratelimit-tokens-limit': '40000',
    'anthropic-ratelimit-tokens-remaining': '36000',
    'anthropic-ratelimit-tokens-reset': iso(NOW + 20_000),
    'anthropic-ratelimit-unified-status': 'allowed'
  })

describe('header parsing', () => {
  it('reads Anthropic per-request limits with RFC 3339 resets and the unified status', () => {
    const parsed = parseLimitHeaders(anthropic(5), NOW)
    expect(parsed.requests).toEqual({ limit: 50, remaining: 5, resetsAt: NOW + 30_000 })
    expect(parsed.tokens).toEqual({ limit: 40000, remaining: 36000, resetsAt: NOW + 20_000 })
    expect(parsed.inputTokens).toBeUndefined()
    expect(parsed.tier).toBe('allowed')
  })
  it('reads OpenAI limits with Go durations', () => {
    const parsed = parseLimitHeaders(
      headers({
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-remaining-requests': '499',
        'x-ratelimit-reset-requests': '6m0s',
        'x-ratelimit-limit-tokens': '30000',
        'x-ratelimit-remaining-tokens': '29000',
        'x-ratelimit-reset-tokens': '1.5s'
      }),
      NOW
    )
    expect(parsed.requests).toEqual({ limit: 500, remaining: 499, resetsAt: NOW + 360_000 })
    expect(parsed.tokens).toEqual({ limit: 30000, remaining: 29000, resetsAt: NOW + 1500 })
  })
  it('an answer without limit headers parses to nothing', () => {
    expect(parseLimitHeaders(headers({ 'content-type': 'application/json' }), NOW)).toEqual({})
  })
  it('durations and retry-after', () => {
    expect(parseGoDuration('1h2m3s')).toBe(3_723_000)
    expect(parseGoDuration('20ms')).toBe(20)
    expect(parseGoDuration('soon')).toBeUndefined()
    expect(parseRetryAfter('30', NOW)).toBe(NOW + 30_000)
    expect(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW)).toBe(NOW + 5000)
    expect(parseRetryAfter(null, NOW)).toBeUndefined()
  })
  it('a 429 lifts at retry-after, else the exhausted field\'s reset, else the unified reset, else a default; 529 pauses briefly', () => {
    expect(throttleUntil(429, headers({ 'retry-after': '12' }), {}, NOW)).toBe(NOW + 12_000)
    expect(throttleUntil(429, headers({}), { requests: { limit: 50, remaining: 0, resetsAt: NOW + 7000 } }, NOW)).toBe(NOW + 7000)
    expect(throttleUntil(429, headers({ 'anthropic-ratelimit-unified-reset': iso(NOW + 90_000) }), {}, NOW)).toBe(NOW + 90_000)
    expect(throttleUntil(429, headers({}), {}, NOW)).toBe(NOW + THROTTLE_DEFAULT_MS)
    expect(throttleUntil(529, headers({}), {}, NOW)).toBe(NOW + OVERLOADED_MS)
  })
})

describe('HeadroomStore', () => {
  let clock = NOW
  const store = (environmentId = 'env_a', extra: Partial<ConstructorParameters<typeof HeadroomStore>[0]> = {}) =>
    new HeadroomStore({ environmentId, now: () => clock, ...extra })

  it('an answer records the account\'s limits, the rate and nothing throttled', () => {
    clock = NOW
    const s = store()
    s.observe({ service: 'claude-code', account: 'a', model: 'claude-opus-5-5', status: 200, headers: anthropic(10) })
    clock = NOW + 1000
    s.observe({ service: 'claude-code', account: 'a', model: 'claude-opus-5-5', status: 200, headers: anthropic(9) })
    const v = s.view('claude-code', 'a')
    expect(v.room).toBeCloseTo(9 / 50)
    expect(v.resetsAt).toBe(NOW + 30_000)
    expect(v.ratePerMin).toBe(2)
    expect(v.throttledUntil).toBeUndefined()
    expect(v.tier).toBe('allowed')
    expect(v.seenAt).toBe(NOW + 1000)
    expect(s.view('claude-code', 'never')).toEqual({ room: null, ratePerMin: 0, seenAt: null })
  })

  it('the rate counts only the last minute', () => {
    clock = NOW
    const s = store()
    for (let i = 0; i < 5; i++) s.observe({ service: 'claude-code', account: 'a', model: null, status: 200, headers: headers({}) })
    clock = NOW + RATE_WINDOW_MS + 1
    s.observe({ service: 'claude-code', account: 'a', model: null, status: 200, headers: headers({}) })
    expect(s.view('claude-code', 'a').ratePerMin).toBe(1)
  })

  it('a 429 throttles the account until its reset and tells the host; a lifted throttle is gone', () => {
    clock = NOW
    const events: string[] = []
    const s = store('env_a', { onThrottle: (service, account, e) => events.push(`${service} ${account} ${e.status} ${e.until}`) })
    s.observe({ service: 'claude-code', account: 'a', model: 'claude-opus-5-5', status: 429, headers: headers({ 'retry-after': '45' }) })
    expect(events).toEqual([`claude-code a 429 ${NOW + 45_000}`])
    expect(s.throttled('claude-code', ['a', 'b'])).toEqual(['a'])
    expect(s.view('claude-code', 'a').throttledUntil).toBe(NOW + 45_000)
    clock = NOW + 45_001
    expect(s.throttled('claude-code', ['a', 'b'])).toEqual([])
  })

  it('a Fable 429 leaves Opus pickable on the same account; unknown models use the account-wide cooldown', () => {
    clock = NOW
    const s = store()
    const b = store('env_b')
    b.observe({ service: 'claude-code', account: 'a', model: 'claude-fable-5-1', status: 429, headers: headers({ 'retry-after': '45' }) })
    s.merge('env_b', b.own())
    expect(s.view('claude-code', 'a', NOW, 'claude-fable-5-1').throttledUntil).toBe(NOW + 45_000)
    expect(s.throttled('claude-code', ['a'], NOW, 'claude-opus-5-5')).toEqual([])
    expect(s.summary('claude-code', ['a'], NOW, 'claude-opus-5-5').a.throttledUntil).toBeUndefined()
    expect(s.view('claude-code', 'a').throttledUntil).toBe(NOW + 45_000)
    // An answer whose model is unknown pauses all models on the account.
    s.observe({ service: 'claude-code', account: 'a', model: null, status: 529, headers: headers({}) })
    expect(s.view('claude-code', 'a', NOW, 'claude-opus-5-5').throttledUntil).toBe(NOW + OVERLOADED_MS)
    expect(s.view('claude-code', 'a', NOW + OVERLOADED_MS, 'claude-opus-5-5').throttledUntil).toBeUndefined()
    expect(s.view('claude-code', 'a', NOW + OVERLOADED_MS, 'claude-fable-5-1').throttledUntil).toBe(NOW + 45_000)
  })

  it('an overloaded answer pauses the account briefly', () => {
    clock = NOW
    const s = store()
    s.observe({ service: 'claude-code', account: 'a', model: null, status: 529, headers: headers({}) })
    expect(s.view('claude-code', 'a').throttledUntil).toBe(NOW + OVERLOADED_MS)
  })

  it('a field whose reset passed counts as refilled', () => {
    clock = NOW
    const s = store()
    s.observe({ service: 'claude-code', account: 'a', model: null, status: 200, headers: anthropic(0, 50, NOW + 10_000) })
    expect(s.view('claude-code', 'a').room).toBe(0)
    clock = NOW + 10_001
    // The requests field refilled; the tokens field (reset NOW + 20 s) still binds.
    expect(s.view('claude-code', 'a').room).toBeCloseTo(0.9)
    clock = NOW + 20_001
    expect(s.view('claude-code', 'a').room).toBeNull()
  })

  it('merges another host\'s own observations and never its copy of ours', () => {
    clock = NOW
    const a = store('env_a')
    const b = store('env_b')
    a.observe({ service: 'claude-code', account: 'x', model: null, status: 200, headers: anthropic(40) })
    b.observe({ service: 'claude-code', account: 'x', model: null, status: 200, headers: headers({}) })
    b.observe({ service: 'claude-code', account: 'x', model: null, status: 429, headers: headers({ 'retry-after': '20' }) })
    expect(a.merge('env_b', b.own())).toBe(true)
    const v = a.view('claude-code', 'x')
    expect(v.room).toBeCloseTo(0.8)
    expect(v.ratePerMin).toBe(3)
    expect(v.throttledUntil).toBe(NOW + 20_000)
    // b's picture now carries a's entry too; pushed back, a keeps its own as the authority.
    expect(b.merge('env_a', a.own())).toBe(true)
    const stale = b.snapshot()
    stale.hosts.env_a = { 'claude-code:x': { seenAt: NOW + 5, recent: [NOW + 5], throttles: [], requests: { limit: 50, remaining: 0 } } }
    expect(a.merge('env_b', stale)).toBe(false)
    expect(a.view('claude-code', 'x').room).toBeCloseTo(0.8)
    // An older picture of b than a holds changes nothing.
    expect(a.merge('env_b', b.own())).toBe(false)
    expect(a.merge('env_a', a.own())).toBe(false)
  })

  it('the cross-host picture is the newest field, the summed rate and the furthest throttle', () => {
    const older: HostObservation = { seenAt: NOW - 5000, recent: [NOW - 5000], throttles: [{ at: NOW - 5000, status: 429, until: NOW + 8000, model: null }], requests: { limit: 50, remaining: 1, resetsAt: NOW + 9000 } }
    const newer: HostObservation = { seenAt: NOW, recent: [NOW, NOW - 1], throttles: [{ at: NOW, status: 529, until: NOW + 3000, model: null }], requests: { limit: 50, remaining: 25, resetsAt: NOW + 9000 }, tier: 'allowed_warning' }
    const v = mergeViews([older, newer], NOW)
    expect(v).toEqual({ room: 0.5, resetsAt: NOW + 9000, ratePerMin: 3, throttledUntil: NOW + 8000, tier: 'allowed_warning', seenAt: NOW })
  })

  describe('persisted snapshot', () => {
    const dirs: string[] = []
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    })
    it('survives a relaunch, trimmed of what time made worthless', () => {
      clock = NOW
      const dir = mkdtempSync(join(tmpdir(), 'tc-headroom-'))
      dirs.push(dir)
      const file = join(dir, 'headroom.json')
      const s = store('env_a', { file })
      s.observe({ service: 'claude-code', account: 'a', model: null, status: 429, headers: headers({ 'retry-after': '600' }) })
      s.observe({ service: 'codex', account: 'c', model: null, status: 200, headers: headers({ 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '3', 'x-ratelimit-reset-requests': '10m' }) })
      s.merge('env_b', { version: 1, hosts: { env_b: { 'claude-code:a': { seenAt: NOW - 1000, recent: [NOW - 1000], throttles: [] } } } })
      s.flush()
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
      clock = NOW + 2 * RATE_WINDOW_MS
      const again = store('env_a', { file })
      const a = again.view('claude-code', 'a')
      expect(a.throttledUntil).toBe(NOW + 600_000)
      expect(a.ratePerMin).toBe(0)
      expect(again.view('codex', 'c').room).toBeCloseTo(0.3)
      expect(again.snapshot().hosts.env_b).toBeDefined()
      // A day later nothing of it is believed.
      clock = NOW + 25 * 3_600_000
      expect(store('env_a', { file }).view('codex', 'c').seenAt).toBeNull()
    })
    it('a broken or foreign file is ignored', () => {
      const dir = mkdtempSync(join(tmpdir(), 'tc-headroom-'))
      dirs.push(dir)
      const file = join(dir, 'headroom.json')
      require('node:fs').writeFileSync(file, '{"version":99}')
      expect(store('env_a', { file }).snapshot()).toEqual({ version: 1, hosts: {} })
      require('node:fs').writeFileSync(file, 'nope')
      expect(store('env_a', { file }).snapshot()).toEqual({ version: 1, hosts: {} })
    })
  })
})
