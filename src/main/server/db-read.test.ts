import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { SessionMeta } from '@shared/events'

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async () => ({ send: async () => {}, interrupt: () => {}, dispose: async () => {} })
    }
  }
}))

/** Read marks (CLAUDE.md "Read and unread: the host's mark"): the host owns
 *  one read mark per thread, compared with its updatedAt by every client. */

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
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
  updatedAt: 100,
  ...patch
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-read-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('sessions.read_at', () => {
  it('a database from before the mark starts with every thread read; a thread made since starts unread', () => {
    const path = join(root, 'old.db')
    const first = openDb(path)
    new Store(first).insertSession(meta('old', { updatedAt: 500 }))
    first.close()
    // Back to the old shape: the column did not exist.
    const raw = new DatabaseSync(path)
    raw.exec(`ALTER TABLE sessions DROP COLUMN read_at`)
    raw.close()

    const db = openDb(path)
    const store = new Store(db)
    expect(store.getSession('old')?.readAt).toBe(500)
    store.insertSession(meta('new', { updatedAt: 600 }))
    expect(store.getSession('new')?.readAt).toBe(0)
    db.close()
  })

  it('a mark moves forward only, never past the row, and leaves updatedAt alone', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertSession(meta('t', { updatedAt: 100 }))
    expect(store.markSessionRead('t', 80)?.readAt).toBe(80)
    expect(store.markSessionRead('t', 50)).toBeNull()
    // A client clock ahead of the host's is held to the row's updatedAt.
    expect(store.markSessionRead('t', 9_999)?.readAt).toBe(100)
    expect(store.getSession('t')?.updatedAt).toBe(100)
    expect(store.markSessionRead('t')).toBeNull()
    expect(store.markSessionUnread('t')?.readAt).toBe(0)
    expect(store.markSessionUnread('t')).toBeNull()
    expect(store.getSession('t')?.updatedAt).toBe(100)
    // No `at`: read as the row stands.
    expect(store.markSessionRead('t')?.readAt).toBe(100)
    expect(store.markSessionRead('gone')).toBeNull()
    db.close()
  })

  it('a later edit unreads the thread until it is read again', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertSession(meta('t', { updatedAt: 100 }))
    store.markSessionRead('t')
    const edited = store.updateSession('t', { title: 'renamed' })!
    expect(edited.updatedAt).toBeGreaterThan(edited.readAt!)
    db.close()
  })
})

describe('registry.markRead / markUnread', () => {
  it('pushes the meta with the mark, skips unknown ids, and pushes nothing when nothing moved', async () => {
    const db = openDb(join(root, 'r.db'))
    const store = new Store(db)
    const registry = new SessionRegistry(store)
    const a = await registry.create({ cwd: root })
    const b = await registry.create({ cwd: root })
    const pushed: { id: string; readAt?: number; updatedAt: number }[] = []
    registry.onMeta((m) => pushed.push({ id: m.id, readAt: m.readAt, updatedAt: m.updatedAt }))

    registry.markRead([{ sessionId: a.id }, { sessionId: 'nope' }, { sessionId: b.id, at: 1 }])
    const updatedA = registry.get(a.id)!.updatedAt
    expect(registry.get(a.id)?.readAt).toBe(updatedA)
    expect(registry.get(b.id)?.readAt).toBe(1)
    expect(pushed.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
    expect(pushed.find((p) => p.id === a.id)).toMatchObject({ readAt: updatedA, updatedAt: updatedA })

    pushed.length = 0
    registry.markRead([{ sessionId: a.id }])
    expect(pushed).toEqual([])

    registry.markUnread([a.id, 'nope'])
    expect(registry.get(a.id)?.readAt).toBe(0)
    expect(pushed).toEqual([{ id: a.id, readAt: 0, updatedAt: updatedA }])
    await registry.close()
    db.close()
  })
})
