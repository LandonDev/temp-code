import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { failureKindOf } from '../failureKind'
import { bridgeMcpConfig } from '../apptools'
import { COMPUTER_PICTURES_TEXT, MAX_IMAGE_PARTS, formatShotLine } from '@shared/computer/tools'
import type { DriverCtx } from './types'

/**
 * Driver boot over a fake `codex app-server` process: each spawn hands the
 * test a script that answers (or kills the process on) every JSON-RPC
 * request the driver writes. Covers the stderr tail in the handshake error
 * and the boot retry.
 */

type Frame = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
type Script = (proc: FakeProc, frame: Frame) => void

class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin: Writable
  killed = false
  constructor(script: Script) {
    super()
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        for (const line of String(chunk).split('\n')) if (line) script(this, JSON.parse(line))
        cb()
      }
    })
  }
  reply(id: number, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }
  fail(id: number, message: string): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message } }) + '\n')
  }
  die(code: number, stderr: string[] = []): void {
    for (const line of stderr) this.stderr.write(line + '\n')
    // stderr lines reach the reader on the next tick; the exit must follow them.
    setImmediate(() => this.emit('exit', code))
  }
  kill(): void {
    this.killed = true
  }
}

const scripts: Script[] = []
const spawned: FakeProc[] = []

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    const script = scripts.shift()
    if (!script) throw new Error('no script for this spawn')
    const proc = new FakeProc(script)
    spawned.push(proc)
    return proc
  }
}))
vi.mock('./binaries', () => ({ resolveBinary: async () => '/fake/codex', harnessEnv: async () => ({}) }))
vi.mock('../endpoint', () => ({ routedEndpointFor: async () => ({ url: null, account: 'acct-1' }) }))
vi.mock('../apptools', () => ({ bridgeMcpConfig: vi.fn(() => null) }))
vi.mock('../gatewayObserve', () => ({ observeCodexSnapshot: () => undefined }))

const { codexDriver, codexWarm, bootOptions, setCodexBootFailureLog, withoutImageBytes, codexComputerImages } = await import('./codex')

/** Answers the handshake and every later request; starts thread `t1`. */
const healthy: Script = (proc, frame) => {
  if (frame.id === undefined) return
  if (frame.method === 'thread/start') proc.reply(frame.id, { thread: { id: 't1' } })
  else proc.reply(frame.id, {})
}

/** Dies at initialize with the codex log-database complaint on stderr. */
const dying: Script = (proc, frame) => {
  if (frame.method === 'initialize') {
    proc.die(1, [
      '2026-09-26T20:30:01Z DEBUG rmcp::transport::worker: sending message',
      'ERROR codex_core::logging: unable to open database file: ~/.codex/logs_2.sqlite',
      'Error: database is locked'
    ])
  }
}

const session = {
  id: 'sess-1',
  cwd: '/repo',
  model: 'gpt-6-astra',
  permission: 'auto',
  reasoning: 'medium',
  fast: false,
  ultrafast: false,
  nativeId: null,
  goal: null
} as unknown as SessionMeta

let events: AgentEvent[]
let nativeIds: string[]
let logDir: string

function ctx(): DriverCtx {
  return {
    session,
    emit: (e) => events.push(e),
    setNativeId: (id) => nativeIds.push(id),
    requestApproval: async () => true
  }
}

beforeEach(() => {
  events = []
  nativeIds = []
  spawned.length = 0
  scripts.length = 0
  bootOptions.backoffMs = [0, 0]
  logDir = mkdtempSync(join(tmpdir(), 'codex-boot-'))
  setCodexBootFailureLog(logDir)
})

afterEach(() => {
  codexWarm.retire()
  for (const proc of spawned) proc.emit('exit', 0)
  vi.useRealTimers()
  vi.unstubAllEnvs()
  setCodexBootFailureLog(null)
  bootOptions.backoffMs = [1500, 4000]
})

describe('codex app-server boot', () => {
  it('a boot that keeps dying fails with the exit code and the stderr tail, noise dropped, and is logged', async () => {
    scripts.push(dying, dying, dying)
    const err = await codexDriver.start(ctx()).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain('codex app-server handshake failed: codex app-server exited (1)')
    expect(message).toContain('unable to open database file')
    expect(message).toContain('database is locked')
    expect(message).not.toContain('rmcp')
    expect(spawned).toHaveLength(3)
    expect(spawned.every((p) => p.killed)).toBe(true)
    // No crash report on top of the thrown error.
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    await new Promise((r) => setTimeout(r, 20))
    const log = readFileSync(join(logDir, 'codex-boot-failures.log'), 'utf8')
    expect(log).toContain('session=sess-1 attempt=1 exit=1 cwd=/repo account=-')
    expect(log).toContain('attempt=3 exit=1')
    expect(log).toContain('  ERROR codex_core::logging: unable to open database file')
    expect(log).not.toContain('rmcp')
  })

  it('a boot that dies once is retried and the thread starts on the second process', async () => {
    scripts.push(dying, healthy)
    const handle = await codexDriver.start(ctx())
    expect(handle).toBeTruthy()
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killed).toBe(true)
    expect(spawned[1].killed).toBe(false)
    expect(nativeIds).toEqual(['t1'])
    expect(events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('a living app-server that misses its handshake deadline is killed and booted again', async () => {
    vi.useFakeTimers()
    vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
    scripts.push(() => {}, healthy)
    const started = codexDriver.start(ctx())
    await vi.advanceTimersByTimeAsync(30_001)
    const handle = await started
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killed).toBe(true)
    expect(nativeIds).toEqual(['t1'])
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    await handle.dispose()
  })

  it('a turn/start deadline emits a network error, idles the thread and kills the stalled process', async () => {
    vi.useFakeTimers()
    vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
    scripts.push((proc, frame) => {
      if (frame.method !== 'turn/start') healthy(proc, frame)
    })
    const handle = await codexDriver.start(ctx())
    await vi.advanceTimersByTimeAsync(20_000) // the existing first-turn MCP startup gate
    await handle.send('hello')
    await vi.advanceTimersByTimeAsync(60_000)
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toEqual([{ type: 'error', message: 'codex app-server turn/start timed out after 60000 ms' }])
    const error = errors[0] as { message: string }
    expect(failureKindOf({ message: error.message, provider: 'codex', model: null, account: null, accountKnown: null, modelVisible: true })).toBe('network')
    expect(events.filter((e) => e.type === 'status').at(-1)).toMatchObject({ status: 'idle' })
    expect(spawned[0].killed).toBe(true)
    spawned[0].emit('exit', 0)
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    // The next message is never written into the dead process: the handle
    // says the harness is gone, and the registry boots a fresh one on that.
    expect(handle.alive?.()).toBe(false)
    await expect(handle.send('again')).rejects.toThrow('harness gone')
    await handle.dispose()
  })

  it("codex's own retries are a log line, not rows; the error that ends the turn is a row", async () => {
    scripts.push(healthy)
    await codexDriver.start(ctx())
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const notify = (method: string, params: Record<string, unknown>): void => {
      spawned[0].stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params: { threadId: 't1', ...params } }) + '\n')
    }
    const retry = (n: number) => ({ error: { message: `Reconnecting... ${n}/5`, additionalDetails: 'workspace routing discovery unauthorized (401)' }, willRetry: true })
    notify('error', retry(2))
    notify('error', retry(3))
    notify('error', { error: { message: 'workspace routing discovery unauthorized (401)' }, willRetry: false })
    notify('turn/completed', { turn: { id: 'turn-1', status: 'failed' } })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn-complete')).toBe(true))
    expect(events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message)).toEqual(['workspace routing discovery unauthorized (401)'])
    const retries = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Reconnecting'))
    expect(retries).toEqual(['[codex] sess-1: Reconnecting... 2/5 (workspace routing discovery unauthorized (401)); retrying'])
    // The strip hears each retry as a phase, cleared by the next item.
    expect(events.filter((e) => e.type === 'phase')).toEqual([
      { type: 'phase', phase: 'retrying', detail: 'Reconnecting... 2/5', retry: { attempt: 2, delayMs: 0, reason: 'of 5' } },
      { type: 'phase', phase: 'retrying', detail: 'Reconnecting... 3/5', retry: { attempt: 3, delayMs: 0, reason: 'of 5' } },
      { type: 'phase', phase: null }
    ])
    // The next turn logs again.
    notify('error', retry(1))
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Reconnecting'))).toHaveLength(2)
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    log.mockRestore()
  })

  it('the first send says Initializing while the MCP gate holds, and notes the gate on delivered; the handle is cold', async () => {
    vi.useFakeTimers()
    vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
    scripts.push(healthy)
    const marks: { phase: string; note?: string }[] = []
    const handle = await codexDriver.start({ ...ctx(), mark: (phase, note) => marks.push({ phase, note }) })
    expect(marks).toEqual([{ phase: 'handle', note: 'cold' }])
    const notify = (method: string, params: Record<string, unknown>): void => {
      spawned[0].stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    }
    notify('mcpServer/startupStatus/updated', { name: 'linear', status: 'starting' })
    await vi.advanceTimersByTimeAsync(0)
    const sent = handle.send('hello')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.filter((e) => e.type === 'phase')).toEqual([{ type: 'phase', phase: 'initializing' }])
    await vi.advanceTimersByTimeAsync(1_400)
    notify('mcpServer/startupStatus/updated', { name: 'linear', status: 'ready' })
    await vi.advanceTimersByTimeAsync(500)
    await sent
    expect(events.filter((e) => e.type === 'phase')).toEqual([
      { type: 'phase', phase: 'initializing' },
      { type: 'phase', phase: null }
    ])
    const delivered = marks.find((m) => m.phase === 'delivered')
    expect(delivered?.note).toMatch(/^mcp=19\d\d$/)
    // The gate is the first send's alone.
    await handle.send('again')
    expect(marks.filter((m) => m.phase === 'delivered')).toHaveLength(1)
    await handle.dispose()
  })

  it('an adopted warm app-server marks the handle warm', async () => {
    scripts.push(healthy, healthy)
    const spec = { command: '/fake/codex', args: ['app-server'], cwd: '/repo', env: { TEMP_CODE_THREAD: 'other' } }
    codexWarm.noteStart(spec)
    await codexWarm.settled()
    expect(codexWarm.status().warm).toHaveLength(1)
    const marks: { phase: string; note?: string }[] = []
    const handle = await codexDriver.start({ ...ctx(), mark: (phase, note) => marks.push({ phase, note }) })
    expect(marks).toEqual([{ phase: 'handle', note: 'warm' }])
    expect(spawned).toHaveLength(1)
    await handle.dispose()
  })

  it('an exit after the thread is up is a crash, not a retry', async () => {
    scripts.push(healthy)
    await codexDriver.start(ctx())
    spawned[0].emit('exit', 1)
    expect(spawned).toHaveLength(1)
    expect(events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message)).toEqual([
      'codex app-server exited unexpectedly (1)'
    ])
  })
})

describe('a steer into a codex turn', () => {
  /** A healthy app-server that records every request and answers turn/steer by `steer`. */
  const steering = (steer: (proc: FakeProc, frame: Frame) => void, requests: Frame[]): Script => (proc, frame) => {
    requests.push(frame)
    if (frame.method === 'turn/steer' && frame.id !== undefined) steer(proc, frame)
    else healthy(proc, frame)
  }
  const boot = async (script: Script) => {
    vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
    scripts.push(script)
    const handle = await codexDriver.start(ctx())
    const notify = (method: string, params: Record<string, unknown>): void => {
      spawned[0].stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params: { threadId: 't1', ...params } }) + '\n')
    }
    // Release the first-turn MCP gate: no server is starting.
    notify('mcpServer/startupStatus/updated', { name: 'x', status: 'ready' })
    await new Promise((r) => setTimeout(r, 550))
    notify('turn/started', { turn: { id: 'turn-1' } })
    return { handle, notify }
  }
  const echo = (clientId: string) => ({ item: { type: 'userMessage', id: 'u1', clientId, content: [] } })
  const steerRows = () => events.filter((e) => e.type === 'steer')

  it('goes in with turn/steer on the running turn and is received at its echo, once', async () => {
    const requests: Frame[] = []
    const { handle, notify } = await boot(steering((proc, frame) => proc.reply(frame.id!, { turnId: 'turn-1' }), requests))
    await handle.send('use the other table', [], { steerId: 's1' })
    await vi.waitFor(() => expect(requests.some((r) => r.method === 'turn/steer')).toBe(true))
    expect(requests.find((r) => r.method === 'turn/steer')?.params).toMatchObject({ threadId: 't1', expectedTurnId: 'turn-1', clientUserMessageId: 's1' })
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false)
    notify('item/started', echo('s1'))
    notify('item/completed', echo('s1'))
    await vi.waitFor(() => expect(steerRows()).toHaveLength(1))
    expect(steerRows()).toEqual([{ type: 'steer', steerId: 's1', state: 'received', how: 'in-turn' }])
    await handle.dispose()
  })

  it('a turn that ended first, or a binary without turn/steer, starts the next turn with the id', async () => {
    for (const refusal of ['no active turn to steer', 'Invalid request: unknown variant `turn/steer`']) {
      events = []
      spawned.length = 0
      const requests: Frame[] = []
      const { handle, notify } = await boot(steering((proc, frame) => proc.fail(frame.id!, refusal), requests))
      await handle.send('use the other table', [], { steerId: 's2' })
      await vi.waitFor(() => expect(requests.some((r) => r.method === 'turn/start')).toBe(true))
      expect(requests.find((r) => r.method === 'turn/start')?.params).toMatchObject({ clientUserMessageId: 's2' })
      notify('item/started', echo('s2'))
      await vi.waitFor(() => expect(steerRows()).toEqual([{ type: 'steer', steerId: 's2', state: 'received', how: 'next-turn' }]))
      await handle.dispose()
      spawned[0].emit('exit', 0)
    }
  })

  it('a plain send and an unknown clientId never stamp', async () => {
    const requests: Frame[] = []
    const { handle, notify } = await boot(steering((proc, frame) => proc.reply(frame.id!, {}), requests))
    await handle.send('hello')
    await vi.waitFor(() => expect(requests.some((r) => r.method === 'turn/start')).toBe(true))
    expect(requests.find((r) => r.method === 'turn/start')?.params).not.toHaveProperty('clientUserMessageId')
    notify('item/started', echo('stranger'))
    notify('item/started', { item: { type: 'userMessage', id: 'u2', content: [] } })
    await new Promise((r) => setTimeout(r, 20))
    expect(steerRows()).toEqual([])
    await handle.dispose()
  })
})

describe('withoutImageBytes', () => {
  it("replaces an MCP result's image parts with [image] and leaves everything else", () => {
    const result = {
      content: [
        { type: 'text', text: '{"contentHeight":248}' },
        { type: 'image', data: 'iVBORw0KGgo'.repeat(100), mimeType: 'image/png' }
      ],
      structuredContent: { ok: true }
    }
    expect(withoutImageBytes(result)).toEqual({
      content: [
        { type: 'text', text: '{"contentHeight":248}' },
        { type: 'text', text: '[image]' }
      ],
      structuredContent: { ok: true }
    })
    expect(withoutImageBytes('plain')).toBe('plain')
    expect(withoutImageBytes(null)).toBeNull()
    expect(withoutImageBytes({ htmlRender: {} })).toEqual({ htmlRender: {} })
  })
})


describe('codex approval and question replies', () => {
  async function boot() {
    vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
    const responses: Frame[] = []
    scripts.push((proc, frame) => {
      if (frame.method) healthy(proc, frame)
      else responses.push(frame)
    })
    const handle = await codexDriver.start({ ...ctx(), session: { ...session, permission: 'safe' } })
    const request = (method: string, params: Record<string, unknown>) => {
      spawned[0].stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method, params: { threadId: 't1', ...params } }) + '\n')
    }
    return { handle, responses, request }
  }

  it.each([
    ['item/commandExecution/requestApproval', { decision: 'decline' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['execCommandApproval', { decision: 'denied' }],
    ['applyPatchApproval', { decision: 'denied' }],
    ['mcpServer/elicitation/request', { action: 'decline' }]
  ])('denies %s without adding text to its wire', async (method, result) => {
    const { handle, responses, request } = await boot()
    try {
      request(method, { itemId: 'call-1', serverName: 'external' })
      await vi.waitFor(() => expect(events.some((event) => event.type === 'approval-request')).toBe(true))
      const approval = events.find((event) => event.type === 'approval-request')!
      expect(handle.approve!(approval.requestId, false, 'The person is away. Decide yourself.')).toBe(true)
      await vi.waitFor(() => expect(responses).toEqual([{ jsonrpc: '2.0', id: 900, result }]))
      expect(handle.approve!(approval.requestId, false)).toBe(false)
    } finally {
      await handle.dispose()
    }
  })

  it('sends free text in the question answers wire', async () => {
    const { handle, responses, request } = await boot()
    try {
      request('item/tool/requestUserInput', {
        itemId: 'call-q', questions: [{ id: 'q1', question: 'Which one?', isOther: true, options: [{ label: 'A' }, { label: 'B' }] }]
      })
      await vi.waitFor(() => expect(events.some((event) => event.type === 'question-request')).toBe(true))
      const question = events.find((event) => event.type === 'question-request')!
      const text = 'The person is away. Decide yourself.'
      expect(handle.answer!(question.requestId, [[text]])).toBe(true)
      await vi.waitFor(() => expect(responses).toEqual([{
        jsonrpc: '2.0', id: 900, result: { answers: { q1: { answers: [text] } } }
      }]))
      expect(handle.answer!(question.requestId, [[text]])).toBe(false)
    } finally {
      await handle.dispose()
    }
  })
})

describe('computer pictures', () => {
  it('gates overrides to tests and proof runs', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TEMP_CODE_E2E_STATUS', '')
    vi.stubEnv('TEMP_CODE_CODEX_COMPUTER_IMAGES', 'steer')
    expect(codexComputerImages()).toBe('parts')
    vi.stubEnv('TEMP_CODE_E2E_STATUS', '1')
    expect(codexComputerImages()).toBe('steer')
    vi.stubEnv('TEMP_CODE_E2E_STATUS', '')
    vi.stubEnv('NODE_ENV', 'test')
    for (const mode of ['parts', 'steer', 'view'] as const) {
      vi.stubEnv('TEMP_CODE_CODEX_COMPUTER_IMAGES', mode)
      expect(codexComputerImages()).toBe(mode)
    }
    vi.stubEnv('TEMP_CODE_CODEX_COMPUTER_IMAGES', 'invalid')
    expect(codexComputerImages()).toBe('parts')
  })

  it('passes parts to the bridge', async () => {
    vi.stubEnv('TEMP_CODE_CODEX_COMPUTER_IMAGES', 'parts')
    scripts.push(healthy)
    const handle = await codexDriver.start(ctx())
    expect(bridgeMcpConfig).toHaveBeenLastCalledWith('sess-1', { computerImages: 'parts' })
    await handle.dispose()
  })

  it.each([false, true])('steers pictures once, hides its echo and drops refusal=%s', async (refused) => {
    vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
    vi.stubEnv('TEMP_CODE_CODEX_COMPUTER_IMAGES', 'steer')
    const requests: Frame[] = []
    scripts.push((proc, frame) => {
      requests.push(frame)
      if (frame.method === 'turn/steer' && refused) proc.fail(frame.id!, 'no active turn to steer')
      else healthy(proc, frame)
    })
    const handle = await codexDriver.start(ctx())
    const notify = (method: string, params: Record<string, unknown>) => spawned[0].stdout.write(JSON.stringify({ method, params }) + '\n')
    notify('turn/started', { turn: { id: 'turn-1' } })
    const paths = Array.from({ length: MAX_IMAGE_PARTS + 1 }, (_, i) => `/tmp/shot ${i}.png`)
    const result = { content: [{ type: 'text', text: paths.map((path, i) => formatShotLine(i + 1, i + 1, { path, width: 1280, height: 800 }, true)).join('\n') }] }
    const item = { type: 'mcpToolCall', id: 'c1', server: 'app', tool: 'computer_batch', status: 'completed', result }
    notify('item/started', { item })
    notify('item/completed', { item: { ...item, id: 'other', tool: 'html_preview' } })
    notify('item/completed', { item: { ...item, id: 'external', server: 'external' } })
    expect(requests.filter((r) => r.method === 'turn/steer')).toHaveLength(0)
    notify('item/completed', { item })
    notify('item/completed', { item })
    await vi.waitFor(() => expect(requests.filter((r) => r.method === 'turn/steer')).toHaveLength(1))
    expect(requests.find((r) => r.method === 'turn/steer')?.params).toEqual({
      threadId: 't1', expectedTurnId: 'turn-1', clientUserMessageId: 'tcimg_1',
      input: [{ type: 'text', text: COMPUTER_PICTURES_TEXT }, ...paths.slice(0, MAX_IMAGE_PARTS).map((path) => ({ type: 'localImage', path }))]
    })
    const before = events.length
    for (const method of ['item/started', 'item/completed']) notify(method, { item: { type: 'userMessage', clientId: 'tcimg_1', content: [] } })
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(before)
    expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(0)
    expect(bridgeMcpConfig).toHaveBeenLastCalledWith('sess-1', { computerImages: 'none' })
    await handle.dispose()
  })

  it('records native image reads for the proof to audit', async () => {
    scripts.push(healthy)
    const handle = await codexDriver.start(ctx())
    for (const method of ['item/started', 'item/completed']) spawned[0].stdout.write(JSON.stringify({ method, params: { item: { type: 'imageView', id: 'v1', path: '/tmp/shot.png' } } }) + '\n')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'tool-result' && e.callId === 'v1')).toBe(true))
    expect(events.filter((e) => e.type === 'tool-call')).toContainEqual({ type: 'tool-call', callId: 'v1', name: 'view_image', input: { path: '/tmp/shot.png' } })
    await handle.dispose()
  })
})
