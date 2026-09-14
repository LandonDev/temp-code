import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, spawn: mocks.spawn }))

type Callback = (error: Error | null, stdout: string, stderr: string) => void

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  killed: string | null = null
  pid = 1
  kill(signal: string): boolean {
    if (this.exitCode !== null) return false
    this.killed = signal
    return true
  }
  exit(code = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

let budget: typeof import('./spawnBudget')
let pending: { args: string[]; child: FakeChild; callback: Callback }[]

beforeEach(async () => {
  vi.resetModules()
  pending = []
  mocks.execFile.mockReset().mockImplementation((_file: string, args: string[], _opts: unknown, callback: Callback) => {
    const child = new FakeChild()
    pending.push({ args, child, callback })
    return child
  })
  mocks.spawn.mockReset().mockImplementation(() => new FakeChild())
  budget = await import('./spawnBudget')
})

afterEach(() => {
  budget.killTrackedChildren()
})

const tick = () => new Promise((r) => setTimeout(r, 0))
const finish = (index: number, stdout = 'ok'): void => {
  const entry = pending[index]
  entry.child.exit(0)
  entry.callback(null, stdout, '')
}

describe('ChildBudget', () => {
  it('runs at most `concurrency` jobs and starts the rest as slots free up', async () => {
    const b = new budget.ChildBudget(2)
    const order: string[] = []
    let releaseA!: () => void
    let releaseB!: () => void
    const a = b.run(() => new Promise<void>((r) => { order.push('a'); releaseA = r }))
    const bb = b.run(() => new Promise<void>((r) => { order.push('b'); releaseB = r }))
    const c = b.run(async () => { order.push('c') })
    await tick()
    expect(order).toEqual(['a', 'b'])
    expect(b.running).toBe(2)
    expect(b.waiting).toBe(1)
    releaseA()
    await tick()
    expect(order).toEqual(['a', 'b', 'c'])
    releaseB()
    await Promise.all([a, bb, c])
    expect(b.running).toBe(0)
  })

  it('frees the slot when the work throws', async () => {
    const b = new budget.ChildBudget(1)
    await expect(b.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(b.running).toBe(0)
    await expect(b.run(async () => 1)).resolves.toBe(1)
  })

  it('ignores a double release', async () => {
    const b = new budget.ChildBudget(1)
    const release = await b.acquire()
    release()
    release()
    expect(b.running).toBe(0)
  })
})

describe('execFileBudgeted', () => {
  it('queues the fifth process behind four running ones', async () => {
    const runs = ['1', '2', '3', '4', '5'].map((n) => budget.execFileBudgeted('git', ['-C', n, 'status']))
    await tick()
    expect(mocks.execFile).toHaveBeenCalledTimes(4)
    expect(budget.childBudget.waiting).toBe(1)
    finish(0)
    await tick()
    expect(mocks.execFile).toHaveBeenCalledTimes(5)
    expect(pending[4].args).toEqual(['-C', '5', 'status'])
    for (let i = 1; i < 5; i += 1) finish(i)
    const results = await Promise.all(runs)
    expect(results.map((r) => r.stdout)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(budget.childBudget.running).toBe(0)
  })

  it('gives every process a timeout and utf8 output unless told otherwise, never detached', async () => {
    void budget.execFileBudgeted('git', ['log'], { detached: true, maxBuffer: 5 } as never)
    void budget.execFileBudgeted('git', ['show'], { timeout: 5, encoding: 'buffer' })
    await tick()
    const first = mocks.execFile.mock.calls[0][2] as Record<string, unknown>
    const second = mocks.execFile.mock.calls[1][2] as Record<string, unknown>
    expect(first).toMatchObject({ timeout: budget.DEFAULT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 5 })
    expect(first).not.toHaveProperty('detached')
    expect(second).toMatchObject({ timeout: 5, encoding: 'buffer' })
  })

  it('rejects like promisify(execFile): the error carries stdout and stderr', async () => {
    const run = budget.execFileBudgeted('git', ['bad'])
    await tick()
    pending[0].child.exit(1)
    pending[0].callback(Object.assign(new Error('failed'), { code: 1 }), 'out', 'err')
    await expect(run).rejects.toMatchObject({ code: 1, stdout: 'out', stderr: 'err' })
  })
})

describe('the child registry', () => {
  it('kills every live helper on demand and forgets the ones that exited', async () => {
    void budget.execFileBudgeted('git', ['a'])
    void budget.execFileBudgeted('git', ['b'])
    const long = budget.spawnTracked('java', ['-jar', 'x'])
    await tick()
    expect(budget.trackedChildren()).toBe(3)
    finish(0)
    expect(budget.trackedChildren()).toBe(2)
    expect(budget.killTrackedChildren()).toBe(2)
    expect(pending[1].child.killed).toBe('SIGKILL')
    expect((long as unknown as FakeChild).killed).toBe('SIGKILL')
    expect(budget.trackedChildren()).toBe(0)
  })

  it('spawnBudgeted holds a slot until exit and strips detached', async () => {
    const b = budget.childBudget
    const child = (await budget.spawnBudgeted('git', ['fetch'], { detached: true })) as unknown as FakeChild
    expect(mocks.spawn.mock.calls[0][2]).not.toHaveProperty('detached')
    expect(b.running).toBe(1)
    child.exit(0)
    expect(b.running).toBe(0)
    expect(budget.trackedChildren()).toBe(0)
  })
})
