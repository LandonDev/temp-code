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
  let held: { promise: Promise<void>; release: () => void } | null = null
  const holdListing = (): (() => void) => {
    let release!: () => void
    held = { promise: new Promise<void>((r) => (release = r)), release }
    return () => {
      held = null
      release()
    }
  }
  const asked: string[][] = []
  const pushed: string[][] = Array.from({ length: sinks }, () => [])
  const turns = new CheckpointTurns({
    store,
    session: (id) => (id === 'gone' ? null : { cwd: dir }),
    inHeadMany: async (_root, relatives) => {
      asked.push([...relatives].sort())
      return new Set(relatives.filter((relative) => head.includes(relative)))
    },
    // The settle's git listing held open by the test (holdListing) to overlap it with the next send.
    listTracked: async (root) => {
      listings.push(root)
      if (held) await held.promise
      return new Set(tracked)
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
  /** A write tool's call row, as the registry appends it. */
  const call = (name: string, input: unknown, partial?: boolean, id = 's1') =>
    turns.observe({ sessionId: id, seq: 2, ts: 0, event: { type: 'tool-call', callId: 'c1', name, input, ...(partial ? { partial } : {}) } } satisfies EventRow)
  return { dir, turns, writes, listings, asked, pushed, manifest, file, edit, end, call, holdListing }
}

describe('checkpoint turns', () => {
  it("a settled live edit snapshots nothing of the agent's bytes, and a path made and removed inside the turn is not recorded", async () => {
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
    expect(manifest.files).toEqual({})
    expect(manifest.touched).toEqual(['a.txt', 'new.txt'])
    expect(manifest.tracked).toEqual(['a.txt'])
    expect(git.children).toEqual([])
  })

  it("a write tool's call touches the path it names: the target, not the temporary file the watcher saw", async () => {
    const t = setup({ tracked: ['src/app.ts'] })
    mkdirSync(join(t.dir, 'src'))
    t.file('src/app.ts')
    await t.turns.ensure('s1', t.dir)
    // The Edit tool wrote through a temporary name and renamed it onto the target.
    await t.call('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' })
    t.file('src/app.ts', 'edited\n')
    await t.edit('src/app.ts.tmp.123')
    await t.end()
    expect(t.manifest().touched).toEqual(['src/app.ts'])
    expect(t.manifest().files).toEqual({})
    expect((await t.turns.status('s1')).files.map((f) => f.relative)).toEqual([])
    git.dirty = ['src/app.ts']
    expect((await t.turns.status('s1')).files.map((f) => f.relative)).toEqual(['src/app.ts'])
  })

  it('the flush writes only paths on disk; a temporary file it listed and the turn removed leaves the manifest at the settle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup()
    await t.turns.ensure('s1', t.dir)
    t.file('a.txt')
    t.file('a.txt.tmp.1')
    await t.edit('a.txt')
    await t.edit('a.txt.tmp.1')
    await t.edit('gone.tmp.2') // never on disk by the time it is flushed
    await vi.advanceTimersByTimeAsync(FLUSH_MS)
    await t.turns.written('s1')
    expect(t.manifest().touched).toEqual(['a.txt', 'a.txt.tmp.1'])
    rmSync(join(t.dir, 'a.txt.tmp.1'))
    await t.end()
    expect(t.manifest().touched).toEqual(['a.txt'])
    expect(t.manifest().files).toEqual({})
    // The next turn makes the path for real: it is recorded then.
    await t.turns.ensure('s1', t.dir)
    t.file('a.txt.tmp.1')
    await t.edit('a.txt.tmp.1')
    await t.end()
    expect(t.manifest().touched).toEqual(['a.txt', 'a.txt.tmp.1'])
  })

  it("an edit that settles after the turn waits for the next settle when its file is gone: the temporary file never lists; a deleted tracked file is the sync's", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup({ tracked: ['kept.txt'] })
    await t.turns.ensure('s1', t.dir)
    t.file('a.txt')
    await t.edit('a.txt')
    await t.end()
    expect(t.manifest().touched).toEqual(['a.txt'])
    // The Edit tool's temporary file: its settled edit lands after the turn, the file already renamed away.
    await t.edit('a.txt.tmp.9')
    await vi.advanceTimersByTimeAsync(FLUSH_MS)
    await t.turns.written('s1')
    expect(t.manifest().touched).toEqual(['a.txt'])
    // The next turn's settle asks HEAD: a path HEAD has is recorded, the rest forgotten.
    await t.turns.ensure('s1', t.dir)
    await t.edit('kept.txt') // a tracked file deleted by the shell
    await t.end()
    expect(t.manifest().touched).toEqual(['a.txt', 'kept.txt'])
    expect(t.manifest().tracked).toEqual(['kept.txt'])
  })

  it('an absolute path, a Write, a MultiEdit and a notebook are touched; a partial call, another tool and a path outside the root are not', async () => {
    const t = setup()
    await t.turns.ensure('s1', t.dir)
    await t.call('Write', { file_path: join(t.dir, 'made.txt'), content: 'x' })
    await t.call('MultiEdit', { file_path: 'multi.txt', edits: [] })
    await t.call('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: '' })
    await t.call('Edit', { file_path: 'streaming.txt' }, true)
    await t.call('Read', { file_path: 'read.txt' })
    await t.call('Write', { file_path: join(t.dir, '..', 'outside.txt'), content: 'x' })
    await t.call('Write', { content: 'no path' })
    for (const relative of ['made.txt', 'multi.txt', 'nb.ipynb']) t.file(relative)
    await t.end()
    expect(t.manifest().touched).toEqual(['made.txt', 'multi.txt', 'nb.ipynb'])
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
    t.file('c.txt')
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
    t.file('a.txt')
    await t.edit('a.txt')
    await t.end('s1', { type: 'status', status: 'paused' })
    expect(t.manifest().touched).toEqual(['a.txt'])
  })

  it('writes on a 5 s debounce during a long turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup({ tracked: ['a.txt'] })
    await t.turns.ensure('s1', t.dir)
    const armed = t.writes.mock.calls.length
    t.file('a.txt')
    t.file('b.txt')
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
    expect([t.listings, t.asked, git.children]).toEqual([[], [], []]) // HEAD waits for the settle
    expect(t.pushed).toEqual([['s1']])
    await t.end()
    expect(t.manifest().tracked).toEqual(['a.txt'])
    expect([t.listings.length, t.asked]).toEqual([1, [['b.txt']]])
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

  it('a settle queued behind a write never takes the next send\'s ensure for its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setup()
    await t.turns.ensure('s1', t.dir)
    t.file('a.txt')
    await t.edit('a.txt')
    vi.advanceTimersByTime(FLUSH_MS) // the write is in flight
    const settled = t.end() // queued behind it
    const armed = t.turns.ensure('s1', t.dir) // the next send, before the settle runs
    await Promise.all([settled, armed, t.turns.written('s1')])
    // The next turn writes only through the shell: its settle must still sync.
    git.dirty = ['shell.txt']
    const diffs = git.diffs
    await t.end()
    expect(git.diffs - diffs).toBe(1)
    expect(t.manifest().touched).toEqual(['a.txt', 'shell.txt'])
  })

  it('an edit reaches every owner with a checkpoint: the subagent and its root', async () => {
    const t = setup()
    await t.turns.ensure('root', t.dir)
    t.file('a.txt')
    t.file('b.txt')
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

  it("a write tool's call that lands while the first baseline is still being made waits for it and is never dropped", async () => {
    const t = setup()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const ensure = CheckpointStore.prototype.ensure
    const spy = vi.spyOn(CheckpointStore.prototype, 'ensure').mockImplementation(async function (this: CheckpointStore, id: string, cwd: string) {
      await held
      return ensure.call(this, id, cwd)
    })
    const armed = t.turns.ensure('s1', t.dir)
    // The tool's complete call lands before the baseline is on disk.
    const touched = t.call('Write', { file_path: 'made.txt', content: 'x' })
    release()
    await Promise.all([armed, touched])
    spy.mockRestore()
    t.file('made.txt')
    await t.end()
    expect(t.manifest().touched).toEqual(['made.txt'])
    expect((await t.turns.status('s1')).files.map((f) => f.relative)).toEqual(['made.txt'])
  })

  it("the next send's refresh waits behind a settle still on its listing: the turn's own file is claimed, never snapshotted as the person's", async () => {
    const t = setup()
    await t.turns.ensure('s1', t.dir)
    t.file('agent.txt', 'agent\n')
    git.dirty = ['agent.txt']
    await t.edit('agent.txt')
    const release = t.holdListing()
    const settled = t.end()
    // The next send, while the settle waits on git: its refresh must not see agent.txt as the person's.
    const armed = t.turns.ensure('s1', t.dir)
    release()
    await Promise.all([settled, armed, t.turns.written('s1')])
    expect(t.manifest().files).toEqual({})
    expect(t.manifest().touched).toEqual(['agent.txt'])
    expect((await t.turns.status('s1')).files.map((f) => f.relative)).toEqual(['agent.txt'])
  })

  it("the second send's ensure refreshes the baseline: a live edit of the person's file is a no-op, a write tool's call claims it", async () => {
    const t = setup()
    await t.turns.ensure('s1', t.dir)
    t.file('a.txt')
    await t.edit('a.txt')
    await t.end()
    expect(t.manifest().touched).toEqual(['a.txt'])
    // Between the turns the person makes a file by hand; the next send snapshots it.
    t.file('hand.txt', 'person\n')
    git.dirty = ['a.txt', 'hand.txt']
    await t.turns.ensure('s1', t.dir)
    expect(t.manifest().files).toEqual({ 'hand.txt': 'contents' })
    expect(t.manifest().touched).toEqual(['a.txt'])
    // The watcher's edit of it may be the person's own save: nothing is written.
    const writes = t.writes.mock.calls.length
    await t.edit('hand.txt')
    await t.end()
    expect(t.writes.mock.calls.length).toBe(writes)
    expect(t.manifest().touched).toEqual(['a.txt'])
    expect((await t.turns.status('s1')).files.map((f) => f.relative)).toEqual(['a.txt'])
    // The agent's write tool names it: claimed, shown against the person's bytes, undone to them.
    await t.turns.ensure('s1', t.dir)
    await t.call('Edit', { file_path: 'hand.txt', old_string: 'person', new_string: 'agent' })
    t.file('hand.txt', 'agent\n')
    await t.end()
    expect(t.manifest().touched).toEqual(['a.txt', 'hand.txt'])
    expect(t.manifest().files).toEqual({ 'hand.txt': 'contents' })
    expect((await t.turns.status('s1')).files.map((f) => f.relative)).toEqual(['a.txt', 'hand.txt'])
    await t.turns.undo('s1', 'hand.txt')
    expect(readFileSync(join(t.dir, 'hand.txt'), 'utf8')).toBe('person\n')
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
