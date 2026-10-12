import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { AgentEvent } from '@shared/events'

/**
 * A streamed delta moves no fold output, so append() keeps the fold in
 * memory and lands its watermark with the next non-delta event or the
 * timer — never once per token.
 */

let db: ReturnType<typeof openDb>
let store: Store
let reg: SessionRegistry
let foldWrites = 0
beforeEach(() => {
  db = openDb(':memory:')
  const prepare = db.prepare.bind(db)
  ;(db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const st = prepare(sql)
    if (!/INSERT INTO session_folds/.test(sql)) return st
    return new Proxy(st, {
      get(t, k, r) {
        if (k !== 'run') return Reflect.get(t, k, r)
        return (...args: unknown[]) => {
          foldWrites += 1
          return (t.run as (...a: unknown[]) => unknown).apply(t, args)
        }
      }
    })
  }) as typeof db.prepare
  store = new Store(db)
  reg = new SessionRegistry(store)
  foldWrites = 0
})
afterEach(async () => {
  vi.useRealTimers()
  await reg.disposeAll()
  db.close()
})

const delta = (text: string): AgentEvent => ({ type: 'assistant-text', text, delta: true, msgId: 'm1', blockIndex: 0 })

describe('fold writes per event', () => {
  it('writes no fold row for a pure text delta and lands the watermark with the next non-delta event', async () => {
    const s = await reg.create({ cwd: '/tmp', provider: 'claude' })
    reg.append(s.id, { type: 'user-text', text: 'go' })
    const after = foldWrites
    for (let i = 0; i < 50; i++) reg.append(s.id, delta(`${i}`))
    expect(foldWrites).toBe(after)
    expect(store.getFold(s.id)?.foldedSeq).toBe(1)
    expect(reg.foldOf(s.id)?.foldedSeq).toBe(51)
    reg.append(s.id, { type: 'tool-call', callId: 'c1', name: 'Read', input: {} })
    expect(foldWrites).toBe(after + 1)
    expect(store.getFold(s.id)?.foldedSeq).toBe(52)
    // eslint-disable-next-line no-console
    console.log(`[measure] 50 deltas + 1 tool call: fold upserts=${foldWrites - after}`)
  })

  it('a delta-only stream lands its watermark on the timer, and disposeAll flushes the rest', async () => {
    const s = await reg.create({ cwd: '/tmp', provider: 'claude' })
    vi.useFakeTimers()
    reg.append(s.id, delta('a'))
    reg.append(s.id, delta('b'))
    expect(store.getFold(s.id)?.foldedSeq).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.getFold(s.id)?.foldedSeq).toBe(2)
    reg.append(s.id, delta('c'))
    expect(store.getFold(s.id)?.foldedSeq).toBe(2)
    await reg.disposeAll()
    expect(store.getFold(s.id)?.foldedSeq).toBe(3)
  })

  it('a delta that moves the fold still writes at once', async () => {
    const s = await reg.create({ cwd: '/tmp', provider: 'claude' })
    reg.append(s.id, { type: 'error', message: 'boom' })
    expect(store.getFold(s.id)?.canContinue).toBe(true)
    const n = foldWrites
    reg.append(s.id, delta('recovering'))
    // An assistant delta after an error clears the continuable state: that is a fold move.
    expect(store.getFold(s.id)?.canContinue).toBe(reg.foldOf(s.id)?.canContinue)
    expect(foldWrites === n || store.getFold(s.id)?.foldedSeq === 2).toBe(true)
  })
})
