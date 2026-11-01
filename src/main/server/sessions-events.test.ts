import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventsPage } from '@shared/wire'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventRow } from '@shared/events'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { sessionEvents } from './wire'

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

describe('session.events refuses an id this host does not show', () => {
  const ask = (sessionId: string, profile: 'local' | 'remote', subscribe = vi.fn()) =>
    sessionEvents(registry, { sessionId, afterSeq: 0, tail: 300, subscribe: true }, profile, subscribe)

  it('answers a known thread on both profiles, subscribing first', async () => {
    const s = await registry.create({ cwd: root })
    registry.append(s.id, { type: 'user-text', text: 'hi' })
    const subscribe = vi.fn()
    expect(((await ask(s.id, 'local', subscribe)) as EventRow[]).map((r) => r.event.type)).toContain('user-text')
    const page = (await ask(s.id, 'remote', subscribe)) as EventsPage
    expect(page.subscribed).toBe(true)
    expect(page.rows.length).toBeGreaterThan(0)
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('refuses an id it never had, on both profiles, without subscribing', async () => {
    const subscribe = vi.fn()
    await expect(ask('nope', 'local', subscribe)).rejects.toThrow('unknown session: nope')
    await expect(ask('nope', 'remote', subscribe)).rejects.toThrow('unknown session: nope')
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('refuses a deleted thread, a move tombstone and a landing still hidden', async () => {
    const gone = await registry.create({ cwd: root })
    registry.append(gone.id, { type: 'user-text', text: 'x' })
    await registry.delete(gone.id)
    await expect(ask(gone.id, 'local')).rejects.toThrow(`unknown session: ${gone.id}`)

    const moved = await registry.create({ cwd: root })
    const landing = await registry.create({ cwd: root })
    for (const id of [moved.id, landing.id]) registry.append(id, { type: 'user-text', text: 'x' })
    db.prepare(`UPDATE sessions SET moved_to = 'env_box' WHERE id = ?`).run(moved.id)
    db.prepare(`UPDATE sessions SET moving_from = 'env_mac', move_id = 'm1' WHERE id = ?`).run(landing.id)
    store.forgetSessions([moved.id, landing.id])
    await expect(ask(moved.id, 'remote')).rejects.toThrow('unknown session')
    await expect(ask(landing.id, 'local')).rejects.toThrow('unknown session')
  })
})
