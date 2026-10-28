import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Every git child the checkpoint store itself starts (`args`), and the
 *  ones gitops starts for it (`gitops`: the diffs ensure and sync read). */
const spawned = vi.hoisted(() => ({ args: [] as string[][], gitops: [] as string[][] }))
vi.mock('./spawnBudget', async (importOriginal) => {
  const real = await importOriginal<typeof import('./spawnBudget')>()
  return {
    ...real,
    execFileBudgeted: (...args: Parameters<typeof real.execFileBudgeted>) => {
      spawned.args.push(args[1] as string[])
      return (real.execFileBudgeted as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof real.execFileBudgeted>
    },
    execFileChildBudgeted: (...args: Parameters<typeof real.execFileChildBudgeted>) => {
      spawned.gitops.push(args[1] as string[])
      return real.execFileChildBudgeted(...args)
    }
  }
})

import { CheckpointStore, inHeadMany, listTracked } from './checkpoint'
import { CheckpointTurns } from './checkpointTurns'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  spawned.args.length = 0
  spawned.gitops.length = 0
})

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

function setup(files: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), 'tc-cp-spawns-'))
  roots.push(base)
  const repo = join(base, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'commit.gpgSign', 'false')
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true })
    writeFileSync(join(repo, name), body)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return { repo, store: new CheckpointStore(join(base, 'checkpoints')) }
}

const headLookups = () => spawned.args.filter((a) => a.includes('ls-tree') || a.includes('cat-file'))

describe('checkpoint store spawns', () => {
  it('status asks HEAD once for forty touched files, not forty times', async () => {
    const { repo, store } = setup({ 'a.txt': 'a\n' })
    await store.ensure('s1', repo)
    const paths = Array.from({ length: 40 }, (_, i) => `src/f${i}.txt`)
    for (const p of paths) {
      mkdirSync(join(repo, p, '..'), { recursive: true })
      writeFileSync(join(repo, p), 'agent\n')
    }
    await store.capture('s1', repo, paths)
    await store.sync('s1', repo)
    expect((await store.status('s1', repo)).files).toHaveLength(40)
    // The new files are committed: every touched path is now clean against
    // the index and unknown to HEAD at capture time, so each must be checked
    // against HEAD before it drops off the review.
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'agent work')
    spawned.args.length = 0

    const status = await store.status('s1', repo)
    expect(status.files).toEqual([])
    const lookups = headLookups()
    expect(lookups).toHaveLength(1)
    expect(lookups[0].filter((a) => a.startsWith('src/f'))).toHaveLength(40)
  })

  it('ensure and capture each spend one HEAD lookup for many files', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 12; i++) files[`a${i}.txt`] = 'x\n'
    const { repo, store } = setup(files)
    for (const p of Object.keys(files)) writeFileSync(join(repo, p), 'user\n')
    await store.ensure('s1', repo)
    expect(headLookups()).toHaveLength(1)
    spawned.args.length = 0
    for (let i = 0; i < 12; i++) writeFileSync(join(repo, `new${i}.txt`), 'n\n')
    await store.capture(
      's1',
      repo,
      Array.from({ length: 12 }, (_, i) => `new${i}.txt`)
    )
    expect(headLookups()).toHaveLength(1)
  })

  it('a later send refreshes the baseline with one listing and one HEAD lookup, none per path; nothing new costs the listing alone', async () => {
    const { repo, store } = setup({ 'a.txt': 'a\n' })
    await store.ensure('s1', repo)
    spawned.args.length = 0
    spawned.gitops.length = 0
    for (let i = 0; i < 12; i++) writeFileSync(join(repo, `hand${i}.txt`), 'hand\n')
    writeFileSync(join(repo, 'a.txt'), 'hand edit\n')
    await store.ensure('s1', repo)
    expect(spawned.gitops.filter((args) => args.includes('--numstat'))).toHaveLength(1)
    expect(headLookups()).toHaveLength(1)
    expect(headLookups()[0].filter((a) => a.startsWith('hand') || a === 'a.txt')).toHaveLength(13)
    expect(spawned.args).toHaveLength(1)
    spawned.args.length = 0
    spawned.gitops.length = 0
    await store.ensure('s1', repo)
    expect(spawned.gitops.filter((args) => args.includes('--numstat'))).toHaveLength(1)
    expect(spawned.args).toEqual([])
    expect((await store.status('s1', repo)).files).toEqual([])
  })

  it('a capture queued while ensure is still running lands on the baseline it made', async () => {
    const { repo, store } = setup({ 'a.txt': 'a\n', 'user.txt': 'user\n' })
    writeFileSync(join(repo, 'user.txt'), 'user edit\n')
    // Neither call is awaited before the next: the per-session chain must
    // run the capture after the ensure, or the capture finds no manifest
    // and the agent's edit is never tracked.
    const ensured = store.ensure('s1', repo)
    const captured = store.capture('s1', repo, ['a.txt'])
    await Promise.all([ensured, captured])
    // Only a capture applied to ensure's manifest leaves a.txt touched, so
    // the edit shows up in the review without another sync.
    writeFileSync(join(repo, 'a.txt'), 'agent\n')
    const status = await store.status('s1', repo)
    expect(status.files.map((f) => f.relative)).toEqual(['a.txt'])
    // The user's own dirty file was baselined by ensure, not claimed.
    await store.undo('s1', repo)
    expect(execFileSync('cat', [join(repo, 'user.txt')], { encoding: 'utf8' })).toBe('user edit\n')
    expect(execFileSync('cat', [join(repo, 'a.txt')], { encoding: 'utf8' })).toBe('a\n')
  })

  it('sync reads the other manifests once and sees later saves without a rescan', async () => {
    const { repo, store } = setup({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    await store.ensure('s1', repo)
    await store.ensure('s2', repo)
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    await store.capture('s1', repo, ['a.txt'])
    await store.sync('s1', repo)
    // s2 must not claim a.txt (s1 has it) even though it is dirty.
    await store.sync('s2', repo)
    expect((await store.status('s2', repo)).files).toEqual([])
    // s1 drops its checkpoint; s2's next sync may claim the still-dirty file.
    await store.keep('s1', repo)
    await store.sync('s2', repo)
    expect((await store.status('s2', repo)).files.map((f) => f.relative)).toEqual(['a.txt'])
  })

  it('a turn costs the ensure, one ls-files, one HEAD lookup and one settle diff, not a child per path', async () => {
    const { repo, store } = setup({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    const turns = new CheckpointTurns({ store, session: () => ({ cwd: repo }), listTracked, inHeadMany, push: () => {} })
    await turns.ensure('s1', repo)
    const ensured = { own: spawned.args.length, gitops: spawned.gitops.length }
    spawned.args.length = 0
    spawned.gitops.length = 0

    // The turn: two tracked files edited and thirty made, most edits settling twice.
    const made = Array.from({ length: 30 }, (_, i) => `src/f${i}.txt`)
    for (const p of ['a.txt', 'b.txt', ...made]) {
      mkdirSync(join(repo, p, '..'), { recursive: true })
      writeFileSync(join(repo, p), 'agent\n')
    }
    const edit = (path: string) =>
      turns.liveEdit({ cwd: repo, sessionIds: ['s1'], edit: { path, kind: 'created', diff: null, settled: true, ts: 0 } })
    for (const p of ['a.txt', 'b.txt', ...made, 'a.txt', ...made]) await edit(p)
    expect([spawned.args, spawned.gitops]).toEqual([[], []])
    await turns.observe({ sessionId: 's1', seq: 1, ts: 0, event: { type: 'turn-complete' } })

    // The listing answers a.txt and b.txt; the thirty it does not know share one ls-tree.
    expect(spawned.args.map((args) => args.find((a) => a === 'ls-files' || a === 'ls-tree'))).toEqual(['ls-files', 'ls-tree'])
    expect(spawned.args[1].filter((a) => a.startsWith('src/f'))).toHaveLength(30)
    // The settle's one diff reads the index the way ensure's did: the same children.
    expect(spawned.gitops.filter((args) => args.includes('--numstat'))).toHaveLength(1)
    expect(spawned.gitops.length).toBe(ensured.gitops)
    expect(ensured.own).toBe(0)
    expect((await store.status('s1', repo)).files).toHaveLength(32)
  })
})
