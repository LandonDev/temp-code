import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MergeRefusal,
  branchOf,
  buildMergeBundle,
  defaultBranchOf,
  fastForwardMerge
} from './mergeBranch'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  }).trim()

let root: string
let repo: string
let origin: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-merge-'))
  origin = join(root, 'origin.git')
  repo = join(root, 'repo')
  git(root, 'init', '--bare', '-b', 'master', origin)
  git(root, 'clone', origin, repo)
  git(repo, 'checkout', '-b', 'master')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')
  git(repo, 'push', '-u', 'origin', 'master')
  git(repo, 'checkout', '-b', 'feature')
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(repo, 'b.txt'), 'new\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'feature: add b and a line')
  git(repo, 'checkout', 'master')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the bundle', () => {
  it('names the merge-base, the diff, the commits and the files of a branch against the target', async () => {
    const b = await buildMergeBundle(repo, 'feature', 'master')
    expect(b.base).toBe(git(repo, 'rev-parse', 'master'))
    expect(b.head).toBe(git(repo, 'rev-parse', 'feature'))
    expect(b.empty).toBe(false)
    expect(b.files).toEqual(['a.txt', 'b.txt'])
    expect(b.diff).toContain('+two')
    expect(b.diff).toContain('+new')
    expect(b.commits).toContain('feature: add b and a line')
    expect(b.diffTruncated).toBe(false)
  })

  it('is empty when the branch is already in the target', async () => {
    git(repo, 'merge', '--ff-only', 'feature')
    const b = await buildMergeBundle(repo, 'feature', 'master')
    expect(b.empty).toBe(true)
    expect(b.diff).toBe('')
  })

  it('compares a branch that IS the target against origin, and refuses one with no origin copy', async () => {
    git(repo, 'merge', '--ff-only', 'feature')
    const b = await buildMergeBundle(repo, 'master', 'master')
    expect(b.empty).toBe(false)
    expect(b.diff).toContain('+new')
    git(repo, 'checkout', '-b', 'lonely')
    await expect(buildMergeBundle(repo, 'lonely', 'lonely')).rejects.toBeInstanceOf(MergeRefusal)
  })

  it('refuses a missing branch or target', async () => {
    await expect(buildMergeBundle(repo, 'nope', 'master')).rejects.toThrow(/does not exist/)
    await expect(buildMergeBundle(repo, 'feature', 'nope')).rejects.toThrow(/target branch "nope"/)
  })
})

describe('the fast-forward', () => {
  it('lands the branch on the target and pushes it', async () => {
    const r = await fastForwardMerge(repo, 'feature', 'master', true)
    expect(r.merged).toBe(true)
    expect(r.pushed).toBe(true)
    expect(r.sha).toBe(git(repo, 'rev-parse', 'feature'))
    expect(git(origin, 'rev-parse', 'master')).toBe(r.sha)
  })

  it('only pushes when the branch is the target', async () => {
    git(repo, 'merge', '--ff-only', 'feature')
    const r = await fastForwardMerge(repo, 'master', 'master', true)
    expect(r.merged).toBe(false)
    expect(r.pushed).toBe(true)
    expect(git(origin, 'rev-parse', 'master')).toBe(r.sha)
  })

  it('refuses a checkout on another branch, a dirty checkout, and a merge that is not a fast-forward', async () => {
    git(repo, 'checkout', 'feature')
    await expect(fastForwardMerge(repo, 'feature', 'master', false)).rejects.toThrow(/is on feature, not master/)
    git(repo, 'checkout', 'master')
    await writeFile(join(repo, 'a.txt'), 'dirty\n')
    await expect(fastForwardMerge(repo, 'feature', 'master', false)).rejects.toThrow(/uncommitted changes/)
    git(repo, 'checkout', '--', 'a.txt')
    await writeFile(join(repo, 'c.txt'), 'diverge\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'master moved')
    await expect(fastForwardMerge(repo, 'feature', 'master', false)).rejects.toThrow(/Rebase feature onto master/)
    expect(git(repo, 'rev-parse', 'master')).not.toBe(git(repo, 'rev-parse', 'feature'))
  })

  it('reads the checkout branch and the default branch', async () => {
    expect(await branchOf(repo)).toBe('master')
    expect(await defaultBranchOf(repo)).toBe('master')
    expect(await branchOf(root)).toBeNull()
  })
})
