import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, EventRow } from '@shared/events'

/** No git here: the store's own children land in `children` and fail, and
 *  the index the settle's sync reads is whatever `dirty` says. */
const git = vi.hoisted(() => ({ children: [] as string[][], dirty: [] as string[], diffs: 0 }))
vi.mock('./spawnBudget', async (importOriginal) => {
  const real = await importOriginal<typeof import('./spawnBudget')>()
  return {
    ...real,
    execFileBudgeted: (_file: string, args: string[]) => {
      git.children.push(args)
      return Promise.reject(new Error('no git in this test'))
    }
  }
})
vi.mock('./gitops', () => ({
  gitDiffIndex: async (root: string) => {
    git.diffs += 1
    const files = git.dirty.map((relative) => ({
      path: join(root, relative),
      relative,
      status: 'untracked',
      additions: 0,
      deletions: 0,
      staged: false,
      unstaged: true
    }))
    return { files }
  }
}))

import { CheckpointStore } from './checkpoint'
import { CheckpointTurns, FLUSH_MS } from './checkpointTurns'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  git.children.length = 0
  git.dirty = []
  git.diffs = 0
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** A work dir, a real store beside it, and the turns over fakes that count. */
function setup({ tracked = [] as string[], head = [] as string[], sinks = 1 } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tc-cp-turns-'))
  roots.push(base)
  const dir = join(base, 'work')
  mkdirSync(dir)
  const store = new CheckpointStore(join(base, 'checkpoints'))
  const writes = vi.spyOn(CheckpointStore.prototype as unknown as { save: () => Promise<void> }, 'save')
  const listings: string[] = []
  const asked: string[][] = []
  const pushed: string[][] = Array.from({ length: sinks }, () => [])
  const turns = new CheckpointTurns({
    store,
    session: (id) => (id === 'gone' ? null : { cwd: dir }),
    listTracked: async (root) => {
      listings.push(root)
      return new Set(tracked)
    },
    inHeadMany: async (_root, relatives) => {
      asked.push([...relatives].sort())
      return new Set(relatives.filter((relative) => head.includes(relative)))
    },
    // The index's fan-out: every socket subscribed to the session hears it.
    push: (sessionId) => {
      for (const sink of pushed) sink.push(sessionId)
    }
  })
  const manifest = (id = 's1') =>
    JSON.parse(readFileSync(join(base, 'checkpoints', id, 'manifest.json'), 'utf8')) as {
      files: Record<string, string>
      touched: string[]
      tracked: string[]
    }
  const file = (relative: string, body = 'x\n') => writeFileSync(join(dir, relative), body)
  const edit = (relative: string, sessionIds = ['s1'], settled = true) =>
    turns.liveEdit({ cwd: dir, sessionIds, edit: { path: relative, kind: 'changed', diff: null, settled, ts: 0 } })
  const end = (id = 's1', event: AgentEvent = { type: 'turn-complete' }) =>
    turns.observe({ sessionId: id, seq: 1, ts: 0, event } satisfies EventRow)
  return { dir, turns, writes, listings, asked, pushed, manifest, file, edit, end }
}

describe('checkpoint turns', () => {
  it('a settled live edit snapshots only a file that neither HEAD nor the disk has', async () => {
    const t = setup({ tracked: ['a.txt'] })
    t.file('a.txt')
    await t.turns.ensure('s1', t.dir)
    t.file('a.txt', 'agent\n')
    t.file('new.txt', 'made\n')
    await t.edit('a.txt')
    await t.edit('new.txt')
    await t.edit('scratch.txt') // made and deleted again within the turn
    await t.edit('ignored.txt', ['s1'], false) // not settled yet
    await t.end()
    const manifest = t.manifest()
    expect(manifest.files).toEqual({ 'scratch.txt': 'missing' })
    expect(manifest.touched).toEqual(['a.txt', 'new.txt', 'scratch.txt'])
    expect(manifest.tracked).toEqual(['a.txt'])
    expect(git.children).toEqual([])
  })

  it('a second edit of a path costs nothing: no snapshot, no git, no write', async () => {
    const t = setup()
    await t.turns.ensure('s1', t.dir)
    await t.edit('a.txt')
    const writes = t.writes.mock.calls.length
    await t.edit('a.txt')
    await t.edit('a.txt')
    expect(t.writes.mock.calls.length).toBe(writes)
    expect([t.listings, t.asked, git.children]).toEqual([[], [], []])
    await t.end()
    // The next turn knows the path from the manifest: its edit is free too.
    await t.turns.ensure('s1', t.dir)
    const before = { writes: t.writes.mock.calls.length, listings: t.listings.length, asked: t.asked.length }
    await t.edit('a.txt')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await vi.advanceTimersByTimeAsync(FLUSH_MS)
    await t.turns.written('s1')
    expect({ writes: t.writes.mock.calls.length, listings: t.listings.length, asked: t.asked.length }).toEqual(before)
  })

  it('writes the manifest once when the turn settles, however many edits it made', async () => {
    const t = setup({ tracked: ['a.txt', 'b.txt'] })
    await t.turns.ensure('s1', t.dir)
    const armed = t.writes.mock.calls.length
    for (const relative of ['a.txt', 'b.txt', 'c.txt']) await t.edit(relative)
    git.dirty = ['a.txt', 'd.txt'] // d.txt: a shell write no live edit saw
    expect(t.writes.mock.calls.length).toBe(armed)
    await t.end()
    expect(t.writes.mock.calls.length).toBe(armed + 1)
    expect(t.manifest().touched).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
  })

  it('syncs once per settle however many sockets are open, and each hears it once', async () => {
    const t = setup({ sinks: 3 })
    await t.turns.ensure('s1', t.dir)
    const ensureDiffs = git.diffs
    await t.edit('a.txt')
    await t.end('s1', { type: 'turn-complete' })
    await t.end('s1', { type: 'status', status: 'idle' })
    expect(git.diffs - ensureDiffs).toBe(1)
    expect(t.pushed).toEqual([['s1'], ['s1'], ['s1']])
  })

  it('a host with no socket open still captures', async () => {
    const t = setup({ sinks: 0 })
    await t.turns.ensure('s1', t.dir)
    await t.edit('a.txt')
    await t.end('s1', { type: 'status', status: 'paused' })
    expect(t.manifest().touched).toEqual(['a.txt'])
  })

  it('writes on a 5 s debounce during a long turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup({ tracked: ['a.txt'] })
    await t.turns.ensure('s1', t.dir)
    const armed = t.writes.mock.calls.length
    await t.edit('a.txt')
    await vi.advanceTimersByTimeAsync(FLUSH_MS - 1_000)
    await t.edit('b.txt') // inside the window: it does not push the write back
    await vi.advanceTimersByTimeAsync(999)
    await t.turns.written('s1')
    expect(t.writes.mock.calls.length).toBe(armed)
    await vi.advanceTimersByTimeAsync(1)
    await t.turns.written('s1')
    expect(t.writes.mock.calls.length).toBe(armed + 1)
    expect(t.manifest().touched).toEqual(['a.txt', 'b.txt'])
    expect(t.asked).toEqual([]) // b.txt waits for the settle to ask HEAD
    expect(t.pushed).toEqual([['s1']])
  })

  it('asks HEAD once at the settle, for the paths the listing does not know', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup({ tracked: ['a.txt'], head: ['late.txt'] })
    await t.turns.ensure('s1', t.dir)
    await t.edit('early.txt')
    await vi.advanceTimersByTimeAsync(FLUSH_MS) // written unasked mid-turn
    await t.turns.written('s1')
    await t.edit('a.txt')
    await t.edit('late.txt') // committed after the listing was taken
    await t.end()
    expect(t.listings).toHaveLength(1)
    expect(t.asked).toEqual([['early.txt', 'late.txt']])
    expect(t.manifest().tracked).toEqual(['a.txt', 'late.txt'])
  })

  it('an edit reaches every owner with a checkpoint: the subagent and its root', async () => {
    const t = setup()
    await t.turns.ensure('root', t.dir)
    await t.edit('a.txt', ['sub', 'root'])
    await t.end('root')
    await t.end('sub')
    expect(t.manifest('root').touched).toEqual(['a.txt'])
    expect(existsSync(join(t.dir, '..', 'checkpoints', 'sub'))).toBe(false)
    await t.turns.ensure('sub', t.dir)
    await t.edit('b.txt', ['sub', 'root'])
    await t.end('sub')
    await t.end('root')
    expect(t.manifest('sub').touched).toEqual(['b.txt'])
    expect(t.manifest('root').touched).toEqual(['a.txt', 'b.txt'])
  })

  it('status, undo and keep find the cwd on the session row', async () => {
    const t = setup()
    await t.turns.ensure('s1', t.dir)
    t.file('new.txt')
    git.dirty = ['new.txt']
    await t.edit('new.txt')
    await t.end()
    expect((await t.turns.status('s1')).files.map((f) => f.relative)).toEqual(['new.txt'])
    expect(await t.turns.status('gone')).toEqual({ files: [] })
    expect(await t.turns.undo('s1')).toEqual({ files: [] })
    expect(existsSync(join(t.dir, 'new.txt'))).toBe(false)
    // Undo all dropped the checkpoint: edits wait for the next send's ensure.
    const writes = t.writes.mock.calls.length
    await t.edit('other.txt')
    await t.end()
    expect(t.writes.mock.calls.length).toBe(writes)
    expect(await t.turns.keep('s1')).toEqual({ files: [] })
  })
})
