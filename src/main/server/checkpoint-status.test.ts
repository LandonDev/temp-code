import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Every git child the checkpoint path starts — the store's own
 * (execFileBudgeted) and gitops' (execFileChildBudgeted) — with the budget
 * the call took its slot from.
 */
const spawned = vi.hoisted(() => ({ calls: [] as { args: string[]; budget: string }[] }))
vi.mock('./spawnBudget', async (importOriginal) => {
  const real = await importOriginal<typeof import('./spawnBudget')>()
  const name = (): string =>
    real.currentBudget() === real.statusBudget ? 'status' : real.currentBudget() === real.childBudget ? 'shared' : 'other'
  return {
    ...real,
    execFileBudgeted: (...args: Parameters<typeof real.execFileBudgeted>) => {
      spawned.calls.push({ args: args[1] as string[], budget: name() })
      return (real.execFileBudgeted as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof real.execFileBudgeted>
    },
    execFileChildBudgeted: (...args: Parameters<typeof real.execFileChildBudgeted>) => {
      spawned.calls.push({ args: args[1] as string[], budget: name() })
      return real.execFileChildBudgeted(...args)
    }
  }
})

import { CheckpointStore } from './checkpoint'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  spawned.calls.length = 0
})

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'tc-cp-status-'))
  roots.push(base)
  const repo = join(base, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'commit.gpgSign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return { repo, store: new CheckpointStore(join(base, 'checkpoints')) }
}

const numstats = () => spawned.calls.filter((c) => c.args.includes('--numstat'))

describe('checkpoint status', () => {
  it('runs its git on the status lane, while ensure and capture stay on the shared budget', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    writeFileSync(join(repo, 'b.txt'), 'agent\n')
    await store.capture('s1', repo, [join(repo, 'b.txt')])
    expect(spawned.calls.length).toBeGreaterThan(0)
    expect(new Set(spawned.calls.map((c) => c.budget))).toEqual(new Set(['shared']))
    spawned.calls.length = 0
    expect((await store.status('s1', repo)).files.map((f) => f.relative)).toEqual(['b.txt'])
    expect(spawned.calls.length).toBeGreaterThan(0)
    expect(new Set(spawned.calls.map((c) => c.budget))).toEqual(new Set(['status']))
  })

  it('concurrent statuses on one checkout share one diff, and one session shares one call', async () => {
    const { repo, store } = setup()
    for (const id of ['s1', 's2', 's3']) await store.ensure(id, repo)
    writeFileSync(join(repo, 'b.txt'), 'agent\n')
    for (const id of ['s1', 's2', 's3']) await store.capture(id, repo, [join(repo, 'b.txt')])
    spawned.calls.length = 0
    const same = [store.status('s1', repo), store.status('s1', repo), store.status('s1', repo)]
    expect(same[1]).toBe(same[0])
    const others = [store.status('s2', repo), store.status('s3', repo)]
    const results = await Promise.all([...same, ...others])
    for (const r of results) expect(r.files.map((f) => f.relative)).toEqual(['b.txt'])
    // five callers, three sessions, one `git diff --numstat` of the checkout
    expect(numstats()).toHaveLength(1)
    // and the next status, after the burst, diffs again
    await store.status('s1', repo)
    expect(numstats()).toHaveLength(2)
  })
})
