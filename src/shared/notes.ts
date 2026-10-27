/**
 * A thread's working notes, the text side (pure: the renderer's Notes
 * panel, the bridge test and the server share it; the storage lives in
 * src/main/server/threadNotes.ts).
 *
 * One markdown file the thread keeps current so
 * the next context window (after a compaction) and a successor thread
 * (seeded from a digest) start from what the thread KNOWS, not from a
 * lossy transcript. The file lives beside the thread's attachments
 * (`attachmentDir(session)/notes.md`, attachmentDir.ts), where the harness
 * can read and write it with its own tools; the `session_notes` table
 * mirrors it for the renderer, search and archived threads.
 *
 * The headings are fixed (NOTE_SECTIONS): `update_notes` (apptools.ts)
 * replaces or appends one section at a time, the person edits the whole
 * text from the Notes panel, and both land in the same file. A write from
 * either side is the truth the other reads next: the panel follows the
 * `notes` push, the harness reads the file on its next tool call.
 */

export const NOTE_SECTIONS = ['Goal', 'Decisions', 'State', 'Pointers', 'Open questions'] as const
export type NoteSection = (typeof NOTE_SECTIONS)[number]

export const NOTES_FILE = 'notes.md'

export const UPDATE_NOTES_TOOL_NAME = 'update_notes'
export const UPDATE_NOTES_DESCRIPTION =
  "Update this thread's working notes: the one document that survives a context compaction and seeds any successor thread. Replace or append ONE section (Goal, Decisions, State, Pointers, Open questions); the app writes notes.md beside the thread's attachments and shows it live in the Notes panel. Keep State current (what is done, in flight, blocked) and Pointers concrete (files, commands, ids). Update after every decision, before context runs low, and after a commit or merge."
export const UPDATE_NOTES_PARAMS = {
  section: 'Which heading: Goal | Decisions | State | Pointers | Open questions (a new heading is allowed, after the fixed ones).',
  mode: 'replace (default) swaps the section body; append adds a paragraph under it.',
  content: 'Markdown for the section: short lines, concrete names, no transcript.'
} as const

export interface NoteEdit {
  section: string
  mode?: 'replace' | 'append'
  content: string
}

interface Parsed {
  preamble: string
  sections: { heading: string; body: string }[]
}

const HEADING_RE = /^##\s+(.+?)\s*$/

/** The canonical heading for a name the model or person typed (`state`, `Open Questions`). */
export function canonicalSection(name: string): string {
  const key = name.trim().toLowerCase()
  return NOTE_SECTIONS.find((s) => s.toLowerCase() === key) ?? name.trim()
}

export function parseNotes(text: string): Parsed {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const sections: Parsed['sections'] = []
  const pre: string[] = []
  let cur: { heading: string; body: string[] } | null = null
  for (const line of lines) {
    const m = HEADING_RE.exec(line)
    if (m) {
      if (cur) sections.push({ heading: cur.heading, body: cur.body.join('\n').trim() })
      cur = { heading: canonicalSection(m[1]), body: [] }
    } else if (cur) cur.body.push(line)
    else pre.push(line)
  }
  if (cur) sections.push({ heading: cur.heading, body: cur.body.join('\n').trim() })
  return { preamble: pre.join('\n').trim(), sections }
}

/** The fixed headings first, in their order (duplicates merged), then any the thread added. */
function orderSections(sections: Parsed['sections']): Parsed['sections'] {
  const byHeading = new Map<string, string>()
  const extras: Parsed['sections'] = []
  for (const s of sections) {
    if ((NOTE_SECTIONS as readonly string[]).includes(s.heading)) {
      const prev = byHeading.get(s.heading)
      byHeading.set(s.heading, prev ? `${prev}\n\n${s.body}`.trim() : s.body)
    } else extras.push(s)
  }
  return [...NOTE_SECTIONS.map((h) => ({ heading: h, body: byHeading.get(h) ?? '' })), ...extras]
}

/** Serialize with the fixed headings first, in their order, then any the
 *  thread added; every fixed heading is present even when empty, so a
 *  reader always sees the shape. */
export function renderNotes(parsed: Parsed): string {
  const parts: string[] = []
  if (parsed.preamble) parts.push(parsed.preamble)
  for (const s of orderSections(parsed.sections)) parts.push(s.body ? `## ${s.heading}\n\n${s.body}` : `## ${s.heading}`)
  return `${parts.join('\n\n')}\n`
}

export const emptyNotes = (): string => renderNotes({ preamble: '', sections: [] })

/** True when nothing has been written under any heading. */
export function notesEmpty(text: string): boolean {
  const p = parseNotes(text)
  return !p.preamble && p.sections.every((s) => !s.body)
}

/** Apply one section edit; a heading the file lacks is created in its
 *  canonical place. `append` adds a paragraph under the heading, `replace`
 *  (the default) swaps the whole body. */
export function applyNoteEdit(text: string, edit: NoteEdit): string {
  const parsed = parseNotes(text)
  const heading = canonicalSection(edit.section)
  const content = edit.content.replace(/\r\n/g, '\n').trim()
  const existing = parsed.sections.find((s) => s.heading === heading)
  if (existing) {
    existing.body =
      edit.mode === 'append' ? (existing.body ? `${existing.body}\n\n${content}` : content) : content
  } else parsed.sections.push({ heading, body: content })
  return renderNotes(parsed)
}

export function sectionBody(text: string, section: string): string {
  const heading = canonicalSection(section)
  return parseNotes(text).sections.find((s) => s.heading === heading)?.body ?? ''
}

/** The first line under State, stripped of list and checkbox markers: what
 *  the thread row shows while the thread waits on the person. */
export function stateLine(text: string): string | null {
  const body = sectionBody(text, 'State')
  for (const raw of body.split('\n')) {
    const line = raw
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .replace(/^\*\*(.+?)\*\*:?\s*/, '$1: ')
      .trim()
    if (line) return line
  }
  return null
}

/** The notes without their empty headings: what a prompt or a digest
 *  embeds (the file keeps every heading so the thread sees the shape). */
export function compactNotes(text: string): string {
  const p = parseNotes(text)
  const parts: string[] = []
  if (p.preamble) parts.push(p.preamble)
  for (const s of orderSections(p.sections)) if (s.body) parts.push(`## ${s.heading}\n\n${s.body}`)
  return parts.join('\n\n')
}

/** Notes rendered inside a larger document (a digest, a brief): the
 *  section headings step down one level so the host document's own `##`
 *  structure stays the outline. */
export function demoteHeadings(text: string): string {
  return text.replace(/^##\s+/gm, '### ').trim()
}

/** The notes as the first message of a successor thread. */
export function notesAsBrief(text: string, title: string): string {
  const p = parseNotes(text)
  const lines: string[] = [`Continue the work of thread "${title}". Its notes, kept by that thread:`, '']
  if (p.preamble) lines.push(p.preamble, '')
  for (const s of p.sections) {
    if (!s.body) continue
    lines.push(`**${s.heading}**`, '', s.body, '')
  }
  const filled = new Set(p.sections.filter((s) => s.body).map((s) => s.heading))
  const from = (['State', 'Open questions'] as const).filter((h) => filled.has(h))
  // The closing line names only sections the brief carries.
  const clauses = [
    from.length ? `Start from ${from.join(' and ')}` : '',
    filled.has('Pointers') ? 'the Pointers name the files and commands that matter' : ''
  ].filter(Boolean)
  if (clauses.length) {
    const line = clauses.join('; ')
    lines.push(`${line[0].toUpperCase()}${line.slice(1)}.`)
  }
  return lines.join('\n').trim()
}

