import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

/**
 * The local profile's `session.events` reads on the reader worker
 * (`registry.eventsAsync`, F33): the same page the synchronous read answers,
 * with the byte cap the renderer's head walk tolerates.
 */
let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-events-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

it('eventsAsync answers the page events answers: whole, a tail, a slice from afterSeq, a limited slice', async () => {
  const s = await registry.create({ cwd: root })
  for (let i = 0; i < 12; i++) {
    registry.append(s.id, { type: 'user-text', text: `q${i}` })
    registry.append(s.id, { type: 'assistant-text', text: `a${i}`, delta: false })
  }
  const same = async (opts: { afterSeq?: number; beforeSeq?: number; tail?: number; limit?: number }): Promise<void> => {
    const sync = registry.events(s.id, opts)
    const async = await registry.eventsAsync(s.id, opts)
    expect(async.map((r) => r.seq)).toEqual(sync.map((r) => r.seq))
    expect(async.map((r) => r.event)).toEqual(sync.map((r) => r.event))
  }
  await same({})
  await same({ tail: 3 })
  await same({ afterSeq: 5 })
  await same({ afterSeq: 2, limit: 4 })
  await same({ afterSeq: 0, beforeSeq: 10, limit: 100 })
  expect((await registry.eventsAsync(s.id, {})).length).toBe(24)
})
