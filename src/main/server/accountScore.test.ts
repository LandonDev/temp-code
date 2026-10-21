import { describe, expect, it } from 'vitest'
import type { AccountHeadroom } from '@shared/accounts'
import { RATE_FULL_PER_MIN, SPEND_FIRST_BONUS, STICKY, WEIGHTS, cacheWarmth, keepOrMove, rankAccounts, scoreAccount, stickyTolerance, windowShare } from './accountScore'

const NOW = 1_800_000_000_000
const report = (profileName: string, windows: { label: string; usedPercent: number; resetsAt?: number }[]) => ({ profileName, windows })
const seen = (room: number | null, extra: Partial<AccountHeadroom> = {}): AccountHeadroom => ({ room, ratePerMin: 0, seenAt: NOW, ...extra })

describe('scoreAccount', () => {
  it('an unknown, unloaded account with empty windows scores the full scale', () => {
    const s = scoreAccount({ serviceId: 'claude-code', model: 'claude-fable-5-1', report: undefined, headroom: undefined, threads: 0, now: NOW })
    expect(s).toEqual({ total: 1, window: 1, limit: 1, load: 1, rate: 1, spendFirst: false })
  })
  it('the window share is the least room among the model\'s own windows; a lifted window is full', () => {
    const r = report('a', [
      { label: '5h', usedPercent: 40 },
      { label: 'Weekly', usedPercent: 70 },
      { label: 'Fable', usedPercent: 95, resetsAt: NOW + 1 }
    ])
    expect(windowShare('claude-code', 'claude-fable-5-1', r, NOW)).toBeCloseTo(0.05)
    expect(windowShare('claude-code', 'claude-opus-5-5', r, NOW)).toBeCloseTo(0.3)
    expect(windowShare('claude-code', 'claude-fable-5-1', r, NOW + 2)).toBeCloseTo(0.3)
  })
  it('each term carries its weight', () => {
    const base = { serviceId: 'claude-code' as const, model: 'claude-fable-5-1', report: undefined, now: NOW }
    expect(scoreAccount({ ...base, headroom: seen(0.5), threads: 0 }).total).toBeCloseTo(1 - WEIGHTS.limit * 0.5)
    expect(scoreAccount({ ...base, headroom: undefined, threads: 3 }).total).toBeCloseTo(1 - WEIGHTS.load)
    expect(scoreAccount({ ...base, headroom: seen(null, { ratePerMin: RATE_FULL_PER_MIN / 2 }), threads: 0 }).total).toBeCloseTo(1 - WEIGHTS.rate / 2)
    expect(scoreAccount({ ...base, headroom: seen(null, { ratePerMin: 999 }), threads: 9 }).total).toBeCloseTo(1 - WEIGHTS.rate - WEIGHTS.load)
  })
  it('an Opus thread earns the spend-first bonus on a Fable-spent account; a Fable thread never does', () => {
    const spent = report('a', [{ label: 'Fable', usedPercent: 100, resetsAt: NOW + 9 }])
    const opus = scoreAccount({ serviceId: 'claude-code', model: 'claude-opus-5-5', report: spent, headroom: undefined, threads: 0, now: NOW })
    expect(opus.spendFirst).toBe(true)
    expect(opus.total).toBeCloseTo(1 + SPEND_FIRST_BONUS)
    const fable = scoreAccount({ serviceId: 'claude-code', model: 'claude-fable-5-1', report: spent, headroom: undefined, threads: 0, now: NOW })
    expect(fable.spendFirst).toBe(false)
    expect(fable.window).toBe(0)
  })
})

describe('rankAccounts', () => {
  it('orders by score, then fewer threads, then name', () => {
    const ranked = rankAccounts({
      serviceId: 'claude-code',
      model: 'claude-fable-5-1',
      names: ['c', 'b', 'a', 'thin'],
      reports: [report('thin', [{ label: '5h', usedPercent: 90 }])],
      headroom: {},
      load: { c: 1 },
      now: NOW
    })
    expect(ranked.map((r) => r.name)).toEqual(['a', 'b', 'c', 'thin'])
  })
  it('the account with the most headroom leads, whatever the thread is on', () => {
    const ranked = rankAccounts({
      serviceId: 'claude-code',
      model: 'claude-fable-5-1',
      names: ['busy', 'idle'],
      reports: [],
      headroom: { busy: seen(0.1, { ratePerMin: 25 }), idle: seen(null) },
      load: {},
      now: NOW
    })
    expect(ranked[0].name).toBe('idle')
    expect(ranked[1].limit).toBeCloseTo(0.1)
  })
})

describe('stickiness', () => {
  it('warmth is 1 just after an answer and 0 after the cache TTL', () => {
    expect(cacheWarmth(NOW, NOW)).toBe(1)
    expect(cacheWarmth(NOW - STICKY.cacheTtlMs / 2, NOW)).toBeCloseTo(0.5)
    expect(cacheWarmth(NOW - STICKY.cacheTtlMs, NOW)).toBe(0)
    expect(cacheWarmth(null, NOW)).toBe(0)
  })
  it('the tolerance is the base plus the cache term; a fresh pick keeps only the cache term', () => {
    expect(stickyTolerance(0, false)).toBeCloseTo(STICKY.base)
    expect(stickyTolerance(1, false)).toBeCloseTo(STICKY.base + STICKY.cache)
    expect(stickyTolerance(1, true)).toBeCloseTo(STICKY.cache)
    expect(stickyTolerance(0, true)).toBe(0)
  })
  it('a thread moves only when the best leads by more than the tolerance', () => {
    const ranked = (best: number, own: number) => [
      { name: 'best', threads: 0, total: best, window: 1, limit: 1, load: 1, rate: 1, spendFirst: false },
      { name: 'own', threads: 0, total: own, window: 1, limit: 1, load: 1, rate: 1, spendFirst: false }
    ]
    expect(keepOrMove('own', ranked(0.9, 0.85), 0.1)).toBe('own')
    expect(keepOrMove('own', ranked(0.9, 0.7), 0.1)).toBe('best')
    expect(keepOrMove('own', ranked(0.9, 0.7), 0.35)).toBe('own')
    expect(keepOrMove('own', [ranked(0.9, 0.7)[1]], 0)).toBe('own')
    expect(keepOrMove('own', [], 0)).toBe('own')
  })
})
