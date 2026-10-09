import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
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
