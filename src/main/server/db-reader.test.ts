import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { EventReader } from './dbWorkers'
import type { SessionMeta } from '@shared/events'

/**
 * The reader worker (dbWorkers.ts) answers session search on a read-only
 * connection of its own. These pin: the reader's hits are the writer's
 * hits (hot, cold, workspace filter, cap), a row appended this tick is
 * found, the connection refuses writes, a reader that cannot start or
 * that ends leaves search on the writer, and stop() resolves.
 */

let root: string
let path: string
let db: ReturnType<typeof openDb>
const readers: EventReader[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-reader-'))
  path = join(root, 'test.db')
  db = openDb(path)
})
afterEach(async () => {
  for (const r of readers.splice(0)) await r.stop()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const start = async (file = path): Promise<EventReader> => {
  const r = new EventReader(file, { log: () => {} })
  readers.push(r)
  await r.ready
  return r
}
const meta = (id: string, workspaceId: string, archived = false): SessionMeta =>
  ({
    id, parentId: null, projectId: null, workspaceId, threadType: 'chat', planPath: null,
    provider: 'claude', model: 'm', reasoning: 'medium', agentType: 'implementer', title: id, cwd: '/tmp',
    status: 'idle', pinned: false, archived, fast: false, ultrafast: false, context1m: false,
    busySince: null, pausedAt: null, frozenActiveElapsed: null, threadRules: null, permission: 'edits',
    nativeId: null, createdAt: 1, updatedAt: 1
  }) as unknown as SessionMeta
const seed = (store: Store): void => {
  store.insertSession(meta('a', 'w1'))
  store.insertSession(meta('b', 'w2'))
  store.insertSession(meta('c', 'w1', true))
  store.appendEvent('a', { type: 'user-text', text: 'Please rename the Zebra widget' })
  store.appendEvent('a', { type: 'assistant-text', text: 'Zeb', delta: true })
  store.appendEvent('a', { type: 'assistant-text', text: `${'lead '.repeat(30)}the zebra widget is renamed${' tail'.repeat(40)}`, delta: false })
  store.appendEvent('a', { type: 'assistant-text', text: 'nested zebra', delta: false, parentCallId: 'call-1' })
  store.appendEvent('b', { type: 'user-text', text: 'nothing here' })
  store.appendEvent('b', { type: 'assistant-text', text: 'ZEBRA in another workspace', delta: false })
  for (let i = 0; i < 6; i++) store.appendEvent('c', { type: 'user-text', text: `archived zebra ${i}` })
  store.moveToCold('c')
}

describe('reader worker', () => {
  it('answers the same hits as the writer: hot, cold, workspace filter and the cap', async () => {
    const reader = await start()
    expect(reader.available).toBe(true)
    const viaReader = new Store(db, { reader })
    const viaWriter = new Store(db)
    seed(viaReader)
    for (const options of [
      { query: 'zebra' },
      { query: 'zebra', archived: true },
      { query: 'zebra', workspaceId: 'w2' },
      { query: 'zebra', workspaceId: 'w1', archived: true },
      { query: 'zebra', archived: true, limit: 4 }
    ]) {
      const a = await viaReader.searchEvents(options)
      const b = await viaWriter.searchEvents(options)
      expect(a).toEqual(b)
      expect(a.hits.length).toBeGreaterThan(0)
    }
    const all = await viaReader.searchEvents({ query: 'zebra', archived: true })
    expect(all.hits.map((h) => `${h.sessionId}:${h.seq}`).sort()).toEqual(['a:1', 'a:3', 'b:2', 'c:1', 'c:2', 'c:3', 'c:4', 'c:5', 'c:6'])
    expect(all.hits.find((h) => h.sessionId === 'a' && h.seq === 1)?.snippet).toBe('Please rename the Zebra widget')
    const long = all.hits.find((h) => h.sessionId === 'a' && h.seq === 3)!.snippet
    expect(long).toContain('the zebra widget is renamed')
    expect(long.length).toBeLessThanOrEqual(180)
    const capped = await viaReader.searchEvents({ query: 'zebra', archived: true, limit: 4 })
    expect(capped.hits).toHaveLength(4)
    expect(capped.truncated).toBe(true)
    expect((await viaReader.searchEvents({ query: 'zebra' })).hits.map((h) => h.sessionId)).not.toContain('c')
  })

  it('finds a row appended in the same tick: the pending rows land before the reader looks', async () => {
    const reader = await start()
    const store = new Store(db, { reader })
    store.insertSession(meta('a', 'w1'))
    store.appendEvent('a', { type: 'user-text', text: 'fresh needle' })
    const hits = (await store.searchEvents({ query: 'needle' })).hits
    expect(hits.map((h) => h.seq)).toEqual([1])
  })

  it('refuses a write through its read-only connection', async () => {
    const reader = await start()
    await expect(reader.query(`INSERT INTO settings (key, value) VALUES ('k', 'v')`, [])).rejects.toThrow(/readonly/)
    expect(reader.available).toBe(true)
    expect(await reader.query<{ n: number }>('SELECT count(*) AS n FROM settings', [])).toEqual([{ n: 0 }])
  })

  it('a reader that cannot open its file is unavailable and search stays on the writer', async () => {
    const reader = await start(join(root, 'missing', 'nested.db'))
    expect(reader.available).toBe(false)
    const store = new Store(db, { reader })
    seed(store)
    expect((await store.searchEvents({ query: 'zebra' })).hits).toHaveLength(3)
    await expect(reader.query('SELECT 1', [])).rejects.toThrow(/not available/)
  })

  it('a reader stopped under a query rejects that query; the Store answers from the writer from then on', async () => {
    const reader = await start()
    const store = new Store(db, { reader })
    seed(store)
    const slow = reader.query('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3000000) SELECT count(*) FROM c', [])
    const rejected = expect(slow).rejects.toThrow(/reader worker/)
    await new Promise((r) => setTimeout(r, 20))
    await reader.stop()
    await rejected
    expect(reader.available).toBe(false)
    expect((await store.searchEvents({ query: 'zebra', archived: true })).hits).toHaveLength(9)
  })

  it('stop() resolves, twice, and for an in-memory path nothing was started', async () => {
    const reader = await start()
    await reader.stop()
    await reader.stop()
    const none = new EventReader(':memory:')
    expect(await none.ready).toBe(false)
    expect(none.available).toBe(false)
    await none.stop()
  })
})
