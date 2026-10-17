import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import {
  ARCHIVE_IDLE_DAYS_KEY,
  ColdMover,
  archivable,
  openSessionIds,
  sweepArchive
} from './cold'
import type { AgentEvent, SessionMeta } from '@shared/events'

let db: ReturnType<typeof openDb>
let store: Store
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
})
afterEach(() => db.close())

const DAY = 86_400_000
const NOW = 100 * DAY

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
  updatedAt: NOW - 10 * DAY,
  ...extra
})

const noYield = async (): Promise<void> => {}
const none = new Set<string>()
const pick = (sessions: SessionMeta[], extra: Partial<Parameters<typeof archivable>[0]> = {}): string[] =>
  archivable({ sessions, now: NOW, idleDays: 7, queued: none, open: none, ...extra }).sort()

describe('archivable', () => {
  it('archives an idle tree whole and leaves a fresh root, whose settled old child goes on its own', () => {
    const sessions = [
      meta('old'),
      meta('old-kid', { parentId: 'old' }),
      meta('new', { updatedAt: NOW - DAY }),
      meta('new-kid', { parentId: 'new' }),
      meta('new-kid-today', { parentId: 'new', updatedAt: NOW - DAY / 2 })
    ]
    expect(pick(sessions)).toEqual(['new-kid', 'old', 'old-kid'])
  })

  it('a recently touched descendant keeps its old root', () => {
    expect(pick([meta('r'), meta('k', { parentId: 'r', updatedAt: NOW - DAY })])).toEqual([])
  })

  it('never archives pinned, live, paused, queued or open trees', () => {
    for (const status of ['running', 'starting', 'waiting', 'paused', 'watching'] as const) {
      expect(pick([meta('r'), meta('k', { parentId: 'r', status })])).toEqual([])
    }
    expect(pick([meta('r', { pinned: true }), meta('k', { parentId: 'r' })])).toEqual([])
    expect(pick([meta('r'), meta('k', { parentId: 'r', pinned: true })])).toEqual([])
    expect(pick([meta('r'), meta('k', { parentId: 'r' })], { queued: new Set(['k']) })).toEqual([])
    expect(pick([meta('r'), meta('k', { parentId: 'r' })], { open: new Set(['r']) })).toEqual([])
    expect(pick([meta('r', { status: 'error' }), meta('k', { parentId: 'r', status: 'done' })])).toEqual(
      ['k', 'r']
    )
  })

  it('finishes a tree whose root was archived by hand, skips wholly archived ones', () => {
    expect(pick([meta('r', { archived: true }), meta('k', { parentId: 'r' })])).toEqual(['k'])
    expect(pick([meta('r', { archived: true }), meta('k', { parentId: 'r', archived: true })])).toEqual([])
  })

  it('honours the idle window', () => {
    const sessions = [meta('r', { updatedAt: NOW - 8 * DAY })]
    expect(archivable({ sessions, now: NOW, idleDays: 7, queued: none, open: none })).toEqual(['r'])
    expect(archivable({ sessions, now: NOW, idleDays: 30, queued: none, open: none })).toEqual([])
  })

  it('archives a settled subagent subtree under a root that stays, after the subagent window', () => {
    const fresh = NOW - DAY / 2
    const sessions = [
      meta('r', { updatedAt: fresh }),
      meta('done', { parentId: 'r', updatedAt: NOW - 2 * DAY, status: 'done' }),
      meta('done-kid', { parentId: 'done', updatedAt: NOW - 2 * DAY }),
      meta('failed', { parentId: 'r', updatedAt: NOW - 2 * DAY, status: 'error' }),
      meta('today', { parentId: 'r', updatedAt: fresh }),
      meta('stale-but-busy-kid', { parentId: 'r', updatedAt: NOW - 3 * DAY }),
      meta('busy', { parentId: 'stale-but-busy-kid', status: 'running', updatedAt: NOW - 3 * DAY })
    ]
    expect(pick(sessions)).toEqual(['done', 'done-kid', 'failed'])
    expect(pick(sessions, { subagentIdleDays: 3 })).toEqual([])
    expect(pick(sessions, { open: new Set(['done-kid']) })).toEqual(['failed'])
    expect(pick(sessions, { queued: new Set(['failed']) })).toEqual(['done', 'done-kid'])
    // A root someone holds keeps its board whole.
    expect(pick(sessions, { open: new Set(['r']) })).toEqual([])
    expect(pick(sessions.map((s) => (s.id === 'r' ? { ...s, status: 'running' as const } : s)))).toEqual([])
    expect(pick(sessions.map((s) => (s.id === 'r' ? { ...s, pinned: true } : s)))).toEqual([])
  })

  it('a settled grandchild under a fresh child archives on its own', () => {
    const sessions = [
      meta('r', { updatedAt: NOW - DAY / 4 }),
      meta('c', { parentId: 'r', updatedAt: NOW - DAY / 4 }),
      meta('g', { parentId: 'c', updatedAt: NOW - 2 * DAY, status: 'done' }),
      meta('g-archived', { parentId: 'c', updatedAt: NOW - 2 * DAY, archived: true })
    ]
    expect(pick(sessions)).toEqual(['g'])
  })
})

describe('openSessionIds', () => {
  it('collects layout leaves and session stubs from every window snapshot', () => {
    const main = JSON.stringify({
      tabs: [
        { layout: { type: 'leaf', id: 'a' } },
        {
          layout: {
            type: 'split',
            children: [{ type: 'leaf', id: 'b' }, { type: 'split', children: [{ type: 'leaf', id: 'c' }] }]
          }
        }
      ],
      sessions: [{ id: 'd' }]
    })
    const other = JSON.stringify({ tabs: [{ layout: { type: 'leaf', id: 'e' } }] })
    expect([...openSessionIds([main, other, 'not json'])].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

function seed(id: string, n: number, extra: Partial<SessionMeta> = {}): void {
  store.insertSession(meta(id, extra))
  for (let i = 0; i < n; i++) {
    const e: AgentEvent = { type: 'assistant-text', text: `t${i}`, delta: false }
    store.appendEvent(id, e)
  }
}

describe('ColdMover', () => {
  it('drains archived sessions to cold in batches and brings strays back', async () => {
    seed('a', 25, { archived: true })
    seed('b', 5, { archived: true })
    seed('c', 3)
    store.flushEvents()
    // c was left cold by a crash after an unarchive: back to hot.
    db.exec(`INSERT INTO cold.events SELECT * FROM events WHERE session_id = 'c'; DELETE FROM events WHERE session_id = 'c'; UPDATE sessions SET cold = 1 WHERE id = 'c'`)
    const fresh = new Store(db)
    expect(fresh.isCold('c')).toBe(true)
    const progress: { sessionId: string; moved: number; done: boolean }[] = []
    const mover = new ColdMover(fresh, { batch: 10, yieldNow: noYield, onProgress: (p) => progress.push(p) })
    await mover.kick()
    expect(fresh.eventCounts('a')).toEqual({ hot: 0, cold: 25 })
    expect(fresh.eventCounts('b')).toEqual({ hot: 0, cold: 5 })
    expect(fresh.eventCounts('c')).toEqual({ hot: 3, cold: 0 })
    expect(fresh.isCold('c')).toBe(false)
    expect(progress.filter((p) => p.sessionId === 'a').map((p) => p.moved)).toEqual([10, 10, 5])
    expect(fresh.coldBacklog()).toEqual({ toCold: [], toHot: [] })
  })

  it('resumes after an interrupted batch', async () => {
    seed('a', 25, { archived: true })
    // One batch landed, then the app quit.
    store.moveToCold('a', 10)
    const reopened = new Store(db)
    expect(reopened.coldBacklog().toCold).toEqual(['a'])
    await new ColdMover(reopened, { batch: 10, yieldNow: noYield }).kick()
    expect(reopened.eventCounts('a')).toEqual({ hot: 0, cold: 25 })
    expect(reopened.eventsAfter('a', 0).map((r) => r.seq)).toHaveLength(25)
  })

  it('stops on a session unarchived mid-move', async () => {
    seed('a', 25, { archived: true })
    let batches = 0
    const mover = new ColdMover(store, {
      batch: 10,
      yieldNow: async () => {
        if (++batches === 1) store.updateSession('a', { archived: false })
      }
    })
    await mover.kick()
    expect(store.eventCounts('a')).toEqual({ hot: 25, cold: 0 })
    expect(store.isCold('a')).toBe(false)
  })

  it('a second kick during a drain runs again afterwards', async () => {
    seed('a', 5, { archived: true })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const mover = new ColdMover(store, { batch: 2, yieldNow: () => gate })
    const first = mover.kick()
    seed('b', 5, { archived: true })
    const second = mover.kick()
    expect(second).toBe(first)
    release()
    await first
    // the re-run is a fresh drain
    await new Promise((r) => setTimeout(r, 10))
    expect(store.eventCounts('b')).toEqual({ hot: 0, cold: 5 })
  })
})

describe('sweepArchive', () => {
  it('archives idle trees through the registry and drops their checkpoints', async () => {
    seed('old', 2)
    seed('old-kid', 2, { parentId: 'old' })
    seed('fresh', 2, { updatedAt: NOW - DAY })
    seed('open', 2)
    seed('queued', 2)
    seed('pinned', 2, { pinned: true })
    store.setSetting(
      'renderer.workspaceSnapshot.v1:second',
      JSON.stringify({ tabs: [{ layout: { type: 'leaf', id: 'open' } }] })
    )
    const registry = new SessionRegistry(store)
    const discarded: string[] = []
    const kicks: number[] = []
    registry.coldMover = { kick: () => kicks.push(1) }
    const ids = await sweepArchive(
      {
        store,
        list: () => registry.list({ archived: undefined }),
        // queueAdd on an idle thread drains at once; the queue rule itself
        // is covered above, this checks the sweep asks.
        queueList: (id) => (id === 'queued' ? [{ id: 'm' }] : registry.queueList(id)),
        setArchived: (id, archived) => registry.setArchived(id, archived),
        checkpoints: { discard: async (id) => void discarded.push(id) }
      },
      { now: NOW, yieldNow: noYield }
    )
    expect(ids.sort()).toEqual(['old', 'old-kid'])
    expect(discarded.sort()).toEqual(['old', 'old-kid'])
    expect(store.getSession('old')?.archived).toBe(true)
    expect(store.getSession('old-kid')?.archived).toBe(true)
    for (const id of ['fresh', 'open', 'queued', 'pinned']) expect(store.getSession(id)?.archived).toBe(false)
    expect(kicks.length).toBe(2)
    // the default list no longer shows them; the archived list does
    expect(registry.list().map((s) => s.id).sort()).toEqual(['fresh', 'open', 'pinned', 'queued'])
    expect(registry.list({ archived: true }).map((s) => s.id).sort()).toEqual(['old', 'old-kid'])
  })

  it('reads the window from the settings table', async () => {
    seed('r', 1, { updatedAt: NOW - 8 * DAY })
    store.setSetting(ARCHIVE_IDLE_DAYS_KEY, '30')
    const registry = new SessionRegistry(store)
    const host = {
      store,
      list: () => registry.list({ archived: undefined }),
      queueList: (id: string) => registry.queueList(id),
      setArchived: (id: string, archived: boolean) => registry.setArchived(id, archived),
      checkpoints: null
    }
    expect(await sweepArchive(host, { now: NOW, yieldNow: noYield })).toEqual([])
    store.setSetting(ARCHIVE_IDLE_DAYS_KEY, null)
    expect(await sweepArchive(host, { now: NOW, yieldNow: noYield })).toEqual(['r'])
  })
})
