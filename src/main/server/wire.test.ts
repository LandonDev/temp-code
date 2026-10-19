import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import {
  boundRows,
  encodedBytes,
  eventsPage,
  profileFor,
  projectLiveEdit,
  projectRow,
  PushCoalescer,
  sessionPage
} from './wire'
import { isOmittedBody } from '@shared/wire'
import { BODY_OMIT_BYTES, HISTORY_PAGE_BYTES, RESUME_ROWS, TAIL_BYTES, TAIL_ROWS } from '@shared/wireBudgets'
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
      edit: { path: 'a.ts', kind: 'changed', adds: 3, dels: 1, diff: big(5000), bytes: 10, ts: 1 }
    }
    const out = projectLiveEdit(push)
    expect(out.edit.diff).toBeNull()
    expect(out.edit.adds).toBe(3)
    const small = { ...push, edit: { ...push.edit, diff: 'tiny' } }
    expect(projectLiveEdit(small)).toBe(small)
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

  it('groups a burst into one frame per kind after the delay, in order', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    c.push(evt('a', 1))
    c.push({ push: 'session', session: meta('a', { status: 'running' }) })
    c.push(evt('b', 1))
    c.push(evt('a', 2))
    c.push({ push: 'session', session: meta('a', { status: 'idle' }) })
    expect(out).toEqual([])
    vi.advanceTimersByTime(99)
    expect(out).toEqual([])
    vi.advanceTimersByTime(1)
    expect(out.map((f) => f.push)).toEqual(['sessions', 'events', 'events'])
    const sessions = out[0] as Extract<ServerPush, { push: 'sessions' }>
    expect(sessions.sessions).toHaveLength(1)
    expect(sessions.sessions[0].status).toBe('idle')
    const a = out[1] as Extract<ServerPush, { push: 'events' }>
    expect(a.sessionId).toBe('a')
    expect(a.rows.map((r) => r.seq)).toEqual([1, 2])
  })

  it('projects bodies off the rows it carries', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    c.push({
      push: 'event',
      row: { sessionId: 'a', seq: 1, ts: 1, event: { type: 'tool-result', callId: 'c', output: big(5000), isError: false } }
    })
    vi.advanceTimersByTime(100)
    const frame = out[0] as Extract<ServerPush, { push: 'events' }>
    expect(isOmittedBody((frame.rows[0].event as { output: unknown }).output)).toBe(true)
  })

  it('a push of another kind flushes what waits first, so order holds', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    c.push(evt('a', 1))
    c.push({ push: 'session-removed', sessionIds: ['a'] })
    expect(out.map((f) => f.push)).toEqual(['events', 'session-removed'])
    vi.advanceTimersByTime(100)
    expect(out).toHaveLength(2)
  })

  it('joins build lines of one run and keeps separate runs apart', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    const run = (id: string) => ({ id, projectId: 'p', target: 't', status: 'running' as const, startedAt: 1 }) as never
    c.push({ push: 'build', projectId: 'p', run: run('r1'), lines: ['a'] })
    c.push({ push: 'build', projectId: 'p', run: run('r1'), lines: ['b', 'c'] })
    c.push({ push: 'build', projectId: 'p', run: run('r2'), lines: ['d'] })
    vi.advanceTimersByTime(100)
    const frame = out[0] as Extract<ServerPush, { push: 'builds' }>
    expect(frame.items.map((i) => i.lines)).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('batches live edits in order', () => {
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
    vi.advanceTimersByTime(100)
    const frame = out[0] as Extract<ServerPush, { push: 'live-edits' }>
    expect(frame.items.map((i) => i.edit.path)).toEqual(['a', 'b'])
  })

  it('dispose drops what waits and ignores what follows', () => {
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    c.push(evt('a', 1))
    c.dispose()
    c.push(evt('a', 2))
    vi.advanceTimersByTime(200)
    expect(out).toEqual([])
  })
})
