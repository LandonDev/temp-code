import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/events'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

const started: string[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: { session: { model: string }; emit: (event: AgentEvent) => void }) => {
        started.push(ctx.session.model)
        return { send: async () => {}, interrupt: () => {}, dispose: async () => {} }
      }
    }
  }
}))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  started.length = 0
  root = await mkdtemp(join(tmpdir(), 'tc-model-repair-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

it('a respawn from a row holding a display slug hands the driver the catalog id', async () => {
  const session = await registry.create({ cwd: root, provider: 'claude', model: 'claude-fable-5-1' })
  await registry.disposeAll()
  // Poison the row behind the registry's back, as the pre-v180 send did,
  // then boot again on the same store and wake the thread.
  db.prepare(`UPDATE sessions SET model = 'fable-5.1' WHERE id = ?`).run(session.id)
  registry = new SessionRegistry(store)
  await registry.send(session.id, 'hi')
  expect(started.at(-1)).toBe('claude-fable-5-1')
})
