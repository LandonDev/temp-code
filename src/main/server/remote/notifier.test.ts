import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import { batchBody, Notifier, type Notice, type NotifierRegistry } from './notifier'

/** A registry of metas and rows the test drives by hand. */
class FakeRegistry implements NotifierRegistry {
  metas = new Map<string, SessionMeta>()
  activity = new Map<string, number>()
  private metaListeners = new Set<(meta: SessionMeta) => void>()
  private eventListeners = new Set<(row: EventRow) => void>()
  private seqs = new Map<string, number>()

  onMeta(l: (meta: SessionMeta) => void): () => void {
    this.metaListeners.add(l)
    return () => this.metaListeners.delete(l)
  }
  onEvent(l: (row: EventRow) => void): () => void {
    this.eventListeners.add(l)
    return () => this.eventListeners.delete(l)
  }
  list(opts: { archived?: boolean } = {}): SessionMeta[] {
    return [...this.metas.values()].filter((m) => m.archived === (opts.archived ?? false))
  }
  get(id: string): SessionMeta | null {
    return this.metas.get(id) ?? null
  }
  rootSessionOf(id: string): string {
    return this.metas.get(id)?.parentId ?? id
  }
  lastActivityAt(id: string): number {
    return this.activity.get(id) ?? 0
  }

  add(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
    const meta: SessionMeta = {
      id,
      parentId: null,
      projectId: null,
      workspaceId: null,
      threadType: 'implementation',
      planPath: null,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      reasoning: 'low',
      agentType: 'implementer',
      title: `thread ${id}`,
      cwd: '/tmp',
      status: 'idle',
      pinned: false,
      archived: false,
      permission: 'edits',
      fast: false,
      ultrafast: false,
      context1m: false,
      busySince: null,
      pausedAt: null,
      frozenActiveElapsed: null,
      nativeId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...patch
    }
    this.metas.set(id, meta)
    return meta
  }
  status(id: string, status: SessionMeta['status']): void {
    this.push(id, { status })
  }
  push(id: string, patch: Partial<SessionMeta>): void {
    const meta = { ...this.metas.get(id)!, ...patch, updatedAt: Date.now() }
    this.metas.set(id, meta)
    for (const l of this.metaListeners) l(meta)
  }
  row(id: string, event: AgentEvent): EventRow {
    const seq = (this.seqs.get(id) ?? 0) + 1
    this.seqs.set(id, seq)
    const row: EventRow = { sessionId: id, seq, ts: Date.now(), event }
    this.activity.set(id, row.ts)
    for (const l of this.eventListeners) l(row)
    return row
  }
}

let reg: FakeRegistry
let notifier: Notifier
let notices: Notice[]
let stuckMinutes = 10
const lines: string[] = []

const settle = (): void => {
  vi.advanceTimersByTime(1500)
}
const minutes = (n: number): void => {
  vi.advanceTimersByTime(n * 60_000)
}
const seen = (): string[] => notices.map((n) => `${n.event}:${n.threadId}`)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  reg = new FakeRegistry()
  notices = []
  stuckMinutes = 10
  lines.length = 0
  notifier = new Notifier({
    registry: reg,
    stuckMinutes: () => stuckMinutes,
    origin: () => 'https://tc.example',
    now: () => Date.now(),
    log: (l) => lines.push(l)
  })
  notifier.onNotice((n) => {
    notices.push(n)
  })
})
afterEach(() => {
  notifier.stop()
  vi.useRealTimers()
})

describe('needs_you', () => {
  it('fires once for a permission prompt, never for the same prompt twice, then finished once', () => {
    reg.add('t1', { title: 'Ship it' })
    notifier.start()
    reg.status('t1', 'running')
    reg.row('t1', { type: 'user-text', text: 'go' })
    reg.row('t1', {
      type: 'approval-request',
      requestId: 'a1',
      toolName: 'Bash',
      input: { command: 'git push --force' }
    })
    reg.status('t1', 'waiting')
    expect(notices).toEqual([])
    settle()
    expect(notices).toEqual([
      {
        event: 'needs_you',
        kind: 'approval',
        threadId: 't1',
        title: 'Ship it',
        body: 'Needs approval: Bash — git push --force',
        url: 'https://tc.example/ui#thread=t1',
        ts: Date.now(),
        seq: 2,
        requestId: 'a1'
      }
    ])
    reg.push('t1', { activity: 'thinking' })
    reg.status('t1', 'waiting')
    settle()
    expect(seen()).toEqual(['needs_you:t1'])
    reg.row('t1', { type: 'approval-resolved', requestId: 'a1', allow: true })
    reg.status('t1', 'running')
    settle()
    expect(seen()).toEqual(['needs_you:t1'])
    reg.row('t1', { type: 'turn-complete' })
    reg.status('t1', 'idle')
    settle()
    expect(seen()).toEqual(['needs_you:t1', 'finished:t1'])
    expect(notices[1].body).toBe('Done in 6s')
    reg.status('t1', 'idle')
    reg.push('t1', { tasks: { done: 1, total: 1 } })
    settle()
    expect(seen()).toEqual(['needs_you:t1', 'finished:t1'])
    // The next turn is a new state: it finishes again.
    reg.status('t1', 'running')
    reg.row('t1', { type: 'user-text', text: 'again' })
    reg.status('t1', 'idle')
    settle()
    expect(seen()).toEqual(['needs_you:t1', 'finished:t1', 'finished:t1'])
  })
  it('names questions and plan prompts, and a prompt answered inside the window makes no notice', () => {
    reg.add('q', { status: 'running' })
    reg.add('p', { status: 'running' })
    reg.add('fast', { status: 'running' })
    notifier.start()
    reg.row('q', {
      type: 'question-request',
      requestId: 'q1',
      questions: [{ question: 'Tabs or spaces?', options: [{ label: 'Tabs' }] }]
    })
    reg.status('q', 'waiting')
    reg.row('p', { type: 'approval-request', requestId: 'p1', toolName: 'ExitPlanMode', input: {} })
    reg.status('p', 'waiting')
    reg.row('fast', { type: 'approval-request', requestId: 'f1', toolName: 'Bash', input: {} })
    reg.status('fast', 'waiting')
    vi.advanceTimersByTime(500)
    reg.row('fast', { type: 'approval-resolved', requestId: 'f1', allow: true, auto: true })
    reg.status('fast', 'running')
    reg.row('fast', { type: 'turn-complete' })
    reg.status('fast', 'idle')
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toEqual([
      ['needs_you', 'q', 'Asked: Tabs or spaces?'],
      ['needs_you', 'p', 'Plan ready to approve'],
      ['finished', 'fast', 'Done in 2s']
    ])
  })
  it('reports a subagent prompt on its root, naming the subagent', () => {
    reg.add('root', { title: 'Fleet', status: 'running' })
    reg.add('kid', { title: 'review-auth', parentId: 'root', status: 'running' })
    notifier.start()
    reg.row('kid', {
      type: 'approval-request',
      requestId: 'k1',
      toolName: 'Bash',
      input: { command: 'rm -rf dist' }
    })
    reg.status('kid', 'waiting')
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.title, n.body])).toEqual([
      ['needs_you', 'root', 'Fleet', 'Needs approval (subagent review-auth): Bash — rm -rf dist']
    ])
    reg.row('kid', { type: 'approval-resolved', requestId: 'k1', allow: false })
    reg.status('kid', 'running')
    settle()
    expect(seen()).toEqual(['needs_you:root'])
  })
})

describe('failed', () => {
  it('fires once when an error ends the turn, and at once for a lapsed sign-in', () => {
    reg.add('e', { status: 'running' })
    reg.add('s', { status: 'running' })
    notifier.start()
    reg.row('e', { type: 'error', message: 'harness died: exit 1' })
    reg.status('e', 'error')
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toEqual([
      ['failed', 'e', 'Failed: harness died: exit 1']
    ])
    reg.status('e', 'error')
    reg.push('e', { canContinue: true })
    settle()
    expect(seen()).toEqual(['failed:e'])
    reg.row('s', { type: 'error', message: 'Aliax account work needs sign-in' })
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toContainEqual([
      'failed',
      's',
      'Failed: Aliax account work needs sign-in'
    ])
    reg.status('s', 'error')
    settle()
    expect(seen().filter((s) => s === 'failed:s').length).toBe(1)
  })
  it('a stop by the user is not a finish and not a failure', () => {
    reg.add('x', { status: 'running' })
    notifier.start()
    reg.row('x', { type: 'error', message: 'turn ended: interrupted', stopped: true })
    reg.status('x', 'idle')
    settle()
    expect(notices).toEqual([])
  })
})

describe('stuck', () => {
  it('fires after the silent limit, once per silence, and follows the setting', () => {
    reg.add('w', { status: 'running' })
    notifier.start()
    reg.row('w', { type: 'user-text', text: 'go' })
    minutes(9)
    expect(notices).toEqual([])
    minutes(1.5)
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toEqual([
      ['stuck', 'w', 'Quiet for 10 min while working']
    ])
    minutes(10)
    expect(seen()).toEqual(['stuck:w'])
    reg.row('w', { type: 'tool-call', callId: 'c1', name: 'Bash', input: {} })
    minutes(5)
    expect(seen()).toEqual(['stuck:w'])
    minutes(5.5)
    expect(seen()).toEqual(['stuck:w', 'stuck:w'])
    reg.row('w', { type: 'tool-result', callId: 'c1', output: 'ok', isError: false })
    stuckMinutes = 1
    minutes(1.5)
    expect(seen()).toEqual(['stuck:w', 'stuck:w', 'stuck:w'])
    // Settled threads are never stuck.
    reg.status('w', 'idle')
    minutes(30)
    expect(seen().filter((s) => s === 'stuck:w').length).toBe(3)
  })
  it('a stall report makes a working thread stuck at once; a subagent row counts as activity', () => {
    reg.add('r', { status: 'running' })
    reg.add('c', { parentId: 'r', status: 'running' })
    reg.add('idle', { status: 'idle' })
    notifier.start()
    notifier.reportStall('c')
    notifier.reportStall('idle')
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toEqual([
      ['stuck', 'r', 'Stalled while working']
    ])
    minutes(9.9)
    reg.row('c', { type: 'tool-call', callId: 'k', name: 'Read', input: {} })
    minutes(9.9)
    expect(seen()).toEqual(['stuck:r'])
  })
})

describe('plumbing', () => {
  it('seeds without notices, drops archived threads, and keeps going when a sink throws', () => {
    reg.add('seed-idle', { status: 'idle' })
    reg.add('seed-run', { status: 'running' })
    reg.activity.set('seed-run', Date.now())
    notifier.start()
    settle()
    expect(notices).toEqual([])
    const off = notifier.onNotice(() => {
      throw new Error('bad sink')
    })
    notifier.onNotice(async () => {
      throw new Error('bad async sink')
    })
    reg.row('seed-run', { type: 'error', message: 'boom' })
    reg.status('seed-run', 'error')
    settle()
    expect(seen()).toEqual(['failed:seed-run'])
    expect(lines.filter((l) => l.startsWith('sink failed: bad sink')).length).toBe(1)
    off()
    reg.push('seed-idle', { archived: true, status: 'running' })
    reg.row('seed-idle', { type: 'approval-request', requestId: 'z', toolName: 'Bash', input: {} })
    settle()
    expect(seen()).toEqual(['failed:seed-run'])
    notifier.stop()
    reg.status('seed-run', 'idle')
    settle()
    expect(seen()).toEqual(['failed:seed-run'])
  })
})

describe('a completed plan', () => {
  it('says the plan is complete and whether its build started', () => {
    reg.add('p', { threadType: 'planning', planPath: '/p.md', title: 'Plan: widget' })
    notifier.start()
    reg.status('p', 'running')
    reg.row('p', { type: 'user-text', text: 'plan it' })
    reg.row('p', { type: 'assistant-text', text: 'done', delta: false } as AgentEvent)
    reg.push('p', { status: 'idle', planCompletedAt: 7 })
    settle()
    expect(notices.at(-1)).toMatchObject({ event: 'finished', threadId: 'p', body: 'Plan complete — waiting for you to start the build' })
    reg.add('b', { threadType: 'implementation', title: 'Ship it' })
    reg.status('p', 'running')
    reg.row('p', { type: 'assistant-text', text: 'more', delta: false } as AgentEvent)
    reg.push('p', { status: 'idle', planCompletedAt: 7, implementationId: 'b' })
    settle()
    expect(notices.at(-1)).toMatchObject({ event: 'finished', threadId: 'p', body: 'Plan complete — implementation started: Ship it' })
  })
})

describe("the host's verdict, a gone harness, a queued thread", () => {
  it('a failure summary beats the raw error line', () => {
    reg.add('f', { status: 'running' })
    notifier.start()
    reg.row('f', {
      type: 'error',
      message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      failure: { kind: 'rate_limited', account: 'work', summary: 'Usage limit reached for the 5h window on work', cause: 'The window resets at 14:00.' }
    })
    reg.status('f', 'error')
    settle()
    expect(notices.map((n) => [n.event, n.kind, n.body])).toEqual([['failed', 'failed', 'Failed: Usage limit reached for the 5h window on work']])
  })
  it('a stopped thread says the harness is gone, once', () => {
    reg.add('g', { status: 'running' })
    notifier.start()
    reg.row('g', { type: 'user-text', text: 'go' })
    reg.status('g', 'stopped')
    settle()
    expect(notices.map((n) => [n.event, n.kind, n.body, n.seq])).toEqual([['failed', 'stopped', 'Stopped: the harness is gone', 1]])
    reg.status('g', 'stopped')
    settle()
    expect(seen()).toEqual(['failed:g'])
    // Resumed and finished: a new state.
    reg.status('g', 'running')
    reg.row('g', { type: 'turn-complete' })
    reg.status('g', 'idle')
    settle()
    expect(seen()).toEqual(['failed:g', 'finished:g'])
  })
  it('a queued thread emits nothing until it runs', () => {
    reg.add('q', { status: 'queued' })
    notifier.start()
    reg.status('q', 'queued')
    reg.push('q', { activity: 'Queued · waiting for t0' })
    settle()
    minutes(30)
    expect(notices).toEqual([])
    reg.status('q', 'running')
    reg.row('q', { type: 'user-text', text: 'go' })
    reg.status('q', 'idle')
    settle()
    expect(notices.map((n) => [n.event, n.kind])).toEqual([['finished', 'finished']])
  })
  it('every notice names the host and the plan body carries its kind', () => {
    notifier.stop()
    notifier = new Notifier({ registry: reg, stuckMinutes: () => 10, hostName: () => 'box', now: () => Date.now(), log: () => {} })
    notifier.onNotice((n) => {
      notices.push(n)
    })
    reg.add('p', { threadType: 'planning', planPath: '/p.md', status: 'running' })
    notifier.start()
    reg.row('p', { type: 'user-text', text: 'plan it' })
    reg.push('p', { status: 'idle', planCompletedAt: 7 })
    settle()
    expect(notices).toEqual([expect.objectContaining({ event: 'finished', kind: 'plan', hostName: 'box', body: 'Plan complete — waiting for you to start the build' })])
  })
})

describe("a master's batch", () => {
  const gate = (ok: boolean, step: 'gate' | 'release' = 'gate') => ({ step, branch: 'master', ok, log: ok ? '✓ vitest 12s' : '✗ vitest 12s failed', at: 1 })
  it('says the batch is done once the master is between turns, and stays quiet on a thread that is not a master', () => {
    reg.add('m', { threadType: 'chat', isMaster: true, status: 'running' })
    reg.add('c', { status: 'running' })
    notifier.start()
    reg.row('m', { type: 'user-text', text: 'run the batch' })
    reg.row('m', { type: 'notice', kind: 'batch', message: 'Batch done: 3 landed · gate passed in 4m 12s · release-281 tagged' })
    settle()
    expect(notices).toEqual([])
    reg.status('m', 'watching')
    settle()
    expect(notices.map((n) => [n.event, n.kind, n.body, n.seq])).toEqual([['finished', 'batch', 'Batch done · 3 landed · gate passed in 4m 12s · release-281 tagged', 2]])
    // Told once: the master's next idle is an ordinary finish, not the batch again.
    reg.status('m', 'running')
    reg.row('m', { type: 'assistant-text', text: 'Landed.', delta: false } as AgentEvent)
    reg.status('m', 'idle')
    settle()
    expect(notices.map((n) => n.kind)).toEqual(['batch', 'finished'])
    // A gate row on a thread that is not a master is merge_branch's own gate: nothing.
    reg.row('c', { type: 'notice', kind: 'gate', message: 'Gate failed on c · at vitest', gate: gate(false) })
    reg.status('c', 'idle')
    settle()
    expect(notices.map((n) => n.threadId)).toEqual(['m', 'm', 'c'])
    expect(notices.at(-1)).toMatchObject({ kind: 'finished', body: 'Done' })
  })
  it('a failing gate or release step stops the batch; a passing one says nothing', () => {
    reg.add('m', { threadType: 'chat', isMaster: true, status: 'watching' })
    notifier.start()
    reg.row('m', { type: 'notice', kind: 'gate', message: 'Gate passed on master', gate: gate(true) })
    settle()
    expect(notices).toEqual([])
    reg.row('m', { type: 'notice', kind: 'gate', message: 'Gate failed on master · at vitest', gate: gate(false) })
    settle()
    expect(notices.map((n) => [n.event, n.kind, n.body])).toEqual([['failed', 'batch', 'Batch stopped: gate failed · at vitest']])
    reg.row('m', { type: 'notice', kind: 'gate', message: 'Release failed on master', gate: gate(false, 'release') })
    settle()
    expect(notices.at(-1)).toMatchObject({ event: 'failed', kind: 'batch', body: 'Batch stopped: release failed' })
  })
  it('batchBody reads the engine rows and nothing else', () => {
    expect(batchBody({ kind: 'batch', message: 'Batch done: 2 landed\nmore' })).toEqual({ body: 'Batch done · 2 landed', failed: false })
    expect(batchBody({ kind: 'batch', message: 'Batch done' })).toEqual({ body: 'Batch done', failed: false })
    expect(batchBody({ kind: 'batch', message: 'Merged by the batch: b → master at abc' })).toBeNull()
    expect(batchBody({ kind: 'gate', message: 'Gate passed on master', gate: { step: 'gate', ok: true } })).toBeNull()
    expect(batchBody({ kind: 'gate', message: 'Typecheck failed on b · 3 errors', gate: { step: 'typecheck', ok: false } })).toEqual({ body: 'Batch stopped: typecheck failed · 3 errors', failed: true })
    expect(batchBody({ kind: 'account-gone', message: 'Account work is gone' })).toBeNull()
  })
})
