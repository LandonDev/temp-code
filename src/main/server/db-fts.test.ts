import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { Notes } from './notes'
import { ftsQuery, turnText } from './turnIndex'
import type { AgentEvent, SessionMeta } from '@shared/events'

/**
 * The FTS5 turn index (turnIndex.ts) behind session.search: rows are
 * indexed as they land, a database from before the index is backfilled in
 * the background (and searchable by scan meanwhile), a session's rows
 * follow it between the hot and cold files, a deleted session leaves the
 * index, a session whose rows changed under the store is indexed again,
 * hits carry bm25 so the renderer can rank by match quality, and a SQLite
 * without FTS5 keeps the scan.
 */

let db: DatabaseSync
let store: Store
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id, parentId: null, projectId: null, workspaceId: 'w1', threadType: 'chat', planPath: null,
    provider: 'claude', model: 'm', reasoning: 'medium', agentType: 'implementer', title: id, cwd: '/tmp',
    status: 'idle', pinned: false, archived: false, fast: false, ultrafast: false, context1m: false,
    busySince: null, pausedAt: null, frozenActiveElapsed: null, threadRules: null, permission: 'edits',
    nativeId: null, createdAt: 1, updatedAt: 1, ...extra
  }) as unknown as SessionMeta

const say = (id: string, text: string, extra: Partial<AgentEvent> = {}): void => {
  store.appendEvent(id, { type: 'assistant-text', text, delta: false, ...extra } as AgentEvent)
}
const ftsRows = (table = 'events_fts'): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
const keys = (hits: { sessionId: string; seq: number }[]): string[] => hits.map((h) => `${h.sessionId}:${h.seq}`).sort()

/** The rows of a database written before the index existed: landed, then
 *  stripped of everything the index wrote. */
const forgetIndex = (): void => {
  store.flushEvents()
  db.exec('DELETE FROM turn_index; DELETE FROM events_fts; DELETE FROM cold.events_fts')
}

describe('turnText and ftsQuery', () => {
  it('indexes a user or assistant turn and nothing else', () => {
    expect(turnText({ type: 'user-text', text: 'hi' })).toBe('hi')
    expect(turnText({ type: 'assistant-text', text: 'yo', delta: false })).toBe('yo')
    expect(turnText({ type: 'assistant-text', text: 'yo', delta: true })).toBeNull()
    expect(turnText({ type: 'assistant-text', text: 'yo', delta: false, parentCallId: 'c' } as AgentEvent)).toBeNull()
    expect(turnText({ type: 'assistant-text', text: '', delta: false })).toBeNull()
    expect(turnText({ type: 'tool-call', callId: 'c', name: 'Bash', input: {} } as unknown as AgentEvent)).toBeNull()
  })

  it('quotes every token, requires all of them and makes the last a prefix', () => {
    expect(ftsQuery('gateway trace')).toBe('"gateway" "trace"*')
    expect(ftsQuery('  one ')).toBe('"one"*')
    expect(ftsQuery('a "b" OR c*')).toBe('"a" "b" "OR" "c*"*')
    expect(ftsQuery('""')).toBe('')
  })
})

describe('incremental index', () => {
  it('finds a row the moment it lands, with its bm25 rank and FTS snippet', async () => {
    store.insertSession(meta('a'))
    store.appendEvent('a', { type: 'user-text', text: 'please trace the gateway' })
    say('a', 'gate', { delta: true })
    say('a', 'nested gateway', { parentCallId: 'call' } as Partial<AgentEvent>)
    const { hits } = await store.searchEvents({ query: 'gateway' })
    expect(keys(hits)).toEqual(['a:1'])
    expect(hits[0]).toMatchObject({ role: 'user', snippet: 'please trace the gateway' })
    expect(hits[0].rank).toBeLessThan(0)
    expect(ftsRows()).toBe(1)
    expect(store.turnIndex.hasPending()).toBe(false)
  })

  it('matches words by prefix and diacritics-insensitively, every word required', async () => {
    store.insertSession(meta('a'))
    say('a', 'the café on the corner')
    say('a', 'the corner shop')
    expect(keys((await store.searchEvents({ query: 'cafe corn' })).hits)).toEqual(['a:1'])
    expect(keys((await store.searchEvents({ query: 'corner' })).hits)).toEqual(['a:1', 'a:2'])
    expect((await store.searchEvents({ query: 'corner café shop' })).hits).toEqual([])
  })

  it('ranks the better match first and keeps recency as the tie-break', async () => {
    store.insertSession(meta('a'))
    say('a', 'zebra zebra zebra')
    say('a', 'one zebra in a long line of other words that dilute the term quite a bit more')
    say('a', 'zebra zebra zebra')
    const { hits } = await store.searchEvents({ query: 'zebra' })
    expect(hits.map((h) => h.seq)).toEqual([3, 1, 2])
    expect(hits[0].rank).toBeLessThan(hits[2].rank!)
  })
})

describe('backfill', () => {
  it('a database from before the index is searched by scan, then indexed newest first in the background', async () => {
    store.insertSession(meta('old', { updatedAt: 1 }))
    store.insertSession(meta('new', { updatedAt: 2 }))
    say('old', 'the needle in the old thread')
    say('new', 'the needle in the new thread')
    say('new', 'no match here')
    forgetIndex()
    store = new Store(db)
    expect(store.turnIndex.pending()).toEqual(['new', 'old'])
    expect(store.turnIndex.hasPending()).toBe(true)
    const scanned = await store.searchEvents({ query: 'needle' })
    expect(keys(scanned.hits)).toEqual(['new:1', 'old:1'])
    expect(scanned.hits.every((h) => h.rank === undefined)).toBe(true)

    const progress: string[] = []
    await store.backfillTurnIndex({ onProgress: ({ sessionId, rows }) => progress.push(`${sessionId}:${rows}`) })
    expect(progress).toEqual(['new:2', 'old:1'])
    expect(store.turnIndex.pending()).toEqual([])
    expect(ftsRows()).toBe(3)
    const indexed = await store.searchEvents({ query: 'needle' })
    expect(keys(indexed.hits)).toEqual(['new:1', 'old:1'])
    expect(indexed.hits.every((h) => typeof h.rank === 'number' && h.rank < 0)).toBe(true)
  })

  it('works in bounded transactions with a yield between them, and rows appended meanwhile land too', async () => {
    store.insertSession(meta('a'))
    for (let i = 0; i < 7; i++) say('a', `row ${i} needle`)
    forgetIndex()
    store = new Store(db)
    let yields = 0
    const yieldNow = async (): Promise<void> => {
      yields++
      // A turn arrives while the backfill is between chunks.
      if (yields === 1) say('a', 'late needle')
    }
    await store.backfillTurnIndex({ batch: 3, yieldNow })
    expect(yields).toBeGreaterThanOrEqual(3)
    expect(ftsRows()).toBe(8)
    expect(keys((await store.searchEvents({ query: 'needle' })).hits)).toHaveLength(8)
    // Ready now: the next row is indexed as it lands.
    say('a', 'after needle')
    store.flushEvents()
    expect(ftsRows()).toBe(9)
  })

  it('a session that quit half-indexed is pending again and finishes without duplicates', async () => {
    store.insertSession(meta('a'))
    for (let i = 0; i < 4; i++) say('a', `needle ${i}`)
    forgetIndex()
    db.exec(`INSERT INTO turn_index (session_id, ready) VALUES ('a', 0)`)
    const { ordinal } = db.prepare(`SELECT ordinal FROM turn_index WHERE session_id = 'a'`).get() as { ordinal: number }
    db.prepare(`INSERT INTO events_fts (rowid, text) VALUES (?, 'needle 0')`).run((BigInt(ordinal) << 32n) | 1n)
    store = new Store(db)
    expect(store.turnIndex.pending()).toEqual(['a'])
    await store.backfillTurnIndex()
    expect(ftsRows()).toBe(4)
    expect(keys((await store.searchEvents({ query: 'needle' })).hits)).toEqual(['a:1', 'a:2', 'a:3', 'a:4'])
  })

  it('a kick during a run looks again when it ends', async () => {
    store.insertSession(meta('a'))
    say('a', 'needle a')
    forgetIndex()
    store = new Store(db)
    let second: Promise<void> | null = null
    const first = store.backfillTurnIndex({
      yieldNow: async () => {
        if (!second) {
          // A thread lands through a move while the first run is on: its
          // index rows are dropped and a kick asks for another look.
          store.insertSession(meta('b'))
          say('b', 'needle b')
          store.flushEvents()
          store.turnIndex.forget(['b'])
          second = store.backfillTurnIndex()
        }
      }
    })
    await first
    expect(second).toBe(first)
    expect(store.turnIndex.pending()).toEqual([])
    expect(keys((await store.searchEvents({ query: 'needle' })).hits)).toEqual(['a:1', 'b:1'])
  })
})

describe('hot and cold files', () => {
  it("a session's index rows follow it to the cold file and back", async () => {
    store.insertSession(meta('a'))
    say('a', 'needle one')
    say('a', 'needle two')
    store.moveToCold('a')
    expect(ftsRows('events_fts')).toBe(0)
    expect(ftsRows('cold.events_fts')).toBe(2)
    expect((await store.searchEvents({ query: 'needle' })).hits).toEqual([])
    const cold = await store.searchEvents({ query: 'needle', archived: true })
    expect(keys(cold.hits)).toEqual(['a:1', 'a:2'])
    expect(cold.hits[0].rank).toBeLessThan(0)
    // A row appended to a cold session is indexed in the cold file.
    say('a', 'needle three')
    store.flushEvents()
    expect(ftsRows('cold.events_fts')).toBe(3)
    store.moveToHot('a')
    expect(ftsRows('events_fts')).toBe(3)
    expect(ftsRows('cold.events_fts')).toBe(0)
    expect(keys((await store.searchEvents({ query: 'needle' })).hits)).toEqual(['a:1', 'a:2', 'a:3'])
  })

  it('a batched move carries each batch of index rows', async () => {
    store.insertSession(meta('a'))
    for (let i = 0; i < 5; i++) say('a', `needle ${i}`)
    expect(store.moveToCold('a', 2)).toEqual({ moved: 2, done: false })
    expect(ftsRows('events_fts')).toBe(3)
    expect(ftsRows('cold.events_fts')).toBe(2)
    expect(store.moveToCold('a', 2)).toEqual({ moved: 2, done: false })
    expect(store.moveToCold('a', 2)).toEqual({ moved: 1, done: true })
    expect(ftsRows('events_fts')).toBe(0)
    expect(ftsRows('cold.events_fts')).toBe(5)
    expect(keys((await store.searchEvents({ query: 'needle', archived: true })).hits)).toHaveLength(5)
  })

  it('a session not yet indexed is backfilled in whichever file holds it', async () => {
    store.insertSession(meta('a'))
    say('a', 'needle')
    forgetIndex()
    store = new Store(db)
    store.moveToCold('a')
    await store.backfillTurnIndex()
    expect(ftsRows('events_fts')).toBe(0)
    expect(ftsRows('cold.events_fts')).toBe(1)
  })
})

describe('deletes and re-indexing', () => {
  it('a deleted tree leaves the index', async () => {
    store.insertSession(meta('a'))
    store.insertSession(meta('a1', { parentId: 'a' }))
    say('a', 'needle')
    say('a1', 'needle child')
    store.deleteSessionTree('a')
    expect(ftsRows()).toBe(0)
    expect((db.prepare(`SELECT count(*) AS n FROM turn_index`).get() as { n: number }).n).toBe(0)
    expect((await store.searchEvents({ query: 'needle' })).hits).toEqual([])
  })

  it('rows that changed under the store are dropped, found by scan, and indexed again by the next backfill', async () => {
    store.insertSession(meta('a'))
    say('a', 'needle')
    store.flushEvents()
    // Another writer (a move landing) rewrote the log: the store is told.
    db.prepare(`UPDATE events SET payload = ? WHERE session_id = 'a' AND seq = 1`).run(
      JSON.stringify({ type: 'assistant-text', text: 'replaced needle', delta: false })
    )
    store.forgetSessions(['a'])
    expect(store.turnIndex.isReady('a')).toBe(false)
    expect(ftsRows()).toBe(0)
    // Found by the scan meanwhile (no backfill has been asked of this store).
    expect((await store.searchEvents({ query: 'replaced' })).hits.map((h) => h.rank)).toEqual([undefined])
    await store.backfillTurnIndex()
    const { hits } = await store.searchEvents({ query: 'replaced' })
    expect(hits).toHaveLength(1)
    expect(hits[0].rank).toBeLessThan(0)
    expect(hits[0].snippet).toBe('replaced needle')
  })

  it('once a backfill has run, rows that change under the store are indexed again on their own', async () => {
    store.insertSession(meta('a'))
    say('a', 'needle')
    store.flushEvents()
    await store.backfillTurnIndex()
    db.prepare(`UPDATE events SET payload = ? WHERE session_id = 'a' AND seq = 1`).run(
      JSON.stringify({ type: 'assistant-text', text: 'replaced needle', delta: false })
    )
    store.forgetSessions(['a'])
    await new Promise((r) => setTimeout(r, 20))
    expect(store.turnIndex.isReady('a')).toBe(true)
    const { hits } = await store.searchEvents({ query: 'replaced' })
    expect(hits.map((h) => h.snippet)).toEqual(['replaced needle'])
    expect(hits[0].rank).toBeLessThan(0)
  })
})

describe('without FTS5', () => {
  it('the search is the scan it was, rank-less, and every index hook is a no-op', async () => {
    const real = openDb(':memory:')
    const noFts = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'exec') {
          return (sql: string) => {
            if (/fts5/i.test(sql)) throw new Error('no such module: fts5')
            return target.exec(sql)
          }
        }
        const value = Reflect.get(target, prop, receiver) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      }
    })
    const plain = new Store(noFts)
    expect(plain.turnIndex.available).toBe(false)
    plain.insertSession(meta('a'))
    plain.appendEvent('a', { type: 'user-text', text: 'a needle here' })
    plain.appendEvent('a', { type: 'assistant-text', text: 'nee', delta: true })
    const { hits } = await plain.searchEvents({ query: 'needle' })
    expect(hits).toEqual([{ sessionId: 'a', seq: 1, role: 'user', snippet: 'a needle here', ts: hits[0].ts }])
    expect(plain.turnIndex.pending()).toEqual([])
    await plain.backfillTurnIndex()
    plain.moveToCold('a')
    plain.deleteSessionTree('a')
    real.close()
  })
})

describe('notes.search', () => {
  it('matches title or body, snippets around the mention, newest first, capped', () => {
    const notes = new Notes(db)
    notes.upsert({ id: 'n1', title: 'Gateway notes', body: 'nothing relevant' })
    notes.upsert({ id: 'n2', title: 'Other', body: `${'lead '.repeat(30)}the GATEWAY trace flag${' tail'.repeat(40)}`, sourceCwd: '/work/app' })
    notes.upsert({ id: 'n3', title: 'Unrelated', body: 'nope' })
    const result = notes.search('gateway')
    expect(result.truncated).toBe(false)
    expect(result.hits.map((h) => h.id).sort()).toEqual(['n1', 'n2'])
    const byTitle = result.hits.find((h) => h.id === 'n1')!
    expect(byTitle.snippet).toBe('Gateway notes')
    expect(byTitle.sourceCwd).toBeUndefined()
    const byBody = result.hits.find((h) => h.id === 'n2')!
    expect(byBody.snippet.startsWith('…')).toBe(true)
    expect(byBody.snippet).toContain('the GATEWAY trace flag')
    expect(byBody.snippet.length).toBeLessThanOrEqual(181)
    expect(byBody.sourceCwd).toBe('/work/app')
    expect(byBody.updatedAt).toBeGreaterThan(0)
    expect(notes.search('gateway', 1)).toMatchObject({ truncated: true })
    expect(notes.search('   ')).toEqual({ hits: [], truncated: false })
  })
})
