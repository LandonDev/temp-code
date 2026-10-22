import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import type { SessionMeta } from '@shared/events'

/** Master threads (CLAUDE.md "Master threads"): the session row's master and
 *  queue columns, and the project's master pin, round-trip through the store. */

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
  updatedAt: 1,
  ...patch
})

describe('sessions: master_id and after_id', () => {
  let db: ReturnType<typeof openDb>
  let store: Store
  beforeEach(() => {
    db = openDb(':memory:')
    store = new Store(db)
  })
  afterEach(() => db.close())

  it('round-trips masterId and after through insert and update', () => {
    store.insertSession(meta('m'))
    store.insertSession(meta('a', { masterId: 'm' }))
    store.insertSession(meta('b', { masterId: 'm', after: 'a', status: 'queued' }))
    expect(store.getSession('m')).toMatchObject({ masterId: null, after: null })
    expect(store.getSession('a')).toMatchObject({ masterId: 'm', after: null })
    expect(store.getSession('b')).toMatchObject({ masterId: 'm', after: 'a', status: 'queued' })
    // The sibling landed: the queue link clears, the master link stays.
    store.updateSession('b', { after: null, status: 'starting' })
    expect(store.getSession('b')).toMatchObject({ masterId: 'm', after: null, status: 'starting' })
    // An undefined key in a patch never clears the stored value.
    store.updateSession('a', { title: 'renamed' })
    expect(store.getSession('a')).toMatchObject({ masterId: 'm', title: 'renamed' })
  })

  it('answers the children of a master by masterId', () => {
    store.insertSession(meta('m'))
    store.insertSession(meta('a', { masterId: 'm' }))
    store.insertSession(meta('x'))
    expect(store.listSessions().filter((s) => s.masterId === 'm').map((s) => s.id)).toEqual(['a'])
  })
})

describe('sessions: is_master', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tc-dbmaster-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips the flag through insert and update, off by default', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertSession(meta('m'))
    store.insertSession(meta('n', { isMaster: true }))
    expect(store.getSession('m')?.isMaster).toBe(false)
    expect(store.getSession('n')?.isMaster).toBe(true)
    store.updateSession('m', { isMaster: true })
    store.updateSession('n', { isMaster: false })
    expect(store.getSession('m')?.isMaster).toBe(true)
    expect(store.getSession('n')?.isMaster).toBe(false)
    // An undefined key in a patch never clears the flag.
    store.updateSession('m', { title: 'renamed' })
    expect(store.getSession('m')?.isMaster).toBe(true)
    db.close()
  })

  it("a database from the project-pin days: the project's master_thread_id becomes the flag once, and the column is then ignored", () => {
    const path = join(root, 'old.db')
    const first = openDb(path)
    const s1 = new Store(first)
    s1.insertProject({ id: 'p', workspaceId: 'w', name: 'p', mode: 'worktree', branch: 'b', cwd: '/p', archived: false, createdAt: 1 })
    s1.insertSession(meta('m', { projectId: 'p' }))
    s1.insertSession(meta('x', { projectId: 'p' }))
    s1.insertSession(meta('sub', { projectId: 'p', parentId: 'm' }))
    // The old pin, written the old way, and the flag column dropped as an old database would lack it.
    first.exec(`UPDATE projects SET master_thread_id = 'm' WHERE id = 'p'`)
    first.exec(`ALTER TABLE sessions DROP COLUMN is_master`)
    first.close()
    const second = openDb(path)
    const s2 = new Store(second)
    expect(s2.getSession('m')?.isMaster).toBe(true)
    expect(s2.getSession('x')?.isMaster).toBe(false)
    // Unpinned here, the old column still names it: the next boot leaves the flag alone.
    s2.updateSession('m', { isMaster: false })
    second.exec(`UPDATE projects SET master_thread_id = 'sub' WHERE id = 'p'`)
    second.close()
    const third = openDb(path)
    const s3 = new Store(third)
    expect(s3.getSession('m')?.isMaster).toBe(false)
    expect(s3.getSession('sub')?.isMaster).toBe(false)
    expect(s3.listProjects()[0]).not.toHaveProperty('masterThreadId')
    third.close()
  })
})
