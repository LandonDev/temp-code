import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compare, defaultTarget } from './git'

let dir: string
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tc-compare-'))
  git('init', '-q', '-b', 'master')
  git('config', 'user.name', 'Compare Test')
  git('config', 'user.email', 'compare@example.test')
  git('config', 'commit.gpgSign', 'false')
  await writeFile(join(dir, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'first')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the compare target', () => {
  it('a repository on master with no other branch has no default target and compares to nothing', async () => {
    expect(await defaultTarget(dir)).toBeNull()
    expect(await compare(dir)).toBeNull()
  })

  it('defaults to another branch when one exists', async () => {
    git('checkout', '-q', '-b', 'feature')
    await writeFile(join(dir, 'b.txt'), 'two\n')
    git('add', 'b.txt')
    git('commit', '-q', '-m', 'second')
    expect(await defaultTarget(dir)).toBe('master')
    const result = await compare(dir)
    expect(result).toMatchObject({ target: 'master', ahead: 1, behind: 0 })
    expect(result?.files.map((f) => f.path)).toEqual(['b.txt'])
  })

  it('a named branch that is gone still throws', async () => {
    await expect(compare(dir, 'deleted-branch')).rejects.toThrow('unknown branch: deleted-branch')
  })
})
