import { describe, expect, it } from 'vitest'
import type { BatchState } from '@shared/contract-batch'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { Batches, handleBatch, releaseTag, type BatchesDeps } from './batch'
import { GateQueue } from './gateQueue'
import type { GateRunOptions, GateRunResult } from './gateRun'
import type { Landed } from './mergeReview'

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, parentId: null, archived: false, createdAt: 1, status: 'idle', title: `T ${id}`, projectId: 'p1', ...patch }) as SessionMeta

/** A registry of a master `m` with children a, b (and a sub of a); a store of a map. */
function world(opts: { master?: string | null; branch?: string | null } = {}) {
  const sessions = new Map<string, SessionMeta>(
    [
      meta('m'),
      meta('b', { masterId: 'm', createdAt: 3, status: 'queued' }),
      meta('a', { masterId: 'm', createdAt: 2 }),
      meta('sub', { masterId: 'm', parentId: 'a', createdAt: 4 }),
      meta('other', { masterId: 'n' })
    ].map((s) => [s.id, s])
  )
  const rows: Record<string, AgentEvent[]> = {}
  const settings = new Map<string, string>()
  const registry: BatchesDeps['registry'] = {
    list: () => [...sessions.values()].filter((s) => !s.archived),
    get: (id) => sessions.get(id) ?? null,
    getProject: () => ({ id: 'p1', workspaceId: 'w1', name: 'p', mode: 'local', branch: 'master', cwd: '/repo', archived: false, createdAt: 1, masterThreadId: opts.master === undefined ? 'm' : opts.master }),
    append: (id, e) => void (rows[id] ??= []).push(e)
  }
  const store = {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string | null) => void (v === null ? settings.delete(k) : settings.set(k, v)),
    settingsWithPrefix: (p: string) => new Map([...settings].filter(([k]) => k.startsWith(p)))
  }
  const runs: GateRunOptions[] = []
  let outcome: (o: GateRunOptions) => Partial<GateRunResult> = () => ({})
  const runGate = async (o: GateRunOptions): Promise<GateRunResult> => {
    runs.push(o)
    const log = o.step === 'gate' ? '✓ typecheck 12s passed\n✓ vitest 40s passed\n✓ build 20s passed' : 'released v277 (tag release-277, package.json 1.0.277) — publish it with: bun run release:publish'
    for (const line of log.split('\n')) o.onLine?.(line)
    return { ok: true, log, ms: 72_000, exitCode: 0, ...outcome(o) }
  }
  const pushes: BatchState[] = []
  const make = () => {
    const b = new Batches({ registry, store, runGate, queue: new GateQueue(), branchOf: async () => opts.branch === undefined ? 'master' : opts.branch, now: () => 1000 })
    b.onChange((s) => pushes.push(s))
    return b
  }
  const landed = (id: string, branch = `br-${id}`, subjects = [`${id}: did it`]): Landed => ({
    session: sessions.get(id)!,
    branch,
    target: 'master',
    sha: 'abc',
    subjects
  })
  return { registry, store, sessions, rows, runs, pushes, make, landed, setOutcome: (f: typeof outcome) => (outcome = f) }
}

const steps = (s: BatchState) => Object.fromEntries(s.steps.map((x) => [x.id, [x.status, x.detail]]))

describe('Batches', () => {
  it('an untouched batch is empty with the master\'s roots pending, oldest first', () => {
    const w = world()
    const b = w.make()
    expect(b.get('m')).toEqual({
      masterId: 'm',
      rules: { land: 'as-they-finish', gate: true, release: true, deploy: 'none', then: 'notify' },
      steps: [
        { id: 'land', status: 'pending', detail: '', at: null },
        { id: 'gate', status: 'pending', detail: '', at: null },
        { id: 'release', status: 'pending', detail: '', at: null }
      ],
      landed: [],
      pending: ['a', 'b'],
      held: [],
      blocked: null,
      finishedAt: null
    })
    expect(w.pushes).toEqual([])
  })

  it('land runs from the first landing, counts them, and is done when every child has landed', () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    let s = b.get('m')
    expect(steps(s).land).toEqual(['running', '1 of 2 landed'])
    expect(s.landed).toEqual(['a'])
    expect(s.pending).toEqual(['b'])
    expect(w.pushes).toHaveLength(1)
    b.landed(w.landed('b'))
    s = b.get('m')
    expect(steps(s).land).toEqual(['done', '2 of 2 landed'])
    expect(s.pending).toEqual([])
    // a landing with no master is nobody's batch
    b.landed({ ...w.landed('a'), session: meta('loose') })
    expect(w.pushes).toHaveLength(2)
  })

  it('persists in one settings row a new instance reads back', () => {
    const w = world()
    w.make().landed(w.landed('a'))
    expect([...w.store.settingsWithPrefix('batch:').keys()]).toEqual(['batch:m'])
    const again = w.make()
    expect(steps(again.get('m')).land).toEqual(['running', '1 of 2 landed'])
    expect(again.get('m').landed).toEqual(['a'])
  })

  it('batch_gate: refused off the master or before anything landed', async () => {
    const w = world()
    const b = w.make()
    expect(await b.gate(w.sessions.get('a')!)).toMatch(/^refused: batch_gate is for the project's master/)
    expect(await b.gate(w.sessions.get('m')!)).toMatch(/^refused: nothing has landed/)
    expect(w.runs).toEqual([])
    const off = world({ branch: 'feature' })
    const b2 = off.make()
    b2.landed(off.landed('a'))
    expect(await b2.gate(off.sessions.get('m')!)).toMatch(/^refused: the project checkout at \/repo is on feature, not master/)
  })

  it('batch_gate: the gate on the project checkout streams its ✓ lines, then the release tags; the rest are left out', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    const text = await b.gate(w.sessions.get('m')!)
    expect(text).toBe('passed in 1m 12s · release-277 tagged')
    expect(w.runs.map((r) => [r.step, r.cwd, r.branch, r.since, r.notes])).toEqual([
      ['gate', '/repo', 'master', undefined, undefined],
      ['release', '/repo', 'master', undefined, 'T m; a: did it']
    ])
    const s = b.get('m')
    expect(steps(s)).toEqual({
      land: ['done', '1 of 2 landed · 1 left out'],
      gate: ['done', 'passed in 1m 12s'],
      release: ['done', 'release-277 tagged']
    })
    // the details the board saw along the way
    const gateDetails = w.pushes.map((p) => p.steps.find((x) => x.id === 'gate')!.detail)
    expect(gateDetails).toContain('queued')
    expect(gateDetails).toContain('✓ typecheck 12s')
    expect(gateDetails).toContain('✓ build 20s')
    // a gate row and a release row on the master
    expect(w.rows.m.map((e) => (e.type === 'notice' ? [e.kind, e.gate?.step, e.gate?.ok, e.message] : e.type))).toEqual([
      ['gate', 'gate', true, 'Gate passed on master'],
      ['gate', 'release', true, 'Release passed on master']
    ])
  })

  it('batch_gate: a red gate fails the step, names the step, tags nothing; a landing re-opens the gate', async () => {
    const w = world()
    w.setOutcome((o) => (o.step === 'gate' ? { ok: false, log: '✓ typecheck 12s passed\n✗ vitest 40s failed: 2 tests', exitCode: 1 } : {}))
    const b = w.make()
    b.landed(w.landed('a'))
    b.landed(w.landed('b'))
    const text = await b.gate(w.sessions.get('m')!, { notes: 'n' })
    expect(text).toMatch(/^FAILED at vitest in 1m 12s; nothing was tagged\./)
    expect(text).toContain('✗ vitest 40s failed: 2 tests')
    expect(w.runs.map((r) => r.step)).toEqual(['gate'])
    expect(steps(b.get('m'))).toEqual({
      land: ['done', '2 of 2 landed'],
      gate: ['failed', 'failed at vitest · ✗ vitest 40s failed: 2 tests'],
      release: ['pending', '']
    })
    // the fix lands on a child branch: the gate waits to run again
    b.landed(w.landed('a', 'br-a', ['a: fix']))
    expect(steps(b.get('m')).gate).toEqual(['pending', ''])
    w.setOutcome(() => ({}))
    expect(await b.gate(w.sessions.get('m')!, { notes: 'n' })).toBe('passed in 1m 12s · release-277 tagged')
    expect(w.runs.at(-1)?.notes).toBe('n')
  })

  it('batch_gate: release false runs the gate alone; a landing after a release starts a new cycle', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    expect(await b.gate(w.sessions.get('m')!, { release: false })).toBe('passed in 1m 12s. Release left for later (release: false).')
    expect(steps(b.get('m')).release).toEqual(['pending', ''])
    expect(await b.gate(w.sessions.get('m')!)).toBe('passed in 1m 12s · release-277 tagged')
    b.landed(w.landed('b'))
    const s = b.get('m')
    expect(s.landed).toEqual(['b'])
    expect(steps(s)).toEqual({ land: ['running', '1 of 2 landed'], gate: ['pending', ''], release: ['pending', ''] })
  })

  it('batch_gate: one at a time per master', async () => {
    const w = world()
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const b = new Batches({
      registry: w.registry,
      store: w.store,
      runGate: async (o) => {
        if (o.step === 'gate') await hold
        return { ok: true, log: o.step === 'gate' ? '✓ build 1s' : 'tag release-1', ms: 1, exitCode: 0 }
      },
      queue: new GateQueue(),
      branchOf: async () => 'master'
    })
    b.landed(w.landed('a'))
    const first = b.gate(w.sessions.get('m')!)
    await new Promise((r) => setTimeout(r, 0))
    expect(await b.gate(w.sessions.get('m')!)).toBe("refused: the batch's gate is already running")
    release()
    expect(await first).toBe('passed in 0s · release-1 tagged')
  })

  it('releaseTag reads release.ts\'s last line', () => {
    expect(releaseTag('released v277 (tag release-277, package.json 1.0.277)')).toBe('release-277')
    expect(releaseTag('tree has uncommitted changes')).toBeNull()
  })
})

describe('handleBatch', () => {
  it('batch.get answers the live state and batch.children the roots', () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    const r = handleBatch({ id: '1', method: 'batch.get', params: { masterId: 'm' } }, b, w.registry)
    expect(r.handled && (r.result as BatchState).landed).toEqual(['a'])
    const c = handleBatch({ id: '1', method: 'batch.children', params: { masterId: 'm' } }, b, w.registry)
    expect(c.handled && (c.result as { children: SessionMeta[] }).children.map((s) => s.id)).toEqual(['a', 'b'])
    expect(handleBatch({ id: '1', method: 'session.list', params: {} } as never, b, w.registry)).toEqual({ handled: false })
  })
})
