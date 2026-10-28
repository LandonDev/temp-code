import { describe, expect, it } from 'vitest'
import { emptyBundle } from '@shared/aliaxStats'
import { StatsHost, type WorkerLike } from './statsHost'
import type { StatsReply, StatsRequest } from './statsWire'

/** A fake worker: every request posted lands in `posted`; the test answers through `reply`. */
class FakeWorker implements WorkerLike {
  readonly posted: StatsRequest[] = []
  private readonly listeners = new Map<string, ((arg: never) => void)[]>()
  terminated = 0
  /** Answer a bundle ask at once (false: hold it for the test). */
  auto = true
  generated = 0
  postMessage(message: unknown): void {
    const request = message as StatsRequest
    this.posted.push(request)
    if (request.type === 'bundle' && this.auto) this.reply({ type: 'bundle', id: request.id, bundle: { ...emptyBundle(), generatedAt: ++this.generated } })
    if (request.type === 'index' || request.type === 'reindex') this.reply({ type: 'index', id: request.id, progress: { running: false, filesDone: 2, filesTotal: 2, rows: 9 } })
  }
  on(event: string, listener: (arg: never) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  emit(event: 'message' | 'error' | 'exit', arg: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(arg as never)
  }
  reply(message: StatsReply): void {
    queueMicrotask(() => this.emit('message', message))
  }
  async terminate(): Promise<void> {
    this.terminated++
  }
}

function rig() {
  const workers: FakeWorker[] = []
  const logs: string[] = []
  const host = new StatsHost({
    spawn: () => {
      const w = new FakeWorker()
      workers.push(w)
      w.reply({ type: 'ready' })
      return w
    },
    log: (line) => logs.push(line)
  })
  return { host, workers, logs, worker: () => workers.at(-1)! }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('StatsHost', () => {
  it('asks the worker for the bundle once at a time: callers meanwhile share the ask, and the next ask is fresh', async () => {
    const r = rig()
    r.worker().auto = false
    const first = r.host.bundle()
    const second = r.host.bundle()
    expect(r.worker().posted.filter((m) => m.type === 'bundle')).toHaveLength(1)
    const id = (r.worker().posted[0] as { id: number }).id
    r.worker().reply({ type: 'bundle', id, bundle: { ...emptyBundle(), generatedAt: 7 } })
    expect(await first).toMatchObject({ generatedAt: 7 })
    expect(await second).toBe(await first)
    r.worker().auto = true
    expect(await r.host.bundle()).toMatchObject({ generatedAt: 1 })
    expect(r.worker().posted.filter((m) => m.type === 'bundle')).toHaveLength(2)
  })

  it('mirrors the index progress, and an index ask answers the final count', async () => {
    const r = rig()
    await tick()
    expect(r.host.status()).toEqual({ ready: true, restarts: 0, unavailable: null })
    r.worker().emit('message', { type: 'progress', progress: { running: true, filesDone: 1, filesTotal: 2, rows: 4 } })
    expect(r.host.progress()).toEqual({ running: true, filesDone: 1, filesTotal: 2, rows: 4 })
    expect(await r.host.index()).toEqual({ running: false, filesDone: 2, filesTotal: 2, rows: 9 })
    expect(r.host.progress().running).toBe(false)
  })

  it('forwards a sample and an app event without waiting', () => {
    const r = rig()
    r.host.sample('codex', 'acct', '5h', 42, 1_000, 5_000)
    r.host.appEvent('switch', 'claude-code', 'acct', 'why')
    expect(r.worker().posted).toEqual([
      { type: 'sample', service: 'codex', account: 'acct', label: '5h', usedPercent: 42, resetsAt: 1_000, periodMs: 5_000 },
      { type: 'appEvent', kind: 'switch', service: 'claude-code', account: 'acct', detail: 'why' }
    ])
  })

  it('a worker that dies is started again once, its waiters told; a second death leaves Stats unavailable with the last bundle', async () => {
    const r = rig()
    expect(await r.host.bundle()).toMatchObject({ generatedAt: 1 })
    r.worker().auto = false
    const held = r.host.bundle()
    r.worker().emit('exit', 1)
    expect(r.workers).toHaveLength(2)
    expect(r.host.status()).toMatchObject({ restarts: 1, unavailable: null })
    // The ask the death cut answers the last bundle, marked.
    expect(await held).toMatchObject({ generatedAt: 1, unavailable: 'exited (1)' })
    expect(await r.host.bundle()).toMatchObject({ generatedAt: 1 })
    expect((await r.host.bundle()).unavailable).toBeUndefined()
    r.worker().emit('error', new Error('boom'))
    expect(r.workers).toHaveLength(2)
    expect(r.host.status()).toMatchObject({ restarts: 1, unavailable: 'crashed: boom' })
    // The last bundle the worker gave, not the first.
    expect(await r.host.bundle()).toMatchObject({ generatedAt: 2, unavailable: 'crashed: boom' })
    await expect(r.host.index()).rejects.toThrow('crashed: boom')
    expect(r.logs.some((l) => l.includes('starting it again'))).toBe(true)
    expect(r.logs.some((l) => l.includes('reads unavailable'))).toBe(true)
  })

  it("a crash emits error and then exit: the old worker's exit never puts its replacement down", async () => {
    const r = rig()
    const first = r.worker()
    first.emit('error', new Error('boom'))
    expect(r.workers).toHaveLength(2)
    first.emit('exit', 1)
    expect(r.workers).toHaveLength(2)
    expect(r.host.status()).toMatchObject({ restarts: 1, unavailable: null })
    expect(await r.host.bundle()).toMatchObject({ generatedAt: 1 })
    expect((await r.host.bundle()).unavailable).toBeUndefined()
    // A late message from the dead worker is ignored too.
    first.emit('message', { type: 'progress', progress: { running: true, filesDone: 9, filesTotal: 9, rows: 1 } })
    expect(r.host.progress().filesDone).not.toBe(9)
  })

  it('a worker that never gave a bundle leaves an empty one saying why; stop ends the worker without a restart', async () => {
    const r = rig()
    r.worker().emit('exit', 0)
    r.worker().emit('exit', 0)
    expect(await r.host.bundle()).toEqual({ ...emptyBundle(), unavailable: 'exited (0)' })
    const fresh = rig()
    await fresh.host.stop()
    expect(fresh.worker().terminated).toBe(1)
    fresh.worker().emit('exit', 0)
    expect(fresh.workers).toHaveLength(1)
  })
})
