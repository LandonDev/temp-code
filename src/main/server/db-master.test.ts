import { DatabaseSync } from 'node:sqlite'
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

describe('projects: master_thread_id', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tc-dbmaster-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('adds the column to a projects table created before it, null by default', () => {
    const path = join(root, 'old.db')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL, branch TEXT, cwd TEXT NOT NULL, created_at INTEGER NOT NULL)`)
    old.exec(`INSERT INTO projects (id, workspace_id, name, mode, branch, cwd, created_at) VALUES ('p', 'w', 'one', 'branch', 'b', '/one', 5)`)
    old.close()
    const db = openDb(path)
    const store = new Store(db)
    expect(store.listProjects()[0]).toMatchObject({ id: 'p', masterThreadId: null })
    db.close()
  })

  it('sets and clears the master pin', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertProject({ id: 'p', workspaceId: 'w', name: 'p', mode: 'worktree', branch: 'b', cwd: '/p', archived: false, createdAt: 1 })
    store.setProjectMaster('p', 's1')
    expect(store.listProjects()[0].masterThreadId).toBe('s1')
    store.setProjectMaster('p', null)
    expect(store.listProjects()[0].masterThreadId).toBeNull()
    db.close()
  })
})
