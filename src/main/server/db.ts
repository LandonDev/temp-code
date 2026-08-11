import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentEvent, EventRow, SessionMeta, SessionStatus } from '@shared/events'

/**
 * node:sqlite, zero native deps (no electron-rebuild pain).
 * Two tables: sessions (the tree) and events (append-only log, the
 * source of truth the transcript is rendered from — T3-style).
 */

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      parent_id  TEXT,
      provider   TEXT NOT NULL,
      model      TEXT NOT NULL,
      reasoning  TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      title      TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      status     TEXT NOT NULL,
      archived   INTEGER NOT NULL DEFAULT 0,
      native_id  TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      ts         INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
  `)
  // Migration for databases created before the archived column existed.
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
  } catch {
    // column already exists
  }
  return db
}

interface SessionRowRaw {
  id: string
  parent_id: string | null
  provider: string
  model: string
  reasoning: string
  agent_type: string
  title: string
  cwd: string
  status: string
  archived: number
  native_id: string | null
  created_at: number
  updated_at: number
}

function toMeta(r: SessionRowRaw): SessionMeta {
  return {
    id: r.id,
    parentId: r.parent_id,
    provider: r.provider as SessionMeta['provider'],
    model: r.model,
    reasoning: r.reasoning as SessionMeta['reasoning'],
    agentType: r.agent_type as SessionMeta['agentType'],
    title: r.title,
    cwd: r.cwd,
    status: r.status as SessionStatus,
    archived: !!r.archived,
    nativeId: r.native_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export class Store {
  constructor(private db: DatabaseSync) {}

  insertSession(meta: SessionMeta): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, parent_id, provider, model, reasoning, agent_type, title, cwd, status, archived, native_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        meta.id,
        meta.parentId,
        meta.provider,
        meta.model,
        meta.reasoning,
        meta.agentType,
        meta.title,
        meta.cwd,
        meta.status,
        meta.archived ? 1 : 0,
        meta.nativeId,
        meta.createdAt,
        meta.updatedAt
      )
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionMeta, 'status' | 'title' | 'nativeId' | 'archived'>>
  ): SessionMeta | null {
    const cur = this.getSession(id)
    if (!cur) return null
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, title = ?, native_id = ?, archived = ?, updated_at = ? WHERE id = ?`
      )
      .run(next.status, next.title, next.nativeId, next.archived ? 1 : 0, next.updatedAt, id)
    return next
  }

  /** Delete a session and all of its descendants (log included). */
  deleteSessionTree(id: string): string[] {
    const ids: string[] = []
    const collect = (cur: string): void => {
      ids.push(cur)
      const kids = this.db
        .prepare(`SELECT id FROM sessions WHERE parent_id = ?`)
        .all(cur) as unknown as { id: string }[]
      for (const k of kids) collect(k.id)
    }
    collect(id)
    const del = this.db.prepare(`DELETE FROM sessions WHERE id = ?`)
    const delEvents = this.db.prepare(`DELETE FROM events WHERE session_id = ?`)
    for (const sid of ids) {
      delEvents.run(sid)
      del.run(sid)
    }
    return ids
  }

  getSession(id: string): SessionMeta | null {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRowRaw
      | undefined
    return r ? toMeta(r) : null
  }

  listSessions(): SessionMeta[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY created_at DESC`)
      .all() as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  appendEvent(sessionId: string, event: AgentEvent): EventRow {
    const ts = Date.now()
    const r = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE session_id = ?`)
      .get(sessionId) as { max: number }
    const seq = r.max + 1
    this.db
      .prepare(`INSERT INTO events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)`)
      .run(sessionId, seq, ts, JSON.stringify(event))
    return { sessionId, seq, ts, event }
  }

  eventsAfter(sessionId: string, afterSeq: number): EventRow[] {
    const rows = this.db
      .prepare(`SELECT seq, ts, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`)
      .all(sessionId, afterSeq) as unknown as { seq: number; ts: number; payload: string }[]
    return rows.map((r) => ({
      sessionId,
      seq: r.seq,
      ts: r.ts,
      event: JSON.parse(r.payload) as AgentEvent
    }))
  }
}
