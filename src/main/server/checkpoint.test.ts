import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CheckpointStore, validateSessionId } from './checkpoint'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tc-m9-'))
  roots.push(dir)
  return dir
}

/** A fresh repo with `files` committed as "init", plus a store beside it. */
function setup(files: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'user.txt': 'user\n' }) {
  const base = scratch()
  const repo = join(base, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'commit.gpgSign', 'false')
  for (const [name, body] of Object.entries(files)) write(repo, name, body)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return { repo, store: new CheckpointStore(join(base, 'checkpoints')) }
}

const write = (repo: string, rel: string, body: string) => {
  mkdirSync(join(repo, rel, '..'), { recursive: true })
  writeFileSync(join(repo, rel), body)
}
const read = (repo: string, rel: string) => readFileSync(join(repo, rel), 'utf8')
const relatives = (status: { files: { relative: string }[] }) => status.files.map((f) => f.relative)

/** The renderer's capture-then-sync pair after a tool edit. */
async function record(store: CheckpointStore, id: string, cwd: string, paths: string[]) {
  await store.capture(id, cwd, paths)
  await store.sync(id, cwd)
}

describe('checkpoint store', () => {
  it('undo reverts only session files and keeps user-dirty ones', async () => {
    const { repo, store } = setup()
    write(repo, 'user.txt', 'user edit\n')
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'agent a\n')
    write(repo, 'new.txt', 'new\n')
    rmSync(join(repo, 'b.txt'))
    await record(store, 's1', repo, ['a.txt', 'new.txt', 'b.txt'])

    expect(relatives(await store.status('s1', repo))).toEqual(['a.txt', 'b.txt', 'new.txt'])
    const after = await store.undo('s1', repo)
    expect(after.files).toEqual([])
    expect(read(repo, 'a.txt')).toBe('a\n')
    expect(read(repo, 'b.txt')).toBe('b\n')
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect(read(repo, 'user.txt')).toBe('user edit\n')
  })

  it('undo does not touch untouched user files', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'agent\n')
    await record(store, 's1', repo, ['a.txt'])
    write(repo, 'user.txt', 'user later\n')
    await store.undo('s1', repo)
    expect(read(repo, 'a.txt')).toBe('a\n')
    expect(read(repo, 'user.txt')).toBe('user later\n')
  })

  it('ensure is idempotent across turns', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'turn 1\n')
    await record(store, 's1', repo, ['a.txt'])
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'turn 2\n')
    await record(store, 's1', repo, ['a.txt'])
    await store.undo('s1', repo)
    expect(read(repo, 'a.txt')).toBe('a\n')
  })

  it('keep clears review and leaves files', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'agent\n')
    await record(store, 's1', repo, ['a.txt'])
    expect(relatives(await store.status('s1', repo))).toEqual(['a.txt'])
    expect((await store.keep('s1', repo)).files).toEqual([])
    expect((await store.status('s1', repo)).files).toEqual([])
    expect(read(repo, 'a.txt')).toBe('agent\n')
  })

  it('keep one file then undo the rest', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'agent a\n')
    write(repo, 'b.txt', 'agent b\n')
    await record(store, 's1', repo, ['a.txt', 'b.txt'])
    expect(relatives(await store.keep('s1', repo, 'a.txt'))).toEqual(['b.txt'])
    await store.undo('s1', repo)
    expect(read(repo, 'a.txt')).toBe('agent a\n')
    expect(read(repo, 'b.txt')).toBe('b\n')
  })

  it('ensure baselines other-session dirty files', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'session one\n')
    await record(store, 's1', repo, ['a.txt'])
    await store.ensure('s2', repo)
    write(repo, 'b.txt', 'session two\n')
    await record(store, 's2', repo, ['b.txt'])
    await store.undo('s2', repo)
    expect(read(repo, 'a.txt')).toBe('session one\n')
    expect(read(repo, 'b.txt')).toBe('b\n')
  })

  it('sync does not claim other-session edits', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    await store.ensure('s2', repo)
    write(repo, 'a.txt', 'session one\n')
    await record(store, 's1', repo, ['a.txt'])
    write(repo, 'b.txt', 'session two\n')
    await record(store, 's2', repo, ['b.txt'])
    expect(relatives(await store.status('s1', repo))).toEqual(['a.txt'])
    expect(relatives(await store.status('s2', repo))).toEqual(['b.txt'])
  })

  it('other-session edits do not appear in review', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    await store.ensure('s2', repo)
    write(repo, 'a.txt', 'one\n')
    await record(store, 's1', repo, ['a.txt'])
    await store.sync('s2', repo)
    expect((await store.status('s2', repo)).files).toEqual([])
  })

  it('capture of a missing path lets a non-git undo delete it', async () => {
    const base = scratch()
    const dir = join(base, 'plain')
    mkdirSync(dir)
    const store = new CheckpointStore(join(base, 'checkpoints'))
    await store.ensure('s1', dir)
    await store.capture('s1', dir, [join(dir, 'made.txt')])
    write(dir, 'made.txt', 'made\n')
    await store.sync('s1', dir)
    expect(relatives(await store.status('s1', dir))).toEqual(['made.txt'])
    await store.undo('s1', dir)
    expect(existsSync(join(dir, 'made.txt'))).toBe(false)
  })

  it('capture does not overwrite an existing file baseline after the write', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'agent wrote first\n')
    await record(store, 's1', repo, ['a.txt'])
    await store.undo('s1', repo)
    expect(read(repo, 'a.txt')).toBe('a\n')
  })

  it('sync picks up new files without capture', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'fresh.txt', 'fresh\n')
    await store.sync('s1', repo)
    expect(relatives(await store.status('s1', repo))).toEqual(['fresh.txt'])
    await store.undo('s1', repo)
    expect(existsSync(join(repo, 'fresh.txt'))).toBe(false)
  })

  it('sync does not claim pre-existing dirty files', async () => {
    const { repo, store } = setup()
    write(repo, 'user.txt', 'dirty before\n')
    await store.ensure('s1', repo)
    await store.sync('s1', repo)
    expect((await store.status('s1', repo)).files).toEqual([])
    await store.undo('s1', repo)
    expect(read(repo, 'user.txt')).toBe('dirty before\n')
  })

  it('committed session changes leave review', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'agent\n')
    await record(store, 's1', repo, ['a.txt'])
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'session work')
    expect((await store.status('s1', repo)).files).toEqual([])
  })

  it('deleting an untracked baseline still needs review', async () => {
    const { repo, store } = setup()
    write(repo, 'draft.txt', 'draft\n')
    await store.ensure('s1', repo)
    rmSync(join(repo, 'draft.txt'))
    await record(store, 's1', repo, ['draft.txt'])
    expect(relatives(await store.status('s1', repo))).toEqual(['draft.txt'])
    await store.undo('s1', repo)
    expect(read(repo, 'draft.txt')).toBe('draft\n')
  })

  it('undo restores index state for a staged edit', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'staged\n')
    git(repo, 'add', 'a.txt')
    await record(store, 's1', repo, ['a.txt'])
    await store.undo('s1', repo)
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
  })

  it('status reports git stats and marks missing files deleted', async () => {
    const { repo, store } = setup()
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'a\nmore\n')
    rmSync(join(repo, 'b.txt'))
    await record(store, 's1', repo, ['a.txt', 'b.txt'])
    const status = await store.status('s1', repo)
    const a = status.files.find((f) => f.relative === 'a.txt')
    const b = status.files.find((f) => f.relative === 'b.txt')
    expect(a?.additions).toBe(1)
    expect(a?.path).toBe(join(repo, 'a.txt'))
    expect(b?.status).toBe('deleted')
  })

  it('ensure with a different cwd starts over', async () => {
    const { repo, store } = setup()
    const other = setup().repo
    await store.ensure('s1', repo)
    write(repo, 'a.txt', 'agent\n')
    await record(store, 's1', repo, ['a.txt'])
    await store.ensure('s1', other)
    expect((await store.status('s1', repo)).files).toEqual([])
    expect(read(repo, 'a.txt')).toBe('agent\n')
  })

  it('rejects an invalid session id', () => {
    expect(() => validateSessionId('../x')).toThrow()
    expect(() => validateSessionId('ok_id-1')).not.toThrow()
  })
})
