import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REVIEW_SETTINGS,
  effectiveReviewSettings,
  isBlocking,
  parseReviewSettings,
  reviewLine,
  splitFindings,
  type ReviewFinding
} from './review'

const f = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  file: 'src/a.ts',
  line: 3,
  summary: 'off by one',
  failure_scenario: 'n=0 → index -1',
  ...over
})

describe('review settings', () => {
  it('is off by default, reviewing with GPT-6.1 Sol at high for 15 minutes on confirmed defects', () => {
    expect(DEFAULT_REVIEW_SETTINGS).toEqual({
      beforeMerge: false,
      provider: 'codex',
      model: 'gpt-6.1-sol',
      reasoning: 'high',
      blockOn: 'confirmed',
      maxMinutes: 15
    })
  })

  it('parses a stored set, fills what an older row lacks, and reads junk as unset', () => {
    expect(parseReviewSettings('{"beforeMerge":true}')).toEqual({ ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true })
    expect(parseReviewSettings(null)).toBeNull()
    expect(parseReviewSettings('nope')).toBeNull()
    expect(parseReviewSettings('{"maxMinutes":0}')).toBeNull()
  })

  it('precedence: the project override, else the global set, else the defaults', () => {
    const global = { ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true, maxMinutes: 5 }
    const project = { ...DEFAULT_REVIEW_SETTINGS, model: 'claude-haiku-5-5', provider: 'claude' as const }
    expect(effectiveReviewSettings(null, null)).toEqual({ settings: DEFAULT_REVIEW_SETTINGS, source: 'default' })
    expect(effectiveReviewSettings(null, global)).toEqual({ settings: global, source: 'global' })
    // A project's set is whole: it does not merge field by field with the global one.
    expect(effectiveReviewSettings(project, global)).toEqual({ settings: project, source: 'project' })
  })
})

describe('findings', () => {
  it('blocks on confirmed defects only by default; a missing verdict counts as confirmed', () => {
    expect(isBlocking(f({ verdict: 'CONFIRMED' }), 'confirmed')).toBe(true)
    expect(isBlocking(f({ verdict: 'PLAUSIBLE' }), 'confirmed')).toBe(false)
    expect(isBlocking(f(), 'confirmed')).toBe(true)
    expect(isBlocking(f({ verdict: 'PLAUSIBLE' }), 'any')).toBe(true)
  })

  it('splits blocking from minor keeping the reported order', () => {
    const list = [f({ verdict: 'PLAUSIBLE', line: 1 }), f({ verdict: 'CONFIRMED', line: 2 }), f({ line: 3 })]
    const { blocking, minor } = splitFindings(list, 'confirmed')
    expect(blocking.map((x) => x.line)).toEqual([2, 3])
    expect(minor.map((x) => x.line)).toEqual([1])
    expect(splitFindings(list, 'any').minor).toEqual([])
  })

  it('words each outcome the way the transcript and the e2e read it', () => {
    const base = { runId: 'r', provider: 'codex', model: 'gpt-6.1-sol', branch: 'b', target: 'master', blocking: [], minor: [], merged: true, pushed: false }
    expect(reviewLine({ ...base, outcome: 'pass', minor: [f(), f()] }, 'GPT-6.1 Sol')).toBe('Reviewed by GPT-6.1 Sol: no blocking findings (2 minor)')
    expect(reviewLine({ ...base, outcome: 'pass' })).toBe('Reviewed by gpt-6.1-sol: no blocking findings')
    expect(reviewLine({ ...base, outcome: 'held', merged: false, blocking: [f()] })).toBe('Reviewed by gpt-6.1-sol: 1 blocking finding — merge held')
    expect(reviewLine({ ...base, outcome: 'timeout', minutes: 15 })).toBe('Review by gpt-6.1-sol timed out after 15 min — merged without it')
    expect(reviewLine({ ...base, outcome: 'failed', reason: 'no report' })).toBe('Review by gpt-6.1-sol failed to run (no report) — merged without it')
    expect(reviewLine({ ...base, outcome: 'merged-anyway', blocking: [f(), f()] })).toBe('Merged anyway: 2 blocking findings overridden')
  })
})
