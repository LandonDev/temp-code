import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LARGE_BINDING, openDb, Store } from './db'
import type { SessionMeta } from '@shared/events'

/**
 * A cached StatementSync pins its last bound string until the next bind,
 * so a 2 MB workspace snapshot or a long payload stayed in memory for as
 * long as the app ran. Binds of LARGE_BINDING or more go through a
 * throwaway statement (stmtFor); everything else keeps the cached one.
 */

type Counts = { prepare: Record<string, number>; run: Record<string, number> }
let db: ReturnType<typeof openDb>
let store: Store
let counts: Counts

function counting(target: ReturnType<typeof openDb>): Counts {
  const c: Counts = { prepare: {}, run: {} }
  const prepare = target.prepare.bind(target)
  const key = (sql: string): string => sql.trim().split(/\s+/).slice(0, 3).join(' ')
  ;(target as { prepare: typeof target.prepare }).prepare = ((sql: string) => {
    c.prepare[key(sql)] = (c.prepare[key(sql)] ?? 0) + 1
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
  return c
}
const cacheSize = (): number => (store as unknown as { stmts: Map<string, unknown> }).stmts.size

beforeEach(() => {
  db = openDb(':memory:')
  counts = counting(db)
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string): SessionMeta =>
  ({
    id, parentId: null, projectId: null, workspaceId: null, threadType: null, planPath: null,
    provider: 'claude', model: 'm', reasoning: 'medium', agentType: 'implementer', title: id, cwd: '/tmp',
    status: 'idle', pinned: false, archived: false, fast: false, ultrafast: false, context1m: false,
    busySince: null, pausedAt: null, frozenActiveElapsed: null, threadRules: null, permission: 'edits',
    nativeId: null, createdAt: 1, updatedAt: 1
  }) as unknown as SessionMeta
const SETTING = 'INSERT INTO settings'
const EVENTS = 'INSERT INTO events'

describe('large bindings bypass the statement cache', () => {
  it('a large setting value prepares a throwaway and leaves the cache alone; a small one is cached and reused', () => {
    const before = cacheSize()
    const big = 'x'.repeat(LARGE_BINDING + 100)
    store.setSetting('snapshot', big)
    expect(counts.prepare[SETTING]).toBe(1)
    expect(cacheSize()).toBe(before)
    store.setSetting('snapshot', big)
    expect(counts.prepare[SETTING]).toBe(2)
    expect(cacheSize()).toBe(before)
    store.setSetting('snapshot', 'small')
    expect(counts.prepare[SETTING]).toBe(3)
    expect(cacheSize()).toBe(before + 1)
    store.setSetting('other', 'small too')
    expect(counts.prepare[SETTING]).toBe(3)
    expect(counts.run[SETTING]).toBe(4)
    expect(store.getSetting('snapshot')).toBe('small')
    expect(store.getSetting('other')).toBe('small too')
  })

  it('a value one short of the line is cached; at the line it is not', () => {
    const before = cacheSize()
    store.setSetting('a', 'x'.repeat(LARGE_BINDING - 1))
    expect(cacheSize()).toBe(before + 1)
    store.setSetting('b', 'x'.repeat(LARGE_BINDING))
    expect(cacheSize()).toBe(before + 1)
    expect(counts.prepare[SETTING]).toBe(2)
  })

  it('a large event payload lands through a throwaway statement and reads back whole', () => {
    store.insertSession(meta('a'))
    store.appendEvent('a', { type: 'user-text', text: 'small' })
    store.flushEvents()
    const cached = cacheSize()
    expect(counts.prepare[EVENTS]).toBe(1)
    const long = 'y'.repeat(LARGE_BINDING)
    store.appendEvent('a', { type: 'assistant-text', text: long, delta: false })
    store.appendEvent('a', { type: 'user-text', text: 'small again' })
    store.flushEvents()
    expect(counts.prepare[EVENTS]).toBe(2)
    expect(cacheSize()).toBe(cached)
    const rows = store.events('a')
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
    expect((rows[1].event as { text: string }).text).toBe(long)
    expect((rows[2].event as { text: string }).text).toBe('small again')
  })

  it('github inbox items over the line take the throwaway path too', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, title: 'z'.repeat(200) }))
    const before = cacheSize()
    store.putGithubInboxRepo({ repo: 'o/r', fetchedAt: 1, error: null, items: items as never })
    expect(JSON.stringify(items).length).toBeGreaterThanOrEqual(LARGE_BINDING)
    expect(cacheSize()).toBe(before)
    expect(store.listGithubInboxRepos()[0].items).toHaveLength(400)
  })
})
