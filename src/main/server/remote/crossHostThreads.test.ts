import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import type { CrossHostCaller } from '@shared/contract-crosshost'
import { CrossHostThreads, OWNER_PREFIX, macPathFor, trimEvent } from './crossHostThreads'

const MAC = `env_${'m'.repeat(22)}`
const BOX = `env_${'b'.repeat(22)}`
const MAP = {
  roots: { '/Users/landon/IdeaProjects/temp-code': '/srv/agents/work/temp-code' },
  prefixes: { '/Users/landon': '/srv/agents/home' }
}

describe('macPathFor', () => {
  it('maps a box root back to the Mac checkout, with the rest of the path', () => {
    expect(macPathFor('/srv/agents/work/temp-code', MAP, '/Users/landon/IdeaProjects')).toBe(
      '/Users/landon/IdeaProjects/temp-code'
    )
    expect(macPathFor('/srv/agents/work/temp-code/ios/TempCode', MAP, '/Users/landon/IdeaProjects')).toBe(
      '/Users/landon/IdeaProjects/temp-code/ios/TempCode'
    )
  })
  it('maps a box home path back through the prefix', () => {
    expect(macPathFor('/srv/agents/home/.temp-code/x', MAP, '/Users/landon/IdeaProjects')).toBe(
      '/Users/landon/.temp-code/x'
    )
  })
  it("a checkout under the box work root with no map entry lands under the Mac's work root", () => {
    expect(macPathFor('/srv/agents/work/other', MAP, '/Users/landon/IdeaProjects', '/srv/agents/work')).toBe(
      '/Users/landon/IdeaProjects/other'
    )
  })
  it('answers null for a path nothing maps, and for a relative one', () => {
    expect(macPathFor('/opt/elsewhere', MAP, '/Users/landon/IdeaProjects', '/srv/agents/work')).toBeNull()
    expect(macPathFor('relative/path', MAP, '/Users/landon/IdeaProjects')).toBeNull()
  })
})

describe('trimEvent', () => {
  it('cuts long strings anywhere in the event and leaves the rest', () => {
    const out = trimEvent({ type: 'tool-call', input: { text: 'x'.repeat(50), n: 3 }, list: ['y'.repeat(50)] }, 10)
    expect(out.type).toBe('tool-call')
    expect((out.input as { text: string }).text).toBe(`${'x'.repeat(10)}…[40 more]`)
    expect((out.input as { n: number }).n).toBe(3)
    expect((out.list as string[])[0]).toBe(`${'y'.repeat(10)}…[40 more]`)
  })
})

// ── the service over a fake registry ─────────────────────────────────

function fakeRegistry() {
  const sessions = new Map<string, SessionMeta>()
  const events = new Map<string, EventRow[]>()
  const sent: { id: string; text: string }[] = []
  const subs = new Map<string, Set<(row: EventRow) => void>>()
  const metaListeners = new Set<(m: SessionMeta) => void>()
  const approvals: { id: string; requestId: string; allow: boolean }[] = []
  const answers: { id: string; requestId: string; answers: string[][] | null }[] = []
  let n = 0
  const registry = {
    async create(raw: Record<string, unknown>): Promise<SessionMeta> {
      const id = `s${++n}`
      const meta = {
        id,
        parentId: (raw.parentId as string | null) ?? null,
        projectId: (raw.projectId as string | null) ?? null,
        workspaceId: null,
        threadType: (raw.threadType as SessionMeta['threadType']) ?? null,
        planPath: (raw.planPath as string) ?? null,
        provider: raw.provider as SessionMeta['provider'],
        model: (raw.model as string) ?? 'm',
        reasoning: 'medium',
        agentType: (raw.agentType as SessionMeta['agentType']) ?? 'implementer',
        title: (raw.title as string) ?? 'Untitled',
        cwd: raw.cwd as string,
        status: 'idle',
        pinned: false,
        archived: false,
        permission: raw.permission as SessionMeta['permission'],
        fast: false,
        ultrafast: false,
        context1m: false,
        busySince: null,
        pausedAt: null,
        frozenActiveElapsed: null,
        nativeId: null,
        createdAt: 1,
        updatedAt: 1
      } as unknown as SessionMeta
      sessions.set(id, meta)
      events.set(id, [])
      return meta
    },
    async send(id: string, text: string): Promise<void> {
      sent.push({ id, text })
      registry.setStatus(id, 'running')
    },
    get: (id: string) => sessions.get(id) ?? null,
    eventsAfter: (id: string, after: number) => (events.get(id) ?? []).filter((r) => r.seq > after),
    async interrupt(): Promise<void> {},
    async answer(id: string, requestId: string, a: string[][] | null): Promise<void> {
      answers.push({ id, requestId, answers: a })
    },
    async approve(id: string, requestId: string, allow: boolean): Promise<void> {
      approvals.push({ id, requestId, allow })
    },
    lastActivityAt: () => Date.now(),
    subscribe(id: string, l: (row: EventRow) => void) {
      const set = subs.get(id) ?? new Set()
      set.add(l)
      subs.set(id, set)
      return () => set.delete(l)
    },
    onMeta(l: (m: SessionMeta) => void) {
      metaListeners.add(l)
      return () => metaListeners.delete(l)
    },
    listProjects: () => [{ id: 'p1', cwd: '/Users/landon/IdeaProjects/temp-code' }] as never,
    // test seams
    append(id: string, event: AgentEvent) {
      const rows = events.get(id)!
      const row: EventRow = { sessionId: id, seq: rows.length + 1, ts: Date.now(), event }
      rows.push(row)
      for (const l of subs.get(id) ?? []) l(row)
    },
    setStatus(id: string, status: SessionMeta['status']) {
      const meta = { ...sessions.get(id)!, status }
      sessions.set(id, meta)
      registry.append(id, { type: 'status', status } as AgentEvent)
      for (const l of metaListeners) l(meta)
    },
    sessions,
    sent,
    approvals,
    answers
  }
  return registry
}

function service(opts: { exists?: (p: string) => boolean; link?: (m: string, p: unknown) => Promise<unknown> } = {}) {
  const settings = new Map<string, string>()
  const registry = fakeRegistry()
  const requests: { method: string; params: unknown }[] = []
  const svc = new CrossHostThreads({
    environmentId: MAC,
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    registry: registry as never,
    environments: () => [{ id: BOX, name: 'box' }],
    link: () => async (method, params) => {
      requests.push({ method, params })
      return opts.link ? opts.link(method, params) : { ok: true }
    },
    pathMap: () => MAP,
    workRoot: () => '/Users/landon/IdeaProjects',
    exists: opts.exists ?? ((p) => p.startsWith('/Users/landon/IdeaProjects/temp-code')),
    worktree: async (cwd) => `${cwd}/.wt`,
    log: () => {}
  })
  return { svc, registry, settings, requests }
}
const caller: CrossHostCaller = { environmentId: BOX, sessionId: 'box-thread', title: 'Box thread', permission: 'auto' }
const ctx = { from: BOX, callId: 'c1', deadlineAt: Date.now() + 120_000 }
const startArgs = { threadType: 'chat' as const, provider: 'claude' as const, firstMessage: 'hello', cwd: '/srv/agents/work/temp-code', workRoot: '/srv/agents/work' }

afterEach(() => vi.useRealTimers())

describe('CrossHostThreads', () => {
  it('thread.start runs the thread in the mapped checkout, under the project there, with the caller permission', async () => {
    const { svc, registry, settings } = service()
    const r = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string; cwd: string; projectId: string | null; cwdNote?: string }
    expect(r.cwd).toBe('/Users/landon/IdeaProjects/temp-code')
    expect(r.projectId).toBe('p1')
    expect(r.cwdNote).toBeUndefined()
    const meta = registry.get(r.sessionId)!
    expect(meta.parentId).toBeNull()
    expect(meta.threadType).toBe('chat')
    expect(meta.permission).toBe('auto')
    expect(registry.sent).toEqual([{ id: r.sessionId, text: 'hello' }])
    expect(settings.get(`${OWNER_PREFIX}${r.sessionId}`)).toBe(BOX)
  })
  it('a box path with no checkout here starts in the work root and says so', async () => {
    const { svc } = service({ exists: () => false })
    const r = (await svc.handle('thread.start', { caller, args: { ...startArgs, cwd: '/srv/agents/work/other' } }, ctx)) as { cwd: string; cwdNote?: string }
    expect(r.cwd).toBe('/Users/landon/IdeaProjects')
    expect(r.cwdNote).toContain('no checkout for /srv/agents/work/other')
    expect(r.cwdNote).toContain('looked for /Users/landon/IdeaProjects/other')
  })
  it('thread.spawn makes a child of the box thread, in a worktree for a writer', async () => {
    const { svc, registry } = service()
    const r = (await svc.handle(
      'thread.spawn',
      { caller, args: { provider: 'claude' as const, model: 'claude-sonnet-5-5', reasoning: 'medium' as const, context1m: false, agentType: 'implementer' as const, task: 'build it', title: 'build it', useWorktree: true, cwd: '/srv/agents/work/temp-code' } },
      ctx
    )) as { sessionId: string; cwd: string }
    const meta = registry.get(r.sessionId)!
    expect(meta.parentId).toBe('box-thread')
    expect(meta.agentType).toBe('implementer')
    expect(r.cwd).toBe('/Users/landon/IdeaProjects/temp-code/.wt')
    expect(registry.sent[0].text).toBe('build it')
  })
  it('refuses a caller from another host, and a thread this host did not start', async () => {
    const { svc, registry } = service()
    await expect(svc.handle('thread.start', { caller, args: startArgs }, { ...ctx, from: 'env_other' })).rejects.toThrow('does not know that host')
    await expect(svc.handle('thread.start', { caller: { ...caller, environmentId: MAC }, args: startArgs }, ctx)).rejects.toThrow('another host as its caller')
    const own = await registry.create({ provider: 'claude', cwd: '/x', permission: 'safe' })
    await expect(svc.handle('thread.send', { caller, args: { sessionId: own.id, message: 'hi' } }, ctx)).rejects.toThrow('not a thread this host started')
  })
  it('thread.wait settles when the status leaves running, and answers unsettled at the deadline', async () => {
    const { svc, registry } = service()
    const { sessionId } = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
    const early = (await svc.handle('thread.wait', { caller, args: { sessionId, deadlineMs: 50 } }, ctx)) as { settled: boolean; status: string }
    expect(early).toMatchObject({ settled: false, status: 'running' })
    const waiting = svc.handle('thread.wait', { caller, args: { sessionId, deadlineMs: 5_000 } }, ctx) as Promise<{ settled: boolean; status: string; reply: string }>
    registry.append(sessionId, { type: 'assistant-text', text: 'done here' } as AgentEvent)
    registry.setStatus(sessionId, 'idle')
    expect(await waiting).toMatchObject({ settled: true, status: 'idle', reply: 'done here' })
  })
  it('thread.events is bounded and trimmed; thread.list names only this host threads', async () => {
    const { svc, registry } = service()
    const { sessionId } = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
    for (let i = 0; i < 5; i++) registry.append(sessionId, { type: 'assistant-text', text: 'z'.repeat(5_000) } as AgentEvent)
    const r = (await svc.handle('thread.events', { caller, args: { sessionId, afterSeq: 1, limit: 2 } }, ctx)) as { rows: { seq: number; event: { text: string } }[]; lastSeq: number }
    expect(r.rows.map((x) => x.seq)).toEqual([2, 3])
    expect(r.rows[0].event.text.length).toBeLessThan(4_100)
    expect(r.lastSeq).toBe(6)
    const list = (await svc.handle('thread.list', { caller, args: {} }, ctx)) as { sessionId: string; parentSessionId: string | null }[]
    expect(list.map((s) => s.sessionId)).toEqual([sessionId])
  })
  it('thread.answer decides an approval with allow and a question with answers', async () => {
    const { svc, registry } = service()
    const { sessionId } = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
    registry.append(sessionId, { type: 'approval-request', requestId: 'r1', toolName: 'Bash' } as AgentEvent)
    await expect(svc.handle('thread.answer', { caller, args: { sessionId, requestId: 'r1', answers: [['x']] } }, ctx)).rejects.toThrow('pass allow')
    expect(await svc.handle('thread.answer', { caller, args: { sessionId, requestId: 'r1', allow: true } }, ctx)).toEqual({ ok: true, kind: 'approval' })
    expect(registry.approvals).toEqual([{ id: sessionId, requestId: 'r1', allow: true }])
    registry.append(sessionId, { type: 'approval-resolved', requestId: 'r1' } as AgentEvent)
    registry.append(sessionId, { type: 'question-request', requestId: 'q1', questions: [] } as AgentEvent)
    await expect(svc.handle('thread.answer', { caller, args: { sessionId, requestId: 'wrong', answers: [['a']] } }, ctx)).rejects.toThrow('not this thread')
    expect(await svc.handle('thread.answer', { caller, args: { sessionId, requestId: 'q1', answers: [['a']] } }, ctx)).toEqual({ ok: true, kind: 'question' })
    expect(registry.answers).toEqual([{ id: sessionId, requestId: 'q1', answers: [['a']] }])
  })
  it('a settle is reported to the box over the link as crossHost.settled', async () => {
    vi.useFakeTimers()
    const { svc, registry, requests } = service()
    const { sessionId } = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
    registry.append(sessionId, { type: 'assistant-text', text: 'finished' } as AgentEvent)
    registry.setStatus(sessionId, 'idle')
    await vi.advanceTimersByTimeAsync(500)
    const settled = requests.find((r) => r.method === 'crossHost.settled')
    expect(settled?.params).toMatchObject({ from: MAC, sessionId, parentSessionId: null, status: 'idle', reply: 'finished' })
    // Idle → idle again (a meta change with no settle) reports nothing more.
    registry.setStatus(sessionId, 'idle')
    await vi.advanceTimersByTimeAsync(500)
    expect(requests.filter((r) => r.method === 'crossHost.settled')).toHaveLength(1)
  })
})
