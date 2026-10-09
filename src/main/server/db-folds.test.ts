import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FOLD_VERSION, openDb, Store, type FoldRow } from './db'
import type { SessionMeta } from '@shared/events'

let db: ReturnType<typeof openDb>
let store: Store
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string, parentId: string | null = null): SessionMeta => ({
  id,
  parentId,
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
  updatedAt: 1
})

const fold = (sessionId: string, patch: Partial<FoldRow> = {}): FoldRow => ({
  sessionId,
  foldedSeq: 3,
  foldVersion: FOLD_VERSION,
  tasks: { done: 1, total: 4, current: 'Running tests' },
  goal: { condition: 'green', iterations: 2, setAt: 10 },
  canContinue: true,
  ...patch
})

describe('session_folds', () => {
  it('round-trips a full row and a "no tasks, no goal" row', () => {
    store.putFold(fold('a'))
    store.putFold(fold('b', { tasks: null, goal: null, canContinue: false }))
    expect(store.getFold('a')).toEqual(fold('a'))
    expect(store.getFold('b')).toEqual(fold('b', { tasks: null, goal: null, canContinue: false }))
    expect(store.getFold('missing')).toBeNull()
    expect(store.listFolds().map((f) => f.sessionId).sort()).toEqual(['a', 'b'])
  })

  it('putFold upserts in place', () => {
    store.putFold(fold('a'))
    store.putFold(fold('a', { foldedSeq: 9, tasks: { done: 4, total: 4, current: null } }))
    expect(store.listFolds()).toHaveLength(1)
    expect(store.getFold('a')?.foldedSeq).toBe(9)
    expect(store.getFold('a')?.tasks).toEqual({ done: 4, total: 4, current: null })
  })

  it('deleteFold and deleteSessionTree drop rows', () => {
    store.insertSession(meta('root'))
    store.insertSession(meta('kid', 'root'))
    store.putFold(fold('root'))
    store.putFold(fold('kid'))
    store.putFold(fold('other'))
    store.deleteFold('other')
    expect(store.getFold('other')).toBeNull()
    store.deleteSessionTree('root')
    expect(store.listFolds()).toEqual([])
  })

  it('maxSeqs reports the highest seq per session without touching payloads', () => {
    store.insertSession(meta('a'))
    store.insertSession(meta('b'))
    store.insertSession(meta('empty'))
    store.appendEvent('a', { type: 'user-text', text: 'hi' })
    store.appendEvent('a', { type: 'assistant-text', text: 'yo', delta: false })
    store.appendEvent('b', { type: 'user-text', text: 'hi' })
    const max = store.maxSeqs()
    expect(max.get('a')).toBe(2)
    expect(max.get('b')).toBe(1)
    expect(max.has('empty')).toBe(false)
  })

  it('eventsRange pages a log in seq order and eventsAfter reads it all', () => {
    store.insertSession(meta('a'))
    for (let i = 0; i < 7; i++) store.appendEvent('a', { type: 'user-text', text: `${i}` })
    const first = store.eventsRange('a', 0, 3)
    expect(first.map((r) => r.seq)).toEqual([1, 2, 3])
    const second = store.eventsRange('a', 3, 3)
    expect(second.map((r) => r.seq)).toEqual([4, 5, 6])
    const tail = store.eventsRange('a', 6, 3)
    expect(tail.map((r) => r.seq)).toEqual([7])
    expect(store.eventsRange('a', 7, 3)).toEqual([])
    expect(store.eventsAfter('a', 0).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(store.eventsAfter('a', 5).map((r) => r.seq)).toEqual([6, 7])
  })

  it('childrenOf lists direct children only', () => {
    store.insertSession(meta('root'))
    store.insertSession(meta('kid', 'root'))
    store.insertSession(meta('grandkid', 'kid'))
    expect(store.childrenOf('root').map((s) => s.id)).toEqual(['kid'])
    expect(store.childrenOf('kid').map((s) => s.id)).toEqual(['grandkid'])
    expect(store.childrenOf('grandkid')).toEqual([])
  })
})
