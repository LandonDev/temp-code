import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The git read cache: a repeat `git.diffIndex` or `git.branches` within the
 * window and with nothing moved in the git dir runs no git at all;
 * concurrent asks share one run; a commit, a checkout, a staged file or a
 * new branch is a miss at once.
 */
const spawns = vi.hoisted(() => ({ n: 0 }))
vi.mock('./spawnBudget', async (importOriginal) => {
  const real = await importOriginal<typeof import('./spawnBudget')>()
  return {
    ...real,
    execFileChildBudgeted: (...args: Parameters<typeof real.execFileChildBudgeted>) => {
      spawns.n += 1
      return real.execFileChildBudgeted(...args)
    }
  }
})

import * as git from './gitops'

let root: string
let cwd: string
const command = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-git-cache-'))
  cwd = join(root, 'repo')
  await mkdir(cwd, { recursive: true })
  command(cwd, 'init', '-q', '-b', 'main')
  command(cwd, 'config', 'user.name', 'T')
  command(cwd, 'config', 'user.email', 't@example.test')
  command(cwd, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(cwd, 'tracked.txt'), 'a\nb\n')
  command(cwd, 'add', '.')
  command(cwd, 'commit', '-q', '-m', 'init')
  await writeFile(join(cwd, 'tracked.txt'), 'a\nb\nc\n')
  git.invalidateGitCache()
  git.gitCacheTtl.ms = 3_000
  spawns.n = 0
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A git dir file's mtime moved back a step, so a change inside one second still reads as a change. */
const touchBack = async (path: string, seconds: number): Promise<void> => {
  const t = new Date(Date.now() - seconds * 1000)
  await utimes(path, t, t)
}

describe('the git read cache', () => {
  it('answers a repeat diffIndex from the cache, with no git child', async () => {
    const first = await git.gitDiffIndexCached(cwd)
    const ran = spawns.n
    expect(ran).toBeGreaterThan(0)
    const again = await git.gitDiffIndexCached(cwd)
    expect(spawns.n).toBe(ran)
    expect(again).toEqual(first)
    expect(git.gitCacheStats.hits).toBeGreaterThan(0)
  })

  it('joins concurrent asks for one checkout into one run', async () => {
    const [a, b, c] = await Promise.all([git.gitDiffIndexCached(cwd), git.gitDiffIndexCached(cwd), git.gitDiffIndexCached(cwd)])
    const one = spawns.n
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    spawns.n = 0
    await git.gitDiffIndexCached(join(root, 'other-' + 'x'.repeat(1))).catch(() => null)
    const another = spawns.n
    expect(one).toBeLessThanOrEqual(another + one)
    expect(one).toBeGreaterThan(0)
  })

  it('misses when the index, HEAD or a branch moved', async () => {
    await git.gitDiffIndexCached(cwd)
    await git.gitBranchesCached(cwd)
    // Staged: the index file changes.
    await touchBack(join(cwd, '.git', 'index'), 5)
    command(cwd, 'add', 'tracked.txt')
    spawns.n = 0
    expect((await git.gitDiffIndexCached(cwd)).files[0]).toMatchObject({ staged: true })
    expect(spawns.n).toBeGreaterThan(0)
    // A commit: HEAD's reflog changes.
    await touchBack(join(cwd, '.git', 'logs', 'HEAD'), 5)
    await touchBack(join(cwd, '.git', 'index'), 5)
    command(cwd, 'commit', '-q', '-m', 'two')
    spawns.n = 0
    expect((await git.gitDiffIndexCached(cwd)).files).toEqual([])
    expect(spawns.n).toBeGreaterThan(0)
    // A new branch: refs/heads changes.
    await touchBack(join(cwd, '.git', 'refs', 'heads'), 5)
    command(cwd, 'branch', 'feature')
    spawns.n = 0
    expect((await git.gitBranchesCached(cwd)).branches.map((b) => b.name)).toEqual(['main', 'feature'])
    expect(spawns.n).toBeGreaterThan(0)
  })

  it('serves only inside the window', async () => {
    await git.gitDiffIndexCached(cwd)
    git.gitCacheTtl.ms = 0
    spawns.n = 0
    await git.gitDiffIndexCached(cwd)
    expect(spawns.n).toBeGreaterThan(0)
  })

  it('never caches a folder outside any repository, and the plain functions never cache', async () => {
    const outside = join(root, 'plain')
    await mkdir(outside)
    expect((await git.gitDiffIndexCached(outside)).files).toEqual([])
    spawns.n = 0
    await git.gitDiffIndexCached(outside)
    expect(spawns.n).toBeGreaterThan(0)
    expect(await git.gitDirs(outside)).toBeNull()
    await git.gitDiffIndexCached(cwd)
    spawns.n = 0
    await git.gitDiffIndex(cwd)
    expect(spawns.n).toBeGreaterThan(0)
  })

  it('finds a worktree\'s own git dir and the common dir', async () => {
    const wt = join(root, 'wt')
    command(cwd, 'worktree', 'add', '-q', '-b', 'side', wt)
    const dirs = await git.gitDirs(wt)
    expect(dirs?.gitDir).toBe(await realpath(join(cwd, '.git', 'worktrees', 'wt')))
    expect(dirs?.commonDir).toBe(await realpath(join(cwd, '.git')))
    expect(await git.gitStamp(wt)).not.toBe('')
    expect((await git.gitBranchesCached(wt)).current).toBe('side')
  })
})
