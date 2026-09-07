import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { ApprovalRequest, DriverCtx } from '../types'
import { mockChild } from './fxChildMock'

/**
 * The pi family driver over a scripted fake child. Every RPC request pi
 * would answer gets an immediate `response` frame; agent frames (the
 * turn's content) are pushed by the test through the watcher.
 */

type Watch = { onLine: (l: string) => void; onExit: (code: number | null) => void }
const fake = {
  spawned: [] as { id: string; command: string; args: string[]; cwd: string }[],
  written: [] as { id: string; rec: Record<string, unknown> }[],
  killed: [] as string[],
  watches: new Map<string, Watch>(),
  /** frames pi sends back on its own after a request is answered */
  after: (_id: string, _rec: Record<string, unknown>) => undefined as void
}

const respond = (id: string, rec: Record<string, unknown>): void => {
  const data =
    rec.type === 'get_state'
      ? { sessionId: 'pi-sess-1', model: { provider: 'anthropic', id: 'claude-x', contextWindow: 200_000 } }
      : rec.type === 'get_session_stats'
        ? { contextUsage: { tokens: 120, contextWindow: 200_000 } }
        : rec.type === 'set_model'
          ? { contextWindow: 200_000 }
          : undefined
  fake.watches.get(id)?.onLine(JSON.stringify({ type: 'response', command: rec.type, id: rec.id, success: true, data }))
  fake.after(id, rec)
}

mockChild({
  resolvePiBinary: async () => ({ path: '/fake/pi' }),
  resolveOmpBinary: async () => ({ path: '/fake/omp' }),
  spawnChild: async (id, command, args, cwd) => {
    fake.spawned.push({ id, command, args, cwd })
  },
  writeChild: async (id, line) => {
    const rec = JSON.parse(line) as Record<string, unknown>
    fake.written.push({ id, rec })
    queueMicrotask(() => respond(id, rec))
  },
  killChild: async (id) => {
    fake.killed.push(id)
    fake.watches.delete(id)
  },
  watchChild: (id, onLine, onExit) => {
    fake.watches.set(id, { onLine, onExit })
  },
  unwatchChild: (id) => {
    fake.watches.delete(id)
  }
})

const { piDriver } = await import('../pi')
const { ompDriver } = await import('../omp')

const frame = (id: string, rec: Record<string, unknown>): void => fake.watches.get(id)?.onLine(JSON.stringify(rec))
const written = (type: string) => fake.written.filter((w) => w.rec.type === type).map((w) => w.rec)
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await tick()
  if (!cond()) throw new Error('condition never held')
}

/** The frames of one whole turn: text, a bash tool that runs and ends, then agent_end. */
const streamTurn = (id: string): void => {
  frame(id, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } })
  frame(id, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'there' } })
  frame(id, {
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call_1', toolName: 'bash' }
  })
  frame(id, {
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'call_1', name: 'bash', arguments: { command: 'ls' } } }
  })
  frame(id, { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } })
  frame(id, {
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'bash',
    isError: false,
    result: { content: [{ type: 'text', text: 'a.ts\nb.ts' }] }
  })
  frame(id, { type: 'message_end', message: { role: 'assistant', stopReason: 'end_turn', usage: { totalTokens: 90 } } })
  frame(id, { type: 'agent_end', willRetry: false })
}

function harness(flavor: 'pi' | 'omp', id: string) {
  const events: AgentEvent[] = []
  const approvals: ApprovalRequest[] = []
  const nativeIds: string[] = []
  const session = {
    id,
    provider: flavor,
    model: 'anthropic/claude-x',
    reasoning: 'medium',
    cwd: '/tmp/proj',
    permission: 'edits',
    nativeId: null
  } as unknown as SessionMeta
  const ctx: DriverCtx = {
    session,
    emit: (e) => events.push(e),
    setNativeId: (n) => nativeIds.push(n),
    requestApproval: async (req) => {
      approvals.push(req)
      return true
    }
  }
  return { events, approvals, nativeIds, session, ctx }
}

describe.each([
  ['pi', piDriver, '/fake/pi'],
  ['omp', ompDriver, '/fake/omp']
] as const)('%s driver', (flavor, driver, bin) => {
  beforeEach(() => {
    fake.spawned.length = 0
    fake.written.length = 0
    fake.killed.length = 0
    fake.watches.clear()
    fake.after = () => undefined
  })

  it(`has id ${flavor}`, () => {
    expect(driver.id as string).toBe(flavor)
  })

  it('a send streams text, a tool call with its result, and turn-complete', async () => {
    const id = `${flavor}-s1`
    const h = harness(flavor, id)
    const handle = await driver.start(h.ctx)
    fake.after = (_id, rec) => {
      if (rec.type === 'prompt') streamTurn(id)
    }
    await handle.send('hi')
    await until(() => of(h.events, 'turn-complete').length === 1)

    expect(fake.spawned).toEqual([
      { id, command: bin, args: ['--mode', 'rpc', '--model', 'anthropic/claude-x'], cwd: '/tmp/proj' }
    ])
    expect(written('prompt')).toEqual([{ type: 'prompt', message: 'hi', id: expect.any(String) }])
    expect(h.nativeIds).toEqual(['pi-sess-1'])

    const text = of(h.events, 'assistant-text')
    expect(text.at(-1)).toMatchObject({ text: 'Hello there', delta: false })
    const calls = of(h.events, 'tool-call')
    expect(calls[0]).toMatchObject({ callId: 'call_1', name: 'Bash' })
    expect(calls.at(-1)).toMatchObject({ callId: 'call_1', name: 'Bash', input: { command: 'ls' } })
    expect(of(h.events, 'tool-result')).toEqual([{ type: 'tool-result', callId: 'call_1', output: 'a.ts\nb.ts', isError: false }])
    expect(of(h.events, 'context').at(-1)).toMatchObject({ tokens: 120, window: 200_000 })
    const types = h.events.map((e) => e.type)
    expect(types[0]).toBe('status')
    expect(types.indexOf('tool-call')).toBeGreaterThan(types.indexOf('assistant-text'))
    expect(types.indexOf('turn-complete')).toBeGreaterThan(types.indexOf('tool-result'))
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle' })
    await handle.dispose()
  })

  it('a second send mid-turn goes through the steer frame', async () => {
    const id = `${flavor}-s2`
    const h = harness(flavor, id)
    const handle = await driver.start(h.ctx)
    await handle.send('first')
    expect(written('prompt')).toHaveLength(1)

    await handle.send('and also this')
    expect(written('steer')).toEqual([{ type: 'steer', message: 'and also this', id: expect.any(String) }])
    expect(written('prompt')).toHaveLength(1)
    expect(written('abort')).toHaveLength(0)

    streamTurn(id)
    await until(() => of(h.events, 'turn-complete').length === 1)
    await handle.dispose()
  })

  it('an extension prompt is asked through ctx.requestApproval and answered on the wire', async () => {
    const id = `${flavor}-s3`
    const h = harness(flavor, id)
    const handle = await driver.start(h.ctx)
    await handle.send('go')
    frame(id, { type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Run rm?', message: 'dangerous' })
    await until(() => written('extension_ui_response').length === 1)
    expect(h.approvals).toEqual([{ toolName: expect.stringContaining('extension'), input: {}, title: 'Run rm? — dangerous', callId: undefined }])
    expect(written('extension_ui_response')).toEqual([{ type: 'extension_ui_response', id: 'ui-1', confirmed: true }])
    expect(of(h.events, 'approval-request')).toHaveLength(0)
    streamTurn(id)
    await until(() => of(h.events, 'turn-complete').length === 1)
    await handle.dispose()
  })

  it('interrupt sends abort and settles the turn', async () => {
    const id = `${flavor}-s4`
    const h = harness(flavor, id)
    const handle = await driver.start(h.ctx)
    await handle.send('long task')
    handle.interrupt()
    await until(() => of(h.events, 'turn-complete').length === 1)
    expect(written('abort')).toHaveLength(1)
    await handle.dispose()
  })

  it('dispose kills the child', async () => {
    const id = `${flavor}-s5`
    const h = harness(flavor, id)
    const handle = await driver.start(h.ctx)
    await handle.send('hi')
    await handle.dispose()
    expect(fake.killed).toEqual([id])
    expect(fake.watches.has(id)).toBe(false)
  })

  it('images ride inline; other files become path references', async () => {
    const id = `${flavor}-s6`
    const h = harness(flavor, id)
    const handle = await driver.start(h.ctx)
    const png = join(tmpdir(), `.tmp-${flavor}-test.png`)
    await writeFile(png, new Uint8Array([137, 80, 78, 71]))
    try {
      await handle.send('look', [
        { path: png, name: 'shot.png', mime: 'image/png', kind: 'image' },
        { path: '/tmp/notes.md', name: 'notes.md', kind: 'file' }
      ])
    } finally {
      await rm(png, { force: true })
    }
    const prompt = written('prompt')[0]!
    expect(prompt.message).toBe('look\n\nAttached file: /tmp/notes.md')
    expect(prompt.images).toEqual([{ type: 'image', mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') }])
    await handle.dispose()
  })
})
