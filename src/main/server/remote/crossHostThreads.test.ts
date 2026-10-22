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
        startedBy: (raw.startedBy as string | null) ?? null,
        masterId: (raw.masterId as string | null) ?? null,
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
    list: () => [...sessions.values()].filter((m) => !m.archived),
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

function service(
  opts: {
    exists?: (p: string) => boolean
    link?: (m: string, p: unknown) => Promise<unknown>
    admit?: (envId: string) => { ok: boolean; reason?: string }
    ensureLinked?: ConstructorParameters<typeof CrossHostThreads>[0]['ensureLinked']
  } = {}
) {
  const settings = new Map<string, string>()
  const registry = fakeRegistry()
  const requests: { method: string; params: unknown }[] = []
  const pushed: string[] = []
  const svc = new CrossHostThreads({
    ...(opts.admit ? { admit: opts.admit } : {}),
    ...(opts.ensureLinked ? { ensureLinked: opts.ensureLinked } : {}),
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
    attachmentDirs: () => [],
    pushBranch: async (cwd, branch) => void pushed.push(`${cwd}:${branch}`),
    log: () => {}
  })
  return { svc, registry, settings, requests, pushed }
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
  it("thread.start stamps the box caller as the starter and carries the caller's batch (masterId) when one rides along", async () => {
    const { svc, registry } = service()
    const plain = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
    expect(registry.get(plain.sessionId)).toMatchObject({ startedBy: 'box-thread', masterId: null })
    const inBatch = (await svc.handle('thread.start', { caller, args: { ...startArgs, masterId: 'box-master' } }, ctx)) as { sessionId: string }
    expect(registry.get(inBatch.sessionId)).toMatchObject({ startedBy: 'box-thread', masterId: 'box-master' })
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
  it("the Mac bridge's thread cap is asked before a start or a spawn, with the host's id; a refusal is the tool's error", async () => {
    const asked: string[] = []
    let verdict: { ok: boolean; reason?: string } = { ok: true }
    const { svc, registry } = service({ admit: (envId) => (asked.push(envId), verdict) })
    const r = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
    expect(asked).toEqual([BOX])
    // What the cap counts: the threads this host started here that are live now.
    expect(svc.liveThreadsOf(BOX)).toBe(1)
    expect(svc.liveThreadsOf('env_other')).toBe(0)
    registry.setStatus(r.sessionId, 'idle')
    expect(svc.liveThreadsOf(BOX)).toBe(0)
    verdict = { ok: false, reason: 'the Mac already runs 2 threads from this host, its cap of 2' }
    await expect(svc.handle('thread.start', { caller, args: startArgs }, ctx)).rejects.toThrow(/already runs 2 threads/)
    await expect(
      svc.handle('thread.spawn', { caller, args: { provider: 'claude' as const, model: 'claude-sonnet-5-5', reasoning: 'medium' as const, context1m: false, agentType: 'explorer' as const, task: 'look', title: 'look', useWorktree: false, cwd: '/srv/agents/work/temp-code' } }, ctx)
    ).rejects.toThrow(/already runs 2 threads/)
    expect(registry.sent.length).toBe(1)
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
    // A started thread names its starter as the parent (the owner's record sits under that thread); a spawned one its parentId.
    expect(settled?.params).toMatchObject({ from: MAC, sessionId, parentSessionId: 'box-thread', status: 'idle', reply: 'finished' })
    // Idle → idle again (a meta change with no settle) reports nothing more.
    registry.setStatus(sessionId, 'idle')
    await vi.advanceTimersByTimeAsync(500)
    expect(requests.filter((r) => r.method === 'crossHost.settled')).toHaveLength(1)
  })
})

// ── both directions: the box serving the Mac, the batch's reach, the landing hooks ──

import { boxPathFor, hostPathFor, listAttachments } from './crossHostThreads'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('boxPathFor and hostPathFor', () => {
  it('maps a Mac root onto the box checkout, a Mac home path through the prefix, and a Mac work-root checkout onto the box work root', () => {
    expect(boxPathFor('/Users/landon/IdeaProjects/temp-code/src', MAP, '/srv/agents/work')).toBe('/srv/agents/work/temp-code/src')
    expect(boxPathFor('/Users/landon/.claude/x', MAP, '/srv/agents/work')).toBe('/srv/agents/home/.claude/x')
    // The map first (the home prefix covers IdeaProjects here), the work roots for a path outside it.
    expect(boxPathFor('/Users/landon/IdeaProjects/other', MAP, '/srv/agents/work', '/Users/landon/IdeaProjects')).toBe('/srv/agents/home/IdeaProjects/other')
    expect(boxPathFor('/Volumes/work/other', MAP, '/srv/agents/work', '/Volumes/work')).toBe('/srv/agents/work/other')
    expect(boxPathFor('/opt/x', MAP, '/srv/agents/work', '/Users/landon/IdeaProjects')).toBeNull()
    expect(boxPathFor('rel', MAP, '/srv/agents/work')).toBeNull()
  })
  it('hostPathFor tries the inverse map, the forward map and the work roots, and says whether the first hit exists', () => {
    const exists = (p: string): boolean => p.startsWith('/srv/agents/work/temp-code') || p === '/Users/landon/IdeaProjects/temp-code'
    // A box path on the Mac (inverse), a Mac path on the box (forward): each matches only its own side.
    expect(hostPathFor('/srv/agents/work/temp-code', MAP, '/Users/landon/IdeaProjects', '/srv/agents/work', exists)).toEqual({ path: '/Users/landon/IdeaProjects/temp-code', exists: true })
    expect(hostPathFor('/Users/landon/IdeaProjects/temp-code', MAP, '/srv/agents/work', '/Users/landon/IdeaProjects', exists)).toEqual({ path: '/srv/agents/work/temp-code', exists: true })
    expect(hostPathFor('/Users/landon/IdeaProjects/missing', MAP, '/srv/agents/work', '/Users/landon/IdeaProjects', exists)).toEqual({ path: '/srv/agents/work/missing', exists: false })
    expect(hostPathFor('/elsewhere', MAP, '/srv/agents/work', '/Users/landon/IdeaProjects', exists)).toBeNull()
  })
  it('listAttachments walks the directories, skips dotfiles, and caps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-att-'))
    try {
      mkdirSync(join(dir, 'shots'))
      writeFileSync(join(dir, 'notes.md'), 'n')
      writeFileSync(join(dir, '.hidden'), 'h')
      writeFileSync(join(dir, 'shots', 'one.png'), 'p')
      writeFileSync(join(dir, 'shots', 'two.png'), 'p')
      expect(listAttachments([dir, join(dir, 'nope')])).toEqual([join(dir, 'notes.md'), join(dir, 'shots', 'one.png'), join(dir, 'shots', 'two.png')])
      expect(listAttachments([dir], 2)).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CrossHostThreads: the box serving the Mac', () => {
  it('handleRequest serves a thread.* request from a registered peer and refuses one from a socket that never registered', async () => {
    const { svc, registry } = service()
    const r = (await svc.handleRequest('thread.start', { caller, args: startArgs }, BOX)) as { sessionId: string }
    expect(registry.get(r.sessionId)?.startedBy).toBe('box-thread')
    await expect(svc.handleRequest('thread.check', { caller, args: { sessionId: r.sessionId } }, null)).rejects.toThrow('peer.register')
    expect(svc.handleRequest('session.list', {}, BOX)).toBeNull()
  })
  it("a Mac caller's path lands in the box checkout through the forward map", async () => {
    const { svc } = service({ exists: (p) => p === '/srv/agents/work/temp-code' })
    const r = (await svc.handle('thread.start', { caller, args: { ...startArgs, cwd: '/Users/landon/IdeaProjects/temp-code', workRoot: '/Users/landon/IdeaProjects' } }, ctx)) as { cwd: string; cwdNote?: string }
    expect(r.cwd).toBe('/srv/agents/work/temp-code')
    expect(r.cwdNote).toBeUndefined()
  })
  it("without a Mac bridge cap this host's own crossHost.maxThreads.<env> admits (default 4), and a settings row changes it", async () => {
    const { svc, settings, registry } = service()
    for (let i = 0; i < 4; i++) await svc.handle('thread.start', { caller, args: startArgs }, ctx)
    await expect(svc.handle('thread.start', { caller, args: startArgs }, ctx)).rejects.toThrow('4 of at most 4 threads for box already (crossHost.maxThreads.')
    settings.set(`crossHost.maxThreads.${BOX}`, '6')
    await svc.handle('thread.start', { caller, args: startArgs }, ctx)
    expect(svc.liveThreadsOf(BOX)).toBe(5)
    registry.setStatus('s1', 'idle')
    expect(svc.admitThread(BOX)).toEqual({ ok: true })
    settings.set(`crossHost.maxThreads.${BOX}`, '0')
    expect(svc.admitThread(BOX).ok).toBe(false)
  })
  it('thread.pause, thread.resume and thread.archive reach the registry for a thread this caller started, and nothing else', async () => {
    const { svc, registry } = service()
    const calls: string[] = []
    Object.assign(registry, {
      pauseRun: async (id: string) => void calls.push(`pause ${id}`),
      resumePausedRun: async (id: string) => void calls.push(`resume ${id}`),
      setArchived: async (id: string, a: boolean) => {
        calls.push(`archive ${id} ${a}`)
        registry.sessions.set(id, { ...registry.sessions.get(id)!, archived: true })
      }
    })
    const { sessionId } = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
    expect(await svc.handle('thread.pause', { caller, args: { sessionId } }, ctx)).toEqual({ ok: true })
    expect(await svc.handle('thread.resume', { caller, args: { sessionId } }, ctx)).toEqual({ ok: true })
    expect(await svc.handle('thread.archive', { caller, args: { sessionId } }, ctx)).toEqual({ ok: true })
    expect(calls).toEqual([`pause ${sessionId}`, `resume ${sessionId}`, `archive ${sessionId} true`])
    const other = await registry.create({ provider: 'claude', cwd: '/x', title: 'own' })
    await expect(svc.handle('thread.pause', { caller, args: { sessionId: other.id } }, ctx)).rejects.toThrow('not a thread this host started')
  })
  it('thread.adopt takes an unarchived root of no batch into the caller\'s batch, makes the caller its owner, and refuses the rest with why', async () => {
    const { svc, registry, settings } = service()
    const members: string[] = []
    Object.assign(registry, { setBatchMembership: (id: string, masterId: string) => void members.push(`${id}→${masterId}`) })
    const loose = await registry.create({ provider: 'codex', cwd: '/x', title: 'Loose' })
    const r = (await svc.handle('thread.adopt', { caller, args: { sessionId: loose.id, masterId: 'box-master' } }, ctx)) as { ok: true; sessionId: string; title: string }
    expect(r).toMatchObject({ ok: true, sessionId: loose.id, title: 'Loose', provider: 'codex' })
    expect(members).toEqual([`${loose.id}→box-master`])
    expect(settings.get(`${OWNER_PREFIX}${loose.id}`)).toBe(BOX)
    expect(await svc.handle('thread.check', { caller, args: { sessionId: loose.id } }, ctx)).toMatchObject({ sessionId: loose.id })
    const sub = await registry.create({ provider: 'claude', cwd: '/x', parentId: loose.id })
    await expect(svc.handle('thread.adopt', { caller, args: { sessionId: sub.id, masterId: 'box-master' } }, ctx)).rejects.toThrow('it is a subagent')
    const taken = await registry.create({ provider: 'claude', cwd: '/x', masterId: 'other-master' })
    await expect(svc.handle('thread.adopt', { caller, args: { sessionId: taken.id, masterId: 'box-master' } }, ctx)).rejects.toThrow('in the batch of other-master')
    await expect(svc.handle('thread.adopt', { caller, args: { sessionId: 'nope', masterId: 'box-master' } }, ctx)).rejects.toThrow('unknown thread')
    settings.set(`${OWNER_PREFIX}${loose.id}`, MAC)
    await expect(svc.handle('thread.adopt', { caller, args: { sessionId: loose.id, masterId: 'box-master' } }, ctx)).rejects.toThrow('belongs to a thread on')
  })
  it('thread.events names the files under the attachments directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-att-'))
    try {
      writeFileSync(join(dir, 'shot.png'), 'p')
      const settings = new Map<string, string>()
      const registry = fakeRegistry()
      const svc = new CrossHostThreads({
        environmentId: MAC,
        store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
        registry: registry as never,
        environments: () => [{ id: BOX, name: 'box' }],
        link: () => null,
        pathMap: () => MAP,
        workRoot: () => '/Users/landon/IdeaProjects',
        exists: () => true,
        attachmentDirs: () => [dir],
        log: () => {}
      })
      const { sessionId } = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
      const r = (await svc.handle('thread.events', { caller, args: { sessionId } }, ctx)) as { attachments: string[] }
      expect(r.attachments).toEqual([join(dir, 'shot.png')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CrossHostThreads: a batch thread here landing', () => {
  it('landingHold pushes the branch, asks the owner, and holds when told to; a thread of no batch, or of this host, is nobody\'s to ask', async () => {
    const answers: unknown[] = []
    const { svc, registry, requests, pushed } = service({
      link: async (method, params) => {
        if (method === 'crossHost.landing') {
          answers.push(params)
          return { hold: (params as { branch: string }).branch === 'held-one' }
        }
        return { ok: true }
      }
    })
    const { sessionId } = (await svc.handle('thread.start', { caller, args: { ...startArgs, masterId: 'box-master' } }, ctx)) as { sessionId: string }
    const session = registry.get(sessionId)!
    const held = await svc.landingHold(session, { cwd: '/wt', branch: 'held-one', target: 'master', subjects: ['one'] })
    expect(held).toContain('HELD: the batch lands all at once; the master (on box) will merge held-one from origin')
    expect(pushed).toEqual(['/wt:held-one'])
    expect(answers[0]).toMatchObject({ from: MAC, sessionId, masterId: 'box-master', phase: 'ask', branch: 'held-one', target: 'master', subjects: ['one'] })
    expect(await svc.landingHold(session, { cwd: '/wt', branch: 'free', target: 'master', subjects: [] })).toBeNull()
    expect(pushed).toEqual(['/wt:held-one', '/wt:free'])
    // landed: reported, counted on the owner.
    expect(svc.landingDone(session, { branch: 'free', target: 'master', sha: 'abc', subjects: [] })).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(requests.filter((r) => r.method === 'crossHost.landing').at(-1)?.params).toMatchObject({ phase: 'landed', sha: 'abc', branch: 'free' })
    // Not a batch thread: nothing asked, nothing pushed.
    const plain = (await svc.handle('thread.start', { caller, args: startArgs }, ctx)) as { sessionId: string }
    expect(await svc.landingHold(registry.get(plain.sessionId)!, { cwd: '/wt', branch: 'x', target: 'master', subjects: [] })).toBeNull()
    expect(svc.landingDone(registry.get(plain.sessionId)!, { branch: 'x', target: 'master', sha: 'a', subjects: [] })).toBe(false)
    expect(pushed).toHaveLength(2)
  })
  it('an owner that cannot be asked refuses the merge rather than landing blind', async () => {
    const { svc, registry } = service({
      link: async (method) => {
        if (method === 'crossHost.landing') throw new Error('box is not connected')
        return { ok: true }
      }
    })
    const { sessionId } = (await svc.handle('thread.start', { caller, args: { ...startArgs, masterId: 'box-master' } }, ctx)) as { sessionId: string }
    await expect(svc.landingHold(registry.get(sessionId)!, { cwd: '/wt', branch: 'b', target: 'master', subjects: [] })).rejects.toThrow("the master's host (box) could not be asked")
  })
})

// ── a start that carries the caller's project lands in the linked copy ──

import { ensureLinked, type EnsureLinkedDeps } from '../projectLinks'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { ProjectLinkFacts } from '@shared/projectLinks'

describe('CrossHostThreads: the linked project', () => {
  /** The real ensureLinked over an in-memory catalog of this host (the Mac). */
  function linker(dirs: string[]) {
    const workspaces: WorkspaceMeta[] = []
    const projects: ProjectMeta[] = []
    let n = 0
    const deps: EnsureLinkedDeps = {
      listProjects: () => projects,
      listWorkspaces: () => workspaces,
      async createWorkspace(path, { linkId }) {
        const row = { id: `w${++n}`, name: 'alpha', path, git: true, githubRepo: null, linkId, createdAt: n } as WorkspaceMeta
        workspaces.push(row)
        return row
      },
      async createProject(workspaceId, name, mode, o) {
        const cwd = mode === 'worktree' ? `/Users/landon/.temp-code/worktrees/${name.toLowerCase()}` : workspaces.find((w) => w.id === workspaceId)!.path
        const row = { id: `lp${++n}`, workspaceId, name, mode, branch: o.branch ?? 'main', cwd, archived: false, linkId: o.linkId, createdAt: n } as ProjectMeta
        projects.push(row)
        return row
      },
      linkCatalog: () => {},
      pathMap: () => MAP,
      workRoot: () => '/Users/landon/IdeaProjects',
      exists: (p) => dirs.includes(p)
    }
    return { ensure: (a: Parameters<typeof ensureLinked>[1]) => ensureLinked(deps, a), workspaces, projects }
  }
  const facts: ProjectLinkFacts = {
    linkId: 'pl_alpha',
    workspaceLinkId: 'wl_alpha',
    name: 'Alpha',
    branch: 'tc/alpha',
    mode: 'worktree',
    workspacePath: '/srv/agents/work/alpha',
    cwd: '/srv/agents/home/.temp-code/worktrees/alpha'
  }
  const linkedArgs = { ...startArgs, cwd: facts.cwd, project: facts }

  it('a start into a host with no copy creates and links it, and the thread lands in it; a second start reuses it', async () => {
    const l = linker(['/Users/landon/IdeaProjects/alpha'])
    const { svc, registry } = service({ ensureLinked: l.ensure })
    const r = (await svc.handle('thread.start', { caller, args: linkedArgs }, ctx)) as { sessionId: string; cwd: string; projectId: string | null; cwdNote?: string }
    expect(l.workspaces).toEqual([expect.objectContaining({ path: '/Users/landon/IdeaProjects/alpha', linkId: 'wl_alpha' })])
    expect(l.projects).toEqual([expect.objectContaining({ name: 'Alpha', mode: 'worktree', branch: 'tc/alpha', linkId: 'pl_alpha' })])
    expect(r.projectId).toBe(l.projects[0].id)
    expect(r.cwd).toBe('/Users/landon/.temp-code/worktrees/alpha')
    expect(r.cwdNote).toBeUndefined()
    expect(registry.get(r.sessionId)).toMatchObject({ projectId: l.projects[0].id, cwd: '/Users/landon/.temp-code/worktrees/alpha' })

    const again = (await svc.handle('thread.start', { caller, args: linkedArgs }, ctx)) as { projectId: string | null }
    expect(again.projectId).toBe(l.projects[0].id)
    expect(l.projects).toHaveLength(1)
  })

  it('thread.spawn lands the child in the linked copy too', async () => {
    const l = linker(['/Users/landon/IdeaProjects/alpha'])
    const { svc, registry } = service({ ensureLinked: l.ensure })
    const r = (await svc.handle(
      'thread.spawn',
      { caller, args: { provider: 'claude' as const, model: 'claude-sonnet-5-5', reasoning: 'medium' as const, context1m: false, agentType: 'explorer' as const, task: 'look', title: 'look', useWorktree: false, cwd: facts.cwd, workRoot: '/srv/agents/work', project: facts } },
      ctx
    )) as { sessionId: string; projectId: string | null }
    expect(r.projectId).toBe(l.projects[0].id)
    expect(registry.get(r.sessionId)).toMatchObject({ parentId: 'box-thread', projectId: l.projects[0].id })
  })

  it('no checkout here: the path logic decides as before, a note and no project', async () => {
    const l = linker([])
    const { svc } = service({ ensureLinked: l.ensure, exists: () => false })
    const r = (await svc.handle('thread.start', { caller, args: linkedArgs }, ctx)) as { cwd: string; projectId: string | null; cwdNote?: string }
    expect(l.projects).toEqual([])
    expect(r.projectId).toBeNull()
    expect(r.cwd).toBe('/Users/landon/IdeaProjects')
    expect(r.cwdNote).toContain('no checkout for /srv/agents/home/.temp-code/worktrees/alpha')
  })

  it('a refused start makes no copy', async () => {
    const l = linker(['/Users/landon/IdeaProjects/alpha'])
    const { svc } = service({ ensureLinked: l.ensure, admit: () => ({ ok: false, reason: 'full' }) })
    await expect(svc.handle('thread.start', { caller, args: linkedArgs }, ctx)).rejects.toThrow('full')
    expect(l.workspaces).toEqual([])
  })
})
