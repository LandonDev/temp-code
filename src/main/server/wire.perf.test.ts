import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
  PUSH_COALESCE_MS,
  RESUME_BYTES,
  RESUME_ROWS,
  SHELL_PAGE_BYTES,
  TAIL_BYTES,
  TAIL_ROWS
} from '@shared/wireBudgets'
import { body } from './wireWorkload'
import type { EventRow, SessionMeta } from '@shared/events'
import type { ServerFrame, ServerPush } from '@shared/contract'
import { busyRows, meta, rng, words } from './wireWorkload'

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

  it('a fleet burst inside one window leaves as each lane’s leading push plus one frame per kind, smaller than the singular frames', () => {
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
    c.dispose()
    const remoteBytes = out.reduce((n, p) => n + encodedBytes(p), 0)
    record({
      scenario: `fleet burst (${working.length} agents, 100 ms)`,
      local: localBytes,
      remote: remoteBytes,
      deflated: out.reduce((n, p) => n + deflated(p), 0),
      budget: null,
      rows: `${pushes.length} pushes → ${out.length} frames`
    })
    // The first row and the first meta of a quiet period leave at once
    // (the leading edge); the rest of the burst waits for its window and
    // leaves as one meta frame and one events frame per agent.
    expect(out.filter((f) => f.push === 'sessions')).toHaveLength(2)
    expect(out.filter((f) => f.push === 'events')).toHaveLength(working.length + 1)
    expect(out.length).toBeLessThan(pushes.length / 3)
    expect(remoteBytes).toBeLessThan(localBytes)
  })

  it('a codex patch streaming to 30 KiB leaves at most ten previews a second', () => {
    // codex's patchUpdated is not throttled: a partial every 10 ms for a
    // second, each the whole patch so far. Previews ride the 100 ms window
    // and only the newest per call leaves, so the link carries ten
    // snapshots, not a hundred.
    vi.useFakeTimers()
    try {
      const patch = body(rng(42), 30 * KIB)
      const pushes: ServerPush[] = []
      for (let k = 1; k <= 100; k++) {
        pushes.push({
          push: 'event',
          row: {
            sessionId: BUSY,
            seq: -1,
            ts: k,
            ephemeral: true,
            event: {
              type: 'tool-call',
              callId: 'patch',
              name: 'apply_patch',
              input: { path: 'src/a.ts', diff: patch.slice(0, Math.round((patch.length * k) / 100)) },
              partial: true
            }
          }
        })
      }
      const out: ServerPush[] = []
      const c = new PushCoalescer((f) => out.push(f))
      for (const p of pushes) {
        c.push(p)
        vi.advanceTimersByTime(10)
      }
      vi.advanceTimersByTime(PUSH_COALESCE_MS)
      c.dispose()
      const localBytes = pushes.reduce((n, p) => n + encodedBytes(p), 0)
      const remoteBytes = out.reduce((n, p) => n + encodedBytes(p), 0)
      record({
        scenario: 'codex patch to 30 KiB (1 s)',
        local: localBytes,
        remote: remoteBytes,
        deflated: out.reduce((n, p) => n + deflated(p), 0),
        budget: null,
        rows: `${pushes.length} partials → ${out.length} frames`
      })
      expect(out.length).toBeLessThanOrEqual(1000 / PUSH_COALESCE_MS + 1)
      expect(remoteBytes).toBeLessThan(localBytes / 8)
      const last = out[out.length - 1] as Extract<ServerPush, { push: 'events' }>
      expect((last.rows[0].event as { input: { diff: string } }).input.diff).toBe(patch)
    } finally {
      vi.useRealTimers()
    }
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
