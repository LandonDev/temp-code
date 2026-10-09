import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FOLD_VERSION, openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { sweepFolds } from './folds'
import type { AgentEvent, SessionMeta } from '@shared/events'

let db: ReturnType<typeof openDb>
let store: Store
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string, updatedAt = 1): SessionMeta => ({
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
  updatedAt
})

const todoWrite = (
  callId: string,
  todos: { content: string; status: string; activeForm?: string }[]
): AgentEvent => ({ type: 'tool-call', callId, name: 'TodoWrite', input: { todos } })

/** A session written the way an older build left it: rows in `sessions`
 *  and `events`, nothing in `session_folds`. */
function legacy(id: string, events: AgentEvent[], updatedAt = 1): void {
  store.insertSession(meta(id, updatedAt))
  for (const e of events) store.appendEvent(id, e)
}

const noYield = async (): Promise<void> => {}
const sweep = (reg: SessionRegistry, chunk?: number): Promise<number> =>
  sweepFolds(store, reg, { yieldNow: noYield, chunk })

const listed = (reg: SessionRegistry, id: string): SessionMeta =>
  reg.list().find((s) => s.id === id)!

describe('fold sweep', () => {
  it('folds a TodoWrite history to the right tally, in chunks', async () => {
    legacy('a', [
      { type: 'user-text', text: 'go' },
      todoWrite('c1', [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
        { content: 'three', status: 'pending' }
      ]),
      { type: 'assistant-text', text: 'ok', delta: false }
    ])
    const reg = new SessionRegistry(store)
    expect(listed(reg, 'a').tasks).toBeNull()
    expect(await sweep(reg, 2)).toBe(1)
    expect(listed(reg, 'a').tasks).toEqual({ done: 1, total: 3, current: 'Doing two' })
    const row = store.getFold('a')!
    expect(row.foldedSeq).toBe(3)
    expect(row.foldVersion).toBe(FOLD_VERSION)
  })

  it('round-trips goal set / updated / met through the JSON column', async () => {
    legacy('set', [{ type: 'goal', phase: 'set', condition: 'green' }])
    legacy('updated', [
      { type: 'goal', phase: 'set', condition: 'green' },
      { type: 'goal', phase: 'updated', condition: 'greener', iterations: 3 }
    ])
    legacy('met', [
      { type: 'goal', phase: 'set', condition: 'green' },
      { type: 'goal', phase: 'met', condition: 'green' }
    ])
    const reg = new SessionRegistry(store)
    await sweep(reg)
    const setAt = store.eventsAfter('set', 0)[0].ts
    expect(listed(reg, 'set').goal).toEqual({ condition: 'green', iterations: 0, setAt })
    expect(listed(reg, 'updated').goal).toMatchObject({ condition: 'greener', iterations: 3 })
    expect(listed(reg, 'met').goal).toBeNull()
    // A fresh registry reads the same answer straight off the rows.
    const again = new SessionRegistry(store)
    expect(listed(again, 'updated').goal).toMatchObject({ condition: 'greener', iterations: 3 })
    expect(listed(again, 'set').goal).toEqual({ condition: 'green', iterations: 0, setAt })
  })

  it('a trailing error sets can_continue; a later user-text clears it', async () => {
    legacy('err', [
      { type: 'user-text', text: 'go' },
      { type: 'error', message: 'session limit' }
    ])
    legacy('cleared', [
      { type: 'user-text', text: 'go' },
      { type: 'error', message: 'session limit' },
      { type: 'user-text', text: 'again' }
    ])
    const reg = new SessionRegistry(store)
    expect(listed(reg, 'err').canContinue).toBe(false) // not swept yet
    await sweep(reg)
    expect(listed(reg, 'err').canContinue).toBe(true)
    expect(listed(reg, 'err').treeCanContinue).toBe(true)
    expect(listed(reg, 'cleared').canContinue).toBe(false)
    expect(store.getFold('err')?.canContinue).toBe(true)
  })

  it('lists an unfolded session undecorated and fills it in live over onMeta', async () => {
    legacy('a', [{ type: 'user-text', text: 'go' }, todoWrite('c1', [{ content: 'x', status: 'pending' }])])
    const reg = new SessionRegistry(store)
    const pushed: SessionMeta[] = []
    reg.onMeta((s) => pushed.push(s))
    const before = listed(reg, 'a')
    expect(before).toMatchObject({ tasks: null, goal: null, canContinue: false, treeCanContinue: false })
    await sweep(reg)
    expect(pushed.map((s) => s.id)).toEqual(['a'])
    expect(pushed[0].tasks).toEqual({ done: 0, total: 1, current: null })
    expect(listed(reg, 'a').tasks).toEqual({ done: 0, total: 1, current: null })
  })

  it('re-folds a row behind MAX(seq) and a row behind FOLD_VERSION, leaves current rows alone', async () => {
    legacy('behind', [{ type: 'user-text', text: 'go' }, todoWrite('c1', [{ content: 'x', status: 'completed' }])])
    legacy('old', [{ type: 'user-text', text: 'go' }, todoWrite('c1', [{ content: 'x', status: 'completed' }])])
    legacy('fresh', [{ type: 'user-text', text: 'go' }])
    store.putFold({ sessionId: 'behind', foldedSeq: 1, foldVersion: FOLD_VERSION, tasks: null, goal: null, canContinue: false })
    store.putFold({ sessionId: 'old', foldedSeq: 2, foldVersion: FOLD_VERSION - 1, tasks: null, goal: null, canContinue: false })
    store.putFold({ sessionId: 'fresh', foldedSeq: 1, foldVersion: FOLD_VERSION, tasks: { done: 9, total: 9, current: null }, goal: null, canContinue: false })
    const reg = new SessionRegistry(store)
    expect(await sweep(reg)).toBe(2)
    expect(listed(reg, 'behind').tasks).toEqual({ done: 1, total: 1, current: null })
    expect(store.getFold('old')).toMatchObject({ foldVersion: FOLD_VERSION, tasks: { done: 1, total: 1 } })
    // "fresh" was current, so its (deliberately wrong) row was trusted, not re-walked.
    expect(listed(reg, 'fresh').tasks).toEqual({ done: 9, total: 9, current: null })
  })

  it('sweeps newest first and yields between chunks', async () => {
    legacy('older', [{ type: 'user-text', text: 'a' }], 10)
    legacy('newer', [{ type: 'user-text', text: 'b' }, { type: 'user-text', text: 'c' }, { type: 'user-text', text: 'd' }], 20)
    const reg = new SessionRegistry(store)
    const order: string[] = []
    reg.onMeta((s) => order.push(s.id))
    let yields = 0
    await sweepFolds(store, reg, { chunk: 2, batch: 1, yieldNow: async () => void yields++ })
    expect(order).toEqual(['newer', 'older'])
    expect(yields).toBeGreaterThanOrEqual(3) // one mid-'newer' chunk boundary + one per session
  })

  it('drops its own result when append() warmed the session mid-sweep', async () => {
    legacy('a', [{ type: 'user-text', text: 'go' }, { type: 'user-text', text: 'more' }, { type: 'user-text', text: 'more' }])
    const reg = new SessionRegistry(store)
    let n = 0
    const yieldNow = async (): Promise<void> => {
      // First yield lands inside 'a' (chunk boundary): a send arrives.
      if (n++ === 0) reg.append('a', todoWrite('c9', [{ content: 'live', status: 'in_progress', activeForm: 'Live' }]))
    }
    expect(await sweepFolds(store, reg, { chunk: 2, yieldNow })).toBe(0)
    expect(listed(reg, 'a').tasks).toEqual({ done: 0, total: 1, current: 'Live' })
    expect(store.getFold('a')).toMatchObject({ foldedSeq: 4, tasks: { done: 0, total: 1, current: 'Live' } })
  })
})

describe('registry fold writes', () => {
  it('append() on an unfolded session persists a correct row without the sweep', () => {
    legacy('a', [
      { type: 'user-text', text: 'go' },
      { type: 'goal', phase: 'set', condition: 'green' },
      { type: 'error', message: 'boom' }
    ])
    const reg = new SessionRegistry(store)
    expect(listed(reg, 'a')).toMatchObject({ tasks: null, goal: null, canContinue: false })
    reg.append('a', todoWrite('c1', [{ content: 'x', status: 'in_progress', activeForm: 'Doing x' }]))
    const row = store.getFold('a')!
    expect(row).toMatchObject({
      foldedSeq: 4,
      foldVersion: FOLD_VERSION,
      tasks: { done: 0, total: 1, current: 'Doing x' },
      goal: { condition: 'green', iterations: 0 },
      canContinue: false // the tool-call superseded the error
    })
    expect(listed(reg, 'a')).toMatchObject({ tasks: row.tasks, goal: row.goal, canContinue: false })
    // Fresh process: the row alone carries the answer, no log walk.
    expect(listed(new SessionRegistry(store), 'a')).toMatchObject({ tasks: row.tasks, goal: row.goal })
  })

  it('append() keeps a folded row current event by event', () => {
    legacy('a', [])
    const reg = new SessionRegistry(store)
    reg.append('a', { type: 'user-text', text: 'go' })
    reg.append('a', { type: 'error', message: 'boom' })
    expect(store.getFold('a')).toMatchObject({ foldedSeq: 2, canContinue: true })
    reg.append('a', { type: 'errors-cleared' })
    expect(store.getFold('a')).toMatchObject({ foldedSeq: 3, canContinue: false })
    reg.append('a', { type: 'goal', phase: 'set', condition: 'g' })
    expect(store.getFold('a')?.goal).toMatchObject({ condition: 'g' })
  })

  it('create() seeds an empty row so a new session is never unfolded', async () => {
    const reg = new SessionRegistry(store)
    const s = await reg.create({ cwd: '/tmp', provider: 'claude' })
    expect(store.getFold(s.id)).toMatchObject({ foldedSeq: 0, foldVersion: FOLD_VERSION, tasks: null, goal: null, canContinue: false })
    expect(await sweep(reg)).toBe(0)
  })

  it('resetStaleStatuses() advances a current row and leaves a stale one for the sweep', () => {
    legacy('current', [{ type: 'user-text', text: 'go' }])
    legacy('stale', [{ type: 'user-text', text: 'go' }, { type: 'user-text', text: 'go' }])
    store.updateSession('current', { status: 'running' })
    store.updateSession('stale', { status: 'running' })
    store.putFold({ sessionId: 'current', foldedSeq: 1, foldVersion: FOLD_VERSION, tasks: null, goal: null, canContinue: true })
    store.putFold({ sessionId: 'stale', foldedSeq: 1, foldVersion: FOLD_VERSION, tasks: null, goal: null, canContinue: false })
    const reg = new SessionRegistry(store)
    reg.resetStaleStatuses()
    expect(store.getFold('current')).toMatchObject({ foldedSeq: 2, canContinue: true })
    expect(store.getFold('stale')?.foldedSeq).toBe(1)
    expect(store.maxSeqs().get('stale')).toBe(3)
  })

  it('a deleted session leaves no row', async () => {
    const reg = new SessionRegistry(store)
    const s = await reg.create({ cwd: '/tmp', provider: 'claude' })
    reg.append(s.id, { type: 'user-text', text: 'go' })
    expect(store.getFold(s.id)).not.toBeNull()
    await reg.delete(s.id)
    expect(store.getFold(s.id)).toBeNull()
    expect(store.listFolds()).toEqual([])
  })
})
