import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
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
  writeFileSync
} from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import {
  SESSION_MOVE_FILE_CHUNK,
  SESSION_MOVE_PART_BYTES,
  type SessionImportBeginAnswer,
  type SessionMoveFile,
  type SessionMoveFrame,
  type SessionMoveManifest,
  type SessionMovePart,
  type SessionMoveRowState
} from '@shared/contract-session-move'
import { stripSlash, type HistoryMapping } from './pathMap'

/**
 * Moving one thread between hosts: the data half (docs/box.md "Moving a
 * thread between hosts"). remote/sessionMover.ts drives a move over the peer
 * link; this file reads a thread out of one host's database and lands it in
 * another's, with no network and no registry, so the round trip is testable
 * on two temp databases.
 *
 *  - export: the subtree (root + every descendant by parent_id), its event
 *    rows from both tiers, its folds, its agent pages (html-renders/<id>)
 *    and its harness transcripts (Claude's projects/<slug(cwd)>/<id>.jsonl
 *    plus the <id>/ dir, Codex's sessions/**\/rollout-*-<id>.jsonl), cut into
 *    ordered parts: event rows in seq ranges of at most 2 MiB of JSON, files
 *    in 2 MiB chunks. Each frame carries the running digest of the bundle
 *    (a hash chain over each part's canonical bytes), so a receiver checks
 *    every frame as it lands and the commit compares one value.
 *  - import: the receiver remaps the sender's paths (pathMap.ts, its own
 *    `harness.sync.pathMap` plus the sender's home and work root, either
 *    direction), resolves its own workspace and project by the remapped path,
 *    refuses when no workspace holds the cwd or the cwd is missing, and lands
 *    the rows at once but hidden (`moving_from`), the files on commit. The
 *    landing becomes the thread on release; abort drops it.
 *  - tombstone: once the receiver echoed the digest, the source keeps only
 *    the sessions rows with `moved_to` and archived set, and drops the
 *    events, folds and pages. Checkpoints stay: they are baselines of this
 *    host's tree, and the result says undo history stayed here.
 */

export interface MoveHost {
  db: DatabaseSync
  environmentId: string
  /** <userData>: html-renders/, checkpoints/ and the staging dir live under it. */
  dataDir: string
  home(): string
  workRoot(): string
  pathMap(): HistoryMapping
  /** Claude Code's config dir (CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeDir(): string
  /** Codex's home (CODEX_HOME, else ~/.codex). */
  codexDir(): string
  /** `git status --porcelain` paths of a cwd; [] when it is not a repo. */
  gitDirty?(cwd: string): Promise<string[]>
  exists?(path: string): boolean
  /** The store's caches over these ids are stale (seq counters, tiers). */
  forget?(ids: readonly string[]): void
}

export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
export const codexHomeDir = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')

/** Claude Code's project dir name for a cwd (scripts/mac/copy-claude-projects.sh). */
export const claudeSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9_-]/g, '-')

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
type Row = Record<string, string | number | null>
const MOVE_COLUMNS = new Set(['moving_to', 'moving_from', 'moved_to', 'move_id'])
const DIRTY_CAP = 200

// ── the subtree and its state ────────────────────────────────────────────

/** The root and every descendant, parent before child. Tombstones and landings included: callers filter. */
export function subtreeIds(db: DatabaseSync, rootId: string): string[] {
  const out: string[] = []
  const kids = db.prepare(`SELECT id FROM sessions WHERE parent_id = ? ORDER BY created_at`)
  const walk = (id: string): void => {
    out.push(id)
    for (const k of kids.all(id) as { id: string }[]) walk(k.id)
  }
  if (db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(rootId)) walk(rootId)
  return out
}

interface MoveCols {
  id: string
  moving_to: string | null
  moving_from: string | null
  moved_to: string | null
  move_id: string | null
}

function moveCols(db: DatabaseSync, id: string): MoveCols | null {
  return (db.prepare(`SELECT id, moving_to, moving_from, moved_to, move_id FROM sessions WHERE id = ?`).get(id) as MoveCols | undefined) ?? null
}

export function rowState(cols: MoveCols | null, id: string): SessionMoveRowState {
  if (!cols) return { id, state: 'absent' }
  if (cols.moved_to) return { id, state: 'tombstone', peer: cols.moved_to }
  if (cols.moving_from) return { id, state: 'provisional', peer: cols.moving_from, moveId: cols.move_id }
  if (cols.moving_to) return { id, state: 'exporting', peer: cols.moving_to, moveId: cols.move_id }
  return { id, state: 'live' }
}

/** The settle pass's view of this host: the asked ids, plus every row moving to or from `peer`. */
export function moveStatus(db: DatabaseSync, peer: string, ids: readonly string[]): SessionMoveRowState[] {
  const seen = new Map<string, SessionMoveRowState>()
  for (const id of ids) seen.set(id, rowState(moveCols(db, id), id))
  const rows = db
    .prepare(`SELECT id, moving_to, moving_from, moved_to, move_id FROM sessions WHERE moving_to = ? OR moving_from = ?`)
    .all(peer, peer) as unknown as MoveCols[]
  for (const r of rows) seen.set(r.id, rowState(r, r.id))
  return [...seen.values()]
}

/** Freeze (or thaw, `to` null) a subtree's rows for a move. */
export function setMovingTo(db: DatabaseSync, ids: readonly string[], to: string | null, moveId: string | null): void {
  const st = db.prepare(`UPDATE sessions SET moving_to = ?, move_id = ? WHERE id = ? AND moved_to IS NULL AND moving_from IS NULL`)
  for (const id of ids) st.run(to, moveId, id)
}

/** The live subtree rows frozen toward `peer` (the root's ids, by move id when given). */
export function frozenIds(db: DatabaseSync, opts: { moveId?: string; sessionId?: string }): string[] {
  if (opts.moveId)
    return (db.prepare(`SELECT id FROM sessions WHERE move_id = ? AND moving_to IS NOT NULL`).all(opts.moveId) as { id: string }[]).map((r) => r.id)
  if (opts.sessionId) return subtreeIds(db, opts.sessionId).filter((id) => moveCols(db, id)?.moving_to)
  return []
}

// ── the hash chain ──────────────────────────────────────────────────────

export function chainStart(moveId: string, rootId: string): string {
  return sha256(`tc-session-move-v1\0${moveId}\0${rootId}`)
}

/** The bytes a part stands for, independent of how its JSON is spelled. */
export function partDigest(part: SessionMovePart): string {
  const h = createHash('sha256')
  if (part.kind === 'events') {
    h.update(`E\0${part.sessionId}\0`)
    for (const r of part.rows) h.update(`${r.seq}\0${r.ts}\0${r.payload}\n`)
  } else {
    h.update(`F\0${part.file}\0${part.chunk}\0${part.chunks}\0`)
    h.update(Buffer.from(part.dataBase64, 'base64'))
  }
  return h.digest('hex')
}

export const chainNext = (prev: string, part: SessionMovePart): string => sha256(prev + partDigest(part))

/** What the commit compares: the chain's end, bound to the manifest's ids, row counts and files. */
export function finalDigest(chain: string, m: Pick<SessionMoveManifest, 'sessions' | 'events' | 'files' | 'moveId'>): string {
  const ids = m.sessions.map((s) => String(s.id)).join(',')
  const events = Object.keys(m.events)
    .sort()
    .map((k) => `${k}=${m.events[k]}`)
    .join(',')
  const files = m.files.map((f) => `${f.kind}|${f.sessionId}|${f.rel}|${f.size}|${f.sha256}`).join('\n')
  return sha256(`${chain}\0${m.moveId}\0${ids}\0${events}\0${files}`)
}

// ── export ──────────────────────────────────────────────────────────────

const EVENTS_UNION = `SELECT seq, ts, payload FROM main.events WHERE session_id = ?1
  UNION ALL
  SELECT c.seq, c.ts, c.payload FROM cold.events c WHERE c.session_id = ?1
    AND NOT EXISTS (SELECT 1 FROM main.events h WHERE h.session_id = ?1 AND h.seq = c.seq)`

type PlanEntry =
  | { kind: 'events'; sessionId: string; fromSeq: number; toSeq: number }
  | { kind: 'file'; file: number; chunk: number; chunks: number }

/** Files of one tree, relative paths, skipping symlinks. */
function walkFiles(root: string, base = root): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const full = join(root, e.name)
    if (e.isDirectory()) out.push(...walkFiles(full, base))
    else if (e.isFile()) out.push(full.slice(base.length + 1))
  }
  return out.sort()
}

function fileEntry(kind: SessionMoveFile['kind'], sessionId: string, rel: string, full: string): SessionMoveFile {
  const data = readFileSync(full)
  return { kind, sessionId, rel, size: data.length, sha256: sha256(data) }
}

/** Codex rollouts by native id: sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl. */
function findCodexRollouts(codexDir: string, ids: Set<string>): Map<string, string[]> {
  const found = new Map<string, string[]>()
  if (ids.size === 0) return found
  const root = join(codexDir, 'sessions')
  for (const rel of walkFiles(root)) {
    const name = rel.slice(rel.lastIndexOf(sep) + 1)
    const m = /^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/.exec(name)
    const id = m?.[1]
    if (id && ids.has(id)) found.set(id, [...(found.get(id) ?? []), rel])
  }
  return found
}

/** A Claude transcript's dir: under the cwd's slug, else whichever project dir holds it. */
function findClaudeDir(claudeDir: string, cwd: string, nativeId: string): string | null {
  const projects = join(claudeDir, 'projects')
  const first = join(projects, claudeSlug(cwd))
  if (existsSync(join(first, `${nativeId}.jsonl`))) return first
  let dirs: string[] = []
  try {
    dirs = readdirSync(projects)
  } catch {
    return null
  }
  for (const d of dirs) if (existsSync(join(projects, d, `${nativeId}.jsonl`))) return join(projects, d)
  return null
}

export function htmlDirOf(dataDir: string, sessionId: string): string {
  return join(dataDir, 'html-renders', sessionId)
}

const defaultGitDirty = (cwd: string): Promise<string[]> =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      resolve(
        String(stdout)
          .split('\n')
          .filter((l) => l.length > 3)
          .map((l) => l.slice(3))
      )
    })
  })

export class MoveExport {
  private next = 0
  private chain: string
  private last: SessionMoveFrame | null = null

  private constructor(
    private readonly host: MoveHost,
    readonly manifest: SessionMoveManifest,
    private readonly plan: PlanEntry[],
    /** Absolute source path per manifest file. */
    private readonly paths: string[]
  ) {
    this.chain = chainStart(manifest.moveId, manifest.rootId)
  }

  get ids(): string[] {
    return this.manifest.sessions.map((s) => String(s.id))
  }

  /** The bundle of a frozen subtree. The caller checked it is at rest. */
  static async build(host: MoveHost, rootId: string, moveId: string, to: string): Promise<MoveExport> {
    const db = host.db
    const ids = subtreeIds(db, rootId).filter((id) => {
      const s = rowState(moveCols(db, id), id).state
      return s === 'live' || s === 'exporting'
    })
    if (ids.length === 0) throw new Error(`unknown session: ${rootId}`)
    const rowOf = db.prepare(`SELECT * FROM sessions WHERE id = ?`)
    const sessions: Row[] = ids.map((id) => {
      const row = { ...(rowOf.get(id) as Row) }
      for (const c of MOVE_COLUMNS) delete row[c]
      return row
    })
    const root = sessions[0]
    const folds = ids.flatMap((id) => {
      const f = db.prepare(`SELECT * FROM session_folds WHERE session_id = ?`).get(id) as Row | undefined
      return f ? [{ ...f }] : []
    })
    const project = root.project_id
      ? ((db.prepare(`SELECT id, cwd, workspace_id AS workspaceId FROM projects WHERE id = ?`).get(root.project_id) as
          | { id: string; cwd: string; workspaceId: string }
          | undefined) ?? null)
      : null
    const wsId = project?.workspaceId ?? (root.workspace_id as string | null)
    const workspace = wsId
      ? ((db.prepare(`SELECT id, path, name FROM workspaces WHERE id = ?`).get(wsId) as { id: string; path: string; name: string } | undefined) ?? null)
      : null

    // Event rows: count, and seq ranges whose JSON stays under the part budget.
    const plan: PlanEntry[] = []
    const events: Record<string, number> = {}
    for (const id of ids) {
      let n = 0
      let from: number | null = null
      let to = 0
      let bytes = 0
      for (const r of db.prepare(`SELECT seq, payload FROM (${EVENTS_UNION}) ORDER BY seq`).iterate(id) as Iterable<{ seq: number; payload: string }>) {
        const size = JSON.stringify(r.payload).length + 48
        if (from !== null && bytes + size > SESSION_MOVE_PART_BYTES) {
          plan.push({ kind: 'events', sessionId: id, fromSeq: from, toSeq: to })
          from = null
          bytes = 0
        }
        if (from === null) from = r.seq
        to = r.seq
        bytes += size
        n++
      }
      if (from !== null) plan.push({ kind: 'events', sessionId: id, fromSeq: from, toSeq: to })
      events[id] = n
    }

    // Files: agent pages, then the harness transcripts.
    const files: SessionMoveFile[] = []
    const paths: string[] = []
    const add = (kind: SessionMoveFile['kind'], sessionId: string, rel: string, full: string): void => {
      files.push(fileEntry(kind, sessionId, rel, full))
      paths.push(full)
    }
    for (const id of ids) {
      const dir = htmlDirOf(host.dataDir, id)
      for (const rel of walkFiles(dir)) add('html', id, rel, join(dir, rel))
    }
    const transcriptMissing: string[] = []
    const codexIds = new Set(sessions.filter((s) => s.provider === 'codex' && s.native_id).map((s) => String(s.native_id)))
    const rollouts = findCodexRollouts(host.codexDir(), codexIds)
    for (const s of sessions) {
      const id = String(s.id)
      const nativeId = s.native_id ? String(s.native_id) : null
      if (!nativeId) continue
      if (s.provider === 'claude') {
        const dir = findClaudeDir(host.claudeDir(), String(s.cwd), nativeId)
        if (!dir) {
          transcriptMissing.push(id)
          continue
        }
        add('claude', id, `${nativeId}.jsonl`, join(dir, `${nativeId}.jsonl`))
        for (const rel of walkFiles(join(dir, nativeId))) add('claude', id, join(nativeId, rel), join(dir, nativeId, rel))
      } else if (s.provider === 'codex') {
        const found = rollouts.get(nativeId)
        if (!found?.length) {
          transcriptMissing.push(id)
          continue
        }
        for (const rel of found) add('codex', id, rel, join(host.codexDir(), 'sessions', rel))
      } else {
        // Harnesses whose session store this app does not know: the dialogue replays on the destination.
        transcriptMissing.push(id)
      }
    }
    files.forEach((f, i) => {
      const chunks = Math.max(1, Math.ceil(f.size / SESSION_MOVE_FILE_CHUNK))
      for (let c = 0; c < chunks; c++) plan.push({ kind: 'file', file: i, chunk: c, chunks })
    })

    const dirtyAll = await (host.gitDirty ?? defaultGitDirty)(String(root.cwd)).catch(() => [] as string[])
    const checkpoints = ids.some((id) => existsSync(join(host.dataDir, 'checkpoints', id)))
    const manifest: SessionMoveManifest = {
      moveId,
      from: host.environmentId,
      to,
      home: host.home(),
      workRoot: host.workRoot(),
      rootId,
      sessions,
      folds,
      project,
      workspace,
      events,
      files,
      transcriptMissing,
      parts: plan.length,
      dirty: dirtyAll.slice(0, DIRTY_CAP),
      dirtyMore: Math.max(0, dirtyAll.length - DIRTY_CAP),
      checkpoints
    }
    return new MoveExport(host, manifest, plan, paths)
  }

  /** Part `index`, in order; the last one again on a retry. */
  part(index: number): SessionMoveFrame {
    if (this.last && index === this.next - 1) return this.last
    if (index !== this.next) throw new Error(`session.export.part: expected part ${this.next}, asked ${index}`)
    const entry = this.plan[index]
    if (!entry) throw new Error(`session.export.part: no part ${index}`)
    let part: SessionMovePart
    if (entry.kind === 'events') {
      const rows = this.host.db
        .prepare(`SELECT seq, ts, payload FROM (${EVENTS_UNION}) WHERE seq BETWEEN ?2 AND ?3 ORDER BY seq`)
        .all(entry.sessionId, entry.fromSeq, entry.toSeq) as { seq: number; ts: number; payload: string }[]
      part = { kind: 'events', sessionId: entry.sessionId, rows: rows.map((r) => ({ seq: r.seq, ts: r.ts, payload: r.payload })) }
    } else {
      const path = this.paths[entry.file]
      const size = this.manifest.files[entry.file].size
      const start = entry.chunk * SESSION_MOVE_FILE_CHUNK
      const len = Math.max(0, Math.min(SESSION_MOVE_FILE_CHUNK, size - start))
      const buf = Buffer.alloc(len)
      const fd = openSync(path, 'r')
      try {
        let got = 0
        while (got < len) {
          const n = readSync(fd, buf, got, len - got, start + got)
          if (n === 0) break
          got += n
        }
      } finally {
        closeSync(fd)
      }
      part = { kind: 'file', file: entry.file, chunk: entry.chunk, chunks: entry.chunks, dataBase64: buf.toString('base64') }
    }
    this.chain = chainNext(this.chain, part)
    this.next++
    this.last = { moveId: this.manifest.moveId, index, sha: this.chain, part }
    return this.last
  }

  get done(): boolean {
    return this.next >= this.plan.length
  }

  digest(): string {
    if (!this.done) throw new Error('session move: not every part was sent')
    return finalDigest(this.chain, this.manifest)
  }
}

// ── path remap on landing ───────────────────────────────────────────────

/**
 * Where a sender's path lands here. Every rule that covers it is a
 * candidate, longest source first: the path map's roots and prefixes in
 * either direction (it is written Mac → box), the sender's work root and
 * IdeaProjects / Desktop/Websites against this host's, and the sender's home
 * against this one. The first candidate that exists wins; with no rule at
 * all the path stays as it is.
 */
export function landingCandidates(
  path: string,
  ctx: { map: HistoryMapping; senderHome: string; senderWork: string; home: string; work: string }
): string[] {
  if (!isAbsolute(path)) return [path]
  const p = stripSlash(path)
  const rules: [string, string][] = []
  const add = (from: string, to: string): void => {
    const f = stripSlash(from)
    const t = stripSlash(to)
    if (f !== t && f !== '/') rules.push([f, t])
  }
  for (const [f, t] of Object.entries(ctx.map.roots)) {
    add(f, t)
    add(t, f)
  }
  const sHome = stripSlash(ctx.senderHome)
  const sWork = stripSlash(ctx.senderWork)
  const home = stripSlash(ctx.home)
  const work = stripSlash(ctx.work)
  const homeWorkDirs = (h: string): string[] => [`${h}/IdeaProjects`, `${h}/Desktop/Websites`]
  if (work !== home) for (const d of homeWorkDirs(sHome)) add(d, work)
  if (sWork !== sHome) {
    if (work !== home) add(sWork, work)
    else for (const d of homeWorkDirs(home)) add(sWork, d)
  }
  for (const [f, t] of Object.entries(ctx.map.prefixes)) {
    add(f, t)
    add(t, f)
  }
  add(sHome, home)
  const under = (from: string): boolean => p === from || p.startsWith(from + '/')
  const matching = rules
    .map((r, order) => ({ r, order }))
    .filter(({ r }) => under(r[0]))
    .sort((a, b) => b.r[0].length - a.r[0].length || a.order - b.order)
  if (matching.length === 0) return [p]
  const out: string[] = []
  for (const { r } of matching) {
    const c = normalize(r[1] + p.slice(r[0].length))
    if (!out.includes(c)) out.push(c)
  }
  return out
}

// ── import ──────────────────────────────────────────────────────────────

export class MoveRefused extends Error {}

interface Landing {
  manifest: SessionMoveManifest
  ids: string[]
  chain: string
  next: number
  received: Map<string, number>
  chunks: Map<number, Set<number>>
  staging: string
  /** Where each file lands here, by manifest index. */
  targets: string[]
  answer: SessionImportBeginAnswer
}

const tableColumns = (db: DatabaseSync, table: string): Set<string> =>
  new Set((db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[]).map((r) => r.name))

const safeRel = (rel: string): boolean => !isAbsolute(rel) && !normalize(rel).split(/[\\/]/).includes('..') && normalize(rel) !== '.'

export class MoveImports {
  private readonly landings = new Map<string, Landing>()
  constructor(private readonly host: MoveHost) {}

  private exists(path: string): boolean {
    return (this.host.exists ?? existsSync)(path)
  }

  private stagingDir(moveId: string): string {
    return join(this.host.dataDir, 'session-move', moveId.replace(/[^A-Za-z0-9_-]/g, '_'))
  }

  /** Check, remap and resolve; land the rows hidden. Throws MoveRefused with the reason. */
  begin(manifest: SessionMoveManifest): SessionImportBeginAnswer {
    const db = this.host.db
    if (manifest.to !== this.host.environmentId) throw new MoveRefused(`this host is ${this.host.environmentId}, not ${manifest.to}`)
    const ids = manifest.sessions.map((s) => String(s.id))
    if (String(manifest.sessions[0].id) !== manifest.rootId) throw new MoveRefused('the manifest does not start with its root')
    // Ids name directories here (html-renders/<id>): the alphabet session.create allows, nothing else.
    for (const id of ids) if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new MoveRefused(`bad session id ${JSON.stringify(id)}`)
    for (const id of ids) {
      const state = rowState(moveCols(db, id), id)
      if (state.state === 'live' || state.state === 'exporting') throw new MoveRefused('the thread is already on this host')
    }
    for (const f of manifest.files) if (!safeRel(f.rel) || !ids.includes(f.sessionId)) throw new MoveRefused(`bad file entry ${JSON.stringify(f.rel)}`)

    const ctx = {
      map: this.host.pathMap(),
      senderHome: manifest.home,
      senderWork: manifest.workRoot,
      home: this.host.home(),
      work: this.host.workRoot()
    }
    const land = (path: string): string => {
      const c = landingCandidates(path, ctx)
      return c.find((x) => this.exists(x)) ?? c[0]
    }
    const root = manifest.sessions[0]
    const rootCwd = land(String(root.cwd))
    if (!this.exists(rootCwd)) throw new MoveRefused(`${rootCwd} does not exist on this host`)

    // The workspace: the one at the remapped workspace path, else the deepest one holding the cwd.
    const workspaces = db.prepare(`SELECT id, path FROM workspaces`).all() as { id: string; path: string }[]
    const byPath = new Map(workspaces.map((w) => [stripSlash(w.path), w.id]))
    let workspaceId: string | null = null
    if (manifest.workspace) {
      for (const c of landingCandidates(manifest.workspace.path, ctx)) {
        const hit = byPath.get(stripSlash(c))
        if (hit) {
          workspaceId = hit
          break
        }
      }
    }
    if (!workspaceId) {
      const holding = workspaces
        .filter((w) => rootCwd === stripSlash(w.path) || rootCwd.startsWith(stripSlash(w.path) + '/'))
        .sort((a, b) => b.path.length - a.path.length)
      workspaceId = holding[0]?.id ?? null
    }
    if (!workspaceId) throw new MoveRefused(`no workspace on this host holds ${rootCwd}; add the workspace here first`)

    const projects = db.prepare(`SELECT id, cwd FROM projects WHERE workspace_id = ?`).all(workspaceId) as { id: string; cwd: string }[]
    const projectAt = (cwd: string): string | null => projects.find((p) => stripSlash(p.cwd) === stripSlash(cwd))?.id ?? null
    const rootProject = manifest.project ? projectAt(land(manifest.project.cwd)) ?? projectAt(rootCwd) : projectAt(rootCwd)

    const missing = new Set(manifest.transcriptMissing)
    const cols = tableColumns(db, 'sessions')
    const foldCols = tableColumns(db, 'session_folds')
    const landed = new Map<string, string>()
    const rows: Row[] = manifest.sessions.map((s) => {
      const id = String(s.id)
      const cwd = id === manifest.rootId ? rootCwd : land(String(s.cwd))
      landed.set(id, cwd)
      const plan = typeof s.plan_path === 'string' && isAbsolute(s.plan_path) ? land(s.plan_path) : s.plan_path
      const project =
        id === manifest.rootId
          ? rootProject
          : s.project_id && manifest.project && s.project_id === manifest.project.id
            ? rootProject
            : projectAt(cwd)
      return {
        ...s,
        cwd,
        plan_path: plan ?? null,
        project_id: project,
        workspace_id: workspaceId,
        native_id: missing.has(id) ? null : (s.native_id ?? null),
        cold: 0,
        busy_since: null,
        moving_to: null,
        moved_to: null,
        moving_from: manifest.from,
        move_id: manifest.moveId
      }
    })

    // Where the files land: pages under this host's html-renders, transcripts under the remapped cwd's slug.
    const nativeOf = new Map(manifest.sessions.map((s) => [String(s.id), s.native_id ? String(s.native_id) : null]))
    const targets = manifest.files.map((f) => {
      if (f.kind === 'html') return join(htmlDirOf(this.host.dataDir, f.sessionId), f.rel)
      if (f.kind === 'codex') return join(this.host.codexDir(), 'sessions', f.rel)
      const native = nativeOf.get(f.sessionId)
      if (!native || !(f.rel === `${native}.jsonl` || f.rel.startsWith(`${native}/`))) throw new MoveRefused(`bad transcript entry ${JSON.stringify(f.rel)}`)
      return join(this.host.claudeDir(), 'projects', claudeSlug(landed.get(f.sessionId)!), f.rel)
    })

    // A stale landing of an earlier attempt, or the tombstone this host kept when the thread left: replaced.
    const prior = this.landings.get(manifest.moveId)
    if (prior) this.discard(prior)
    db.exec('BEGIN')
    try {
      dropRows(db, ids)
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => cols.has(k))
        db.prepare(`INSERT INTO sessions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k] ?? null))
      }
      for (const f of manifest.folds) {
        if (!ids.includes(String(f.session_id))) continue
        const keys = Object.keys(f).filter((k) => foldCols.has(k))
        db.prepare(`INSERT OR REPLACE INTO session_folds (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => f[k] ?? null))
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    this.host.forget?.(ids)
    const staging = this.stagingDir(manifest.moveId)
    rmSync(staging, { recursive: true, force: true })
    const answer = { cwd: rootCwd, workspaceId, projectId: rootProject }
    this.landings.set(manifest.moveId, {
      manifest,
      ids,
      chain: chainStart(manifest.moveId, manifest.rootId),
      next: 0,
      received: new Map(),
      chunks: new Map(),
      staging,
      targets,
      answer
    })
    return answer
  }

  private landing(moveId: string): Landing {
    const l = this.landings.get(moveId)
    if (!l) throw new Error(`no move ${moveId} in progress here`)
    return l
  }

  part(frame: SessionMoveFrame): { index: number } {
    const l = this.landing(frame.moveId)
    if (frame.index === l.next - 1) return { index: frame.index } // a retry of the last one
    if (frame.index !== l.next) throw new Error(`session.import.part: expected part ${l.next}, got ${frame.index}`)
    const chain = chainNext(l.chain, frame.part)
    if (chain !== frame.sha) throw new Error(`session.import.part: part ${frame.index} does not match its digest`)
    const part = frame.part
    if (part.kind === 'events') {
      if (!l.ids.includes(part.sessionId)) throw new Error('session.import.part: rows of a session outside the move')
      const db = this.host.db
      const insert = db.prepare(`INSERT OR REPLACE INTO main.events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)`)
      db.exec('BEGIN')
      try {
        for (const r of part.rows) insert.run(part.sessionId, r.seq, r.ts, r.payload)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      l.received.set(part.sessionId, (l.received.get(part.sessionId) ?? 0) + part.rows.length)
    } else {
      const f = l.manifest.files[part.file]
      if (!f) throw new Error('session.import.part: no such file')
      const expected = Math.max(1, Math.ceil(f.size / SESSION_MOVE_FILE_CHUNK))
      if (part.chunks !== expected || part.chunk >= expected) throw new Error('session.import.part: chunk out of range')
      const dir = join(l.staging, String(part.file))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, String(part.chunk)), Buffer.from(part.dataBase64, 'base64'), { mode: 0o600 })
      const got = l.chunks.get(part.file) ?? new Set<number>()
      got.add(part.chunk)
      l.chunks.set(part.file, got)
    }
    l.chain = chain
    l.next++
    return { index: frame.index }
  }

  /** Everything arrived and matches: the files go into place and the digest comes back. The rows stay hidden until release.
   *  `digest` null (a pull: the source compares on its own commit) skips the comparison here. */
  commit(moveId: string, digest: string | null): { digest: string } {
    const l = this.landing(moveId)
    const m = l.manifest
    if (l.next !== m.parts) throw new Error(`session.import.commit: ${l.next} of ${m.parts} parts arrived`)
    const mine = finalDigest(l.chain, m)
    if (digest !== null && mine !== digest) throw new Error('session.import.commit: the digest does not match')
    const count = this.host.db.prepare(`SELECT count(*) AS n FROM main.events WHERE session_id = ?`)
    for (const id of l.ids) {
      const have = (count.get(id) as { n: number }).n
      if (have !== (m.events[id] ?? 0)) throw new Error(`session.import.commit: ${have} of ${m.events[id] ?? 0} rows of ${id}`)
    }
    // Every file whole and matching before any is put in place.
    const ready: Buffer[] = m.files.map((f, i) => {
      const chunks = Math.max(1, Math.ceil(f.size / SESSION_MOVE_FILE_CHUNK))
      if ((l.chunks.get(i)?.size ?? 0) !== chunks) throw new Error(`session.import.commit: ${f.rel} is incomplete`)
      const data = Buffer.concat(Array.from({ length: chunks }, (_, c) => readFileSync(join(l.staging, String(i), String(c)))))
      if (data.length !== f.size || sha256(data) !== f.sha256) throw new Error(`session.import.commit: ${f.rel} does not match its hash`)
      return data
    })
    for (const id of l.ids) rmSync(htmlDirOf(this.host.dataDir, id), { recursive: true, force: true })
    ready.forEach((data, i) => {
      const target = l.targets[i]
      mkdirSync(dirname(target), { recursive: true })
      const tmp = `${target}.tc-move-${process.pid}`
      writeFileSync(tmp, data)
      renameSync(tmp, target)
    })
    rmSync(l.staging, { recursive: true, force: true })
    this.landings.delete(moveId)
    return { digest: mine }
  }

  private discard(l: Landing): void {
    rmSync(l.staging, { recursive: true, force: true })
    this.landings.delete(l.manifest.moveId)
  }

  /** Forget a landing in memory (the rows are dropped by dropLanding). */
  forget(moveId: string): void {
    const l = this.landings.get(moveId)
    if (l) this.discard(l)
  }

  get active(): string[] {
    return [...this.landings.keys()]
  }
}

/** Delete these rows and everything keyed by them (events, folds). */
function dropRows(db: DatabaseSync, ids: readonly string[]): void {
  for (const id of ids) {
    db.prepare(`DELETE FROM main.events WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM cold.events WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM session_folds WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
  }
}

/** The hidden landing of a subtree (by its root, or by move id): rows, events, folds and pages go. Returns the ids dropped. */
export function dropLanding(host: MoveHost, opts: { sessionId?: string; moveId?: string }): string[] {
  const db = host.db
  let ids: string[] = []
  if (opts.moveId) ids = (db.prepare(`SELECT id FROM sessions WHERE move_id = ? AND moving_from IS NOT NULL`).all(opts.moveId) as { id: string }[]).map((r) => r.id)
  else if (opts.sessionId) ids = subtreeIds(db, opts.sessionId).filter((id) => moveCols(db, id)?.moving_from)
  if (ids.length === 0) return []
  db.exec('BEGIN')
  try {
    dropRows(db, ids)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  for (const id of ids) rmSync(htmlDirOf(host.dataDir, id), { recursive: true, force: true })
  host.forget?.(ids)
  return ids
}

/** The landing becomes the thread. Returns the ids claimed. */
export function claimLanding(host: MoveHost, opts: { sessionId?: string; moveId?: string }): string[] {
  const db = host.db
  let ids: string[] = []
  if (opts.moveId) ids = (db.prepare(`SELECT id FROM sessions WHERE move_id = ? AND moving_from IS NOT NULL`).all(opts.moveId) as { id: string }[]).map((r) => r.id)
  if (ids.length === 0 && opts.sessionId) ids = subtreeIds(db, opts.sessionId).filter((id) => moveCols(db, id)?.moving_from)
  const st = db.prepare(`UPDATE sessions SET moving_from = NULL, move_id = NULL WHERE id = ?`)
  for (const id of ids) st.run(id)
  host.forget?.(ids)
  return ids
}

/** The source's side of a finished move: rows kept as a tombstone pointing at `to`; events, folds and pages gone. */
export function tombstone(host: MoveHost, ids: readonly string[], to: string): void {
  const db = host.db
  db.exec('BEGIN')
  try {
    const st = db.prepare(`UPDATE sessions SET moved_to = ?, moving_to = NULL, move_id = NULL, archived = 1, cold = 0, busy_since = NULL WHERE id = ?`)
    for (const id of ids) {
      st.run(to, id)
      db.prepare(`DELETE FROM main.events WHERE session_id = ?`).run(id)
      db.prepare(`DELETE FROM cold.events WHERE session_id = ?`).run(id)
      db.prepare(`DELETE FROM session_folds WHERE session_id = ?`).run(id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  for (const id of ids) rmSync(htmlDirOf(host.dataDir, id), { recursive: true, force: true })
  host.forget?.(ids)
}

/** The ids of a landing in progress or held, by move id. */
export function landingIds(db: DatabaseSync, moveId: string): string[] {
  return (db.prepare(`SELECT id FROM sessions WHERE move_id = ? AND moving_from IS NOT NULL`).all(moveId) as { id: string }[]).map((r) => r.id)
}
