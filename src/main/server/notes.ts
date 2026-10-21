import type { DatabaseSync } from 'node:sqlite'
import { NoteIdSchema, NoteUpsertSchema, type Note, type NoteSearchHit, type NoteSearchResult, type NoteUpsert } from '@shared/contract-m3a'

export function ensureNotesTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', source_session_id TEXT, source_cwd TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS notes_updated_idx ON notes (updated_at DESC, id);`)
}

const columns = `id, slug, title, body, source_session_id AS sourceSessionId,
  source_cwd AS sourceCwd, created_at AS createdAt, updated_at AS updatedAt`
type NoteRow = Omit<Note, 'sourceSessionId' | 'sourceCwd'> & {
  sourceSessionId: string | null
  sourceCwd: string | null
}
function fromRow({ sourceSessionId, sourceCwd, ...note }: NoteRow): Note {
  return {
    ...note,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sourceCwd ? { sourceCwd } : {})
  }
}

export class Notes {
  constructor(private db: DatabaseSync) {}

  list(): Note[] {
    return (
      this.db
        .prepare(`SELECT ${columns} FROM notes ORDER BY updated_at DESC, id ASC`)
        .all() as unknown as NoteRow[]
    ).map(fromRow)
  }

  get(id: string): Note | null {
    NoteIdSchema.parse(id)
    const row = this.db.prepare(`SELECT ${columns} FROM notes WHERE id = ?`).get(id) as
      NoteRow | undefined
    return row ? fromRow(row) : null
  }

  upsert(input: NoteUpsert): Note {
    const note = NoteUpsertSchema.parse(input)
    if (Buffer.byteLength(note.body, 'utf8') > 1_000_000) throw new Error('Note is too large')
    const title = Array.from(note.title.trim()).slice(0, 200).join('').trim() || 'Untitled'
    const body = note.body.replace(/\r\n?/g, '\n')
    const existing = this.get(note.id)
    const now = Date.now()
    if (existing) {
      this.db
        .prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?')
        .run(title, body, now, note.id)
      return { ...existing, title, body, updatedAt: now }
    }
    const base =
      title
        .replace(/[^A-Za-z0-9]+/g, '-')
        .toLowerCase()
        .replace(/^-/, '')
        .slice(0, 48)
        .replace(/-$/, '') || 'note'
    let slug = base
    let suffix = 2
    while (this.db.prepare('SELECT 1 FROM notes WHERE slug = ?').get(slug))
      slug = `${base}-${suffix++}`
    const sourceSessionId = note.sourceSessionId?.trim() || null
    const sourceCwd = note.sourceCwd?.trim() || null
    this.db
      .prepare(
        `INSERT INTO notes (id, slug, title, body, source_session_id, source_cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(note.id, slug, title, body, sourceSessionId, sourceCwd, now, now)
    return fromRow({
      id: note.id,
      slug,
      title,
      body,
      sourceSessionId,
      sourceCwd,
      createdAt: now,
      updatedAt: now
    })
  }

  delete(id: string): void {
    NoteIdSchema.parse(id)
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id)
  }

  /** Notes whose title or body mentions the query, newest first, with a
   *  snippet around the first mention (`notes.search`). Notes are few and
   *  small, so this is a case-insensitive scan; a per-thread notes file,
   *  when one lands, joins through the same shape. */
  search(query: string, limit = 50): NoteSearchResult {
    const needle = query.trim().toLowerCase()
    const cap = Math.min(Math.max(1, Math.floor(limit)), 200)
    if (!needle) return { hits: [], truncated: false }
    const rows = this.db
      .prepare(
        `SELECT id, title, body, source_cwd AS sourceCwd, updated_at AS updatedAt FROM notes
         WHERE instr(lower(title), ?) > 0 OR instr(lower(body), ?) > 0
         ORDER BY updated_at DESC, id ASC LIMIT ?`
      )
      .all(needle, needle, cap + 1) as unknown as { id: string; title: string; body: string; sourceCwd: string | null; updatedAt: number }[]
    const hits: NoteSearchHit[] = rows.slice(0, cap).map((row) => ({
      id: row.id,
      title: row.title,
      snippet: noteSnippet(row.title, row.body, needle),
      updatedAt: row.updatedAt,
      ...(row.sourceCwd ? { sourceCwd: row.sourceCwd } : {})
    }))
    return { hits, truncated: rows.length > cap }
  }
}

/** Up to 180 characters of the body around the first mention; the title
 *  when only it matches. */
export function noteSnippet(title: string, body: string, needle: string): string {
  const compact = body.replace(/\s+/g, ' ').trim()
  const at = compact.toLowerCase().indexOf(needle)
  if (at < 0) return title.toLowerCase().includes(needle) ? title : compact.slice(0, 180)
  const start = Math.max(0, at - 60)
  return (start > 0 ? '…' : '') + compact.slice(start, start + 180).trim()
}
