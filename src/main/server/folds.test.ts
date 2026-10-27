import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FOLD_VERSION, openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { foldEvent, foldLog, newFoldState, reviveTodo, sweepFolds, toFoldRow } from './folds'
import { EventReader } from './dbWorkers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
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
    store.putFold({ sessionId: 'behind', foldedSeq: 1, foldVersion: FOLD_VERSION, tasks: null, goal: null, canContinue: false, failure: null })
    store.putFold({ sessionId: 'old', foldedSeq: 2, foldVersion: FOLD_VERSION - 1, tasks: null, goal: null, canContinue: false, failure: null })
    store.putFold({ sessionId: 'fresh', foldedSeq: 1, foldVersion: FOLD_VERSION, tasks: { done: 9, total: 9, current: null }, goal: null, canContinue: false, failure: null })
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
  it('append() on an unfolded session persists a correct row without the sweep', async () => {
    legacy('a', [
      { type: 'user-text', text: 'go' },
      { type: 'goal', phase: 'set', condition: 'green' },
      { type: 'error', message: 'boom' }
    ])
    const reg = new SessionRegistry(store)
    expect(listed(reg, 'a')).toMatchObject({ tasks: null, goal: null, canContinue: false })
    reg.append('a', todoWrite('c1', [{ content: 'x', status: 'in_progress', activeForm: 'Doing x' }]))
    // The log before the append is read off the loop; the append folds in after it.
    await reg.whenFoldWarm('a')
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
    // Waiting rows: the reset idles those (a running row waits for the
    // boot resume or the liveness sweep instead).
    store.updateSession('current', { status: 'waiting' })
    store.updateSession('stale', { status: 'waiting' })
    store.putFold({ sessionId: 'current', foldedSeq: 1, foldVersion: FOLD_VERSION, tasks: null, goal: null, canContinue: true, failure: null })
    store.putFold({ sessionId: 'stale', foldedSeq: 1, foldVersion: FOLD_VERSION, tasks: null, goal: null, canContinue: false, failure: null })
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

/** A long, varied log: task tools with their results, a TodoWrite, goals,
 *  errors and their recovery, passes, big bodies, subagent lanes. */
function variedLog(n: number): AgentEvent[] {
  const out: AgentEvent[] = []
  for (let i = 0; i < n; i++) {
    out.push({ type: 'user-text', text: `turn ${i} ${'u'.repeat(300)}`, ...(i % 3 === 0 ? { newPass: true } : {}) })
    out.push({ type: 'assistant-text', text: 'thinking aloud', delta: true })
    out.push({ type: 'tool-call', callId: `tc${i}`, name: 'TaskCreate', input: { subject: `Task ${i}`, activeForm: `Doing ${i}` } })
    out.push({ type: 'tool-result', callId: `tc${i}`, output: `Task #${i + 1} created successfully: Task ${i}`, isError: false })
    out.push({ type: 'tool-call', callId: `big${i}`, name: 'Write', input: { file_path: '/a.ts', content: 'x'.repeat(20_000) } })
    out.push({ type: 'tool-result', callId: `big${i}`, output: 'y'.repeat(30_000), isError: false })
    out.push({ type: 'tool-call', callId: `tu${i}`, name: 'TaskUpdate', input: { taskId: String(i + 1), status: i % 2 ? 'completed' : 'in_progress' } })
    if (i % 4 === 1) out.push(todoWrite(`tw${i}`, [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Bee' }]))
    if (i % 5 === 2) out.push({ type: 'goal', phase: i % 10 === 2 ? 'set' : 'updated', condition: `cond ${i}`, iterations: i })
    if (i % 6 === 3) out.push({ type: 'error', message: `boom ${i}`, failure: { kind: 'unknown', summary: 'x', detail: 'y' } as never })
    if (i % 7 === 4) out.push({ type: 'tool-call', callId: `sub${i}`, name: 'TodoWrite', input: { todos: [] }, parentCallId: 'p' })
    out.push({ type: 'assistant-text', text: `answer ${i}`, delta: false })
    out.push({ type: 'turn-complete' } as AgentEvent)
    out.push({ type: 'status', status: 'idle' })
  }
  return out
}

/** The whole log folded the old way, synchronously from seq 0. */
const reference = (id: string) => {
  const state = newFoldState()
  for (const row of store.eventsAfter(id, 0)) foldEvent(state, row)
  return toFoldRow(id, state)
}
const outputs = (row: ReturnType<typeof toFoldRow> | null | undefined) => row && { tasks: row.tasks, goal: row.goal, canContinue: row.canContinue, failure: row.failure, seq: row.foldedSeq }

describe('warm-up off the loop', () => {
  it('the slim payload the worker reads folds to exactly what the whole rows fold to', async () => {
    legacy('a', variedLog(40))
    const state = newFoldState()
    await foldLog(store, 'a', state, 0, store.lastSeq('a'), { chunk: 37, between: async () => {} })
    expect(outputs(toFoldRow('a', state))).toEqual(outputs(reference('a')))
    expect(reviveTodo(toFoldRow('a', state).todo)?.todo).toEqual(reviveTodo(reference('a').todo)?.todo)
  })

  it('a current fold row and task snapshot warm the fold at once, with no read of the log', async () => {
    legacy('a', variedLog(5))
    store.putFold(reference('a'))
    const reg = new SessionRegistry(store)
    const reads = vi.spyOn(store, 'readRows')
    const walks = vi.spyOn(store, 'eventsAfter')
    reg.append('a', { type: 'user-text', text: 'next' })
    expect(reg.isFoldWarm('a')).toBe(true)
    await reg.whenFoldWarm('a')
    expect(reads).not.toHaveBeenCalled()
    expect(walks).not.toHaveBeenCalled()
    expect(outputs(store.getFold('a'))).toEqual(outputs(reference('a')))
  })

  it('a row behind the log reads only the rows past its snapshot', async () => {
    legacy('a', variedLog(5))
    const stored = reference('a')
    store.putFold(stored)
    // Rows a crashed process appended without folding.
    for (const e of variedLog(2)) store.appendEvent('a', e)
    const reg = new SessionRegistry(store)
    const reads = vi.spyOn(store, 'readRows')
    reg.append('a', { type: 'user-text', text: 'next' })
    await reg.whenFoldWarm('a')
    expect(reads.mock.calls[0][1]).toMatchObject({ afterSeq: stored.foldedSeq })
    expect(outputs(store.getFold('a'))).toEqual(outputs(reference('a')))
  })

  it('rows appended while the warm-up reads fold in after it: none lost, none twice', async () => {
    legacy('a', variedLog(30))
    const reg = new SessionRegistry(store)
    // Hold the read open while the thread keeps streaming.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const read = store.readRows.bind(store)
    vi.spyOn(store, 'readRows').mockImplementation(async (id, opts) => {
      const rows = await read(id, opts)
      await gate
      return rows
    })
    const pushes: string[] = []
    reg.onMeta((m) => pushes.push(m.id))
    for (const e of variedLog(6)) reg.append('a', e)
    expect(reg.isFoldWarm('a')).toBe(true)
    // Nothing folded yet: the row holds the transcript flags alone (folded_seq 0), never a fold past the start.
    expect(store.getFold('a')?.foldedSeq ?? 0).toBe(0)
    release()
    await reg.whenFoldWarm('a')
    expect(outputs(store.getFold('a'))).toEqual(outputs(reference('a')))
    expect(reg.foldOf('a')?.foldedSeq).toBe(store.lastSeq('a'))
    // Warm from here: the next append folds at once.
    reg.append('a', todoWrite('late', [{ content: 'z', status: 'in_progress', activeForm: 'Zed' }]))
    expect(store.getFold('a')?.tasks).toEqual({ done: 0, total: 1, current: 'Zed' })
    expect(pushes).toContain('a')
  })

  it('reads through the reader worker when it is up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-fold-reader-'))
    const path = join(dir, 'w.db')
    const fileDb = openDb(path)
    const reader = new EventReader(path, { log: () => {} })
    try {
      const fileStore = new Store(fileDb, { reader })
      expect(await reader.ready).toBe(true)
      fileStore.insertSession(meta('w'))
      for (const e of variedLog(8)) fileStore.appendEvent('w', e)
      const asked = vi.spyOn(reader, 'query')
      const state = newFoldState()
      await foldLog(fileStore, 'w', state, 0, fileStore.lastSeq('w'), { chunk: 25, between: async () => {} })
      expect(asked).toHaveBeenCalled()
      const whole = newFoldState()
      for (const row of fileStore.eventsAfter('w', 0)) foldEvent(whole, row)
      expect(outputs(toFoldRow('w', state))).toEqual(outputs(toFoldRow('w', whole)))
    } finally {
      await reader.stop()
      fileDb.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
