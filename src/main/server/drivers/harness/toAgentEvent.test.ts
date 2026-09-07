import { describe, expect, test } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from '../types'
import { createTranslator, type TranslatorOptions } from './toAgentEvent'

function harness(opts?: TranslatorOptions) {
  const events: AgentEvent[] = []
  const nativeIds: string[] = []
  const session = { id: 's1', nativeId: null } as unknown as SessionMeta
  const ctx: DriverCtx = {
    session,
    emit: (e) => events.push(e),
    setNativeId: (id) => nativeIds.push(id),
    requestApproval: async () => true
  }
  return { events, nativeIds, session, t: createTranslator(ctx, opts) }
}
const types = (events: AgentEvent[]) => events.map((e) => e.type)
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

describe('blocks', () => {
  test('text → tool → text yields two assistant blocks with distinct blockIndex, one msgId', () => {
    const { events, t } = harness()
    t.push({ type: 'message.delta', text: 'Hel' })
    t.push({ type: 'message.delta', text: 'lo' })
    t.push({ type: 'tool.started', callId: 'c1', title: 'Read a.ts', kind: 'read', input: { path: 'a.ts' } })
    t.push({ type: 'tool.updated', callId: 'c1', status: 'completed' })
    t.push({ type: 'message.delta', text: 'Done' })
    t.push({ type: 'message.completed' })
    const text = of(events, 'assistant-text')
    expect(text.map((e) => [e.delta, e.text, e.blockIndex])).toEqual([
      [true, 'Hel', 0],
      [true, 'lo', 0],
      [false, 'Hello', 0],
      [true, 'Done', 1],
      [false, 'Done', 1]
    ])
    expect(new Set(text.map((e) => e.msgId)).size).toBe(1)
    expect(text[0]!.msgId).toMatch(/^msg-/)
  })

  test('reasoning and text get their own blocks; completed closes with a full snapshot', () => {
    const { events, t } = harness()
    t.push({ type: 'reasoning.delta', text: 'hm' })
    t.push({ type: 'reasoning.delta', text: 'm' })
    t.push({ type: 'reasoning.completed' })
    t.push({ type: 'message.delta', text: 'ok' })
    t.push({ type: 'message.completed' })
    expect(types(events)).toEqual(['thinking', 'thinking', 'thinking', 'assistant-text', 'assistant-text'])
    expect(of(events, 'thinking').at(-1)).toMatchObject({ text: 'hmm', delta: false, blockIndex: 0 })
    expect(of(events, 'assistant-text').at(-1)).toMatchObject({ text: 'ok', delta: false, blockIndex: 1 })
  })

  test('completed without an open block emits nothing; mismatched completed leaves the block open', () => {
    const { events, t } = harness()
    t.push({ type: 'message.completed' })
    t.push({ type: 'reasoning.delta', text: 'x' })
    t.push({ type: 'message.completed' })
    expect(types(events)).toEqual(['thinking'])
  })

  test('each turn gets a fresh msgId and block numbering', () => {
    const { events, t } = harness()
    t.push({ type: 'message.delta', text: 'a' })
    t.settleTurn()
    t.push({ type: 'message.delta', text: 'b' })
    const [a, , b] = of(events, 'assistant-text')
    expect(a!.msgId).not.toBe(b!.msgId)
    expect(b!.blockIndex).toBe(0)
  })
})

describe('tools', () => {
  test('started → tool-call with name from kind, input and preview carried; terminal update → replace + result', () => {
    const { events, t } = harness()
    const preview = { kind: 'shell' as const, title: 'ls', output: 'a.ts\n' }
    t.push({ type: 'tool.started', callId: 'c1', title: 'Run ls', kind: 'execute', status: 'running', input: { command: 'ls' } })
    t.push({ type: 'tool.updated', callId: 'c1', status: 'completed', preview })
    expect(types(events)).toEqual(['tool-call', 'tool-call', 'tool-result'])
    expect(events[0]).toEqual({ type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'ls' }, preview: undefined })
    expect(events[1]).toMatchObject({ name: 'Bash', input: { command: 'ls' }, preview })
    expect(events[2]).toEqual({ type: 'tool-result', callId: 'c1', output: 'a.ts\n', isError: false })
  })

  test('failed → isError with detail as output; the result is emitted once', () => {
    const { events, t } = harness()
    t.push({ type: 'tool.started', callId: 'c1', title: 'Edit a.ts', kind: 'edit' })
    t.push({ type: 'tool.updated', callId: 'c1', status: 'failed', detail: 'boom' })
    t.push({ type: 'tool.updated', callId: 'c1', status: 'failed', detail: 'boom again' })
    expect(types(events)).toEqual(['tool-call', 'tool-call', 'tool-result', 'tool-call'])
    expect(of(events, 'tool-result')[0]).toEqual({ type: 'tool-result', callId: 'c1', output: 'boom', isError: true })
  })

  test('updated without a started (grok) still opens the call; name falls back to preview kind then title', () => {
    const { events, t } = harness()
    t.push({ type: 'tool.updated', callId: 'c1', title: 'Search foo', preview: { kind: 'search', query: 'foo' }, status: 'completed' })
    t.push({ type: 'tool.updated', callId: 'c2', title: 'Weird thing', status: 'completed' })
    expect(of(events, 'tool-call').map((e) => [e.callId, e.name, e.input])).toEqual([
      ['c1', 'Grep', {}],
      ['c2', 'Weird', {}]
    ])
    expect(of(events, 'tool-result')).toHaveLength(2)
  })

  test('toolInput and toolName options synthesize what the engine lacks (fx)', () => {
    const { events, t } = harness({
      toolInput: (tool) => (tool.preview?.kind === 'shell' ? { command: tool.preview.title } : undefined),
      toolName: (tool) => (tool.kind === 'other' ? 'Custom' : undefined)
    })
    t.push({ type: 'tool.started', callId: 'c1', title: 'x', kind: 'other', preview: { kind: 'shell', title: 'make' } })
    expect(events[0]).toMatchObject({ name: 'Custom', input: { command: 'make' } })
  })

  test('non-terminal statuses never produce a result', () => {
    const { events, t } = harness()
    t.push({ type: 'tool.started', callId: 'c1', title: 'x', status: 'pending' })
    t.push({ type: 'tool.updated', callId: 'c1', status: 'in_progress' })
    t.push({ type: 'tool.updated', callId: 'c1', status: 'running' })
    expect(types(events)).toEqual(['tool-call', 'tool-call', 'tool-call'])
  })
})

describe('approvals', () => {
  test('numbers become string ids unique per session, mapped back through approvalNumber', () => {
    const a = harness()
    const b = harness()
    a.t.push({ type: 'approval.requested', requestId: 7, title: 'Run rm', kind: 'execute', callId: 'c1' })
    a.t.push({ type: 'approval.requested', requestId: 8, title: 'Edit', kind: 'edit' })
    b.t.push({ type: 'approval.requested', requestId: 7, title: 'Run rm', kind: 'execute' })
    const [r1, r2] = of(a.events, 'approval-request')
    const [r3] = of(b.events, 'approval-request')
    expect(typeof r1!.requestId).toBe('string')
    expect(new Set([r1!.requestId, r2!.requestId, r3!.requestId]).size).toBe(3)
    expect(a.t.approvalNumber(r1!.requestId)).toBe(7)
    expect(a.t.approvalNumber(r2!.requestId)).toBe(8)
    expect(b.t.approvalNumber(r1!.requestId)).toBeUndefined()
    expect(r1).toMatchObject({ toolName: 'Bash', title: 'Run rm', callId: 'c1' })
    expect(types(a.events)).toEqual(['approval-request', 'status', 'approval-request', 'status'])
    expect(a.events[1]).toEqual({ type: 'status', status: 'waiting', detail: 'awaiting approval' })
  })

  test('the request carries the guarded tool input when the call is known, else the preview', () => {
    const { events, t } = harness()
    t.push({ type: 'tool.started', callId: 'c1', title: 'Run', kind: 'execute', input: { command: 'rm -rf x' } })
    t.push({ type: 'approval.requested', requestId: 1, title: 'Run', callId: 'c1' })
    t.push({ type: 'approval.requested', requestId: 2, title: 'Write', preview: { kind: 'write', path: 'a.ts' } })
    const [r1, r2] = of(events, 'approval-request')
    expect(r1!.input).toEqual({ command: 'rm -rf x' })
    expect(r2!.input).toEqual({ kind: 'write', path: 'a.ts' })
  })

  test('resolved: allow, deny, and cancelled → {allow:false, auto:true}; status returns to running', () => {
    const { events, t } = harness()
    for (const n of [1, 2, 3]) t.push({ type: 'approval.requested', requestId: n, title: 't' })
    const ids = of(events, 'approval-request').map((e) => e.requestId)
    events.length = 0
    t.push({ type: 'approval.resolved', requestId: 1, decision: 'allow' })
    t.push({ type: 'approval.resolved', requestId: 2, decision: 'deny' })
    t.push({ type: 'approval.resolved', requestId: 3, decision: 'cancelled' })
    expect(of(events, 'approval-resolved')).toEqual([
      { type: 'approval-resolved', requestId: ids[0]!, allow: true, auto: undefined },
      { type: 'approval-resolved', requestId: ids[1]!, allow: false, auto: undefined },
      { type: 'approval-resolved', requestId: ids[2]!, allow: false, auto: true }
    ])
    expect(of(events, 'status')).toHaveLength(3)
    expect(t.approvalNumber(ids[0]!)).toBeUndefined()
  })

  test('resolving an unknown number emits nothing', () => {
    const { events, t } = harness()
    t.push({ type: 'approval.resolved', requestId: 99, decision: 'allow' })
    expect(events).toEqual([])
  })
})

describe('session and turn', () => {
  test('plan, context and status text map straight across', () => {
    const { events, t } = harness()
    t.push({ type: 'plan', text: '1. do it' })
    t.push({ type: 'context', used: 1200, window: 200_000 })
    t.push({ type: 'context', window: 200_000 })
    t.push({ type: 'status', text: 'Thinking' })
    expect(events).toEqual([
      { type: 'plan', text: '1. do it' },
      { type: 'context', tokens: 1200, window: 200_000 },
      { type: 'status', status: 'running', detail: 'Thinking' }
    ])
  })

  test('providerBound → setNativeId; error → error event', () => {
    const { events, nativeIds, session, t } = harness()
    t.push({ type: 'session.providerBound', providerSessionId: 'native-1' })
    t.push({ type: 'session.error', message: 'bad' })
    expect(nativeIds).toEqual(['native-1'])
    expect(session.nativeId).toBe('native-1')
    expect(events).toEqual([{ type: 'error', message: 'bad' }])
  })

  test('session.ended settles the turn: open block finalized, then turn-complete + idle exactly once', () => {
    const { events, t } = harness()
    t.beginTurn()
    t.push({ type: 'session.started' })
    t.push({ type: 'message.delta', text: 'hi' })
    t.push({ type: 'session.ended', code: 0 })
    t.settleTurn()
    t.push({ type: 'session.ended', code: 0 })
    expect(types(events)).toEqual(['status', 'assistant-text', 'assistant-text', 'turn-complete', 'status'])
    expect(events[0]).toEqual({ type: 'status', status: 'running' })
    expect(events[2]).toMatchObject({ delta: false, text: 'hi' })
    expect(events[4]).toEqual({ type: 'status', status: 'idle' })
  })

  test('settleTurn with no turn open is a no-op', () => {
    const { events, t } = harness()
    t.settleTurn()
    expect(events).toEqual([])
  })
})
