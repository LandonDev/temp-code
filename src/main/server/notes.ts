import type { DatabaseSync } from 'node:sqlite'
import { NoteIdSchema, NoteUpsertSchema, type Note, type NoteUpsert } from '@shared/contract-m3a'

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
}
