import { describe, expect, it } from 'vitest'
import { TierVerdictSchema, tierVerdictSetting, type TierVerdict } from '@shared/computer/tools'
import type { StepResult, Tier } from '@shared/computer/protocol'
import { TierVerdicts, VERDICT_TTL_MS, nextVerdict } from './verdicts'

const B = 'com.example.app'
function memoryStore() {
  const rows = new Map<string, string>()
  return { rows, getSetting: (k: string) => rows.get(k) ?? null, setSetting: (k: string, v: string | null) => (v === null ? rows.delete(k) : rows.set(k, v)) }
}
const ok = (tier: Tier | null, effect: 'changed' | 'none' | 'unknown'): StepResult => ({
  index: 0,
  action: 'left_click',
  status: 'ok',
  tier,
  effect
})
const click = { action: 'left_click' as const }

describe('tiersFor', () => {
  it('ax then process with no verdict, session only when admitted', () => {
    const v = new TierVerdicts(memoryStore())
    expect(v.tiersFor(B, click, false)).toEqual(['ax', 'process'])
    expect(v.tiersFor(B, click, true)).toEqual(['ax', 'process', 'session'])
  })
  it('two misses at process skip it while session is admitted', () => {
    const store = memoryStore()
    store.setSetting(tierVerdictSetting(B), JSON.stringify({ bundleId: B, classes: {}, misses: { click: 2 }, updatedAt: Date.now() }))
    const v = new TierVerdicts(store)
    expect(v.tiersFor(B, click, true)).toEqual(['ax', 'session'])
    expect(v.tiersFor(B, click, false)).toEqual(['ax', 'process'])
  })
  it('a session verdict drops process', () => {
    const store = memoryStore()
    const verdict: TierVerdict = { bundleId: B, classes: { click: 'session' }, misses: {}, updatedAt: Date.now() }
    store.setSetting(tierVerdictSetting(B), JSON.stringify(verdict))
    const v = new TierVerdicts(store)
    expect(v.needsSession(B, click)).toBe(true)
    expect(v.tiersFor(B, click, false)).toEqual(['ax'])
    expect(v.tiersFor(B, { action: 'key' }, false)).toEqual(['ax', 'process'])
  })
})

describe('learning (spec §5.2)', () => {
  it('process none counts misses, then session changed raises the class', () => {
    let v = nextVerdict(null, 'click', ok('process', 'none'), 1, B)!
    expect(v.misses.click).toBe(1)
    expect(nextVerdict(v, 'click', ok('session', 'changed'), 2, B)).toBeNull()
    v = nextVerdict(v, 'click', ok('process', 'none'), 3, B)!
    expect(v.misses.click).toBe(2)
    v = nextVerdict(v, 'click', ok('session', 'changed'), 4, B)!
    expect(v.classes.click).toBe('session')
    expect(v.misses.click).toBeUndefined()
  })
  it('a later success at process lowers it again', () => {
    const v = nextVerdict({ bundleId: B, classes: { click: 'session' }, misses: {}, updatedAt: 0 }, 'click', ok('process', 'changed'), 5, B)!
    expect(v.classes.click).toBe('process')
  })
  it('unknown, ax and no-input steps learn nothing', () => {
    expect(nextVerdict(null, 'click', ok('process', 'unknown'), 1, B)).toBeNull()
    expect(nextVerdict(null, 'click', ok('ax', 'changed'), 1, B)).toBeNull()
    expect(nextVerdict(null, 'click', ok(null, 'none'), 1, B)).toBeNull()
  })
  it('a key window failure is recorded, not a ban', () => {
    const failed: StepResult = { index: 0, action: 'key', status: 'failed', error: { kind: 'key_window_unavailable', message: 'not key' } }
    const v = nextVerdict(null, 'key', failed, 1, B)!
    expect(v.needsKeyWindow).toBe(true)
    expect(v.classes.key).toBeUndefined()
    expect(nextVerdict(v, 'key', failed, 2, B)).toBeNull()
  })
  it('round trips through the settings row', () => {
    const store = memoryStore()
    const v = new TierVerdicts(store, { now: () => 1_000 })
    v.learn(B, click, ok('process', 'none'))
    v.learn(B, click, ok('process', 'none'))
    v.learn(B, click, ok('session', 'changed'))
    const row = TierVerdictSchema.parse(JSON.parse(store.rows.get(tierVerdictSetting(B))!))
    expect(row.classes.click).toBe('session')
    v.learn(null, click, ok('process', 'none'))
    expect(store.rows.size).toBe(1)
  })
  it('forgets a verdict older than 30 days', () => {
    const store = memoryStore()
    let now = 1_000
    const v = new TierVerdicts(store, { now: () => now })
    v.learn(B, click, ok('process', 'none'))
    expect(v.get(B)).not.toBeNull()
    now += VERDICT_TTL_MS + 1
    expect(v.get(B)).toBeNull()
  })
})

describe('the probe', () => {
  it('runs once per app: outcomes, the key window and probedAt', () => {
    const store = memoryStore()
    const v = new TierVerdicts(store, { now: () => 7 })
    expect(v.needsProbe(B)).toBe(true)
    expect(v.needsProbe(null)).toBe(false)
    v.learnProbe(B, {
      pid: 1,
      bundleId: B,
      keyWindow: 'other',
      results: [
        { class: 'scroll', outcome: 'honoured', restored: true, ms: 3 },
        { class: 'click', outcome: 'ignored', restored: true, ms: 3 },
        { class: 'key', outcome: 'untested', reason: 'no field', restored: true, ms: 0 }
      ]
    })
    const got = v.get(B)!
    expect(got.classes).toEqual({ scroll: 'process' })
    expect(got.misses).toEqual({ click: 2 })
    expect(got.needsKeyWindow).toBe(true)
    expect(got.probedAt).toBe(7)
    expect(v.needsProbe(B)).toBe(false)
  })
  it('a failed probe is stamped too', () => {
    const v = new TierVerdicts(memoryStore(), { now: () => 9 })
    v.stampProbe(B)
    expect(v.get(B)?.probedAt).toBe(9)
    expect(v.needsProbe(B)).toBe(false)
  })
})
