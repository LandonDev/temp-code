import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { SessionMeta } from '@shared/events'

/**
 * The boot's empty-thread sweep (CLAUDE.md "Stability 2"): a root thread an
 * older New thread… created at the click, never written to, is archived a
 * day later; anything that might be the person's is left alone.
 */
const DAY = 24 * 60 * 60 * 1000
const NOW = 10 * DAY

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    parentId: null,
    provider: 'claude',
    model: 'claude-opus-5-5',
    reasoning: 'medium',
    agentType: 'implementer',
    title: 'New chat',
    cwd: '/repo',
    status: 'idle',
    archived: false,
    permission: 'edits',
    nativeId: null,
    pinned: false,
    fast: false,
    ultrafast: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    projectId: null,
    workspaceId: null,
    threadType: 'chat',
    planPath: null,
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    ...extra
  }) as SessionMeta

let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.close()
  db.close()
})

describe('archiveEmptyThreads', () => {
  it('archives an old empty placeholder thread and nothing that might be the person\'s', async () => {
    store.insertSession(meta('empty'))
    store.insertSession(meta('empty-plan', { title: 'New plan', threadType: 'planning' }))
    store.insertSession(meta('young', { createdAt: NOW - 60_000 }))
    store.insertSession(meta('with-row'))
    store.appendEvent('with-row', { type: 'user', text: 'hello' } as never)
    store.insertSession(meta('queued'))
    ;(registry as unknown as { queues: Map<string, unknown[]> }).queues.set('queued', [{ id: 'q1', text: 'first' }])
    store.insertSession(meta('parent', { title: 'A real thread' }))
    store.appendEvent('parent', { type: 'user', text: 'go' } as never)
    store.insertSession(meta('subagent', { parentId: 'parent' }))
    store.insertSession(meta('master', { isMaster: true }))
    store.insertSession(meta('batch-child', { masterId: 'master' }))
    store.insertSession(meta('pinned', { pinned: true }))
    store.insertSession(meta('titled', { title: 'Fix the login flow' }))
    store.insertSession(meta('waiting', { status: 'waiting' }))

    expect(await registry.archiveEmptyThreads(NOW)).toBe(2)
    expect(store.getSession('empty')?.archived).toBe(true)
    expect(store.getSession('empty-plan')?.archived).toBe(true)
    for (const id of ['young', 'with-row', 'queued', 'parent', 'subagent', 'master', 'batch-child', 'pinned', 'titled', 'waiting']) {
      expect(store.getSession(id)?.archived, id).toBe(false)
    }
  })
})
