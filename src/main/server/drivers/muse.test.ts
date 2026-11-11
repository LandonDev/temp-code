import { chmodSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Connection } from '@muse-code/sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx, DriverHandle } from './types'

// A shell wrapper stands in for the muse launcher: `muse serve` becomes the
// fake host (harness/museFakeServe.mjs) under this test runner's node.
const fakeDir = mkdtempSync(join(tmpdir(), 'muse-fake-'))
const fakeBin = join(fakeDir, 'muse')
const fakeScript = join(process.cwd(), 'src/main/server/drivers/harness/museFakeServe.mjs')
writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`)
chmodSync(fakeBin, 0o755)

vi.mock('./harness/child', async () => ({
  ...(await vi.importActual<typeof import('./harness/child')>('./harness/child')),
  resolveMuseBinary: async () => ({ path: fakeBin })
}))
vi.mock('./binaries', () => ({ harnessEnv: async () => ({ PATH: process.env.PATH, FAKE_MUSE_SANDBOX: process.env.FAKE_MUSE_SANDBOX }) }))
vi.mock('../apptools', () => ({ bridgeMcpConfig: () => ({ command: '/usr/bin/node', args: ['/app/bridge.mjs'], env: { TEMP_CODE_SESSION: 's1', TEMP_CODE_PORT: '1' } }) }))

const { museDriver, FIRST_OUTPUT_MS } = await import('./muse')
const { configureMuseDirs, configureMuseSkills } = await import('../museConfigDirs')

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
const waitFor = async (pred: () => boolean, label: string, ms = 10_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function ctxFor(over: Partial<SessionMeta> = {}, hooks: Partial<DriverCtx> = {}) {
  const events: AgentEvent[] = []
  const nativeIds: string[] = []
  const approvals: Array<{ title?: string; toolName: string; input: unknown }> = []
  let decide: (allow: boolean) => void = () => {}
  const session = { id: 's1', cwd: fakeDir, model: 'muse-spark-1.3', reasoning: 'low', permission: 'edits', nativeId: null, ...over } as unknown as SessionMeta
  const ctx: DriverCtx = {
    session,
    emit: (e) => events.push(e),
    setNativeId: (id) => nativeIds.push(id),
    requestApproval: (req) => {
      approvals.push({ title: req.title, toolName: req.toolName, input: req.input })
      return new Promise<boolean>((resolve) => (decide = resolve))
    },
    ...hooks
  }
  return { ctx, events, nativeIds, approvals, decide: (allow: boolean) => decide(allow) }
}

const settled = (events: AgentEvent[]) => of(events, 'turn-complete').length
const handles: DriverHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.dispose().catch(() => undefined)
})

describe('the muse driver over the fake host', () => {
  it('starts a session with the profile, the mode and the bridge, then runs a turn with text, thinking and a tool call', async () => {
    const t = ctxFor()
    const h = await museDriver.start(t.ctx)
    handles.push(h)
    expect(t.nativeIds).toEqual(['sess-1'])
    expect(h.alive?.()).toBe(true)
    expect(typeof h.pid?.()).toBe('number')
    await h.send('tool please')
    await waitFor(() => settled(t.events) === 1, 'the turn')
    const text = of(t.events, 'assistant-text').filter((e) => !e.delta).map((e) => e.text)
    expect(text).toEqual(['running ls ', 'two entries '])
    const calls = of(t.events, 'tool-call')
    expect(calls[0]).toMatchObject({ callId: 'call-1', name: 'Bash', input: { command: 'ls -la' } })
    expect(of(t.events, 'tool-result')[0]).toMatchObject({ callId: 'call-1', output: 'total 0\ndrwxr-xr-x .\n', isError: false })
    const phases = of(t.events, 'phase').map((e) => e.phase)
    expect(phases.slice(0, 5)).toEqual(['cli-starting', 'initializing', null, 'waiting-provider', null])
    expect(phases.at(-1)).toBeNull()
    expect(of(t.events, 'usage').at(-1)).toMatchObject({ inputTokens: 120, outputTokens: 30 })
    expect(of(t.events, 'status').at(-1)).toMatchObject({ status: 'idle' })

    await h.send('think')
    await waitFor(() => settled(t.events) === 2, 'the second turn')
    expect(of(t.events, 'thinking').filter((e) => !e.delta).map((e) => e.text)).toEqual(['weighing options'])
  })

  it('resumes by native id, forgets a lost one and refuses one in use', async () => {
    const kept = ctxFor({ nativeId: 'sess-kept' })
    const h1 = await museDriver.start(kept.ctx)
    handles.push(h1)
    expect(kept.nativeIds).toEqual([])

    const lost: string[] = []
    const t = ctxFor({ nativeId: 'lost' }, { nativeSessionLost: () => lost.push('lost') })
    const h2 = await museDriver.start(t.ctx)
    handles.push(h2)
    expect(lost).toEqual(['lost'])
    expect(t.nativeIds).toEqual(['sess-1'])

    await expect(museDriver.start(ctxFor({ nativeId: 'busy' }).ctx)).rejects.toThrow(/in use/)
  })

  it('approvals: allowed through the request, denied through the request, with the card titled by the command', async () => {
    const t = ctxFor()
    const h = await museDriver.start(t.ctx)
    handles.push(h)
    await h.send('approve')
    await waitFor(() => t.approvals.length === 1, 'the approval card')
    expect(t.approvals[0]).toEqual({ title: 'rm -rf build', toolName: 'shell', input: { command: 'rm -rf build' } })
    t.decide(true)
    await waitFor(() => settled(t.events) === 1, 'the allowed turn')
    expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe('removed build ')

    await h.send('approve again')
    await waitFor(() => t.approvals.length === 2, 'the second card')
    t.decide(false)
    await waitFor(() => settled(t.events) === 2, 'the denied turn')
    expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe('left it alone ')
    expect(of(t.events, 'tool-result').at(-1)).toMatchObject({ isError: true })
  })

  it('questions: asked as a card, answered by label, or dismissed', async () => {
    const t = ctxFor()
    const h = await museDriver.start(t.ctx)
    handles.push(h)
    await h.send('ask')
    await waitFor(() => of(t.events, 'question-request').length === 1, 'the question')
    const q = of(t.events, 'question-request')[0]
    expect(q.questions).toEqual([{ question: 'Tabs or spaces?', header: 'Indent', multiSelect: false, allowFreeform: true, options: [{ label: 'Tabs' }, { label: 'Spaces', description: 'two of them' }] }])
    expect(of(t.events, 'status').at(-1)).toMatchObject({ status: 'waiting', detail: 'awaiting answer' })
    expect(h.answer?.('nope', [['x']])).toBe(false)
    expect(h.answer?.(q.requestId, [['Spaces']])).toBe(true)
    await waitFor(() => settled(t.events) === 1, 'the answered turn')
    expect(of(t.events, 'question-resolved')[0]).toEqual({ type: 'question-resolved', requestId: q.requestId, answers: [['Spaces']] })
    expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe('chose Spaces ')

    await h.send('ask again')
    await waitFor(() => of(t.events, 'question-request').length === 2, 'the second question')
    expect(h.answer?.(of(t.events, 'question-request')[1].requestId, null)).toBe(true)
    await waitFor(() => settled(t.events) === 2, 'the dismissed turn')
    expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe('dismissed ')
  })

  it('an allow from the host (Away) sends approved once through approval/decide', async () => {
    const commands = vi.spyOn(Connection.prototype, 'command')
    try {
      const t = ctxFor()
      const requests = vi.spyOn(t.ctx, 'requestApproval')
      const h = await museDriver.start(t.ctx)
      handles.push(h)
      await h.send('approve')
      await waitFor(() => requests.mock.calls.length === 1, 'the approval')
      const approvalId = requests.mock.calls[0][0].requestId!
      t.decide(true)
      await waitFor(() => settled(t.events) === 1, 'the allowed turn')
      expect(commands.mock.calls.filter(([method]) => method === 'approval/decide')).toEqual([
        ['approval/decide', { sessionId: 'sess-1', approvalId, choiceId: 'c-once', requirementId: { approvalId, sourceIndex: 0 } }, undefined]
      ])
      expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe('removed build ')
    } finally {
      commands.mockRestore()
    }
  })

  it.each([
    ['approve', 'c-deny'],
    ['approve abort', 'c-abort']
  ])('denies %s through approval/decide without text', async (prompt, choiceId) => {
    const commands = vi.spyOn(Connection.prototype, 'command')
    try {
      const t = ctxFor()
      const requests = vi.spyOn(t.ctx, 'requestApproval')
      const h = await museDriver.start(t.ctx)
      handles.push(h)
      await h.send(prompt)
      await waitFor(() => requests.mock.calls.length === 1, 'the approval')
      const approvalId = requests.mock.calls[0][0].requestId!
      // The host settles its promise before trying the driver's stale-request path.
      t.decide(false)
      await waitFor(() => commands.mock.calls.some(([method]) => method === 'approval/decide'), 'the deny command')
      h.approve!(approvalId, false, 'The person is away. Decide yourself.')
      expect(commands.mock.calls.filter(([method]) => method === 'approval/decide')).toEqual([
        ['approval/decide', { sessionId: 'sess-1', approvalId, choiceId, requirementId: { approvalId, sourceIndex: 0 } }, undefined]
      ])
      await waitFor(() => settled(t.events) === 1, 'the denied turn')
      expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe('left it alone ')
    } finally {
      commands.mockRestore()
    }
  })

  it('sends a free-text question answer in freeText', async () => {
    const commands = vi.spyOn(Connection.prototype, 'command')
    try {
      const t = ctxFor()
      const h = await museDriver.start(t.ctx)
      handles.push(h)
      await h.send('ask')
      await waitFor(() => of(t.events, 'question-request').length === 1, 'the question')
      const question = of(t.events, 'question-request')[0]
      const text = 'The person is away. Decide yourself.'
      expect(h.answer!(question.requestId, [[text]])).toBe(true)
      const answer = commands.mock.calls.find(([method]) => method === 'userInput/answer')
      expect(answer).toEqual(['userInput/answer', {
        sessionId: 'sess-1', userInputId: expect.any(String), answers: [{ questionId: 'q1', freeText: text }]
      }, undefined])
      await waitFor(() => settled(t.events) === 1, 'the answered turn')
      expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe(`chose ${text} `)
    } finally {
      commands.mockRestore()
    }
  })

  it('a steer mid-turn is received when its user message lands; a cancel ends the turn quietly', async () => {
    const t = ctxFor()
    const h = await museDriver.start(t.ctx)
    handles.push(h)
    expect(h.confirmsSteers).toBe(true)
    await h.send('steer')
    await h.send('go left', [], { steerId: 'st-1' })
    await waitFor(() => settled(t.events) === 1, 'the steered turn')
    expect(of(t.events, 'steer')).toEqual([{ type: 'steer', steerId: 'st-1', state: 'received', how: 'in-turn' }])
    expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe('heard go left ')

    await h.send('steer')
    h.interrupt()
    await waitFor(() => settled(t.events) === 2, 'the cancelled turn')
    expect(of(t.events, 'error')).toEqual([])
  })

  it('a host whisper goes into the live turn by turn/steer and stamps no steer; with no turn it answers false', async () => {
    const t = ctxFor()
    const h = await museDriver.start(t.ctx)
    handles.push(h)
    expect(await h.whisper!('notes line')).toBe(false)
    await h.send('steer')
    await waitFor(() => of(t.events, 'phase').some((e) => e.phase === 'waiting-provider'), 'the open turn')
    expect(await h.whisper!('notes line')).toBe(true)
    await waitFor(() => settled(t.events) === 1, 'the whispered turn')
    expect(of(t.events, 'assistant-text').filter((e) => !e.delta).at(-1)?.text).toBe('heard notes line ')
    expect(of(t.events, 'steer')).toEqual([])
    expect(await h.whisper!('after the turn')).toBe(false)
  })

  it('a quota stop errors the row as a resetting limit and tells the host; usage and context reach their hooks', async () => {
    const windows: unknown[] = []
    const limits: unknown[] = []
    const t = ctxFor({}, { observeUsage: (w) => windows.push(w), observeLimit: (w, at) => limits.push([w, at]) })
    const h = await museDriver.start(t.ctx)
    handles.push(h)
    await h.send('quota')
    await waitFor(() => settled(t.events) === 1, 'the quota turn')
    const err = of(t.events, 'error')[0]
    expect(err.message).toMatch(/^quota: tierLimit, resets in 1 h 30 min/)
    expect(err.limit).toEqual({ window: '5h' })
    expect(limits).toHaveLength(1)

    await h.send('usage')
    await waitFor(() => settled(t.events) === 2, 'the usage turn')
    expect(windows[0]).toMatchObject([{ label: '5h', usedPercent: 42 }, { label: 'Weekly', usedPercent: 7 }])
    expect(of(t.events, 'context').at(-1)).toMatchObject({ tokens: 12_345, window: 1_048_576 })

    await h.send('auth')
    await waitFor(() => settled(t.events) === 3, 'the auth turn')
    expect(of(t.events, 'error').at(-1)?.message).toMatch(/not logged in on this host/)

    await h.send('retry')
    await waitFor(() => settled(t.events) === 4, 'the retry turn')
    expect(of(t.events, 'phase').find((p) => p.phase === 'retrying')).toMatchObject({ detail: 'retry 2 of 5 in 32 s (503)', retry: { attempt: 2, delayMs: 32_000 } })

    await h.send('compact')
    await waitFor(() => settled(t.events) === 5, 'the compaction turn')
    expect(of(t.events, 'compaction').map((c) => c.phase)).toEqual(['start', 'done'])
  })

  it('a host that dies mid-turn errors the row; one that dies idle is reported gone', async () => {
    const gone: string[] = []
    const t = ctxFor({}, { harnessGone: () => gone.push('gone') })
    const h = await museDriver.start(t.ctx)
    handles.push(h)
    await h.send('die')
    await waitFor(() => settled(t.events) === 1, 'the death')
    expect(of(t.events, 'error')[0].message).toMatch(/exited unexpectedly/)
    expect(h.alive?.()).toBe(false)
    await expect(h.send('again')).rejects.toThrow(/gone/)

    const t2 = ctxFor({}, { harnessGone: () => gone.push('gone-idle') })
    const h2 = await museDriver.start(t2.ctx)
    handles.push(h2)
    process.kill(h2.pid!()!, 'SIGKILL')
    await waitFor(() => gone.includes('gone-idle'), 'the idle death')
    expect(of(t2.events, 'error')).toEqual([])
  })

  it('the first-output watchdog errors a silent turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const t = ctxFor()
      const h = await museDriver.start(t.ctx)
      handles.push(h)
      await h.send('slow')
      await vi.advanceTimersByTimeAsync(FIRST_OUTPUT_MS + 1)
      expect(of(t.events, 'error')[0].message).toBe('the harness never answered the message — recovered')
      expect(settled(t.events)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes --disable-sandbox on Linux when the host says the sandbox is unavailable', async () => {
    process.env.FAKE_MUSE_SANDBOX = 'unavailable'
    try {
      const stderr: string[] = []
      const t = ctxFor({ permission: 'auto' })
      const h = await museDriver.start(t.ctx)
      handles.push(h)
      void stderr
      // The fake prints its start line to stderr; the driver keeps the tail, which the exit words read.
      expect(t.nativeIds.length).toBe(1)
    } finally {
      delete process.env.FAKE_MUSE_SANDBOX
    }
  })

  it.skipIf(process.platform !== 'linux')('runs `muse serve` under its (account, scope) dir: the own dir for a thread on no account, the account\'s with the file backend', async () => {
    const root = join(fakeDir, 'muse-accounts')
    configureMuseDirs({ root, readBlob: (a) => (a === 'me@x' ? '{"providers":{"meta":{"access_token":"t"}}}' : null), userConfigDir: join(fakeDir, 'cfg', 'muse') })
    configureMuseSkills({ scopeOf: (s) => s.workspaceId, pointers: { path: (_p, ws) => join(fakeDir, 'scope', ws ? `ws-${ws}` : 'global') } })
    const environ = (pid: number): Record<string, string> =>
      Object.fromEntries(
        readFileSync(`/proc/${pid}/environ`, 'utf8')
          .split('\0')
          .filter(Boolean)
          .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])
      )
    try {
      const own = ctxFor({ workspaceId: 'w1' } as Partial<SessionMeta>)
      const h1 = await museDriver.start(own.ctx)
      handles.push(h1)
      const e1 = environ(h1.pid!()!)
      expect(e1.XDG_CONFIG_HOME).toBe(join(root, 'own', 'ws-w1'))
      expect(e1.TBH_CREDENTIAL_BACKEND).toBeUndefined()
      expect(readlinkSync(join(root, 'own', 'ws-w1', 'muse', 'skills'))).toBe(join(fakeDir, 'scope', 'ws-w1', 'skills'))
      const acct = ctxFor({ id: 's2', workspaceId: null } as Partial<SessionMeta>, { route: { account: 'me@x' } as DriverCtx['route'] })
      const h2 = await museDriver.start(acct.ctx)
      handles.push(h2)
      const e2 = environ(h2.pid!()!)
      expect(e2.XDG_CONFIG_HOME).toBe(join(root, 'accounts', 'me@x', 'global'))
      expect(e2.TBH_CREDENTIAL_BACKEND).toBe('file')
      expect(e2.GH_CONFIG_DIR).toBeTruthy()
    } finally {
      configureMuseDirs(null)
      configureMuseSkills(null)
    }
  })
})
