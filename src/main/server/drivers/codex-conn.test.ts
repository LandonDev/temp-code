import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  kill = vi.fn()
}
const spawned: FakeProc[] = []
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    const proc = new FakeProc()
    spawned.push(proc)
    return proc
  }
}))
const { AppServerConn, AppServerExit, AppServerTimeout } = await import('./codex')

beforeEach(() => {
  spawned.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  for (const proc of spawned) proc.emit('exit', 0)
  vi.useRealTimers()
})
const connect = () => new AppServerConn('/fake/codex', {}, '/tmp', () => {}, () => {}, () => {})
const reply = (id: number, result: unknown = {}) => spawned[0].stdout.write(JSON.stringify({ id, result }) + '\n')

describe('AppServerConn deadlines', () => {
  it('every RPC except turn/start expires after 30 s and releases its pending entry', async () => {
    const conn = connect()
    const request = conn.request('initialize', {})
    const failed = expect(request).rejects.toMatchObject({ name: 'AppServerTimeout', method: 'initialize', timeoutMs: 30_000 })
    await vi.advanceTimersByTimeAsync(29_999)
    expect((Reflect.get(conn, 'pending') as Map<number, unknown>).size).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect((Reflect.get(conn, 'pending') as Map<number, unknown>).size).toBe(0)
    reply(1, 'late')
    const next = conn.request('thread/start', {})
    reply(2, 'new')
    expect(await next).toBe('new')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('turn/start gets 60 s, with a caller override for a shorter deadline', async () => {
    const conn = connect()
    const request = conn.request('turn/start', {})
    const failed = expect(request).rejects.toMatchObject({ method: 'turn/start', timeoutMs: 60_000 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect((Reflect.get(conn, 'pending') as Map<number, unknown>).size).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await failed
    const shorter = conn.request('turn/start', {}, { timeoutMs: 5 })
    const failedShorter = expect(shorter).rejects.toBeInstanceOf(AppServerTimeout)
    await vi.advanceTimersByTimeAsync(5)
    await failedShorter
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replies and process exits clear their timers; requests after exit fail at once', async () => {
    const conn = connect()
    const completed = conn.request('thread/start')
    reply(1, { thread: { id: 't' } })
    expect(await completed).toEqual({ thread: { id: 't' } })
    const refused = conn.request('thread/start')
    spawned[0].stdout.write(JSON.stringify({ id: 2, error: { message: 'bad thread' } }) + '\n')
    await expect(refused).rejects.toThrow('bad thread')
    const pending = conn.request('turn/start')
    spawned[0].emit('exit', 1)
    await expect(pending).rejects.toBeInstanceOf(AppServerExit)
    await expect(conn.request('turn/start')).rejects.toBeInstanceOf(AppServerExit)
    expect(vi.getTimerCount()).toBe(0)
  })
})
