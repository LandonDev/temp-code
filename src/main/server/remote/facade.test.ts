import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configure } from 'aliax-core'
import type { Principal } from '@shared/capabilities'
import type { SessionMeta } from '@shared/events'
import type { RunningServer } from '../index'
import {
  FACADE_TOOLS,
  FacadeError,
  archiveSession,
  callFacade,
  collapseStatus,
  getDiff,
  getSession,
  getTranscript,
  listPending,
  listProjects,
  listSessions,
  pendingPrompts,
  renderPage,
  renderRows,
  respond,
  sendMessage,
  startSession,
  stopSession,
  type FacadeContext
} from './facade'

/**
 * The twelve operations against a real registry on a temp database and a
 * scratch git repo. The harness never spawns: `registry.send` is replaced
 * by a fake that lands the user row, so every path that would boot a
 * driver (start_session, send_message, an answer to a stale question)
 * stays in-process.
 */
let root: string
let repo: string
let server: RunningServer
let projectId: string
let workspaceId: string
let sent: { id: string; text: string }[] = []

const bot: Principal = {
  kind: 'remote',
  keyId: 'k1',
  name: 'grok',
  audience: 'mcp',
  caps: ['read', 'operate']
}
const reader: Principal = {
  kind: 'remote',
  keyId: 'k2',
  name: 'watch',
  audience: 'mcp',
  caps: ['read']
}
const approver: Principal = {
  kind: 'remote',
  keyId: 'k3',
  name: 'phone',
  audience: 'client',
  caps: ['read', 'operate', 'approve']
}
const ctx = (principal: Principal = bot): FacadeContext => ({
  registry: server.registry,
  principal,
  origin: 'https://tc.example'
})

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

async function thread(title: string, status: SessionMeta['status'] = 'idle'): Promise<SessionMeta> {
  const meta = await server.registry.create({
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    reasoning: 'low',
    projectId,
    threadType: 'implementation',
    title
  })
  if (status !== 'idle') server.registry.append(meta.id, { type: 'status', status })
  return server.registry.get(meta.id)!
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-facade-'))
  configure({
    dataDir: join(root, 'aliax'),
    fetch: async () => {
      throw new Error('no network in tests')
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-test'
  })
  repo = join(root, 'scratch')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  const { startServer } = await import('../index')
  server = await startServer(join(root, 'app.db'), {
    claimShim: false,
    remotePort: 0,
    appPath: root
  })
  const ws = await server.registry.createWorkspace(repo, 'scratch')
  workspaceId = ws.id
  const project = await server.registry.createProject(ws.id, 'main-work', 'local')
  projectId = project.id
  vi.spyOn(server.registry, 'send').mockImplementation(async (id: string, text: string) => {
    sent.push({ id, text })
    server.registry.append(id, { type: 'user-text', text })
  })
}, 60_000)
afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('status', () => {
  it('collapses the registry statuses to four', () => {
    expect(
      ['starting', 'running', 'watching'].map((s) => collapseStatus(s as SessionMeta['status']))
    ).toEqual(['working', 'working', 'working'])
    expect(['waiting', 'paused'].map((s) => collapseStatus(s as SessionMeta['status']))).toEqual([
      'waiting',
      'waiting'
    ])
    expect(collapseStatus('error')).toBe('failed')
    expect(['idle', 'done'].map((s) => collapseStatus(s as SessionMeta['status']))).toEqual([
      'done',
      'done'
    ])
  })
})

describe('list_projects', () => {
  it('lists repos with their projects', async () => {
    const out = await listProjects(ctx())
    const scratch = out.repos.find((r) => r.id === workspaceId)!
    expect(scratch.name).toBe('scratch')
    expect(scratch.path).toBe(repo)
    expect(scratch.projects).toEqual([
      { id: projectId, name: 'main-work', branch: 'main', mode: 'local', cwd: repo }
    ])
    // every repo names its host; this host is the first host row, always available
    expect(scratch.host).toBe('local')
    expect(out.hosts).toEqual([
      expect.objectContaining({ environmentId: 'local', self: true, state: 'available', screen: 'unknown', power: 'awake' })
    ])
  })
  it('names this host by its id and name, and lists the relayed hosts with their state', async () => {
    const since = Date.UTC(2026, 2, 4, 9, 14)
    const relayed = (environmentId: string, name: string, over: Record<string, unknown>) => ({
      environmentId, name, platform: 'darwin', link: 'up' as const, since, screen: 'unlocked' as const, power: 'awake' as const, lastSeenAt: since, build: null, ...over
    })
    const out = await listProjects({
      ...ctx(),
      environmentId: 'env_box',
      hostName: 'The box',
      relay: {
        list: () => [relayed('env_mac', 'Studio', { screen: 'locked' }), relayed('env_gone', 'Gone', { link: 'down' })],
        call: async () => ({ ok: true, result: null })
      }
    })
    expect(out.hosts).toEqual([
      expect.objectContaining({ environmentId: 'env_box', name: 'The box', self: true, state: 'available' }),
      { environmentId: 'env_mac', name: 'Studio', self: false, state: 'locked', since: new Date(since).toISOString(), screen: 'locked', power: 'awake' },
      { environmentId: 'env_gone', name: 'Gone', self: false, state: 'unreachable', since: new Date(since).toISOString(), screen: 'unlocked', power: 'awake' }
    ])
    expect(out.repos.every((r) => r.host === 'env_box')).toBe(true)
  })
})

describe('list_sessions', () => {
  it('stamps every row with this host', async () => {
    const stamped = await thread('stamped one')
    const out = await listSessions({ ...ctx(), environmentId: 'env_box' }, {})
    expect(out.sessions.length).toBeGreaterThan(0)
    expect(out.sessions.every((r) => r.host === 'env_box')).toBe(true)
    // the next test counts the live threads exactly
    await server.registry.setArchived(stamped.id, true)
  })
  it('returns compact rows, working first, with a cursor', async () => {
    const idle = await thread('idle one')
    const busy = await thread('busy one', 'running')
    const waiting = await thread('waiting one')
    server.registry.append(waiting.id, {
      type: 'approval-request',
      requestId: 'a1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' }
    })
    server.registry.append(waiting.id, {
      type: 'status',
      status: 'waiting',
      detail: 'awaiting approval'
    })
    const first = await listSessions(ctx(), { limit: 2 })
    expect(first.sessions.length).toBe(2)
    expect(first.cursor).toBeTruthy()
    const ids = [...first.sessions.map((s) => s.id)]
    const rest = await listSessions(ctx(), { limit: 50, cursor: first.cursor! })
    ids.push(...rest.sessions.map((s) => s.id))
    expect(new Set(ids)).toEqual(new Set([idle.id, busy.id, waiting.id]))
    const row =
      first.sessions.find((s) => s.id === busy.id) ?? rest.sessions.find((s) => s.id === busy.id)!
    expect(row).toMatchObject({
      title: 'busy one',
      repo: 'scratch',
      project: 'main-work',
      branch: 'main',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      status: 'working',
      state: 'running',
      pending: null,
      queued: 0,
      archived: false
    })
    expect(row.url).toBe(`https://tc.example/ui#thread=${busy.id}`)
    const w = [...first.sessions, ...rest.sessions].find((s) => s.id === waiting.id)!
    expect(w).toMatchObject({ status: 'waiting', pending: 'permission' })
    const only = await listSessions(ctx(), { status: 'waiting', repo: 'scratch' })
    expect(only.sessions.map((s) => s.id)).toEqual([waiting.id])
    await expect(listSessions(ctx(), { repo: 'nope' })).rejects.toThrow(/no repo "nope"/)
  })
})

describe('start_session', () => {
  it('starts a thread in the repo and sends the prompt', async () => {
    sent = []
    const row = await startSession(ctx(), {
      repo: 'scratch',
      prompt: 'Add a CHANGELOG',
      model: 'claude',
      title: 'changelog'
    })
    expect(row).toMatchObject({
      title: 'changelog',
      repo: 'scratch',
      project: 'main-work',
      branch: 'main',
      provider: 'claude',
      model: 'claude-fable-5-1',
      cwd: repo
    })
    expect(sent).toEqual([{ id: row.id, text: 'Add a CHANGELOG' }])
    const meta = server.registry.get(row.id)!
    expect(meta.threadType).toBe('implementation')
    expect(meta.permission).toBe('edits')
  })
  it('resolves codex, a model id, an existing branch, and refuses what it cannot run', async () => {
    const codex = await startSession(ctx(), {
      repo: repo,
      prompt: 'x',
      model: 'codex',
      type: 'chat'
    })
    expect(codex).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', type: 'chat' })
    const byId = await startSession(ctx(), {
      repo: 'scratch',
      prompt: 'x',
      model: 'gpt-6.1-sol',
      reasoning: 'high'
    })
    expect(byId).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' })
    expect(server.registry.get(byId.id)!.reasoning).toBe('high')
    const onBranch = await startSession(ctx(), { repo: 'scratch', prompt: 'x', branch: 'main' })
    expect(onBranch.project).toBe('main-work')
    await expect(
      startSession(ctx(), { repo: 'scratch', prompt: 'x', model: 'gpt-2' })
    ).rejects.toThrow(/no provider serves model "gpt-2"/)
    await expect(
      startSession(ctx(), { repo: 'scratch', prompt: 'x', permission: 'auto' })
    ).rejects.toThrow(/needs the approve capability/)
    await expect(startSession(ctx(), { repo: 'missing', prompt: 'x' })).rejects.toThrow(
      /no repo "missing"/
    )
  })
})

describe('send_message', () => {
  it('sends at once when idle, queues behind a turn, steers, interrupts', async () => {
    const t = await thread('messages')
    sent = []
    expect(await sendMessage(ctx(), { session: t.id, text: 'one' })).toMatchObject({
      ok: true,
      delivered: 'sent',
      queued: 0
    })
    expect(sent.map((s) => s.text)).toEqual(['one'])
    server.registry.append(t.id, { type: 'status', status: 'running' })
    expect(await sendMessage(ctx(), { session: t.id, text: 'two' })).toMatchObject({
      delivered: 'queued',
      queued: 1,
      status: 'working'
    })
    expect(sent.map((s) => s.text)).toEqual(['one'])
    expect(await sendMessage(ctx(), { session: t.id, text: 'three', when: 'now' })).toMatchObject({
      delivered: 'steered'
    })
    expect(sent.map((s) => s.text)).toEqual(['one', 'three'])
    expect(
      await sendMessage(ctx(), { session: t.id, text: 'four', when: 'interrupt' })
    ).toMatchObject({ delivered: 'interrupted', queued: 1 })
    // No live harness: the stop settles the row idle and the queue drains in order.
    expect(server.registry.get(t.id)!.status).toBe('idle')
    expect(sent.map((s) => s.text)).toEqual(['one', 'three', 'four'])
    expect(server.registry.queueList(t.id).map((m) => m.text)).toEqual(['two'])
    await expect(sendMessage(ctx(), { session: 'nope', text: 'x' })).rejects.toThrow(
      /no session "nope"/
    )
  })
})

describe('transcript rendering', () => {
  it('folds deltas, faces tools, summarizes bodies and prompts', () => {
    const rows = [
      { type: 'user-text', text: 'Do the thing' },
      { type: 'assistant-text', text: 'Sure, ', delta: true, msgId: 'm1', blockIndex: 0 },
      { type: 'assistant-text', text: 'starting.', delta: true, msgId: 'm1', blockIndex: 0 },
      {
        type: 'assistant-text',
        text: 'Sure, starting now.',
        delta: false,
        msgId: 'm1',
        blockIndex: 0
      },
      { type: 'thinking', text: 'hmm', delta: false },
      { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'ls' }, partial: false },
      { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'ls -la' } },
      {
        type: 'tool-result',
        callId: 'c1',
        output: { omitted: true, bytes: 4096, lines: 40, head: 'total 12' },
        isError: false
      },
      { type: 'tool-result', callId: 'c2', output: 'boom\nline 2', isError: true },
      {
        type: 'approval-request',
        requestId: 'a1',
        toolName: 'Bash',
        input: { command: 'rm -rf x' }
      },
      { type: 'approval-resolved', requestId: 'a1', allow: false, auto: true },
      {
        type: 'question-request',
        requestId: 'q1',
        questions: [
          { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], allowFreeform: true }
        ]
      },
      { type: 'approval-request', requestId: 'p1', toolName: 'ExitPlanMode', input: {} },
      { type: 'error', message: 'turn ended', stopped: true },
      { type: 'turn-complete' }
    ].map((event, i) => ({ sessionId: 's', seq: i + 1, ts: i, event: event as never }))
    const text = renderRows(rows).map((e) => `#${e.seq} ${e.text}`)
    expect(text).toEqual([
      '#1 user: Do the thing',
      '#2 assistant: Sure, starting now.',
      '#6 tool Bash: ls -la',
      '#8 result: total 12 (40 lines, 4.0 KB)',
      '#9 result ERROR: boom (2 lines, 11 B)',
      '#10 PERMISSION a1: Bash — rm -rf x',
      '#11 permission a1: denied (auto)',
      '#12 QUESTION q1: Which? [A | B | free text]',
      '#13 PLAN READY p1: the thread asks to leave plan mode — respond with allow',
      '#14 stopped: turn ended',
      '#15 — turn complete —'
    ])
    const page = renderPage(renderRows(rows), 60)
    expect(page.truncated).toBe(true)
    expect(page.lastSeq).toBe(15)
    expect(page.text.split('\n').length).toBeGreaterThan(1)
    expect(page.text.length).toBeLessThanOrEqual(60)
    expect(pendingPrompts('s', rows).map((p) => [p.requestId, p.kind])).toEqual([
      ['q1', 'question'],
      ['p1', 'plan']
    ])
  })
})

describe('get_transcript', () => {
  it('reads the newest turn through the bounded page and pages older', async () => {
    const t = await thread('transcript')
    const big = 'x'.repeat(3000)
    for (let turn = 1; turn <= 3; turn++) {
      server.registry.append(t.id, { type: 'user-text', text: `turn ${turn}` })
      server.registry.append(t.id, {
        type: 'tool-call',
        callId: `c${turn}`,
        name: 'Read',
        input: { file_path: `/f${turn}` }
      })
      server.registry.append(t.id, {
        type: 'tool-result',
        callId: `c${turn}`,
        output: big,
        isError: false
      })
      server.registry.append(t.id, { type: 'assistant-text', text: `done ${turn}`, delta: false })
      server.registry.append(t.id, { type: 'turn-complete' })
    }
    const last = await getTranscript(ctx(), { session: t.id, limit: 3 })
    expect(last.text).toContain('user: turn 3')
    expect(last.text).not.toContain('user: turn 2')
    expect(last.text).toContain('tool Read: /f3')
    expect(last.text).toMatch(/result: x{10,} .*\(1 lines, 2\.9 KB\)/)
    expect(last.text).not.toContain(big)
    expect(last.moreBefore).toBe(true)
    expect(last.lastSeq).toBe(15)
    const older = await getTranscript(ctx(), { session: t.id, before: last.firstSeq!, limit: 3 })
    expect(older.text).toContain('user: turn 2')
    expect(older.text).not.toContain('turn 3')
    const two = await getTranscript(ctx(), { session: t.id, limit: 6 })
    expect(two.text).not.toContain('user: turn 1')
    const all = await getTranscript(ctx(), { session: t.id })
    expect(all.text).toContain('user: turn 1')
    expect(all.moreBefore).toBe(false)
    expect(two.text).toContain('user: turn 2')
    expect(two.text).toContain('user: turn 3')
    const newer = await getTranscript(ctx(), { session: t.id, after: 10 })
    expect(newer.firstSeq).toBe(11)
    expect(newer.text).toContain('user: turn 3')
    expect(newer.reset).toBe(false)
    const tiny = await getTranscript(ctx(), { session: t.id, chars: 1000 })
    expect(tiny.text.length).toBeLessThanOrEqual(1000)
  })
})

describe('get_session, list_pending, respond', () => {
  it('shows prompts, last words and errors; answers questions; refuses permissions without approve', async () => {
    const t = await thread('prompts')
    server.registry.append(t.id, { type: 'user-text', text: 'go' })
    server.registry.append(t.id, {
      type: 'assistant-text',
      text: 'I need to know one thing.',
      delta: false
    })
    server.registry.append(t.id, {
      type: 'question-request',
      requestId: 'q1',
      questions: [
        {
          question: 'Tabs or spaces?',
          options: [{ label: 'Tabs' }, { label: 'Spaces', description: 'two' }]
        }
      ]
    })
    server.registry.append(t.id, { type: 'status', status: 'waiting', detail: 'awaiting answer' })
    const detail = await getSession(ctx(), { session: t.id })
    expect(detail).toMatchObject({
      status: 'waiting',
      pending: 'question',
      lastSaid: 'I need to know one thing.',
      error: null,
      cwd: repo
    })
    expect(detail.prompts).toEqual([
      {
        session: t.id,
        requestId: 'q1',
        kind: 'question',
        seq: 3,
        summary: 'Tabs or spaces?',
        questions: [{ question: 'Tabs or spaces?', options: ['Tabs', 'Spaces — two'] }]
      }
    ])
    const pending = await listPending(ctx(), {})
    expect(pending.pending.map((p) => p.requestId)).toContain('q1')
    expect(pending.pending.find((p) => p.requestId === 'q1')).toMatchObject({
      title: 'prompts',
      canRespond: true
    })
    await expect(respond(ctx(), { session: t.id, requestId: 'q1' })).rejects.toThrow(/pass answers/)
    sent = []
    const answered = await respond(ctx(), { session: t.id, requestId: 'q1', answer: 'Spaces' })
    expect(answered).toMatchObject({ ok: true, kind: 'question' })
    // No live harness: the stale-question path settles the card and sends the answers.
    expect(sent[0]?.text).toContain('Tabs or spaces? → Spaces')
    expect((await listPending(ctx(), { session: t.id })).pending).toEqual([])
    await expect(respond(ctx(), { session: t.id, requestId: 'q1', answer: 'x' })).rejects.toThrow(
      /no pending prompt "q1"/
    )

    server.registry.append(t.id, {
      type: 'approval-request',
      requestId: 'a1',
      toolName: 'Bash',
      input: { command: 'git push --force' },
      title: 'push'
    })
    server.registry.append(t.id, { type: 'status', status: 'waiting', detail: 'awaiting approval' })
    const asBot = await listPending(ctx(), { session: t.id })
    expect(asBot.pending[0]).toMatchObject({
      requestId: 'a1',
      kind: 'permission',
      tool: 'Bash',
      summary: 'Bash: push',
      canRespond: false
    })
    expect(asBot.pending[0].how).toMatch(/cannot answer permission prompts/)
    const refused = await respond(ctx(), { session: t.id, requestId: 'a1', allow: true }).catch(
      (e: unknown) => e
    )
    expect(refused).toBeInstanceOf(FacadeError)
    expect((refused as FacadeError).code).toBe('forbidden')
    expect((refused as Error).message).toMatch(
      /cannot approve permission prompts.*approve capability.*thread "prompts" asks: Bash: push/
    )
    expect((await listPending(ctx(approver), { session: t.id })).pending[0].canRespond).toBe(true)
    expect(
      await respond(ctx(approver), { session: t.id, requestId: 'a1', allow: false })
    ).toMatchObject({ ok: true, kind: 'permission' })
    expect((await listPending(ctx(approver), { session: t.id })).pending).toEqual([])

    server.registry.append(t.id, {
      type: 'approval-request',
      requestId: 'p1',
      toolName: 'ExitPlanMode',
      input: { plan: 'do it' }
    })
    expect((await listPending(ctx(), { session: t.id })).pending[0]).toMatchObject({
      requestId: 'p1',
      kind: 'plan',
      canRespond: true
    })
    expect(await respond(ctx(), { session: t.id, requestId: 'p1', allow: true })).toMatchObject({
      ok: true,
      kind: 'plan'
    })

    server.registry.append(t.id, { type: 'error', message: 'harness died' })
    server.registry.append(t.id, { type: 'status', status: 'error' })
    expect(await getSession(ctx(), { session: t.id })).toMatchObject({
      status: 'failed',
      error: 'harness died',
      prompts: []
    })
  })
})

describe('stop, archive', () => {
  it('stops a working thread and archives it out of the list', async () => {
    const t = await thread('stoppable', 'running')
    expect(await stopSession(ctx(), { session: t.id })).toMatchObject({
      ok: true,
      status: 'done',
      state: 'idle'
    })
    expect(await archiveSession(ctx(), { session: t.id })).toEqual({
      ok: true,
      session: t.id,
      archived: true
    })
    expect((await listSessions(ctx(), {})).sessions.map((s) => s.id)).not.toContain(t.id)
    expect((await listSessions(ctx(), { archived: true })).sessions.map((s) => s.id)).toContain(
      t.id
    )
    expect(await archiveSession(ctx(), { session: t.id, archived: false })).toMatchObject({
      archived: false
    })
    expect((await listSessions(ctx(), {})).sessions.map((s) => s.id)).toContain(t.id)
  })
})

describe('get_diff', () => {
  it('lists changed files on the branch and renders one diff', async () => {
    const t = await thread('differ')
    writeFileSync(join(repo, 'README.md'), 'hello\nworld\n')
    writeFileSync(join(repo, 'new.txt'), 'fresh\n')
    const out = await getDiff(ctx(), { session: t.id })
    expect(out).toMatchObject({
      session: t.id,
      cwd: repo,
      branch: 'main',
      where: 'checkout',
      totals: { files: 2, adds: 1, dels: 0 }
    })
    expect(out.files.map((f) => [f.path, f.status])).toEqual(
      expect.arrayContaining([
        ['README.md', 'modified'],
        ['new.txt', 'untracked']
      ])
    )
    const one = await getDiff(ctx(), { session: t.id, path: 'README.md' })
    expect(one.diff).toContain('+world')
    expect(one.truncated).toBeUndefined()
    const cutDiff = await getDiff(ctx(), { session: t.id, path: 'README.md', chars: 1000 })
    expect(cutDiff.diff!.length).toBeLessThan(1100)
    await expect(getDiff(ctx(), { session: t.id, path: 'nope.txt' })).rejects.toThrow(
      /not among the changed files/
    )
  })
})

describe('callFacade', () => {
  it('gates by capability, parses input, and names unknown tools', async () => {
    expect(FACADE_TOOLS.map((t) => t.name)).toEqual([
      'list_projects',
      'list_sessions',
      'start_session',
      'send_message',
      'get_session',
      'get_transcript',
      'list_pending',
      'respond',
      'stop_session',
      'archive_session',
      'get_diff'
    ])
    await expect(
      callFacade(ctx(reader), 'start_session', { repo: 'scratch', prompt: 'x' })
    ).rejects.toThrow(/start_session needs the operate capability; this key has read/)
    await expect(callFacade(ctx(), 'nope', {})).rejects.toThrow(/unknown tool "nope"/)
    await expect(callFacade(ctx(), 'get_session', {})).rejects.toThrow()
    const projects = (await callFacade(ctx(reader), 'list_projects', undefined)) as {
      repos: unknown[]
    }
    expect(projects.repos.length).toBe(1)
  })
})
