import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { failureKindOf } from '../failureKind'
import type { DriverCtx } from './types'

/**
 * Driver boot over a fake `codex app-server` process: each spawn hands the
 * test a script that answers (or kills the process on) every JSON-RPC
 * request the driver writes. Covers the stderr tail in the handshake error
 * and the boot retry.
 */

type Frame = { id?: number; method?: string; params?: Record<string, unknown> }
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
vi.mock('../apptools', () => ({ bridgeMcpConfig: () => null }))
vi.mock('../gatewayObserve', () => ({ observeCodexSnapshot: () => undefined }))

const { codexDriver, codexWarm, bootOptions, setCodexBootFailureLog, withoutImageBytes } = await import('./codex')

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
    // The next turn logs again.
    notify('error', retry(1))
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Reconnecting'))).toHaveLength(2)
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    log.mockRestore()
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
