import { beforeEach, describe, expect, it } from 'vitest'
import { mockChild } from './fxChildMock'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from '../types'

const sent: string[] = []
let onLine: ((line: string) => void) | undefined

mockChild({
  resolveGrokBinary: async () => ({ path: '/fake/grok' }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line)
  }
})

const { grokDriver } = await import('../grok')

const parse = () => sent.map((s) => JSON.parse(s))
const reply = (id: number, result: unknown) => onLine!(JSON.stringify({ jsonrpc: '2.0', id, result }))
const frame = (msg: object) => onLine!(JSON.stringify({ jsonrpc: '2.0', ...msg }))
// Client request ids and harness request ids share a number space, so match on the reply shape.
const response = (id: number) => parse().find((m) => m.id === id && 'result' in m)?.result
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}; sent=${JSON.stringify(parse().map((m) => m.method ?? `reply:${m.id}`))}`)
}
const request = async (method: string) => {
  await waitFor(() => parse().some((m) => m.method === method), method)
  return parse().find((m) => m.method === method)!.id as number
}
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

function harness(id: string) {
  const events: AgentEvent[] = []
  const nativeIds: string[] = []
  const session = {
    id,
    nativeId: null,
    cwd: '/repo',
    model: 'grok-4.6',
    reasoning: 'high',
    permission: 'safe'
  } as unknown as SessionMeta
  const ctx: DriverCtx = {
    session,
    emit: (e) => events.push(e),
    setNativeId: (n) => nativeIds.push(n),
    requestApproval: async () => true
  }
  return { events, nativeIds, ctx }
}

async function handshake() {
  reply(await request('initialize'), {
    protocolVersion: 1,
    authMethods: [{ id: 'cached_token' }],
    _meta: { modelState: { currentModelId: 'grok-4.6', availableModels: [] } }
  })
  reply(await request('authenticate'), {})
  reply(await request('session/new'), { sessionId: 'S1', models: { currentModelId: 'grok-4.6' } })
  reply(await request('session/set_mode'), {})
  return request('session/prompt')
}

describe('grok driver', () => {
  beforeEach(() => {
    sent.length = 0
  })

  it('streams a turn: text, tool-call with rawInput, approval round-trip, result, turn-complete', async () => {
    const { events, nativeIds, ctx } = harness('d1')
    const handle = await grokDriver.start(ctx)
    const turn = handle.send('run git', [{ path: '/repo/notes.md', name: 'notes.md', kind: 'file' }])
    const promptId = await handshake()
    expect(nativeIds).toEqual(['S1'])
    const prompt = parse().find((m) => m.id === promptId)
    expect(prompt.params.prompt).toEqual([{ type: 'text', text: 'run git\n\nAttached file: /repo/notes.md' }])

    frame({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking' } } } })
    frame({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_a',
          kind: 'execute',
          title: 'Execute `git status`',
          status: 'in_progress',
          rawInput: { variant: 'Bash', command: 'git status' }
        }
      }
    })
    frame({
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId: 'S1',
        toolCall: { toolCallId: 'call_a', kind: 'execute', title: 'Execute `git status`', rawInput: { variant: 'Bash', command: 'git status' } },
        options: [{ optionId: 'allow-once' }, { optionId: 'reject-once' }]
      }
    })
    await waitFor(() => of(events, 'approval-request').length > 0, 'approval-request')
    const approval = of(events, 'approval-request')[0]!
    expect(approval).toMatchObject({ toolName: 'Bash', callId: 'call_a', input: { command: 'git status' } })
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'waiting' })

    expect(handle.approve!('nope', true)).toBe(false)
    expect(handle.approve!(approval.requestId, true)).toBe(true)
    await waitFor(() => response(7) !== undefined, 'permission response')
    expect(response(7).outcome.optionId).toBe('allow-once')
    expect(of(events, 'approval-resolved')[0]).toMatchObject({ requestId: approval.requestId, allow: true })

    frame({
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_a', status: 'completed', rawOutput: 'clean' } }
    })
    reply(promptId, { stopReason: 'end_turn' })
    await turn

    expect(of(events, 'assistant-text').map((e) => e.text)).toEqual(['Checking', 'Checking'])
    const calls = of(events, 'tool-call')
    expect(calls[0]).toMatchObject({ callId: 'call_a', name: 'Bash', input: { variant: 'Bash', command: 'git status' } })
    expect(of(events, 'tool-result')).toEqual([{ type: 'tool-result', callId: 'call_a', output: 'clean', isError: false }])
    expect(events.map((e) => e.type).slice(-2)).toEqual(['turn-complete', 'status'])
    expect(events.at(-1)).toMatchObject({ status: 'idle' })
    await handle.dispose()
  })

  it('carries ask_user_question as a question-request answered through answer()', async () => {
    const { events, ctx } = harness('d2')
    const handle = await grokDriver.start(ctx)
    const turn = handle.send('pick')
    const promptId = await handshake()
    frame({
      id: 9,
      method: '_x.ai/ask_user_question',
      params: { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }
    })
    await waitFor(() => of(events, 'question-request').length > 0, 'question-request')
    const q = of(events, 'question-request')[0]!
    expect(q.questions).toEqual([
      { question: 'Which colour?', multiSelect: false, allowFreeform: true, options: [{ label: 'Red' }, { label: 'Blue' }] }
    ])
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'waiting' })

    expect(handle.answer!('nope', [['Red']])).toBe(false)
    expect(handle.answer!(q.requestId, [['Blue']])).toBe(true)
    await waitFor(() => response(9) !== undefined, 'question response')
    expect(response(9)).toEqual({ outcome: 'accepted', answers: { 'Which colour?': 'Blue' } })
    expect(of(events, 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: q.requestId, answers: [['Blue']] }])
    expect(handle.answer!(q.requestId, null)).toBe(false)

    reply(promptId, { stopReason: 'end_turn' })
    await turn
    await handle.dispose()
  })

  it('a dismissed question tells grok to skip; interrupt cancels the turn', async () => {
    const { events, ctx } = harness('d3')
    const handle = await grokDriver.start(ctx)
    const turn = handle.send('pick')
    await handshake()
    frame({ id: 3, method: '_x.ai/ask_user_question', params: { questions: [{ question: 'Q?', options: [] }] } })
    await waitFor(() => of(events, 'question-request').length > 0, 'question-request')
    handle.answer!(of(events, 'question-request')[0]!.requestId, null)
    await waitFor(() => response(3) !== undefined, 'skip response')
    expect(response(3)).toEqual({ outcome: 'skip_interview' })

    handle.interrupt()
    await turn
    expect(parse().some((m) => m.method === 'session/cancel')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'idle' })
    expect(of(events, 'error')).toEqual([])
    await handle.dispose()
  })
})
