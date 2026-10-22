import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async () => ({ send: async () => {}, interrupt: () => {}, dispose: async () => {} })
    }
  }
}))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-index-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

it('the index follows every row the store writes: meta pushes and row writes never re-read the table', async () => {
  const parent = await registry.create({ cwd: root })
  const child = await registry.create({ cwd: root, parentId: parent.id })
  const pushes: string[] = []
  registry.onMeta((m) => pushes.push(m.id))
  store.updateSession(parent.id, { title: 'parent' })
  const lists = vi.spyOn(store, 'listSessions')

  expect(registry.get(parent.id)?.title).toBe('parent')
  // Twenty tool calls: each moves the activity line and pushes the child
  // and its root, and none touches the sessions table.
  for (let i = 0; i < 20; i++) {
    registry.append(child.id, { type: 'tool-call', callId: `c${i}`, name: 'Read', input: { file_path: `/f${i}.ts` } })
  }
  expect(pushes.length).toBeGreaterThanOrEqual(40)
  registry.childrenOf(parent.id)
  registry.runningCount()

  // A row write patches the index in place: the parent's tree flag comes
  // from its children's rows, and it moves without a reread.
  expect(registry.get(parent.id)?.treeHasLiveWork).toBe(false)
  store.updateSession(child.id, { status: 'running' })
  expect(registry.get(parent.id)?.treeHasLiveWork).toBe(true)
  expect(registry.runningCount()).toBe(1)
  expect(lists).not.toHaveBeenCalled()

  // list() is the authority: it reads the table, as before.
  expect(registry.list().map((s) => s.id).sort()).toEqual([parent.id, child.id].sort())
  expect(lists).toHaveBeenCalledTimes(1)
  // A write the store cannot describe (a move's raw SQL) bumps the version:
  // the next read builds the index again, once.
  store.forgetSessions([child.id])
  registry.get(parent.id)
  registry.runningCount()
  expect(lists).toHaveBeenCalledTimes(2)
})

it('300 metas changing (context ticks, statuses, accounts) cost no listSessions call', async () => {
  const ids: string[] = []
  for (let i = 0; i < 30; i++) ids.push((await registry.create({ cwd: root, provider: 'claude' })).id)
  const pushes: string[] = []
  registry.onMeta((m) => pushes.push(m.id))
  const lists = vi.spyOn(store, 'listSessions')
  const version = store.sessionsVersion
  for (let i = 0; i < 300; i++) {
    const id = ids[i % ids.length]
    if (i % 3 === 0) registry.append(id, { type: 'context', tokens: 1000 + i, window: 200_000 })
    else if (i % 3 === 1) registry.append(id, { type: 'status', status: i % 2 ? 'running' : 'idle' })
    else store.setSessionAccount(id, `a${i}@x`)
  }
  await registry.scheduler.tick()
  registry.sweepLiveness(60_000)
  expect(pushes.length).toBeGreaterThanOrEqual(200)
  expect(lists).not.toHaveBeenCalled()
  // A context tick is not a version bump; the row it wrote is the indexed one.
  expect(store.sessionsVersion).toBe(version)
  const last = ids[297 % ids.length]
  expect(registry.get(last)?.context).toEqual({ tokens: 1297, window: 200_000 })
  expect(store.getSession(last)?.context).toEqual({ tokens: 1297, window: 200_000 })
  expect(store.getSession(ids[2])?.account).toBe(registry.get(ids[2])?.account)
})

it('writes the store can describe patch the index; only the rest bump the version', async () => {
  const session = await registry.create({ cwd: root })
  const child = await registry.create({ cwd: root, parentId: session.id })
  const v = store.sessionsVersion
  store.updateSession(session.id, { title: 't' })
  store.setSessionAccount(session.id, 'a@x')
  store.setSessionContext(session.id, { tokens: 1, window: null })
  store.setSessionWorkspace(session.id, 'w')
  store.setRetyped(session.id, true)
  expect(store.sessionsVersion).toBe(v)
  expect(registry.get(session.id)).toMatchObject({ title: 't', account: 'a@x', workspaceId: 'w' })
  store.deleteSessionTree(session.id)
  expect(store.sessionsVersion).toBe(v)
  expect(registry.get(session.id)).toBeNull()
  expect(registry.get(child.id)).toBeNull()
  store.forgetSessions([session.id])
  expect(store.sessionsVersion).toBeGreaterThan(v)
})

it("byMaster follows a batch: children created, adopted, archived and removed, with no list", async () => {
  const master = await registry.create({ cwd: root, provider: 'claude', title: 'M' })
  registry.setMaster(master.id, true)
  const a = await registry.create({ cwd: root, provider: 'claude', masterId: master.id, title: 'A' })
  const loose = await registry.create({ cwd: root, provider: 'claude', title: 'Loose' })
  const lists = vi.spyOn(store, 'listSessions')
  const children = (): string[] => registry.batchChildren(master.id).map((s) => s.id).sort()
  expect(children()).toEqual([a.id])
  registry.setBatchMembership(loose.id, master.id)
  const b = await registry.create({ cwd: root, provider: 'claude', masterId: master.id, title: 'B' })
  expect(children()).toEqual([a.id, loose.id, b.id].sort())
  await registry.setArchived(a.id, true)
  expect(children()).toEqual([loose.id, b.id].sort())
  store.deleteSessionTree(b.id)
  expect(children()).toEqual([loose.id])
  expect(lists).not.toHaveBeenCalled()
})

it('deleting a thread removes its HTML pages along with its children\'s', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { setHtmlRenderRoot } = await import('./htmlRender')
  const pages = join(root, 'html-renders')
  setHtmlRenderRoot(pages)
  const parent = await registry.create({ cwd: root })
  const child = await registry.create({ cwd: root, parentId: parent.id })
  const other = await registry.create({ cwd: root })
  for (const id of [parent.id, child.id, other.id]) {
    await mkdir(join(pages, id), { recursive: true })
    await writeFile(join(pages, id, 'p.html'), '<p/>')
  }
  await registry.delete(parent.id)
  expect(existsSync(join(pages, parent.id))).toBe(false)
  expect(existsSync(join(pages, child.id))).toBe(false)
  expect(existsSync(join(pages, other.id, 'p.html'))).toBe(true)
})
