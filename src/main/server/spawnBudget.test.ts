import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The budget's slots and registry over a fake `spawn`: with no spawner
 * installed the exec broker runs in this process (execBroker.ts), so every
 * budgeted helper reaches node's `spawn` through execBrokerChild.ts, and
 * that is what the mock stands in for.
 */

const mocks = vi.hoisted(() => ({
  spawn: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

let nextPid = 1000
class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  killed = false
  killedWith: string | null = null
  pid = nextPid++
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), { written: [] as string[], ended: false, write(chunk: Buffer) { this.written.push(chunk.toString()) }, end() { this.ended = true } })
  kill(signal: string): boolean {
    if (this.exitCode !== null) return false
    this.killed = true
    this.killedWith = signal
    return true
  }
  exit(code = 0, signal: string | null = null): void {
    this.exitCode = code
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

let budget: typeof import('./spawnBudget')
let pending: { file: string; args: string[]; options: Record<string, unknown>; child: FakeChild }[]

beforeEach(async () => {
  vi.resetModules()
  pending = []
  mocks.spawn.mockReset().mockImplementation((file: string, args: string[], options: Record<string, unknown>) => {
    const child = new FakeChild()
    pending.push({ file, args, options, child })
    return child
  })
  budget = await import('./spawnBudget')
})

afterEach(() => {
  budget.killTrackedChildren()
  vi.useRealTimers()
})

const tick = () => new Promise((r) => setTimeout(r, 0))
const finish = (index: number, stdout = 'ok', code = 0, stderr = ''): void => {
  const entry = pending[index]
  if (stdout) entry.child.stdout.emit('data', Buffer.from(stdout))
  if (stderr) entry.child.stderr.emit('data', Buffer.from(stderr))
  entry.child.exit(code)
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
    expect(mocks.spawn).toHaveBeenCalledTimes(4)
    expect(budget.childBudget.waiting).toBe(1)
    finish(0)
    await tick()
    expect(mocks.spawn).toHaveBeenCalledTimes(5)
    expect(pending[4].args).toEqual(['-C', '5', 'status'])
    for (let i = 1; i < 5; i += 1) finish(i)
    const results = await Promise.all(runs)
    expect(results.map((r) => r.stdout)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(budget.childBudget.running).toBe(0)
  })

  it('gives every process a timeout, stdin at EOF and utf8 output unless told otherwise, never detached', async () => {
    vi.useFakeTimers()
    const first = budget.execFileBudgeted('git', ['log'], { detached: true, maxBuffer: 5 } as never)
    const second = budget.execFileBudgeted('git', ['show'], { timeout: 5, encoding: 'buffer' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pending[0].options).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] })
    expect(pending[0].options).not.toHaveProperty('detached')
    // The default timeout: the first child is killed at DEFAULT_TIMEOUT_MS, the second at its own 5 ms.
    vi.advanceTimersByTime(6)
    expect(pending[1].child.killedWith).toBe('SIGTERM')
    expect(pending[0].child.killedWith).toBeNull()
    vi.advanceTimersByTime(budget.DEFAULT_TIMEOUT_MS)
    expect(pending[0].child.killedWith).toBe('SIGTERM')
    pending[0].child.exit(null as never, 'SIGTERM')
    pending[1].child.stdout.emit('data', Buffer.from('raw'))
    pending[1].child.exit(null as never, 'SIGTERM')
    await expect(first).rejects.toMatchObject({ killed: true, signal: 'SIGTERM' })
    await expect(second).rejects.toMatchObject({ stdout: Buffer.from('raw') })
    // maxBuffer: output past it kills the child and names the stream.
    const third = budget.execFileBudgeted('git', ['big'], { maxBuffer: 5 })
    await vi.advanceTimersByTimeAsync(0)
    pending[2].child.stdout.emit('data', Buffer.from('0123456789'))
    expect(pending[2].child.killedWith).toBe('SIGTERM')
    pending[2].child.exit(null as never, 'SIGTERM')
    await expect(third).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '01234' })
  })

  it('rejects like promisify(execFile): the error carries the code, stdout and stderr', async () => {
    const run = budget.execFileBudgeted('git', ['bad'])
    await tick()
    finish(0, 'out', 1, 'err')
    await expect(run).rejects.toMatchObject({ code: 1, stdout: 'out', stderr: 'err', cmd: 'git bad' })
  })

  it('execFileOffBudget takes no slot', async () => {
    const lane = new budget.ChildBudget(1)
    void budget.withBudget(lane, () => budget.execFileBudgeted('git', ['a']))
    await tick()
    const ps = budget.execFileOffBudget('ps', ['-A'])
    expect(pending.map((p) => p.file)).toEqual(['git', 'ps'])
    expect(lane.running).toBe(1)
    expect(budget.childBudget.running).toBe(0)
    finish(1, 'rows')
    expect((await ps).stdout).toBe('rows')
    finish(0)
  })

  it('execFileChildBudgeted hands back a child whose stdin reaches the process', async () => {
    const result = new Promise<string>((resolve, reject) => {
      void budget.execFileChildBudgeted('git', ['apply'], { encoding: 'buffer' }, (error, stdout) => (error ? reject(error) : resolve(stdout.toString()))).then((child) => {
        child.stdin!.end('patch')
      })
    })
    await tick()
    expect(pending[0].options).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] })
    await tick()
    expect(pending[0].child.stdin.written).toEqual(['patch'])
    expect(pending[0].child.stdin.ended).toBe(true)
    finish(0, 'applied')
    expect(await result).toBe('applied')
  })
})

describe('withBudget', () => {
  it('routes every budgeted child inside the scope to the given budget, however deep', async () => {
    const lane = new budget.ChildBudget(1)
    const deep = () => budget.execFileBudgeted('git', ['status'])
    const inLane = budget.withBudget(lane, async () => Promise.all([deep(), deep()]))
    const outside = budget.execFileBudgeted('git', ['log'])
    await tick()
    // the lane holds one; the second waits on it, not on the shared budget
    expect(lane.running).toBe(1)
    expect(lane.waiting).toBe(1)
    expect(budget.childBudget.running).toBe(1)
    expect(pending.map((p) => p.args[0])).toEqual(['status', 'log'])
    finish(0)
    await tick()
    expect(pending).toHaveLength(3)
    finish(1)
    finish(2)
    await Promise.all([inLane, outside])
    expect(lane.running).toBe(0)
    expect(budget.currentBudget()).toBe(budget.childBudget)
  })

  it('the status lane is its own budget', () => {
    expect(budget.statusBudget).not.toBe(budget.childBudget)
    expect(budget.statusBudget).not.toBe(budget.oneShotBudget)
  })
})

describe('the child registry', () => {
  it('kills every live helper on demand and forgets the ones that exited', async () => {
    void budget.execFileBudgeted('git', ['a'])
    void budget.execFileBudgeted('git', ['b'])
    const long = budget.spawnTracked('java', ['-jar', 'x'])
    await tick()
    expect(budget.trackedChildren()).toBe(3)
    const git = pending.filter((p) => p.file === 'git')
    expect(git).toHaveLength(2)
    git[0].child.exit(0)
    expect(budget.trackedChildren()).toBe(2)
    expect(budget.killTrackedChildren()).toBe(2)
    expect(git[1].child.killedWith).toBe('SIGKILL')
    expect((long as unknown as FakeChild).killedWith).toBe('SIGKILL')
    expect(budget.trackedChildren()).toBe(0)
  })

  it('spawnBudgeted holds a slot until exit, streams the output and strips detached', async () => {
    const b = budget.childBudget
    const child = await budget.spawnBudgeted('git', ['fetch'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(pending[0].options).not.toHaveProperty('detached')
    expect(pending[0].options).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] })
    expect(child.pid).toBe(pending[0].child.pid)
    const lines: string[] = []
    child.stderr!.on('data', (c: Buffer) => lines.push(c.toString()))
    pending[0].child.stderr.emit('data', Buffer.from('Receiving objects: 50%'))
    expect(b.running).toBe(1)
    pending[0].child.exit(0)
    expect(b.running).toBe(0)
    expect(budget.trackedChildren()).toBe(0)
    await tick()
    expect(lines).toEqual(['Receiving objects: 50%'])
  })
})
