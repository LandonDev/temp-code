import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import type { AgentEvent, SessionMeta } from '@shared/events'

let db: ReturnType<typeof openDb>
let store: Store
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string): SessionMeta => ({
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

/** `turns` user turns of 10 events each: prompt, 8 deltas, final. */
function seed(id: string, turns: number): void {
  store.insertSession(meta(id))
  for (let t = 0; t < turns; t++) {
    const events: AgentEvent[] = [{ type: 'user-text', text: `prompt ${t}` }]
    for (let i = 0; i < 8; i++)
      events.push({ type: 'assistant-text', text: `d${i} `, delta: true, msgId: `m${t}` })
    events.push({ type: 'turn-complete', costUsd: 0.01 })
    for (const e of events) store.appendEvent(id, e)
  }
}

const seqs = (rows: { seq: number }[]): number[] => rows.map((r) => r.seq)

describe('Store.events tail window', () => {
  it('tail returns the last N turns, starting at a user prompt', () => {
    seed('s', 500)
    const tail = store.events('s', { tail: 20 })
    expect(tail).toHaveLength(200)
    expect(tail[0].seq).toBe(4801)
    expect(tail[0].event.type).toBe('user-text')
    expect(tail.at(-1)!.seq).toBe(5000)
    expect(tail.filter((r) => r.event.type === 'user-text')).toHaveLength(20)
  })

  it('the remainder before the tail plus the tail is the whole log, nothing lost or doubled', () => {
    seed('s', 500)
    const tail = store.events('s', { tail: 20 })
    const head = store.events('s', { afterSeq: 0, beforeSeq: tail[0].seq })
    expect(head).toHaveLength(4800)
    expect(seqs([...head, ...tail])).toEqual(seqs(store.eventsAfter('s', 0)))
    expect(seqs(head.concat(tail))).toEqual(Array.from({ length: 5000 }, (_, i) => i + 1))
  })

  it('a log shorter than the tail comes back whole', () => {
    seed('s', 5)
    expect(seqs(store.events('s', { tail: 20 }))).toEqual(seqs(store.eventsAfter('s', 0)))
    expect(store.events('s', { tail: 20 })).toHaveLength(50)
  })

  it('tail respects afterSeq, so a reconnect gap never re-sends folded rows', () => {
    seed('s', 500)
    expect(seqs(store.events('s', { afterSeq: 4990, tail: 20 }))).toEqual(
      Array.from({ length: 10 }, (_, i) => 4991 + i)
    )
  })

  it('without options it equals eventsAfter(0)', () => {
    seed('s', 3)
    expect(store.events('s')).toEqual(store.eventsAfter('s', 0))
  })
})
