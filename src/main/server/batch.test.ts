import { describe, expect, it } from 'vitest'
import type { BatchState } from '@shared/contract-batch'
import type { DeployStatus, HostLogPush } from '@shared/contract-host'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { Batches, deployStage, handleBatch, publishStage, releaseTag, type BatchesDeps, type PublishRun } from './batch'
import { GateQueue } from './gateQueue'
import type { GateRunOptions, GateRunResult } from './gateRun'
import type { Landed } from './mergeReview'

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, parentId: null, archived: false, createdAt: 1, status: 'idle', title: `T ${id}`, projectId: 'p1', ...patch }) as SessionMeta

/** A fake deploy trigger: the files as a status, the log as pushes. */
function fakeDeploy() {
  let status: DeployStatus = { job: 'deploy', phase: 'idle', target: null, startedAt: null, finishedAt: null, exit: null, stoppable: false, installed: true, installHint: '', version: '1.0.1' }
  const subs = new Map<number, (push: HostLogPush) => void>()
  const requested: string[] = []
  let refuse: string | null = null
  const emit = (push: HostLogPush): void => {
    for (const s of subs.values()) s(push)
  }
  return {
    requested,
    refuse: (why: string | null) => (refuse = why),
    deploy: async (ref: string) => {
      if (refuse) throw new Error(refuse)
      requested.push(ref)
      status = { ...status, phase: 'pending', target: ref, startedAt: 1, exit: null }
      return status
    },
    status: () => status,
    subscribe: (connection: number, send: (push: HostLogPush) => void) => {
      subs.set(connection, send)
      return () => void subs.delete(connection)
    },
    /** the runner writes a line */
    line: (text: string) => {
      status = { ...status, phase: 'running' }
      emit({ push: 'host-log', job: 'deploy', append: `${text}\n`, status })
    },
    /** the runner writes the exit file */
    exit: (code: number) => {
      status = { ...status, phase: 'done', finishedAt: 2, exit: code }
      emit({ push: 'host-log', job: 'deploy', status })
    },
    /** the files as a fresh process finds them */
    set: (s: Partial<DeployStatus>) => (status = { ...status, ...s })
  }
}

/** A fake Mac publish: lines fed by hand, the outcome resolved by hand. */
function fakePublish() {
  const calls: { sessionId: string; args: { sha: string; branch: string; version: string; notes: string } }[] = []
  let feed: ((line: string) => void) | null = null
  let settle: { resolve: (r: PublishRun) => void; reject: (e: Error) => void } | null = null
  let mac: string | (() => never) = 'env_mac'
  const stops: string[] = []
  return {
    calls,
    stops,
    noMac: () => {
      mac = () => {
        throw new Error('no Mac paired')
      }
    },
    line: (l: string) => feed?.(l),
    finish: (r: PublishRun) => settle?.resolve(r),
    fail: (why: string) => settle?.reject(new Error(why)),
    resolveMac: (_sessionId: string) => (typeof mac === 'string' ? mac : mac()),
    start: (sessionId: string, args: { sha: string; branch: string; version: string; notes: string }, onLine: (line: string) => void) => {
      calls.push({ sessionId, args })
      feed = onLine
      const done = new Promise<PublishRun>((resolve, reject) => (settle = { resolve, reject }))
      return { done, stop: async () => void stops.push(sessionId) }
    }
  }
}

/** A registry of a master `m` with children a, b (and a sub of a); a store of a map. */
function world(opts: { master?: string | null; branch?: string | null; children?: SessionMeta[] } = {}) {
  const sessions = new Map<string, SessionMeta>(
    (
      opts.children ?? [
        meta('m'),
        meta('b', { masterId: 'm', createdAt: 3, status: 'queued' }),
        meta('a', { masterId: 'm', createdAt: 2 }),
        meta('sub', { masterId: 'm', parentId: 'a', createdAt: 4 }),
        meta('other', { masterId: 'n' })
      ]
    ).map((s) => [s.id, s])
  )
  if (!sessions.has('m')) sessions.set('m', meta('m'))
  const rows: Record<string, AgentEvent[]> = {}
  const reports: { to: string; status: string; text: string }[] = []
  const settings = new Map<string, string>()
  const metaListeners = new Set<(s: SessionMeta) => void>()
  const spoke = new Set<string>(['a', 'b', 'r'])
  const registry: BatchesDeps['registry'] = {
    list: () => [...sessions.values()].filter((s) => !s.archived),
    get: (id) => sessions.get(id) ?? null,
    getProject: () => ({ id: 'p1', workspaceId: 'w1', name: 'p', mode: 'local', branch: 'master', cwd: '/repo', archived: false, createdAt: 1, masterThreadId: opts.master === undefined ? 'm' : opts.master }),
    append: (id, e) => void (rows[id] ??= []).push(e),
    hasUserText: (id) => spoke.has(id),
    setArchived: async (id, archived) => {
      const s = sessions.get(id)
      if (s) sessions.set(id, { ...s, archived })
    },
    deliverAgentReport: (to, r) => void reports.push({ to, status: r.status, text: r.text }),
    onMeta: (l) => {
      metaListeners.add(l)
      return () => metaListeners.delete(l)
    },
    onRemoved: () => () => {}
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
    const own = outcome(o)
    const log =
      own.log ??
      (o.step === 'gate'
        ? 'gate: commit tier, 3 steps: typecheck, vitest, build\n› typecheck\n✓ typecheck 12s passed\n› vitest\n✓ vitest 40s passed\n› build\n✓ build 20s passed'
        : 'released v277 (tag release-277, package.json 1.0.277) — publish it with: bun run release:publish')
    for (const line of log.split('\n')) o.onLine?.(line)
    return { ok: true, log, ms: 72_000, exitCode: 0, ...own }
  }
  const merges: { cwd: string; branch: string; target: string; push: boolean }[] = []
  let refuseMerge: string | null = null
  const merge = async (cwd: string, branch: string, target: string, push: boolean) => {
    if (refuseMerge) throw new Error(refuseMerge)
    merges.push({ cwd, branch, target, push })
    return { sha: 'abcdef1234567890', merged: branch !== target, pushed: push }
  }
  const pushes: BatchState[] = []
  const deploy = fakeDeploy()
  const publish = fakePublish()
  let now = 1000
  const make = (extra: Partial<BatchesDeps> = {}) => {
    const b = new Batches({
      registry,
      store,
      runGate,
      queue: new GateQueue(),
      branchOf: async () => (opts.branch === undefined ? 'master' : opts.branch),
      revParse: async () => 'c0ffee0000000000000000000000000000000000',
      merge,
      deploy,
      publish,
      now: () => now,
      pushEveryMs: 250,
      ...extra
    })
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
  const set = (id: string, patch: Partial<SessionMeta>): void => {
    const s = { ...sessions.get(id)!, ...patch }
    sessions.set(id, s)
    for (const l of metaListeners) l(s)
  }
  return {
    registry,
    store,
    sessions,
    rows,
    reports,
    runs,
    merges,
    pushes,
    deploy,
    publish,
    make,
    landed,
    set,
    tick: (ms: number) => (now += ms),
    refuseMerge: (why: string | null) => (refuseMerge = why),
    setOutcome: (f: typeof outcome) => (outcome = f)
  }
}

const steps = (s: BatchState) => Object.fromEntries(s.steps.map((x) => [x.id, [x.status, x.detail]]))
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Batches: the rows and the rules', () => {
  it("an untouched batch is empty with the master's roots pending, oldest first", () => {
    const w = world()
    const b = w.make()
    const state = b.get('m')
    expect(state.rules).toEqual({ land: 'as-they-finish', gate: true, release: true, publish: false, deploy: 'none', then: 'notify' })
    expect(state.steps.map((s) => [s.id, s.status, s.log])).toEqual([
      ['land', 'pending', []],
      ['gate', 'pending', []],
      ['release', 'pending', []],
      ['publish', 'pending', []],
      ['deploy', 'pending', []]
    ])
    expect(state).toMatchObject({ landed: [], pending: ['a', 'b'], held: [], blocked: null, finishedAt: null })
    expect(w.pushes).toEqual([])
  })

  it('setRules merges a patch, validates it, pushes, and the tool answers the line; a non-master is refused', () => {
    const w = world()
    const b = w.make()
    const master = w.sessions.get('m')!
    expect(b.rulesTool(master)).toBe('Rules: land as they finish · gate · release · then notify.')
    const answer = b.rulesTool(master, { land: 'all-at-once', deploy: 'box', summary: 'Land all, gate, release, deploy' })
    expect(answer).toMatch(/^Rules set: land all at once · gate · release · deploy to the box · then notify — "Land all, gate, release, deploy"\. The app runs them when every thread of the batch is done \(2 now\)/)
    expect(b.rules('m')).toMatchObject({ land: 'all-at-once', gate: true, deploy: 'box', publish: false })
    expect(w.pushes.at(-1)?.rules.land).toBe('all-at-once')
    expect(b.rulesTool(master, { deploy: 'moon' as never })).toMatch(/^refused: deploy/)
    expect(b.rulesTool(w.sessions.get('a')!, { gate: false })).toMatch(/^refused: batch_rules is for the project's master thread/)
    // A new instance reads them back.
    expect(w.make().rules('m').summary).toBe('Land all, gate, release, deploy')
  })

  it('handleBatch: batch.get, batch.children, batch.setRules (partial) and batch.stopStep', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    const get = await handleBatch({ id: '1', method: 'batch.get', params: { masterId: 'm' } } as never, b, w.registry)
    expect(get.handled && (get.result as BatchState).landed).toEqual(['a'])
    const children = await handleBatch({ id: '2', method: 'batch.children', params: { masterId: 'm' } } as never, b, w.registry)
    expect(children.handled && (children.result as { children: SessionMeta[] }).children.map((s) => s.id)).toEqual(['a', 'b'])
    const set = await handleBatch({ id: '3', method: 'batch.setRules', params: { masterId: 'm', rules: { then: 'archive-children' } } } as never, b, w.registry)
    expect(set.handled && (set.result as BatchState).rules).toMatchObject({ then: 'archive-children', gate: true })
    const stop = await handleBatch({ id: '4', method: 'batch.stopStep', params: { masterId: 'm' } } as never, b, w.registry)
    expect(stop.handled && stop.result).toEqual({ stopped: false })
    expect(await handleBatch({ id: '5', method: 'session.list', params: {} } as never, b, w.registry)).toEqual({ handled: false })
  })

  it('a row from before the telemetry reads back: done is passed, a missing log is empty', () => {
    const w = world()
    w.store.setSetting(
      'batch:m',
      JSON.stringify({ masterId: 'm', steps: [{ id: 'land', status: 'done', detail: '2 of 2 landed', at: 5 }, { id: 'gate', status: 'running', detail: '', at: 6 }], landed: ['a'] })
    )
    const state = w.make().get('m')
    expect(steps(state).land).toEqual(['passed', '2 of 2 landed'])
    expect(steps(state).gate).toEqual(['running', ''])
    expect(state.steps.every((s) => Array.isArray(s.log))).toBe(true)
    expect(state.steps.map((s) => s.id)).toEqual(['land', 'gate', 'release', 'publish', 'deploy'])
  })
})

describe('Batches: land', () => {
  it('as they finish: land runs from the first landing with a log line and progress, and the batch stays open', () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a', 'feat-a', ['a: one', 'a: two']))
    const state = b.get('m')
    expect(steps(state).land).toEqual(['running', '1 of 2 landed'])
    expect(state.steps[0].log).toEqual(['feat-a landed'])
    expect(state.steps[0].progress).toEqual({ done: 1, total: 2 })
    expect(state.steps[0].startedAt).toBe(1000)
    expect(state.landed).toEqual(['a'])
    expect(state.pending).toEqual(['b'])
    expect(b.open('m')).toBe(true)
    expect(w.pushes).toHaveLength(1)
  })

  it('all at once: merge_branch is held with the text, the branch recorded; as-they-finish holds nothing', () => {
    const w = world()
    const b = w.make()
    const a = w.sessions.get('a')!
    expect(b.hold(a, { cwd: '/repo', branch: 'feat-a', target: 'master', push: true, subjects: ['a: one'] })).toBeNull()
    b.setRules('m', { land: 'all-at-once' })
    const text = b.hold(a, { cwd: '/repo', branch: 'feat-a', target: 'master', push: true, subjects: ['a: one'] })
    expect(text).toBe('HELD: the batch lands all at once; the master will merge feat-a when every thread is done. Your work is recorded; you are done with it.')
    const state = b.get('m')
    expect(state.held).toEqual(['a'])
    expect(steps(state).land).toEqual(['running', '1 held for the end'])
    expect(state.steps[0].log).toEqual(['feat-a held for the end'])
    expect(b.hold(meta('x'), { cwd: '/repo', branch: 'x', target: 'master', push: false, subjects: [] })).toBeNull()
  })
})

describe('Batches: the end of the batch', () => {
  it('runs gate, release (pushed), skips publish and deploy, rows the master and wakes it; then the batch is closed', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a', 'feat-a', ['a: one']))
    // b still queued: nothing runs.
    await b.review('m')
    expect(w.runs).toHaveLength(0)
    expect(b.open('m')).toBe(true)
    w.set('b', { status: 'idle' })
    b.landed(w.landed('b', 'feat-b', ['b: two']))
    await b.review('m')
    expect(w.runs.map((r) => [r.step, r.push ?? false, r.notes])).toEqual([
      ['gate', false, undefined],
      ['release', true, 'T m; a: one; b: two']
    ])
    const state = b.get('m')
    expect(steps(state)).toEqual({
      land: ['passed', '2 of 2 landed'],
      gate: ['passed', 'passed in 1m 12s'],
      release: ['passed', 'release-277 tagged'],
      publish: ['skipped', 'off by the rules'],
      deploy: ['skipped', 'off by the rules']
    })
    expect(state.finishedAt).toBe(1000)
    expect(state.steps[1].log).toContain('✓ vitest 40s passed')
    expect(state.steps[1].progress).toEqual({ done: 3, total: 3 })
    expect(state.steps[1].startedAt).toBe(1000)
    expect(state.steps[1].endedAt).toBe(1000)
    expect(w.rows.m.filter((e) => e.type === 'notice').map((e) => (e as { kind: string }).kind + ': ' + (e as { message: string }).message)).toEqual([
      'gate: Gate passed on master',
      'gate: Release passed on master',
      'batch: Batch done: 2 of 2 landed · gate passed in 1m 12s · release-277 tagged'
    ])
    expect(w.reports).toEqual([
      { to: 'm', status: 'done', text: expect.stringContaining('<batch-report>\nThe batch is done: 2 of 2 landed · gate passed in 1m 12s · release-277 tagged.') }
    ])
    expect(b.open('m')).toBe(false)
    // A second review runs nothing again.
    await b.review('m')
    expect(w.runs).toHaveLength(2)
  })

  it('gate and release off: both skipped, nothing run, the master still told', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { gate: false, release: false })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(w.runs).toHaveLength(0)
    expect(steps(b.get('m'))).toMatchObject({ gate: ['skipped', 'off by the rules'], release: ['skipped', 'off by the rules'], land: ['passed', '1 of 2 landed · 1 left out'] })
    expect(w.reports.map((r) => r.status)).toEqual(['done'])
  })

  it('nothing landed (research only): gate, release and deploy are skipped as such', async () => {
    const w = world({ children: [meta('m'), meta('r', { masterId: 'm', createdAt: 2 })] })
    const b = w.make()
    b.setRules('m', { deploy: 'box' })
    await b.review('m')
    expect(w.runs).toHaveLength(0)
    expect(steps(b.get('m'))).toMatchObject({ land: ['passed', '0 of 1 landed · 1 left out'], gate: ['skipped', 'nothing landed'], release: ['skipped', 'nothing landed'], deploy: ['skipped', 'nothing landed'] })
    expect(w.deploy.requested).toEqual([])
  })

  it('all at once: the held branches merge in landing order at the end, then the rest runs; a refused merge fails land and tells the master', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { land: 'all-at-once' })
    b.hold(w.sessions.get('b')!, { cwd: '/repo', branch: 'feat-b', target: 'master', push: true, subjects: ['b: two'] })
    b.hold(w.sessions.get('a')!, { cwd: '/repo', branch: 'feat-a', target: 'master', push: true, subjects: ['a: one'] })
    w.set('b', { status: 'idle' })
    await b.review('m')
    expect(w.merges.map((m) => m.branch)).toEqual(['feat-b', 'feat-a'])
    const state = b.get('m')
    expect(state.held).toEqual([])
    expect(state.landed).toEqual(['b', 'a'])
    expect(steps(state).land).toEqual(['passed', '2 of 2 landed'])
    expect(w.rows.b.map((e) => (e as { message?: string }).message)).toEqual(['Merged by the batch: feat-b → master at abcdef1234, pushed'])
    expect(w.runs.map((r) => r.notes ?? r.step)).toEqual(['gate', 'T m; b: two; a: one'])

    const w2 = world()
    const b2 = w2.make()
    b2.setRules('m', { land: 'all-at-once' })
    b2.hold(w2.sessions.get('a')!, { cwd: '/repo', branch: 'feat-a', target: 'master', push: true, subjects: [] })
    w2.refuseMerge('not a fast-forward')
    w2.set('b', { status: 'idle' })
    await b2.review('m')
    expect(steps(b2.get('m')).land).toEqual(['failed', "The batch's merge of feat-a failed: not a fast-forward. Rebase it on a child and call merge_branch there again; the batch finishes once every thread is done."])
    expect(w2.runs).toHaveLength(0)
    expect(w2.reports.map((r) => r.status)).toEqual(['failed'])
    expect(b2.get('m').steps[0].log.at(-1)).toBe('✗ feat-a: not a fast-forward')
  })

  it('an errored or stopped child blocks: blocked names it, the master is told once, nothing runs, the batch stays open', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    w.set('b', { status: 'error' })
    await b.review('m')
    await b.review('m')
    expect(b.get('m').blocked).toEqual({ sessionId: 'b', why: 'errored' })
    expect(w.reports).toEqual([{ to: 'm', status: 'blocked', text: expect.stringContaining('batch thread "T b" (b) errored') }])
    expect(w.runs).toHaveLength(0)
    expect(b.open('m')).toBe(true)
    w.set('b', { status: 'stopped' })
    await b.review('m')
    expect(b.get('m').blocked).toEqual({ sessionId: 'b', why: 'stopped' })
    expect(w.reports.map((r) => r.status)).toEqual(['blocked', 'blocked'])
    // Archiving it clears the block and the batch ends.
    await w.registry.setArchived!('b', true)
    await b.review('m')
    expect(b.get('m').blocked).toBeNull()
    expect(w.reports.at(-1)?.status).toBe('done')
  })

  it('a red gate fails the step, tells the master, runs nothing after; a child moving again re-arms, and a landing re-opens the steps', async () => {
    const w = world()
    const b = w.make()
    w.setOutcome((o) => (o.step === 'gate' ? { ok: false, log: '✓ typecheck 12s passed\n✗ vitest 40s failed\nFAIL x.test.ts' } : {}))
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(steps(b.get('m')).gate).toEqual(['failed', "The batch's gate FAILED at vitest in 1m 12s; nothing was tagged."])
    expect(steps(b.get('m')).release).toEqual(['pending', ''])
    expect(w.reports.map((r) => r.status)).toEqual(['failed'])
    expect(w.reports[0].text).toContain('FAIL x.test.ts')
    expect(b.open('m')).toBe(false)
    expect(w.runs).toHaveLength(1)
    // Nothing changed: no second run.
    await b.review('m')
    expect(w.runs).toHaveLength(1)
    // A child runs again and lands: the gate runs once more.
    w.set('b', { status: 'running' })
    await b.review('m')
    expect(b.open('m')).toBe(true)
    w.setOutcome(() => ({}))
    b.landed(w.landed('b'))
    w.set('b', { status: 'idle' })
    await b.review('m')
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'gate', 'release'])
    expect(steps(b.get('m')).release).toEqual(['passed', 'release-277 tagged'])
  })

  it('archive-children archives every done child at the end', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { then: 'archive-children', gate: false, release: false })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(w.sessions.get('a')?.archived).toBe(true)
    expect(w.sessions.get('b')?.archived).toBe(true)
    expect(w.sessions.get('m')?.archived).toBe(false)
    expect(w.reports[0].text).toContain('The 2 done threads are archived.')
  })
})

describe('Batches: publish and deploy', () => {
  it("publish runs the Mac's job for the released commit, streams its lines, and passes; deploy then takes v1.0.N", async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { publish: true, deploy: 'box' })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a', 'feat-a', ['a: one']))
    const review = b.review('m')
    await flush()
    expect(w.publish.calls).toEqual([{ sessionId: 'm', args: { sha: 'c0ffee0000000000000000000000000000000000', branch: 'master', version: '1.0.277', notes: 'T m; a: one' } }])
    expect(steps(b.get('m')).publish).toEqual(['running', 'v1.0.277 on the Mac'])
    w.publish.line('== release v1.0.277 from /Users/x/temp-code')
    w.publish.line('== notarizing')
    expect(b.get('m').steps[3].log).toEqual(['== release v1.0.277 from /Users/x/temp-code', '== notarizing'])
    expect(b.get('m').steps[3].progress).toEqual({ done: 0, total: 1, label: 'notarizing' })
    expect(await b.stopStep('m')).toEqual({ stopped: true })
    expect(w.publish.stops).toEqual(['m'])
    w.publish.finish({ ok: true, exit: 0, version: '1.0.277', text: 'published' })
    await flush()
    expect(steps(b.get('m')).publish).toEqual(['passed', 'v1.0.277 published'])
    expect(w.deploy.requested).toEqual(['v1.0.277'])
    expect(steps(b.get('m')).deploy).toEqual(['running', 'v1.0.277 requested'])
    // The store already carries the deploy in flight (the trigger restarts this process).
    expect(JSON.parse(w.store.getSetting('batch:m')!).deployRef).toBe('v1.0.277')
    w.deploy.line('== stage 40: fetch')
    w.deploy.line('== stage 60: install')
    expect(b.get('m').steps[4].progress).toEqual({ done: 0, total: 1, label: 'stage 60: install' })
    w.deploy.exit(0)
    await review
    await flush()
    expect(steps(b.get('m')).deploy).toEqual(['passed', 'v1.0.277 deployed'])
    expect(b.get('m').finishedAt).toBe(1000)
    expect(w.reports.at(-1)?.text).toContain('release-277 tagged · v1.0.277 published · v1.0.277 deployed')
    expect(await b.stopStep('m')).toEqual({ stopped: false })
  })

  it('publish without a Mac fails the step with the reason; a Mac failure names the exit; deploy without publish takes master', async () => {
    const w = world()
    const b = w.make()
    w.publish.noMac()
    b.setRules('m', { publish: true })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(steps(b.get('m')).publish).toEqual(['failed', "The batch's publish cannot run: no Mac paired"])
    expect(w.reports.map((r) => r.status)).toEqual(['failed'])

    const w2 = world()
    const b2 = w2.make()
    b2.setRules('m', { publish: true })
    w2.set('b', { status: 'idle' })
    b2.landed(w2.landed('a'))
    const review = b2.review('m')
    await flush()
    w2.publish.finish({ ok: false, exit: 1, version: '1.0.277', text: 'notarization failed' })
    await review
    expect(steps(b2.get('m')).publish).toEqual(['failed', "The Mac's publish of v1.0.277 FAILED (exit 1): notarization failed"])

    const w3 = world()
    const b3 = w3.make()
    b3.setRules('m', { deploy: 'box' })
    w3.set('b', { status: 'idle' })
    b3.landed(w3.landed('a'))
    const r3 = b3.review('m')
    await flush()
    expect(w3.deploy.requested).toEqual(['master'])
    w3.deploy.exit(1)
    await r3
    await flush()
    expect(steps(b3.get('m')).deploy).toEqual(['failed', 'exit 1'])
    expect(w3.reports.at(-1)).toMatchObject({ status: 'failed', text: expect.stringContaining('The box deploy of master FAILED (exit 1)') })
    expect(b3.get('m').finishedAt).toBeNull()
  })

  it('a refused deploy fails the step without a follower; no trigger on this host fails it too', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { deploy: 'box' })
    w.deploy.refuse('a deploy of the box is in progress; wait for it to finish')
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(steps(b.get('m')).deploy).toEqual(['failed', 'The box deploy was refused: a deploy of the box is in progress; wait for it to finish'])
    expect(b.open('m')).toBe(false)
    const w2 = world()
    const b2 = w2.make({ deploy: undefined })
    b2.setRules('m', { deploy: 'box' })
    w2.set('b', { status: 'idle' })
    b2.landed(w2.landed('a'))
    await b2.review('m')
    expect(steps(b2.get('m')).deploy[0]).toBe('failed')
    expect(steps(b2.get('m')).deploy[1]).toContain('no deploy trigger')
  })

  it('the deploy survives a restart: a new instance over the same store reads the exit file, closes the step and runs then', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { deploy: 'box', then: 'archive-children' })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    const review = b.review('m')
    await flush()
    expect(steps(b.get('m')).deploy).toEqual(['running', 'master requested'])
    // The service restarts: this instance is gone, the files say the deploy finished.
    b.dispose()
    w.deploy.set({ phase: 'done', exit: 0, target: 'master' })
    const b2 = w.make()
    expect(steps(b2.get('m')).deploy).toEqual(['running', 'master requested'])
    expect(b2.open('m')).toBe(true)
    await b2.resumeAfterBoot()
    await flush()
    expect(steps(b2.get('m')).deploy).toEqual(['passed', 'master deployed'])
    expect(b2.get('m').finishedAt).toBe(1000)
    expect(w.sessions.get('a')?.archived).toBe(true)
    expect(w.reports.at(-1)?.status).toBe('done')
    expect(b2.get('m').steps[4].log).toContain('== host restarted; following the deploy of master')
    await review
  })

  it('a publish that was running at the restart is failed with a pointer to the Mac', async () => {
    const w = world()
    w.store.setSetting(
      'batch:m',
      JSON.stringify({ masterId: 'm', rules: { publish: true }, steps: [{ id: 'publish', status: 'running', detail: 'v1.0.9 on the Mac', at: 1, log: [] }], landed: ['a'] })
    )
    const b = w.make()
    await b.resumeAfterBoot()
    expect(steps(b.get('m')).publish).toEqual(['failed', 'the host restarted during the publish; its outcome is on the Mac'])
    expect(w.reports[0]).toMatchObject({ status: 'failed', text: expect.stringContaining("check the Mac's publish log") })
  })
})

describe('Batches: the push and the log', () => {
  it('log lines coalesce into at most one push per interval, the trailing one carrying the rest; the log keeps 200 lines', async () => {
    const w = world()
    const b = w.make()
    w.setOutcome((o) => (o.step === 'gate' ? { log: Array.from({ length: 260 }, (_, i) => `line ${i}`).join('\n') } : {}))
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    const before = w.pushes.length
    await b.review('m')
    // Everything above ran at one instant: one push went out, the rest wait for the trailing timer.
    expect(w.pushes.length - before).toBeLessThanOrEqual(2)
    b.flush()
    const last = w.pushes.at(-1)!
    expect(last.steps[1].log).toHaveLength(200)
    expect(last.steps[1].log[0]).toBe('line 60')
    expect(last.steps[1].log.at(-1)).toBe('line 259')
    // Persisted with the push.
    expect(JSON.parse(w.store.getSetting('batch:m')!).steps[1].log).toHaveLength(200)
  })

  it('a push goes out at once when the last one is old enough', () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    expect(w.pushes).toHaveLength(1)
    w.tick(300)
    b.setRules('m', { gate: false })
    expect(w.pushes).toHaveLength(2)
  })
})

describe('Batches: batch_gate', () => {
  it('refused off the master or before anything landed', async () => {
    const w = world({ master: 'z' })
    const b = w.make()
    expect(await b.gate(w.sessions.get('m')!)).toMatch(/^refused: batch_gate is for the project's master thread/)
    const w2 = world()
    const b2 = w2.make()
    expect(await b2.gate(w2.sessions.get('m')!)).toBe('refused: nothing has landed yet; children land through merge_branch first')
    const w3 = world({ branch: 'feature' })
    const b3 = w3.make()
    b3.landed(w3.landed('a'))
    expect(await b3.gate(w3.sessions.get('m')!)).toBe('refused: the project checkout at /repo is on feature, not master')
  })

  it('the gate streams its lines, then the release tags and pushes; the rest are left out', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a', 'feat-a', ['a: one', 'a: two']))
    const answer = await b.gate(w.sessions.get('m')!)
    expect(answer).toBe('passed in 1m 12s · release-277 tagged')
    expect(w.runs.map((r) => [r.step, r.cwd, r.branch, r.push ?? false, r.notes])).toEqual([
      ['gate', '/repo', 'master', false, undefined],
      ['release', '/repo', 'master', true, 'T m; a: one; a: two']
    ])
    const state = b.get('m')
    expect(steps(state)).toMatchObject({ land: ['passed', '1 of 2 landed · 1 left out'], gate: ['passed', 'passed in 1m 12s'], release: ['passed', 'release-277 tagged'] })
    expect(w.rows.m.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message)).toEqual(['Gate passed on master', 'Release passed on master'])
  })

  it('a red gate fails the step and tags nothing; release false runs the gate alone; one at a time', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    w.setOutcome((o) => (o.step === 'gate' ? { ok: false, log: '✓ typecheck 12s passed\n✗ vitest 40s failed\nFAIL x.test.ts' } : {}))
    const answer = await b.gate(w.sessions.get('m')!)
    expect(answer).toMatch(/^FAILED at vitest in 1m 12s; nothing was tagged\./)
    expect(steps(b.get('m')).gate).toEqual(['failed', 'failed at vitest · FAIL x.test.ts'])
    expect(w.runs.map((r) => r.step)).toEqual(['gate'])
    w.setOutcome(() => ({}))
    expect(await b.gate(w.sessions.get('m')!, { release: false })).toBe('passed in 1m 12s. Release left for later (release: false).')
    expect(steps(b.get('m')).release).toEqual(['pending', ''])
    const slow = world()
    const sb = slow.make({ runGate: (o) => new Promise((r) => setTimeout(() => r({ ok: true, log: o.step === 'gate' ? '✓ ok' : 'tag release-1', ms: 1, exitCode: 0 }), 20)) })
    sb.landed(slow.landed('a'))
    const first = sb.gate(slow.sessions.get('m')!)
    expect(await sb.gate(slow.sessions.get('m')!)).toBe("refused: the batch's gate is already running")
    await first
  })

  it('helpers: releaseTag, deployStage, publishStage', () => {
    expect(releaseTag('released v277 (tag release-277, package.json 1.0.277) — publish it with: bun run release:publish')).toBe('release-277')
    expect(releaseTag('nothing')).toBeNull()
    expect(deployStage('== stage 40: build')).toBe('stage 40: build')
    expect(deployStage('[deploy] trial')).toBe('trial')
    expect(deployStage('plain output')).toBeNull()
    expect(publishStage('== uploading')).toBe('uploading')
    expect(publishStage('x')).toBeNull()
  })
})
