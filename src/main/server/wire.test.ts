import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import {
  SocketBudget,
  SOCKET_MAX_BYTES,
  boundRows,
  encodedBytes,
  eventsPage,
  frameJson,
  profileFor,
  projectLiveEdit,
  projectRow,
  PushCoalescer,
  sessionPage,
  eventsWindowMs,
  LAGGING_EVENTS_MS
} from './wire'
import { BACKPRESSURE_BYTES } from './stalls'
import { isOmittedBody } from '@shared/wire'
import {
  BODY_OMIT_BYTES,
  HISTORY_PAGE_BYTES,
  PUSH_COALESCE_MS,
  PUSH_EVENTS_COALESCE_MS,
  RESUME_ROWS,
  STREAMING_BODY_OMIT_BYTES,
  TAIL_BYTES,
  TAIL_ROWS
} from '@shared/wireBudgets'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import type { ServerPush } from '@shared/contract'

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  parentId: null,
  projectId: null,
  workspaceId: null,
  threadType: 'implementation',
  planPath: null,
  provider: 'claude',
  model: 'm',
  reasoning: 'medium',
  agentType: 'implementer',
  title: id,
  cwd: '/tmp',
  status: 'idle',
  pinned: false,
  archived: false,
  fast: false,
  ultrafast: false,
  context1m: false,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  threadRules: null,
  permission: 'edits',
  nativeId: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch
})

const row = (seq: number, event: AgentEvent): EventRow => ({ sessionId: 's', seq, ts: seq, event })
const big = (n: number, fill = 'x'): string => `line one\n${fill.repeat(n)}`

describe('profileFor', () => {
  it('is local unless the socket URL asks for remote', () => {
    expect(profileFor({ url: '/' })).toBe('local')
    expect(profileFor({ url: undefined })).toBe('local')
    expect(profileFor({ url: '/?profile=local' })).toBe('local')
    expect(profileFor({ url: '/?profile=remote' })).toBe('remote')
    expect(profileFor({ url: '/?x=1&profile=remote' })).toBe('remote')
    expect(profileFor({ url: '/lsp/abc?profile=remote' })).toBe('remote')
  })
  it('a remote principal is remote whatever the URL; a local one follows the URL', () => {
    expect(profileFor({ principal: { kind: 'remote' }, url: '/' })).toBe('remote')
    expect(profileFor({ principal: { kind: 'local' }, url: '/' })).toBe('local')
    expect(profileFor({ principal: { kind: 'local' }, url: '/?profile=remote' })).toBe('remote')
  })
})

describe('projectRow', () => {
  it('leaves a small row as the same object', () => {
    const r = row(1, { type: 'tool-result', callId: 'c', output: 'ok', isError: false })
    expect(projectRow(r)).toBe(r)
  })

  it('replaces a large tool output with its summary', () => {
    const output = big(BODY_OMIT_BYTES)
    const r = row(1, { type: 'tool-result', callId: 'c', output, isError: false })
    const out = projectRow(r)
    expect(out).not.toBe(r)
    const body = (out.event as { output: unknown }).output
    expect(isOmittedBody(body)).toBe(true)
    if (!isOmittedBody(body)) throw new Error('unreachable')
    expect(body.bytes).toBe(Buffer.byteLength(output))
    expect(body.lines).toBe(2)
    expect(body.head).toBe('line one')
    // the persisted row is untouched
    expect((r.event as { output: string }).output).toBe(output)
  })

  it('keeps a body one byte under the line and omits one at it', () => {
    const under = row(1, { type: 'tool-result', callId: 'c', output: 'x'.repeat(BODY_OMIT_BYTES - 1), isError: false })
    expect(projectRow(under)).toBe(under)
    const at = row(2, { type: 'tool-result', callId: 'c', output: 'x'.repeat(BODY_OMIT_BYTES), isError: false })
    expect(isOmittedBody((projectRow(at).event as { output: unknown }).output)).toBe(true)
  })

  it('walks a tool input: large strings go, the rest stays, arrays included', () => {
    const r = row(1, {
      type: 'tool-call',
      callId: 'c',
      name: 'Edit',
      input: { file_path: '/a.ts', old_string: 'small', new_string: big(5000), edits: [{ x: big(3000) }, { y: 'ok' }] }
    })
    const out = projectRow(r).event as { input: Record<string, unknown> }
    expect(out.input.file_path).toBe('/a.ts')
    expect(out.input.old_string).toBe('small')
    expect(isOmittedBody(out.input.new_string)).toBe(true)
    const edits = out.input.edits as Record<string, unknown>[]
    expect(isOmittedBody(edits[0].x)).toBe(true)
    expect(edits[1].y).toBe('ok')
  })

  it('gives an edit whose text left the wire its line counts as a preview', () => {
    const r = row(1, {
      type: 'tool-call',
      callId: 'c',
      name: 'Edit',
      input: { file_path: '/src/a.ts', old_string: 'a\nb\nc', new_string: `x\n${'y'.repeat(3000)}\nz\nw` }
    })
    const out = projectRow(r).event as { preview?: { additions?: number; deletions?: number; fileName?: string } }
    expect(out.preview).toMatchObject({ kind: 'write', fileName: 'a.ts', additions: 4, deletions: 3 })
    const write = row(2, { type: 'tool-call', callId: 'w', name: 'Write', input: { file_path: '/b.ts', content: big(3000) } })
    expect((projectRow(write).event as { preview?: { additions?: number } }).preview?.additions).toBe(2)
    const small = row(3, { type: 'tool-call', callId: 's', name: 'Edit', input: { file_path: '/c.ts', old_string: 'a', new_string: 'b' } })
    expect(projectRow(small)).toBe(small)
  })

  it('omits a preview whose diff lines are large and keeps its counts', () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ kind: 'add' as const, text: `added line ${i} ${'y'.repeat(40)}` }))
    const r = row(1, {
      type: 'tool-call',
      callId: 'c',
      name: 'Write',
      input: { file_path: '/a.ts' },
      preview: { kind: 'write', path: '/a.ts', additions: 200, deletions: 0, lines }
    })
    const out = projectRow(r).event as { preview: { additions: number; lines: unknown } }
    expect(out.preview.additions).toBe(200)
    expect(isOmittedBody(out.preview.lines)).toBe(true)
    if (isOmittedBody(out.preview.lines)) expect(out.preview.lines.lines).toBe(200)
  })

  it('never touches conversation text', () => {
    const text = big(100_000)
    for (const event of [
      { type: 'user-text', text } as const,
      { type: 'assistant-text', text, delta: false } as const,
      { type: 'thinking', text, delta: false } as const,
      { type: 'plan', text } as const
    ]) {
      const r = row(1, event)
      expect(projectRow(r)).toBe(r)
    }
  })

  it('omits a large approval-request input body', () => {
    const r = row(1, { type: 'approval-request', requestId: 'r', toolName: 'Write', input: { content: big(4000) } })
    expect(isOmittedBody((projectRow(r).event as { input: { content: unknown } }).input.content)).toBe(true)
  })

  it('degrades a large live-edit diff to null and keeps the counts', () => {
    const push: Extract<ServerPush, { push: 'live-edit' }> = {
      push: 'live-edit',
      cwd: '/p',
      sessionIds: ['s'],
      edit: { path: 'a.ts', kind: 'changed', adds: 3, dels: 1, diff: big(STREAMING_BODY_OMIT_BYTES), bytes: 10, ts: 1 }
    }
    const out = projectLiveEdit(push)
    expect(out.edit.diff).toBeNull()
    expect(out.edit.adds).toBe(3)
    const small = { ...push, edit: { ...push.edit, diff: 'tiny' } }
    expect(projectLiveEdit(small)).toBe(small)
  })

  it('keeps a live-edit diff past the body line but under the streaming line, so the card grows', () => {
    const push: Extract<ServerPush, { push: 'live-edit' }> = {
      push: 'live-edit',
      cwd: '/p',
      sessionIds: ['s'],
      edit: { path: 'a.ts', kind: 'changed', adds: 3, dels: 1, diff: big(8 * BODY_OMIT_BYTES), bytes: 10, ts: 1 }
    }
    expect(projectLiveEdit(push)).toBe(push)
  })

  it('a partial tool call keeps its growing input up to the streaming line; the final call keeps the body line', () => {
    const content = big(8 * BODY_OMIT_BYTES)
    const partial = row(-1, { type: 'tool-call', callId: 'w', name: 'Write', input: { file_path: '/a.ts', content }, partial: true })
    expect(projectRow(partial)).toBe(partial)
    const final = row(2, { type: 'tool-call', callId: 'w', name: 'Write', input: { file_path: '/a.ts', content } })
    expect(isOmittedBody((projectRow(final).event as { input: { content: unknown } }).input.content)).toBe(true)
    const huge = row(-1, {
      type: 'tool-call',
      callId: 'w',
      name: 'Write',
      input: { file_path: '/a.ts', content: big(STREAMING_BODY_OMIT_BYTES) },
      partial: true
    })
    const out = projectRow(huge).event as { input: { content: unknown }; preview?: { additions?: number } }
    expect(isOmittedBody(out.input.content)).toBe(true)
    expect(out.preview?.additions).toBe(2)
  })

  it('a partial edit keeps its preview diff lines up to the streaming line', () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ kind: 'add' as const, text: `added line ${i} ${'y'.repeat(40)}` }))
    const r = row(-1, {
      type: 'tool-call',
      callId: 'c',
      name: 'Write',
      input: { file_path: '/a.ts' },
      partial: true,
      preview: { kind: 'write', path: '/a.ts', additions: 200, deletions: 0, lines }
    })
    expect(projectRow(r)).toBe(r)
  })
})

describe('boundRows', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, { type: 'assistant-text', text: 'a'.repeat(100), delta: false }))
  it('keeps the newest rows that fit', () => {
    const budget = rows.slice(7).reduce((n, r) => n + encodedBytes(r) + 1, 0)
    const out = boundRows(rows, budget, 'newest')
    expect(out.rows.map((r) => r.seq)).toEqual([8, 9, 10])
    expect(out.cut).toBe(true)
  })
  it('keeps the oldest rows that fit', () => {
    const each = encodedBytes(rows[0]) + 1
    const out = boundRows(rows, each * 2, 'oldest')
    expect(out.rows.map((r) => r.seq)).toEqual([1, 2])
  })
  it('always keeps one row, however large', () => {
    const out = boundRows(rows, 1, 'newest')
    expect(out.rows.map((r) => r.seq)).toEqual([10])
  })
  it('returns everything when it fits', () => {
    const out = boundRows(rows, 1_000_000, 'newest')
    expect(out.rows).toHaveLength(10)
    expect(out.cut).toBe(false)
  })
})

describe('eventsPage over a real store', () => {
  let db: ReturnType<typeof openDb>
  let store: Store
  beforeEach(() => {
    db = openDb(':memory:')
    store = new Store(db)
    store.insertSession(meta('s'))
  })
  afterEach(() => db.close())

  /** `n` tool call/result pairs, each result `outBytes` long. */
  function seed(n: number, outBytes: number): void {
    for (let i = 0; i < n; i++) {
      store.appendEvent('s', { type: 'tool-call', callId: `c${i}`, name: 'Bash', input: { command: `echo ${i}` } })
      store.appendEvent('s', { type: 'tool-result', callId: `c${i}`, output: big(outBytes, String(i % 10)), isError: false })
    }
    store.flushEvents()
  }

  it('cold open: the tail, bodies off, bounded by TAIL_BYTES, with the head flagged', () => {
    seed(2000, 4000)
    const page = eventsPage(store, { sessionId: 's', afterSeq: 0, tail: TAIL_ROWS })
    expect(page.reset).toBe(false)
    expect(page.moreBefore).toBe(true)
    expect(page.moreAfter).toBe(false)
    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.rows[page.rows.length - 1].seq).toBe(4000)
    expect(encodedBytes(page.rows)).toBeLessThanOrEqual(TAIL_BYTES + 64)
    for (const r of page.rows) {
      if (r.event.type === 'tool-result') expect(isOmittedBody(r.event.output)).toBe(true)
    }
  })

  it('cold open of a short log comes back whole', () => {
    seed(5, 10)
    const page = eventsPage(store, { sessionId: 's', afterSeq: 0, tail: TAIL_ROWS })
    expect(page.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(page.moreBefore).toBe(false)
  })

  it('resume replays a small gap in place', () => {
    seed(100, 10)
    const page = eventsPage(store, { sessionId: 's', afterSeq: 190 })
    expect(page.reset).toBe(false)
    expect(page.rows.map((r) => r.seq)).toEqual([191, 192, 193, 194, 195, 196, 197, 198, 199, 200])
  })

  it('resume past RESUME_ROWS falls back to a fresh tail with reset', () => {
    seed(400, 10)
    const page = eventsPage(store, { sessionId: 's', afterSeq: 10 })
    expect(page.reset).toBe(true)
    expect(page.moreBefore).toBe(true)
    expect(page.rows[page.rows.length - 1].seq).toBe(800)
    expect(page.rows.length).toBeLessThanOrEqual(2 * TAIL_ROWS)
  })

  it('resume of exactly RESUME_ROWS rows replays; one more resets', () => {
    seed(100, 10)
    const exact = eventsPage(store, { sessionId: 's', afterSeq: 200 - RESUME_ROWS })
    expect(exact.reset).toBe(false)
    expect(exact.rows).toHaveLength(RESUME_ROWS)
    const over = eventsPage(store, { sessionId: 's', afterSeq: 200 - RESUME_ROWS - 1 })
    expect(over.reset).toBe(true)
  })

  it('resume whose rows are small in count but large in bytes resets', () => {
    seed(60, 30_000)
    // 60 pairs = 120 rows (under RESUME_ROWS) but the inputs stay whole? No:
    // outputs are omitted, so bytes are small. A large *conversation* row
    // is what makes a gap heavy: seed assistant text past the budget.
    for (let i = 0; i < 20; i++) store.appendEvent('s', { type: 'assistant-text', text: 'z'.repeat(100_000), delta: false })
    store.flushEvents()
    const page = eventsPage(store, { sessionId: 's', afterSeq: 120 })
    expect(page.reset).toBe(true)
  })

  it('an older page below beforeSeq is bounded and flags what remains', () => {
    seed(2000, 4000)
    const page = eventsPage(store, { sessionId: 's', afterSeq: 0, beforeSeq: 3001, tail: 300 })
    expect(page.rows[page.rows.length - 1].seq).toBe(3000)
    expect(page.moreBefore).toBe(true)
    expect(encodedBytes(page.rows)).toBeLessThanOrEqual(HISTORY_PAGE_BYTES + 64)
    const last = eventsPage(store, { sessionId: 's', afterSeq: 0, beforeSeq: 5, tail: 300 })
    expect(last.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect(last.moreBefore).toBe(false)
  })

  it('a forward walk pages from afterSeq with moreAfter until the end', () => {
    seed(500, 10)
    const first = eventsPage(store, { sessionId: 's', afterSeq: 0, beforeSeq: 701, limit: 4000 })
    expect(first.rows[0].seq).toBe(1)
    expect(first.moreAfter).toBe(true)
    let cursor = first.rows[first.rows.length - 1].seq
    let pages = 1
    for (;;) {
      const next = eventsPage(store, { sessionId: 's', afterSeq: cursor, beforeSeq: 701, limit: 4000 })
      pages++
      cursor = next.rows[next.rows.length - 1].seq
      if (!next.moreAfter) break
    }
    expect(cursor).toBe(700)
    expect(pages).toBeGreaterThan(1)
  })
})

describe('sessionPage', () => {
  const sessions = [
    meta('idle-root-old', { updatedAt: 10 }),
    meta('idle-root-new', { updatedAt: 20 }),
    meta('working-root', { status: 'running', updatedAt: 5 }),
    meta('working-sub', { status: 'running', parentId: 'working-root', updatedAt: 30 }),
    meta('settled-sub', { status: 'done', parentId: 'idle-root-new', updatedAt: 40 }),
    meta('waiting-root', { status: 'waiting', updatedAt: 1 })
  ]

  it('orders working roots, working subagents, settled roots, settled subagents', () => {
    const page = sessionPage(sessions, null)
    expect(page.sessions.map((s) => s.id)).toEqual([
      'working-root',
      'waiting-root',
      'working-sub',
      'idle-root-new',
      'idle-root-old',
      'settled-sub'
    ])
    expect(page.cursor).toBeNull()
  })

  it('walks the whole list in row-bounded pages without a gap or a repeat', () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const page: ReturnType<typeof sessionPage> = sessionPage(sessions, cursor, { maxRows: 2 })
      seen.push(...page.sessions.map((s) => s.id))
      cursor = page.cursor
      if (!cursor) break
    }
    expect(seen).toEqual(sessionPage(sessions, null).sessions.map((s) => s.id))
  })

  it('cuts a page by bytes and always returns one row', () => {
    const page = sessionPage(sessions, null, { maxBytes: 1 })
    expect(page.sessions).toHaveLength(1)
    expect(page.cursor).not.toBeNull()
  })

  it('a bad cursor ends the walk', () => {
    expect(sessionPage(sessions, 'nonsense')).toEqual({ sessions: [], cursor: null })
  })
})

describe('PushCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const evt = (sessionId: string, seq: number): ServerPush => ({
    push: 'event',
    row: { sessionId, seq, ts: seq, event: { type: 'assistant-text', text: `t${seq}`, delta: true } }
  })
  const partial = (callId: string, content: string, sessionId = 'a'): ServerPush => ({
    push: 'event',
    row: {
      sessionId,
      seq: -1,
      ts: 1,
      ephemeral: true,
      event: { type: 'tool-call', callId, name: 'Write', input: { file_path: '/a.ts', content }, partial: true }
    }
  })
  const kinds = (out: ServerPush[]): string[] => out.map((f) => f.push)
  const seqs = (f: ServerPush): number[] => (f as Extract<ServerPush, { push: 'events' }>).rows.map((r) => r.seq)
  const contents = (f: ServerPush): unknown[] =>
    (f as Extract<ServerPush, { push: 'events' }>).rows.map((r) => (r.event as { input?: { content?: unknown } }).input?.content)

  it('defaults to a 33 ms window for event rows and 100 ms for the rest', () => {
    expect(PUSH_EVENTS_COALESCE_MS).toBe(33)
    expect(PUSH_COALESCE_MS).toBe(100)
  })

  it('sends the first row of a quiet period at once, then batches per window', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    c.push(evt('a', 1))
    expect(kinds(out)).toEqual(['events'])
    expect(seqs(out[0])).toEqual([1])
    c.push(evt('a', 2))
    c.push(evt('b', 1))
    c.push(evt('a', 3))
    expect(out).toHaveLength(1)
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS - 1)
    expect(out).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(kinds(out)).toEqual(['events', 'events', 'events'])
    expect((out[1] as Extract<ServerPush, { push: 'events' }>).sessionId).toBe('a')
    expect(seqs(out[1])).toEqual([2, 3])
    expect(seqs(out[2])).toEqual([1])
  })

  it('a steady stream leaves as one frame per window, never faster', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    // a row every 5 ms for a second
    for (let seq = 1; seq <= 200; seq++) {
      c.push(evt('a', seq))
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    const frames = out.filter((f) => f.push === 'events')
    expect(frames.flatMap(seqs)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
    // 1000 ms / 33 ms windows plus the leading frame
    expect(frames.length).toBeLessThanOrEqual(Math.ceil(1000 / PUSH_EVENTS_COALESCE_MS) + 1)
    expect(frames.length).toBeGreaterThanOrEqual(Math.floor(1000 / PUSH_EVENTS_COALESCE_MS))
  })

  it('a window that closes on nothing leaves the lane quiet: the next row goes at once', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    c.push(evt('a', 1))
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    expect(out).toHaveLength(1)
    c.push(evt('a', 2))
    expect(out).toHaveLength(2)
    expect(seqs(out[1])).toEqual([2])
  })

  it('metas keep their 100 ms window while rows leave every 33 ms', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    c.push({ push: 'session', session: meta('a', { status: 'running' }) })
    c.push(evt('a', 1))
    expect(kinds(out)).toEqual(['sessions', 'events'])
    c.push({ push: 'session', session: meta('a', { status: 'running', updatedAt: 2 }) })
    c.push(evt('a', 2))
    c.push({ push: 'session', session: meta('a', { status: 'running', updatedAt: 3 }) })
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    expect(kinds(out)).toEqual(['sessions', 'events', 'events'])
    vi.advanceTimersByTime(PUSH_COALESCE_MS - PUSH_EVENTS_COALESCE_MS)
    expect(kinds(out)).toEqual(['sessions', 'events', 'events', 'sessions'])
    const last = out[3] as Extract<ServerPush, { push: 'sessions' }>
    expect(last.sessions.map((s) => s.updatedAt)).toEqual([3])
  })

  it("a status row's waiting meta goes ahead of the row", () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    c.push(evt('a', 1))
    c.push({ push: 'session', session: meta('b', { status: 'running' }) })
    c.push({ push: 'session', session: meta('a', { status: 'idle' }) })
    c.push({ push: 'session', session: meta('b', { status: 'running', updatedAt: 9 }) })
    c.push({ push: 'event', row: { sessionId: 'a', seq: 2, ts: 2, event: { type: 'status', status: 'idle' } } })
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    // leading row, leading meta (b), then a's meta ahead of a's status row
    expect(kinds(out)).toEqual(['events', 'sessions', 'sessions', 'events'])
    expect((out[2] as Extract<ServerPush, { push: 'sessions' }>).sessions.map((s) => s.id)).toEqual(['a'])
    expect(seqs(out[3])).toEqual([2])
    vi.advanceTimersByTime(PUSH_COALESCE_MS)
    // b's newer meta keeps its own window
    expect((out[4] as Extract<ServerPush, { push: 'sessions' }>).sessions.map((s) => [s.id, s.updatedAt])).toEqual([['b', 9]])
  })

  it('projects bodies off the rows it carries', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    c.push({
      push: 'event',
      row: { sessionId: 'a', seq: 1, ts: 1, event: { type: 'tool-result', callId: 'c', output: big(5000), isError: false } }
    })
    const frame = out[0] as Extract<ServerPush, { push: 'events' }>
    expect(isOmittedBody((frame.rows[0].event as { output: unknown }).output)).toBe(true)
  })

  it('a push of another kind flushes what waits first, so order holds', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    c.push(evt('a', 1))
    c.push(evt('a', 2))
    c.push({ push: 'session', session: meta('a') })
    c.push({ push: 'live-edit', cwd: '/p', sessionIds: ['a'], edit: { path: 'x', kind: 'changed', diff: null, ts: 1 } })
    c.push({ push: 'session-removed', sessionIds: ['a'] })
    expect(kinds(out)).toEqual(['events', 'sessions', 'events', 'live-edits', 'session-removed'])
    vi.advanceTimersByTime(100)
    expect(out).toHaveLength(5)
  })

  it('a flush keeps the window open: a row right after it still waits', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    c.push(evt('a', 1))
    c.push({ push: 'queue', sessionId: 'a', items: [] })
    c.push(evt('a', 2))
    expect(kinds(out)).toEqual(['events', 'queue'])
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    expect(kinds(out)).toEqual(['events', 'queue', 'events'])
  })

  it('joins build lines of one run and keeps separate runs apart', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    const run = (id: string) => ({ id, projectId: 'p', target: 't', status: 'running' as const, startedAt: 1 }) as never
    c.push({ push: 'build', projectId: 'p', run: run('r1'), lines: ['a'] })
    c.push({ push: 'build', projectId: 'p', run: run('r1'), lines: ['b'] })
    c.push({ push: 'build', projectId: 'p', run: run('r1'), lines: ['c', 'd'] })
    c.push({ push: 'build', projectId: 'p', run: run('r2'), lines: ['e'] })
    vi.advanceTimersByTime(100)
    expect(out.map((f) => (f as Extract<ServerPush, { push: 'builds' }>).items.map((i) => i.lines))).toEqual([
      [['a']],
      [['b', 'c', 'd'], ['e']]
    ])
  })

  it('batches live edits in order on the 100 ms previews window, with no leading edge', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    const edit = (path: string): ServerPush => ({
      push: 'live-edit',
      cwd: '/p',
      sessionIds: ['s'],
      edit: { path, kind: 'changed', diff: null, ts: 1 }
    })
    c.push(edit('a'))
    c.push(edit('b'))
    c.push(edit('c'))
    vi.advanceTimersByTime(99)
    expect(out).toEqual([])
    vi.advanceTimersByTime(1)
    expect(out.map((f) => (f as Extract<ServerPush, { push: 'live-edits' }>).items.map((i) => i.edit.path))).toEqual([
      ['a', 'b', 'c']
    ])
  })

  it('a burst of 30 partials for one call within 100 ms leaves as one frame with the newest; text in the same window still leaves within 33 ms', () => {
    const out: { at: number; frame: ServerPush }[] = []
    const start = Date.now()
    const c = new PushCoalescer((frame) => out.push({ at: Date.now() - start, frame }))
    const sent = new Map<number, number>()
    let seq = 0
    for (let k = 0; k < 30; k++) {
      c.push(partial('w', `line ${k} `.repeat(k + 1)))
      // a text delta every 10 ms through the same window
      if (k % 3 === 1) {
        sent.set(++seq, Date.now() - start)
        c.push(evt('a', seq))
      }
      vi.advanceTimersByTime(3)
    }
    expect(Date.now() - start).toBeLessThan(PUSH_COALESCE_MS)
    vi.advanceTimersByTime(PUSH_COALESCE_MS)
    const previews = out.filter(({ frame }) => frame.push === 'events' && seqs(frame).includes(-1))
    expect(previews).toHaveLength(1)
    expect(contents(previews[0].frame)).toEqual([`line 29 `.repeat(30)])
    expect(previews[0].at).toBe(PUSH_COALESCE_MS)
    // every text row left, in order, each within one events window of its push
    const text = out.filter(({ frame }) => frame.push === 'events' && !seqs(frame).includes(-1))
    expect(text.flatMap(({ frame }) => seqs(frame))).toEqual([...sent.keys()])
    for (const { at, frame } of text)
      for (const s of seqs(frame)) expect(at - sent.get(s)!).toBeLessThanOrEqual(PUSH_EVENTS_COALESCE_MS)
    expect(text[0].at).toBe(sent.get(1))
  })

  it('keeps only the newest partial per tool call, apart from the text rows', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    c.push(evt('a', 1))
    c.push(partial('w', 'one'))
    c.push(partial('x', 'other'))
    c.push(evt('a', 2))
    c.push(partial('w', 'one two'))
    c.push(partial('w', 'one two three'))
    c.push(partial('w', 'elsewhere', 'b'))
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    expect(out.map(seqs)).toEqual([[1], [2]])
    vi.advanceTimersByTime(PUSH_COALESCE_MS - PUSH_EVENTS_COALESCE_MS)
    expect(out.slice(2).map((f) => (f as Extract<ServerPush, { push: 'events' }>).sessionId)).toEqual(['a', 'b'])
    expect(contents(out[2])).toEqual(['other', 'one two three'])
    expect(contents(out[3])).toEqual(['elsewhere'])
  })

  it('a final tool call drops the partials of its call that still wait, so no stale preview lands after it', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    c.push(evt('a', 1))
    c.push(partial('w', 'one'))
    c.push(partial('w', 'one two'))
    c.push({
      push: 'event',
      row: { sessionId: 'a', seq: 2, ts: 2, event: { type: 'tool-call', callId: 'w', name: 'Write', input: { file_path: '/a.ts', content: 'one two three' } } }
    })
    vi.advanceTimersByTime(PUSH_COALESCE_MS)
    expect(out.map(seqs)).toEqual([[1], [2]])
    expect(contents(out[1])).toEqual(['one two three'])
  })

  it('a partial already sent is not touched; the next window starts fresh', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    c.push(partial('w', 'one'))
    c.push(partial('w', 'one two'))
    vi.advanceTimersByTime(PUSH_COALESCE_MS)
    c.push(partial('w', 'one two three'))
    c.push(partial('w', 'one two three four'))
    vi.advanceTimersByTime(PUSH_COALESCE_MS)
    expect(out.map(contents)).toEqual([['one two'], ['one two three four']])
  })

  it('a growing partial input past the body line still rides whole', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f))
    const content = big(4 * BODY_OMIT_BYTES)
    c.push(partial('w', content))
    vi.advanceTimersByTime(PUSH_COALESCE_MS)
    expect(contents(out[0])).toEqual([content])
  })

  it('dispose drops what waits and ignores what follows', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    c.push(evt('a', 1))
    c.push(evt('a', 2))
    c.dispose()
    c.push(evt('a', 3))
    vi.advanceTimersByTime(200)
    expect(out.flatMap(seqs)).toEqual([1])
  })
})

describe('PushCoalescer on a local socket', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const local = (out: ServerPush[], immediate?: (id: string) => boolean): PushCoalescer =>
    new PushCoalescer((f) => out.push(f), undefined, undefined, { project: false, immediate })
  const metasOf = (out: ServerPush[]): SessionMeta[] =>
    out.flatMap((f) => (f.push === 'sessions' ? f.sessions : f.push === 'session' ? [f.session] : []))

  it('13,000 meta changes in a second leave as at most ten frames in that second, the newest per thread', () => {
    const out: { at: number; frame: ServerPush }[] = []
    const c = new PushCoalescer((frame) => out.push({ at: Date.now(), frame }), undefined, undefined, { project: false })
    const start = Date.now()
    // 13 changes a millisecond over 40 threads, each carrying its own version.
    let version = 0
    for (let ms = 0; ms < 1000; ms++) {
      for (let k = 0; k < 13; k++) {
        version++
        c.push({ push: 'session', session: meta(`t${version % 40}`, { updatedAt: version }) })
      }
      vi.advanceTimersByTime(1)
    }
    const inSecond = out.filter((o) => o.at - start < 1000)
    expect(inSecond.length).toBeLessThanOrEqual(10)
    vi.advanceTimersByTime(PUSH_COALESCE_MS)
    expect(out.length).toBeLessThanOrEqual(11)
    // A meta never goes older than one already sent for its thread, and the last of each is the newest.
    const seen = new Map<string, number>()
    for (const m of metasOf(out.map((o) => o.frame))) {
      expect(m.updatedAt).toBeGreaterThan(seen.get(m.id) ?? -1)
      seen.set(m.id, m.updatedAt)
    }
    expect(seen.size).toBe(40)
    for (let t = 0; t < 40; t++) expect(seen.get(`t${t}`)).toBe(13_000 - ((13_000 - t) % 40))
  })

  it('rows go as they are (no body projection) and each session\'s rows stay in seq order across windows', () => {
    const out: ServerPush[] = []
    const c = local(out)
    const big = 'x'.repeat(4 * BODY_OMIT_BYTES)
    const row = (sessionId: string, seq: number): ServerPush => ({
      push: 'event',
      row: { sessionId, seq, ts: seq, event: { type: 'tool-result', callId: `c${seq}`, output: big, isError: false } }
    })
    for (let seq = 1; seq <= 30; seq++) {
      c.push(row('a', seq))
      c.push(row('b', seq))
      vi.advanceTimersByTime(7)
    }
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    const frames = out.filter((f): f is Extract<ServerPush, { push: 'events' }> => f.push === 'events')
    for (const id of ['a', 'b']) {
      const rows = frames.filter((f) => f.sessionId === id).flatMap((f) => f.rows)
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
      expect(rows.every((r) => r.event.type === 'tool-result' && r.event.output === big)).toBe(true)
    }
    expect(frames.length).toBeLessThan(60)
  })

  it('the immediate seam sends a focused thread\'s rows at once, behind its own waiting ones and its status meta', () => {
    const out: ServerPush[] = []
    let focused: string | null = null
    const c = local(out, (id) => id === focused)
    const row = (sessionId: string, seq: number, type: 'text' | 'status' = 'text'): ServerPush => ({
      push: 'event',
      row: { sessionId, seq, ts: seq, event: type === 'status' ? { type: 'status', status: 'running' } : { type: 'assistant-text', text: `t${seq}`, delta: true } }
    })
    c.push(row('a', 1))
    c.push(row('a', 2))
    c.push(row('b', 1))
    expect(out.flatMap((f) => (f.push === 'events' ? f.rows.map((r) => `${r.sessionId}${r.seq}`) : []))).toEqual(['a1'])
    focused = 'a'
    c.push({ push: 'session', session: meta('a', { status: 'running' }) })
    c.push(row('a', 3, 'status'))
    // a's waiting row 2 and the new row 3 leave now, its meta ahead; b still waits for the window.
    expect(out.map((f) => f.push)).toEqual(['events', 'sessions', 'events'])
    expect((out[2] as Extract<ServerPush, { push: 'events' }>).rows.map((r) => r.seq)).toEqual([2, 3])
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    expect(out.at(-1)).toMatchObject({ push: 'events', sessionId: 'b' })
  })
})

describe('the events window follows the loop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('33 ms while the loop keeps up; 100 ms locally and 250 ms remotely while it lags', () => {
    expect(eventsWindowMs('local', 10)).toBe(PUSH_EVENTS_COALESCE_MS)
    expect(eventsWindowMs('remote', 49)).toBe(PUSH_EVENTS_COALESCE_MS)
    expect(eventsWindowMs('local', 50)).toBe(LAGGING_EVENTS_MS.local)
    expect(eventsWindowMs('remote', 120)).toBe(LAGGING_EVENTS_MS.remote)
    expect(LAGGING_EVENTS_MS).toEqual({ local: 100, remote: 250 })
  })

  it('under lag an unfocused thread\'s rows wait the wide window, the focused thread\'s go at once', () => {
    const out: { at: number; frame: ServerPush }[] = []
    let lag = 0
    const start = Date.now()
    const c = new PushCoalescer((frame) => out.push({ at: Date.now() - start, frame }), undefined, undefined, {
      project: false,
      immediate: (id) => id === 'focused',
      eventsDelay: () => eventsWindowMs('remote', lag)
    })
    const row = (sessionId: string, seq: number): ServerPush => ({
      push: 'event',
      row: { sessionId, seq, ts: seq, event: { type: 'assistant-text', text: `t${seq}`, delta: true } }
    })
    lag = 80
    c.push(row('other', 1)) // leading edge: at once, and the window opens wide
    c.push(row('other', 2))
    c.push(row('focused', 1))
    c.push(row('focused', 2))
    const rows = (sessionId: string) =>
      out.flatMap((o) => (o.frame.push === 'events' && o.frame.sessionId === sessionId ? o.frame.rows.map((r) => [o.at, r.seq]) : []))
    expect(rows('focused')).toEqual([[0, 1], [0, 2]])
    expect(rows('other')).toEqual([[0, 1]])
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    expect(rows('other')).toEqual([[0, 1]])
    vi.advanceTimersByTime(LAGGING_EVENTS_MS.remote - PUSH_EVENTS_COALESCE_MS)
    expect(rows('other')).toEqual([[0, 1], [LAGGING_EVENTS_MS.remote, 2]])
    // The loop caught up: the next window is the ordinary one.
    lag = 0
    vi.advanceTimersByTime(LAGGING_EVENTS_MS.remote)
    c.push(row('other', 3))
    c.push(row('other', 4))
    vi.advanceTimersByTime(PUSH_EVENTS_COALESCE_MS)
    expect(rows('other').map(([, seq]) => seq)).toEqual([1, 2, 3, 4])
    c.dispose()
  })
})

describe('frameJson', () => {
  it('writes the bytes JSON.stringify would, stringifying each shared meta and row once across sockets', () => {
    const m = meta('a', { title: 'Quote " and \\ slash' })
    const row: EventRow = { sessionId: 'a', seq: 3, ts: 1, event: { type: 'assistant-text', text: 'hi', delta: false } }
    const frames: ServerPush[] = [
      { push: 'session', session: m },
      { push: 'sessions', sessions: [m, meta('b')] },
      { push: 'event', row },
      { push: 'events', sessionId: 'a', rows: [row, row] }
    ]
    for (const f of frames) expect(frameJson(f)).toBe(JSON.stringify(f))
    expect(frameJson({ id: '1', ok: true, result: { x: 1 } })).toBe(JSON.stringify({ id: '1', ok: true, result: { x: 1 } }))
    // A second socket's frames carrying the same meta and row reuse their strings.
    const shared = meta('c')
    const sharedRow: EventRow = { sessionId: 'c', seq: 1, ts: 1, event: { type: 'assistant-text', text: 'x', delta: false } }
    frameJson({ push: 'sessions', sessions: [shared] })
    frameJson({ push: 'events', sessionId: 'c', rows: [sharedRow] })
    const stringify = vi.spyOn(JSON, 'stringify')
    for (let socket = 0; socket < 5; socket++) {
      frameJson({ push: 'sessions', sessions: [shared] })
      frameJson({ push: 'events', sessionId: 'c', rows: [sharedRow] })
    }
    // Only the session id of each events frame is stringified again.
    expect(stringify.mock.calls.filter(([v]) => typeof v !== 'string')).toEqual([])
    stringify.mockRestore()
  })

  it('a large row is projected once for every remote socket', () => {
    const row: EventRow = { sessionId: 'a', seq: 1, ts: 1, event: { type: 'tool-result', callId: 'c', output: 'x'.repeat(2 * BODY_OMIT_BYTES), isError: false } }
    const first = projectRow(row)
    expect(first).not.toBe(row)
    expect(projectRow(row)).toBe(first)
  })
})

describe('SocketBudget', () => {
  afterEach(() => vi.useRealTimers())
  it('drops unfocused pushes above the budget while preserving focused rows and answers', () => {
    let buffered = BACKPRESSURE_BYTES
    const budget = new SocketBudget({ buffered: () => buffered, focused: (id) => id === 'focus', resync: vi.fn(), close: vi.fn() })
    const background = { push: 'session', session: meta('background') } as const
    expect(budget.filter(background)).toBe(background)
    buffered++
    expect(budget.filter(background)).toBeNull()
    const answer = { id: 'a', ok: true, result: 42 } as const
    expect(budget.filter(answer)).toBe(answer)
    const focused = { push: 'event', row: { ...row(1, { type: 'user-text', text: 'hi' }), sessionId: 'focus' } } as const
    expect(budget.filter(focused)).toBe(focused)
    expect(budget.filter({ push: 'sessions', sessions: [meta('background'), meta('focus')] }))
      .toEqual({ push: 'sessions', sessions: [meta('focus')] })
    budget.dispose()
  })

  it('sends one resync when the queue drains below half, even with no later push', async () => {
    vi.useFakeTimers()
    let buffered = BACKPRESSURE_BYTES + 1
    const resync = vi.fn()
    const budget = new SocketBudget({ buffered: () => buffered, focused: () => false, resync, close: vi.fn() })
    budget.filter({ push: 'events', sessionId: 's', rows: [] })
    buffered = BACKPRESSURE_BYTES / 2
    await vi.advanceTimersByTimeAsync(100)
    expect(resync).not.toHaveBeenCalled()
    buffered--
    await vi.advanceTimersByTimeAsync(1000)
    expect(resync).toHaveBeenCalledTimes(1)
    budget.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes once with 1013 past 64 MiB, including focused traffic or answers', () => {
    let buffered = SOCKET_MAX_BYTES
    const close = vi.fn()
    const budget = new SocketBudget({ buffered: () => buffered, focused: () => true, resync: vi.fn(), close })
    const answer = { id: 'a', ok: true, result: 42 } as const
    expect(budget.filter(answer)).toBe(answer)
    buffered++
    expect(budget.poll()).toBe(false)
    expect(budget.filter(answer)).toBeNull()
    expect(close).toHaveBeenCalledExactlyOnceWith(1013, expect.any(String))
  })
})
