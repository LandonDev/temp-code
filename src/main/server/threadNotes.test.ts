import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyNoteEdit,
  compactNotes,
  demoteHeadings,
  emptyNotes,
  notesAsBrief,
  notesEmpty,
  parseNotes,
  sectionBody,
  stateLine,
  ThreadNotes,
  type NotesRow,
  type NotesStore
} from './threadNotes'

class MemStore implements NotesStore {
  rows = new Map<string, NotesRow>()
  getSessionNotes(id: string): NotesRow | null {
    return this.rows.get(id) ?? null
  }
  setSessionNotes(id: string, text: string, updatedAt: number): void {
    this.rows.set(id, { text, updatedAt })
  }
  deleteSessionNotes(id: string): void {
    this.rows.delete(id)
  }
}

describe('note sections', () => {
  it('an empty file carries every fixed heading in order', () => {
    expect(emptyNotes()).toBe('## Goal\n\n## Decisions\n\n## State\n\n## Pointers\n\n## Open questions\n')
    expect(notesEmpty(emptyNotes())).toBe(true)
    expect(notesEmpty('')).toBe(true)
  })

  it('replace swaps one section body and creates a missing heading in its place', () => {
    const a = applyNoteEdit('', { section: 'state', content: 'Done: parser.\nIn flight: tests.' })
    expect(sectionBody(a, 'State')).toBe('Done: parser.\nIn flight: tests.')
    expect(a.startsWith('## Goal\n\n## Decisions\n\n## State\n\nDone: parser.')).toBe(true)
    const b = applyNoteEdit(a, { section: 'State', mode: 'replace', content: 'Done: everything.' })
    expect(sectionBody(b, 'State')).toBe('Done: everything.')
    expect(sectionBody(b, 'Goal')).toBe('')
    expect(notesEmpty(b)).toBe(false)
  })

  it('append adds a paragraph under the heading and keeps the rest', () => {
    const a = applyNoteEdit(emptyNotes(), { section: 'Decisions', content: '- Use SQLite.' })
    const b = applyNoteEdit(a, { section: 'decisions', mode: 'append', content: '- One file per thread.' })
    expect(sectionBody(b, 'Decisions')).toBe('- Use SQLite.\n\n- One file per thread.')
    expect(sectionBody(b, 'State')).toBe('')
  })

  it('a heading the thread invented survives after the fixed ones; a preamble stays first', () => {
    const text = 'Scratch line.\n\n## Risks\n\n- flaky test\n\n## Goal\n\nShip notes.\n'
    const out = applyNoteEdit(text, { section: 'Pointers', content: 'src/x.ts' })
    expect(parseNotes(out).preamble).toBe('Scratch line.')
    const headings = parseNotes(out).sections.map((s) => s.heading)
    expect(headings).toEqual(['Goal', 'Decisions', 'State', 'Pointers', 'Open questions', 'Risks'])
    expect(sectionBody(out, 'Risks')).toBe('- flaky test')
  })

  it('duplicate headings merge and CRLF input normalizes', () => {
    const out = applyNoteEdit('## State\r\n\r\none\r\n\r\n## State\r\n\r\ntwo\r\n', {
      section: 'Goal',
      content: 'g'
    })
    expect(sectionBody(out, 'State')).toBe('one\n\ntwo')
    expect(out.includes('\r')).toBe(false)
  })

  it('the State line is the first non-empty line without its list marker', () => {
    expect(stateLine(emptyNotes())).toBeNull()
    const t = applyNoteEdit('', { section: 'State', content: '\n- [ ] **Blocked**: waiting on the API key\n- next' })
    expect(stateLine(t)).toBe('Blocked: waiting on the API key')
    expect(stateLine(applyNoteEdit('', { section: 'State', content: '1. tests red' }))).toBe('tests red')
  })

  it('compact notes drop empty headings and keep the preamble', () => {
    const t = applyNoteEdit('Scratch.\n\n## State\n\n- half', { section: 'Pointers', content: 'src/a.ts' })
    expect(compactNotes(t)).toBe('Scratch.\n\n## State\n\n- half\n\n## Pointers\n\nsrc/a.ts')
    expect(compactNotes(emptyNotes())).toBe('')
  })

  it('headings demote for embedding and the brief names the thread', () => {
    const t = applyNoteEdit(applyNoteEdit('', { section: 'Goal', content: 'Ship it.' }), {
      section: 'Open questions',
      content: '- Which port?'
    })
    expect(demoteHeadings(t)).toContain('### Goal\n\nShip it.')
    expect(demoteHeadings(t)).not.toMatch(/^## /m)
    const brief = notesAsBrief(t, 'Notes feature')
    expect(brief.startsWith('Continue the work of thread "Notes feature".')).toBe(true)
    expect(brief).toContain('**Goal**\n\nShip it.')
    expect(brief).toContain('**Open questions**\n\n- Which port?')
    expect(brief).not.toContain('**Decisions**')
  })

  it('the brief\'s closing line names only the sections it carries', () => {
    const custom = notesAsBrief('# Scratch\n\nJust a note.', 'T')
    expect(custom).not.toMatch(/Start from|Pointers/)
    expect(custom.endsWith('Just a note.')).toBe(true)
    const state = notesAsBrief(applyNoteEdit('', { section: 'State', content: 'Half done.' }), 'T')
    expect(state.endsWith('Start from State.')).toBe(true)
    const pointers = notesAsBrief(applyNoteEdit('', { section: 'Pointers', content: 'src/a.ts' }), 'T')
    expect(pointers.endsWith('The Pointers name the files and commands that matter.')).toBe(true)
    expect(pointers).not.toContain('Start from')
  })
})

describe('ThreadNotes storage', () => {
  let root: string
  let store: MemStore
  let notes: ThreadNotes
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tc-notes-'))
    store = new MemStore()
    notes = new ThreadNotes(store, (id) => (id === 'nodir' ? null : join(root, id)))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a section update lands in the file and the mirror and notifies', async () => {
    const seen: string[] = []
    notes.onChange((id, doc) => seen.push(`${id}:${doc.updatedAt}`))
    const doc = notes.update('s1', { section: 'Goal', content: 'Keep notes.' }, 1000)
    expect(doc.path).toBe(join(root, 's1', 'notes.md'))
    expect(await readFile(doc.path!, 'utf8')).toBe(doc.text)
    expect(store.rows.get('s1')).toEqual({ text: doc.text, updatedAt: 1000 })
    expect(seen).toEqual(['s1:1000'])
    expect(notes.has('s1')).toBe(true)
    expect(notes.textFor('s1')).toBe('## Goal\n\nKeep notes.')
  })

  it("the person's whole-text write is what the next section update builds on", () => {
    notes.update('s1', { section: 'Goal', content: 'A' }, 1)
    notes.write('s1', '## Goal\n\nA (edited by hand)\n\n## State\n\n- half done\n', 2)
    const doc = notes.update('s1', { section: 'State', mode: 'append', content: '- tests green' }, 3)
    expect(sectionBody(doc.text, 'Goal')).toBe('A (edited by hand)')
    expect(sectionBody(doc.text, 'State')).toBe('- half done\n\n- tests green')
    expect(notes.stateLine('s1')).toBe('half done')
  })

  it('a file edited behind the mirror wins on the next read and is mirrored back', async () => {
    notes.update('s1', { section: 'Goal', content: 'A' }, 1)
    const seen: number[] = []
    notes.onChange((_id, doc) => seen.push(doc.updatedAt ?? -1))
    const path = join(root, 's1', 'notes.md')
    await writeFile(path, '## Goal\n\nB by the harness\n')
    await utimes(path, new Date(5000), new Date(5000))
    const doc = notes.read('s1')
    expect(doc.text).toBe('## Goal\n\nB by the harness\n')
    expect(doc.updatedAt).toBe(5000)
    expect(store.rows.get('s1')?.text).toBe(doc.text)
    expect(seen).toEqual([5000])
    // Unchanged on the next read: no second notification.
    notes.read('s1')
    expect(seen).toEqual([5000])
  })

  it('without a directory the mirror alone holds the notes; nothing yet reads empty', () => {
    expect(notes.read('nodir')).toEqual({ text: '', updatedAt: null, path: null })
    expect(notes.has('nodir')).toBe(false)
    expect(notes.textFor('nodir')).toBeNull()
    const doc = notes.update('nodir', { section: 'Pointers', content: 'src/a.ts' }, 7)
    expect(doc.path).toBeNull()
    expect(store.rows.get('nodir')?.updatedAt).toBe(7)
    expect(notes.read('nodir').text).toBe(doc.text)
    notes.remove('nodir')
    expect(notes.read('nodir').text).toBe('')
  })

  it('an all-empty file counts as no notes for prompts', () => {
    notes.write('s1', emptyNotes(), 1)
    expect(notes.has('s1')).toBe(false)
    expect(notes.textFor('s1')).toBeNull()
  })
})
