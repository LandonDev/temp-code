import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventRow, SessionMeta } from '@shared/events'
import type { ProjectMeta } from '@shared/domain'
import { toolLinesOf, turnText } from './orchestration'
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
    } else {
      turn.push(row)
    }
  }
  flush()
  return sections.join('\n\n')
}

/** Full mirror content: frontmatter + dialogue, head-trimmed to the cap. */
export function renderMirror(
  meta: SessionMeta,
  rows: EventRow[],
  projectName?: string | null
): string {
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
    '---'
  ].join('\n')
  let body = renderDialogue(rows)
  if (body.length > MIRROR_MAX_CHARS) {
    body = `_[earlier turns trimmed]_\n\n…${body.slice(-MIRROR_MAX_CHARS)}`
  }
  return `${front}\n\n${body}\n`
}

/** The project cwd a session's context files live in. Subagents may run in
 *  throwaway worktrees — their context belongs to the project. */
function contextCwd(reg: SessionRegistry, meta: SessionMeta): string | null {
  return meta.projectId ? (reg.getProject(meta.projectId)?.cwd ?? null) : null
}

export function mirrorSession(reg: SessionRegistry, sessionId: string): void {
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
  writeAtomic(join(targetCwd, rel), threadDigest(reg, refMeta))
  return rel
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
      `# ${project.name}\n\n_Project journal. Threads append dated bullets under ## Log when they produce a durable outcome; humans read it to catch up._\n\n## Log\n\n- ${today()} — project created (${where})\n`
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
  } catch {
    // best-effort
  }
}
