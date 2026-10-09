import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDb, Store } from './db'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-dbws-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('adds the github columns to a workspaces table created before them', () => {
  const path = join(root, 'old.db')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, git INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`)
  old.exec(`INSERT INTO workspaces (id, name, path, git, created_at) VALUES ('w1', 'one', '/one', 1, 5)`)
  old.close()
  const db = openDb(path)
  const store = new Store(db)
  const [w] = store.listWorkspaces()
  expect(w).toMatchObject({ id: 'w1', git: true, githubRepo: null, githubRepoCheckedAt: null })
  store.setWorkspaceGithubRepo('w1', 'o/n', 42)
  expect(store.listWorkspaces()[0]).toMatchObject({ githubRepo: 'o/n', githubRepoCheckedAt: 42 })
  db.close()
})

it('round-trips the repo through insert, set, and clear', () => {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.insertWorkspace({ id: 'a', name: 'a', path: '/a', git: true, createdAt: 1 })
  store.insertWorkspace({ id: 'b', name: 'b', path: '/b', git: true, githubRepo: 'x/y', githubRepoCheckedAt: 7, createdAt: 2 })
  expect(store.listWorkspaces().map((w) => [w.id, w.githubRepo, w.githubRepoCheckedAt])).toEqual([
    ['a', null, null],
    ['b', 'x/y', 7]
  ])
  store.setWorkspaceGithubRepo('b', null, 9)
  expect(store.listWorkspaces()[1]).toMatchObject({ githubRepo: null, githubRepoCheckedAt: 9 })
  db.close()
})
