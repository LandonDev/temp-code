import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/events'
import { AddonStore } from './addonStore'
import { watchScopeFlips } from './addons/scopeFlip'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

/** One stub driver for every provider: each start records its spawn and hands back its emit. */
const emits = new Map<string, (event: AgentEvent) => void>()
const spawned: string[] = []
const disposed: string[] = []
vi.mock('./drivers', () => {
  const driver = (id: string) => ({
    id,
    start: async (ctx: { session: { id: string }; emit: (event: AgentEvent) => void }) => {
      emits.set(ctx.session.id, ctx.emit)
      spawned.push(ctx.session.id)
      return { send: async () => {}, interrupt: () => {}, dispose: async () => void disposed.push(ctx.session.id) }
    }
  })
  return { BUILT_IN_DRIVERS: { claude: driver('claude'), codex: driver('codex'), muse: driver('muse') } }
})

let root: string
let db: ReturnType<typeof openDb>
let registry: SessionRegistry
beforeEach(async () => {
  emits.clear()
  spawned.length = 0
  disposed.length = 0
  root = await mkdtemp(join(tmpdir(), 'tc-addons-reboot-'))
  db = openDb(join(root, 'test.db'))
  registry = new SessionRegistry(new Store(db))
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A booted thread at rest whose emit we hold. */
async function atRest(provider: 'claude' | 'codex' | 'muse', model: string): Promise<string> {
  const session = await registry.create({ cwd: root, provider, model })
  await registry.send(session.id, 'hello')
  emits.get(session.id)!({ type: 'status', status: 'idle' })
  return session.id
}
const spawnsOf = (id: string) => spawned.filter((s) => s === id).length

it('rebootAtNextTurn puts a live handle down at the next turn start, never mid-turn', async () => {
  const id = await atRest('codex', 'gpt-6.1-sol')
  expect(registry.rebootAtNextTurn('no-such-thread')).toBe(false)
  emits.get(id)!({ type: 'status', status: 'running' })
  expect(registry.rebootAtNextTurn(id)).toBe(true)
  await registry.send(id, 'a steer into the running turn')
  expect(disposed).toEqual([])
  expect(spawnsOf(id)).toBe(1)
  emits.get(id)!({ type: 'status', status: 'idle' })
  await sleep(20)
  await registry.send(id, 'the next turn')
  expect(disposed).toEqual([id])
  expect(spawnsOf(id)).toBe(2)
  emits.get(id)!({ type: 'status', status: 'idle' })
  await registry.send(id, 'and the one after keeps its handle')
  expect(spawnsOf(id)).toBe(2)
})

it('a scope gaining its first add-on marks its codex and Muse handles, not its claude ones', async () => {
  const codex = await atRest('codex', 'gpt-6.1-sol')
  const muse = await atRest('muse', 'muse-spark-1.3')
  const claude = await atRest('claude', 'claude-sonnet-5-5')
  const store = new AddonStore(new DatabaseSync(':memory:'))
  const stop = watchScopeFlips({ store, sessions: registry, rebootAtNextTurn: (id) => registry.rebootAtNextTurn(id) })
  const row = store.set({ name: 'fake', workspaceId: null, spec: { transport: 'stdio', command: 'x', args: [], env: [], auth: 'none' } }, { kind: 'person' })
  for (const id of [codex, muse, claude]) await registry.send(id, 'next')
  expect(spawnsOf(codex)).toBe(2)
  expect(spawnsOf(muse)).toBe(2)
  expect(spawnsOf(claude)).toBe(1)
  // A second add-on changes nothing for the bridge; removing the last flips again.
  for (const id of [codex, muse]) emits.get(id)!({ type: 'status', status: 'idle' })
  const second = store.set({ name: 'other', workspaceId: null, spec: { transport: 'stdio', command: 'y', args: [], env: [], auth: 'none' } }, { kind: 'person' })
  await registry.send(codex, 'again')
  expect(spawnsOf(codex)).toBe(2)
  emits.get(codex)!({ type: 'status', status: 'idle' })
  store.remove(second.id)
  store.remove(row.id)
  await registry.send(codex, 'after the last went')
  expect(spawnsOf(codex)).toBe(3)
  stop()
})
