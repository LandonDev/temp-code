import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { cancelMirrors, DIGEST_TAIL_PAGE, mirrorName, mirrorSession, scheduleMirror, renderMirror, renderMirrorOffLoop, threadDigestTail, writeThreadsIndex } from './mirror'
import type { AgentEvent, SessionMeta } from '@shared/events'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-mirror-index-'))
})
afterEach(() => {
  cancelMirrors()
  vi.useRealTimers()
  vi.clearAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const mirror = (title: string, updated: string, body: string): string =>
  `---\ntitle: "${title}"\ntype: implementation\nstatus: idle\nupdated: ${updated}\n---\n\n${body}`

describe('writeThreadsIndex', () => {
  it('lists every mirror newest first, reading only the head of each file', () => {
    // A transcript far larger than the head window: the index reads its
    // first 4 KB, never the whole file.
    writeFileSync(join(dir, 'a-big.md'), mirror('Big thread', '2026-09-28T10:00:00.000Z', 'x'.repeat(2_000_000)))
    writeFileSync(join(dir, 'b-small.md'), mirror('Small thread', '2026-09-29T10:00:00.000Z', 'short'))
    writeFileSync(join(dir, 'c-untitled.md'), 'no frontmatter here')
    writeFileSync(join(dir, 'notes.txt'), 'not a mirror')
    writeThreadsIndex(dir)
    const index = readFileSync(join(dir, 'INDEX.md'), 'utf8')
    const lines = index.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"Small thread"')
    expect(lines[0]).toContain('threads/b-small.md')
    expect(lines[1]).toContain('"Big thread"')
    expect(lines[1]).toContain('threads/a-big.md')
    expect(index).not.toContain('c-untitled')
  })

  it('a mirror whose frontmatter runs past the head window is skipped, not misread', () => {
    const long = `---\ntitle: "Padded"\nnoise: ${'y'.repeat(5_000)}\nupdated: 2026-09-29\n---\n`
    writeFileSync(join(dir, 'padded.md'), long)
    writeFileSync(join(dir, 'fine.md'), mirror('Fine', '2026-09-27', ''))
    writeThreadsIndex(dir)
    const index = readFileSync(join(dir, 'INDEX.md'), 'utf8')
    // The title sits inside the first 4 KB so the padded one still lists;
    // its `updated` (past the window) reads as unknown.
    expect(index).toContain('"Padded"')
    expect(index).toContain('"Fine"')
    expect(index.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2)
  })
})

const thread: SessionMeta = {
  id: 'm', parentId: null, projectId: 'p', workspaceId: null, threadType: 'implementation', planPath: '/plan.md',
  provider: 'claude', model: 'x', reasoning: 'medium', agentType: 'implementer', title: 'Mirror me', cwd: '/repo',
  status: 'idle', pinned: false, archived: false, fast: false, ultrafast: false, context1m: false, busySince: null,
  pausedAt: null, frozenActiveElapsed: null, threadRules: null, permission: 'edits', nativeId: null, createdAt: 1, updatedAt: 2
}

/** A seeded log of everything a transcript holds: deltas, big bodies,
 *  string and odd inputs, subagent lanes, goals, failures. */
function seededLog(seed: number, n: number): AgentEvent[] {
  let x = seed
  const rnd = (k: number): number => ((x = (x * 1103515245 + 12345) % 2147483648), x % k)
  const names = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Agent', 'apply_patch', 'shell', 'NotebookEdit']
  const out: AgentEvent[] = []
  for (let i = 0; i < n; i++) {
    switch (rnd(11)) {
      case 0: out.push({ type: 'user-text', text: `ask ${i}`, attachments: [{ path: '/x.png', name: 'x.png', kind: 'image' }] }); break
      case 1: out.push({ type: 'assistant-text', text: `delta ${i}`, delta: true }); break
      case 2: out.push({ type: 'assistant-text', text: `final ${i} ${'a'.repeat(rnd(3000))}`, delta: false, ...(rnd(4) === 0 ? { parentCallId: 'p1' } : {}) }); break
      case 3: {
        const input = rnd(3) === 0 ? { file_path: rnd(2) ? `/repo/src/f${rnd(20)}.ts` : `src/g${rnd(20)}.ts`, content: 'c'.repeat(rnd(9000)) }
          : rnd(2) ? { command: `echo ${'  spaced   out '.repeat(rnd(30))} ${i}` } : { prompt: 'p'.repeat(rnd(6000)), path: { nested: true } }
        out.push({ type: 'tool-call', callId: `c${rnd(40)}`, name: names[rnd(names.length)], input, ...(rnd(5) === 0 ? { parentCallId: 'p1' } : {}) })
        break
      }
      case 4: out.push({ type: 'tool-result', callId: `c${rnd(40)}`, output: 'o'.repeat(rnd(20000)), isError: rnd(3) === 0 }); break
      case 5: out.push({ type: 'goal', phase: (['set', 'updated', 'met', 'cleared'] as const)[rnd(4)], condition: `g${i}`, iterations: rnd(5), ...(rnd(2) ? { reason: 'why' } : {}) }); break
      case 6: out.push({ type: 'status', status: 'idle' }); break
      case 7: out.push({ type: 'tool-call', callId: `c${rnd(40)}`, name: 'Bash', input: 'a string input' }); break
      case 8: out.push({ type: 'tool-call', callId: `c${rnd(40)}`, name: 'Read', input: { notebook_path: '../outside.ipynb', command: 7 } }); break
      case 9: out.push({ type: 'thinking', text: 't'.repeat(rnd(500)) } as AgentEvent); break
      default: out.push({ type: 'turn-complete' } as AgentEvent)
    }
  }
  return out
}

describe('renderMirrorOffLoop', () => {
  it('reads the log in chunks with only what the mirror reads, and writes the same mirror as the whole rows', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const db = openDb(':memory:')
      const store = new Store(db)
      store.insertSession(thread)
      for (const e of seededLog(seed, 300)) store.appendEvent('m', e)
      const reads = vi.spyOn(store, 'readRows')
      const between = vi.fn(async () => {})
      const off = await renderMirrorOffLoop({ readLogRows: (id, o) => store.readRows(id, o) }, thread, { chunk: 23, between })
      expect(off).toBe(renderMirror(thread, store.eventsAfter('m', 0)))
      // Deltas, statuses and thinking never left the read; a quiet loop between chunks.
      expect(reads.mock.calls[0][1].whereSql).toContain("'user-text'")
      expect(reads.mock.calls.length).toBeGreaterThan(1)
      expect(between).toHaveBeenCalledTimes(reads.mock.calls.length - 1)
      db.close()
    }
  })

  it('renders the dialogue, the tool lines with failures, the files and the outcome', () => {
    const rows = [
      { type: 'user-text', text: 'fix it' },
      { type: 'tool-call', callId: 'a', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' } },
      { type: 'tool-result', callId: 'a', output: 'ok', isError: false },
      { type: 'tool-call', callId: 'b', name: 'Bash', input: { command: 'bun   test' } },
      { type: 'tool-result', callId: 'b', output: 'fail', isError: true },
      { type: 'assistant-text', text: 'Fixed the parser.', delta: false }
    ].map((event, i) => ({ sessionId: 'm', seq: i + 1, ts: i, event: event as AgentEvent }))
    const out = renderMirror(thread, rows)
    expect(out).toContain('files: src/a.ts')
    expect(out).toContain('## Outcome\n\nFixed the parser.')
    expect(out).toContain('## User\n\nfix it')
    expect(out).toContain('- Edit /repo/src/a.ts\n- Bash: bun test (failed)\n\nFixed the parser.')
  })

  it('mirrorSession writes off the loop, one render per thread at a time; one asked for meanwhile runs once after', async () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    const meta = { ...thread, cwd: dir }
    store.insertSession(meta)
    store.appendEvent('m', { type: 'user-text', text: 'first' })
    let reads = 0
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const reg = {
      get: () => meta,
      getProject: () => ({ id: 'p', cwd: dir }),
      readLogRows: async (id: string, o: Parameters<Store['readRows']>[1]) => {
        reads++
        const rows = await store.readRows(id, o)
        if (reads === 1) await held
        return rows
      }
    }
    const first = mirrorSession(reg as never, 'm')
    // Two more asks while the first render waits: one more render, not two.
    void mirrorSession(reg as never, 'm')
    void mirrorSession(reg as never, 'm')
    store.appendEvent('m', { type: 'user-text', text: 'second' })
    release()
    await first
    await vi.waitFor(() => expect(reads).toBe(2))
    await vi.waitFor(() => expect(readFileSync(join(dir, '.temp-code', 'threads', mirrorName(meta)), 'utf8')).toContain('## User\n\nsecond'))
    expect(readFileSync(join(dir, '.temp-code', 'threads', 'INDEX.md'), 'utf8')).toContain('"Mirror me"')
    db.close()
  })
})

it('three settles in a window render each session once and share one index write', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const db = openDb(':memory:')
  const store = new Store(db)
  const a = { ...thread, id: 'a', cwd: dir }
  const b = { ...thread, id: 'b', cwd: dir }
  store.insertSession(a)
  store.insertSession(b)
  store.appendEvent('a', { type: 'user-text', text: 'first' })
  store.appendEvent('b', { type: 'user-text', text: 'second' })
  const readLogRows = vi.fn((id, opts) => store.readRows(id, opts))
  const reg = { get: (id: string) => id === 'a' ? a : b, getProject: () => ({ cwd: dir }), readLogRows }
  try {
    scheduleMirror(reg as never, 'a')
    scheduleMirror(reg as never, 'b')
    await vi.advanceTimersByTimeAsync(1000)
    scheduleMirror(reg as never, 'a')
    await vi.advanceTimersByTimeAsync(999)
    expect(readLogRows).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1001)
    expect(readLogRows).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    const writes = vi.mocked(renameSync).mock.calls.map((args) => String(args[1]))
    expect(writes.filter((path) => path.endsWith('/INDEX.md'))).toHaveLength(1)
    expect(writes.filter((path) => path.endsWith(mirrorName(a)))).toHaveLength(1)
    expect(writes.filter((path) => path.endsWith(mirrorName(b)))).toHaveLength(1)
    expect(readFileSync(join(dir, '.temp-code', 'threads', 'INDEX.md'), 'utf8')).toContain('threads/a-')
  } finally {
    cancelMirrors()
    db.close()
  }
})

it('the index waits for a queued render when a previous window is still rendering', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let meta = { ...thread, cwd: dir }
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  const second = new Promise<void>((resolve) => { releaseSecond = resolve })
  let reads = 0
  const reg = {
    get: () => meta,
    getProject: () => ({ cwd: dir }),
    readLogRows: async () => { await (++reads === 1 ? first : second); return [] }
  }
  const indexes = (): string[] => vi.mocked(renameSync).mock.calls.map((args) => String(args[1])).filter((path) => path.endsWith('/INDEX.md'))
  scheduleMirror(reg as never, 'm')
  await vi.advanceTimersByTimeAsync(2000)
  meta = { ...meta, title: 'Latest title' }
  scheduleMirror(reg as never, 'm')
  await vi.advanceTimersByTimeAsync(2000)
  releaseFirst()
  await vi.advanceTimersByTimeAsync(0)
  expect(reads).toBe(2)
  expect(indexes()).toHaveLength(0)
  releaseSecond()
  await vi.advanceTimersByTimeAsync(0)
  expect(indexes()).toHaveLength(2)
  expect(readFileSync(join(dir, '.temp-code', 'threads', 'INDEX.md'), 'utf8')).toContain('Latest title')
})

describe('threadDigestTail', () => {
  it('reads a long log from its end in pages until the cap is covered, never the whole log', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      sessionId: 's',
      seq: i + 1,
      ts: i,
      event: i % 2 === 0 ? { type: 'user-text', text: `question ${i + 1} ${'x'.repeat(40)}` } : { type: 'assistant-text', text: `answer ${i + 1} ${'y'.repeat(40)}`, delta: false }
    })) as never[]
    const asked: number[] = []
    const reg = {
      getProject: () => null,
      notes: { textFor: () => null },
      lastEvents: (_id: string, limit: number) => {
        asked.push(limit)
        return rows.slice(-limit)
      }
    }
    const meta = { id: 's', title: 'Long', projectId: null, createdAt: 0, updatedAt: 0, status: 'idle', threadType: 'chat' } as unknown as SessionMeta
    const digest = threadDigestTail(reg as never, meta, 12_000)
    expect(asked).toEqual([DIGEST_TAIL_PAGE])
    expect(digest).toContain('answer 10000')
    expect(digest).not.toContain('question 1 ')
    expect(digest.length).toBeGreaterThanOrEqual(12_000)
    // A short log is read whole, once.
    asked.length = 0
    const short = { ...reg, lastEvents: (_id: string, limit: number) => (asked.push(limit), rows.slice(0, 5)) }
    expect(threadDigestTail(short as never, meta, 12_000)).toContain('question 1 ')
    expect(asked).toEqual([DIGEST_TAIL_PAGE])
  })
})
