import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDb, Store } from './db'
import type { SessionMeta } from '@shared/events'

let root: string
let db: ReturnType<typeof openDb>
let store: Store
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-search-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
})
afterEach(async () => {
  db.close()
  await rm(root, { recursive: true, force: true })
})

function meta(id: string, workspaceId: string): SessionMeta {
  const now = Date.now()
  return {
    id,
    parentId: null,
    projectId: null,
    workspaceId,
    threadType: 'chat',
    planPath: null,
    provider: 'claude',
    model: 'm',
    reasoning: 'medium',
    agentType: 'orchestrator',
    title: 'Untitled',
    cwd: root,
    status: 'idle',
    archived: false,
    pinned: false,
    permission: 'default',
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: 0,
    threadRules: null,
    nativeId: null,
    createdAt: now,
    updatedAt: now
  } as unknown as SessionMeta
}

it('finds user and assistant text rows, skipping deltas and nested output', () => {
  store.insertSession(meta('a', 'w1'))
  store.insertSession(meta('b', 'w2'))
  store.appendEvent('a', { type: 'user-text', text: 'Please rename the Zebra widget' })
  store.appendEvent('a', { type: 'assistant-text', text: 'Zeb', delta: true })
  store.appendEvent('a', { type: 'assistant-text', text: 'ra widget', delta: true })
  store.appendEvent('a', { type: 'assistant-text', text: 'Renamed the zebra widget.', delta: false })
  store.appendEvent('a', {
    type: 'assistant-text',
    text: 'subagent saw zebra too',
    delta: false,
    parentCallId: 'call-1'
  })
  store.appendEvent('b', { type: 'user-text', text: 'nothing here' })
  store.appendEvent('b', { type: 'assistant-text', text: 'ZEBRA in another workspace', delta: false })

  const all = store.searchEvents({ query: 'zebra' })
  expect(all.truncated).toBe(false)
  expect(all.hits.map((h) => `${h.sessionId}:${h.seq}:${h.role}`).sort()).toEqual([
    'a:1:user',
    'a:4:assistant',
    'b:2:assistant'
  ])
  expect(all.hits.find((h) => h.seq === 1 && h.sessionId === 'a')?.snippet).toBe(
    'Please rename the Zebra widget'
  )

  const scoped = store.searchEvents({ query: 'zebra', workspaceId: 'w2' })
  expect(scoped.hits).toHaveLength(1)
  expect(scoped.hits[0].sessionId).toBe('b')

  expect(store.searchEvents({ query: '   ' }).hits).toEqual([])
})

it('caps results and reports truncation', () => {
  store.insertSession(meta('a', 'w1'))
  for (let i = 0; i < 5; i++) store.appendEvent('a', { type: 'user-text', text: `needle ${i}` })
  const capped = store.searchEvents({ query: 'needle', limit: 3 })
  expect(capped.hits).toHaveLength(3)
  expect(capped.truncated).toBe(true)
  expect(store.searchEvents({ query: 'needle' }).truncated).toBe(false)
})
