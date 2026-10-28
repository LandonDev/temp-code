import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceMeta } from '@shared/domain'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { groupWorkspaceDuplicates, workspacePathKey, WORKSPACE_FOLD_KEY } from './workspaceFold'

vi.mock('./drivers', () => ({ BUILT_IN_DRIVERS: {} }))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-ws-fold-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const workspace = (
  id: string,
  path: string,
  createdAt: number,
  linkId: string | null = null
): WorkspaceMeta => ({ id, name: id, path, git: false, createdAt, linkId })

function project(id: string, workspaceId: string, archived = false): void {
  store.insertProject({
    id,
    workspaceId,
    name: id,
    mode: 'local',
    branch: null,
    cwd: root,
    archived,
    createdAt: 1
  })
  if (archived) store.setProjectArchived(id, true)
}

it('normalizes real folders and symlinks, strips missing paths, and keeps root and empty input', async () => {
  const alias = join(root, 'alias')
  await symlink(root, alias)
  expect(workspacePathKey(`${alias}///`)).toBe(realpathSync(root))
  expect(workspacePathKey(`${root}/missing///`)).toBe(`${root}/missing`)
  expect(workspacePathKey('/')).toBe('/')
  expect(workspacePathKey('///')).toBe('/')
  expect(workspacePathKey('')).toBe('')
})

it('groups equal normalized paths oldest first without changing input, with stable date ties', () => {
  const rows = [
    workspace('new', '/repo', 3),
    workspace('old', '/repo', 1),
    workspace('tie', '/repo', 1),
    workspace('other', '/elsewhere', 0)
  ]
  expect(groupWorkspaceDuplicates(rows).map((group) => group.map((w) => w.id))).toEqual([
    ['old', 'tie', 'new']
  ])
  expect(rows.map((w) => w.id)).toEqual(['new', 'old', 'tie', 'other'])
})

it('moves every project and session to the oldest row, keeps a link, and pushes catalogs once', async () => {
  const alias = join(root, 'alias')
  await symlink(root, alias)
  // Insert out of age order; the first linked duplicate by age supplies the link.
  store.insertWorkspace(workspace('new', alias, 30, 'wl_new'))
  store.insertWorkspace(workspace('old', root, 10))
  store.insertWorkspace(workspace('middle', `${root}/`, 20, 'wl_middle'))
  project('keep', 'old')
  project('moved', 'new')
  project('archived', 'middle', true)
  const loose = await registry.create({ workspaceId: 'new' })
  const child = await registry.create({ workspaceId: 'middle', parentId: loose.id })
  const inProject = await registry.create({ projectId: 'moved' })
  store.setSessionWorkspace(inProject.id, 'new')
  store.updateSession(child.id, { archived: true })
  // Read the registry index before the fold to check that bulk writes refresh it.
  registry.get(loose.id)
  const pushes = vi.fn()
  registry.onCatalog(pushes)
  registry.foldWorkspaces()

  expect(store.listWorkspaces()).toEqual([
    expect.objectContaining({ id: 'old', path: root, linkId: 'wl_middle' })
  ])
  expect(store.listProjects().map((p) => [p.id, p.workspaceId])).toEqual([
    ['keep', 'old'],
    ['moved', 'old'],
    ['archived', 'old']
  ])
  expect(store.getProject('archived')?.archived).toBe(true)
  for (const session of [loose, child, inProject]) {
    expect(store.getSession(session.id)?.workspaceId).toBe('old')
    expect(registry.get(session.id)?.workspaceId).toBe('old')
  }
  expect(store.getSession(inProject.id)?.projectId).toBe('moved')
  expect(store.getSession(child.id)?.parentId).toBe(loose.id)
  expect(store.getSession(child.id)?.archived).toBe(true)
  expect(pushes.mock.calls).toEqual([['workspaces'], ['projects']])
  expect(store.getSetting(WORKSPACE_FOLD_KEY)).not.toBeNull()
})

it('keeps the oldest row’s own link and pushes only workspaces when no projects move', () => {
  store.insertWorkspace(workspace('old', root, 1, 'wl_old'))
  store.insertWorkspace(workspace('new', `${root}/`, 2, 'wl_new'))
  const pushes = vi.fn()
  registry.onCatalog(pushes)
  registry.foldWorkspaces()
  expect(store.listWorkspaces()[0].linkId).toBe('wl_old')
  expect(pushes.mock.calls).toEqual([['workspaces']])
})

it('folds all groups before one catalog push and permits groups without any link', async () => {
  const other = join(root, 'other')
  await mkdir(other)
  for (const [id, path, age] of [
    ['a', root, 1],
    ['b', `${root}/`, 2],
    ['c', other, 3],
    ['d', `${other}/`, 4]
  ] as const) {
    store.insertWorkspace(workspace(id, path, age))
  }
  const pushes = vi.fn()
  registry.onCatalog(pushes)
  registry.foldWorkspaces()
  expect(store.listWorkspaces().map((w) => [w.id, w.linkId])).toEqual([
    ['a', null],
    ['c', null]
  ])
  expect(pushes.mock.calls).toEqual([['workspaces']])
})

it('runs only once, including after reopening the database', async () => {
  store.insertWorkspace(workspace('old', root, 1))
  store.insertWorkspace(workspace('new', `${root}/`, 2))
  registry.foldWorkspaces()
  const marker = store.getSetting(WORKSPACE_FOLD_KEY)
  await registry.disposeAll()
  db.close()
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  store.insertWorkspace(workspace('later', `${root}///`, 3))
  const pushes = vi.fn()
  registry.onCatalog(pushes)
  registry.foldWorkspaces()
  expect(store.listWorkspaces().map((w) => w.id)).toEqual(['old', 'later'])
  expect(store.getSetting(WORKSPACE_FOLD_KEY)).toBe(marker)
  expect(pushes).not.toHaveBeenCalled()
})

it('leaves different real paths and their references untouched and still records the marker', async () => {
  const other = join(root, 'other')
  await mkdir(other)
  store.insertWorkspace(workspace('a', root, 1, 'same-link'))
  store.insertWorkspace(workspace('b', other, 2, 'same-link'))
  project('p', 'b')
  const session = await registry.create({ workspaceId: 'b' })
  const before = store.listWorkspaces()
  const pushes = vi.fn()
  registry.onCatalog(pushes)
  registry.foldWorkspaces()
  expect(store.listWorkspaces()).toEqual(before)
  expect(store.getProject('p')?.workspaceId).toBe('b')
  expect(store.getSession(session.id)?.workspaceId).toBe('b')
  expect(store.getSetting(WORKSPACE_FOLD_KEY)).not.toBeNull()
  expect(pushes).not.toHaveBeenCalled()
})

it('rolls back a failed merge, leaves the marker unset, and safely retries', async () => {
  store.insertWorkspace(workspace('old', root, 1))
  store.insertWorkspace(workspace('new', `${root}/`, 2, 'wl_new'))
  project('p', 'new')
  const session = await registry.create({ workspaceId: 'new' })
  db.exec(`CREATE TRIGGER fail_fold BEFORE DELETE ON workspaces
    BEGIN SELECT RAISE(ABORT, 'fold blocked'); END`)
  const pushes = vi.fn()
  registry.onCatalog(pushes)
  expect(() => registry.foldWorkspaces()).toThrow('fold blocked')
  expect(store.listWorkspaces()).toHaveLength(2)
  expect(store.listWorkspaces()[0].linkId).toBeNull()
  expect(store.getProject('p')?.workspaceId).toBe('new')
  expect(store.getSession(session.id)?.workspaceId).toBe('new')
  expect(store.getSetting(WORKSPACE_FOLD_KEY)).toBeNull()
  expect(pushes).not.toHaveBeenCalled()
  db.exec('DROP TRIGGER fail_fold')
  registry.foldWorkspaces()
  expect(store.listWorkspaces()).toHaveLength(1)
  expect(store.getProject('p')?.workspaceId).toBe('old')
  expect(store.getSession(session.id)?.workspaceId).toBe('old')
})

it('folds equal missing paths by spelling without merging different missing folders', () => {
  const missing = join(root, 'missing')
  store.insertWorkspace(workspace('old', missing, 1))
  store.insertWorkspace(workspace('new', `${missing}/`, 2))
  store.insertWorkspace(workspace('other', join(root, 'other-missing'), 3))
  registry.foldWorkspaces()
  expect(store.listWorkspaces().map((w) => w.id)).toEqual(['old', 'other'])
})

it("carries a duplicate's preamble, account pins and workspace settings to the kept row, never over the keeper's own", async () => {
  store.insertWorkspace(workspace('old', root, 10))
  store.insertWorkspace(workspace('dup', `${root}/`, 20))
  store.setWorkspacePreamble('dup', 'House rules', false)
  store.setWorkspaceAccounts('dup', { claude: 'a@x.com' })
  store.setSetting('build:dup', '{"run":"make"}')
  store.setSetting('thread-defaults:dup', '{"model":"x"}')
  store.setSetting('thread-defaults:old', '{"model":"mine"}')
  store.setSetting('orchestration-rules:dup', '{"models":{}}')
  store.setSetting('orchestration-rules:dup:explicit', '1')
  registry.foldWorkspaces()
  const kept = store.listWorkspaces()
  expect(kept.map((w) => w.id)).toEqual(['old'])
  expect(kept[0].preamble).toBe('House rules')
  expect(kept[0].preambleEnabled).toBe(false)
  expect(kept[0].accountPins).toEqual({ claude: 'a@x.com' })
  expect(store.getSetting('build:old')).toBe('{"run":"make"}')
  expect(store.getSetting('thread-defaults:old')).toBe('{"model":"mine"}')
  expect(store.getSetting('build:dup')).toBeNull()
  expect(store.getSetting('thread-defaults:dup')).toBeNull()
  // Rules keep their explicit marker, so a model they never listed stays off.
  expect(store.getSetting('orchestration-rules:old')).toBe('{"models":{}}')
  expect(store.getSetting('orchestration-rules:old:explicit')).toBe('1')
  expect(store.getSetting('orchestration-rules:dup:explicit')).toBeNull()
})
