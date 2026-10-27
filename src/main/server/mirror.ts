import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { timed, untilLoopIdle, yieldUntilIdle } from './stalls'
import { appendFile, readFile } from 'node:fs/promises'
import { bootMark } from './boot'
import { basename, join, relative, isAbsolute } from 'node:path'
import type { EventRow, SessionMeta } from '@shared/events'
import type { ProjectMeta } from '@shared/domain'
import { demoteHeadings } from '@shared/notes'
import { TOOL_PATH_KEYS, TOOL_VALUE_KEYS, toolLine } from './orchestration'
import type { SessionRegistry } from './sessions'

/**
 * Shared project context, piece 1 (docs/PLAN-2.md M8): files are the
 * substrate. Every project thread's transcript is mirrored to
 * `.temp-code/threads/<slug>.md` after each completed turn, so any other
 * thread — any provider — can read what happened by reading a file.
 * PROJECT.md is the model-maintained journal next to them.
 */

/** Mirror size cap — head-trimmed like the provider-switch handoff. */
const MIRROR_MAX_CHARS = 60_000
/** How much of the closing turn the `## Outcome` header carries — its
 *  END, where the thread says what it settled on. */
const OUTCOME_MAX_CHARS = 1_200
/** How many touched files the `files:` frontmatter line names. */
const FILES_MAX = 20
/** The mechanical retrieval index every thread is pointed at. */
const INDEX_NAME = 'INDEX.md'
/** A burst of turn-completes (orchestrator fleets) writes once. */
const MIRROR_DEBOUNCE_MS = 2_000

const indexTimers = new Map<string, ReturnType<typeof setTimeout>>()
const indexSessions = new Map<string, Set<string>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const kebab = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40)

/** `<sessionId>-<kebab title>`; subagents prefixed `agent-`. The id keeps
 *  the file stable across renames (stale-titled copies are swept on write). */
export function mirrorName(meta: SessionMeta): string {
  const slug = kebab(meta.title)
  return `${meta.parentId ? 'agent-' : ''}${meta.id}${slug ? `-${slug}` : ''}.md`
}

export const mirrorRelPath = (meta: SessionMeta): string =>
  join('.temp-code', 'threads', mirrorName(meta))

/** Atomic write (tmp + rename): a harness mid-read never sees a half file. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** Goal lifecycle as one system line per event. Claude's mid-turn checks
 *  carry a reason; sets/updates without one read as plain state changes. */
function goalLine(e: Extract<EventRow['event'], { type: 'goal' }>): string {
  const by = e.byModel ? ' by the model' : ''
  switch (e.phase) {
    case 'set':
      return `Goal set${by} — ${e.condition}`
    case 'updated':
      return e.reason
        ? `Goal check (iteration ${e.iterations ?? 0}): ${e.reason}`
        : `Goal updated${by} — ${e.condition}`
    case 'met':
      return `Goal met${e.reason ? ` — ${e.reason}` : ''}`
    case 'cleared':
      return `Goal cleared${e.reason ? ` — ${e.reason}` : ''}`
  }
}

/** Tools that CHANGE a file, across providers — their paths lead the
 *  `files:` line, because the thread that wrote a file is the one you
 *  want when you go looking for who touched it. */
const WRITES = /edit|write|patch|create|update|notebook/i

/** A turn's final assistant text: no deltas, no subagent lanes (orchestration.ts turnText). */
const finalText = (event: EventRow['event']): string | null =>
  event.type === 'assistant-text' && !event.delta && !('parentCallId' in event && event.parentCallId) ? event.text : null

/**
 * The mirror, a row at a time: the dialogue (## User / ## Assistant
 * sections, one-line tool actions as bullets, no thinking, no tool
 * payloads), the files the thread touched and its closing turn are folded
 * as rows arrive, so a long log renders in chunks between reads.
 */
export class MirrorRenderer {
  private sections: string[] = []
  /** The open turn: rows seen, tool lines by call (a later row of a call replaces its line in place), failed calls, final texts. */
  private turnRows = 0
  private calls = new Map<string, string>()
  private failed = new Set<string>()
  private texts: string[] = []
  /** Final texts since the last user message: the closing turn. */
  private closing: string[] = []
  private writes: string[] = []
  private reads: string[] = []

  constructor(private readonly cwd: string) {}

  push(row: EventRow): void {
    const { event } = row
    if (event.type === 'tool-call' && !event.partial) this.touched(event.name, event.input)
    if (event.type === 'user-text') {
      this.flush()
      this.sections.push(`## User\n\n${event.text}`)
      this.closing = []
      return
    }
    if (event.type === 'goal') {
      this.flush()
      this.sections.push(`_${goalLine(event)}_`)
      return
    }
    this.turnRows++
    if (event.type === 'tool-result' && event.isError) this.failed.add(event.callId)
    if (event.type === 'tool-call') this.calls.set(event.callId, toolLine(event.name, event.input))
    const text = finalText(event)
    if (text !== null) {
      this.texts.push(text)
      this.closing.push(text)
    }
  }

  /** Project-relative paths a file tool named: writes first, reads after.
   *  `.temp-code/` is the app's own context dir — never what a reader is
   *  grepping for; outside the checkout (a worktree scratch file, /tmp)
   *  tells a reader nothing. */
  private touched(name: string, input: unknown): void {
    const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const key = TOOL_PATH_KEYS.find((k) => typeof obj[k] === 'string')
    if (!key) return
    const raw = obj[key] as string
    const rel = isAbsolute(raw) ? relative(this.cwd, raw) : raw
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.startsWith('.temp-code/')) return
    ;(WRITES.test(name) ? this.writes : this.reads).push(rel)
  }

  private flush(): void {
    if (this.turnRows === 0) return
    const tools = [...this.calls.entries()].map(([id, line]) => (this.failed.has(id) ? `${line} (failed)` : line)).slice(-1000)
    const text = this.texts.join('\n')
    const body = [tools.map((l) => `- ${l}`).join('\n'), text].filter(Boolean).join('\n\n')
    if (body) this.sections.push(`## Assistant\n\n${body}`)
    this.turnRows = 0
    this.calls = new Map()
    this.failed = new Set()
    this.texts = []
  }

  /** Full mirror content: frontmatter + dialogue, head-trimmed to the cap. */
  finish(
    meta: SessionMeta,
    projectName?: string | null,
    /** The thread's working notes (threadNotes.ts), verbatim ahead of the dialogue. */
    notes?: string | null
  ): string {
    this.flush()
    const files = [...new Set([...this.writes, ...this.reads])].slice(0, FILES_MAX)
    const front = [
      '---',
      `title: ${JSON.stringify(meta.title)}`,
      `type: ${meta.threadType ?? `subagent (${meta.agentType})`}`,
      ...(projectName ? [`project: ${JSON.stringify(projectName)}`] : []),
      `provider: ${meta.provider} · ${meta.model}`,
      `status: ${meta.status}`,
      `updated: ${new Date(meta.updatedAt).toISOString()}`,
      `sessionId: ${meta.id}`,
      ...(meta.parentId ? [`parentSessionId: ${meta.parentId}`] : []),
      ...(meta.planPath ? [`plan: ${meta.planPath}`] : []),
      ...(files.length ? [`files: ${files.join(', ')}`] : []),
      '---'
    ].join('\n')
    // The payload first: a reader gets what this thread concluded inside the
    // opening lines, and only reads the dialogue if that says it's the one.
    const closing = this.closing.join('\n').trim()
    const outcome = closing.length > OUTCOME_MAX_CHARS ? `…${closing.slice(-OUTCOME_MAX_CHARS)}` : closing
    // The notes come before the outcome: what the thread chose to keep is
    // the first thing a successor reads, then what it last said.
    const noted = notes?.trim() ? `${front}\n\n## Notes\n\n${demoteHeadings(notes)}` : front
    const head = outcome ? `${noted}\n\n## Outcome\n\n${outcome}` : noted
    let body = this.sections.join('\n\n')
    if (body.length > MIRROR_MAX_CHARS) {
      body = `_[earlier turns trimmed]_\n\n…${body.slice(-MIRROR_MAX_CHARS)}`
    }
    return `${head}\n\n${body}\n`
  }
}

/** Full mirror content from rows in hand (a digest, a test). */
export function renderMirror(
  meta: SessionMeta,
  rows: EventRow[],
  projectName?: string | null,
  notes?: string | null
): string {
  const r = new MirrorRenderer(meta.cwd)
  for (const row of rows) r.push(row)
  return r.finish(meta, projectName, notes)
}

/** A text value of a tool call's input, or SQL NULL: a value that is not a
 *  string (an object, a number) must stay one, so toolLine skips it alike. */
const inputText = (key: string, cap?: number): string => {
  const value = `json_extract(payload, '$.input.${key}')`
  return `'${key}', CASE WHEN json_type(payload, '$.input.${key}') = 'text' THEN ${cap ? `substr(${value}, 1, ${cap})` : value} END`
}

/** The rows a mirror reads (MirrorRenderer.push): user messages, goals,
 *  final assistant text, tool calls and results. Deltas and the rest never
 *  leave the worker. */
const MIRROR_ROWS_SQL = `json_valid(payload)
  AND json_extract(payload, '$.type') IN ('user-text', 'goal', 'assistant-text', 'tool-call', 'tool-result')
  AND NOT (json_extract(payload, '$.type') = 'assistant-text' AND COALESCE(json_extract(payload, '$.delta'), 0))`

/** Each row's payload cut to what the mirror reads: a tool call's input to
 *  the keys a tool line names (a value capped well past the 100 characters
 *  it shows), a tool result to its error flag. Built on first use: the keys
 *  come from orchestration.ts, which imports this module back. */
let mirrorPayloadSql: string | null = null
const MIRROR_PAYLOAD_SQL = (): string =>
  (mirrorPayloadSql ??= `CASE json_extract(payload, '$.type')
  WHEN 'tool-call' THEN json_set(json_remove(payload, '$.input', '$.preview'), '$.input', json_object(${[
    ...TOOL_PATH_KEYS.map((k) => inputText(k)),
    ...TOOL_VALUE_KEYS.map((k) => inputText(k, 4_000))
  ].join(', ')}))
  WHEN 'tool-result' THEN json_object('type', 'tool-result', 'callId', json_extract(payload, '$.callId'),
    'isError', json(CASE WHEN json_extract(payload, '$.isError') THEN 'true' ELSE 'false' END))
  WHEN 'user-text' THEN json_remove(payload, '$.attachments', '$.preamble')
  ELSE payload
END`)

/** Rows per read of a mirror render. */
const MIRROR_CHUNK = 2_000

/** The mirror off the loop: the log read in chunks on the reader worker
 *  (Store.readRows) with only what the mirror reads, rendered between
 *  waits for a quiet loop. */
export async function renderMirrorOffLoop(
  reg: Pick<SessionRegistry, 'readLogRows'>,
  meta: SessionMeta,
  opts: { chunk?: number; between?: () => Promise<void> } = {}
): Promise<string> {
  const chunk = opts.chunk ?? MIRROR_CHUNK
  const between = opts.between ?? (() => untilLoopIdle())
  const r = new MirrorRenderer(meta.cwd)
  let after = 0
  for (;;) {
    const rows = await reg.readLogRows(meta.id, { afterSeq: after, limit: chunk, payloadSql: MIRROR_PAYLOAD_SQL(), whereSql: MIRROR_ROWS_SQL })
    for (const row of rows) r.push(row)
    if (rows.length < chunk) break
    after = rows[rows.length - 1].seq
    await between()
    await new Promise((resolve) => setImmediate(resolve))
  }
  return r.finish(meta)
}

/** Frontmatter of a mirror, read from its head — the index never parses
 *  a whole transcript. */
function frontmatterOf(head: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = head.split('\n')
  if (lines[0] !== '---') return out
  for (const line of lines.slice(1)) {
    if (line === '---') break
    const at = line.indexOf(': ')
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 2)
  }
  return out
}

/** `threads/INDEX.md` — one line per thread, newest first, rebuilt from
 *  the mirrors' own frontmatter after every mirror write. Mechanical, so
 *  it is always current and costs no model tokens; regenerating from the
 *  directory makes last-writer-wins correct across parallel sessions. */
export function writeThreadsIndex(dir: string): void {
  timed('writeThreadsIndex', () => writeThreadsIndexNow(dir))
}

/** The frontmatter lives in the first bytes; a mirror can be megabytes. */
const FRONT_BYTES = 4_096

function readHead(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(FRONT_BYTES)
    const n = readSync(fd, buf, 0, FRONT_BYTES, 0)
    return buf.toString('utf8', 0, n)
  } finally {
    closeSync(fd)
  }
}

function writeThreadsIndexNow(dir: string): void {
  const entries: { updated: string; line: string }[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md') || file === INDEX_NAME) continue
    let front: Record<string, string>
    try {
      front = frontmatterOf(readHead(join(dir, file)))
    } catch {
      continue
    }
    if (!front.title) continue
    const updated = front.updated ?? ''
    const parts = [
      updated.slice(0, 10) || '?',
      front.type ?? 'thread',
      front.title,
      front.status ?? '?',
      front.files ? `files: ${front.files}` : 'files: —',
      ...(front.plan ? [`plan: ${basename(front.plan)}`] : []),
      join('threads', file)
    ]
    entries.push({ updated, line: `- ${parts.join(' · ')}` })
  }
  entries.sort((a, b) => b.updated.localeCompare(a.updated))
  const body = entries.length ? entries.map((e) => e.line).join('\n') : '_No threads yet._'
  writeAtomic(
    join(dir, INDEX_NAME),
    `# Thread index\n\n_Written by the app after every turn. date · type · title · status · files touched · plan · path (relative to .temp-code/). Grep it by file path or topic, then read only the threads it points at._\n\n${body}\n`
  )
}

/** The project cwd a session's context files live in. Subagents may run in
 *  throwaway worktrees — their context belongs to the project. */
function contextCwd(reg: SessionRegistry, meta: SessionMeta): string | null {
  const cwd = meta.projectId ? (reg.getProject(meta.projectId)?.cwd ?? null) : null
  // A checkout that is not on this machine (a worktree the app remakes on
  // the first turn, a root not cloned yet) gets no mirror: creating its dir
  // would make sessions.ts ensureCwd take the checkout for present.
  return cwd && existsSync(cwd) ? cwd : null
}

/** The mirror renders in flight, and the ones asked for again meanwhile. */
const rendering = new Map<string, Promise<void>>()
const again = new Set<string>()

/** Write a thread's mirror: the log read and rendered off the loop
 *  (renderMirrorOffLoop), one render per thread at a time; a write asked
 *  for while one runs runs once more after it. */
export function mirrorSession(
  reg: SessionRegistry,
  sessionId: string,
  opts: { index?: boolean } = {}
): Promise<void> {
  const running = rendering.get(sessionId)
  if (running) {
    again.add(sessionId)
    return running
  }
  const run = mirrorSessionNow(reg, sessionId, opts).finally(() => {
    rendering.delete(sessionId)
    if (again.delete(sessionId)) void mirrorSession(reg, sessionId, opts)
  })
  rendering.set(sessionId, run)
  return run
}

async function mirrorSessionNow(
  reg: SessionRegistry,
  sessionId: string,
  opts: { index?: boolean }
): Promise<void> {
  const meta = reg.get(sessionId)
  const cwd = meta && contextCwd(reg, meta)
  if (!meta || !cwd) return
  try {
    const content = await renderMirrorOffLoop(reg, meta)
    timed('mirrorSession', () => {
      const dir = join(cwd, '.temp-code', 'threads')
      mkdirSync(dir, { recursive: true })
      const name = mirrorName(meta)
      // Sweep copies left by an old title — one file per session, always.
      for (const f of readdirSync(dir)) {
        if (f !== name && f.includes(meta.id)) rmSync(join(dir, f), { force: true })
      }
      writeAtomic(join(dir, name), content)
      if (opts.index !== false) writeThreadsIndex(dir)
      rotateJournal(cwd) // a model append lands shortly before this write
    })
  } catch {
    // Mirrors are best-effort context, never a failure the user sees.
  }
}

/** Test seam: drop every pending mirror write (a closed test database must not be touched by a late timer). */
export function cancelMirrors(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  for (const t of indexTimers.values()) clearTimeout(t)
  indexTimers.clear()
  indexSessions.clear()
}

/** Mirrors in one project's settle window share one index write. */
function scheduleThreadsIndex(dir: string, sessionId: string): void {
  const prior = indexTimers.get(dir)
  if (prior) clearTimeout(prior)
  const sessions = indexSessions.get(dir) ?? new Set<string>()
  sessions.add(sessionId)
  indexSessions.set(dir, sessions)
  const timer = setTimeout(() => {
    indexTimers.delete(dir)
    indexSessions.delete(dir)
    // The session timers are armed first. Wait for their renders before
    // writing one index for the project's whole settle window.
    void Promise.all([...sessions].map(async (id) => {
      for (;;) {
        const pending = rendering.get(id)
        if (!pending) return
        await pending
      }
    })).then(() => {
      try { writeThreadsIndex(dir) } catch { /* best-effort context */ }
    })
  }, MIRROR_DEBOUNCE_MS)
  timer.unref?.()
  indexTimers.set(dir, timer)
}

/** Debounced per session — an orchestrator burst writes once. */
export function scheduleMirror(reg: SessionRegistry, sessionId: string): void {
  const prior = timers.get(sessionId)
  if (prior) clearTimeout(prior)
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId)
      void mirrorSession(reg, sessionId, { index: false })
    }, MIRROR_DEBOUNCE_MS)
  )
  const meta = reg.get(sessionId)
  const cwd = meta && contextCwd(reg, meta)
  if (cwd) scheduleThreadsIndex(join(cwd, '.temp-code', 'threads'), sessionId)
}

/** A mirror written after the thread's last change needs no rewrite.
 *  This is freshness by mtime only: a change to the mirror FORMAT does not
 *  make old files stale. When the format changes, stamp it (a version
 *  line in the frontmatter, say) and compare that here too — otherwise
 *  the backfill silently keeps the old shape. */
function mirrorFresh(dir: string, meta: SessionMeta): boolean {
  try {
    return statSync(join(dir, mirrorName(meta))).mtimeMs >= meta.updatedAt
  } catch {
    return false
  }
}

/** Boot-time catch-up for mirrors that are missing or older than their
 *  thread. Pure serialization off the event log — no model, no network —
 *  a quiet loop awaited after every rewrite and every 50 freshness checks
 *  so the window never freezes, and each project's INDEX.md written once
 *  at the end. */
export async function backfillMirrors(reg: SessionRegistry, between: () => Promise<void> = () => yieldUntilIdle()): Promise<void> {
  bootMark('mirror-backfill start')
  const dirs = new Set<string>()
  let written = 0
  let checked = 0
  for (const meta of reg.list()) {
    if (!meta.projectId || meta.archived) continue
    if (++checked % 50 === 0) await between()
    const cwd = contextCwd(reg, meta)
    if (!cwd) continue
    const dir = join(cwd, '.temp-code', 'threads')
    dirs.add(dir)
    if (mirrorFresh(dir, meta)) continue
    await mirrorSession(reg, meta.id, { index: false })
    written++
    await between()
  }
  for (const dir of dirs) {
    try {
      writeThreadsIndex(dir)
    } catch {
      // best-effort, like every other mirror write
    }
  }
  bootMark('mirror-backfill done', `${written} rewritten`)
}

/** Deleting a thread removes its mirror (archived threads keep theirs). */
export function removeMirror(reg: SessionRegistry, meta: SessionMeta): void {
  const cwd = contextCwd(reg, meta)
  if (!cwd) return
  const timer = timers.get(meta.id)
  if (timer) clearTimeout(timer)
  timers.delete(meta.id)
  try {
    const dir = join(cwd, '.temp-code', 'threads')
    for (const f of readdirSync(dir)) {
      if (f.includes(meta.id)) rmSync(join(dir, f), { force: true })
    }
    writeThreadsIndex(dir)
  } catch {
    // no mirror dir — nothing to remove
  }
}

// ── thread-reference digests (docs/PLAN-2.md M9) ─────────────────────

/** How much of a digest is inlined for projectless sessions. */
export const INLINE_DIGEST_MAX_CHARS = 12_000

/** A referenced thread rendered for reading: the mirror serializer plus a
 *  header naming the source project (and plan file, via frontmatter). */
export function threadDigest(reg: SessionRegistry, refMeta: SessionMeta): string {
  const projectName = refMeta.projectId ? (reg.getProject(refMeta.projectId)?.name ?? null) : null
  return renderMirror(refMeta, reg.eventsAfter(refMeta.id, 0), projectName, reg.notes.textFor(refMeta.id))
}

/** How many rows an inline digest reads at once from the end of the log. */
export const DIGEST_TAIL_PAGE = 400

/**
 * A digest that reads the log from its END in pages until the rendered
 * text covers `maxChars` (INLINE_DIGEST_MAX_CHARS for an inline reference):
 * a reference to a 10,000-row thread reads the rows the cap keeps, never
 * the whole log. The caller trims the text to the cap as before.
 */
export function threadDigestTail(reg: Pick<SessionRegistry, 'getProject' | 'notes' | 'lastEvents'>, refMeta: SessionMeta, maxChars: number): string {
  const projectName = refMeta.projectId ? (reg.getProject(refMeta.projectId)?.name ?? null) : null
  const notes = reg.notes.textFor(refMeta.id)
  let limit = DIGEST_TAIL_PAGE
  for (;;) {
    const rows = reg.lastEvents(refMeta.id, limit)
    const text = renderMirror(refMeta, rows, projectName, notes)
    // Enough text, or the whole log: stop. Else read a longer tail.
    if (text.length >= maxChars || rows.length < limit) return text
    limit *= 2
  }
}

/** Write a fresh digest of a referenced thread into the CURRENT project's
 *  refs/ — a local copy every harness sandbox can read, cross-project or
 *  not. Returns the project-relative path. */
export function writeThreadDigest(
  reg: SessionRegistry,
  refMeta: SessionMeta,
  targetCwd: string
): string {
  const sameProject = contextCwd(reg, refMeta) === targetCwd
  const pointer = sameProject
    ? `\n_Full transcript: ${mirrorRelPath(refMeta)}_\n`
    : ''
  return writeDigestFile(targetCwd, refMeta.id, capDigest(threadDigest(reg, refMeta), pointer))
}

/** Write a digest's text as `.temp-code/refs/<id>.md` under the project; returns the project-relative path. */
export function writeDigestFile(targetCwd: string, sessionId: string, text: string): string {
  mkdirSync(join(targetCwd, '.temp-code', 'refs'), { recursive: true })
  const rel = join('.temp-code', 'refs', `${sessionId}.md`)
  writeAtomic(join(targetCwd, rel), text)
  return rel
}

/** A thread's digest cut to the reference cap, for a reference from another
 *  host (thread.read): no pointer, the mirror file is not on that host. */
export function cappedThreadDigest(reg: SessionRegistry, refMeta: SessionMeta): string {
  return capDigest(threadDigest(reg, refMeta), '')
}

/** A seed is the single biggest thing a thread reads on turn one, so it
 *  gets the head whole — frontmatter and `## Outcome`, the settled result
 *  — plus as much of the newest dialogue as the cap leaves. Older turns
 *  stay one file read away, behind the pointer. */
function capDigest(digest: string, pointer: string): string {
  const budget = INLINE_DIGEST_MAX_CHARS - pointer.length
  if (digest.length <= budget) return `${digest}${pointer}`
  const frontEnd = digest.indexOf('\n---\n', 4) + 5 // close of the frontmatter
  // The head is everything before the first dialogue turn: frontmatter,
  // the notes and the outcome (none of which is a turn heading).
  const starts = [digest.indexOf('\n## User\n', frontEnd), digest.indexOf('\n## Assistant\n', frontEnd)].filter((i) => i > 0)
  const dialogue = starts.length ? Math.min(...starts) : -1
  const head = digest.slice(0, dialogue > 0 ? dialogue : Math.max(frontEnd, 0)).trimEnd()
  const marker = '\n\n_[earlier turns trimmed]_\n\n…'
  const room = budget - head.length - marker.length - pointer.length
  if (room < 1_000) return `${head}${marker}${pointer}` // an outcome this big is the digest
  return `${head}${marker}${digest.slice(-room)}${pointer}`
}

// ── PROJECT.md, the journal ──────────────────────────────────────────

export const journalPath = (cwd: string): string => join(cwd, '.temp-code', 'PROJECT.md')

const today = (): string => new Date().toISOString().slice(0, 10)

/** Seeded once at project creation; model-maintained after that. A
 *  second project pointed at the same checkout finds a journal already
 *  there — that one is the history, so leave it alone. */
export function seedJournal(project: ProjectMeta): void {
  try {
    if (existsSync(journalPath(project.cwd))) return
    mkdirSync(join(project.cwd, '.temp-code'), { recursive: true })
    const where =
      project.mode === 'worktree'
        ? `worktree ${project.branch}`
        : project.branch
          ? `local on ${project.branch}`
          : 'local'
    writeAtomic(
      journalPath(project.cwd),
      `# ${project.name}\n\n_Project journal. One dated line per durable outcome, naming the files it touched — append under ## Log, never rewrite. Humans read it to catch up._\n\n## Log\n\n- ${today()} — project created (${where})\n`
    )
  } catch {
    // best-effort
  }
}

/** The app's one journal write after seeding: a deleted planning thread's
 *  entry, so the journal never dangles into a missing file. */
export async function appendJournal(cwd: string, line: string): Promise<void> {
  try {
    const path = journalPath(cwd)
    const exists = await readFile(path, 'utf8').catch(() => null)
    if (exists === null) return
    await appendFile(path, `- ${today()} — ${line}\n`)
    rotateJournal(cwd)
  } catch {
    // best-effort
  }
}

/** Past this the journal is costing every thread more than it tells them. */
const JOURNAL_MAX_BYTES = 6_000
/** Rotation trims back to here, so it fires once in a while, not per turn. */
const JOURNAL_TARGET_BYTES = 4_000
/** Recent state a thread can still skim, even if other sections keep the
 *  file over its cap on their own. */
const JOURNAL_MIN_ENTRIES = 8
const ARCHIVE_NAME = 'PROJECT-archive.md'
const ARCHIVE_POINTER = `_Older entries: ${ARCHIVE_NAME}._`

/** Move the oldest `## Log` entries to `.temp-code/PROJECT-archive.md`
 *  once the journal outgrows its cap, keeping each entry whole and
 *  verbatim — nothing is rewritten, so the "never rewrite others'
 *  entries" contract survives rotation. Called from the app's own writes
 *  (mirror path, appendJournal), never mid-turn. */
export function rotateJournal(cwd: string): void {
  try {
    const path = journalPath(cwd)
    if (!existsSync(path)) return
    const text = readFileSync(path, 'utf8')
    if (Buffer.byteLength(text) <= JOURNAL_MAX_BYTES) return
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.startsWith('## Log'))
    if (start < 0) return
    let end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
    if (end < 0) end = lines.length

    // The log region as whole entries, oldest first: a `- ` line plus
    // whatever trails it (wrapped text, stray sub-bullets) until the next.
    const entries: string[][] = []
    const preamble: string[] = []
    for (const line of lines.slice(start + 1, end)) {
      if (line.startsWith('- ')) entries.push([line])
      else if (entries.length) entries[entries.length - 1].push(line)
      else preamble.push(line)
    }

    const moved: string[][] = []
    let size = Buffer.byteLength(text)
    while (entries.length > JOURNAL_MIN_ENTRIES && size > JOURNAL_TARGET_BYTES) {
      const entry = entries.shift() as string[]
      moved.push(entry)
      size -= Buffer.byteLength(`${entry.join('\n')}\n`)
    }
    if (!moved.length) return

    const archive = join(cwd, '.temp-code', ARCHIVE_NAME)
    const prior = existsSync(archive)
      ? readFileSync(archive, 'utf8').replace(/\n+$/, '\n')
      : `# Journal archive\n\n_Entries rotated out of PROJECT.md, oldest first._\n`
    writeAtomic(archive, `${prior}${moved.map((e) => e.join('\n').trimEnd()).join('\n')}\n`)

    const kept = preamble.filter((l) => l.trim() && l.trim() !== ARCHIVE_POINTER)
    const region = ['## Log', '', ARCHIVE_POINTER, ...(kept.length ? ['', ...kept] : []), '']
    const next = [...lines.slice(0, start), ...region, ...entries.flat(), ...lines.slice(end)]
    writeAtomic(path, `${next.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`)
  } catch {
    // best-effort, like every other write in this file
  }
}
