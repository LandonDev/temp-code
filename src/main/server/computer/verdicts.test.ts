import { describe, expect, it } from 'vitest'
import { TierVerdictSchema, tierVerdictSetting, type TierVerdict } from '@shared/computer/tools'
import type { StepResult, Tier } from '@shared/computer/protocol'
import { TierVerdicts, VERDICT_TTL_MS, nextVerdict } from './verdicts'

const B = 'com.example.app'
function memoryStore() {
  const rows = new Map<string, string>()
  return {
    rows,
    getSetting: (k: string) => rows.get(k) ?? null,
    setSetting: (k: string, v: string | null) => (v === null ? rows.delete(k) : rows.set(k, v)),
    settingsWithPrefix: (p: string) => new Map([...rows].filter(([k]) => k.startsWith(p)))
  }
}
const ok = (tier: Tier | null, effect: 'changed' | 'none' | 'unknown' | 'uncommitted'): StepResult => ({
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

describe('the background routes (§24.1)', () => {
  const route = (via: 'hit' | 'caret' | 'scroll-page' | 'scroll-into-view' | 'menu' | 'scroll-bar', effect: 'changed' | 'none' | 'unknown'): StepResult => ({
    index: 0,
    action: 'left_click',
    status: 'ok',
    tier: 'ax',
    effect,
    input: { via }
  })

  it('counts a learned route up on none, leaves it on unknown and clears it on changed', () => {
    const once = nextVerdict(null, 'click', route('hit', 'none'), 1, B)!
    expect(once.viaMisses).toEqual({ hit: 1 })
    expect(nextVerdict(once, 'click', route('hit', 'unknown'), 2, B)).toBeNull()
    const twice = nextVerdict(once, 'click', route('hit', 'none'), 3, B)!
    expect(twice.viaMisses).toEqual({ hit: 2 })
    const cleared = nextVerdict(twice, 'click', route('hit', 'changed'), 4, B)!
    expect(cleared.viaMisses).toBeUndefined()
    expect(TierVerdictSchema.parse(cleared)).toEqual(cleared)
    // a change on a route with no misses learns nothing
    expect(nextVerdict(null, 'click', route('caret', 'changed'), 5, B)).toBeNull()
  })

  it('never learns menu or scroll-bar: their no-ops are honest', () => {
    expect(nextVerdict(null, 'key', route('menu', 'none'), 1, B)).toBeNull()
    expect(nextVerdict(null, 'scroll', route('scroll-bar', 'none'), 1, B)).toBeNull()
  })

  it('names the routes and the process classes the app ignored', () => {
    const store = memoryStore()
    const v = new TierVerdicts(store, { now: () => 10 })
    expect(v.ignoredFor(B)).toBeUndefined()
    store.setSetting(tierVerdictSetting(B), JSON.stringify({ bundleId: B, classes: {}, misses: { scroll: 2, key: 1 }, viaMisses: { hit: 2, caret: 1 }, updatedAt: 10 }))
    expect(v.ignoredFor(B)).toEqual({ via: ['hit'], process: ['scroll'] })
    expect(v.ignoredFor(null)).toBeUndefined()
  })
})

describe('the front tier in the verdict (§26, decision 11)', () => {
  const learn = (v: TierVerdict | null, step: StepResult): TierVerdict | null => nextVerdict(v, 'click', step, 1, B)
  it('counts uncommitted as a miss, and raises to front after two process misses then a change in front', () => {
    let v = learn(null, ok('process', 'uncommitted'))
    v = learn(v, ok('process', 'none'))
    expect(v?.misses).toEqual({ click: 2 })
    v = learn(v, ok('front', 'changed'))
    expect(v).toMatchObject({ classes: { click: 'front' }, misses: {} })
  })
  it('raises from front to session after two front misses, and a change lower down lowers it', () => {
    let v: TierVerdict | null = { bundleId: B, classes: { click: 'front' }, misses: {}, updatedAt: 0 }
    v = learn(v, ok('front', 'uncommitted'))
    v = learn(v, ok('front', 'none'))
    expect(v?.frontMisses).toEqual({ click: 2 })
    v = learn(v, ok('session', 'changed'))
    expect(v).toMatchObject({ classes: { click: 'session' } })
    expect(v?.frontMisses).toBeUndefined()
    v = learn(v, ok('front', 'changed'))
    expect(v?.classes.click).toBe('front')
    v = learn(v, ok('process', 'changed'))
    expect(v?.classes.click).toBe('process')
  })
  it('gives front when admitted, skips the tier a class outgrew, and after two front misses sends a later call to the session path with both lower routes last', () => {
    const store = memoryStore()
    const put = (v: Partial<TierVerdict>) => store.setSetting(tierVerdictSetting(B), JSON.stringify({ bundleId: B, classes: {}, misses: {}, updatedAt: Date.now(), ...v }))
    const v = new TierVerdicts(store)
    put({})
    expect(v.tiersFor(B, click, { front: true, session: false })).toEqual(['ax', 'process', 'front'])
    put({ misses: { click: 2 } })
    expect(v.tiersFor(B, click, { front: true, session: false })).toEqual(['ax', 'front'])
    put({ classes: { click: 'front' } })
    expect(v.needsFront(B, click)).toBe(true)
    expect(v.tiersFor(B, click, { front: false, session: false })).toEqual(['ax'])
    put({ classes: { click: 'front' }, frontMisses: { click: 2 } })
    expect(v.needsSession(B, click)).toBe(true)
    expect(v.tiersFor(B, click, { front: true, session: true })).toEqual(['ax', 'session'])
    expect(v.ignoredFor(B)).toEqual({ process: ['click'], front: ['click'] })
  })
})

describe('Settings → Computer use: names, list, forget, onChange', () => {
  const fixed = (now: number) => ({ now: () => now })

  it('keeps the newest name from a learning step, a probe and a stamp', () => {
    const store = memoryStore()
    const v = new TierVerdicts(store)
    v.learn(B, click, ok('process', 'changed'), 'Example')
    expect(v.get(B)?.name).toBe('Example')
    v.learn(B, click, ok('process', 'none'), 'Example 2')
    expect(v.get(B)?.name).toBe('Example 2')
    v.learnProbe(B, { pid: 1, bundleId: B, results: [], keyWindow: 'target' }, 'Example 3')
    expect(v.get(B)?.name).toBe('Example 3')
    v.stampProbe(B)
    expect(v.get(B)?.name).toBe('Example 3')
    v.stampProbe(B, 'Example 4')
    expect(v.get(B)?.name).toBe('Example 4')
  })

  it('names a verdict saved before names were kept at its next call, even one that learns nothing', () => {
    const store = memoryStore()
    store.setSetting(tierVerdictSetting(B), JSON.stringify({ bundleId: B, classes: { click: 'process' }, misses: {}, updatedAt: Date.now() }))
    const v = new TierVerdicts(store)
    v.learn(B, click, ok('ax', 'changed'), 'Example')
    expect(v.get(B)?.name).toBe('Example')
    expect(v.get(B)?.classes).toEqual({ click: 'process' })
  })

  it('lists every kept verdict, leaving out past-TTL and unreadable rows', () => {
    const now = 10 * VERDICT_TTL_MS
    const store = memoryStore()
    const put = (id: string, value: string) => store.setSetting(tierVerdictSetting(id), value)
    put('a.fresh', JSON.stringify({ bundleId: 'a.fresh', name: 'Fresh', classes: { type: 'session' }, misses: {}, updatedAt: now - 1000 }))
    put('b.old', JSON.stringify({ bundleId: 'b.old', classes: {}, misses: {}, updatedAt: now - VERDICT_TTL_MS - 1 }))
    put('c.bad', '{not json')
    put('d.wrong', JSON.stringify({ bundleId: 'd.wrong', classes: { click: 'screen' }, misses: {}, updatedAt: now }))
    store.setSetting('computer.sessionIdleMs', '60000')
    const list = new TierVerdicts(store, fixed(now)).list()
    expect(list.map((x) => x.bundleId)).toEqual(['a.fresh'])
    expect(list[0].name).toBe('Fresh')
  })

  it('forgets one app, then every app, and the next call probes again', () => {
    const store = memoryStore()
    const v = new TierVerdicts(store)
    v.stampProbe('a.one', 'One')
    v.learn('b.two', click, ok('process', 'changed'), 'Two')
    store.setSetting('computer.sessionIdleMs', '60000')
    v.forget('a.one')
    expect(v.get('a.one')).toBeNull()
    expect(v.needsProbe('a.one')).toBe(true)
    expect(v.list().map((x) => x.bundleId)).toEqual(['b.two'])
    v.forget(null)
    expect(v.list()).toEqual([])
    expect(store.getSetting('computer.sessionIdleMs')).toBe('60000')
  })

  it('tells its listeners on every save and forget, and not on a forget that changes nothing', () => {
    const v = new TierVerdicts(memoryStore())
    let calls = 0
    const off = v.onChange(() => calls++)
    v.learn(B, click, ok('process', 'changed'), 'Example')
    expect(calls).toBe(1)
    v.learn(B, click, ok('ax', 'changed'))
    expect(calls).toBe(1)
    v.forget(B)
    expect(calls).toBe(2)
    v.forget(B)
    v.forget(null)
    expect(calls).toBe(2)
    v.stampProbe(B)
    expect(calls).toBe(3)
    off()
    v.forget(null)
    expect(calls).toBe(3)
  })
})


describe('scroll-into-view learning (§25)', () => {
  it('learns misses, ignores unknown evidence, sends the ignored route, and clears on change', () => {
    const v = new TierVerdicts(memoryStore(), { now: () => 10 })
    const action = { action: 'scroll' as const }
    const step = (effect: 'none' | 'changed' | 'unknown'): StepResult => ({ index: 0, action: 'scroll', status: 'ok', tier: 'ax', effect, input: { via: 'scroll-into-view' } })
    v.learn(B, action, step('none'))
    v.learn(B, action, step('unknown'))
    expect(v.get(B)?.viaMisses?.['scroll-into-view']).toBe(1)
    v.learn(B, action, step('none'))
    expect(v.ignoredFor(B)).toEqual({ via: ['scroll-into-view'] })
    v.learn(B, action, step('changed'))
    expect(v.ignoredFor(B)).toBeUndefined()
  })
})
