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

/** Two user turns of `perTurn` events: prompt, tool call/result pairs, done. */
function seedAgentLog(id: string, perTurn: number): void {
  store.insertSession(meta(id))
  let call = 0
  for (let t = 0; t < 2; t++) {
    const events: AgentEvent[] = [{ type: 'user-text', text: `prompt ${t}` }]
    while (events.length < perTurn - 1) {
      const callId = `call-${call++}`
      events.push({ type: 'tool-call', callId, name: 'Read', input: { path: `f${call}` } })
      events.push({ type: 'tool-result', callId, output: 'ok', isError: false })
    }
    events.push({ type: 'turn-complete', costUsd: 0.01 })
    for (const e of events) store.appendEvent(id, e)
  }
}

/** Transcript rows an event list folds into: prompts, tool calls, messages. */
const rowCount = (rows: { event: AgentEvent }[]): number => {
  const keys = new Set<string>()
  for (const { event } of rows) {
    if ('callId' in event && event.callId) keys.add(`c:${event.callId}`)
    else if ('msgId' in event && event.msgId) keys.add(`m:${event.msgId}`)
    else if (event.type === 'user-text') keys.add(`u:${keys.size}`)
  }
  return keys.size
}

describe('Store.events tail window (row budget)', () => {
  it('a 5,000-event two-turn log: the tail holds at most the budget in rows and starts on a row boundary', () => {
    seedAgentLog('s', 2500)
    const tail = store.events('s', { tail: 300 })
    expect(tail.length).toBeLessThanOrEqual(2 * 300 + 2)
    expect(rowCount(tail)).toBeLessThanOrEqual(300)
    expect(rowCount(tail)).toBeGreaterThanOrEqual(299)
    expect(tail[0].event.type).toBe('tool-call')
    expect(tail.at(-1)!.seq).toBe(5000)
  })

  it('the remainder before the tail plus the tail is the whole log, nothing lost or doubled', () => {
    seedAgentLog('s', 2500)
    const tail = store.events('s', { tail: 300 })
    const head = store.events('s', { afterSeq: 0, beforeSeq: tail[0].seq })
    expect(head.length + tail.length).toBe(5000)
    expect(seqs(head.concat(tail))).toEqual(Array.from({ length: 5000 }, (_, i) => i + 1))
    expect(seqs([...head, ...tail])).toEqual(seqs(store.eventsAfter('s', 0)))
  })

  it('a chat log: the budget counts prompts and messages, not deltas', () => {
    seed('s', 500)
    const tail = store.events('s', { tail: 40 })
    // 20 turns of prompt + one message: 40 rows, 200 events.
    expect(tail).toHaveLength(200)
    expect(tail[0].seq).toBe(4801)
    expect(tail[0].event.type).toBe('user-text')
    expect(tail.filter((r) => r.event.type === 'user-text')).toHaveLength(20)
  })

  it('a log shorter than the budget comes back whole', () => {
    seed('s', 5)
    expect(seqs(store.events('s', { tail: 300 }))).toEqual(seqs(store.eventsAfter('s', 0)))
    expect(store.events('s', { tail: 300 })).toHaveLength(50)
  })

  it('one endless stream of deltas: the scan cap bounds the tail', () => {
    store.insertSession(meta('s'))
    store.appendEvent('s', { type: 'user-text', text: 'go' })
    for (let i = 0; i < 8000; i++)
      store.appendEvent('s', { type: 'assistant-text', text: 'd', delta: true, msgId: 'm', blockIndex: 0 })
    const tail = store.events('s', { tail: 300 })
    expect(tail).toHaveLength(6000)
    expect(tail.at(-1)!.seq).toBe(8001)
  })

  it('tail respects afterSeq, so a reconnect gap never re-sends folded rows', () => {
    seed('s', 500)
    expect(seqs(store.events('s', { afterSeq: 4990, tail: 300 }))).toEqual(
      Array.from({ length: 10 }, (_, i) => 4991 + i)
    )
  })

  it('without options it equals eventsAfter(0)', () => {
    seed('s', 3)
    expect(store.events('s')).toEqual(store.eventsAfter('s', 0))
  })
})
