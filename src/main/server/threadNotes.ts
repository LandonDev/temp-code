import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ThreadNotesDoc } from '@shared/contract'
import { applyNoteEdit, compactNotes, emptyNotes, notesEmpty, NOTES_FILE, stateLine, type NoteEdit } from '@shared/notes'

export * from '@shared/notes'

/**
 * The storage side of a thread's notes (the text rules are in
 * src/shared/notes.ts): `attachmentDir(session)/notes.md` on the thread's
 * host, where the harness can read and write it with its own tools, plus
 * the `session_notes` row that mirrors it for the renderer, search and
 * archived threads whose directory is gone. A write from either side is
 * the truth the other reads next: the panel follows the `notes` push, the
 * harness reads the file on its next tool call.
 */

export type NotesDoc = ThreadNotesDoc

/** Who changed the notes: the harness's tool, the person's panel edit, or a file edited behind the mirror. */
export type NotesSource = 'tool' | 'person' | 'file'

// ── storage ───────────────────────────────────────────────────────────

export interface NotesRow {
  text: string
  updatedAt: number
}

/** The database side (db.ts): the mirror of the file. */
export interface NotesStore {
  getSessionNotes(sessionId: string): NotesRow | null
  setSessionNotes(sessionId: string, text: string, updatedAt: number): void
  deleteSessionNotes(sessionId: string): void
}

export type NotesListener = (sessionId: string, doc: NotesDoc, source: NotesSource) => void

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

export class ThreadNotes {
  private listeners = new Set<NotesListener>()

  constructor(
    private store: NotesStore,
    /** The thread's attachment directory on this host, or null when none can be named (attachmentDir.ts). */
    private dirOf: (sessionId: string) => string | null
  ) {}

  onChange(listener: NotesListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  pathOf(sessionId: string): string | null {
    const dir = this.dirOf(sessionId)
    return dir ? join(dir, NOTES_FILE) : null
  }

  /** The current notes. The file wins over the mirror: a harness that
   *  edited notes.md with its own tools, or a person who edited it in an
   *  editor, is picked up here and mirrored into the row (and pushed) before
   *  anyone reads a stale copy. */
  read(sessionId: string): NotesDoc {
    const path = this.pathOf(sessionId)
    const row = this.store.getSessionNotes(sessionId)
    if (path && existsSync(path)) {
      let text: string
      let mtime: number
      try {
        text = readFileSync(path, 'utf8')
        mtime = Math.round(statSync(path).mtimeMs)
      } catch {
        return { text: row?.text ?? '', updatedAt: row?.updatedAt ?? null, path }
      }
      if (!row || row.text !== text) {
        this.store.setSessionNotes(sessionId, text, mtime)
        const doc = { text, updatedAt: mtime, path }
        this.notify(sessionId, doc, 'file')
        return doc
      }
      return { text, updatedAt: row.updatedAt, path }
    }
    return { text: row?.text ?? '', updatedAt: row?.updatedAt ?? null, path }
  }

  /** True when the thread has written anything under a heading. */
  has(sessionId: string): boolean {
    const text = this.read(sessionId).text
    return text.trim().length > 0 && !notesEmpty(text)
  }

  /** The notes for a prompt or a digest — empty headings dropped — or null when there are none. */
  textFor(sessionId: string): string | null {
    const text = this.read(sessionId).text
    return text.trim() && !notesEmpty(text) ? compactNotes(text) : null
  }

  stateLine(sessionId: string): string | null {
    return stateLine(this.read(sessionId).text)
  }

  /** Replace the whole text (the person's edit from the panel). */
  write(sessionId: string, text: string, now: number = Date.now(), source: NotesSource = 'person'): NotesDoc {
    const normalized = text.replace(/\r\n/g, '\n')
    const path = this.pathOf(sessionId)
    if (path) writeAtomic(path, normalized.endsWith('\n') || !normalized ? normalized : `${normalized}\n`)
    this.store.setSessionNotes(sessionId, normalized, now)
    const doc = { text: normalized, updatedAt: now, path }
    this.notify(sessionId, doc, source)
    return doc
  }

  /** One section edit from the harness (update_notes): reads the file
   *  first, so a person's edit since the last call is never overwritten. */
  update(sessionId: string, edit: NoteEdit, now: number = Date.now()): NotesDoc {
    const current = this.read(sessionId).text
    return this.write(sessionId, applyNoteEdit(current || emptyNotes(), edit), now, 'tool')
  }

  /** A deleted thread drops its row; the file goes with the attachment dir sweep. */
  remove(sessionId: string): void {
    this.store.deleteSessionNotes(sessionId)
  }

  private notify(sessionId: string, doc: NotesDoc, source: NotesSource): void {
    for (const l of this.listeners) l(sessionId, doc, source)
  }
}
