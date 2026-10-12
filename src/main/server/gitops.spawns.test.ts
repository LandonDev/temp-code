import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  root = await mkdtemp(join(tmpdir(), 'tc-git-spawns-'))
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
  for (let i = 0; i < 20; i++) await writeFile(join(cwd, `untracked-${i}.txt`), 'x\ny\nz\n')
  spawns.n = 0
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** Spawn budget of the two index calls the renderer makes after a tool result. */
describe('git spawns per index call', () => {
  it('diffIndex and diffStats each stay within their spawn budget', async () => {
    const index = await git.gitDiffIndex(cwd)
    const perIndex = spawns.n
    spawns.n = 0
    const stats = await git.gitDiffStats(cwd)
    const perStats = spawns.n
    // eslint-disable-next-line no-console
    console.log(`[measure] gitDiffIndex=${perIndex} spawns, gitDiffStats=${perStats} spawns, files=${index.files.length}/${stats.files}`)
    expect(index.files.length).toBe(21)
    expect(perIndex).toBeLessThanOrEqual(5)
    expect(perStats).toBeLessThanOrEqual(3)
  })
})
