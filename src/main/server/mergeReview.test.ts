import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import { DEFAULT_REVIEW_SETTINGS, type ReviewSettings } from '@shared/review'
import { MergeRefusal, type MergeBundle } from './mergeBranch'
import { GateQueue } from './gateQueue'
import type { GateRunOptions, GateRunResult } from './gateRun'
import { MergeReviews, subjectsOf, type Landed, type MergeReviewDeps } from './mergeReview'
import { settleSuppressed } from './orchestration'

/** A gate runner that passes every step and records what it was asked. */
function fakeGate(outcome: (o: GateRunOptions) => Partial<GateRunResult> = () => ({})) {
  const runs: GateRunOptions[] = []
  const runGate = async (o: GateRunOptions): Promise<GateRunResult> => {
    runs.push(o)
    return { ok: true, log: `stub ${o.step}`, ms: 1200, exitCode: 0, ...outcome(o) }
  }
  return { runs, runGate }
}
const green = fakeGate().runGate

/**
 * A registry of plain maps: sessions, event logs, subscribers. Creating a
 * child appends agent-spawned to its parent (as the real one does);
 * `settle(id, status)` plays the reviewer's end of turn.
 */
function fakeRegistry() {
  const sessions = new Map<string, SessionMeta>()
  const events = new Map<string, EventRow[]>()
  const subs = new Map<string, Set<(row: EventRow) => void>>()
  const sent: { id: string; text: string }[] = []
  let n = 0
  const settings = new Map<string, string>()
  let review: ReviewSettings | null = null
  const meta = (over: Partial<SessionMeta>): SessionMeta => ({
    id: `s${++n}`,
    parentId: null,
    projectId: 'p1',
    workspaceId: 'w1',
    threadType: 'implementation',
    planPath: null,
    provider: 'claude',
    model: 'claude-haiku-5-5',
    reasoning: 'medium',
    agentType: 'implementer',
    title: 't',
    cwd: '/repo',
    status: 'idle',
    pinned: false,
    archived: false,
    permission: 'auto',
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  } as SessionMeta)
  const append = (id: string, event: AgentEvent): void => {
    const list = events.get(id) ?? []
    const row: EventRow = { sessionId: id, seq: list.length + 1, ts: Date.now(), event }
    list.push(row)
    events.set(id, list)
    for (const l of subs.get(id) ?? []) l(row)
  }
  const registry: MergeReviewDeps['registry'] = {
    get: (id) => sessions.get(id) ?? null,
    eventsAfter: (id, after) => (events.get(id) ?? []).filter((r) => r.seq > after),
    subscribe: (id, l) => {
      const set = subs.get(id) ?? new Set()
      set.add(l)
      subs.set(id, set)
      return () => set.delete(l)
    },
    append,
    interrupt: async (id) => {
      const m = sessions.get(id)
      if (m) settle(id, 'idle')
    },
    getProject: () => ({ id: 'p1', workspaceId: 'w1', name: 'p', mode: 'local', branch: 'master', cwd: '/repo', archived: false, createdAt: 1 }),
    effectiveReview: () => ({ settings: review ?? DEFAULT_REVIEW_SETTINGS, source: review ? 'project' : 'default' }),
    create: async (raw) => {
      const m = meta({
        ...(raw as Partial<SessionMeta>),
        status: 'running',
        threadType: null,
        permission: (raw.permission ?? 'auto') as SessionMeta['permission']
      })
      sessions.set(m.id, m)
      if (raw.parentId) append(raw.parentId, { type: 'agent-spawned', childSessionId: m.id })
      return m
    },
    send: async (id, text) => {
      sent.push({ id, text })
    }
  }
  const settle = (id: string, status: SessionMeta['status']): void => {
    const m = sessions.get(id)
    if (!m) return
    sessions.set(id, { ...m, status })
    append(id, { type: 'status', status })
  }
  const add = (over: Partial<SessionMeta>): SessionMeta => {
    const m = meta(over)
    sessions.set(m.id, m)
    return m
  }
  const store = {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string | null) => (v === null ? settings.delete(k) : settings.set(k, v)),
    settingsWithPrefix: (p: string) => new Map([...settings].filter(([k]) => k.startsWith(p)))
  }
  return {
    registry,
    store,
    sent,
    sessions,
    add,
    settle,
    append,
    setReview: (r: ReviewSettings | null) => (review = r),
    rows: (id: string) => events.get(id) ?? [],
    /** the thread's notice rows of one kind (the review rows by default; every merge also lands a gate row) */
    notices: (id: string, kind: string | null = 'review') =>
      (events.get(id) ?? [])
        .map((r) => r.event)
        .filter((e) => e.type === 'notice' && (kind === null || e.kind === kind)) as Extract<AgentEvent, { type: 'notice' }>[],
    reviewer: () => [...sessions.values()].find((s) => s.agentType === 'reviewer') ?? null
  }
}

function fakeGit(over: Partial<NonNullable<MergeReviewDeps['git']>> = {}) {
  const calls: string[] = []
  const bundle: MergeBundle = {
    cwd: '/repo',
    branch: 'feature',
    target: 'master',
    base: 'base0000000',
    head: 'head0000000',
    diff: '--- a/x.ts\n+++ b/x.ts\n+const y = 1\n',
    diffTruncated: false,
    commits: 'abc123 feature: do the thing\n',
    files: ['x.ts'],
    empty: false
  }
  return {
    calls,
    bundle,
    git: {
      branchOf: async (cwd: string) => (cwd === '/wt' ? 'feature' : 'master'),
      defaultBranchOf: async () => 'master',
      worktreeOf: async (_cwd: string, branch: string) => (branch === 'feature' ? '/wt' : null),
      hasOrigin: async () => true,
      buildMergeBundle: async () => bundle,
      fastForwardMerge: async (cwd: string, branch: string, target: string, push: boolean) => {
        calls.push(`merge ${branch}->${target}@${cwd}${push ? ' push' : ''}`)
        return { sha: 'head0000000', merged: branch !== target, pushed: push }
      },
      targetMoved: async () => false,
      rebaseOnto: async () => ({ head: 'head0000000', base: 'base0000000', rebased: false }),
      ...over
    }
  }
}

const ON: ReviewSettings = { ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true, provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', maxMinutes: 15 }
const finding = (over: Record<string, unknown> = {}) => ({
  file: 'x.ts',
  line: 1,
  summary: 'y is never used',
  failure_scenario: 'nothing reads y',
  verdict: 'CONFIRMED',
  ...over
})
const tick = () => new Promise((r) => setTimeout(r, 5))

let reg: ReturnType<typeof fakeRegistry>
beforeEach(() => {
  reg = fakeRegistry()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('merge_branch without a review', () => {
  it('merges at once when the setting is off and leaves one plain row', async () => {
    const { git, calls } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    const text = await reviews.mergeBranch(impl, {})
    expect(calls).toEqual(['merge feature->master@/repo push'])
    expect(text).toContain('Merged feature into master')
    expect(text).toContain('pushed to origin')
    expect(reg.reviewer()).toBeNull()
    expect(reg.notices(impl.id).map((n) => n.review?.outcome)).toEqual(['skipped'])
  })

  it('answers refusals as text: no branch, nothing to merge, a merge that is not a fast-forward', async () => {
    const { git } = fakeGit({
      branchOf: async () => null
    })
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    expect(await reviews.mergeBranch(impl, {})).toMatch(/^refused: .*not on a branch/)

    const empty = fakeGit({ buildMergeBundle: async () => ({ ...fakeGit().bundle, empty: true }) })
    expect(await new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git: empty.git }).mergeBranch(impl, {})).toMatch(/^nothing to merge/)

    const noFf = fakeGit({
      fastForwardMerge: async () => {
        throw new MergeRefusal('git merge --ff-only feature failed: not a fast-forward. Rebase feature onto master and merge again.')
      }
    })
    expect(await new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git: noFf.git }).mergeBranch(impl, {})).toMatch(/^refused: git merge --ff-only/)
  })
})

describe('merge_branch under review', () => {
  it('sends the reviewer the diff against the merge-base, the commits, the files and the brief', async () => {
    reg.setReview(ON)
    const { git, bundle } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    reg.append(impl.id, { type: 'user-text', text: 'Build the thing.\n\nWith care.' })
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    const reviewer = reg.reviewer()!
    expect(reviewer).toMatchObject({ parentId: impl.id, provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', permission: 'auto', cwd: '/wt', projectId: 'p1' })
    expect(reviewer.title).toBe('Review: feature → master')
    expect(reg.rows(impl.id).some((r) => r.event.type === 'agent-spawned')).toBe(true)
    const brief = reg.sent.find((s) => s.id === reviewer.id)!.text
    expect(brief).toContain('merge of branch feature into master in /repo')
    expect(brief).toContain('Build the thing.\n\nWith care.')
    expect(brief).toContain(bundle.commits.trim())
    expect(brief).toContain('x.ts')
    expect(brief).toContain(bundle.diff)
    expect(brief).toContain(`${bundle.base.slice(0, 10)}..${bundle.head.slice(0, 10)}`)
    expect(brief).toContain('call report_findings ONCE')
    expect(reviews.isReviewer(reviewer.id)).toBe(true)
    expect(reviews.isReviewer(impl.id)).toBe(false)
    reviews.reportFindings(reviewer, { findings: [] })
    await pending
  })

  it('a thread in the project checkout names its branch; the reviewer runs in that branch\'s worktree', async () => {
    reg.setReview(ON)
    const { git } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/repo' })
    const onTarget = fakeGit({ buildMergeBundle: async () => ({ ...fakeGit().bundle, branch: 'master', empty: true }) })
    expect(await new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git: onTarget.git }).mergeBranch(impl, {})).toMatch(
      /^nothing to do: master has nothing unpushed\. If your work is on another branch/
    )
    const pending = reviews.mergeBranch(impl, { branch: 'feature' })
    await tick()
    const reviewer = reg.reviewer()!
    expect(reviewer.cwd).toBe('/wt')
    expect(reg.sent.find((s) => s.id === reviewer.id)!.text).toContain('The change is checked out in your working directory.')
    reviews.reportFindings(reviewer, { findings: [] })
    await pending
  })

  it("a reviewer's settle never wakes the implementation thread, during the run or after it", async () => {
    reg.setReview(ON)
    const { git } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    expect(settleSuppressed(impl)).toBe(false)
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    const reviewer = reg.reviewer()!
    expect(settleSuppressed(reviewer)).toBe(true)
    reviews.reportFindings(reviewer, { findings: [] })
    await pending
    // The run is forgotten once merged; the reviewer still settles quietly.
    expect(settleSuppressed(reviewer)).toBe(true)
    // And one from before a restart, known only by its title.
    expect(settleSuppressed(reg.add({ agentType: 'reviewer', title: 'Review: x → master', parentId: impl.id }))).toBe(true)
    expect(settleSuppressed(reg.add({ agentType: 'reviewer', title: 'Audit the thing', parentId: impl.id }))).toBe(false)
  })

  it('no blocking findings: merges and leaves "Reviewed by …: no blocking findings (2 minor)"', async () => {
    reg.setReview(ON)
    const { git, calls } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    const reviewer = reg.reviewer()!
    expect(reviews.reportFindings(reviewer, { findings: [finding({ verdict: 'PLAUSIBLE' }), finding({ verdict: 'PLAUSIBLE', line: 2 })] })).toMatch(/^reported 2 findings/)
    const text = await pending
    expect(calls).toEqual(['merge feature->master@/repo push'])
    expect(text).toContain('Reviewed by Haiku 5.5: no blocking findings (2 minor)')
    expect(text).toContain('Minor findings (not blocking)')
    const [row] = reg.notices(impl.id)
    expect(row.message).toBe('Reviewed by Haiku 5.5: no blocking findings (2 minor)')
    expect(row.review).toMatchObject({ outcome: 'pass', merged: true, pushed: true, reviewerId: reviewer.id, branch: 'feature', target: 'master' })
    expect(row.review?.minor).toHaveLength(2)
    // A second report is refused: the run has its answer.
    expect(reviews.reportFindings(reviewer, { findings: [] })).toMatch(/^refused/)
  })

  it('blocking findings: holds the merge, lands the card, tells the model to address them', async () => {
    reg.setReview(ON)
    const { git, calls } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    const reviewer = reg.reviewer()!
    reviews.reportFindings(reviewer, { findings: [finding(), finding({ verdict: 'PLAUSIBLE', line: 9, summary: 'maybe' })] })
    const text = await pending
    expect(calls).toEqual([])
    expect(text).toMatch(/^HELD: Reviewed by Haiku 5.5: 1 blocking finding \(1 minor\) — merge held\. Address these before merging, then call merge_branch again/)
    expect(text).toContain('1. x.ts:1 [CONFIRMED] — y is never used')
    expect(text).toContain('Failure: nothing reads y')
    const [row] = reg.notices(impl.id)
    expect(row.review).toMatchObject({ outcome: 'held', merged: false })
    expect(row.review?.blocking).toEqual([finding()])
    expect(row.review?.minor.map((f) => f.line)).toEqual([9])
    expect(reviews.heldRun(impl.id, row.review!.runId)).not.toBeNull()
    expect(reviews.heldRun('other', row.review!.runId)).toBeNull()
  })

  it('"any finding" blocks on a plausible one too', async () => {
    reg.setReview({ ...ON, blockOn: 'any' })
    const { git, calls } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    reviews.reportFindings(reg.reviewer()!, { findings: [finding({ verdict: 'PLAUSIBLE' })] })
    expect(await pending).toMatch(/^HELD/)
    expect(calls).toEqual([])
  })

  it('Merge anyway: merges past a held review, rows it, and survives a restart', async () => {
    reg.setReview(ON)
    const { git, calls } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    reviews.reportFindings(reg.reviewer()!, { findings: [finding()] })
    await pending
    const runId = reg.notices(impl.id)[0].review!.runId
    // A new instance over the same store: the held run is still there.
    const after = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const result = await after.override(impl.id, runId)
    expect(result).toEqual({ sha: 'head0000000', merged: true, pushed: true })
    expect(calls).toEqual(['merge feature->master@/repo push'])
    const rows = reg.notices(impl.id)
    expect(rows[1].message).toBe('Merged anyway: 1 blocking finding overridden')
    expect(rows[1].review).toMatchObject({ outcome: 'merged-anyway', runId, merged: true })
    await expect(after.override(impl.id, runId)).rejects.toThrow(/no held review/)
    expect(reg.store.settingsWithPrefix('review:run:').size).toBe(0)
  })

  it('a head that passed is not reviewed twice when the merge itself failed', async () => {
    reg.setReview(ON)
    let fail = true
    const { git, calls } = fakeGit({
      fastForwardMerge: async (_cwd, branch, target, push) => {
        if (fail) throw new MergeRefusal('git push origin master failed: rejected')
        calls.push(`merge ${branch}->${target} ${push}`)
        return { sha: 'head0000000', merged: true, pushed: push }
      }
    })
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    reviews.reportFindings(reg.reviewer()!, { findings: [] })
    expect(await pending).toMatch(/^refused: Review passed, but git push origin master failed/)
    fail = false
    const second = await reviews.mergeBranch(impl, {})
    expect(second).toContain('no blocking findings')
    expect([...reg.sessions.values()].filter((s) => s.agentType === 'reviewer')).toHaveLength(1)
    expect(reg.notices(impl.id).map((n) => n.review?.outcome)).toEqual(['pass'])
    expect(reg.notices(impl.id)[0].review?.reason).toBe('already reviewed')
  })

  it('timeout: stops the reviewer, merges, and says the review timed out', async () => {
    vi.useFakeTimers()
    reg.setReview({ ...ON, maxMinutes: 2 })
    const { git, calls } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    const pending = reviews.mergeBranch(impl, {})
    await vi.advanceTimersByTimeAsync(10)
    const reviewer = reg.reviewer()!
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1)
    const text = await pending
    expect(text).toContain('Review by Haiku 5.5 timed out after 2 min — merged without it')
    expect(calls).toEqual(['merge feature->master@/repo push'])
    expect(reg.sessions.get(reviewer.id)?.status).toBe('idle')
    expect(reg.notices(impl.id)[0].review).toMatchObject({ outcome: 'timeout', merged: true, minutes: 2 })
    // A report after the timeout is refused: the run is over.
    expect(reviews.reportFindings(reviewer, { findings: [] })).toMatch(/^refused/)
  })

  it('a reviewer that ends without reporting counts as a failed review: merged, said so', async () => {
    reg.setReview(ON)
    const { git, calls } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git })
    const impl = reg.add({ cwd: '/wt' })
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    reg.settle(reg.reviewer()!.id, 'error')
    const text = await pending
    expect(text).toContain('failed to run (the reviewer ended error without reporting) — merged without it')
    expect(calls).toHaveLength(1)
    expect(reg.notices(impl.id)[0].review).toMatchObject({ outcome: 'failed', merged: true })
  })

  it('report_findings outside a review, or with a bad shape, is refused', async () => {
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, runGate: green, git: fakeGit().git })
    const impl = reg.add({})
    expect(reviews.reportFindings(impl, { findings: [] })).toMatch(/not the reviewer/)
    reg.setReview(ON)
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    const reviewer = reg.reviewer()!
    expect(reviews.reportFindings(reviewer, { findings: [{ summary: 'no file' }] })).toMatch(/^refused: findings\.0\.file/)
    reviews.reportFindings(reviewer, { findings: [] })
    await pending
  })
})

describe('the gate before the merge', () => {
  it('a batch child runs typecheck alone in its worktree, on the queue, and lands a green gate row', async () => {
    const { git, calls } = fakeGit()
    const { runs, runGate } = fakeGate()
    const landed: Landed[] = []
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate, queue: new GateQueue(), onLanded: (l) => landed.push(l) })
    const child = reg.add({ cwd: '/wt', masterId: 'master1' })
    const text = await reviews.mergeBranch(child, {})
    expect(runs).toEqual([{ cwd: '/wt', step: 'typecheck', branch: 'feature', since: undefined }])
    expect(calls).toEqual(['merge feature->master@/repo push'])
    expect(text).toContain('Merged feature into master')
    expect(text).toContain('Typecheck passed on feature in 1s')
    const gates = reg.notices(child.id, 'gate')
    expect(gates.map((n) => [n.gate?.step, n.gate?.ok, n.message])).toEqual([['typecheck', true, 'Typecheck passed on feature']])
    expect(landed).toEqual([{ session: child, branch: 'feature', target: 'master', sha: 'head0000000', subjects: ['feature: do the thing'] }])
  })

  it('a red typecheck holds the merge: HELD text with the tail, a failed gate row, nothing merged', async () => {
    const { git, calls } = fakeGit()
    const log = 'src/a.ts(3,1): error TS2322: wrong\nsrc/b.ts(9,2): error TS2345: also wrong\nFound 2 errors in 2 files.'
    const { runGate } = fakeGate((o) => (o.step === 'typecheck' ? { ok: false, log, exitCode: 1 } : {}))
    const landed: Landed[] = []
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate, onLanded: (l) => landed.push(l) })
    const child = reg.add({ cwd: '/wt', masterId: 'master1' })
    const text = await reviews.mergeBranch(child, {})
    expect(text).toMatch(/^HELD: typecheck failed on feature, 2 errors/)
    expect(text).toContain('error TS2345')
    expect(text).toContain('call merge_branch again')
    expect(calls).toEqual([])
    expect(landed).toEqual([])
    const [row] = reg.notices(child.id, 'gate')
    expect(reg.notices(child.id, null)).toHaveLength(1)
    expect(row.message).toBe('Typecheck failed on feature, 2 errors')
    expect(row.gate).toMatchObject({ step: 'typecheck', branch: 'feature', ok: false, log })
    expect(reg.notices(child.id)).toEqual([])
  })

  it('a thread outside any batch runs the commit tier since the merge-base, serialized like the rest', async () => {
    const { git, calls } = fakeGit()
    const { runs, runGate } = fakeGate()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate })
    const impl = reg.add({ cwd: '/wt' })
    const text = await reviews.mergeBranch(impl, {})
    expect(runs).toEqual([{ cwd: '/wt', step: 'gate', branch: 'feature', since: 'base0000000' }])
    expect(calls).toHaveLength(1)
    expect(text).toContain('Gate passed on feature')
    const red = fakeGate(() => ({ ok: false, log: '✓ typecheck 2s passed\n✗ vitest 40s failed: 1 test', exitCode: 1 }))
    const held = await new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate: red.runGate }).mergeBranch(impl, {})
    expect(held).toMatch(/^HELD: gate failed on feature, at vitest/)
  })

  it('two threads gate one at a time through the shared queue, and the waiter hears it', async () => {
    const { git } = fakeGit()
    let release!: () => void
    const gateDone = new Promise<void>((r) => (release = r))
    const order: string[] = []
    const runGate = async (o: GateRunOptions): Promise<GateRunResult> => {
      order.push(`start ${o.branch}`)
      if (o.branch === 'feature') await gateDone
      order.push(`end ${o.branch}`)
      return { ok: true, log: '', ms: 5, exitCode: 0 }
    }
    const queue = new GateQueue()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate, queue })
    const a = reg.add({ cwd: '/wt', masterId: 'm' })
    const other = fakeGit({ branchOf: async () => 'second', buildMergeBundle: async () => ({ ...fakeGit().bundle, branch: 'second' }) })
    const reviews2 = new MergeReviews({ registry: reg.registry, store: reg.store, git: other.git, runGate, queue })
    const b = reg.add({ cwd: '/wt2', masterId: 'm' })
    const pa = reviews.mergeBranch(a, {})
    await tick()
    const pb = reviews2.mergeBranch(b, {})
    await tick()
    expect(order).toEqual(['start feature'])
    release()
    await pa
    const tb = await pb
    expect(order).toEqual(['start feature', 'end feature', 'start second', 'end second'])
    expect(tb).toMatch(/in the gate queue behind 1/)
  })

  it('two landings race: one lock holds the gate, the merge and the push; the second rebases onto the moved target under it', async () => {
    // A fake repo: the target's head moves with every merge; a branch whose
    // base is behind it is not a fast-forward until rebased.
    const repo = { target: 'base0000000' }
    const bases = new Map<string, string>([['feature', 'base0000000'], ['second', 'base0000000']])
    const calls: string[] = []
    const gitFor = (branch: string) =>
      fakeGit({
        branchOf: async (cwd: string) => (cwd === '/repo' ? 'master' : branch),
        worktreeOf: async (_cwd: string, b: string) => (b === branch ? `/wt-${branch}` : null),
        buildMergeBundle: async () => ({ ...fakeGit().bundle, branch, head: `${branch}-head`, base: bases.get(branch)! }),
        targetMoved: async (_cwd: string, b: string) => bases.get(b) !== repo.target,
        rebaseOnto: async (cwd: string, b: string, target: string) => {
          calls.push(`rebase ${b} onto ${target}@${cwd}`)
          bases.set(b, repo.target)
          return { head: `${b}-rebased`, base: repo.target, rebased: true }
        },
        fastForwardMerge: async (_cwd: string, b: string, target: string, push: boolean) => {
          if (bases.get(b) !== repo.target) throw new MergeRefusal(`git merge --ff-only ${b} failed: not a fast-forward`)
          calls.push(`merge ${b}->${target}${push ? ' push' : ''}`)
          repo.target = `${b}-landed`
          return { sha: repo.target, merged: true, pushed: push }
        }
      }).git
    let release!: () => void
    const gateDone = new Promise<void>((r) => (release = r))
    const runGate = async (o: GateRunOptions): Promise<GateRunResult> => {
      calls.push(`gate ${o.branch}`)
      if (o.branch === 'feature') await gateDone
      return { ok: true, log: '', ms: 5, exitCode: 0 }
    }
    const queue = new GateQueue()
    const a = reg.add({ cwd: '/wt-feature', masterId: 'm' })
    const b = reg.add({ cwd: '/wt-second', masterId: 'm' })
    const pa = new MergeReviews({ registry: reg.registry, store: reg.store, git: gitFor('feature'), runGate, queue }).mergeBranch(a, {})
    await tick()
    const pb = new MergeReviews({ registry: reg.registry, store: reg.store, git: gitFor('second'), runGate, queue }).mergeBranch(b, {})
    await tick()
    // The second landing waits for the first's push, not only its typecheck.
    expect(calls).toEqual(['gate feature'])
    release()
    const ta = await pa
    const tb = await pb
    expect(calls).toEqual(['gate feature', 'merge feature->master push', 'rebase second onto master@/wt-second', 'gate second', 'merge second->master push'])
    expect(ta).toContain('Merged feature into master')
    expect(tb).toContain('Merged second into master')
    expect(tb).toContain('rebased onto master first')
    expect(tb).not.toMatch(/^refused/)
    expect(repo.target).toBe('second-landed')
  })

  it('a rebase that hits conflicts refuses the landing and leaves the review standing', async () => {
    const { git, calls } = fakeGit({
      targetMoved: async () => true,
      rebaseOnto: async () => {
        throw new MergeRefusal('rebasing feature onto master (abc) hit conflicts in x.ts; the branch is as it was. Rebase it by hand, resolve them, and merge again.')
      }
    })
    const { runs, runGate } = fakeGate()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate, queue: new GateQueue() })
    const child = reg.add({ cwd: '/wt', masterId: 'master1' })
    const text = await reviews.mergeBranch(child, {})
    expect(text).toMatch(/^refused: rebasing feature onto master .*hit conflicts in x\.ts/)
    expect(runs).toEqual([])
    expect(calls).toEqual([])
  })

  it('a passed review whose gate failed is not reviewed again on the next call', async () => {
    const { git } = fakeGit()
    const red = fakeGate(() => ({ ok: false, log: 'Found 1 error.', exitCode: 1 }))
    reg.setReview(ON)
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate: red.runGate })
    const impl = reg.add({ cwd: '/wt' })
    const p = reviews.mergeBranch(impl, {})
    await tick()
    reviews.reportFindings(reg.reviewer()!, { findings: [] })
    expect(await p).toMatch(/^HELD: gate failed/)
    const reviewers = [...reg.sessions.values()].filter((s) => s.agentType === 'reviewer').length
    const greenReviews = new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate: green })
    const text = await greenReviews.mergeBranch(impl, {})
    expect(text).toContain('Reviewed by Haiku 5.5: no blocking findings')
    expect(reg.notices(impl.id).at(-1)?.review).toMatchObject({ outcome: 'pass', merged: true, reason: 'already reviewed' })
    expect([...reg.sessions.values()].filter((s) => s.agentType === 'reviewer').length).toBe(reviewers)
  })

  it('Merge anyway past a held review skips the gate but still tells the batch', async () => {
    const { git, calls } = fakeGit()
    const red = fakeGate(() => ({ ok: false, log: 'Found 1 error.', exitCode: 1 }))
    const landed: Landed[] = []
    reg.setReview(ON)
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git, runGate: red.runGate, onLanded: (l) => landed.push(l) })
    const child = reg.add({ cwd: '/wt', masterId: 'm' })
    const p = reviews.mergeBranch(child, {})
    await tick()
    reviews.reportFindings(reg.reviewer()!, { findings: [finding()] })
    expect(await p).toMatch(/^HELD: Reviewed by/)
    const runId = reg.notices(child.id).at(-1)!.review!.runId
    await reviews.override(child.id, runId)
    expect(calls).toEqual(['merge feature->master@/repo push'])
    expect(red.runs).toEqual([])
    expect(landed.map((l) => l.branch)).toEqual(['feature'])
  })

  it('subjectsOf reads the bundle log', () => {
    expect(subjectsOf('abc1234 first\nbody line\n\ndef5678 second\n')).toEqual(['first', 'second'])
  })
})
