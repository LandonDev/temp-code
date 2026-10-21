import { describe, expect, it } from 'vitest'
import { GateQueue, type GateWait } from './gateQueue'

const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('GateQueue', () => {
  it('runs one at a time in order', async () => {
    const q = new GateQueue()
    const order: string[] = []
    const a = deferred<void>()
    const b = deferred<void>()
    const ra = q.run('a', async () => {
      order.push('a:start')
      await a.promise
      order.push('a:end')
      return 'A'
    })
    const rb = q.run('b', async () => {
      order.push('b:start')
      await b.promise
      order.push('b:end')
      return 'B'
    })
    await tick()
    expect(order).toEqual(['a:start'])
    expect(q.labels).toEqual(['a', 'b'])
    a.resolve()
    await tick()
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
    b.resolve()
    expect(await ra).toBe('A')
    expect(await rb).toBe('B')
    expect(q.busy).toBe(false)
    expect(q.labels).toEqual([])
  })

  it('tells a waiter its position and who is ahead, and again as the line moves', async () => {
    const q = new GateQueue()
    const a = deferred<void>()
    const b = deferred<void>()
    const waits: GateWait[] = []
    const first: GateWait[] = []
    void q.run('a', () => a.promise, (w) => first.push(w))
    void q.run('b', () => b.promise)
    const rc = q.run('c', async () => 'C', (w) => waits.push(w))
    expect(first).toEqual([])
    expect(waits).toEqual([{ position: 2, ahead: ['a', 'b'] }])
    a.resolve()
    await tick()
    expect(waits.at(-1)).toEqual({ position: 1, ahead: ['b'] })
    b.resolve()
    expect(await rc).toBe('C')
  })

  it('a failure answers its caller and the next run still goes', async () => {
    const q = new GateQueue()
    const ra = q.run('a', async () => {
      throw new Error('red')
    })
    const rb = q.run('b', async () => 'B')
    await expect(ra).rejects.toThrow('red')
    expect(await rb).toBe('B')
    expect(q.busy).toBe(false)
  })
})
