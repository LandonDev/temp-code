import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { bootMark } from './boot'
import { basename, join, relative, isAbsolute } from 'node:path'
import type { EventRow, SessionMeta } from '@shared/events'
import type { ProjectMeta } from '@shared/domain'
import { latestTurnRows, toolLinesOf, turnText } from './orchestration'
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

/** The readable dialogue: ## User / ## Assistant sections, one-line tool
 *  actions as bullets. No thinking, no tool payloads. */
export function renderDialogue(rows: EventRow[]): string {
  const sections: string[] = []
  let turn: EventRow[] = []
  const flush = (): void => {
    if (turn.length === 0) return
    const tools = toolLinesOf(turn, 1000)
    const text = turnText(turn)
    const body = [tools.map((l) => `- ${l}`).join('\n'), text].filter(Boolean).join('\n\n')
    if (body) sections.push(`## Assistant\n\n${body}`)
    turn = []
  }
  for (const row of rows) {
    if (row.event.type === 'user-text') {
      flush()
      sections.push(`## User\n\n${row.event.text}`)
    } else if (row.event.type === 'goal') {
      flush()
      sections.push(`_${goalLine(row.event)}_`)
    } else {
      turn.push(row)
    }
  }
  flush()
  return sections.join('\n\n')
}

/** Tools that CHANGE a file, across providers — their paths lead the
 *  `files:` line, because the thread that wrote a file is the one you
 *  want when you go looking for who touched it. */
const WRITES = /edit|write|patch|create|update|notebook/i

/** Project-relative paths this thread's file tools touched, writes first,
 *  reads after, deduped in that order and capped. `.temp-code/` is the
 *  app's own context dir — never what a reader is grepping for. */
export function filesTouched(rows: EventRow[], cwd: string): string[] {
  const writes: string[] = []
  const reads: string[] = []
  for (const { event } of rows) {
    if (event.type !== 'tool-call' || event.partial) continue
    const input = (event.input && typeof event.input === 'object' ? event.input : {}) as Record<
      string,
      unknown
    >
    const key = ['file_path', 'path', 'notebook_path'].find((k) => typeof input[k] === 'string')
    if (!key) continue
    const raw = input[key] as string
    const rel = isAbsolute(raw) ? relative(cwd, raw) : raw
    // Outside the checkout (a worktree scratch file, /tmp) tells a reader nothing.
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.startsWith('.temp-code/')) continue
    ;(WRITES.test(event.name) ? writes : reads).push(rel)
  }
  return [...new Set([...writes, ...reads])].slice(0, FILES_MAX)
}

/** Full mirror content: frontmatter + dialogue, head-trimmed to the cap. */
export function renderMirror(
  meta: SessionMeta,
  rows: EventRow[],
  projectName?: string | null
): string {
  const files = filesTouched(rows, meta.cwd)
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
  const closing = turnText(latestTurnRows(rows)).trim()
  const outcome =
    closing.length > OUTCOME_MAX_CHARS ? `…${closing.slice(-OUTCOME_MAX_CHARS)}` : closing
  const head = outcome ? `${front}\n\n## Outcome\n\n${outcome}` : front
  let body = renderDialogue(rows)
  if (body.length > MIRROR_MAX_CHARS) {
    body = `_[earlier turns trimmed]_\n\n…${body.slice(-MIRROR_MAX_CHARS)}`
  }
  return `${head}\n\n${body}\n`
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
  const entries: { updated: string; line: string }[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md') || file === INDEX_NAME) continue
    let front: Record<string, string>
    try {
      front = frontmatterOf(readFileSync(join(dir, file), 'utf8').slice(0, 4_000))
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
  return meta.projectId ? (reg.getProject(meta.projectId)?.cwd ?? null) : null
}

export function mirrorSession(
  reg: SessionRegistry,
  sessionId: string,
  opts: { index?: boolean } = {}
): void {
  const meta = reg.list().find((s) => s.id === sessionId)
  const cwd = meta && contextCwd(reg, meta)
  if (!meta || !cwd) return
  try {
    const dir = join(cwd, '.temp-code', 'threads')
    mkdirSync(dir, { recursive: true })
    const name = mirrorName(meta)
    // Sweep copies left by an old title — one file per session, always.
    for (const f of readdirSync(dir)) {
      if (f !== name && f.includes(meta.id)) rmSync(join(dir, f), { force: true })
    }
    writeAtomic(join(dir, name), renderMirror(meta, reg.eventsAfter(sessionId, 0)))
    if (opts.index !== false) writeThreadsIndex(dir)
    rotateJournal(cwd) // a model append lands shortly before this write

  } catch {
    // Mirrors are best-effort context, never a failure the user sees.
  }
}

/** Debounced per session — an orchestrator burst writes once. */
export function scheduleMirror(reg: SessionRegistry, sessionId: string): void {
  const prior = timers.get(sessionId)
  if (prior) clearTimeout(prior)
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId)
      mirrorSession(reg, sessionId)
    }, MIRROR_DEBOUNCE_MS)
  )
}

/** Boot-time catch-up: mirrors written before `files:` and `## Outcome`
 *  existed regenerate once, so INDEX.md is complete from day one. Pure
 *  serialization off the event log — no model, no network — and deferred
 *  past startup so it never competes with the first window. */
export function backfillMirrors(reg: SessionRegistry): void {
  const timer = setTimeout(() => {
    bootMark('mirror-backfill start')
    const dirs = new Set<string>()
    for (const meta of reg.list()) {
      if (!meta.projectId || meta.archived) continue
      mirrorSession(reg, meta.id, { index: false })
      const cwd = contextCwd(reg, meta)
      if (cwd) dirs.add(join(cwd, '.temp-code', 'threads'))
    }
    for (const dir of dirs) {
      try {
        writeThreadsIndex(dir)
      } catch {
        // best-effort, like every other mirror write
      }
    }
    bootMark('mirror-backfill done')
  }, 5_000)
  timer.unref()
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
  return renderMirror(refMeta, reg.eventsAfter(refMeta.id, 0), projectName)
}

/** Write a fresh digest of a referenced thread into the CURRENT project's
 *  refs/ — a local copy every harness sandbox can read, cross-project or
 *  not. Returns the project-relative path. */
export function writeThreadDigest(
  reg: SessionRegistry,
  refMeta: SessionMeta,
  targetCwd: string
): string {
  mkdirSync(join(targetCwd, '.temp-code', 'refs'), { recursive: true })
  const rel = join('.temp-code', 'refs', `${refMeta.id}.md`)
  const sameProject = contextCwd(reg, refMeta) === targetCwd
  const pointer = sameProject
    ? `\n_Full transcript: ${mirrorRelPath(refMeta)}_\n`
    : ''
  writeAtomic(join(targetCwd, rel), capDigest(threadDigest(reg, refMeta), pointer))
  return rel
}

/** A seed is the single biggest thing a thread reads on turn one, so it
 *  gets the head whole — frontmatter and `## Outcome`, the settled result
 *  — plus as much of the newest dialogue as the cap leaves. Older turns
 *  stay one file read away, behind the pointer. */
function capDigest(digest: string, pointer: string): string {
  const budget = INLINE_DIGEST_MAX_CHARS - pointer.length
  if (digest.length <= budget) return `${digest}${pointer}`
  const frontEnd = digest.indexOf('\n---\n', 4) + 5 // close of the frontmatter
  const outcome = digest.indexOf('\n## Outcome\n', frontEnd)
  const dialogue = outcome > 0 ? digest.indexOf('\n## ', outcome + 4) : -1
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
