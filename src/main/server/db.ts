import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { ensureNotesTable } from './notes'
import {
  WorkspaceSnapshotSchema,
  type SessionSearchHit,
  type SessionSearchResult,
  type WorkspaceSnapshot
} from '@shared/contract-m3a'
import { mkdirSync } from 'node:fs'
import { timed } from './stalls'
import { dirname } from 'node:path'
import type { AgentEvent, EventRow, SessionMeta, SessionStatus } from '@shared/events'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import { ACCOUNT_PROVIDERS, type AccountPins } from '@shared/accounts'
import { parseThreadRules } from '@shared/rules'
import { resolveModel, type ProviderId } from '@shared/catalog'

/**
 * node:sqlite, zero native deps (no electron-rebuild pain).
 * Two tables: sessions (the tree) and events (append-only log, the
 * source of truth the transcript is rendered from — T3-style).
 */

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // WAL keeps the file consistent at NORMAL; only the last commits before
  // a power cut can be lost. FULL fsynced the WAL on every one of the two
  // autocommits each streamed event makes, and a build writing beside it
  // stretched single commits to 45-150 ms on the loop the sidebar's open
  // round trips wait on.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      parent_id  TEXT,
      provider   TEXT NOT NULL,
      model      TEXT NOT NULL,
      reasoning  TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      title      TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      status     TEXT NOT NULL,
      archived   INTEGER NOT NULL DEFAULT 0,
      permission TEXT NOT NULL DEFAULT 'edits',
      native_id  TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      ts         INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL,
      git        INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      mode         TEXT NOT NULL,
      branch       TEXT,
      cwd          TEXT NOT NULL,
      archived     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_folds (
      session_id    TEXT PRIMARY KEY,
      folded_seq    INTEGER NOT NULL,
      fold_version  INTEGER NOT NULL,
      tasks_done    INTEGER,
      tasks_total   INTEGER,
      tasks_current TEXT,
      goal          TEXT,
      can_continue  INTEGER NOT NULL DEFAULT 0
    );
  `)
  // Migrations for databases created before these columns existed.
  for (const stmt of [
    `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN permission TEXT NOT NULL DEFAULT 'edits'`,
    `ALTER TABLE sessions ADD COLUMN project_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN workspace_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN thread_type TEXT`,
    `ALTER TABLE sessions ADD COLUMN plan_path TEXT`,
    `ALTER TABLE sessions ADD COLUMN fast INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN context_1m INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN busy_since INTEGER`,
    `ALTER TABLE sessions ADD COLUMN paused_at INTEGER`,
    `ALTER TABLE sessions ADD COLUMN frozen_active_elapsed INTEGER`,
    `ALTER TABLE sessions ADD COLUMN retyped INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN thread_rules TEXT`,
    `ALTER TABLE sessions ADD COLUMN context_tokens INTEGER`,
    `ALTER TABLE sessions ADD COLUMN context_window INTEGER`,
    `ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN account_pin TEXT`,
    `ALTER TABLE sessions ADD COLUMN account_current TEXT`,
    `ALTER TABLE projects ADD COLUMN account_pins TEXT`,
    `ALTER TABLE workspaces ADD COLUMN account_pins TEXT`
  ]) {
    try {
      db.exec(stmt)
    } catch {
      // column already exists
    }
  }
  ensureNotesTable(db)
  // The model-written tool summaries were removed on 2026-09-14; their
  // permanent cache rows would otherwise sit in the settings table forever.
  db.exec(`DELETE FROM settings WHERE key LIKE 'toolsum:%'`)
  repairModelIds(db)
  return db
}

/** Rows that hold a display slug for a model (`fable-5.1`, written by a
 *  renderer bug before v180) instead of the catalog id: Continue respawns
 *  the driver from the row, so it launched `--model fable-5.1[1m]` until
 *  the row was rewritten. Same normalization as resolveModel. */
function repairModelIds(db: DatabaseSync): void {
  const rows = db
    .prepare(`SELECT id, provider, model FROM sessions WHERE archived = 0`)
    .all() as unknown as { id: string; provider: ProviderId; model: string }[]
  const update = db.prepare(`UPDATE sessions SET model = ? WHERE id = ?`)
  for (const r of rows) {
    const fixed = resolveModel(r.provider, r.model)
    if (fixed.provider !== r.provider || fixed.model === r.model) continue
    update.run(fixed.model, r.id)
    console.log(`[db] session ${r.id}: model ${r.model} -> ${fixed.model}`)
  }
}

/**
 * Bump when foldTodo, foldGoal or foldContinuableError changes meaning:
 * every session_folds row falls behind at once and the boot sweep
 * recomputes them. A persisted fold is otherwise sticky.
 */
export const FOLD_VERSION = 1

/** The derived outputs of a session's log — what the sidebar shows — so
 *  list() never reads events. `foldedSeq` is the highest event folded in;
 *  a row behind MAX(seq) or FOLD_VERSION is stale and gets re-swept. A
 *  missing row means "never folded"; `tasks: null` means "no task list". */
export interface FoldRow {
  sessionId: string
  foldedSeq: number
  foldVersion: number
  tasks: { done: number; total: number; current: string | null } | null
  goal: NonNullable<SessionMeta['goal']> | null
  canContinue: boolean
}

interface FoldRowRaw {
  session_id: string
  folded_seq: number
  fold_version: number
  tasks_done: number | null
  tasks_total: number | null
  tasks_current: string | null
  goal: string | null
  can_continue: number
}

function toFold(r: FoldRowRaw): FoldRow {
  return {
    sessionId: r.session_id,
    foldedSeq: r.folded_seq,
    foldVersion: r.fold_version,
    tasks:
      r.tasks_done === null || r.tasks_total === null
        ? null
        : { done: r.tasks_done, total: r.tasks_total, current: r.tasks_current },
    goal: r.goal ? (JSON.parse(r.goal) as FoldRow['goal']) : null,
    canContinue: !!r.can_continue
  }
}

interface SessionRowRaw {
  id: string
  parent_id: string | null
  project_id: string | null
  workspace_id: string | null
  thread_type: string | null
  plan_path: string | null
  provider: string
  model: string
  reasoning: string
  agent_type: string
  title: string
  cwd: string
  status: string
  pinned: number
  archived: number
  permission: string
  fast: number
  context_1m: number
  busy_since: number | null
  paused_at: number | null
  frozen_active_elapsed: number | null
  thread_rules: string | null
  context_tokens: number | null
  context_window: number | null
  native_id: string | null
  /** Unused since the thread pin went; the column stays (master only adds). */
  account_pin: string | null
  account_current: string | null
  created_at: number
  updated_at: number
}

/** The per-provider account pins a project or workspace row stores as JSON. */
function parseAccountPins(raw: string | null): AccountPins {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: AccountPins = {}
    for (const p of ACCOUNT_PROVIDERS) if (typeof parsed[p] === 'string' && parsed[p]) out[p] = parsed[p] as string
    return out
  } catch {
    return {}
  }
}

const serializeAccountPins = (pins: AccountPins): string | null => {
  const kept = Object.fromEntries(Object.entries(pins).filter(([, v]) => typeof v === 'string' && v))
  return Object.keys(kept).length === 0 ? null : JSON.stringify(kept)
}

function toMeta(r: SessionRowRaw): SessionMeta {
  return {
    id: r.id,
    parentId: r.parent_id,
    projectId: r.project_id,
    workspaceId: r.workspace_id,
    threadType: r.thread_type as SessionMeta['threadType'],
    planPath: r.plan_path,
    provider: r.provider as SessionMeta['provider'],
    model: r.model,
    reasoning: r.reasoning as SessionMeta['reasoning'],
    agentType: r.agent_type as SessionMeta['agentType'],
    title: r.title,
    cwd: r.cwd,
    status: r.status as SessionStatus,
    pinned: !!r.pinned,
    archived: !!r.archived,
    fast: !!r.fast,
    context1m: !!r.context_1m,
    busySince: r.busy_since,
    pausedAt: r.paused_at,
    frozenActiveElapsed: r.frozen_active_elapsed,
    threadRules: parseThreadRules(r.thread_rules),
    context: r.context_tokens == null ? null : { tokens: r.context_tokens, window: r.context_window },
    permission: r.permission as SessionMeta['permission'],
    nativeId: r.native_id,
    account: r.account_current,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const SEARCH_CAP = 200

/** How many events a tail walks back over at most, whatever the budget. */
const TAIL_SCAN = 6000

/** First seq of a `budget`-row tail over `scan` (newest first): the row
 *  of the newest `budget` blocks, so the tail begins on a boundary.
 *  Null when the scan holds fewer rows than the budget (send the range
 *  whole); the oldest scanned seq when the scan cap hit first. */
export function tailStart(
  scan: { seq: number; type: string; callId: string | null; msgId: string | null; blockIndex: number | null }[],
  budget: number
): number | null {
  const seen = new Set<string>()
  let rows = 0
  // The lowest seq of the newest `budget` blocks so far: the cut lands on
  // it, so a turn's trailing bookkeeping rows stay with their turn.
  let boundary: number | null = null
  for (const r of scan) {
    const key =
      r.callId != null
        ? `c:${r.callId}`
        : r.msgId != null
          ? `m:${r.msgId}:${r.blockIndex ?? ''}`
          : r.type === 'user-text' || r.type === 'assistant-text' || r.type === 'thinking'
            ? `s:${r.seq}`
            : null
    if (!key) continue
    if (!seen.has(key)) {
      seen.add(key)
      rows++
      if (rows > budget) return boundary ?? r.seq
    }
    boundary = r.seq
  }
  return scan.length === TAIL_SCAN ? scan[scan.length - 1].seq : null
}

export class Store {
  constructor(private db: DatabaseSync) {}

  /** Statements are prepared once per SQL string: preparing dominated a
   *  boot profile where getSession() ran once per session per list(). */
  private stmts = new Map<string, StatementSync>()

  /** Bumped by every sessions-table write; the registry's index cache keys on it. */
  sessionsVersion = 0
  private stmt(sql: string): StatementSync {
    let st = this.stmts.get(sql)
    if (!st) {
      st = this.db.prepare(sql)
      this.stmts.set(sql, st)
    }
    return st
  }

  /** One snapshot per window slot. The first window keeps the pre-M12 key
   *  so an upgrade restores what it had; every other slot gets its own. */
  private snapshotKey(window?: string): string {
    const base = 'renderer.workspaceSnapshot.v1'
    return window && window !== 'main' ? `${base}:${window}` : base
  }

  getWorkspaceSnapshot(window?: string): WorkspaceSnapshot | null {
    const raw = this.getSetting(this.snapshotKey(window))
    return raw === null ? null : WorkspaceSnapshotSchema.parse(JSON.parse(raw))
  }

  setWorkspaceSnapshot(snapshot: unknown, window?: string): void {
    const valid = WorkspaceSnapshotSchema.parse(snapshot)
    const json = JSON.stringify(valid)
    if (Buffer.byteLength(json, 'utf8') > 2_000_000) throw new Error('workspace snapshot is too large')
    this.setSetting(this.snapshotKey(window), json)
  }

  dropWorkspaceSnapshot(window: string): void {
    this.setSetting(this.snapshotKey(window), null)
  }

  setSessionWorkspace(id: string, workspaceId: string): void {
    this.stmt('UPDATE sessions SET workspace_id = ? WHERE id = ?').run(workspaceId, id)
    this.sessionsVersion += 1
  }

  insertSession(meta: SessionMeta): void {
    this.sessionsVersion += 1
    this
      .stmt(
        `INSERT INTO sessions (id, parent_id, project_id, workspace_id, thread_type, plan_path, provider, model, reasoning, agent_type, title, cwd, status, archived, pinned, permission, fast, context_1m, busy_since, paused_at, frozen_active_elapsed, thread_rules, native_id, account_current, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        meta.id,
        meta.parentId,
        meta.projectId,
        meta.workspaceId,
        meta.threadType,
        meta.planPath,
        meta.provider,
        meta.model,
        meta.reasoning,
        meta.agentType,
        meta.title,
        meta.cwd,
        meta.status,
        meta.archived ? 1 : 0,
        meta.pinned ? 1 : 0,
        meta.permission,
        meta.fast ? 1 : 0,
        meta.context1m ? 1 : 0,
        meta.busySince,
        meta.pausedAt,
        meta.frozenActiveElapsed,
        meta.threadRules ? JSON.stringify(meta.threadRules) : null,
        meta.nativeId,
        meta.account ?? null,
        meta.createdAt,
        meta.updatedAt
      )
  }

  updateSession(
    id: string,
    patch: Partial<
      Pick<
        SessionMeta,
        | 'status'
        | 'title'
        | 'nativeId'
        | 'archived'
        | 'pinned'
        | 'provider'
        | 'model'
        | 'reasoning'
        | 'permission'
        | 'fast'
        | 'context1m'
        | 'busySince'
        | 'pausedAt'
        | 'frozenActiveElapsed'
        | 'threadType'
        | 'planPath'
        | 'agentType'
        | 'threadRules'
        | 'account'
      >
    >
  ): SessionMeta | null {
    const cur = this.getSession(id)
    if (!cur) return null
    // A key present but undefined must not clear the stored value — the
    // tune route sends { fast, context1m } with only one of them set, and
    // `undefined ? 1 : 0` below would zero the other.
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    const next = { ...cur, ...defined, updatedAt: Date.now() }
    this.sessionsVersion += 1
    this
      .stmt(
        `UPDATE sessions SET status = ?, title = ?, native_id = ?, archived = ?, pinned = ?, provider = ?, model = ?, reasoning = ?, permission = ?, fast = ?, context_1m = ?, busy_since = ?, paused_at = ?, frozen_active_elapsed = ?, thread_type = ?, plan_path = ?, agent_type = ?, thread_rules = ?, account_current = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.status,
        next.title,
        next.nativeId,
        next.archived ? 1 : 0,
        next.pinned ? 1 : 0,
        next.provider,
        next.model,
        next.reasoning,
        next.permission,
        next.fast ? 1 : 0,
        next.context1m ? 1 : 0,
        next.busySince,
        next.pausedAt,
        next.frozenActiveElapsed,
        next.threadType,
        next.planPath,
        next.agentType,
        next.threadRules ? JSON.stringify(next.threadRules) : null,
        next.account ?? null,
        next.updatedAt,
        id
      )
    return next
  }

  /** The account a thread spends from now, as the gateway reports it. Not
   *  an edit: updated_at stays put so the list keeps its order. */
  setSessionAccount(id: string, account: string | null): SessionMeta | null {
    this.stmt(`UPDATE sessions SET account_current = ? WHERE id = ?`).run(account, id)
    this.sessionsVersion += 1
    return this.getSession(id)
  }

  /** The last context reading off the harness stream, kept so a relaunch
   *  shows the real level instead of whatever the log's last compaction
   *  left. Its own statement: a reading is not an edit, so updated_at
   *  stays put and the list keeps its order. */
  setSessionContext(id: string, context: { tokens: number; window: number | null } | null): void {
    this.sessionsVersion += 1
    this.stmt(`UPDATE sessions SET context_tokens = ?, context_window = ? WHERE id = ?`).run(
      context?.tokens ?? null,
      context?.window ?? null,
      id
    )
  }

  /** Thread type changed mid-conversation; the next send re-instructs.
   *  Server-only state — never part of SessionMeta. */
  getRetyped(id: string): boolean {
    const r = this.stmt(`SELECT retyped FROM sessions WHERE id = ?`).get(id) as
      { retyped: number } | undefined
    return !!r?.retyped
  }

  setRetyped(id: string, on: boolean): void {
    this.stmt(`UPDATE sessions SET retyped = ? WHERE id = ?`).run(on ? 1 : 0, id)
    this.sessionsVersion += 1
  }

  /** Delete a session and all of its descendants (log included). */
  deleteSessionTree(id: string): string[] {
    const ids: string[] = []
    const collect = (cur: string): void => {
      ids.push(cur)
      const kids = this
        .stmt(`SELECT id FROM sessions WHERE parent_id = ?`)
        .all(cur) as unknown as { id: string }[]
      for (const k of kids) collect(k.id)
    }
    collect(id)
    this.sessionsVersion += 1
    const del = this.stmt(`DELETE FROM sessions WHERE id = ?`)
    const delEvents = this.stmt(`DELETE FROM events WHERE session_id = ?`)
    const delFold = this.stmt(`DELETE FROM session_folds WHERE session_id = ?`)
    for (const sid of ids) {
      delEvents.run(sid)
      delFold.run(sid)
      del.run(sid)
    }
    return ids
  }

  getSession(id: string): SessionMeta | null {
    const r = this.stmt(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      SessionRowRaw | undefined
    return r ? toMeta(r) : null
  }

  childrenOf(parentId: string): SessionMeta[] {
    const rows = this
      .stmt(`SELECT * FROM sessions WHERE parent_id = ? ORDER BY created_at DESC`)
      .all(parentId) as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  listSessions(): SessionMeta[] {
    const rows = this
      .stmt(`SELECT * FROM sessions ORDER BY created_at DESC`)
      .all() as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  appendEvent(sessionId: string, event: AgentEvent): EventRow {
    const ts = Date.now()
    const r = this
      .stmt(`SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE session_id = ?`)
      .get(sessionId) as { max: number }
    const seq = r.max + 1
    this
      .stmt(`INSERT INTO events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)`)
      .run(sessionId, seq, ts, JSON.stringify(event))
    return { sessionId, seq, ts, event }
  }

  // ── workspaces & projects ──────────────────────────────────────────

  insertWorkspace(w: WorkspaceMeta): void {
    this
      .stmt(`INSERT INTO workspaces (id, name, path, git, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(w.id, w.name, w.path, w.git ? 1 : 0, w.createdAt)
  }

  listWorkspaces(): WorkspaceMeta[] {
    const rows = this
      .stmt(`SELECT * FROM workspaces ORDER BY created_at`)
      .all() as unknown as {
      id: string
      name: string
      path: string
      git: number
      account_pins: string | null
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      git: !!r.git,
      accountPins: parseAccountPins(r.account_pins),
      createdAt: r.created_at
    }))
  }

  setWorkspaceAccounts(id: string, pins: AccountPins): void {
    this.stmt(`UPDATE workspaces SET account_pins = ? WHERE id = ?`).run(serializeAccountPins(pins), id)
  }

  deleteWorkspace(id: string): string[] {
    const projectIds = (
      this.stmt(`SELECT id FROM projects WHERE workspace_id = ?`).all(id) as unknown as {
        id: string
      }[]
    ).map((p) => p.id)
    this.stmt(`DELETE FROM projects WHERE workspace_id = ?`).run(id)
    this.stmt(`DELETE FROM workspaces WHERE id = ?`).run(id)
    return projectIds
  }

  insertProject(p: ProjectMeta): void {
    this
      .stmt(
        `INSERT INTO projects (id, workspace_id, name, mode, branch, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(p.id, p.workspaceId, p.name, p.mode, p.branch, p.cwd, p.createdAt)
  }

  listProjects(): ProjectMeta[] {
    const rows = this.stmt(`SELECT * FROM projects ORDER BY created_at`).all() as unknown as {
      id: string
      workspace_id: string
      name: string
      mode: string
      branch: string | null
      cwd: string
      archived: number
      account_pins: string | null
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      mode: r.mode as ProjectMeta['mode'],
      branch: r.branch,
      cwd: r.cwd,
      archived: !!r.archived,
      accountPins: parseAccountPins(r.account_pins),
      createdAt: r.created_at
    }))
  }

  setProjectAccounts(id: string, pins: AccountPins): void {
    this.stmt(`UPDATE projects SET account_pins = ? WHERE id = ?`).run(serializeAccountPins(pins), id)
  }

  getProject(id: string): ProjectMeta | null {
    return this.listProjects().find((p) => p.id === id) ?? null
  }

  deleteProject(id: string): void {
    this.stmt(`DELETE FROM projects WHERE id = ?`).run(id)
  }

  renameProject(id: string, name: string): void {
    this.stmt(`UPDATE projects SET name = ? WHERE id = ?`).run(name, id)
  }

  setProjectBranch(id: string, branch: string): void {
    this.stmt(`UPDATE projects SET branch = ? WHERE id = ?`).run(branch, id)
  }

  setProjectArchived(id: string, archived: boolean): void {
    this.stmt(`UPDATE projects SET archived = ? WHERE id = ?`).run(archived ? 1 : 0, id)
  }

  sessionsOfProject(projectId: string): SessionMeta[] {
    const rows = this
      .stmt(`SELECT * FROM sessions WHERE project_id = ?`)
      .all(projectId) as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  /** One-off chats hung directly off a workspace (no project). */
  sessionsOfWorkspace(workspaceId: string): SessionMeta[] {
    const rows = this
      .stmt(`SELECT * FROM sessions WHERE workspace_id = ?`)
      .all(workspaceId) as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  // ── settings (key/value, e.g. orchestrator policy) ─────────────────

  getSetting(key: string): string | null {
    const r = this.stmt(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined
    return r?.value ?? null
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.stmt(`DELETE FROM settings WHERE key = ?`).run(key)
    else
      this
        .stmt(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(key, value)
  }

  /** Has this session ever received a user message? (drives first-send preambles) */
  /** Case-insensitive substring search over every stored user and assistant
   *  text row, newest first, so the renderer finds threads it never opened.
   *  Deltas and in-harness subagent prose are skipped: the full block that
   *  follows a delta stream repeats its text, and nested output has no row
   *  of its own in the transcript. Capped at 200 hits. */
  searchEvents(options: {
    query: string
    workspaceId?: string
    limit?: number
  }): SessionSearchResult {
    const needle = options.query.trim().toLowerCase()
    const limit = Math.min(options.limit ?? SEARCH_CAP, SEARCH_CAP)
    if (!needle) return { hits: [], truncated: false }
    const rows = this
      .stmt(
        `SELECT e.session_id AS sessionId, e.seq AS seq, e.ts AS ts,
                json_extract(e.payload, '$.type') AS type,
                json_extract(e.payload, '$.text') AS text
         FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE json_extract(e.payload, '$.type') IN ('user-text', 'assistant-text')
           AND COALESCE(json_extract(e.payload, '$.delta'), 0) = 0
           AND json_extract(e.payload, '$.parentCallId') IS NULL
           AND instr(lower(json_extract(e.payload, '$.text')), ?) > 0
           ${options.workspaceId ? 'AND s.workspace_id = ?' : ''}
         ORDER BY e.ts DESC, e.seq DESC
         LIMIT ?`
      )
      .all(
        ...(options.workspaceId ? [needle, options.workspaceId] : [needle]),
        limit + 1
      ) as unknown as Array<{ sessionId: string; seq: number; ts: number; type: string; text: string }>
    const hits: SessionSearchHit[] = rows.slice(0, limit).map((row) => {
      const at = row.text.toLowerCase().indexOf(needle)
      return {
        sessionId: row.sessionId,
        seq: row.seq,
        role: row.type === 'user-text' ? 'user' : 'assistant',
        snippet: row.text.slice(Math.max(0, at - 60), at + 120).trim(),
        ts: row.ts
      }
    })
    return { hits, truncated: rows.length > limit }
  }

  hasUserText(sessionId: string): boolean {
    const r = this
      .stmt(
        `SELECT 1 AS x FROM events WHERE session_id = ? AND payload LIKE '%"user-text"%' LIMIT 1`
      )
      .get(sessionId)
    return !!r
  }

  eventsAfter(sessionId: string, afterSeq: number): EventRow[] {
    return this.eventsRange(sessionId, afterSeq, -1)
  }

  /** Events in (`afterSeq`, `beforeSeq`). With `tail`, only the rows that
   *  fold into about the last `tail` transcript rows (a prompt, a tool call,
   *  or one assistant/thinking message each), cut at a row boundary; a log
   *  with fewer rows comes back whole. Rows are the paint unit: an agent
   *  thread packs tens of thousands of events into two turns, so a budget
   *  in turns would return the whole log. The walk back reads only light
   *  columns and stops at TAIL_SCAN events, so a huge log costs at most
   *  that many rows. */
  events(
    sessionId: string,
    opts: { afterSeq?: number; beforeSeq?: number; tail?: number } = {}
  ): EventRow[] {
    const afterSeq = opts.afterSeq ?? 0
    const beforeSeq = opts.beforeSeq ?? Number.MAX_SAFE_INTEGER
    let fromSeq = afterSeq + 1
    if (opts.tail && opts.tail > 0) {
      const scan = timed('events tail scan', () =>
        this
          .stmt(
            `SELECT seq, json_extract(payload, '$.type') AS type,
                    json_extract(payload, '$.callId') AS callId,
                    json_extract(payload, '$.msgId') AS msgId,
                    json_extract(payload, '$.blockIndex') AS blockIndex
               FROM events
               WHERE session_id = ? AND seq > ? AND seq < ?
               ORDER BY seq DESC LIMIT ?`
          )
          .all(sessionId, afterSeq, beforeSeq, TAIL_SCAN) as unknown as {
          seq: number
          type: string
          callId: string | null
          msgId: string | null
          blockIndex: number | null
        }[]
      )
      const start = tailStart(scan, opts.tail)
      if (start !== null) fromSeq = start
    }
    const rows = this
      .stmt(
        `SELECT seq, ts, payload FROM events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq`
      )
      .all(sessionId, fromSeq, beforeSeq) as unknown as { seq: number; ts: number; payload: string }[]
    return rows.map((r) => ({
      sessionId,
      seq: r.seq,
      ts: r.ts,
      event: JSON.parse(r.payload) as AgentEvent
    }))
  }

  /** Up to `limit` events after `afterSeq` (-1 for all) — the chunked
   *  read the fold sweep walks big logs with, yielding between chunks. */
  eventsRange(sessionId: string, afterSeq: number, limit: number): EventRow[] {
    const rows = this
      .stmt(
        `SELECT seq, ts, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`
      )
      .all(sessionId, afterSeq, limit) as unknown as { seq: number; ts: number; payload: string }[]
    return rows.map((r) => ({
      sessionId,
      seq: r.seq,
      ts: r.ts,
      event: JSON.parse(r.payload) as AgentEvent
    }))
  }

  /** Highest event seq per session — index-only, no payload read. */
  maxSeqs(): Map<string, number> {
    const rows = this
      .stmt(`SELECT session_id, MAX(seq) AS max FROM events GROUP BY session_id`)
      .all() as unknown as { session_id: string; max: number }[]
    return new Map(rows.map((r) => [r.session_id, r.max]))
  }

  // ── session folds ──────────────────────────────────────────────────

  listFolds(): FoldRow[] {
    const rows = this.stmt(`SELECT * FROM session_folds`).all() as unknown as FoldRowRaw[]
    return rows.map(toFold)
  }

  getFold(sessionId: string): FoldRow | null {
    const r = this.stmt(`SELECT * FROM session_folds WHERE session_id = ?`).get(sessionId) as
      FoldRowRaw | undefined
    return r ? toFold(r) : null
  }

  putFold(fold: FoldRow): void {
    this
      .stmt(
        `INSERT INTO session_folds
           (session_id, folded_seq, fold_version, tasks_done, tasks_total, tasks_current, goal, can_continue)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           folded_seq = excluded.folded_seq, fold_version = excluded.fold_version,
           tasks_done = excluded.tasks_done, tasks_total = excluded.tasks_total,
           tasks_current = excluded.tasks_current, goal = excluded.goal,
           can_continue = excluded.can_continue`
      )
      .run(
        fold.sessionId,
        fold.foldedSeq,
        fold.foldVersion,
        fold.tasks?.done ?? null,
        fold.tasks?.total ?? null,
        fold.tasks?.current ?? null,
        fold.goal ? JSON.stringify(fold.goal) : null,
        fold.canContinue ? 1 : 0
      )
  }

  deleteFold(sessionId: string): void {
    this.stmt(`DELETE FROM session_folds WHERE session_id = ?`).run(sessionId)
  }
}
