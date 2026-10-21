import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import { DEFAULT_REVIEW_SETTINGS, type ReviewSettings } from '@shared/review'
import { MergeRefusal, type MergeBundle } from './mergeBranch'
import { MergeReviews, type MergeReviewDeps } from './mergeReview'
import { settleSuppressed } from './orchestration'

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
    notices: (id: string) =>
      (events.get(id) ?? []).map((r) => r.event).filter((e) => e.type === 'notice') as Extract<AgentEvent, { type: 'notice' }>[],
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
    const impl = reg.add({ cwd: '/wt' })
    expect(await reviews.mergeBranch(impl, {})).toMatch(/^refused: .*not on a branch/)

    const empty = fakeGit({ buildMergeBundle: async () => ({ ...fakeGit().bundle, empty: true }) })
    expect(await new MergeReviews({ registry: reg.registry, store: reg.store, git: empty.git }).mergeBranch(impl, {})).toMatch(/^nothing to merge/)

    const noFf = fakeGit({
      fastForwardMerge: async () => {
        throw new MergeRefusal('git merge --ff-only feature failed: not a fast-forward. Rebase feature onto master and merge again.')
      }
    })
    expect(await new MergeReviews({ registry: reg.registry, store: reg.store, git: noFf.git }).mergeBranch(impl, {})).toMatch(/^refused: git merge --ff-only/)
  })
})

describe('merge_branch under review', () => {
  it('sends the reviewer the diff against the merge-base, the commits, the files and the brief', async () => {
    reg.setReview(ON)
    const { git, bundle } = fakeGit()
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
    const impl = reg.add({ cwd: '/repo' })
    const onTarget = fakeGit({ buildMergeBundle: async () => ({ ...fakeGit().bundle, branch: 'master', empty: true }) })
    expect(await new MergeReviews({ registry: reg.registry, store: reg.store, git: onTarget.git }).mergeBranch(impl, {})).toMatch(
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
    const impl = reg.add({ cwd: '/wt' })
    const pending = reviews.mergeBranch(impl, {})
    await tick()
    reviews.reportFindings(reg.reviewer()!, { findings: [finding()] })
    await pending
    const runId = reg.notices(impl.id)[0].review!.runId
    // A new instance over the same store: the held run is still there.
    const after = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git })
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
    const reviews = new MergeReviews({ registry: reg.registry, store: reg.store, git: fakeGit().git })
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
