import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { encodedBytes, eventsPage, projectRow, PushCoalescer, sessionPage } from './wire'
import { isOmittedBody } from '@shared/wire'
import type { EventsPage } from '@shared/wire'
import {
  BODY_OMIT_BYTES,
  HISTORY_PAGE_BYTES,
  KIB,
  RESUME_BYTES,
  RESUME_ROWS,
  SHELL_PAGE_BYTES,
  TAIL_BYTES,
  TAIL_ROWS
} from '@shared/wireBudgets'
import type { AgentEvent, EventRow, SessionMeta, ToolPreview } from '@shared/events'
import type { ServerFrame, ServerPush } from '@shared/contract'

/**
 * The wire regression test (`bun run test:perf:wire`, also part of the
 * suite): a seeded synthetic workload runs through the real server-side
 * projection, paging and coalescing path for both profiles, and the
 * remote bytes are held to the budgets in wireBudgets.ts. It prints one
 * table of measured bytes per scenario so a human reads the trend; it
 * fails when a remote payload grows past its budget or a body that should
 * have left the wire did not.
 *
 * What the fixtures measure: the encoded JSON of the frames the socket
 * sends, before permessage-deflate (the deflate columns are a one-shot
 * deflateRaw of the same bytes, close to what the socket achieves per
 * frame; context takeover across frames does better). Not measured:
 * server RSS, the cost of building a page, or the renderer's fold.
 */

// ── a seeded workload ────────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  'the renderer folds rows into blocks while the server keeps the log and ships what the client asked for budget bytes seq tail page cursor frame deflate body omit fetch expand store diff output shell'.split(
    ' '
  )

function words(r: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)])
  return out.join(' ')
}

/** About `bytes` of text in lines of 40 to 100 characters. */
function body(r: () => number, bytes: number): string {
  const lines: string[] = []
  let size = 0
  while (size < bytes) {
    const line = words(r, 6 + Math.floor(r() * 10))
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

/** Log-uniform between lo and hi bytes. */
function logUniform(r: () => number, lo: number, hi: number): number {
  return Math.round(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))))
}

/** The size of a tool output: 60% small, 25% medium, 15% large (2 KiB to
 *  200 KiB), the shape the prod snapshot showed on 2026-10-19. */
function outputBytes(r: () => number): number {
  const p = r()
  if (p < 0.6) return Math.floor(r() * 400)
  if (p < 0.85) return 400 + Math.floor(r() * 1600)
  return logUniform(r, BODY_OMIT_BYTES, 200 * KIB)
}

function diffLines(r: () => number, n: number): NonNullable<ToolPreview['lines']> {
  return Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    kind: r() < 0.5 ? ('add' as const) : r() < 0.3 ? ('del' as const) : ('context' as const),
    text: words(r, 4 + Math.floor(r() * 8))
  }))
}

const meta = (id: string, patch: Partial<SessionMeta>): SessionMeta => ({
  id,
  parentId: null,
  projectId: 'p1',
  workspaceId: 'w1',
  threadType: 'implementation',
  planPath: null,
  provider: 'claude',
  model: 'claude-opus-5-5',
  reasoning: 'high',
  agentType: 'implementer',
  title: id,
  cwd: '/Users/someone/IdeaProjects/project',
  status: 'idle',
  pinned: false,
  archived: false,
  fast: false,
  ultrafast: false,
  context1m: true,
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

/** The busy thread: `count` rows of prompts, thinking, assistant text and
 *  tool calls with outputs, diffs, file reads, writes and one html render
 *  per hundred rows. */
function busyRows(r: () => number, count: number): AgentEvent[] {
  const out: AgentEvent[] = []
  let call = 0
  let turn = 0
  while (out.length < count) {
    out.push({ type: 'user-text', text: words(r, 20 + Math.floor(r() * 40)) })
    const msg = `m${turn++}`
    for (let i = 0; i < 6; i++) out.push({ type: 'thinking', text: words(r, 8), delta: true, msgId: msg, blockIndex: 0 })
    out.push({ type: 'thinking', text: words(r, 48), delta: false, msgId: msg, blockIndex: 0 })
    const tools = 10 + Math.floor(r() * 30)
    for (let t = 0; t < tools && out.length < count - 4; t++) {
      const id = `c${call++}`
      const p = r()
      if (p < 0.45) {
        out.push({ type: 'tool-call', callId: id, name: 'Bash', input: { command: words(r, 6), description: words(r, 4) } })
        out.push({ type: 'tool-result', callId: id, output: body(r, outputBytes(r)), isError: r() < 0.05 })
      } else if (p < 0.65) {
        out.push({ type: 'tool-call', callId: id, name: 'Read', input: { file_path: `/src/${words(r, 1)}.ts` } })
        out.push({ type: 'tool-result', callId: id, output: body(r, logUniform(r, 1 * KIB, 60 * KIB)), isError: false })
      } else if (p < 0.85) {
        const lines = 2 + Math.floor(r() * 120)
        const oldText = body(r, lines * 30)
        const newText = body(r, lines * 34)
        out.push({
          type: 'tool-call',
          callId: id,
          name: 'Edit',
          input: { file_path: `/src/${words(r, 1)}.tsx`, old_string: oldText, new_string: newText },
          preview: { kind: 'write', path: `/src/x.tsx`, additions: lines, deletions: lines, lines: diffLines(r, 2 * lines) }
        })
        out.push({ type: 'tool-result', callId: id, output: 'ok', isError: false })
      } else if (p < 0.97) {
        out.push({
          type: 'tool-call',
          callId: id,
          name: 'Write',
          input: { file_path: `/src/${words(r, 1)}.ts`, content: body(r, logUniform(r, 500, 40 * KIB)) }
        })
        out.push({ type: 'tool-result', callId: id, output: 'written', isError: false })
      } else {
        out.push({
          type: 'tool-call',
          callId: id,
          name: 'mcp__app__html_render',
          input: { title: words(r, 3), height: 600, html: `<!doctype html><style>${body(r, 4 * KIB)}</style><body>${body(r, 16 * KIB)}</body>` }
        })
        out.push({ type: 'tool-result', callId: id, output: JSON.stringify({ htmlRender: { sessionId: 's', pageId: id }, message: 'shown' }), isError: false })
      }
      for (let i = 0; i < 4; i++) out.push({ type: 'assistant-text', text: words(r, 6), delta: true, msgId: `${msg}.${t}`, blockIndex: 1 })
      out.push({ type: 'assistant-text', text: words(r, 24), delta: false, msgId: `${msg}.${t}`, blockIndex: 1 })
    }
    out.push({ type: 'turn-complete', costUsd: 0.5, inputTokens: 100_000, outputTokens: 4_000 })
  }
  return out.slice(0, count)
}

// ── the measurements ─────────────────────────────────────────────────

const BUSY = 'busy'
const ROOT = 'orchestrator'
const BUSY_ROWS = 2000
const FLEET = 200
const SHELL_ROOTS = 2800

type Row = {
  scenario: string
  local: number
  remote: number
  deflated: number
  budget: number | null
  rows?: string
}

const rows: Row[] = []
const deflated = (frame: unknown): number => deflateRawSync(JSON.stringify(frame)).length
const response = (result: unknown): ServerFrame => ({ id: '1', ok: true, result })

/** Every string inside a tool call's input and preview or a tool result's
 *  output is under the line: the invariant the projection promises. */
function largestBody(rowsOnWire: EventRow[]): number {
  let largest = 0
  const walk = (value: unknown, depth = 0): void => {
    if (typeof value === 'string') largest = Math.max(largest, Buffer.byteLength(value))
    else if (value && typeof value === 'object' && depth < 10) {
      if (isOmittedBody(value)) return
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1)
    }
  }
  for (const row of rowsOnWire) {
    const e = row.event
    if (e.type === 'tool-result') walk(e.output)
    else if (e.type === 'tool-call') {
      walk(e.input)
      walk(e.preview)
    } else if (e.type === 'approval-request') walk(e.input)
  }
  return largest
}

let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry

beforeAll(() => {
  const r = rng(20261019)
  db = openDb(':memory:')
  store = new Store(db)

  store.insertSession(meta(BUSY, { status: 'running', updatedAt: 5_000, busySince: 4_000 }))
  for (const e of busyRows(r, BUSY_ROWS)) store.appendEvent(BUSY, e)

  store.insertSession(meta(ROOT, { threadType: 'orchestration', agentType: 'orchestrator', status: 'running', updatedAt: 4_900 }))
  for (let i = 0; i < FLEET; i++) {
    const status = i < 40 ? 'running' : i < 60 ? 'waiting' : 'done'
    store.insertSession(
      meta(`agent-${i}`, {
        parentId: ROOT,
        threadType: null,
        agentType: i % 3 === 0 ? 'explorer' : 'implementer',
        title: `Subagent ${i}: ${words(r, 8)}`,
        status,
        updatedAt: 4_000 + i,
        model: i % 2 ? 'gpt-6.1-sol' : 'claude-sonnet-5-5',
        provider: i % 2 ? 'codex' : 'claude'
      })
    )
    for (let k = 0; k < 10; k++) store.appendEvent(`agent-${i}`, { type: 'assistant-text', text: words(r, 30), delta: false })
  }

  // Two roots in a hundred are working (prod runs a handful of threads at
  // once over a shell of thousands); the rest sit idle, done or failed.
  const statusOf = (i: number): SessionMeta['status'] =>
    i % 100 === 0 ? 'running' : i % 100 === 50 ? 'waiting' : i % 7 === 3 ? 'error' : i % 3 === 0 ? 'done' : 'idle'
  for (let i = 0; i < SHELL_ROOTS; i++) {
    store.insertSession(
      meta(`thread-${i}`, {
        projectId: `p${i % 12}`,
        workspaceId: `w${i % 4}`,
        title: words(r, 4 + Math.floor(r() * 8)),
        cwd: `/Users/someone/IdeaProjects/project-${i % 12}`,
        status: statusOf(i),
        archived: i % 2 === 1,
        pinned: i % 50 === 0,
        updatedAt: 1_000 + i,
        createdAt: 500 + i,
        threadType: (['implementation', 'planning', 'chat', 'research'] as const)[i % 4],
        threadRules: i % 10 === 0 ? { instructions: words(r, 80) } : null
      })
    )
  }
  store.flushEvents()
  registry = new SessionRegistry(store)
})

afterAll(() => {
  db.close()
  const width = Math.max(...rows.map((row) => row.scenario.length))
  const kb = (n: number): string => `${(n / KIB).toFixed(1)} KiB`.padStart(11)
  const lines = [
    '',
    'wire bytes per scenario (encoded JSON; deflated = one-shot deflateRaw of the remote frame)',
    `${'scenario'.padEnd(width)}  ${'local'.padStart(11)}  ${'remote'.padStart(11)}  ${'deflated'.padStart(11)}  ${'budget'.padStart(11)}  rows`,
    ...rows.map(
      (row) =>
        `${row.scenario.padEnd(width)}  ${kb(row.local)}  ${kb(row.remote)}  ${kb(row.deflated)}  ${row.budget === null ? '          -' : kb(row.budget)}  ${row.rows ?? ''}`
    ),
    ''
  ]
  console.log(lines.join('\n'))
})

function record(row: Row): void {
  rows.push(row)
}

describe('wire budgets (remote profile)', () => {
  it('cold open of a busy thread stays under TAIL_BYTES with every large body off the wire', () => {
    const local = store.events(BUSY, { afterSeq: 0, tail: TAIL_ROWS })
    const remote = eventsPage(registry, { sessionId: BUSY, afterSeq: 0, tail: TAIL_ROWS })
    const frame = response(remote)
    const bytes = encodedBytes(frame)
    record({
      scenario: 'cold open (tail)',
      local: encodedBytes(response(local)),
      remote: bytes,
      deflated: deflated(frame),
      budget: TAIL_BYTES,
      rows: `${remote.rows.length}/${local.length} rows, seq ${remote.rows[0]?.seq}..${remote.rows[remote.rows.length - 1]?.seq}`
    })
    expect(remote.rows.length).toBeGreaterThan(0)
    expect(remote.rows[remote.rows.length - 1].seq).toBe(local[local.length - 1].seq)
    expect(bytes).toBeLessThanOrEqual(TAIL_BYTES + 4 * KIB)
    expect(largestBody(remote.rows)).toBeLessThan(BODY_OMIT_BYTES)
    // the same rows locally carry bodies past the line: the projection is doing the work
    expect(largestBody(local)).toBeGreaterThan(BODY_OMIT_BYTES)
  })

  it('an older history page stays under HISTORY_PAGE_BYTES', () => {
    const first = eventsPage(registry, { sessionId: BUSY, afterSeq: 0, tail: TAIL_ROWS })
    const before = first.rows[0].seq
    const localPage = store.events(BUSY, { afterSeq: 0, beforeSeq: before, tail: 300 })
    const page = eventsPage(registry, { sessionId: BUSY, afterSeq: 0, beforeSeq: before, tail: 300 })
    const frame = response(page)
    record({
      scenario: 'history page (beforeSeq)',
      local: encodedBytes(response(localPage)),
      remote: encodedBytes(frame),
      deflated: deflated(frame),
      budget: HISTORY_PAGE_BYTES,
      rows: `${page.rows.length} rows, moreBefore=${page.moreBefore}`
    })
    expect(page.rows[page.rows.length - 1].seq).toBe(before - 1)
    expect(encodedBytes(frame)).toBeLessThanOrEqual(HISTORY_PAGE_BYTES + 4 * KIB)
    expect(largestBody(page.rows)).toBeLessThan(BODY_OMIT_BYTES)
  })

  it('a resume of a small gap replays under RESUME_BYTES; a large gap resets to a bounded tail', () => {
    const gap = 100
    const localSmall = store.eventsAfter(BUSY, BUSY_ROWS - gap)
    const small = eventsPage(registry, { sessionId: BUSY, afterSeq: BUSY_ROWS - gap })
    const smallFrame = response(small)
    record({
      scenario: `resume (gap ${gap})`,
      local: encodedBytes(response(localSmall)),
      remote: encodedBytes(smallFrame),
      deflated: deflated(smallFrame),
      budget: RESUME_BYTES,
      rows: `${small.rows.length} rows, reset=${small.reset}`
    })
    expect(small.reset).toBe(false)
    expect(small.rows.length).toBe(gap)
    expect(small.rows.length).toBeLessThanOrEqual(RESUME_ROWS)
    expect(encodedBytes(smallFrame)).toBeLessThanOrEqual(RESUME_BYTES + 4 * KIB)

    const wide = 1500
    const localWide = store.eventsAfter(BUSY, BUSY_ROWS - wide)
    const large = eventsPage(registry, { sessionId: BUSY, afterSeq: BUSY_ROWS - wide })
    const largeFrame = response(large)
    record({
      scenario: `resume (gap ${wide}, snapshot)`,
      local: encodedBytes(response(localWide)),
      remote: encodedBytes(largeFrame),
      deflated: deflated(largeFrame),
      budget: TAIL_BYTES,
      rows: `${large.rows.length} rows, reset=${large.reset}`
    })
    expect(large.reset).toBe(true)
    expect(large.moreBefore).toBe(true)
    expect(encodedBytes(largeFrame)).toBeLessThanOrEqual(TAIL_BYTES + 4 * KIB)
  })

  it('the shell first page stays under SHELL_PAGE_BYTES and leads with the working rows', () => {
    const all = registry.list({ archived: false })
    const page = sessionPage(all, null)
    const frame = response(page)
    let pages = 1
    let walked = page.sessions.length
    for (let cursor = page.cursor; cursor; ) {
      const next = sessionPage(all, cursor)
      pages++
      walked += next.sessions.length
      cursor = next.cursor
    }
    record({
      scenario: 'shell first page (session.list)',
      local: encodedBytes(response(all)),
      remote: encodedBytes(frame),
      deflated: deflated(frame),
      budget: SHELL_PAGE_BYTES,
      rows: `${page.sessions.length}/${all.length} metas, ${pages} pages to walk all`
    })
    expect(encodedBytes(frame)).toBeLessThanOrEqual(SHELL_PAGE_BYTES + 4 * KIB)
    expect(walked).toBe(all.length)
    const working = new Set(['starting', 'running', 'waiting'])
    const firstSettled = page.sessions.findIndex((s) => !working.has(s.status))
    const lastWorking = page.sessions.map((s) => working.has(s.status)).lastIndexOf(true)
    expect(firstSettled === -1 || lastWorking < firstSettled).toBe(true)
    // every working subagent of the fleet is on the first page
    const fleetWorking = all.filter((s) => s.parentId === ROOT && working.has(s.status)).length
    expect(page.sessions.filter((s) => s.parentId === ROOT && working.has(s.status)).length).toBe(fleetWorking)
  })

  it('the archived list pages the same way', () => {
    const all = registry.list({ archived: true })
    const page = sessionPage(all, null)
    const frame = response(page)
    record({
      scenario: 'archived first page',
      local: encodedBytes(response(all)),
      remote: encodedBytes(frame),
      deflated: deflated(frame),
      budget: SHELL_PAGE_BYTES,
      rows: `${page.sessions.length}/${all.length} metas`
    })
    expect(encodedBytes(frame)).toBeLessThanOrEqual(SHELL_PAGE_BYTES + 4 * KIB)
  })

  it('a fleet burst of 100 ms leaves as one frame per kind, smaller than the singular frames', () => {
    const pushes: ServerPush[] = []
    const working = registry.list({ archived: false }).filter((s) => s.parentId === ROOT && s.status !== 'done')
    for (const s of working) {
      for (let k = 0; k < 5; k++) {
        pushes.push({
          push: 'event',
          row: { sessionId: s.id, seq: 11 + k, ts: 1, event: { type: 'assistant-text', text: words(rng(k), 8), delta: true } }
        })
      }
      pushes.push({ push: 'session', session: { ...s, updatedAt: s.updatedAt + 1 } })
      pushes.push({ push: 'session', session: { ...s, updatedAt: s.updatedAt + 2 } })
    }
    const root = registry.list({ archived: false }).find((s) => s.id === ROOT)!
    for (let k = 0; k < 20; k++) pushes.push({ push: 'session', session: { ...root, updatedAt: root.updatedAt + k } })
    const localBytes = pushes.reduce((n, p) => n + encodedBytes(p), 0)
    const out: ServerPush[] = []
    const c = new PushCoalescer((f) => out.push(f), 100)
    for (const p of pushes) c.push(p)
    c.flush()
    const remoteBytes = out.reduce((n, p) => n + encodedBytes(p), 0)
    record({
      scenario: `fleet burst (${working.length} agents, 100 ms)`,
      local: localBytes,
      remote: remoteBytes,
      deflated: out.reduce((n, p) => n + deflated(p), 0),
      budget: null,
      rows: `${pushes.length} pushes → ${out.length} frames`
    })
    expect(out.filter((f) => f.push === 'sessions')).toHaveLength(1)
    expect(out.filter((f) => f.push === 'events')).toHaveLength(working.length)
    expect(out.length).toBeLessThan(pushes.length / 3)
    expect(remoteBytes).toBeLessThan(localBytes)
  })

  it('a tool output stream of big rows ships only summaries', () => {
    const rowsOnWire: EventRow[] = []
    let localBytes = 0
    for (let seq = 1; seq <= 50; seq++) {
      const row: EventRow = {
        sessionId: BUSY,
        seq,
        ts: seq,
        event: { type: 'tool-result', callId: `x${seq}`, output: body(rng(seq), 50 * KIB), isError: false }
      }
      localBytes += encodedBytes({ push: 'event', row })
      rowsOnWire.push(projectRow(row))
    }
    const frame: ServerPush = { push: 'events', sessionId: BUSY, rows: rowsOnWire }
    record({
      scenario: 'push: 50 × 50 KiB tool outputs',
      local: localBytes,
      remote: encodedBytes(frame),
      deflated: deflated(frame),
      budget: null,
      rows: '50 rows'
    })
    expect(largestBody(rowsOnWire)).toBeLessThan(BODY_OMIT_BYTES)
    expect(encodedBytes(frame)).toBeLessThan(50 * KIB)
  })

  it('deflate helps on our JSON', () => {
    const page: EventsPage = eventsPage(registry, { sessionId: BUSY, afterSeq: 0, tail: TAIL_ROWS })
    const frame = response(page)
    const raw = encodedBytes(frame)
    const packed = deflated(frame)
    expect(packed / raw).toBeLessThan(0.5)
  })
})
