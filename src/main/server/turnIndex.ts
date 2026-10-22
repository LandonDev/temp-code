import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { AgentEvent } from '@shared/events'
import { yieldUntilIdle } from './stalls'

/**
 * Full-text index over turn text, one per host (db.ts owns the hooks).
 *
 * `session.search` used to walk every row of `events` with json_extract
 * and instr: 432 MB of hot rows on the box, 4 GB cold. Two FTS5 tables
 * now mirror the two event files — `events_fts` in the hot file and
 * `cold.events_fts` in the cold one — holding the text of every
 * user-text / assistant-text row that is not a delta and not inside a
 * tool call (the rows the scan matched). A row's FTS rowid is
 * `(ordinal << 32) | seq`, where `turn_index` gives each session an
 * integer ordinal: a session's rows are one rowid range, so dropping or
 * moving a session is an indexed range delete instead of a scan of the
 * content table, and the search joins back to `events` on the primary
 * key for ts and role.
 *
 * Kept current three ways:
 *  - incrementally: flushEvents() inserts the text of each landed row
 *    whose session is ready (every session created through
 *    insertSession() is, with nothing to backfill);
 *  - by the backfill: after boot, sessions without a ready `turn_index`
 *    row (the whole database on the first boot after the upgrade; a thread
 *    that landed through a move since) are indexed newest first in
 *    bounded transactions with a yield between them, and marked ready
 *    only once every row is in;
 *  - by the moves: a session's rows follow it between the files.
 * A session not yet ready is still found: the search unions a scan of
 * those sessions' rows (a PK lookup per session, never the whole table)
 * while the backfill has work left.
 *
 * Without FTS5 in the SQLite build (`available` false) nothing here runs
 * and the search is the scan it always was.
 */

const ORDINAL_SHIFT = 32n
const SEQ_MASK = 0xffffffff

export type IndexTable = 'events' | 'cold.events'
const ftsOf = (table: IndexTable): string => (table === 'events' ? 'events_fts' : 'cold.events_fts')

/** The indexable text of an event, or null when the row is not a turn
 *  (a delta, a tool call's child, anything else). The same predicate the
 *  scan used, applied in JS at append time. */
export function turnText(event: AgentEvent): string | null {
  if (event.type !== 'user-text' && event.type !== 'assistant-text') return null
  const row = event as { text?: unknown; delta?: unknown; parentCallId?: unknown }
  if (row.delta) return null
  if (row.parentCallId !== undefined && row.parentCallId !== null) return null
  return typeof row.text === 'string' && row.text.length > 0 ? row.text : null
}

/** The SQL predicate equivalent of turnText(), over an `events` alias `e`. */
export const TURN_ROW_SQL = `json_extract(e.payload, '$.type') IN ('user-text', 'assistant-text')
          AND COALESCE(json_extract(e.payload, '$.delta'), 0) = 0
          AND json_extract(e.payload, '$.parentCallId') IS NULL
          AND json_extract(e.payload, '$.text') IS NOT NULL`

/** An FTS5 MATCH expression for what a person typed: every whitespace
 *  token a quoted term (so punctuation and operators are literal), all
 *  required, the last one a prefix so a word being typed matches. Empty
 *  when nothing is left to match. */
export function ftsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ''))
    .filter((token) => token.length > 0)
  return tokens.map((token, index) => `"${token}"${index === tokens.length - 1 ? '*' : ''}`).join(' ')
}

export interface BackfillOptions {
  /** Event rows per transaction. */
  batch?: number
  yieldNow?: () => Promise<void>
  /** Before each transaction; the store lands its pending rows here. */
  flush?: () => void
  onProgress?: (info: { sessionId: string; rows: number }) => void
}

export class TurnIndex {
  /** False when this SQLite has no FTS5: every method is then a no-op and
   *  the search stays the scan. */
  readonly available: boolean
  /** Ready sessions (every row indexed, new rows indexed as they land). */
  private ready = new Map<string, number>()
  private stmts = new Map<string, StatementSync>()
  private running: Promise<void> | null = null
  private again = false

  constructor(private readonly db: DatabaseSync) {
    let available = false
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS turn_index (
        ordinal    INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        ready      INTEGER NOT NULL DEFAULT 0
      );`)
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')`)
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS cold.events_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')`)
      available = true
    } catch (error) {
      console.log(`[search] no FTS5 in this SQLite (${(error as Error).message}); session search scans`)
    }
    this.available = available
    if (available) {
      const rows = db.prepare(`SELECT ordinal, session_id FROM turn_index WHERE ready = 1`).all() as unknown as {
        ordinal: number
        session_id: string
      }[]
      for (const r of rows) this.ready.set(r.session_id, r.ordinal)
    }
  }

  private stmt(sql: string): StatementSync {
    let st = this.stmts.get(sql)
    if (!st) {
      st = this.db.prepare(sql)
      this.stmts.set(sql, st)
    }
    return st
  }

  /** Whether the session's rows are all in the index and new ones follow. */
  isReady(sessionId: string): boolean {
    return this.ready.has(sessionId)
  }

  /** The session's ordinal row, made on first ask; not ready until marked. */
  private allocate(sessionId: string): number {
    const known = this.ready.get(sessionId)
    if (known !== undefined) return known
    this.stmt(`INSERT OR IGNORE INTO turn_index (session_id) VALUES (?)`).run(sessionId)
    const r = this.stmt(`SELECT ordinal FROM turn_index WHERE session_id = ?`).get(sessionId) as { ordinal: number }
    return r.ordinal
  }

  private setReady(sessionId: string, ordinal: number): void {
    this.stmt(`UPDATE turn_index SET ready = 1 WHERE ordinal = ?`).run(ordinal)
    this.ready.set(sessionId, ordinal)
  }

  /** A session created now has nothing to backfill: index it from its first row. */
  markReady(sessionId: string): void {
    if (!this.available) return
    if (this.ready.has(sessionId)) return
    this.setReady(sessionId, this.allocate(sessionId))
  }

  /** Inside the caller's transaction: the text rows that landed this
   *  flush, for the sessions that are ready. The others wait for the
   *  backfill, which reads them from the table. */
  insertLanded(rows: readonly { sessionId: string; seq: number; text: string | null; table: IndexTable }[]): void {
    if (!this.available) return
    for (const row of rows) {
      if (row.text === null) continue
      const ordinal = this.ready.get(row.sessionId)
      if (ordinal === undefined) continue
      this.stmt(`INSERT OR REPLACE INTO ${ftsOf(row.table)} (rowid, text) VALUES (?, ?)`).run(
        rowidOf(ordinal, row.seq),
        row.text
      )
    }
  }

  /** Write the turn rows of a session from one events table into that
   *  file's index: the rows with seq in (afterSeq, hiSeq], or up to
   *  `limit` event rows after afterSeq when hiSeq is omitted. Idempotent. */
  private writeRows(
    ordinal: number,
    sessionId: string,
    table: IndexTable,
    afterSeq: number,
    limit: number,
    hiSeq?: number
  ): { rows: number; lastSeq: number } {
    const base = BigInt(ordinal) << ORDINAL_SHIFT
    let last = hiSeq
    if (last === undefined) {
      const bound = limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''
      const edge = this
        .stmt(`SELECT MAX(seq) AS last FROM (SELECT seq FROM ${table} WHERE session_id = ? AND seq > ? ORDER BY seq ${bound})`)
        .get(sessionId, afterSeq) as { last: number | null }
      if (edge.last === null) return { rows: 0, lastSeq: -1 }
      last = edge.last
    }
    const rows = this
      .stmt(
        `INSERT OR REPLACE INTO ${ftsOf(table)} (rowid, text)
         SELECT ? + e.seq, json_extract(e.payload, '$.text') FROM ${table} e
         WHERE e.session_id = ? AND e.seq > ? AND e.seq <= ? AND ${TURN_ROW_SQL}`
      )
      .run(base, sessionId, afterSeq, last).changes
    return { rows: Number(rows), lastSeq: last }
  }

  /** Rows of a ready session moved between the files (inside the move's
   *  transaction): the index rows with seq in [loSeq, hiSeq] leave `from`
   *  and are read again from `to`'s events table. A session not ready is
   *  left to the backfill, which reads whichever file holds it then. */
  moveRows(sessionId: string, from: IndexTable, to: IndexTable, loSeq: number, hiSeq: number): void {
    if (!this.available) return
    const ordinal = this.ready.get(sessionId)
    if (ordinal === undefined) return
    const lo = Math.max(0, loSeq)
    const hi = Math.min(hiSeq, SEQ_MASK)
    const base = BigInt(ordinal) << ORDINAL_SHIFT
    this.stmt(`DELETE FROM ${ftsOf(from)} WHERE rowid >= ? AND rowid <= ?`).run(base + BigInt(lo), base + BigInt(hi))
    this.writeRows(ordinal, sessionId, to, lo - 1, 0, hi)
  }

  /** Drop a session's rows from the index of one file, or both. */
  private dropRows(ordinal: number, table: IndexTable | 'both'): void {
    const [lo, hi] = rangeOf(ordinal)
    for (const t of table === 'both' ? (['events', 'cold.events'] as const) : [table]) {
      this.stmt(`DELETE FROM ${ftsOf(t)} WHERE rowid >= ? AND rowid <= ?`).run(lo, hi)
    }
  }

  /** Forget a session (deleted, or its rows changed under the store: a
   *  move landed or left, rows imported): its index rows in both files
   *  and its ordinal go; a session still in `sessions` is pending again
   *  and the next backfill reads the table afresh. */
  forget(sessionIds: readonly string[]): void {
    if (!this.available) return
    for (const id of sessionIds) {
      const row = this.stmt(`SELECT ordinal FROM turn_index WHERE session_id = ?`).get(id) as { ordinal: number } | undefined
      if (row) this.dropRows(row.ordinal, 'both')
      this.stmt(`DELETE FROM turn_index WHERE session_id = ?`).run(id)
      this.ready.delete(id)
    }
  }

  /** Sessions with no ready index row, newest first: the backfill's work. */
  pending(): string[] {
    if (!this.available) return []
    return (
      this.stmt(
        `SELECT s.id AS id FROM sessions s LEFT JOIN turn_index ti ON ti.session_id = s.id AND ti.ready = 1
         WHERE ti.session_id IS NULL ORDER BY s.updated_at DESC`
      ).all() as unknown as { id: string }[]
    ).map((r) => r.id)
  }

  /** True while some session is not ready: the search adds a scan of those. */
  hasPending(): boolean {
    if (!this.available) return false
    return !!this.stmt(
      `SELECT 1 AS x FROM sessions s LEFT JOIN turn_index ti ON ti.session_id = s.id AND ti.ready = 1
       WHERE ti.session_id IS NULL LIMIT 1`
    ).get()
  }

  /** Index one session whole, in transactions of `batch` event rows with a
   *  yield between them; ready only once every row is in. `tableOf` says
   *  which file holds the session's rows now: a move between chunks
   *  starts the session over in its new file. */
  async indexSession(sessionId: string, tableOf: () => IndexTable, opts: BackfillOptions = {}): Promise<number> {
    if (!this.available) return 0
    if (this.ready.has(sessionId)) return 0
    const batch = opts.batch ?? 5_000
    const yieldNow = opts.yieldNow ?? (() => yieldUntilIdle())
    const ordinal = this.allocate(sessionId)
    let total = 0
    let after = 0
    let lastTable: IndexTable | null = null
    for (;;) {
      opts.flush?.()
      const table = tableOf()
      if (lastTable !== null && table !== lastTable) {
        this.dropRows(ordinal, 'both')
        total = 0
        after = 0
      }
      lastTable = table
      this.db.exec('BEGIN')
      let step: { rows: number; lastSeq: number }
      try {
        step = this.writeRows(ordinal, sessionId, table, after, batch)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      total += step.rows
      if (step.lastSeq < 0) break
      after = step.lastSeq
      const more = this.stmt(`SELECT 1 AS x FROM ${table} WHERE session_id = ? AND seq > ? LIMIT 1`).get(sessionId, after)
      if (!more) break
      await yieldNow()
    }
    // The session may have been deleted while this ran.
    if (this.stmt(`SELECT 1 AS x FROM sessions WHERE id = ?`).get(sessionId)) this.setReady(sessionId, ordinal)
    else this.forget([sessionId])
    opts.onProgress?.({ sessionId, rows: total })
    return total
  }

  /** Drain the pending sessions in the background; a kick while one runs
   *  asks it to look again when it ends. Resolves when nothing is pending. */
  kick(tableOf: (sessionId: string) => IndexTable, opts: BackfillOptions = {}): Promise<void> {
    if (!this.available) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.drain(tableOf, opts)
      } while (this.again)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async drain(tableOf: (sessionId: string) => IndexTable, opts: BackfillOptions): Promise<void> {
    const yieldNow = opts.yieldNow ?? (() => yieldUntilIdle())
    for (const id of this.pending()) {
      if (this.ready.has(id)) continue
      await this.indexSession(id, () => tableOf(id), opts)
      await yieldNow()
    }
  }

  /** The search over one file's index: hits ranked by bm25 (lower is
   *  better), joined to `events` for ts and role, with FTS5's snippet.
   *  Binds: the MATCH expression, then the workspace id when asked. The
   *  caller unions the two files and orders. */
  matchSql(table: IndexTable, workspace: boolean): string {
    // FTS5's auxiliary functions and MATCH take the table's own name, never
    // an alias; inside this SELECT `events_fts` is the one in `table`'s file.
    return `SELECT ti.session_id AS sessionId, (events_fts.rowid & ${SEQ_MASK}) AS seq, e.ts AS ts,
              json_extract(e.payload, '$.type') AS type,
              snippet(events_fts, 0, '', '', '…', 24) AS snippet,
              bm25(events_fts) AS rank
       FROM ${ftsOf(table)}
       JOIN turn_index ti ON ti.ordinal = (events_fts.rowid >> 32)
       JOIN ${table} e ON e.session_id = ti.session_id AND e.seq = (events_fts.rowid & ${SEQ_MASK})
       JOIN sessions s ON s.id = ti.session_id
       WHERE events_fts MATCH ? ${workspace ? 'AND s.workspace_id = ?' : ''}`
  }
}

function rowidOf(ordinal: number, seq: number): bigint {
  return (BigInt(ordinal) << ORDINAL_SHIFT) | BigInt(seq)
}

function rangeOf(ordinal: number): [bigint, bigint] {
  const lo = BigInt(ordinal) << ORDINAL_SHIFT
  return [lo, lo | BigInt(SEQ_MASK)]
}
