import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_WATCH_MS, type BatchBoard, type BatchPushState, type BatchState } from '@shared/contract-batch'
import type { DeployStatus, HostLogPush } from '@shared/contract-host'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import { Batches, handleBatch, releaseOutcome, releaseTag, spawnShellStep, type BatchesDeps, type PublishRun } from './batch'
import { BoardDigests, type BoardPush } from './boardDigest'
import { BoardWatch } from './boardWatch'
import { FocusSet } from './focus'
import { GateQueue } from './gateQueue'
import type { GateRunOptions, GateRunResult } from './gateRun'
import type { Landed } from './mergeReview'

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, parentId: null, archived: false, createdAt: 1, status: 'idle', title: `T ${id}`, projectId: 'p1', threadType: 'implementation', ...patch }) as SessionMeta

/** Step specs by kind, the default names. */
const S = {
  land: { id: 'land', name: 'Land', kind: 'land' } as const,
  gate: { id: 'gate', name: 'Gate', kind: 'gate' } as const,
  release: { id: 'release', name: 'Release', kind: 'release' } as const,
  publish: { id: 'publish', name: 'Publish', kind: 'publish' } as const,
  deploy: { id: 'deploy', name: 'Deploy', kind: 'deploy' } as const
}
const FIVE = [S.land, S.gate, S.release, S.publish, S.deploy]

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
  // The pin lives on the thread: 'm' unless the world names another master (or none).
  const pinned = opts.master === undefined ? 'm' : opts.master
  if (pinned && sessions.has(pinned)) sessions.set(pinned, { ...sessions.get(pinned)!, isMaster: true })
  const rows: Record<string, AgentEvent[]> = {}
  const batchCalls: { action: string; ids: string[]; cleanup?: boolean }[] = []
  const reports: { to: string; status: string; text: string }[] = []
  const settings = new Map<string, string>()
  const metaListeners = new Set<(s: SessionMeta) => void>()
  const spoke = new Set<string>(['a', 'b', 'r'])
  /** when each thread last moved (lastActivityAt); unset reads as the world's start */
  const activity = new Map<string, number>()
  const registry: BatchesDeps['registry'] = {
    lastActivityAt: (id) => activity.get(id) ?? 1000,
    batchChildren: (masterId) =>
      [...sessions.values()].filter((s) => !s.archived && !s.parentId && s.masterId === masterId).sort((a, b) => a.createdAt - b.createdAt),
    get: (id) => sessions.get(id) ?? null,
    getProject: () => ({ id: 'p1', workspaceId: 'w1', name: 'p', mode: 'local', branch: 'master', cwd: '/repo', archived: false, createdAt: 1 }),
    append: (id, e) => void (rows[id] ??= []).push(e),
    hasCompletedTurn: (id) => spoke.has(id),
    setArchived: async (id, archived) => {
      const s = sessions.get(id)
      if (s) sessions.set(id, { ...s, archived })
    },
    deliverAgentReport: (to, r) => void reports.push({ to, status: r.status, text: r.text }),
    onMeta: (l) => {
      metaListeners.add(l)
      return () => metaListeners.delete(l)
    },
    onRemoved: () => () => {},
    setBatchMembership: (id, masterId) => {
      const s = sessions.get(id)!
      sessions.set(id, { ...s, masterId, startedBy: s.startedBy ?? masterId })
    },
    batch: async (action, ids, options) => {
      batchCalls.push({ action, ids: [...ids], ...(options?.cleanup !== undefined ? { cleanup: options.cleanup } : {}) })
      for (const id of ids) {
        const s = sessions.get(id)
        if (!s) continue
        sessions.set(id, action === 'archive' ? { ...s, archived: true } : { ...s, status: 'stopped' })
      }
      return { attempted: [...ids], succeeded: [...ids], failed: [] }
    }
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
  const deltas: BatchPushState[] = []
  const deploy = fakeDeploy()
  const publish = fakePublish()
  const announced: string[] = []
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
      announce: (v) => announced.push(v),
      now: () => now,
      pushEveryMs: 250,
      ...extra
    })
    b.onChange((s, p) => {
      pushes.push(s)
      deltas.push(p)
    })
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
    batchCalls,
    runs,
    merges,
    pushes,
    deltas,
    deploy,
    publish,
    announced,
    make,
    landed,
    set,
    activity,
    tick: (ms: number) => (now += ms),
    refuseMerge: (why: string | null) => (refuseMerge = why),
    setOutcome: (f: typeof outcome) => (outcome = f)
  }
}

const steps = (s: BatchState) => Object.fromEntries(s.steps.map((x) => [x.id, [x.status, x.detail]]))
const flush = () => new Promise((r) => setTimeout(r, 0))
/** Poll until `cond` holds, a few seconds at most. */
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
/** A real shell for the shell steps: /bin/sh, so the test never sources a login profile. */
const sh: BatchesDeps['shell'] = (run, cwd, onLine) => spawnShellStep(run, cwd, onLine, '/bin/sh')
/** A shell step spec; the cwd is a real directory (the world's /repo is not one) unless the test says otherwise. */
const shell = (id: string, run: string, extra: Partial<{ name: string; cwd: string | null; when: 'all-done' | 'each-landing' }> = {}) =>
  ({ id, name: extra.name ?? id[0].toUpperCase() + id.slice(1), kind: 'shell' as const, run, ...(extra.cwd === null ? {} : { cwd: extra.cwd ?? tmpdir() }), ...(extra.when ? { when: extra.when } : {}) })

describe('Batches: the rows and the rules', () => {
  it("an untouched batch is empty with the master's roots pending, oldest first", () => {
    const w = world()
    const b = w.make()
    const state = b.get('m')
    expect(state.rules).toEqual({ land: 'as-they-finish', steps: [S.land, S.gate, S.release], then: 'notify' })
    expect(state.steps.map((s) => [s.id, s.kind, s.status, s.log])).toEqual([
      ['land', 'land', 'pending', []],
      ['gate', 'gate', 'pending', []],
      ['release', 'release', 'pending', []]
    ])
    expect(state).toMatchObject({ landed: [], pending: ['a', 'b'], held: [], blocked: null, finishedAt: null })
    expect(w.pushes).toEqual([])
  })

  it('setRules merges a patch, validates it, pushes, and the tool answers the line; a non-master is refused', () => {
    const w = world()
    const b = w.make()
    const master = w.sessions.get('m')!
    expect(b.rulesTool(master)).toBe('Rules: land as they finish · Gate · Release · then notify.')
    const answer = b.rulesTool(master, { land: 'all-at-once', steps: [S.land, S.gate, S.release, { ...S.deploy, name: 'Deploy to the box' }], summary: 'Land all, gate, release, deploy' })
    expect(answer).toMatch(/^Rules set: land all at once · Gate · Release · Deploy to the box · then notify — "Land all, gate, release, deploy"\. The app runs the steps when every thread of the batch is done \(2 now\)/)
    expect(b.rules('m')).toMatchObject({ land: 'all-at-once', steps: [S.land, S.gate, S.release, { ...S.deploy, name: 'Deploy to the box' }] })
    expect(w.pushes.at(-1)?.rules.land).toBe('all-at-once')
    expect(b.get('m').steps.map((s) => s.id)).toEqual(['land', 'gate', 'release', 'deploy'])
    expect(b.rulesTool(master, { land: 'moon' as never })).toMatch(/^refused: land/)
    // The list's own rules: unique ids, one per built-in kind, run on shell steps alone, a land step added at the front.
    expect(b.rulesTool(master, { steps: [S.gate, { ...S.gate, id: 'gate2' }] })).toBe('refused: two gate steps; one per built-in kind')
    expect(b.rulesTool(master, { steps: [S.gate, { id: 'gate', name: 'Smoke', kind: 'shell', run: 'true' }] })).toBe('refused: step id "gate" is used twice')
    expect(b.rulesTool(master, { steps: [{ id: 'smoke', name: 'Smoke', kind: 'shell' }] })).toBe('refused: shell step "smoke" has no run')
    expect(b.rulesTool(master, { steps: [{ ...S.gate, run: 'x' }] })).toBe('refused: step "gate" is gate, which takes no run')
    expect(b.rulesTool(master, { steps: [{ id: 'bad id', name: 'x', kind: 'shell', run: 'true' }] })).toMatch(/^refused: step id "bad id"/)
    expect(b.rulesTool(master, { steps: [{ id: 'smoke', name: 'Smoke', kind: 'shell', run: 'true' }] })).toMatch(/^Rules set: land all at once · Smoke · then notify/)
    expect(b.get('m').steps.map((s) => s.id)).toEqual(['land', 'smoke'])
    expect(b.rulesTool(w.sessions.get('a')!, { then: 'notify' })).toMatch(/^refused: batch_rules is for a master thread/)
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
    expect(set.handled && (set.result as BatchState).rules).toMatchObject({ then: 'archive-children', steps: [S.land, S.gate, S.release] })
    const stop = await handleBatch({ id: '4', method: 'batch.stopStep', params: { masterId: 'm', stepId: 'gate' } } as never, b, w.registry)
    expect(stop.handled && stop.result).toEqual({ stopped: false })
    expect(await handleBatch({ id: '5', method: 'session.list', params: {} } as never, b, w.registry)).toEqual({ handled: false })
  })

  it("a child's meta change reviews its batch through the registry's index by master alone", async () => {
    const w = world()
    const b = w.make()
    b.attach()
    const asked: string[] = []
    const own = w.registry.batchChildren
    w.registry.batchChildren = (masterId) => {
      asked.push(masterId)
      return own(masterId)
    }
    w.set('a', { status: 'running' })
    w.set('other', { status: 'running' })
    await Promise.resolve()
    await Promise.resolve()
    expect(asked.length).toBeGreaterThan(0)
    expect(new Set(asked)).toEqual(new Set(['m']))
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
    expect(state.steps.map((s) => s.id)).toEqual(['land', 'gate', 'release'])
  })

  it("a row from the fixed-five days reads its booleans as a steps list, keeping each step's telemetry", () => {
    const w = world()
    w.store.setSetting(
      'batch:m',
      JSON.stringify({
        masterId: 'm',
        rules: { land: 'all-at-once', gate: false, release: true, publish: true, deploy: 'box', then: 'archive-children' },
        steps: [{ id: 'land', status: 'passed', detail: '2 of 2 landed', at: 5, log: ['x landed'] }, { id: 'release', status: 'passed', detail: 'release-9 tagged', at: 6, log: [] }],
        landed: ['a']
      })
    )
    const state = w.make().get('m')
    expect(state.rules).toEqual({ land: 'all-at-once', steps: [S.land, S.release, S.publish, S.deploy], then: 'archive-children' })
    expect(state.steps.map((s) => [s.id, s.status, s.detail])).toEqual([
      ['land', 'passed', '2 of 2 landed'],
      ['release', 'passed', 'release-9 tagged'],
      ['publish', 'pending', ''],
      ['deploy', 'pending', '']
    ])
  })

  it('a new steps list keeps the telemetry of a step whose id and kind stay, renames it, and drops the rest', () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    expect(steps(b.get('m')).land[0]).toBe('running')
    b.setRules('m', { steps: [{ ...S.gate, name: 'Check' }, { id: 'smoke', name: 'Smoke', kind: 'shell', run: 'true' }] })
    const state = b.get('m')
    expect(state.steps.map((s) => [s.id, s.name, s.status])).toEqual([
      ['land', 'Land', 'running'],
      ['gate', 'Check', 'pending'],
      ['smoke', 'Smoke', 'pending']
    ])
    expect(state.steps[0].log).toEqual(['br-a landed'])
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
  it('runs gate, release (pushed), rows the master and wakes it; then the batch is closed', async () => {
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
      release: ['passed', 'release-277 tagged']
    })
    expect(state.finishedAt).toBe(1000)
    expect(state.steps[1].log).toContain('✓ vitest 40s passed')
    expect(state.steps[1].progress).toEqual({ done: 3, total: 3 })
    expect(state.steps[1].startedAt).toBe(1000)
    expect(state.steps[1].endedAt).toBe(1000)
    expect(w.rows.m.filter((e) => e.type === 'notice').map((e) => (e as { kind: string }).kind + ': ' + (e as { message: string }).message)).toEqual([
      'gate: Gate passed on master',
      'gate: Release passed on master',
      'batch: Batch done: 2 of 2 landed, gate passed in 1m 12s, release-277 tagged in 0s'
    ])
    expect(w.reports).toEqual([
      { to: 'm', status: 'done', text: expect.stringContaining('<batch-report>\nThe batch is done: 2 of 2 landed, gate passed in 1m 12s, release-277 tagged in 0s.') }
    ])
    expect(b.open('m')).toBe(false)
    // A second review runs nothing again.
    await b.review('m')
    expect(w.runs).toHaveLength(2)
  })

  it('a list of land alone: nothing run, the master still told', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { steps: [S.land] })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(w.runs).toHaveLength(0)
    expect(steps(b.get('m'))).toEqual({ land: ['passed', '1 of 2 landed, 1 left out'] })
    expect(w.reports.map((r) => r.status)).toEqual(['done'])
    expect(w.reports[0].text).toContain('The batch is done: 1 of 2 landed, 1 left out.')
  })

  it('nothing landed (research only): the land step says so, and the steps after it still run on the project checkout', async () => {
    const w = world({ children: [meta('m'), meta('r', { masterId: 'm', createdAt: 2, threadType: 'research' })] })
    const b = w.make()
    b.setRules('m', { steps: [S.land, S.gate, S.release] })
    await b.review('m')
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
    expect(steps(b.get('m'))).toEqual({ land: ['passed', 'nothing landed'], gate: ['passed', 'passed in 1m 12s'], release: ['passed', 'release-277 tagged'] })
    expect(w.reports[0].text).toContain('The batch is done: nothing landed, gate passed in 1m 12s, release-277 tagged in 0s.')
  })

  it('children that landed on their own (never through merge_branch) still get the gate and the release; deploy without a release step before it is skipped as needing one', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { steps: [S.land, S.gate, S.deploy] })
    w.set('b', { status: 'idle' })
    await b.review('m')
    expect(w.runs.map((r) => r.step)).toEqual(['gate'])
    expect(steps(b.get('m'))).toMatchObject({ land: ['passed', '0 of 2 landed, 2 left out'], gate: ['passed', 'passed in 1m 12s'], deploy: ['skipped', 'needs a release'] })
    expect(w.deploy.requested).toEqual([])
  })

  it('the land step counts only threads with a branch to land: planners never, a chat or research thread once it landed', async () => {
    const w = world({
      children: [
        meta('m'),
        meta('plan', { masterId: 'm', createdAt: 2, threadType: 'planning', status: 'done', planCompletedAt: 5, implementationId: 'a' }),
        meta('a', { masterId: 'm', createdAt: 3, planThreadId: 'plan' }),
        meta('impl', { masterId: 'm', createdAt: 4, status: 'done' }),
        meta('chat', { masterId: 'm', createdAt: 5, threadType: 'chat', status: 'done' }),
        meta('research', { masterId: 'm', createdAt: 6, threadType: 'research', status: 'done' })
      ]
    })
    const b = w.make()
    b.setRules('m', { steps: [S.land] })
    b.landed(w.landed('a'))
    expect(b.get('m').steps[0].detail).toBe('1 of 2 landed')
    b.landed(w.landed('chat'))
    await b.review('m')
    expect(steps(b.get('m'))).toEqual({ land: ['passed', '2 of 3 landed, 1 left out'] })
    expect(b.get('m').steps[0].progress).toEqual({ done: 2, total: 3 })
  })

  it("a planning child whose plan is complete holds the batch open until its build exists; the build then counts as a child", async () => {
    const w = world({ children: [meta('m'), meta('plan', { masterId: 'm', createdAt: 2, threadType: 'planning', status: 'done', planCompletedAt: 5 })] })
    const b = w.make()
    b.setRules('m', { steps: [S.land, S.gate] })
    await b.review('m')
    expect(w.runs).toHaveLength(0)
    expect(b.open('m')).toBe(true)
    w.set('plan', { implementationId: 'b' })
    w.sessions.set('b', meta('b', { masterId: 'm', createdAt: 3, planThreadId: 'plan', status: 'running' }))
    await b.review('m')
    expect(w.runs).toHaveLength(0)
    w.set('b', { status: 'idle' })
    b.landed(w.landed('b'))
    await b.review('m')
    expect(w.runs.map((r) => r.step)).toEqual(['gate'])
    expect(steps(b.get('m'))).toEqual({ land: ['passed', '1 of 1 landed'], gate: ['passed', 'passed in 1m 12s'] })
    expect(b.open('m')).toBe(false)
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
    // The step's detail is the failing step and its first error line, no duration; the master gets the long sentence.
    expect(steps(b.get('m')).gate).toEqual(['failed', 'vitest: FAIL x.test.ts'])
    expect(w.reports[0].text).toContain("The batch's gate FAILED at vitest in 1m 12s; nothing was tagged.")
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

  it("a red gate step's detail reads the step's printed tail first, the notice carries the same words, and fail() keeps it", async () => {
    const w = world()
    const b = w.make()
    const log = [
      'gate: commit tier, 3 steps: typecheck, vitest, build',
      '✓ typecheck 12s passed',
      '✗ vitest 40s failed',
      '',
      '--- vitest (last lines) ---',
      ' ❯ src/x.test.ts (3 tests | 1 failed) 40ms',
      ' FAIL  src/x.test.ts > suite > name',
      'AssertionError: expected 1 to be 2',
      '--- end vitest ---',
      '',
      'gate failed: vitest in 1m 12s'
    ].join('\n')
    w.setOutcome((o) => (o.step === 'gate' ? { ok: false, log, firstError: 'src/early.ts(1,1): error TS2322: early' } : {}))
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    const detail = 'vitest: FAIL  src/x.test.ts > suite > name'
    expect(steps(b.get('m')).gate).toEqual(['failed', detail])
    const notice = w.rows['m'].find((e) => e.type === 'notice' && e.kind === 'gate')
    expect(notice).toMatchObject({ message: 'Gate failed on master, at vitest', gate: { ok: false, detail } })
    expect(w.reports[0].text).toContain("The batch's gate FAILED at vitest")
  })

  it('a landing after the end keeps what landed, reopens the steps after land, and runs them again on the new head', async () => {
    const w = world()
    const b = w.make()
    // Cycle one: b idles on a HELD without landing; a landed. The engine ends the batch with b left out.
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a', 'feat-a', ['a: one']))
    await b.review('m')
    expect(steps(b.get('m')).land).toEqual(['passed', '1 of 2 landed, 1 left out'])
    expect(b.get('m').finishedAt).toBe(1000)
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
    // b runs again and lands: the earlier landing stays, the steps reopen, and the end runs once more.
    w.set('b', { status: 'running' })
    await b.review('m')
    b.landed(w.landed('b', 'feat-b', ['b: two']))
    let state = b.get('m')
    expect(state.landed).toEqual(['a', 'b'])
    expect(steps(state)).toMatchObject({ land: ['running', '2 of 2 landed'], gate: ['pending', ''], release: ['pending', ''] })
    expect(state.finishedAt).toBeNull()
    expect(state.steps[0].log).toEqual(['feat-a landed', 'feat-b landed'])
    w.set('b', { status: 'idle' })
    await b.review('m')
    state = b.get('m')
    expect(steps(state).land).toEqual(['passed', '2 of 2 landed'])
    expect(w.runs.map((r) => [r.step, r.notes ?? ''])).toEqual([
      ['gate', ''],
      ['release', 'T m; a: one'],
      ['gate', ''],
      ['release', 'T m; a: one; b: two']
    ])
    expect(w.reports.map((r) => r.status)).toEqual(['done', 'done'])
    expect(w.reports[1].text).toContain('2 of 2 landed')
  })

  it('archive-children archives every done child at the end', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { then: 'archive-children', steps: [S.land] })
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
    b.setRules('m', { steps: FIVE })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a', 'feat-a', ['a: one']))
    const review = b.review('m')
    await flush()
    expect(w.publish.calls).toEqual([{ sessionId: 'm', args: { sha: 'c0ffee0000000000000000000000000000000000', branch: 'master', version: '1.0.277', notes: 'T m; a: one' } }])
    expect(steps(b.get('m')).publish).toEqual(['running', 'v1.0.277 on the Mac'])
    expect(b.get('m').steps[3].progress).toEqual({ done: 0, total: 7, label: 'pulling' })
    w.publish.line('== release v1.0.277 from /Users/x/temp-code')
    w.publish.line('phase › gate')
    w.publish.line('phase › build')
    expect(b.get('m').steps[3].log).toEqual(['== release v1.0.277 from /Users/x/temp-code', 'phase › gate', 'phase › build'])
    expect(b.get('m').steps[3].progress).toEqual({ done: 0, total: 7, label: 'build' })
    w.publish.line('phase ✓ build 1m24s')
    w.publish.line('phase ✓ gate 1m11s')
    w.publish.line('phase › sign')
    expect(b.get('m').steps[3].progress).toEqual({ done: 2, total: 7, label: 'sign' })
    expect(await b.stopStep('m', 'publish')).toEqual({ stopped: true })
    expect(w.publish.stops).toEqual(['m'])
    for (const l of ['phase › pack', 'phase ✓ pack 15s', 'phase ✓ sign 2m40s', 'phase › upload', 'phase ✓ upload 48s', 'phase › feed', 'phase ✓ feed 6s', 'phase ✓ total 4m12s 1.0.277', 'phase › update', 'phase ✓ update 31s']) w.publish.line(l)
    expect(b.get('m').steps[3].progress).toEqual({ done: 7, total: 7 })
    w.tick(283_000)
    w.publish.finish({ ok: true, exit: 0, version: '1.0.277', text: 'Published 1.0.277 in 4m12s' })
    await flush()
    expect(steps(b.get('m')).publish).toEqual(['passed', 'v1.0.277 published in 4m43s'])
    expect(b.get('m').steps[3].log.at(-1)).toBe('== v1.0.277 published in 4m43s (gate 1m11s · build 1m24s · sign 2m40s · pack 15s · upload 48s · feed 6s · update 31s)')
    // The installed app is told at once.
    expect(w.announced).toEqual(['1.0.277'])
    expect(w.deploy.requested).toEqual(['v1.0.277'])
    expect(steps(b.get('m')).deploy).toEqual(['running', 'v1.0.277 requested'])
    // The store already carries the deploy in flight (the trigger restarts this process).
    expect(JSON.parse(w.store.getSetting('batch:m')!).deployRef).toBe('v1.0.277')
    w.deploy.line('== box-update v1.0.277 (2026-10-21T10:00:00Z)')
    w.deploy.line('SOURCE: release asset temp-code-out-1.0.277.tar.gz (sha256 verified) abc')
    w.deploy.line('MODULES: reused from build-1 (bun.lock unchanged, abc)')
    expect(b.get('m').steps[4].progress).toEqual({ done: 2, total: 7, label: 'modules' })
    w.deploy.line('BUILD: skipped; v1.0.277 abc is prebuilt and its modules are reused')
    w.deploy.line('TRIAL PASS: build-2 port=7690 sha=abc')
    w.deploy.line('COMMIT PASS: build-2 sha=abc')
    expect(b.get('m').steps[4].progress).toEqual({ done: 5, total: 7, label: 'commit' })
    w.tick(190_000)
    w.deploy.exit(0)
    await review
    await flush()
    expect(steps(b.get('m')).deploy).toEqual(['passed', 'v1.0.277 deployed in 3m10s'])
    expect(b.get('m').steps[4].progress).toEqual({ done: 7, total: 7 })
    expect(b.get('m').finishedAt).toBe(474_000)
    expect(w.reports.at(-1)?.text).toContain('gate passed in 1m 12s, release-277 tagged in 0s, v1.0.277 published in 4m43s, v1.0.277 deployed in 3m10s')
    // The deploy of a v1.0.N says so again (the publish may have run elsewhere).
    expect(w.announced).toEqual(['1.0.277', '1.0.277'])
    expect(await b.stopStep('m', 'publish')).toEqual({ stopped: false })
  })

  it('publish without a Mac fails the step with the reason; a Mac failure names the exit; deploy without publish takes master', async () => {
    const w = world()
    const b = w.make()
    w.publish.noMac()
    b.setRules('m', { steps: [S.land, S.gate, S.release, S.publish] })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(steps(b.get('m')).publish).toEqual(['failed', "The batch's publish cannot run: no Mac paired"])
    expect(w.reports.map((r) => r.status)).toEqual(['failed'])

    const w2 = world()
    const b2 = w2.make()
    b2.setRules('m', { steps: [S.land, S.gate, S.release, S.publish] })
    w2.set('b', { status: 'idle' })
    b2.landed(w2.landed('a'))
    const review = b2.review('m')
    await flush()
    w2.publish.finish({ ok: false, exit: 1, version: '1.0.277', text: 'notarization failed' })
    await review
    expect(steps(b2.get('m')).publish).toEqual(['failed', "The Mac's publish of v1.0.277 FAILED (exit 1): notarization failed"])

    const w3 = world()
    const b3 = w3.make()
    b3.setRules('m', { steps: [S.land, S.gate, S.release, S.deploy] })
    w3.set('b', { status: 'idle' })
    b3.landed(w3.landed('a'))
    const r3 = b3.review('m')
    await flush()
    expect(w3.deploy.requested).toEqual(['master'])
    w3.deploy.exit(1)
    await r3
    await flush()
    expect(steps(b3.get('m')).deploy).toEqual(['failed', 'exit 1'])
    expect(w3.announced).toEqual([])
    expect(w3.reports.at(-1)).toMatchObject({ status: 'failed', text: expect.stringContaining('The box deploy of master FAILED (exit 1)') })
    expect(b3.get('m').finishedAt).toBeNull()
  })

  it('a refused deploy fails the step without a follower; no trigger on this host fails it too', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { steps: [S.land, S.gate, S.release, S.deploy] })
    w.deploy.refuse('a deploy of the box is in progress; wait for it to finish')
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(steps(b.get('m')).deploy).toEqual(['failed', 'The box deploy was refused: a deploy of the box is in progress; wait for it to finish'])
    expect(b.open('m')).toBe(false)
    const w2 = world()
    const b2 = w2.make({ deploy: undefined })
    b2.setRules('m', { steps: [S.land, S.gate, S.release, S.deploy] })
    w2.set('b', { status: 'idle' })
    b2.landed(w2.landed('a'))
    await b2.review('m')
    expect(steps(b2.get('m')).deploy[0]).toBe('failed')
    expect(steps(b2.get('m')).deploy[1]).toContain('no deploy trigger')
  })

  it('the deploy survives a restart: a new instance over the same store reads the exit file, closes the step and runs then', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { steps: [S.land, S.gate, S.release, S.deploy], then: 'archive-children' })
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
    expect(steps(b2.get('m')).deploy).toEqual(['passed', 'master deployed in 0s'])
    // A deploy of master is no release: nothing told to the installed app.
    expect(w.announced).toEqual([])
    expect(b2.get('m').finishedAt).toBe(1000)
    expect(w.sessions.get('a')?.archived).toBe(true)
    expect(w.reports.at(-1)?.status).toBe('done')
    expect(b2.get('m').steps[3].log).toContain('== host restarted; following the deploy of master')
    await review
  })

  it('a gate, a release or a land running at the restart is failed with the master told, and the batch can close', async () => {
    const w = world()
    w.store.setSetting(
      'batch:m',
      JSON.stringify({ masterId: 'm', rules: { land: 'as-they-finish', steps: [S.land, S.gate, S.release], then: 'notify' }, steps: [{ id: 'gate', status: 'running', detail: 'typecheck', at: 1, log: [] }], landed: ['a'] })
    )
    const b = w.make()
    await b.resumeAfterBoot()
    expect(steps(b.get('m')).gate).toEqual(['failed', 'the host restarted during the step'])
    expect(w.reports[0]).toMatchObject({ status: 'failed', text: expect.stringContaining('was running when this host restarted') })
    // No step runs any more: with every child done the batch would close (sessions-liveness P3).
    expect(b.get('m').steps.some((s) => s.status === 'running')).toBe(false)
  })

  it('a paused child and one whose turn ended without completing block the batch, each with its own words', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    w.set('b', { status: 'paused' })
    await b.review('m')
    expect(b.get('m').blocked).toEqual({ sessionId: 'b', why: 'paused' })
    expect(w.reports.at(-1)).toMatchObject({ status: 'blocked', text: expect.stringContaining('batch thread "T b" (b) is paused: Resume it or remove it') })
    // Idle with a user turn but no completed one: no-turn.
    w.registry.hasUserText = () => true
    w.registry.hasCompletedTurn = (id) => id !== 'b'
    w.set('b', { status: 'idle' })
    await b.review('m')
    expect(b.get('m').blocked).toEqual({ sessionId: 'b', why: 'no-turn' })
    expect(w.reports.at(-1)).toMatchObject({ status: 'blocked', text: expect.stringContaining('ended its turn without completing: send it a message or remove it') })
    // The same child when a person's Stop ended that turn: interrupted, "was stopped".
    w.registry.lastTurnStopped = (id) => id === 'b'
    await b.review('m')
    expect(b.get('m').blocked).toEqual({ sessionId: 'b', why: 'interrupted' })
    expect(w.reports.at(-1)).toMatchObject({ status: 'blocked', text: expect.stringContaining('was stopped: send it a message or remove it') })
    w.registry.lastTurnStopped = () => false
    // A completed turn clears it.
    w.registry.hasCompletedTurn = () => true
    await b.review('m')
    expect(b.get('m').blocked).toBeNull()
  })

  it('lists the children it counts done: done, or idle on a completed turn with no failure; never paused or idle without a completed turn', async () => {
    const w = world({
      children: [
        meta('m'),
        meta('a', { masterId: 'm', createdAt: 2, status: 'done' }),
        meta('b', { masterId: 'm', createdAt: 3, status: 'idle' }),
        meta('c', { masterId: 'm', createdAt: 4, status: 'idle' }),
        meta('d', { masterId: 'm', createdAt: 5, status: 'paused' }),
        meta('e', { masterId: 'm', createdAt: 6, status: 'idle', failure: { kind: 'quota', account: null, summary: 'Usage cap', cause: 'usage cap' } })
      ]
    })
    w.registry.hasCompletedTurn = (id) => id !== 'c'
    const b = w.make()
    expect(b.get('m').done).toEqual(['a', 'b'])
    // What the wire lists done is exactly what Archive done archives.
    await b.archive('m', 'done')
    expect(w.batchCalls).toEqual([{ action: 'archive', ids: ['a', 'b'], cleanup: false }])
  })

  it('a publish that was running at the restart is failed with a pointer to the Mac', async () => {
    const w = world()
    w.store.setSetting(
      'batch:m',
      JSON.stringify({ masterId: 'm', rules: { land: 'as-they-finish', steps: [S.land, S.gate, S.release, S.publish], then: 'notify' }, steps: [{ id: 'publish', status: 'running', detail: 'v1.0.9 on the Mac', at: 1, log: [] }], landed: ['a'] })
    )
    const b = w.make()
    await b.resumeAfterBoot()
    expect(steps(b.get('m')).publish).toEqual(['failed', 'the host restarted during the publish; its outcome is on the Mac'])
    expect(w.reports[0]).toMatchObject({ status: 'failed', text: expect.stringContaining("check the Mac's publish log") })
  })

  it('a publish running at the restart whose version this host now runs passed: the Mac restarted into its own release', async () => {
    const w = world()
    w.store.setSetting(
      'batch:m',
      JSON.stringify({ masterId: 'm', rules: { land: 'as-they-finish', steps: [S.land, S.gate, S.release, S.publish], then: 'notify' }, version: '1.0.9', steps: [{ id: 'publish', status: 'running', detail: 'v1.0.9 on this Mac', at: 1, log: [] }], landed: ['a'] })
    )
    const b = w.make({ version: '1.0.9' })
    await b.resumeAfterBoot()
    expect(steps(b.get('m')).publish).toEqual(['passed', 'v1.0.9 published; this host restarted into it'])
    expect(w.reports[0]).toMatchObject({ status: 'done', text: expect.stringContaining('restarted into it') })
  })

  it('the deploy follower waits for a box it cannot reach and closes on the push that follows', async () => {
    const w = world()
    const reachable = { value: true }
    const b = w.make({
      deploy: {
        deploy: w.deploy.deploy,
        subscribe: w.deploy.subscribe,
        status: async () => {
          if (!reachable.value) throw new Error('the box is not connected')
          return w.deploy.status()
        }
      }
    })
    b.setRules('m', { steps: [S.land, S.gate, S.release, S.deploy] })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    reachable.value = false
    const review = b.review('m')
    await flush()
    expect(b.get('m').steps[3].log).toContain('== waiting for the box: the box is not connected')
    expect(steps(b.get('m')).deploy[0]).toBe('running')
    w.deploy.exit(0)
    await review
    await flush()
    expect(steps(b.get('m')).deploy[0]).toBe('passed')
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

  it("the push carries each step's log as the lines since the last push, numbered from the step's start; batch.get stays whole", async () => {
    const w = world()
    const b = w.make()
    w.setOutcome((o) => (o.step === 'gate' ? { log: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') } : {}))
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    b.flush()
    // A client folding the deltas in order holds exactly the step's log.
    const gate = w.deltas.map((d) => d.steps.find((s) => s.id === 'gate')!).filter((s) => s.startedAt !== undefined)
    let held: string[] = []
    for (const step of gate) {
      expect(step.log.from).toBe(held.length)
      held = [...held, ...step.log.lines]
    }
    const whole = b.get('m').steps.find((s) => s.id === 'gate')!
    expect(held).toEqual(whole.log)
    expect(whole.logCount).toBe(12)
    expect(gate.at(-1)!.logCount).toBe(12)
    // Nothing new since: the next push sends no lines, from the count.
    w.tick(300)
    b.setRules('m', { summary: 'again' })
    const quiet = w.deltas.at(-1)!.steps.find((s) => s.id === 'gate')!
    expect(quiet.log).toEqual({ from: 12, lines: [] })
    // handleBatch's batch.get answers the whole log, never a delta.
    const got = (await handleBatch({ id: '1', method: 'batch.get', params: { masterId: 'm' } }, b, w.registry)) as { result: BatchState }
    expect(got.result.steps.find((s) => s.id === 'gate')!.log).toHaveLength(12)
  })

  it('past the 200 kept lines a push starts where the kept log starts, so a client behind it asks for the whole state', async () => {
    const w = world()
    const b = w.make()
    w.setOutcome((o) => (o.step === 'gate' ? { log: Array.from({ length: 260 }, (_, i) => `line ${i}`).join('\n') } : {}))
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    b.flush()
    const gate = w.deltas.map((d) => d.steps.find((s) => s.id === 'gate')!).filter((s) => s.log.lines.length)
    const last = gate.at(-1)!
    expect(last.logCount).toBe(260)
    expect(last.log.from).toBe(60)
    expect(last.log.lines[0]).toBe('line 60')
    expect(last.log.from + last.log.lines.length).toBe(260)
  })

  it('a push goes out at once when the last one is old enough', () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    expect(w.pushes).toHaveLength(1)
    w.tick(300)
    b.setRules('m', { steps: [S.land, S.release] })
    expect(w.pushes).toHaveLength(2)
  })
})

describe('Batches: batch_gate', () => {
  it('refused off the master or before anything landed', async () => {
    const w = world({ master: 'z' })
    const b = w.make()
    expect(await b.gate(w.sessions.get('m')!)).toMatch(/^refused: batch_gate is for a master thread/)
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
    expect(answer).toBe('passed in 1m 12s, release-277 tagged')
    expect(w.runs.map((r) => [r.step, r.cwd, r.branch, r.push ?? false, r.notes])).toEqual([
      ['gate', '/repo', 'master', false, undefined],
      ['release', '/repo', 'master', true, 'T m; a: one; a: two']
    ])
    const state = b.get('m')
    expect(steps(state)).toMatchObject({ land: ['passed', '1 of 2 landed, 1 left out'], gate: ['passed', 'passed in 1m 12s'], release: ['passed', 'release-277 tagged'] })
    expect(w.rows.m.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message)).toEqual(['Gate passed on master', 'Release passed on master'])
  })

  it('a red gate fails the step and tags nothing; release false runs the gate alone; one at a time', async () => {
    const w = world()
    const b = w.make()
    b.landed(w.landed('a'))
    w.setOutcome((o) => (o.step === 'gate' ? { ok: false, log: '✓ typecheck 12s passed\n✗ vitest 40s failed\nFAIL x.test.ts' } : {}))
    const answer = await b.gate(w.sessions.get('m')!)
    expect(answer).toMatch(/^FAILED at vitest in 1m 12s; nothing was tagged\./)
    expect(steps(b.get('m')).gate).toEqual(['failed', 'vitest: FAIL x.test.ts'])
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

  it('helpers: releaseTag', () => {
    expect(releaseTag('released v277 (tag release-277, package.json 1.0.277) — publish it with: bun run release:publish')).toBe('release-277')
    expect(releaseTag('nothing')).toBeNull()
  })
})

describe('Batches: shell steps', () => {
  it('run in the order written among the built-in kinds, through the shell in the cwd given, their lines in the log; the done line names each', async () => {
    const w = world()
    const b = w.make({ shell: sh })
    b.setRules('m', { steps: [S.land, shell('build', 'echo building; pwd', { cwd: '/tmp' }), S.gate, shell('smoke', 'echo smoke ok; echo warn >&2', { name: 'Smoke test' })] })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    const state = b.get('m')
    expect(state.steps.map((s) => [s.id, s.status])).toEqual([
      ['land', 'passed'],
      ['build', 'passed'],
      ['gate', 'passed'],
      ['smoke', 'passed']
    ])
    // pwd prints the real path: /private/tmp on macOS, /tmp on Linux.
    expect(state.steps[1].log).toEqual(['$ echo building; pwd', 'building', realpathSync('/tmp'), '== Build passed in 0s'])
    expect(state.steps[3].log.slice(0, 1)).toEqual(['$ echo smoke ok; echo warn >&2'])
    expect(state.steps[3].log.slice(1, 3).sort()).toEqual(['smoke ok', 'warn'])
    expect(state.steps[1].startedAt).toBe(1000)
    expect(state.steps[1].endedAt).toBe(1000)
    // The gate ran between the two shell steps.
    expect(w.runs.map((r) => r.step)).toEqual(['gate'])
    expect(w.reports.at(-1)?.text).toContain('The batch is done: 1 of 2 landed, 1 left out, Build passed in 0s, gate passed in 1m 12s, Smoke test passed in 0s.')
    expect(b.open('m')).toBe(false)
    // A step without a cwd runs in the project checkout; a missing directory is the step's failure.
    const w2 = world()
    const seen: { run: string; cwd: string }[] = []
    const b2 = w2.make({
      shell: (run, cwd, onLine) => {
        seen.push({ run, cwd })
        return sh(run, cwd, onLine)
      }
    })
    b2.setRules('m', { steps: [S.land, shell('here', 'true', { cwd: null })] })
    w2.set('b', { status: 'idle' })
    b2.landed(w2.landed('a'))
    await b2.review('m')
    expect(seen).toEqual([{ run: 'true', cwd: '/repo' }])
    expect(steps(b2.get('m')).here[0]).toBe('failed')
    expect(b2.get('m').steps[1].log.some((l) => /ENOENT/.test(l))).toBe(true)
  })

  it('a non-zero exit fails the step with the exit and the last line, tells the master, and runs nothing after', async () => {
    const w = world()
    const b = w.make({ shell: sh })
    b.setRules('m', { steps: [S.land, shell('build', 'echo compiling; echo "error: boom" >&2; exit 3'), S.gate] })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(steps(b.get('m'))).toEqual({ land: ['passed', '1 of 2 landed, 1 left out'], build: ['failed', 'exit 3 after 0s, error: boom'], gate: ['pending', ''] })
    expect(w.runs).toHaveLength(0)
    expect(w.reports.map((r) => r.status)).toEqual(['failed'])
    expect(w.reports[0].text).toContain('The batch\'s step "Build" FAILED: exit 3 after 0s, error: boom')
    expect(w.reports[0].text).toContain('error: boom')
    expect(b.get('m').finishedAt).toBeNull()
  })

  it('stopStep kills a running shell step, which fails as stopped; a step not running cannot be stopped', async () => {
    const w = world()
    const b = w.make({ shell: sh })
    b.setRules('m', { steps: [S.land, shell('slow', 'echo started; sleep 30; echo never'), S.gate] })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    const review = b.review('m')
    await until(() => b.get('m').steps[1].log.includes('started'))
    expect(steps(b.get('m')).slow).toEqual(['running', 'running'])
    expect(await b.stopStep('m', 'gate')).toEqual({ stopped: false })
    expect(await b.stopStep('m', 'nope')).toEqual({ stopped: false })
    expect(await b.stopStep('m', 'slow')).toEqual({ stopped: true })
    await review
    expect(steps(b.get('m')).slow).toEqual(['failed', 'stopped after 0s'])
    expect(steps(b.get('m')).gate).toEqual(['pending', ''])
    expect(w.reports[0].text).toContain('"Slow" FAILED: stopped after 0s')
  })

  it('an each-landing step runs after every landing and keeps its last outcome at the end; a red one tells the master and never blocks the end', async () => {
    const w = world()
    const b = w.make({ shell: sh })
    const log: string[] = []
    const counting: BatchesDeps['shell'] = (run, cwd, onLine) => {
      log.push(run)
      return sh(run, cwd, onLine)
    }
    const b2 = w.make({ shell: counting })
    void b
    b2.setRules('m', { steps: [S.land, shell('dev', 'echo deployed to dev', { name: 'Deploy to dev', when: 'each-landing' }), S.gate] })
    b2.landed(w.landed('a'))
    await until(() => steps(b2.get('m')).dev?.[0] === 'passed')
    expect(log).toEqual(['echo deployed to dev'])
    expect(b2.get('m').steps[1].log).toContain('deployed to dev')
    // The gate has not run: b is still queued.
    expect(w.runs).toHaveLength(0)
    w.set('b', { status: 'idle' })
    b2.landed(w.landed('b'))
    await until(() => log.length === 2)
    await until(() => b2.get('m').finishedAt !== null)
    // The end ran the gate and release, and left the each-landing step as it stood.
    expect(w.runs.map((r) => r.step)).toEqual(['gate'])
    expect(steps(b2.get('m'))).toEqual({ land: ['passed', '2 of 2 landed'], dev: ['passed', 'passed in 0s'], gate: ['passed', 'passed in 1m 12s'] })
    expect(w.reports.at(-1)?.text).toContain('The batch is done: 2 of 2 landed, Deploy to dev passed in 0s, gate passed in 1m 12s.')
    // A red each-landing step: the master hears, the end still comes.
    const w3 = world()
    const b3 = w3.make({ shell: sh })
    b3.setRules('m', { steps: [S.land, shell('dev', 'exit 2', { when: 'each-landing' }), S.gate] })
    w3.set('b', { status: 'idle' })
    b3.landed(w3.landed('a'))
    await until(() => w3.reports.length >= 2)
    expect(w3.reports.map((r) => r.status)).toEqual(['failed', 'done'])
    expect(w3.reports[0].text).toContain('"Dev" FAILED after a landing: exit 2 after 0s')
    expect(steps(b3.get('m')).gate[0]).toBe('passed')
  })

  it('a shell step running at a restart is failed as such, and the master told', async () => {
    const w = world()
    w.store.setSetting(
      'batch:m',
      JSON.stringify({ masterId: 'm', rules: { land: 'as-they-finish', steps: [S.land, shell('build', 'make'), S.gate], then: 'notify' }, steps: [{ id: 'build', status: 'running', detail: 'running', at: 1, log: ['$ make'] }], landed: ['a'] })
    )
    const b = w.make({ shell: sh })
    await b.resumeAfterBoot()
    expect(steps(b.get('m')).build).toEqual(['failed', 'the host restarted during the step'])
    expect(w.reports[0]).toMatchObject({ status: 'failed', text: expect.stringContaining('"Build" was running when this host restarted') })
  })
})

describe('Batches: adopt and archive', () => {
  it('adopt takes unarchived roots of no batch into the master\'s, setting startedBy when empty; refuses the rest, each with its why; pushes', async () => {
    const w = world({ children: [meta('m'), meta('a', { masterId: 'm' }), meta('loose'), meta('started', { startedBy: 'chat' }), meta('n', { isMaster: true }), meta('sub', { parentId: 'loose' }), meta('gone', { archived: true }), meta('other', { masterId: 'n' })] })
    const b = w.make()
    const r = b.adopt('m', ['loose', 'started', 'a', 'm', 'n', 'sub', 'gone', 'other', 'nope', 'loose'])
    expect(r.adopted).toEqual(['loose', 'started', 'a'])
    expect(r.refused).toEqual([
      { sessionId: 'm', why: 'it is the master itself' },
      { sessionId: 'n', why: 'it is a master thread' },
      { sessionId: 'sub', why: 'it is a subagent' },
      { sessionId: 'gone', why: 'it is archived' },
      { sessionId: 'other', why: 'it is in the batch of n' },
      { sessionId: 'nope', why: 'unknown thread' }
    ])
    expect(w.sessions.get('loose')).toMatchObject({ masterId: 'm', startedBy: 'm' })
    expect(w.sessions.get('started')).toMatchObject({ masterId: 'm', startedBy: 'chat' })
    expect(r.state.pending).toEqual(['a', 'loose', 'started'])
    expect(w.pushes.at(-1)?.pending).toEqual(['a', 'loose', 'started'])
    // Off a master: everything refused.
    expect(b.adopt('loose', ['a']).refused).toEqual([{ sessionId: 'a', why: 'loose is not a master thread' }])
    // The tool's answer.
    expect(await b.adoptTool(w.sessions.get('m')!, { threadId: 'sub' })).toBe('refused: it is a subagent')
    expect(await b.adoptTool(w.sessions.get('loose')!, { threadId: 'a' })).toMatch(/^refused: adopt_thread is for a master thread/)
    w.sessions.set('fresh', meta('fresh', { title: 'Fresh one' }))
    expect(await b.adoptTool(w.sessions.get('m')!, { threadId: 'fresh' })).toBe('Adopted "Fresh one" (fresh) into your batch: its settles reach you from here, and it counts toward the batch\'s end.')
  })

  it('archive done archives the done children through the fleet\'s batch with the cleanup flag; all stops the live ones first; the master stays', async () => {
    const w = world({ children: [meta('m'), meta('a', { masterId: 'm', createdAt: 2 }), meta('b', { masterId: 'm', createdAt: 3, status: 'running' }), meta('q', { masterId: 'm', createdAt: 4, status: 'queued' }), meta('f', { masterId: 'm', createdAt: 5, status: 'idle' })] })
    const b = w.make()
    // a has a turn behind it (done); f is idle with none (not done).
    const done = await b.archive('m', 'done', true)
    expect(done.succeeded).toEqual(['a'])
    expect(w.batchCalls).toEqual([{ action: 'archive', ids: ['a'], cleanup: true }])
    expect(w.sessions.get('a')?.archived).toBe(true)
    expect(w.sessions.get('m')?.archived).toBe(false)
    const all = await b.archive('m', 'all')
    expect(all.succeeded).toEqual(['b', 'q', 'f'])
    expect(w.batchCalls.slice(1)).toEqual([
      { action: 'stop', ids: ['b', 'f'] },
      { action: 'archive', ids: ['b', 'q', 'f'], cleanup: false }
    ])
    expect(w.sessions.get('m')?.archived).toBe(false)
    expect(await b.archive('m', 'all')).toEqual({ attempted: [], succeeded: [], failed: [] })
  })

  it('handleBatch: batch.adopt and batch.archive', async () => {
    const w = world({ children: [meta('m'), meta('a', { masterId: 'm' }), meta('loose')] })
    const b = w.make()
    const adopt = await handleBatch({ id: '1', method: 'batch.adopt', params: { masterId: 'm', sessionIds: ['loose'] } } as never, b, w.registry)
    expect(adopt.handled && (adopt.result as { adopted: string[] }).adopted).toEqual(['loose'])
    const archive = await handleBatch({ id: '2', method: 'batch.archive', params: { masterId: 'm', which: 'done' } } as never, b, w.registry)
    expect(archive.handled && (archive.result as { succeeded: string[] }).succeeded).toEqual(['a'])
    expect(w.batchCalls).toEqual([{ action: 'archive', ids: ['a'], cleanup: false }])
  })
})

// ── the batch across hosts ───────────────────────────────────────────

import type { RemoteChildRecord } from './crossHostAgents'
const MACID = `env_${'m'.repeat(22)}`
const far = (sessionId: string, patch: Partial<RemoteChildRecord> = {}): RemoteChildRecord => ({
  environmentId: MACID,
  sessionId,
  title: `Far ${sessionId}`,
  kind: 'started',
  status: 'running',
  cwd: '/Users/landon/IdeaProjects/repo',
  provider: 'codex',
  model: 'gpt-6.1-sol',
  agentType: 'implementer',
  threadType: 'implementation',
  masterId: 'm',
  seenAt: 5,
  ...patch
})

/** A fake of the batch's reach to other hosts (crossHostAgents.ts): records set by hand, actions logged. */
function fakeRemote(records: RemoteChildRecord[]) {
  const acts: { action: string; ids?: readonly string[] }[] = []
  const adopts: string[][] = []
  let unreachable: string[] = []
  const remote = {
    records,
    acts,
    adopts,
    down: (hosts: string[]) => (unreachable = hosts),
    children: (masterId: string) => records.filter((r) => r.masterId === masterId),
    refresh: async (masterId: string) => ({ children: records.filter((r) => r.masterId === masterId), unreachable }),
    act: async (_masterId: string, action: string, ids?: readonly string[]) => {
      acts.push({ action, ...(ids ? { ids } : {}) })
      const hit = records.filter((r) => !ids || ids.includes(`${r.environmentId}:${r.sessionId}`))
      if (action === 'archive') for (const r of hit) delete r.masterId
      return { succeeded: hit.map((r) => `${r.environmentId}:${r.sessionId}`), failed: [] }
    },
    adopt: async (_master: SessionMeta, ids: readonly string[]) => {
      adopts.push([...ids])
      return { adopted: ids.filter((id) => id.endsWith(':ok')), refused: ids.filter((id) => !id.endsWith(':ok')).map((id) => ({ sessionId: id, why: 'it is a subagent' })) }
    },
    hostName: (id: string) => (id === MACID ? 'Landon Mac' : null)
  }
  return remote
}

describe('Batches: children on other hosts', () => {
  it('batch.get lists every child with its host and type; a far child running keeps the batch open; idle counts as done there', async () => {
    const w = world({ children: [meta('m'), meta('a', { masterId: 'm', threadType: 'implementation', provider: 'claude', model: 'sonnet' })] })
    const remote = fakeRemote([far('x1')])
    const b = w.make({ environmentId: 'env_box', remote })
    const state = b.get('m')
    expect(state.children).toEqual([
      { sessionId: 'a', environmentId: 'env_box', title: 'T a', status: 'idle', threadType: 'implementation', provider: 'claude', model: 'sonnet' },
      { sessionId: 'x1', environmentId: MACID, title: 'Far x1', status: 'running', threadType: 'implementation', provider: 'codex', model: 'gpt-6.1-sol', seenAt: 5, linkDown: false }
    ])
    expect(state.pending).toEqual(['a', `${MACID}:x1`])
    expect(b.open('m')).toBe(true)
    b.landed(w.landed('a'))
    await b.review('m')
    expect(w.runs).toHaveLength(0)
    remote.records[0].status = 'idle'
    await b.review('m')
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
    expect(b.open('m')).toBe(false)
  })
  it('a far landing is recorded under <env>:<id>, the land step fetches origin before the gate, and the log names the host', async () => {
    const w = world({ children: [meta('m'), meta('a', { masterId: 'm' })] })
    const remote = fakeRemote([far('x1')])
    const fetched: string[] = []
    const b = w.make({ remote, fetchFastForward: async (cwd, target) => (fetched.push(`${cwd}@${target}`), { sha: 'feedface00000000', merged: true, pushed: false }) })
    b.landed(w.landed('a'))
    expect(b.remoteLanding({ masterId: 'm', environmentId: MACID, sessionId: 'x1', phase: 'ask', branch: 'far-branch', target: 'master', subjects: ['x1: far work'] })).toEqual({ hold: false })
    expect(b.remoteLanding({ masterId: 'm', environmentId: MACID, sessionId: 'x1', phase: 'landed', branch: 'far-branch', target: 'master', subjects: ['x1: far work'], sha: 'abc' })).toEqual({ hold: false })
    expect(b.get('m').landed).toEqual(['a', `${MACID}:x1`])
    expect(b.get('m').steps[0].log).toContain('far-branch landed on Landon Mac')
    remote.records[0].status = 'done'
    await b.review('m')
    expect(fetched).toEqual(['/repo@master'])
    expect(b.get('m').steps[0].log).toContain('fetched origin: master at feedface00')
    expect(w.runs.map((r) => [r.step, r.notes])).toEqual([
      ['gate', undefined],
      ['release', 'T m; a: did it; x1: far work']
    ])
    expect(b.get('m').steps[0].detail).toBe('2 of 2 landed')
  })
  it('all at once: a far landing is held with its host (pushed to origin there), and the end merges it from origin in landing order', async () => {
    const w = world({ children: [meta('m'), meta('a', { masterId: 'm' })] })
    const remote = fakeRemote([far('x1', { status: 'idle' })])
    const fromOrigin: string[] = []
    const b = w.make({ remote, mergeFromOrigin: async (cwd, branch, target, push) => (fromOrigin.push(`${cwd} ${branch}→${target} push=${push}`), { sha: 'beef000000000000', merged: true, pushed: push }), fetchFastForward: async () => ({ sha: 'x', merged: false, pushed: false }) })
    b.setRules('m', { land: 'all-at-once' })
    expect(b.remoteLanding({ masterId: 'm', environmentId: MACID, sessionId: 'x1', phase: 'ask', branch: 'far-branch', target: 'master', subjects: ['x1: far'] })).toEqual({ hold: true })
    expect(b.hold(w.sessions.get('a')!, { cwd: '/wt-a', branch: 'near', target: 'master', push: true, subjects: ['a: near'] })).toContain('HELD')
    expect(b.get('m').held).toEqual([`${MACID}:x1`, 'a'])
    expect(b.get('m').steps[0].log).toContain('far-branch held for the end (pushed to origin from Landon Mac)')
    await b.review('m')
    expect(fromOrigin).toEqual(['/repo far-branch→master push=true'])
    expect(w.merges).toEqual([{ cwd: '/wt-a', branch: 'near', target: 'master', push: true }])
    expect(b.get('m').landed).toEqual([`${MACID}:x1`, 'a'])
    expect(b.get('m').steps[0].log).toContain('far-branch merged from origin at beef000000')
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
  })
  it('a host out of reach blocks the end naming the host and the child; the master is told once; the host back unblocks', async () => {
    const w = world({ children: [meta('m'), meta('a', { masterId: 'm' })] })
    const remote = fakeRemote([far('x1')])
    const b = w.make({ remote, fetchFastForward: async () => ({ sha: 'x', merged: false, pushed: false }) })
    b.landed(w.landed('a'))
    remote.down([MACID])
    await b.review('m')
    expect(b.get('m').blocked).toEqual({ sessionId: `${MACID}:x1`, why: 'unreachable', environmentId: MACID })
    expect(b.get('m').children?.[1].linkDown).toBe(true)
    expect(w.reports).toEqual([{ to: 'm', status: 'blocked', text: expect.stringContaining('"Far x1" (' + MACID + ':x1) on Landon Mac is out of reach') }])
    await b.review('m')
    expect(w.reports).toHaveLength(1)
    expect(w.runs).toHaveLength(0)
    remote.down([])
    remote.records[0].status = 'error'
    await b.review('m')
    expect(b.get('m').blocked).toEqual({ sessionId: `${MACID}:x1`, why: 'errored' })
    expect(w.reports.at(-1)?.text).toContain('on Landon Mac errored')
    remote.records[0].status = 'done'
    await b.review('m')
    expect(b.get('m').blocked).toBeNull()
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
  })
  it('cascade reaches the far children; archive done lists them in succeeded and takes them out of the batch; all archives the running ones too; then archive-children does the same', async () => {
    const w = world({ children: [meta('m'), meta('a', { masterId: 'm' })] })
    const remote = fakeRemote([far('x1', { status: 'idle' }), far('x2')])
    const b = w.make({ remote })
    await b.cascade('m', 'pause')
    await b.cascade('m', 'resume')
    expect(remote.acts).toEqual([{ action: 'pause' }, { action: 'resume' }])
    const done = await b.archive('m', 'done')
    expect(done.succeeded).toEqual(['a', `${MACID}:x1`])
    expect(remote.acts.at(-1)).toEqual({ action: 'archive', ids: [`${MACID}:x1`] })
    expect(b.get('m').children?.map((c) => c.sessionId)).toEqual(['x2'])
    const all = await b.archive('m', 'all')
    expect(all.succeeded).toEqual([`${MACID}:x2`])
    expect(b.get('m').children).toEqual([])
    // then: archive-children at the end archives the far done ones.
    const w2 = world({ children: [meta('m'), meta('a', { masterId: 'm' })] })
    const remote2 = fakeRemote([far('y1', { status: 'done' })])
    const b2 = w2.make({ remote: remote2, fetchFastForward: async () => ({ sha: 'x', merged: false, pushed: false }) })
    b2.setRules('m', { then: 'archive-children' })
    b2.landed(w2.landed('a'))
    await b2.review('m')
    expect(remote2.acts).toEqual([{ action: 'archive', ids: [`${MACID}:y1`] }])
  })
  it('adoptAll sends <env>:<id> ids to their hosts and merges the refusals with the local ones; without the reach they are refused as such', async () => {
    const w = world({ children: [meta('m'), meta('loose')] })
    const remote = fakeRemote([])
    const b = w.make({ remote })
    const r = await b.adoptAll('m', ['loose', `${MACID}:ok`, `${MACID}:sub`, 'nope'])
    expect(r.adopted).toEqual(['loose', `${MACID}:ok`])
    expect(r.refused).toEqual([
      { sessionId: 'nope', why: 'unknown thread' },
      { sessionId: `${MACID}:sub`, why: 'it is a subagent' }
    ])
    expect(remote.adopts).toEqual([[`${MACID}:ok`, `${MACID}:sub`]])
    const plain = world({ children: [meta('m')] }).make()
    expect((await plain.adoptAll('m', [`${MACID}:ok`])).refused).toEqual([{ sessionId: `${MACID}:ok`, why: 'threads on other hosts are not available here' }])
    const answer = await handleBatch({ id: '1', method: 'batch.adopt', params: { masterId: 'm', sessionIds: [`${MACID}:ok`] } } as never, b, w.registry as never)
    expect(answer.handled).toBe(true)
    expect(((answer as { result: { adopted: string[] } }).result).adopted).toEqual([`${MACID}:ok`])
  })
})

describe('the board: batch.board, digests and their watchers', () => {
  afterEach(() => vi.useRealTimers())

  /** A host with a master m and children a (implementation), r (research, waiting), x (errored); n is another master's. */
  function board(opts: { watched?: (masterId: string) => boolean } = {}) {
    const sessions = new Map<string, SessionMeta>(
      [
        meta('a', { masterId: 'm', createdAt: 1, status: 'running' }),
        meta('r', { masterId: 'm', createdAt: 2, status: 'waiting', threadType: 'research' }),
        meta('x', { masterId: 'm', createdAt: 3, status: 'error', failure: { kind: 'rate_limited', account: null, summary: 'Rate limited until 14:00', cause: '429' } }),
        meta('y', { masterId: 'n', createdAt: 4 })
      ].map((s) => [s.id, s])
    )
    const todos = new Map<string, { status: string; name: string }[]>([
      ['a', [{ status: 'completed', name: 'Read the brief' }, { status: 'in_progress', name: 'Write the view' }]]
    ])
    const notes = new Map<string, string>([['r', '## Goal\n\nx\n\n## State\n\n- Three sources read, two to go\n']])
    const row = (sessionId: string, seq: number, event: AgentEvent): EventRow => ({ sessionId, seq, ts: seq, event })
    const tails = new Map<string, EventRow[]>([
      ['a', [row('a', 4, { type: 'assistant-text', text: 'Wrote the view.\nMore below.', delta: false, msgId: 'm1', blockIndex: 0 } as AgentEvent)]],
      [
        'r',
        [
          row('r', 7, { type: 'question-request', requestId: 'q1', questions: [{ question: 'Which market first?', options: [] }] } as unknown as AgentEvent)
        ]
      ]
    ])
    const tailReads: string[] = []
    const eventListeners = new Set<(row: EventRow) => void>()
    const metaListeners = new Set<(m: SessionMeta) => void>()
    const noteListeners = new Set<(id: string, text: string) => void>()
    const children = (masterId: string) =>
      [...sessions.values()].filter((s) => s.masterId === masterId && !s.parentId && !s.archived).sort((p, q) => p.createdAt - q.createdAt)
    const digests = new BoardDigests({
      children,
      meta: (id) => sessions.get(id) ?? null,
      masterOf: (id) => sessions.get(id)?.masterId ?? null,
      todos: (id) => todos.get(id) ?? null,
      notesText: (id) => notes.get(id) ?? null,
      readTail: async (id) => {
        tailReads.push(id)
        return tails.get(id) ?? []
      },
      watched: opts.watched ?? (() => true),
      onEvent: (l) => {
        eventListeners.add(l)
        return () => eventListeners.delete(l)
      },
      onMeta: (l) => {
        metaListeners.add(l)
        return () => metaListeners.delete(l)
      },
      onNotes: (l) => {
        noteListeners.add(l)
        return () => noteListeners.delete(l)
      }
    })
    digests.attach()
    const pushes: BoardPush[] = []
    digests.onPush((p) => pushes.push(p))
    return {
      sessions,
      todos,
      tails,
      digests,
      pushes,
      tailReads,
      append: (r: EventRow) => {
        for (const l of eventListeners) l(r)
      },
      setMeta: (id: string, patch: Partial<SessionMeta>) => {
        const s = { ...sessions.get(id)!, ...patch }
        sessions.set(id, s)
        for (const l of metaListeners) l(s)
      },
      writeNotes: (id: string, text: string) => {
        for (const l of noteListeners) l(id, text)
      },
      row
    }
  }

  const state = (masterId: string) => ({ masterId, steps: [], landed: [], pending: [], held: [], blocked: null, finishedAt: null }) as unknown as BatchState

  it("answers the master's children here with a digest each from the host's own folds, and the state", async () => {
    const h = board()
    const answer = await h.digests.board('m', () => state('m'))
    expect(answer.children.map((c) => c.id)).toEqual(['a', 'r', 'x'])
    expect(answer.state.masterId).toBe('m')
    expect(answer.digests).toEqual({
      a: {
        todos: [
          { content: 'Read the brief', status: 'completed' },
          { content: 'Write the view', status: 'in_progress' }
        ],
        last: 'Wrote the view.'
      },
      r: { state: 'Three sources read, two to go', question: 'Which market first?' },
      x: { failure: 'Rate limited until 14:00' }
    })
    // Each child's tail was read once; a second board reads nothing.
    expect(h.tailReads.sort()).toEqual(['a', 'r', 'x'])
    await h.digests.board('m', () => state('m'))
    expect(h.tailReads).toHaveLength(3)
  })

  it('handleBatch answers batch.board through the digests, and without them the children and the state alone', async () => {
    const h = board()
    const w = world()
    const b = w.make()
    const withDigests = (await handleBatch({ id: '1', method: 'batch.board', params: { masterId: 'm' } }, b, { batchChildren: () => [...h.sessions.values()].filter((s) => s.masterId === 'm') }, h.digests)) as { result: BatchBoard }
    expect(Object.keys(withDigests.result.digests)).toEqual(['a', 'r', 'x'])
    expect(withDigests.result.state.masterId).toBe('m')
    const bare = (await handleBatch({ id: '2', method: 'batch.board', params: { masterId: 'm' } }, b, w.registry)) as { result: BatchBoard }
    expect(bare.result.children.map((c) => c.id)).toEqual(['a', 'b'])
    expect(bare.result.digests).toEqual({})
    expect(bare.result.state.pending).toEqual(['a', 'b'])
  })

  it("one child's moves inside the window become one push of its new digest; an unchanged digest is never sent", async () => {
    vi.useFakeTimers()
    const h = board()
    await h.digests.board('m', () => state('m'))
    // Three rows and a meta push for a, inside 250 ms.
    h.todos.set('a', [{ status: 'completed', name: 'Read the brief' }, { status: 'completed', name: 'Write the view' }])
    h.append(h.row('a', 5, { type: 'tool-call', callId: 't2', name: 'TodoWrite', input: {} } as AgentEvent))
    h.append(h.row('a', 6, { type: 'assistant-text', text: 'All done.', delta: false, msgId: 'm2', blockIndex: 0 } as AgentEvent))
    h.append(h.row('a', 7, { type: 'assistant-text', text: 'All', delta: true, msgId: 'm3', blockIndex: 0 } as AgentEvent))
    h.setMeta('a', { activity: 'Running tests' })
    expect(h.pushes).toHaveLength(0)
    vi.advanceTimersByTime(250)
    expect(h.pushes).toEqual([
      {
        masterId: 'm',
        sessionId: 'a',
        digest: {
          todos: [
            { content: 'Read the brief', status: 'completed' },
            { content: 'Write the view', status: 'completed' }
          ],
          last: 'All done.'
        }
      }
    ])
    // A meta push that moves nothing the digest says: nothing goes out.
    h.setMeta('a', { activity: 'Running lint' })
    vi.advanceTimersByTime(250)
    expect(h.pushes).toHaveLength(1)
    // The question answered and the notes' State written: r's digest moves.
    h.append(h.row('r', 8, { type: 'question-resolved', requestId: 'q1' } as unknown as AgentEvent))
    h.writeNotes('r', '## State\n\nFour read\n')
    vi.advanceTimersByTime(250)
    expect(h.pushes.at(-1)).toEqual({ masterId: 'm', sessionId: 'r', digest: { state: 'Four read' } })
  })

  it("a row that lands while a child's first read is in flight is folded in and pushed once the read is in", async () => {
    vi.useFakeTimers()
    const h = board()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const appended = new Set<(r: EventRow) => void>()
    const slow = new BoardDigests({
      children: (m) => [...h.sessions.values()].filter((s) => s.masterId === m),
      meta: (id) => h.sessions.get(id) ?? null,
      masterOf: (id) => h.sessions.get(id)?.masterId ?? null,
      todos: () => null,
      notesText: () => null,
      readTail: async () => {
        await gate
        return []
      },
      watched: () => true,
      onEvent: (l) => {
        appended.add(l)
        return () => appended.delete(l)
      }
    })
    slow.attach()
    const got: BoardPush[] = []
    slow.onPush((p) => got.push(p))
    const answer = slow.board('m', () => state('m'))
    // The row arrives through the registry's listener while the tail read waits.
    for (const l of appended) l(h.row('a', 9, { type: 'assistant-text', text: 'Mid-read.', delta: false, msgId: 'm9', blockIndex: 0 } as AgentEvent))
    release()
    expect((await answer).digests.a.last).toBe('Mid-read.')
    await vi.advanceTimersByTimeAsync(250)
    expect(got.find((p) => p.sessionId === 'a')?.digest.last).toBe('Mid-read.')
  })

  it('a thread that joins with no new row (adopted) has its tail read before its first push', async () => {
    vi.useFakeTimers()
    const h = board()
    await h.digests.board('m', () => state('m'))
    // 'y' was another master's; it joins m's batch through a meta push alone.
    h.tails.set('y', [h.row('y', 3, { type: 'assistant-text', text: 'Earlier words.', delta: false, msgId: 'y1', blockIndex: 0 } as AgentEvent)])
    h.setMeta('y', { masterId: 'm' })
    await vi.advanceTimersByTimeAsync(250)
    expect(h.tailReads).toContain('y')
    expect(h.pushes.find((p) => p.sessionId === 'y')).toEqual({ masterId: 'm', sessionId: 'y', digest: { last: 'Earlier words.' } })
  })

  it('nothing is computed or pushed for a master no socket watches', async () => {
    vi.useFakeTimers()
    let watching = false
    const h = board({ watched: () => watching })
    await h.digests.board('m', () => state('m'))
    h.append(h.row('a', 5, { type: 'assistant-text', text: 'Unseen.', delta: false, msgId: 'm2', blockIndex: 0 } as AgentEvent))
    vi.advanceTimersByTime(1_000)
    expect(h.pushes).toHaveLength(0)
    // The lines still fold, so a watcher that comes back reads them.
    watching = true
    expect((await h.digests.board('m', () => state('m'))).digests.a.last).toBe('Unseen.')
  })

  it('a digest that moved while nobody watched is pushed again when it moves back', async () => {
    vi.useFakeTimers()
    let watching = true
    const h = board({ watched: () => watching })
    await h.digests.board('m', () => state('m'))
    const said = (seq: number, text: string) => h.append(h.row('a', seq, { type: 'assistant-text', text, delta: false, msgId: `m${seq}`, blockIndex: 0 } as AgentEvent))
    said(5, 'A')
    vi.advanceTimersByTime(250)
    expect(h.pushes.at(-1)?.digest.last).toBe('A')
    // Unwatched, it says B: no push; a new watcher's answer shows B.
    watching = false
    said(6, 'B')
    watching = true
    expect((await h.digests.board('m', () => state('m'))).digests.a.last).toBe('B')
    // Back to A: the push goes out, though A was the last one pushed.
    said(7, 'A')
    vi.advanceTimersByTime(250)
    expect(h.pushes.at(-1)?.digest.last).toBe('A')
    expect(h.pushes.filter((p) => p.sessionId === 'a')).toHaveLength(2)
  })

  it("a socket watches a master for a minute after its batch.board, or while it has the master on screen; never another master's", () => {
    let now = 0
    const focus = new FocusSet({ parentOf: () => null, masterOf: () => null })
    const watch = new BoardWatch(focus, () => now)
    watch.ask(1, 'm')
    expect(watch.isWatching(1, 'm')).toBe(true)
    expect(watch.isWatching(1, 'n')).toBe(false)
    expect(watch.isWatching(2, 'm')).toBe(false)
    expect(watch.watched('m')).toBe(true)
    expect(watch.watched('n')).toBe(false)
    now = BOARD_WATCH_MS - 1
    expect(watch.isWatching(1, 'm')).toBe(true)
    now = BOARD_WATCH_MS
    expect(watch.isWatching(1, 'm')).toBe(false)
    expect(watch.watched('m')).toBe(false)
    // Asking again renews it.
    watch.ask(1, 'm')
    expect(watch.isWatching(1, 'm')).toBe(true)
    // session.focus: a socket with the master on screen watches it with no ask, and only that socket.
    focus.set(2, 'n')
    expect(watch.isWatching(2, 'n')).toBe(true)
    expect(watch.isWatching(1, 'n')).toBe(false)
    expect(watch.watched('n')).toBe(true)
    // Focus on one of the master's children is not the board.
    focus.set(2, 'a')
    expect(watch.isWatching(2, 'n')).toBe(false)
    focus.set(2, null)
    expect(watch.watched('n')).toBe(false)
    watch.drop(1)
    expect(watch.watched('m')).toBe(false)
    // A socket that asked once reads deltas from then on; one that never asked gets the whole state.
    expect(watch.asksBoards(1)).toBe(false)
    watch.ask(3, 'm')
    expect(watch.asksBoards(3)).toBe(true)
    expect(watch.asksBoards(2)).toBe(false)
  })
})

describe('Batches: one end per cycle', () => {
  it('a child that goes idle again with nothing new never re-runs the end; a new landing does', async () => {
    const w = world()
    const b = w.make()
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
    // A retry loop: the child resumes and settles idle again, three times.
    for (let i = 0; i < 3; i++) {
      w.set('a', { status: 'running' })
      await b.review('m')
      expect(b.open('m')).toBe(true)
      w.set('a', { status: 'idle' })
      await b.review('m')
    }
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
    expect(w.reports.map((r) => r.status)).toEqual(['done'])
    expect(b.open('m')).toBe(false)
    // A landing opens the next cycle.
    b.landed(w.landed('b'))
    await b.review('m')
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release', 'gate', 'release'])
    expect(w.reports.map((r) => r.status)).toEqual(['done', 'done'])
  })

  it('a failed publish, then a child idling again: no fresh release, no second publish', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { steps: [S.land, S.gate, S.release, S.publish] })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    const review = b.review('m')
    await flush()
    w.publish.finish({ ok: false, exit: 1, version: '1.0.277', text: 'the release checkout has uncommitted changes' })
    await review
    expect(steps(b.get('m')).publish[0]).toBe('failed')
    w.set('a', { status: 'running' })
    await b.review('m')
    w.set('a', { status: 'idle' })
    await b.review('m')
    await flush()
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
    expect(w.publish.calls).toHaveLength(1)
    expect(steps(b.get('m')).publish[0]).toBe('failed')
  })

  it('a child that joins after the end opens a cycle, one that leaves does not; a rules call re-runs the end', async () => {
    const w = world()
    const b = w.make()
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(w.runs).toHaveLength(2)
    // b archived: the batch shrinks, nothing runs.
    w.set('b', { archived: true })
    await b.review('m')
    expect(w.runs).toHaveLength(2)
    // A new thread started into the batch (not adopted) runs and settles: the end runs on it.
    w.sessions.set('c', meta('c', { masterId: 'm', createdAt: 9, status: 'running' }))
    await b.review('m')
    w.set('c', { status: 'done' })
    await b.review('m')
    expect(w.runs).toHaveLength(4)
    // The master's batch_rules (even the same steps) is the hand re-run.
    b.setRules('m', {})
    await flush()
    await b.review('m')
    expect(w.runs).toHaveLength(6)
  })

  it('archive-children at the end does not start another cycle', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { then: 'archive-children' })
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    expect(w.sessions.get('a')?.archived).toBe(true)
    await b.review('m')
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
  })

  it('a row from before the cycle field takes its children as seen: an old batch does not run again on the upgrade', async () => {
    const w = world()
    const b = w.make()
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    b.flush()
    // The stored row as an older build wrote it: no ranChildren.
    const key = [...w.store.settingsWithPrefix('')].find(([, v]) => v.includes('"masterId":"m"'))![0]
    const raw = JSON.parse(w.store.getSetting(key)!)
    delete raw.ranChildren
    w.store.setSetting(key, JSON.stringify(raw))
    const fresh = w.make()
    await fresh.review('m')
    w.set('a', { status: 'running' })
    await fresh.review('m')
    w.set('a', { status: 'idle' })
    await fresh.review('m')
    expect(w.runs).toHaveLength(2)
  })
})

describe('Batches: a child whose turn failed', () => {
  const capped: NonNullable<SessionMeta['failure']> = { kind: 'rate_limited', account: 'acct', summary: 'Usage limit reached on acct', cause: 'the account spent its window' }

  it('idle on a failed turn is not done: it blocks the end as failed, named, the master told once; cleared, the end runs', async () => {
    const w = world()
    const b = w.make()
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    w.set('b', { status: 'idle', failure: capped })
    await b.review('m')
    expect(b.get('m').blocked).toEqual({ sessionId: 'b', why: 'failed' })
    expect(w.runs).toHaveLength(0)
    expect(b.open('m')).toBe(true)
    expect(w.reports.map((r) => r.status)).toEqual(['blocked'])
    expect(w.reports[0].text).toContain('failed: Usage limit reached on acct')
    // It retries and fails again: still blocked, not told twice, nothing tagged.
    w.set('b', { status: 'running', failure: null })
    await b.review('m')
    w.set('b', { status: 'idle', failure: capped })
    await b.review('m')
    expect(w.runs).toHaveLength(0)
    expect(w.reports).toHaveLength(1)
    // A turn that ends well clears the failure: the end runs.
    w.set('b', { status: 'idle', failure: null })
    await b.review('m')
    expect(b.get('m').blocked).toBeNull()
    expect(w.runs.map((r) => r.step)).toEqual(['gate', 'release'])
  })
})

describe('Batches: a release with nothing new', () => {
  const none = 'nothing to release since release-276 (package.json 1.0.276)'

  it('the release step is skipped with release.ts\'s words, no gate row says passed, and publish takes the existing v1.0.N', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { steps: [S.land, S.gate, S.release, S.publish] })
    w.setOutcome((o) => (o.step === 'release' ? { log: none } : {}))
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    const review = b.review('m')
    await flush()
    expect(steps(b.get('m')).release).toEqual(['skipped', 'nothing to release since release-276'])
    expect(w.publish.calls[0].args.version).toBe('1.0.276')
    expect(w.rows.m.filter((e) => e.type === 'notice' && e.kind === 'gate')).toHaveLength(1)
    w.publish.finish({ ok: true, exit: 0, version: '1.0.276', text: 'Published 1.0.276 in 4m' })
    await review
    expect(steps(b.get('m')).publish[0]).toBe('passed')
    expect(w.reports.at(-1)?.text).toContain('nothing to release since release-276')
  })

  it('a deploy after a skipped release runs (master without a publish), never "needs a release"', async () => {
    const w = world()
    const b = w.make()
    b.setRules('m', { steps: [S.land, S.gate, S.release, S.deploy] })
    w.setOutcome((o) => (o.step === 'release' ? { log: none } : {}))
    w.set('b', { status: 'idle' })
    b.landed(w.landed('a'))
    await b.review('m')
    await flush()
    expect(w.deploy.requested).toEqual(['master'])
    expect(steps(b.get('m')).deploy[0]).toBe('running')
  })

  it('batch_gate answers it in words; releaseOutcome reads both lines', async () => {
    const w = world()
    const b = w.make()
    w.setOutcome((o) => (o.step === 'release' ? { log: none } : {}))
    b.landed(w.landed('a'))
    expect(await b.gate(w.sessions.get('m')!)).toBe('passed in 1m 12s, nothing to release since release-276')
    expect(releaseOutcome(none)).toEqual({ tag: 'release-276', fresh: false })
    expect(releaseOutcome('released v277 (tag release-277, package.json 1.0.277)')).toEqual({ tag: 'release-277', fresh: true })
    expect(releaseOutcome('stub: release passed on master')).toBeNull()
  })
})

describe('the stall watch', () => {
  const quiet = (w: ReturnType<typeof world>) => {
    const b = w.make()
    // The master watches an open batch: A works, B waits for A, C is done. The
    // engine knows a batch by its row, which the first review of a child's
    // change makes in production (attach); here the read makes it.
    b.get('m')
    return b
  }
  const stalled = () =>
    world({
      children: [
        meta('m', { status: 'watching' }),
        meta('a', { masterId: 'm', createdAt: 2, status: 'running', title: 'A' }),
        meta('b', { masterId: 'm', createdAt: 3, status: 'queued', after: 'a', title: 'B' }),
        meta('c', { masterId: 'm', createdAt: 4, status: 'idle', title: 'C' })
      ]
    })

  it('a batch quiet for half an hour tells the master once, naming every thread with its state and age', () => {
    const w = stalled()
    w.registry.hasCompletedTurn = (id) => id === 'c'
    const b = quiet(w)
    w.tick(29 * 60_000)
    expect(b.checkStalls()).toEqual([])
    w.tick(2 * 60_000)
    expect(b.checkStalls()).toEqual(['m'])
    expect(w.reports).toHaveLength(1)
    expect(w.reports[0]).toMatchObject({ to: 'm', status: 'blocked' })
    expect(w.reports[0].text).toBe(
      '<batch-report>\nNo batch thread has moved for 31 min: "A" (a) working (last event 31 min ago), "B" (b) queued (waiting for "A"), "C" (c) done.\n</batch-report>'
    )
    // Still quiet: told already.
    w.tick(10 * 60_000)
    expect(b.checkStalls()).toEqual([])
    expect(w.reports).toHaveLength(1)
    // The stamp is on the row: a fresh engine over the same store does not repeat it.
    expect(w.make().checkStalls()).toEqual([])
    b.dispose()
  })

  it('a thread moving re-arms the watch: a second quiet stretch is a second report', () => {
    const w = stalled()
    w.registry.hasCompletedTurn = (id) => id === 'c'
    const b = quiet(w)
    w.tick(31 * 60_000)
    expect(b.checkStalls()).toEqual(['m'])
    w.tick(5 * 60_000)
    w.activity.set('a', 1000 + 36 * 60_000)
    expect(b.checkStalls()).toEqual([])
    w.tick(31 * 60_000)
    expect(b.checkStalls()).toEqual(['m'])
    expect(w.reports).toHaveLength(2)
    expect(w.reports[1].text).toContain('"A" (a) working (last event 31 min ago)')
    b.dispose()
  })

  it("a blocked batch is not a stall, nor is a master that is not watching or whose batch is closed", async () => {
    const w = stalled()
    w.registry.hasCompletedTurn = (id) => id === 'c'
    const b = quiet(w)
    w.tick(31 * 60_000)
    w.set('a', { status: 'error' })
    await b.review('m')
    expect(w.reports.map((r) => r.status)).toEqual(['blocked'])
    expect(b.checkStalls()).toEqual([])
    expect(w.reports).toHaveLength(1)
    // Unblocked and quiet, but the master is mid-turn: nothing; watching again: told.
    w.set('a', { status: 'running' })
    await b.review('m')
    w.set('m', { status: 'running' })
    expect(b.checkStalls()).toEqual([])
    w.set('m', { status: 'watching' })
    expect(b.checkStalls()).toEqual(['m'])
    b.dispose()
  })

  it('the timer runs the check and stops with the engine', async () => {
    const w = stalled()
    w.registry.hasCompletedTurn = (id) => id === 'c'
    const b = quiet(w)
    w.tick(31 * 60_000)
    b.startStallWatch(5)
    await until(() => w.reports.length === 1)
    b.dispose()
    w.activity.set('a', 1000 + 31 * 60_000)
    w.tick(31 * 60_000)
    await new Promise((r) => setTimeout(r, 40))
    expect(w.reports).toHaveLength(1)
  })
})
