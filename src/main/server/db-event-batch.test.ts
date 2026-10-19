import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import type { AgentEvent, SessionMeta } from '@shared/events'

/**
 * appendEvent hands out seqs from memory and lands the tick's rows in one
 * transaction; every reader flushes first. These pin: seq continuity across
 * a fresh Store (a relaunch) and after a delete, the flush order, that a
 * read mid-tick sees every row, and that a delta stream replays as before.
 */

type Counts = { run: Record<string, number>; exec: string[] }
let db: ReturnType<typeof openDb>
let store: Store
let counts: Counts

function counting(target: ReturnType<typeof openDb>): Counts {
  const c: Counts = { run: {}, exec: [] }
  const prepare = target.prepare.bind(target)
  const exec = target.exec.bind(target)
  const key = (sql: string): string => sql.trim().split(/\s+/).slice(0, 3).join(' ')
  ;(target as { prepare: typeof target.prepare }).prepare = ((sql: string) => {
    const st = prepare(sql)
    return new Proxy(st, {
      get(t, k, r) {
        if (k === 'run' || k === 'get' || k === 'all') {
          return (...args: unknown[]) => {
            c.run[key(sql)] = (c.run[key(sql)] ?? 0) + 1
            return (t[k] as (...a: unknown[]) => unknown).apply(t, args)
          }
        }
        return Reflect.get(t, k, r)
      }
    })
  }) as typeof target.prepare
  ;(target as { exec: typeof target.exec }).exec = ((sql: string) => {
    c.exec.push(sql.trim())
    return exec(sql)
  }) as typeof target.exec
  return c
}

beforeEach(() => {
  db = openDb(':memory:')
  counts = counting(db)
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string): SessionMeta => ({
  id, parentId: null, projectId: null, workspaceId: null, threadType: null, planPath: null,
  provider: 'claude', model: 'm', reasoning: 'medium', agentType: 'implementer', title: id, cwd: '/tmp',
  status: 'idle', pinned: false, archived: false, fast: false, ultrafast: false, context1m: false,
  busySince: null, pausedAt: null, frozenActiveElapsed: null, threadRules: null, permission: 'edits',
  nativeId: null, createdAt: 1, updatedAt: 1
})
const delta = (text: string): AgentEvent => ({ type: 'assistant-text', text, delta: true, msgId: 'm1', blockIndex: 0 })
const MAX_KEY = 'SELECT COALESCE(MAX(seq), 0)'
const tick = (): Promise<void> => new Promise((r) => setImmediate(() => setImmediate(r)))

describe('batched event log', () => {
  it('assigns consecutive seqs in memory, lands them in one transaction, and a read mid-tick sees them all', async () => {
    store.insertSession(meta('a'))
    const before = { ...counts.run }
    const rows = [store.appendEvent('a', { type: 'user-text', text: 'go' }), store.appendEvent('a', delta('x')), store.appendEvent('a', delta('y'))]
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
    // Nothing touched the table yet apart from the one seed read.
    expect((counts.run['INSERT INTO events'] ?? 0) - (before['INSERT INTO events'] ?? 0)).toBe(0)
    expect((counts.run[MAX_KEY] ?? 0) - (before[MAX_KEY] ?? 0)).toBe(1)
    // A reader in the same tick still sees every row, in order.
    expect(store.eventsAfter('a', 0).map((r) => [r.seq, r.event.type])).toEqual([[1, 'user-text'], [2, 'assistant-text'], [3, 'assistant-text']])
    expect(counts.exec.filter((s) => s === 'BEGIN')).toHaveLength(1)
    expect(counts.exec.filter((s) => s === 'COMMIT')).toHaveLength(1)
    expect(counts.run['INSERT INTO events']).toBe(3)
    await tick()
    // The scheduled flush found nothing left to do.
    expect(counts.exec.filter((s) => s === 'BEGIN')).toHaveLength(1)
  })

  it('one hundred deltas in a tick are one transaction and one seq read', async () => {
    store.insertSession(meta('a'))
    const base = { ...counts.run }
    for (let i = 0; i < 100; i++) store.appendEvent('a', delta(`${i}`))
    await tick()
    expect(counts.exec.filter((s) => s === 'BEGIN')).toHaveLength(1)
    expect(counts.run['INSERT INTO events']).toBe(100)
    expect((counts.run[MAX_KEY] ?? 0) - (base[MAX_KEY] ?? 0)).toBe(1)
    expect(store.eventsAfter('a', 99)).toHaveLength(1)
    // eslint-disable-next-line no-console
    console.log(`[measure] 100 deltas: statements=${counts.run['INSERT INTO events']} inserts + 1 MAX read, transactions=${counts.exec.filter((s) => s === 'BEGIN').length}, fold writes=${counts.run['INSERT INTO session_folds'] ?? 0}`)
  })

  it('seqs continue across a fresh Store and after a delete, and the flush survives a relaunch', async () => {
    store.insertSession(meta('a'))
    store.appendEvent('a', { type: 'user-text', text: 'one' })
    store.appendEvent('a', { type: 'user-text', text: 'two' })
    store.flushEvents()
    const again = new Store(db)
    expect(again.appendEvent('a', { type: 'user-text', text: 'three' }).seq).toBe(3)
    expect(again.eventsAfter('a', 0).map((r) => r.seq)).toEqual([1, 2, 3])
    // The first Store's counter is stale now (3 was taken by the second): a conflict re-seeds it.
    const dup = store.appendEvent('a', { type: 'user-text', text: 'four' })
    expect(dup.seq).toBe(3)
    expect(store.eventsAfter('a', 0).map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect(store.appendEvent('a', { type: 'user-text', text: 'five' }).seq).toBe(5)
    store.deleteSessionTree('a')
    store.insertSession(meta('a'))
    expect(store.appendEvent('a', { type: 'user-text', text: 'fresh' }).seq).toBe(1)
    expect(store.eventsAfter('a', 0).map((r) => [r.seq, (r.event as { text: string }).text])).toEqual([[1, 'fresh']])
  })

  it('a delta stream followed by the full block replays exactly as before', async () => {
    store.insertSession(meta('a'))
    const events: AgentEvent[] = [
      { type: 'user-text', text: 'go' },
      delta('hel'), delta('lo'),
      { type: 'assistant-text', text: 'hello', delta: false, msgId: 'm1', blockIndex: 0 },
      { type: 'turn-complete', costUsd: 0.01 }
    ]
    for (const e of events) store.appendEvent('a', e)
    expect(store.events('a').map((r) => r.event)).toEqual(events)
    expect(store.events('a', { tail: 1 }).map((r) => r.seq)).toEqual([2, 3, 4, 5])
    expect(store.hasUserText('a')).toBe(true)
    expect(store.maxSeqs().get('a')).toBe(5)
    expect((await store.searchEvents({ query: 'hello' })).hits.map((h) => h.seq)).toEqual([4])
  })
})
