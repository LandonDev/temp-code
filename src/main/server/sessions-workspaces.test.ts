import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

vi.mock('./drivers', () => ({ BUILT_IN_DRIVERS: {} }))

const run = promisify(execFile)

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-ws-repo-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

/** A real git checkout (git init) with the given origin, so isGitRepo sees it. */
async function checkout(name: string, origin: string | null): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir)
  await run('git', ['-C', dir, 'init', '-q'])
  if (origin) await run('git', ['-C', dir, 'remote', 'add', 'origin', origin])
  return dir
}

it('createWorkspace refuses a folder that is not on this host', async () => {
  await expect(registry.createWorkspace(join(root, 'elsewhere'))).rejects.toThrow('no such folder on this host')
  const file = join(root, 'a-file')
  await writeFile(file, '')
  await expect(registry.createWorkspace(file)).rejects.toThrow('no such folder on this host')
  expect(registry.listWorkspaces()).toEqual([])
})

it('createWorkspace stores the GitHub slug of the origin, null for other hosts and plain folders', async () => {
  const gh = await checkout('gh', 'git@github.com:LandonDev/aliax.git')
  const gl = await checkout('gl', 'https://gitlab.com/o/n.git')
  const plain = join(root, 'plain')
  await mkdir(plain)
  const a = await registry.createWorkspace(gh)
  const b = await registry.createWorkspace(gl)
  const c = await registry.createWorkspace(plain)
  expect(a).toMatchObject({ git: true, githubRepo: 'LandonDev/aliax' })
  expect(a.githubRepoCheckedAt).toBeTypeOf('number')
  expect(b).toMatchObject({ git: true, githubRepo: null })
  expect(c).toMatchObject({ git: false, githubRepo: null, githubRepoCheckedAt: null })
  expect(store.listWorkspaces().map((w) => w.githubRepo)).toEqual(['LandonDev/aliax', null, null])
})

it('refreshWorkspaceRepos re-reads a changed config, leaves an untouched one alone, and pushes only on change', async () => {
  const dir = await checkout('gh', 'git@github.com:o/old.git')
  const ws = await registry.createWorkspace(dir)
  const pushes: string[] = []
  registry.onCatalog((kind) => pushes.push(kind))

  // Untouched config (mtime before checkedAt): no re-read, no push.
  const old = new Date((ws.githubRepoCheckedAt ?? 0) - 10_000)
  await utimes(join(dir, '.git', 'config'), old, old)
  await registry.refreshWorkspaceRepos()
  expect(store.listWorkspaces()[0].githubRepoCheckedAt).toBe(ws.githubRepoCheckedAt)
  expect(pushes).toEqual([])

  // The remote moves: a newer config mtime triggers a re-read and one push.
  await run('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/o/new.git'])
  const future = new Date(Date.now() + 5_000)
  await utimes(join(dir, '.git', 'config'), future, future)
  const after = await registry.refreshWorkspaceRepos()
  expect(after[0].githubRepo).toBe('o/new')
  expect(pushes).toEqual(['workspaces'])

  // A re-read that yields the same slug updates checkedAt but does not push.
  await utimes(join(dir, '.git', 'config'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
  await registry.refreshWorkspaceRepos()
  expect(pushes).toEqual(['workspaces'])
})

it('refreshWorkspaceRepos resolves rows that were never checked (pre-migration) and skips non-git workspaces', async () => {
  const dir = await checkout('gh', 'git@github.com:o/n.git')
  store.insertWorkspace({ id: 'legacy', name: 'legacy', path: dir, git: true, createdAt: 1 })
  const plain = join(root, 'plain')
  await mkdir(plain)
  await writeFile(join(plain, 'file'), 'x')
  store.insertWorkspace({ id: 'plain', name: 'plain', path: plain, git: false, createdAt: 2 })
  const after = await registry.refreshWorkspaceRepos()
  expect(after.map((w) => [w.id, w.githubRepo])).toEqual([
    ['legacy', 'o/n'],
    ['plain', null]
  ])
  expect(after[1].githubRepoCheckedAt).toBeNull()
})

it('deleting a workspace leaves the others’ repos intact', async () => {
  const a = await registry.createWorkspace(await checkout('a', 'git@github.com:o/a.git'))
  await registry.createWorkspace(await checkout('b', 'git@github.com:o/b.git'))
  await registry.deleteWorkspace(a.id)
  expect(store.listWorkspaces().map((w) => w.githubRepo)).toEqual(['o/b'])
})

it('a trailing slash answers the existing workspace, including legacy path spelling', async () => {
  const folder = await checkout('slash', null)
  const workspace = await registry.createWorkspace(folder)
  expect((await registry.createWorkspace(`${folder}///`)).id).toBe(workspace.id)
  db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(`${folder}/`, workspace.id)
  expect((await registry.createWorkspace(folder)).id).toBe(workspace.id)
  expect(store.listWorkspaces()).toHaveLength(1)
})

it('a symlink answers the existing workspace in either direction', async () => {
  const folder = await checkout('target', null)
  const alias = join(root, 'alias')
  await symlink(folder, alias)
  const workspace = await registry.createWorkspace(folder)
  expect((await registry.createWorkspace(alias)).id).toBe(workspace.id)
  db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(alias, workspace.id)
  expect((await registry.createWorkspace(folder)).id).toBe(workspace.id)
  expect(store.listWorkspaces()).toHaveLength(1)
})

it('concurrent creates through symlinks and trailing slashes join one promise and push once', async () => {
  const folder = await checkout('concurrent', null)
  const alias = join(root, 'alias')
  await symlink(folder, alias)
  const pushes = vi.fn()
  registry.onCatalog(pushes)
  const first = registry.createWorkspace(`${alias}///`)
  expect(registry.createWorkspace(folder)).toBe(first)
  expect(registry.createWorkspace(`${folder}/`)).toBe(first)
  const workspace = await first
  expect(workspace.path).toBe(alias)
  expect(workspace.name).toBe('alias')
  expect(store.listWorkspaces()).toHaveLength(1)
  expect(pushes.mock.calls).toEqual([['workspaces']])
})

it('new workspaces adopt loose sessions whose cwd uses the same real folder', async () => {
  const folder = await checkout('loose', null)
  const alias = join(root, 'alias')
  await symlink(folder, alias)
  const session = await registry.create({ cwd: `${alias}/` })
  const workspace = await registry.createWorkspace(`${folder}/`)
  expect(workspace.path).toBe(folder)
  expect(store.getSession(session.id)?.workspaceId).toBe(workspace.id)
})

it('a failed create releases its normalized in-flight key', async () => {
  const folder = join(root, 'later')
  await expect(registry.createWorkspace(`${folder}/`)).rejects.toThrow('no such folder')
  await mkdir(folder)
  expect((await registry.createWorkspace(folder)).path).toBe(folder)
})
