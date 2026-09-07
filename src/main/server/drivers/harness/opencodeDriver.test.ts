import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from '../types'
import { mockChild } from './fxChildMock'

/**
 * Driver test over a complete fake of the child bridge: spawnChild prints
 * the listening line, harnessHttp records calls and answers by path, and
 * watchSse hands the test the SSE sink so it can push opencode events.
 */

type HttpCall = { method: string; path: string; body?: unknown }
const http: HttpCall[] = []
const spawned: { cmd: string; args: string[]; cwd: string }[] = []
const killed: string[] = []
const sseClosed: string[] = []
let childWatch: { onLine: (l: string) => void; onExit: (c: number | null) => void } | undefined
let sseData: ((data: string) => void) | undefined

const MODELS_OUT = [
  'anthropic/claude-sonnet-4-6',
  '{"id":"claude-sonnet-4-6","name":"Claude Sonnet 4.6","variants":{"high":{},"low":{}},"limit":{"context":200000}}',
  ''
].join('\n')

mockChild({
  resolveOpenCodeBinary: async () => ({ path: '/fake/opencode' }),
  execChild: async (_cmd: string, args: string[]) =>
    args[0] === '--version' ? '1.15.0\n' : args[0] === 'models' ? MODELS_OUT : args[0] === 'agent' ? 'build (primary)\n{}\n' : '',
  freeHarnessPort: async () => 4096,
  watchChild: (_id, onLine, onExit) => {
    childWatch = { onLine, onExit }
  },
  unwatchChild: () => {
    childWatch = undefined
  },
  spawnChild: async (_id, cmd, args, cwd) => {
    spawned.push({ cmd, args, cwd })
    setTimeout(() => childWatch?.onLine('opencode server listening on http://127.0.0.1:4096'), 0)
  },
  killChild: async (id) => {
    childWatch = undefined
    killed.push(id)
  },
  harnessHttp: async ({ url, method, body }) => {
    const path = new URL(url).pathname
    http.push({ method, path, body: body ? JSON.parse(body) : undefined })
    if (method === 'GET' && path === '/session/ses_old') {
      return { status: 200, body: JSON.stringify({ data: { id: 'ses_old', directory: '/repo' } }) }
    }
    if (method === 'POST' && path === '/session') return { status: 200, body: JSON.stringify({ id: 'ses_1' }) }
    return { status: 200, body: '{}' }
  },
  watchSse: (_id, onData) => {
    sseData = onData
  },
  unwatchSse: () => undefined,
  openHarnessSse: async () => undefined,
  closeHarnessSse: async (id) => {
    sseClosed.push(id)
    sseData = undefined
  }
})

const { opencodeDriver } = await import('../opencode')

const sse = (type: string, properties: Record<string, unknown>) => sseData!(JSON.stringify({ type, properties }))
const idle = () => sse('session.status', { sessionID: 'ses_1', status: { type: 'idle' } })
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}; http=${JSON.stringify(http.map((c) => `${c.method} ${c.path}`))}`)
}
const posted = (path: string) => http.find((c) => c.method === 'POST' && c.path === path)

function harness(id: string, nativeId: string | null = null) {
  const events: AgentEvent[] = []
  const nativeIds: string[] = []
  const session = {
    id,
    nativeId,
    cwd: '/repo',
    model: 'anthropic/claude-sonnet-4-6',
    reasoning: 'high',
    permission: 'edits'
  } as unknown as SessionMeta
  const ctx: DriverCtx = {
    session,
    emit: (e) => events.push(e),
    setNativeId: (n) => nativeIds.push(n),
    requestApproval: async () => true
  }
  return { events, nativeIds, ctx }
}

async function startTurn(id: string, text = 'hi') {
  const h = harness(id)
  const handle = await opencodeDriver.start(h.ctx)
  const turn = handle.send(text)
  await waitFor(() => posted('/session/ses_1/prompt_async') !== undefined, 'prompt_async')
  return { ...h, handle, turn }
}

describe('opencode driver', () => {
  beforeEach(() => {
    http.length = 0
    spawned.length = 0
    killed.length = 0
    sseClosed.length = 0
  })

  it('spawns serve, creates a session with policy rules, streams text, tool-call, tool-result, turn-complete', async () => {
    const { events, nativeIds, handle, turn } = await startTurn('d1')
    expect(spawned[0]).toEqual({ cmd: '/fake/opencode', args: ['serve', '--hostname=127.0.0.1', '--port=4096'], cwd: '/repo' })
    expect(nativeIds).toEqual(['ses_1'])
    expect(posted('/session')?.body).toEqual({
      permission: [
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'question', pattern: '*', action: 'allow' },
        { permission: 'edit', pattern: '*', action: 'allow' }
      ]
    })
    expect(posted('/session/ses_1/prompt_async')?.body).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
      variant: 'high',
      parts: [{ type: 'text', text: 'hi' }]
    })

    sse('message.updated', { info: { id: 'm1', sessionID: 'ses_1', role: 'assistant' } })
    sse('message.part.updated', { part: { id: 'p1', type: 'text', messageID: 'm1', text: 'Hello' } })
    sse('message.part.delta', { partID: 'p1', delta: ' world' })
    sse('message.part.updated', {
      part: { id: 't1', type: 'tool', callID: 'call1', tool: 'bash', messageID: 'm1', state: { status: 'pending', input: { command: 'ls' } } }
    })
    sse('message.part.updated', {
      part: {
        id: 't1',
        type: 'tool',
        callID: 'call1',
        tool: 'bash',
        messageID: 'm1',
        state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', title: 'ls' }
      }
    })
    idle()
    await turn

    const text = of(events, 'assistant-text')
    expect(text.filter((e) => e.delta).map((e) => e.text)).toEqual(['Hello', ' world'])
    expect(text.find((e) => !e.delta)?.text).toBe('Hello world')
    const calls = of(events, 'tool-call')
    expect(calls[0]).toMatchObject({ callId: 'call1', name: 'Bash', input: { command: 'ls' } })
    const result = of(events, 'tool-result')[0]
    expect(result).toMatchObject({ callId: 'call1', isError: false })
    expect(result?.output).toContain('a.txt')
    expect(of(events, 'turn-complete')).toHaveLength(1)
    expect(of(events, 'user-text')).toHaveLength(0)
    expect(events.at(-1)).toEqual({ type: 'status', status: 'idle' })
    await handle.dispose()
  })

  it('round-trips an approval through approve()', async () => {
    const { events, handle, turn } = await startTurn('d2')
    sse('permission.asked', {
      id: 'perm1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['rm -rf build'],
      callID: 'call2',
      metadata: { input: { command: 'rm -rf build' } }
    })
    const request = of(events, 'approval-request')[0]
    expect(request).toMatchObject({ toolName: 'Bash', callId: 'call2', input: { command: 'rm -rf build' } })
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'waiting' })

    expect(handle.approve!(request!.requestId, true)).toBe(true)
    await waitFor(() => posted('/permission/perm1/reply') !== undefined, 'permission reply')
    expect(posted('/permission/perm1/reply')?.body).toEqual({ reply: 'once' })
    expect(of(events, 'approval-resolved')[0]).toMatchObject({ requestId: request!.requestId, allow: true })
    expect(handle.approve!(request!.requestId, true)).toBe(false)

    idle()
    await turn
    expect(of(events, 'turn-complete')).toHaveLength(1)
    await handle.dispose()
  })

  it('round-trips a question through answer(); null rejects it', async () => {
    const { events, handle, turn } = await startTurn('d3')
    sse('question.asked', {
      id: 'q1',
      sessionID: 'ses_1',
      questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: 'first' }, { label: 'B' }] }]
    })
    const request = of(events, 'question-request')[0]
    expect(request).toMatchObject({
      requestId: 'opencode-q-q1',
      questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, allowFreeform: true, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }]
    })
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'waiting' })

    expect(handle.answer!('opencode-q-q1', [['A']])).toBe(true)
    expect(of(events, 'question-resolved')[0]).toEqual({ type: 'question-resolved', requestId: 'opencode-q-q1', answers: [['A']] })
    expect(events.at(-1)).toEqual({ type: 'status', status: 'running' })
    await waitFor(() => posted('/question/q1/reply') !== undefined, 'question reply')
    expect(posted('/question/q1/reply')?.body).toEqual({ answers: [['A']] })
    expect(handle.answer!('opencode-q-q1', [['A']])).toBe(false)

    sse('question.asked', { id: 'q2', sessionID: 'ses_1', questions: [{ question: 'Sure?', options: [{ label: 'Yes' }] }] })
    expect(handle.answer!('opencode-q-q2', null)).toBe(true)
    await waitFor(() => posted('/question/q2/reject') !== undefined, 'question reject')

    idle()
    await turn
    await handle.dispose()
  })

  it('dispose closes the SSE stream and kills the child', async () => {
    const { ctx } = harness('d4')
    const handle = await opencodeDriver.start(ctx)
    await handle.dispose()
    expect(sseClosed).toEqual(['d4'])
    expect(killed).toEqual(['d4'])
    expect(posted('/session/ses_1/abort')).toBeDefined()
    await expect(handle.send('again')).rejects.toThrow('disposed')
  })

  it('adopts the persisted opencode session on resume', async () => {
    const { ctx, nativeIds } = harness('d5', 'ses_old')
    const handle = await opencodeDriver.start(ctx)
    expect(http.some((c) => c.method === 'GET' && c.path === '/session/ses_old')).toBe(true)
    expect(posted('/session')).toBeUndefined()
    expect(nativeIds).toEqual(['ses_old'])
    await handle.dispose()
  })

  it('a server exit mid-turn errors the turn and settles it', async () => {
    const { events, handle, turn } = await startTurn('d6')
    childWatch!.onExit(1)
    await turn
    expect(of(events, 'error')[0]?.message).toContain('exited')
    expect(of(events, 'turn-complete')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'status', status: 'error' })
    await expect(handle.send('again')).rejects.toThrow('harness gone')
    await handle.dispose()
  })
})
