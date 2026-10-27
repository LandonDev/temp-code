import type { DatabaseSync } from 'node:sqlite'
import type { MirrorCursor, MirrorHost, MirrorSummary, MirrorWrite } from '@shared/launchMirror'

export type { MirrorCursor, MirrorHost, MirrorSummary, MirrorWrite }

/**
 * The launch mirror: what the desktop's rail and Inbox paint from at boot
 * before any socket is up (CLAUDE.md "Launch: the rail paints from the
 * launch mirror"). Per host (this machine's `local` and every saved
 * environment) it keeps the session SUMMARIES the renderer last saw, the
 * workspace and project lists, and the `session.changes` cursor the next
 * resume asks from. The renderer writes it (preload `launch-mirror:write`)
 * after every list and meta change, coalesced; `launch-mirror:read` answers
 * synchronously at boot. Summaries only, never transcript rows: the table
 * is capped per host and archived threads older than thirty days leave the
 * mirror (the host still has them).
 */

export const MIRROR_MAX_SESSIONS = 2_000
export const MIRROR_ARCHIVED_KEEP_MS = 30 * 24 * 60 * 60_000

type HostRow = {
  environment_id: string
  cursor_seq: number | null
  cursor_generation: string | null
  workspaces: string
  projects: string
  written_at: number
}
type SessionRow = { environment_id: string; summary: string }

export class LaunchMirror {
  private writes: Promise<void> = Promise.resolve()
  private readonly epochs = new Map<string, number>()
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS launch_mirror_hosts (
        environment_id TEXT PRIMARY KEY,
        cursor_seq INTEGER,
        cursor_generation TEXT,
        workspaces TEXT NOT NULL DEFAULT '[]',
        projects TEXT NOT NULL DEFAULT '[]',
        written_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS launch_mirror_sessions (
        environment_id TEXT NOT NULL,
        id TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        summary TEXT NOT NULL,
        PRIMARY KEY (environment_id, id)
      );
      CREATE INDEX IF NOT EXISTS launch_mirror_sessions_by_host
        ON launch_mirror_sessions (environment_id, updated_at);
    `)
  }

  /** Every mirrored host with its summaries, newest first. `keep` names the
   *  hosts that still exist (local plus the saved environments); a host no
   *  longer among them is forgotten on the way. */
  read(keep?: Iterable<string>): MirrorHost[] {
    const wanted = keep ? new Set(keep) : null
    const hosts = this.db.prepare(`SELECT * FROM launch_mirror_hosts`).all() as unknown as HostRow[]
    const out: MirrorHost[] = []
    for (const row of hosts) {
      if (wanted && !wanted.has(row.environment_id)) {
        this.forget(row.environment_id)
        continue
      }
      const sessions = (
        this.db
          .prepare(`SELECT environment_id, summary FROM launch_mirror_sessions WHERE environment_id = ? ORDER BY updated_at DESC`)
          .all(row.environment_id) as unknown as SessionRow[]
      ).flatMap((s) => {
        try {
          return [JSON.parse(s.summary) as MirrorSummary]
        } catch {
          return []
        }
      })
      out.push({
        environmentId: row.environment_id,
        cursor: row.cursor_seq !== null && row.cursor_generation ? { seq: row.cursor_seq, generation: row.cursor_generation } : null,
        workspaces: parseList(row.workspaces),
        projects: parseList(row.projects),
        sessions,
        writtenAt: row.written_at
      })
    }
    return out
  }

  /** The hosts mirrored, for the boot answer's keep-set and the tests. */
  hostIds(): string[] {
    const rows = this.db.prepare(`SELECT environment_id FROM launch_mirror_hosts`).all() as unknown as { environment_id: string }[]
    return rows.map((r) => r.environment_id)
  }

  /** Serialize writes; each transaction lands at most 200 summaries. The
   * cursor lands last so an interrupted write replays from the old cursor. */
  write(write: MirrorWrite, now = Date.now()): Promise<void> {
    const epoch = this.epochs.get(write?.environmentId) ?? 0
    const run = this.writes.then(() => this.apply(write, now, epoch))
    this.writes = run.catch(() => {})
    return run
  }

  private async apply(write: MirrorWrite, now: number, epoch: number): Promise<void> {
    if (typeof write?.environmentId !== 'string' || !write.environmentId) return
    const env = write.environmentId
    const forgotten = (): boolean => (this.epochs.get(env) ?? 0) !== epoch
    if (forgotten()) return
    const upserts = Array.isArray(write.upserts) ? write.upserts.filter(validSummary) : []
    const transaction = (work: () => void): void => {
      this.db.exec('BEGIN')
      try {
        work()
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
    transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO launch_mirror_hosts (environment_id, written_at) VALUES (?, ?)`).run(env, now)
      if (write.full) {
        const keep = new Set(upserts.map((s) => s.id))
        const ids = this.db.prepare(`SELECT id FROM launch_mirror_sessions WHERE environment_id = ?`).all(env) as unknown as { id: string }[]
        const del = this.db.prepare(`DELETE FROM launch_mirror_sessions WHERE environment_id = ? AND id = ?`)
        for (const { id } of ids) if (!keep.has(id)) del.run(env, id)
      }
    })
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO launch_mirror_sessions (environment_id, id, archived, updated_at, summary) VALUES (?, ?, ?, ?, ?)`
    )
    for (let start = 0; start < upserts.length; start += 200) {
      if (forgotten()) return
      transaction(() => {
        for (const s of upserts.slice(start, start + 200)) put.run(env, s.id, s.archived ? 1 : 0, s.updatedAt, JSON.stringify(s))
      })
      if (start + 200 < upserts.length) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (forgotten()) return
    transaction(() => {
      if (Array.isArray(write.removed)) {
        const del = this.db.prepare(`DELETE FROM launch_mirror_sessions WHERE environment_id = ? AND id = ?`)
        for (const id of write.removed) if (typeof id === 'string') del.run(env, id)
      }
      if (Array.isArray(write.workspaces))
        this.db.prepare(`UPDATE launch_mirror_hosts SET workspaces = ? WHERE environment_id = ?`).run(JSON.stringify(write.workspaces), env)
      if (Array.isArray(write.projects))
        this.db.prepare(`UPDATE launch_mirror_hosts SET projects = ? WHERE environment_id = ?`).run(JSON.stringify(write.projects), env)
      this.prune(env, now)
      if (write.cursor !== undefined)
        this.db.prepare(`UPDATE launch_mirror_hosts SET cursor_seq = ?, cursor_generation = ? WHERE environment_id = ?`)
          .run(write.cursor?.seq ?? null, write.cursor?.generation ?? null, env)
      this.db.prepare(`UPDATE launch_mirror_hosts SET written_at = ? WHERE environment_id = ?`).run(now, env)
    })
  }

  /** A host that is no longer saved: its slice leaves whole. */
  forget(environmentId: string): void {
    this.epochs.set(environmentId, (this.epochs.get(environmentId) ?? 0) + 1)
    this.db.prepare(`DELETE FROM launch_mirror_sessions WHERE environment_id = ?`).run(environmentId)
    this.db.prepare(`DELETE FROM launch_mirror_hosts WHERE environment_id = ?`).run(environmentId)
  }

  private prune(env: string, now: number): void {
    this.db
      .prepare(`DELETE FROM launch_mirror_sessions WHERE environment_id = ? AND archived = 1 AND updated_at < ?`)
      .run(env, now - MIRROR_ARCHIVED_KEEP_MS)
    this.db
      .prepare(
        `DELETE FROM launch_mirror_sessions WHERE environment_id = ? AND id IN (
           SELECT id FROM launch_mirror_sessions WHERE environment_id = ?
           ORDER BY updated_at DESC LIMIT -1 OFFSET ?)`
      )
      .run(env, env, MIRROR_MAX_SESSIONS)
  }
}

function validSummary(s: unknown): s is MirrorSummary {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.updatedAt === 'number' && typeof o.archived === 'boolean'
}

function parseList(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
