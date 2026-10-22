import { Buffer } from 'node:buffer'
import type { IncomingHttpHeaders } from 'node:http'
import type { AgentEvent, EventRow, SessionMeta, ToolPreview } from '@shared/events'
import type { ServerFrame, ServerPush } from '@shared/contract'
import { isOmittedBody, type EventsPage, type OmittedBody, type SessionPage, type WireProfile } from '@shared/wire'
import {
  BODY_HEAD_CHARS,
  BODY_OMIT_BYTES,
  DEFLATE_THRESHOLD,
  HISTORY_PAGE_BYTES,
  HISTORY_PAGE_ROWS,
  PUSH_COALESCE_MS,
  PUSH_EVENTS_COALESCE_MS,
  RESUME_BYTES,
  RESUME_ROWS,
  SHELL_PAGE_BYTES,
  SHELL_PAGE_ROWS,
  STREAMING_BODY_OMIT_BYTES,
  TAIL_BYTES,
  TAIL_ROWS
} from '@shared/wireBudgets'

/**
 * The remote wire profile, server side: which profile a connection asked
 * for, the projection that keeps large bodies off the wire, the bounded
 * pages of the log and the session list, and the per-connection coalescer
 * that turns a burst of pushes into one frame per kind. Every function is
 * pure over its inputs so wire.perf.test.ts can run the real path over a
 * synthetic workload; index.ts calls the same functions per connection.
 */

/** Which wire profile a connection gets: the one seam between this
 *  module and the auth work. A socket that authenticated as a remote
 *  principal (shared/capabilities.ts) is remote; the local renderer's
 *  socket is local unless its URL asks for `?profile=remote` (the test
 *  path, and what a client on the loopback port uses to try the shapes). */
export function profileFor(connection: {
  principal?: { kind: string } | null
  url?: string | null
  headers?: IncomingHttpHeaders
}): WireProfile {
  if (connection.principal && connection.principal.kind !== 'local') return 'remote'
  const url = connection.url ?? ''
  const q = url.indexOf('?')
  if (q < 0) return 'local'
  return new URLSearchParams(url.slice(q + 1)).get('profile') === 'remote' ? 'remote' : 'local'
}

/** permessage-deflate as a remote WebSocketServer should enable it: frames
 *  under DEFLATE_THRESHOLD go as they are, a few deflates run at once. */
export function remoteDeflateOptions(): { threshold: number; concurrencyLimit: number } {
  return { threshold: DEFLATE_THRESHOLD, concurrencyLimit: 4 }
}

/** The encoded size of a frame or a row, as the socket sends it. */
export function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

// ── bodies ───────────────────────────────────────────────────────────

function countLines(text: string): number {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return n
}

function omittedString(text: string): OmittedBody {
  const nl = text.indexOf('\n')
  const first = nl < 0 ? text : text.slice(0, nl)
  return { omitted: true, bytes: Buffer.byteLength(text), lines: countLines(text), head: first.slice(0, BODY_HEAD_CHARS) }
}

/** A string at or past the line: the length check first, since UTF-8 bytes never undercount code units. */
function isLarge(text: string, limit = BODY_OMIT_BYTES): boolean {
  return text.length >= limit && Buffer.byteLength(text) >= limit
}

const WALK_DEPTH = 8

/** `value` with every large string replaced by its OmittedBody, the same
 *  object when nothing was large. Walks arrays and plain objects (a tool
 *  input is one, a normalized patch is an array of them). */
function omitStrings(value: unknown, limit = BODY_OMIT_BYTES, depth = 0): unknown {
  if (typeof value === 'string') return isLarge(value, limit) ? omittedString(value) : value
  if (depth >= WALK_DEPTH || typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    let out: unknown[] | null = null
    for (let i = 0; i < value.length; i++) {
      const next = omitStrings(value[i], limit, depth + 1)
      if (next !== value[i]) {
        out ??= value.slice()
        out[i] = next
      }
    }
    return out ?? value
  }
  let out: Record<string, unknown> | null = null
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const next = omitStrings(record[key], limit, depth + 1)
    if (next !== record[key]) {
      out ??= { ...record }
      out[key] = next
    }
  }
  return out ?? value
}

function omitPreview(preview: ToolPreview, limit = BODY_OMIT_BYTES): ToolPreview {
  let out: ToolPreview | null = null
  if (preview.lines && preview.lines.length > 0) {
    const bytes = encodedBytes(preview.lines)
    if (bytes >= limit) {
      out = { ...preview }
      ;(out as { lines: unknown }).lines = {
        omitted: true,
        bytes,
        lines: preview.lines.length,
        head: preview.lines[0].text.slice(0, BODY_HEAD_CHARS)
      } satisfies OmittedBody
    }
  }
  if (preview.output && isLarge(preview.output, limit)) {
    out ??= { ...preview }
    ;(out as { output: unknown }).output = omittedString(preview.output)
  }
  return out ?? preview
}

function linesOf(value: unknown): number | null {
  if (typeof value === 'string') return value.length === 0 ? 0 : countLines(value)
  if (isOmittedBody(value)) return value.lines
  return null
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** The counts of an edit whose text left the wire, for a call that carries
 *  no preview of its own: the renderer counts lines from the strings, and
 *  those are what went. Undefined when nothing of the edit was omitted. */
function editSummary(name: string, input: unknown): ToolPreview | undefined {
  const rec = asRecord(input)
  if (!rec) return undefined
  let additions = 0
  let deletions = 0
  switch (name) {
    case 'Edit':
      if (!isOmittedBody(rec.old_string) && !isOmittedBody(rec.new_string)) return undefined
      additions = linesOf(rec.new_string) ?? 0
      deletions = linesOf(rec.old_string) ?? 0
      break
    case 'MultiEdit': {
      let any = false
      for (const edit of Array.isArray(rec.edits) ? rec.edits : []) {
        const r = asRecord(edit)
        if (!r) continue
        if (isOmittedBody(r.old_string) || isOmittedBody(r.new_string)) any = true
        additions += linesOf(r.new_string) ?? 0
        deletions += linesOf(r.old_string) ?? 0
      }
      if (!any) return undefined
      break
    }
    case 'Write':
      if (!isOmittedBody(rec.content)) return undefined
      additions = linesOf(rec.content) ?? 0
      break
    case 'NotebookEdit':
      if (!isOmittedBody(rec.new_source)) return undefined
      additions = linesOf(rec.new_source) ?? 0
      break
    default:
      return undefined
  }
  const path = typeof rec.file_path === 'string' ? rec.file_path : typeof rec.path === 'string' ? rec.path : undefined
  return {
    kind: 'write',
    ...(path ? { path, fileName: path.slice(path.lastIndexOf('/') + 1) } : {}),
    additions,
    deletions
  }
}

/** The event with its large bodies replaced by OmittedBody values; the
 *  same object when it carries none. Conversation text (user, assistant,
 *  thinking, plan) is never a body: it stays whole whatever its size. */
export function projectEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'tool-result': {
      if (!isLarge(event.output)) return event
      return { ...event, output: omittedString(event.output) as unknown as string }
    }
    case 'tool-call': {
      // A partial is the card growing as the model writes: it keeps a far
      // higher line so the card grows on remote too (STREAMING_BODY_OMIT_BYTES).
      const limit = event.partial ? STREAMING_BODY_OMIT_BYTES : BODY_OMIT_BYTES
      const input = omitStrings(event.input, limit)
      const preview = event.preview ? omitPreview(event.preview, limit) : editSummary(event.name, input)
      if (input === event.input && preview === event.preview) return event
      return { ...event, input, ...(preview ? { preview } : {}) }
    }
    case 'approval-request': {
      const input = omitStrings(event.input)
      return input === event.input ? event : { ...event, input }
    }
    default:
      return event
  }
}

/** Rows already projected, so every remote socket shares one projection
 *  (and so one serialization, frameJson) of the same row. */
const projectedRows = new WeakMap<EventRow, EventRow>()

/** The row as a remote connection sees it: the same object when nothing is large. */
export function projectRow(row: EventRow): EventRow {
  const known = projectedRows.get(row)
  if (known) return known
  const event = projectEvent(row.event)
  const out = event === row.event ? row : { ...row, event }
  projectedRows.set(row, out)
  return out
}

type LiveEdit = Extract<ServerPush, { push: 'live-edit' }>

/** A live-edit push for a remote connection: a unified diff past the
 *  streaming line (STREAMING_BODY_OMIT_BYTES) degrades to `diff: null` (the shape a binary or burst edit already
 *  takes), the counts and bytes stay. */
export function projectLiveEdit(push: LiveEdit): LiveEdit {
  if (!push.edit.diff || !isLarge(push.edit.diff, STREAMING_BODY_OMIT_BYTES)) return push
  return { ...push, edit: { ...push.edit, diff: null } }
}

// ── bounded pages of the log ─────────────────────────────────────────

/** `rows` cut to the ones that fit `maxBytes` encoded, kept from the
 *  newest end (a tail or history page) or the oldest (a forward walk).
 *  The first kept row always fits by definition: one row is the floor. */
export function boundRows(
  rows: EventRow[],
  maxBytes: number,
  keep: 'newest' | 'oldest'
): { rows: EventRow[]; bytes: number; cut: boolean } {
  let bytes = 0
  let count = 0
  const step = keep === 'newest' ? -1 : 1
  for (let i = keep === 'newest' ? rows.length - 1 : 0; i >= 0 && i < rows.length; i += step) {
    const size = encodedBytes(rows[i]) + 1
    if (count > 0 && bytes + size > maxBytes) break
    bytes += size
    count++
  }
  const kept = keep === 'newest' ? rows.slice(rows.length - count) : rows.slice(0, count)
  return { rows: kept, bytes, cut: count < rows.length }
}

/** What the page builder reads: the registry's two log reads. */
export interface EventSource {
  events(sessionId: string, opts: { afterSeq?: number; beforeSeq?: number; tail?: number; limit?: number }): EventRow[]
  eventsRange(sessionId: string, afterSeq: number, limit: number): EventRow[]
}

export interface EventsParams {
  sessionId: string
  afterSeq?: number
  beforeSeq?: number
  tail?: number
  limit?: number
}

/** One bounded page of a session's log for a remote connection, from the
 *  same request shape the local profile answers with the raw rows:
 *   - `tail` (cold open, or an older page with `beforeSeq`): the newest
 *     rows of the range, cut at TAIL_BYTES or HISTORY_PAGE_BYTES;
 *   - `afterSeq` alone (resume): the gap, or a fresh tail with `reset`
 *     when the gap passes RESUME_ROWS or RESUME_BYTES;
 *   - otherwise (a forward walk): from `afterSeq` up, cut at the page budget. */
export function eventsPage(source: EventSource, params: EventsParams): EventsPage {
  const { sessionId } = params
  const afterSeq = params.afterSeq ?? 0
  if (params.tail && params.tail > 0) {
    const older = params.beforeSeq !== undefined
    const raw = source.events(sessionId, {
      afterSeq,
      beforeSeq: params.beforeSeq,
      tail: Math.min(params.tail, older ? HISTORY_PAGE_ROWS : TAIL_ROWS)
    })
    const { rows } = boundRows(raw.map(projectRow), older ? HISTORY_PAGE_BYTES : TAIL_BYTES, 'newest')
    return { rows, moreBefore: rows.length > 0 && rows[0].seq > afterSeq + 1, moreAfter: false, reset: false }
  }
  if (afterSeq > 0 && params.beforeSeq === undefined && !params.limit) {
    const raw = source.eventsRange(sessionId, afterSeq, RESUME_ROWS + 1)
    if (raw.length <= RESUME_ROWS) {
      const { rows, cut } = boundRows(raw.map(projectRow), RESUME_BYTES, 'oldest')
      if (!cut) return { rows, moreBefore: false, moreAfter: false, reset: false }
    }
    const { rows } = boundRows(source.events(sessionId, { tail: TAIL_ROWS }).map(projectRow), TAIL_BYTES, 'newest')
    return { rows, moreBefore: rows.length > 0 && rows[0].seq > 1, moreAfter: false, reset: true }
  }
  const limit = Math.min(params.limit ?? HISTORY_PAGE_ROWS, HISTORY_PAGE_ROWS)
  const raw = source.events(sessionId, { afterSeq, beforeSeq: params.beforeSeq, limit: limit + 1 })
  const { rows, cut } = boundRows(raw.slice(0, limit).map(projectRow), HISTORY_PAGE_BYTES, 'oldest')
  return { rows, moreBefore: false, moreAfter: cut || raw.length > limit, reset: false }
}

// ── the session list ─────────────────────────────────────────────────

const WORKING = new Set<SessionMeta['status']>(['starting', 'running', 'waiting'])

/** Where a meta sorts in a remote shell: working roots, then working
 *  subagents (their parents' boards show them live), then settled roots,
 *  then settled subagents; newest first inside a bucket. A settled
 *  subagent is the bulk of a big workspace (6,198 under 13 idle roots on
 *  2026-10-17) and nothing paints it until its parent's board opens. */
function bucketOf(meta: SessionMeta): number {
  const working = WORKING.has(meta.status)
  if (!meta.parentId) return working ? 0 : 2
  return working ? 1 : 3
}

type ListKey = { bucket: number; updatedAt: number; id: string }

function compareKeys(a: ListKey, b: ListKey): number {
  return a.bucket - b.bucket || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function parseCursor(cursor: string): ListKey | null {
  const m = /^(\d+):(\d+):(.+)$/.exec(cursor)
  return m ? { bucket: Number(m[1]), updatedAt: Number(m[2]), id: m[3] } : null
}

/** One page of `sessions` for a remote connection: working rows first,
 *  cut at SHELL_PAGE_BYTES or SHELL_PAGE_ROWS, with a cursor into the
 *  stable ordering for the next page. A meta that moves between pages
 *  shows up on both or neither; the client merges by id and the pushes
 *  keep it current. */
export function sessionPage(
  sessions: SessionMeta[],
  cursor: string | null | undefined,
  limits: { maxBytes?: number; maxRows?: number } = {}
): SessionPage {
  const maxBytes = limits.maxBytes ?? SHELL_PAGE_BYTES
  const maxRows = limits.maxRows ?? SHELL_PAGE_ROWS
  const ordered = sessions
    .map((meta) => ({ meta, key: { bucket: bucketOf(meta), updatedAt: meta.updatedAt, id: meta.id } }))
    .sort((a, b) => compareKeys(a.key, b.key))
  let start = 0
  if (cursor) {
    const after = parseCursor(cursor)
    if (!after) return { sessions: [], cursor: null }
    start = ordered.findIndex((entry) => compareKeys(entry.key, after) > 0)
    if (start < 0) return { sessions: [], cursor: null }
  }
  const page: SessionMeta[] = []
  let bytes = 0
  let last: ListKey | null = null
  let i = start
  for (; i < ordered.length; i++) {
    const size = encodedBytes(ordered[i].meta) + 1
    if (page.length > 0 && (page.length >= maxRows || bytes + size > maxBytes)) break
    page.push(ordered[i].meta)
    bytes += size
    last = ordered[i].key
  }
  const next = i < ordered.length && last ? `${last.bucket}:${last.updatedAt}:${last.id}` : null
  return { sessions: page, cursor: next }
}

// ── one serialization per piece ──────────────────────────────────────

/** The JSON of a meta or a row, made once: the registry hands the same
 *  decorated meta to every socket's listener and the same row to every
 *  subscriber, so the second socket reuses the first one's string. Metas and
 *  rows are never changed once pushed (a change is a new object). */
const pieceJson = new WeakMap<object, string>()
function jsonOf(piece: object): string {
  let json = pieceJson.get(piece)
  if (json === undefined) {
    json = JSON.stringify(piece)
    pieceJson.set(piece, json)
  }
  return json
}

/** A frame as the socket sends it. The pushes that carry metas and rows are
 *  assembled from each piece's shared JSON (the same bytes JSON.stringify
 *  would give); everything else is stringified as it is. */
export function frameJson(frame: ServerFrame): string {
  if (!('push' in frame)) return JSON.stringify(frame)
  switch (frame.push) {
    case 'session':
      return `{"push":"session","session":${jsonOf(frame.session)}}`
    case 'sessions':
      return `{"push":"sessions","sessions":[${frame.sessions.map(jsonOf).join(',')}]}`
    case 'event':
      return `{"push":"event","row":${jsonOf(frame.row)}}`
    case 'events':
      return `{"push":"events","sessionId":${JSON.stringify(frame.sessionId)},"rows":[${frame.rows.map(jsonOf).join(',')}]}`
    default:
      return JSON.stringify(frame)
  }
}

// ── push coalescing ──────────────────────────────────────────────────

export interface CoalescerOptions {
  /** Project large bodies off the wire (projectRow, projectLiveEdit): the
   *  remote profile. A local socket sends rows as they are. Default true. */
  project?: boolean
  /** The seam for a focused thread: a session this answers true for sends
   *  its stored rows at once, after any of its rows still waiting, instead
   *  of on the events window. Default: none. */
  immediate?: (sessionId: string) => boolean
}

type BuildPush = Extract<ServerPush, { push: 'build' }>

/** The coalescer's lanes: stored transcript rows; metas and build lines;
 *  and previews (partial tool calls and live edits), the growing
 *  snapshots that each supersede the last. */
type Lane = 'events' | 'rest' | 'previews'

/** True for a partial tool call: a broadcast-only row (seq -1, never in
 *  the log) carrying the whole input so far, which the next row of the
 *  same call replaces in the fold. */
function isPartialCall(row: EventRow): row is EventRow & { event: Extract<AgentEvent, { type: 'tool-call' }> } {
  return row.event.type === 'tool-call' && row.event.partial === true
}

/** Per connection (remote and local alike; index.ts), three lanes:
 *  - events: stored rows (text deltas, tool calls, results, status), a
 *    PUSH_EVENTS_COALESCE_MS window with a leading edge: the first row of
 *    a quiet lane goes out at once, the rest as one frame per session when
 *    the window closes, and a window that closes on waiting rows opens the
 *    next, so a stream leaves as one frame per window.
 *  - rest: metas (the newest per session) and build lines (joined per
 *    run), a PUSH_COALESCE_MS window with the same leading edge.
 *  - previews: partial tool calls (the newest per call) and live edits,
 *    a PUSH_COALESCE_MS window with no leading edge: the first preview
 *    opens the window and everything in it leaves when it closes. Each
 *    preview can carry up to STREAMING_BODY_OMIT_BYTES and is stale the
 *    moment the next one lands, so they leave at most ten times a second
 *    and never compete with the text for the link.
 *  A later row of a call drops that call's waiting partial, whichever
 *  lane it rides, so a stale preview never lands after the final call.
 *  Any other push flushes what waits first and goes out at once, so the
 *  order a client sees is the order the server produced. */
export class PushCoalescer {
  private events = new Map<string, EventRow[]>()
  /** `sessionId\0callId` → the newest waiting partial of that call */
  private partials = new Map<string, EventRow>()
  private sessions = new Map<string, SessionMeta>()
  private liveEdits: Omit<LiveEdit, 'push'>[] = []
  private builds: Omit<BuildPush, 'push'>[] = []
  private timers: Record<Lane, ReturnType<typeof setTimeout> | null> = { events: null, rest: null, previews: null }
  private disposed = false

  private readonly project: boolean
  private readonly immediate: (sessionId: string) => boolean

  constructor(
    private readonly emit: (frame: ServerPush) => void,
    private readonly delayMs = PUSH_COALESCE_MS,
    private readonly eventsDelayMs = PUSH_EVENTS_COALESCE_MS,
    options: CoalescerOptions = {}
  ) {
    this.project = options.project ?? true
    this.immediate = options.immediate ?? (() => false)
  }

  push(frame: ServerPush): void {
    if (this.disposed) return
    switch (frame.push) {
      case 'event': {
        const row = this.project ? projectRow(frame.row) : frame.row
        if (row.event.type === 'tool-call') this.partials.delete(`${row.sessionId}\0${row.event.callId}`)
        // A result settles the call: a live preview still waiting (a mac_run's output) must not land after it.
        if (row.event.type === 'tool-result') this.partials.delete(`${row.sessionId}\0${row.event.callId}`)
        if (isPartialCall(row)) {
          this.partials.set(`${row.sessionId}\0${row.event.callId}`, row)
          this.arm('previews')
          return
        }
        const rows = this.events.get(row.sessionId)
        if (rows) rows.push(row)
        else this.events.set(row.sessionId, [row])
        if (this.immediate(row.sessionId)) {
          this.flushSession(row.sessionId)
          return
        }
        this.arm('events')
        return
      }
      case 'live-edit': {
        const { push: _push, ...rest } = this.project ? projectLiveEdit(frame) : frame
        this.liveEdits.push(rest)
        this.arm('previews')
        return
      }
      case 'session':
        this.sessions.set(frame.session.id, frame.session)
        break
      case 'build': {
        const { push: _push, ...rest } = frame
        const prev = this.builds[this.builds.length - 1]
        if (prev && prev.projectId === rest.projectId && prev.run.id === rest.run.id) {
          this.builds[this.builds.length - 1] = {
            ...rest,
            ...(prev.lines || rest.lines ? { lines: [...(prev.lines ?? []), ...(rest.lines ?? [])] } : {})
          }
        } else this.builds.push(rest)
        break
      }
      default:
        this.flush()
        this.emit(frame)
        return
    }
    this.arm('rest')
  }

  /** Everything waiting goes out now, metas first (a status row's meta
   *  lands before the row). Open windows stay open: a push inside one
   *  still waits for its end, so the frame rate holds. */
  flush(): void {
    this.flushSessions()
    this.flushEvents()
    this.flushPartials()
    this.flushLiveEdits()
    this.flushBuilds()
  }

  /** The socket closed: nothing waiting can be sent. */
  dispose(): void {
    this.disposed = true
    for (const lane of ['events', 'rest', 'previews'] as const) {
      const timer = this.timers[lane]
      if (timer) clearTimeout(timer)
      this.timers[lane] = null
    }
    this.events.clear()
    this.partials.clear()
    this.sessions.clear()
    this.liveEdits = []
    this.builds = []
  }

  /** Events and rest have a leading edge: a quiet lane sends now and opens
   *  its window, a window that closes on waiting pushes sends them and
   *  opens the next, one that closes on nothing leaves the lane quiet.
   *  Previews only open the window and send when it closes. */
  private arm(lane: Lane): void {
    if (this.timers[lane]) return
    if (lane !== 'previews') this.flushLane(lane)
    this.openWindow(lane)
  }

  private openWindow(lane: Lane): void {
    this.timers[lane] = setTimeout(
      () => {
        this.timers[lane] = null
        if (this.disposed || !this.waiting(lane)) return
        this.flushLane(lane)
        if (lane !== 'previews') this.openWindow(lane)
      },
      lane === 'events' ? this.eventsDelayMs : this.delayMs
    )
  }

  private waiting(lane: Lane): boolean {
    switch (lane) {
      case 'events':
        return this.events.size > 0
      case 'rest':
        return this.sessions.size > 0 || this.builds.length > 0
      case 'previews':
        return this.partials.size > 0 || this.liveEdits.length > 0
    }
  }

  private flushLane(lane: Lane): void {
    switch (lane) {
      case 'rest':
        this.flushSessions()
        this.flushBuilds()
        return
      case 'previews':
        this.flushPartials()
        this.flushLiveEdits()
        return
      case 'events': {
        // Metas keep their own window; only a status row's waiting meta
        // rides ahead of the rows, so the row never lands before its meta.
        const ahead: SessionMeta[] = []
        for (const [sessionId, rows] of this.events) {
          const meta = this.sessions.get(sessionId)
          if (meta && rows.some((r) => r.event.type === 'status')) {
            this.sessions.delete(sessionId)
            ahead.push(meta)
          }
        }
        if (ahead.length > 0) this.emit({ push: 'sessions', sessions: ahead })
        this.flushEvents()
      }
    }
  }

  /** One session's waiting rows now (the immediate seam), its waiting meta
   *  ahead of them when they carry a status, as the events lane does. */
  private flushSession(sessionId: string): void {
    const rows = this.events.get(sessionId)
    if (!rows) return
    this.events.delete(sessionId)
    const meta = this.sessions.get(sessionId)
    if (meta && rows.some((r) => r.event.type === 'status')) {
      this.sessions.delete(sessionId)
      this.emit({ push: 'sessions', sessions: [meta] })
    }
    this.emit({ push: 'events', sessionId, rows })
  }

  private flushSessions(): void {
    if (this.sessions.size === 0) return
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.emit({ push: 'sessions', sessions })
  }

  private flushEvents(): void {
    if (this.events.size === 0) return
    const events = this.events
    this.events = new Map()
    for (const [sessionId, rows] of events) this.emit({ push: 'events', sessionId, rows })
  }

  /** The waiting partials as one events frame per session. */
  private flushPartials(): void {
    if (this.partials.size === 0) return
    const bySession = new Map<string, EventRow[]>()
    for (const row of this.partials.values()) {
      const rows = bySession.get(row.sessionId)
      if (rows) rows.push(row)
      else bySession.set(row.sessionId, [row])
    }
    this.partials.clear()
    for (const [sessionId, rows] of bySession) this.emit({ push: 'events', sessionId, rows })
  }

  private flushLiveEdits(): void {
    if (this.liveEdits.length === 0) return
    const items = this.liveEdits
    this.liveEdits = []
    this.emit({ push: 'live-edits', items })
  }

  private flushBuilds(): void {
    if (this.builds.length === 0) return
    const items = this.builds
    this.builds = []
    this.emit({ push: 'builds', items })
  }
}
