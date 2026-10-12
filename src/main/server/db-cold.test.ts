import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coldPathFor, openDb, Store } from './db'
import type { AgentEvent, SessionMeta } from '@shared/events'

let db: ReturnType<typeof openDb>
let store: Store
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  parentId: null,
  projectId: null,
  workspaceId: null,
  threadType: null,
  planPath: null,
  provider: 'claude',
  model: 'm',
  reasoning: 'medium',
  agentType: 'implementer',
  title: id,
  cwd: '/tmp',
  status: 'idle',
  pinned: false,
  archived: false,
  fast: false,
  ultrafast: false,
  context1m: false,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  threadRules: null,
  permission: 'edits',
  nativeId: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra
})

function seed(id: string, n: number, extra: Partial<SessionMeta> = {}): void {
  store.insertSession(meta(id, extra))
  for (let i = 0; i < n; i++) {
    const e: AgentEvent =
      i === 0 ? { type: 'user-text', text: 'go' } : { type: 'assistant-text', text: `t${i}`, delta: false }
    store.appendEvent(id, e)
  }
}

const seqs = (rows: { seq: number }[]): number[] => rows.map((r) => r.seq)

describe('hot / cold event files', () => {
  it('names the cold file beside the hot one', () => {
    expect(coldPathFor('/x/temp-code.db')).toBe('/x/temp-code-cold.db')
    expect(coldPathFor(':memory:')).toBe(':memory:')
  })

  it('creates the cold file on disk and reopens with the cold set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tc-cold-'))
    const path = join(dir, 'temp-code.db')
    const d1 = openDb(path)
    const s1 = new Store(d1)
    s1.insertSession(meta('a', { archived: true }))
    s1.appendEvent('a', { type: 'user-text', text: 'hi' })
    expect(s1.moveToCold('a')).toEqual({ moved: 1, done: true })
    d1.close()
    expect(existsSync(coldPathFor(path))).toBe(true)
    const d2 = openDb(path)
    const s2 = new Store(d2)
    expect(s2.isCold('a')).toBe(true)
    expect(s2.eventsAfter('a', 0).map((r) => r.event)).toEqual([{ type: 'user-text', text: 'hi' }])
    d2.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('moves a session to cold and back, rows intact and in order', () => {
    seed('a', 12, { archived: true })
    seed('b', 3)
    expect(store.moveToCold('a')).toEqual({ moved: 12, done: true })
    expect(store.eventCounts('a')).toEqual({ hot: 0, cold: 12 })
    expect(store.eventCounts('b')).toEqual({ hot: 3, cold: 0 })
    expect(store.isCold('a')).toBe(true)
    expect(seqs(store.eventsAfter('a', 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(store.moveToHot('a')).toBe(12)
    expect(store.eventCounts('a')).toEqual({ hot: 12, cold: 0 })
    expect(store.isCold('a')).toBe(false)
    expect(seqs(store.eventsAfter('a', 0))).toHaveLength(12)
  })

  it('every reader falls through to cold', () => {
    seed('a', 12, { archived: true })
    store.moveToCold('a')
    expect(store.hasUserText('a')).toBe(true)
    expect(seqs(store.eventsRange('a', 10, 5))).toEqual([11, 12])
    expect(seqs(store.events('a', { afterSeq: 2, beforeSeq: 5 }))).toEqual([3, 4])
    expect(seqs(store.events('a', { tail: 2 })).length).toBeGreaterThan(0)
    const hits = store.searchEvents({ query: 't11', archived: true }).hits
    expect(hits.map((h) => h.sessionId)).toEqual(['a'])
    // hot-only search does not walk the cold file
    expect(store.searchEvents({ query: 't11' }).hits).toEqual([])
  })

  it('appends to a cold session land in the cold file with the next seq', () => {
    seed('a', 3, { archived: true })
    store.moveToCold('a')
    const row = store.appendEvent('a', { type: 'status', status: 'idle' })
    expect(row.seq).toBe(4)
    expect(store.eventCounts('a')).toEqual({ hot: 0, cold: 4 })
    expect(store.appendEvent('a', { type: 'status', status: 'idle' }).seq).toBe(5)
  })

  it('unarchiving through updateSession brings the rows back first', () => {
    seed('a', 5, { archived: true })
    store.moveToCold('a')
    const next = store.updateSession('a', { archived: false })
    expect(next?.archived).toBe(false)
    expect(store.isCold('a')).toBe(false)
    expect(store.eventCounts('a')).toEqual({ hot: 5, cold: 0 })
    // archiving again leaves the rows where they are until the mover runs
    store.updateSession('a', { archived: true })
    expect(store.eventCounts('a')).toEqual({ hot: 5, cold: 0 })
    expect(store.coldBacklog()).toEqual({ toCold: ['a'], toHot: [] })
  })

  it('moves in batches, settling a half-moved session for a reader', () => {
    seed('a', 10, { archived: true })
    expect(store.moveToCold('a', 4)).toEqual({ moved: 4, done: false })
    expect(store.eventCounts('a')).toEqual({ hot: 6, cold: 4 })
    expect(store.coldBacklog().toCold).toEqual(['a'])
    // A reader mid-move sees the whole log and the move finishes.
    expect(seqs(store.eventsAfter('a', 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(store.eventCounts('a')).toEqual({ hot: 0, cold: 10 })
    expect(store.isCold('a')).toBe(true)
  })

  it('a half-moved session brought back to hot comes back whole', () => {
    seed('a', 10, { archived: true })
    store.moveToCold('a', 4)
    expect(store.moveToHot('a')).toBe(4)
    expect(store.eventCounts('a')).toEqual({ hot: 10, cold: 0 })
    expect(seqs(store.eventsAfter('a', 0))).toHaveLength(10)
  })

  it('a repeated batch is idempotent (resume after an interrupted move)', () => {
    seed('a', 10, { archived: true })
    store.moveToCold('a', 4)
    // Simulate the copy having landed but not the delete: rows in both.
    db.exec(`INSERT OR REPLACE INTO events SELECT * FROM cold.events WHERE session_id = 'a'`)
    expect(store.eventCounts('a')).toEqual({ hot: 10, cold: 4 })
    store.moveToCold('a', 4)
    store.moveToCold('a', 4)
    expect(store.moveToCold('a', 4)).toEqual({ moved: 2, done: true })
    expect(store.eventCounts('a')).toEqual({ hot: 0, cold: 10 })
    expect(seqs(store.eventsAfter('a', 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('deleting a tree clears both files', () => {
    seed('a', 3, { archived: true })
    store.moveToCold('a')
    seed('b', 2)
    store.deleteSessionTree('a')
    store.deleteSessionTree('b')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cold.events`).get()).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events`).get()).toEqual({ n: 0 })
  })

  it('the boot scan asks only unarchived sessions and never the cold file', () => {
    seed('live', 3)
    seed('arch', 7, { archived: true })
    store.moveToCold('arch')
    seed('arch-hot', 2, { archived: true })
    expect([...store.maxSeqs().entries()]).toEqual([['live', 3]])
  })

  it('listSessions filters by archived', () => {
    seed('a', 1)
    seed('b', 1, { archived: true })
    expect(store.listSessions().map((s) => s.id).sort()).toEqual(['a', 'b'])
    expect(store.listSessions({ archived: false }).map((s) => s.id)).toEqual(['a'])
    expect(store.listSessions({ archived: true }).map((s) => s.id)).toEqual(['b'])
  })
})
