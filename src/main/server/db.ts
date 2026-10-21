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
import { ftsQuery, TURN_ROW_SQL, TurnIndex, turnText, type BackfillOptions } from './turnIndex'
import type { EventReader } from './dbWorkers'
import { dirname } from 'node:path'
import type { AgentEvent, EventRow, Failure, PreambleStamp, SessionMeta, SessionStatus } from '@shared/events'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { GithubInboxRepo } from '@shared/contract-github'
import { ACCOUNT_PROVIDERS, type AccountPins } from '@shared/accounts'
import { parseThreadRules } from '@shared/rules'
import { resolveModel, type ProviderId } from '@shared/catalog'

/**
 * node:sqlite, zero native deps (no electron-rebuild pain).
 * Two tables: sessions (the tree) and events (append-only log, the
 * source of truth the transcript is rendered from — T3-style).
 */

/** The cold file beside the hot one: `temp-code.db` → `temp-code-cold.db`. */
export function coldPathFor(path: string): string {
  return path === ':memory:' ? ':memory:' : path.replace(/\.db$/, '') + '-cold.db'
}

const EVENTS_COLUMNS = `(
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      ts         INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    )`

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
    CREATE TABLE IF NOT EXISTS events ${EVENTS_COLUMNS};
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
    CREATE TABLE IF NOT EXISTS github_inbox_repos (
      repo       TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      error      TEXT,
      items      TEXT NOT NULL
    );
    -- A thread's working notes (threadNotes.ts): the mirror of
    -- attachmentDir(session)/notes.md for the renderer, search and
    -- archived threads whose directory is gone.
    CREATE TABLE IF NOT EXISTS session_notes (
      session_id TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
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
    -- Remote access (server/remote/auth.ts): named keys hashed at rest,
    -- one-time pairing codes, and the browser sessions hanging off keys.
    CREATE TABLE IF NOT EXISTS remote_keys (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      audience     TEXT NOT NULL,
      caps         TEXT NOT NULL,
      hash         TEXT,
      salt         TEXT,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER,
      created_by   TEXT NOT NULL,
      -- A bot key may carry its own webhook: the hub payload, signed with the secret.
      webhook_url    TEXT,
      webhook_secret TEXT,
      events         TEXT
    );
    CREATE TABLE IF NOT EXISTS remote_pairings (
      id          TEXT PRIMARY KEY,
      code_hash   TEXT NOT NULL,
      name        TEXT NOT NULL,
      audience    TEXT NOT NULL,
      caps        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_by TEXT
    );
    -- Push (server/remote/push.ts): one APNs registration per key, mirrored
    -- to the hub as an apns subscription, and the Live Activity tokens a
    -- phone registered per thread. Tokens are not secrets; they are dropped
    -- with the key.
    CREATE TABLE IF NOT EXISTS remote_push (
      key_id      TEXT PRIMARY KEY,
      token       TEXT NOT NULL,
      bundle_id   TEXT NOT NULL,
      environment TEXT NOT NULL,
      events      TEXT NOT NULL,
      relay       TEXT NOT NULL,
      error       TEXT,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_push_activities (
      key_id      TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      token       TEXT NOT NULL,
      bundle_id   TEXT NOT NULL,
      environment TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (key_id, session_id)
    );
    -- Thread resources (server/threadResources.ts, contract-resources.ts):
    -- what a thread created and where. A subagent's rows carry its top-level
    -- thread's id. Rows are stamped, never deleted; one live row per
    -- resource on a host (the partial unique index), so a re-creation after
    -- removal is a new row.
    CREATE TABLE IF NOT EXISTS thread_resources (
      id                  TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL,
      environment_id      TEXT NOT NULL,
      kind                TEXT NOT NULL,
      identifier          TEXT NOT NULL,
      label               TEXT NOT NULL,
      branch              TEXT,
      created_at          INTEGER NOT NULL,
      remove_requested_at INTEGER,
      removed_at          INTEGER,
      note                TEXT
    );
    CREATE INDEX IF NOT EXISTS thread_resources_session ON thread_resources(session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS thread_resources_live
      ON thread_resources(environment_id, kind, identifier) WHERE removed_at IS NULL;
    CREATE TABLE IF NOT EXISTS remote_sessions (
      id           TEXT PRIMARY KEY,
      key_id       TEXT NOT NULL,
      secret_hash  TEXT NOT NULL,
      caps         TEXT NOT NULL,
      user_agent   TEXT,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      revoked_at   INTEGER
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
    `ALTER TABLE sessions ADD COLUMN ultrafast INTEGER NOT NULL DEFAULT 0`,
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
    `ALTER TABLE workspaces ADD COLUMN account_pins TEXT`,
    `ALTER TABLE workspaces ADD COLUMN github_repo TEXT`,
    `ALTER TABLE workspaces ADD COLUMN github_repo_checked_at INTEGER`,
    `ALTER TABLE sessions ADD COLUMN cold INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE remote_keys ADD COLUMN webhook_url TEXT`,
    `ALTER TABLE remote_keys ADD COLUMN webhook_secret TEXT`,
    `ALTER TABLE remote_keys ADD COLUMN events TEXT`,
    // Moving a thread between hosts (sessionMove.ts): frozen here while it
    // crosses (moving_to), landed here provisionally (moving_from), or left
    // as a tombstone after it moved (moved_to); move_id names the attempt.
    `ALTER TABLE sessions ADD COLUMN moving_to TEXT`,
    `ALTER TABLE sessions ADD COLUMN moving_from TEXT`,
    `ALTER TABLE sessions ADD COLUMN moved_to TEXT`,
    `ALTER TABLE sessions ADD COLUMN move_id TEXT`,
    // The trailing failure's verdict (failureKind.ts), folded beside can_continue.
    `ALTER TABLE session_folds ADD COLUMN failure TEXT`,
    // A plan's completion and the handoff links (plans.ts): when the
    // planner called plan_complete, the build started from the plan, the
    // plan a build came from, and the thread that started this one.
    `ALTER TABLE sessions ADD COLUMN plan_completed_at INTEGER`,
    `ALTER TABLE sessions ADD COLUMN implementation_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN plan_thread_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN started_by TEXT`,
    // Project preambles (projectPreamble.ts): the markdown prepended to a
    // thread's first message, and whether it applies. A workspace's row is
    // the default for its projects that have none of their own.
    `ALTER TABLE projects ADD COLUMN preamble TEXT`,
    `ALTER TABLE projects ADD COLUMN preamble_enabled INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE workspaces ADD COLUMN preamble TEXT`,
    `ALTER TABLE workspaces ADD COLUMN preamble_enabled INTEGER NOT NULL DEFAULT 1`
  ]) {
    try {
      db.exec(stmt)
    } catch {
      // column already exists
    }
  }
  // The cold file holds the logs of archived threads, same schema, on the
  // same connection: an archived thread's rows leave the hot file so every
  // scan of `events` (boot folds, search, the WAL) covers only live work.
  // `sessions.cold` says which file a session's rows are in.
  db.prepare(`ATTACH DATABASE ? AS cold`).run(coldPathFor(path))
  db.exec(`
    PRAGMA cold.journal_mode = WAL;
    PRAGMA cold.synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS cold.events ${EVENTS_COLUMNS};
  `)
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
export const FOLD_VERSION = 2

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
  /** The trailing failure's verdict while its error still shows (foldFailure). */
  failure: Failure | null
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
  failure: string | null
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
    canContinue: !!r.can_continue,
    failure: r.failure ? (JSON.parse(r.failure) as Failure) : null
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
  ultrafast: number
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
  plan_completed_at: number | null
  implementation_id: string | null
  plan_thread_id: string | null
  started_by: string | null
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
    ultrafast: !!r.ultrafast,
    context1m: !!r.context_1m,
    busySince: r.busy_since,
    pausedAt: r.paused_at,
    frozenActiveElapsed: r.frozen_active_elapsed,
    threadRules: parseThreadRules(r.thread_rules),
    context: r.context_tokens == null ? null : { tokens: r.context_tokens, window: r.context_window },
    permission: r.permission as SessionMeta['permission'],
    nativeId: r.native_id,
    account: r.account_current,
    planCompletedAt: r.plan_completed_at ?? null,
    implementationId: r.implementation_id ?? null,
    planThreadId: r.plan_thread_id ?? null,
    startedBy: r.started_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** A row the app shows: not a tombstone of a thread that moved to another
 *  host, nor a thread still landing here from one (sessionMove.ts). */
export const VISIBLE = `moved_to IS NULL AND moving_from IS NULL`

const SEARCH_CAP = 200
/** A cached StatementSync keeps its last bound string alive until the
 *  next bind (measured on Node 22 / SQLite 3.51: a 64 MB bind held 66 MB
 *  of RSS on the cached statement and was freed on rebind; a throwaway
 *  statement freed it at once). Binds this long or longer run on a
 *  statement of their own. The workspace snapshot (setSetting, up to 2 MB)
 *  was pinned for good; payloads over the line are rare (none in 50k
 *  recent rows) but a transcript can carry one. */
export const LARGE_BINDING = 64 * 1024

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
  /** Session search runs on the reader worker while it is up (dbWorkers.ts). */
  private reader: EventReader | undefined
  /** The FTS5 turn index over both event files (turnIndex.ts). */
  readonly turnIndex: TurnIndex
  /** Set by the first backfillTurnIndex(): from then on a session whose rows
   *  changed under the store is re-indexed in the background. */
  private indexing = false
  constructor(private db: DatabaseSync, options: { reader?: EventReader } = {}) {
    this.reader = options.reader
    const rows = db.prepare(`SELECT id FROM sessions WHERE cold = 1`).all() as unknown as { id: string }[]
    for (const r of rows) this.coldIds.add(r.id)
    this.turnIndex = new TurnIndex(db)
  }

  /** Index every session the turn index does not hold yet, newest first,
   *  in the background (turnIndex.ts): the whole database on the first
   *  boot after the upgrade, else what a move or an import left. Safe to
   *  call again; a call during a run makes it look again at the end. */
  backfillTurnIndex(opts: BackfillOptions = {}): Promise<void> {
    this.indexing = true
    return this.turnIndex.kick((id) => (this.coldIds.has(id) ? 'cold.events' : 'events'), {
      ...opts,
      flush: () => this.flushEvents()
    })
  }

  /** Statements are prepared once per SQL string: preparing dominated a
   *  boot profile where getSession() ran once per session per list(). */
  private stmts = new Map<string, StatementSync>()

  /** Sessions whose rows live in the cold file (`sessions.cold = 1`). */
  private coldIds = new Set<string>()
  /** The session a batched hot→cold move is half-way through: its rows are
   *  split across the two files until the move lands, so a reader asking
   *  for it finishes the move first. */
  private moving: string | null = null

  isCold(sessionId: string): boolean {
    return this.coldIds.has(sessionId)
  }

  /** The table a session's rows are in. Settles a half-moved session so
   *  the answer is one table, never two. */
  private eventsTable(sessionId: string): 'events' | 'cold.events' {
    if (this.moving === sessionId) this.moveToCold(sessionId)
    return this.coldIds.has(sessionId) ? 'cold.events' : 'events'
  }

  /** Bumped by every sessions-table write; the registry's index cache keys on it. */
  sessionsVersion = 0
  /** Next seq per session, seeded from MAX(seq) on first use. The log is
   *  append-only through this class, so the counter is the truth; a delete
   *  drops it and a PRIMARY KEY conflict re-seeds it. */
  private nextSeq = new Map<string, number>()
  /** Rows appended this tick, landed in one transaction by flushEvents().
   *  A streamed turn appends hundreds of deltas a second, and each used to
   *  be its own SELECT MAX + autocommit INSERT on the main thread; every
   *  reader and deleter of the table flushes first, so nothing observes
   *  the gap. */
  private pendingEvents: {
    sessionId: string
    seq: number
    ts: number
    payload: string
    /** The row's turn text for the FTS index, null when it is not a turn. */
    text: string | null
    table: 'events' | 'cold.events'
  }[] = []
  private flushScheduled = false
  private stmt(sql: string): StatementSync {
    let st = this.stmts.get(sql)
    if (!st) {
      st = this.db.prepare(sql)
      this.stmts.set(sql, st)
    }
    return st
  }

  /** The cached statement, unless a param is a string or blob of
   *  LARGE_BINDING or more: that gets a throwaway so the cache never pins it. */
  private stmtFor(sql: string, params: unknown[]): StatementSync {
    for (const p of params) {
      if (typeof p === 'string' ? p.length >= LARGE_BINDING : p instanceof Uint8Array && p.byteLength >= LARGE_BINDING) {
        return this.db.prepare(sql)
      }
    }
    return this.stmt(sql)
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
    this.turnIndex.markReady(meta.id)
    this
      .stmt(
        `INSERT INTO sessions (id, parent_id, project_id, workspace_id, thread_type, plan_path, provider, model, reasoning, agent_type, title, cwd, status, archived, pinned, permission, fast, ultrafast, context_1m, busy_since, paused_at, frozen_active_elapsed, thread_rules, native_id, account_current, plan_completed_at, implementation_id, plan_thread_id, started_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        meta.ultrafast ? 1 : 0,
        meta.context1m ? 1 : 0,
        meta.busySince,
        meta.pausedAt,
        meta.frozenActiveElapsed,
        meta.threadRules ? JSON.stringify(meta.threadRules) : null,
        meta.nativeId,
        meta.account ?? null,
        meta.planCompletedAt ?? null,
        meta.implementationId ?? null,
        meta.planThreadId ?? null,
        meta.startedBy ?? null,
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
        | 'ultrafast'
        | 'context1m'
        | 'busySince'
        | 'pausedAt'
        | 'frozenActiveElapsed'
        | 'threadType'
        | 'planPath'
        | 'agentType'
        | 'threadRules'
        | 'account'
        | 'planCompletedAt'
        | 'implementationId'
        | 'planThreadId'
        | 'startedBy'
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
        `UPDATE sessions SET status = ?, title = ?, native_id = ?, archived = ?, pinned = ?, provider = ?, model = ?, reasoning = ?, permission = ?, fast = ?, ultrafast = ?, context_1m = ?, busy_since = ?, paused_at = ?, frozen_active_elapsed = ?, thread_type = ?, plan_path = ?, agent_type = ?, thread_rules = ?, account_current = ?, plan_completed_at = ?, implementation_id = ?, plan_thread_id = ?, started_by = ?, updated_at = ? WHERE id = ?`
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
        next.ultrafast ? 1 : 0,
        next.context1m ? 1 : 0,
        next.busySince,
        next.pausedAt,
        next.frozenActiveElapsed,
        next.threadType,
        next.planPath,
        next.agentType,
        next.threadRules ? JSON.stringify(next.threadRules) : null,
        next.account ?? null,
        next.planCompletedAt ?? null,
        next.implementationId ?? null,
        next.planThreadId ?? null,
        next.startedBy ?? null,
        next.updatedAt,
        id
      )
    // A revived thread reads from the hot file again, so its rows come back
    // first: every path that unarchives (the archive toggle, a message into
    // an archived thread) goes through here.
    if (cur.archived && !next.archived) this.moveToHot(id)
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

  // ── thread notes (threadNotes.ts): the mirror of notes.md ──────────

  getSessionNotes(sessionId: string): { text: string; updatedAt: number } | null {
    const row = this.stmt(`SELECT text, updated_at AS updatedAt FROM session_notes WHERE session_id = ?`).get(
      sessionId
    ) as unknown as { text: string; updatedAt: number } | undefined
    return row ?? null
  }

  setSessionNotes(sessionId: string, text: string, updatedAt: number): void {
    this.stmt(
      `INSERT INTO session_notes (session_id, text, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`
    ).run(sessionId, text, updatedAt)
  }

  deleteSessionNotes(sessionId: string): void {
    this.stmt(`DELETE FROM session_notes WHERE session_id = ?`).run(sessionId)
  }

  /** Notes whose text contains the needle (case-insensitive), newest first:
   *  what session search folds in beside the transcript hits. */
  searchNotes(options: { query: string; workspaceId?: string; limit?: number }): {
    sessionId: string
    updatedAt: number
    snippet: string
  }[] {
    const needle = options.query.trim().toLowerCase()
    if (!needle) return []
    const limit = Math.min(options.limit ?? SEARCH_CAP, SEARCH_CAP)
    const sql = `SELECT n.session_id AS sessionId, n.updated_at AS updatedAt,
                        substr(n.text, max(1, instr(lower(n.text), ?) - 60), 180) AS snippet
                 FROM session_notes n JOIN sessions s ON s.id = n.session_id
                 WHERE instr(lower(n.text), ?) > 0
                   ${options.workspaceId ? 'AND s.workspace_id = ?' : ''}
                 ORDER BY n.updated_at DESC
                 LIMIT ?`
    const params = options.workspaceId ? [needle, needle, options.workspaceId, limit] : [needle, needle, limit]
    return this.stmt(sql).all(...params) as unknown as { sessionId: string; updatedAt: number; snippet: string }[]
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
    this.flushEvents()
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
    const delCold = this.stmt(`DELETE FROM cold.events WHERE session_id = ?`)
    const delFold = this.stmt(`DELETE FROM session_folds WHERE session_id = ?`)
    const delNotes = this.stmt(`DELETE FROM session_notes WHERE session_id = ?`)
    for (const sid of ids) {
      delEvents.run(sid)
      delCold.run(sid)
      delFold.run(sid)
      delNotes.run(sid)
      del.run(sid)
      this.nextSeq.delete(sid)
      this.coldIds.delete(sid)
      if (this.moving === sid) this.moving = null
    }
    this.turnIndex.forget(ids)
    return ids
  }

  // ── hot / cold ─────────────────────────────────────────────────────

  /** Archived sessions whose rows are still (partly) in the hot file, and
   *  unarchived ones left in cold: what the background mover has to do.
   *  Resumable by construction — a move that quit half-way shows up here
   *  again, and copying is idempotent (INSERT OR REPLACE on the key). */
  coldBacklog(): { toCold: string[]; toHot: string[] } {
    const ids = (sql: string): string[] =>
      (this.stmt(sql).all() as unknown as { id: string }[]).map((r) => r.id)
    return {
      toCold: ids(`SELECT id FROM sessions WHERE archived = 1 AND cold = 0 ORDER BY updated_at`),
      toHot: ids(`SELECT id FROM sessions WHERE archived = 0 AND cold = 1`)
    }
  }

  /** Move up to `limit` of a session's hot rows (lowest seq first) to cold
   *  in one transaction; with no limit, all of them. Returns how many moved
   *  and whether the session is now wholly cold. Between partial batches
   *  the session is `moving`, so readers settle it before reading. */
  moveToCold(sessionId: string, limit = 0): { moved: number; done: boolean } {
    this.flushEvents()
    let upTo = Number.MAX_SAFE_INTEGER
    if (limit > 0) {
      const edge = this
        .stmt(`SELECT seq FROM events WHERE session_id = ? ORDER BY seq LIMIT 1 OFFSET ?`)
        .get(sessionId, limit) as { seq: number } | undefined
      if (edge) upTo = edge.seq - 1
    }
    const done = upTo === Number.MAX_SAFE_INTEGER
    this.db.exec('BEGIN')
    try {
      const low = this.stmt(`SELECT MIN(seq) AS lo FROM events WHERE session_id = ?`).get(sessionId) as { lo: number | null }
      const moved = this
        .stmt(
          `INSERT OR REPLACE INTO cold.events (session_id, seq, ts, payload)
           SELECT session_id, seq, ts, payload FROM events WHERE session_id = ? AND seq <= ?`
        )
        .run(sessionId, upTo).changes
      this.stmt(`DELETE FROM events WHERE session_id = ? AND seq <= ?`).run(sessionId, upTo)
      if (done) this.stmt(`UPDATE sessions SET cold = 1 WHERE id = ?`).run(sessionId)
      if (low.lo !== null) this.turnIndex.moveRows(sessionId, 'events', 'cold.events', low.lo, upTo)
      this.db.exec('COMMIT')
      if (done) {
        this.coldIds.add(sessionId)
        if (this.moving === sessionId) this.moving = null
      } else this.moving = sessionId
      return { moved: Number(moved), done }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Bring every cold row of a session back to the hot file, in one
   *  transaction. Idempotent; a session split across the files (a move
   *  that quit half-way) comes back whole. */
  moveToHot(sessionId: string): number {
    this.flushEvents()
    this.db.exec('BEGIN')
    try {
      const moved = this
        .stmt(
          `INSERT OR REPLACE INTO events (session_id, seq, ts, payload)
           SELECT session_id, seq, ts, payload FROM cold.events WHERE session_id = ?`
        )
        .run(sessionId).changes
      this.stmt(`DELETE FROM cold.events WHERE session_id = ?`).run(sessionId)
      this.stmt(`UPDATE sessions SET cold = 0 WHERE id = ?`).run(sessionId)
      this.turnIndex.moveRows(sessionId, 'cold.events', 'events', 0, Number.MAX_SAFE_INTEGER)
      this.db.exec('COMMIT')
      this.coldIds.delete(sessionId)
      if (this.moving === sessionId) this.moving = null
      return Number(moved)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** How many rows a session has in each file (tests, the mover's log). */
  eventCounts(sessionId: string): { hot: number; cold: number } {
    this.flushEvents()
    const count = (table: string): number =>
      (this.stmt(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n
    return { hot: count('events'), cold: count('cold.events') }
  }

  /** Rows of these sessions changed under the store (a move landed or left):
   *  forget the seq counters and tier flags it cached, and reread the tier. */
  forgetSessions(ids: readonly string[]): void {
    this.flushEvents()
    const tier = this.stmt(`SELECT cold FROM sessions WHERE id = ?`)
    for (const id of ids) {
      this.nextSeq.delete(id)
      if (this.moving === id) this.moving = null
      const r = tier.get(id) as { cold: number } | undefined
      if (r?.cold) this.coldIds.add(id)
      else this.coldIds.delete(id)
    }
    this.sessionsVersion += 1
    // The index held the old rows: drop them and read the table again.
    this.turnIndex.forget(ids)
    if (this.indexing) void this.backfillTurnIndex().catch((error) => console.error('[search] re-index failed:', error))
  }

  /** The host a thread is crossing to while a move freezes it (sessionMove.ts), else null. */
  movingTo(id: string): string | null {
    const r = this.stmt(`SELECT moving_to FROM sessions WHERE id = ?`).get(id) as { moving_to: string | null } | undefined
    return r?.moving_to ?? null
  }

  getSession(id: string): SessionMeta | null {
    const r = this.stmt(`SELECT * FROM sessions WHERE id = ? AND ${VISIBLE}`).get(id) as
      SessionRowRaw | undefined
    return r ? toMeta(r) : null
  }

  childrenOf(parentId: string): SessionMeta[] {
    const rows = this
      .stmt(`SELECT * FROM sessions WHERE parent_id = ? AND ${VISIBLE} ORDER BY created_at DESC`)
      .all(parentId) as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  /** Every session, or only the archived / unarchived ones. */
  listSessions(opts: { archived?: boolean } = {}): SessionMeta[] {
    const where = `WHERE ${VISIBLE}` + (opts.archived === undefined ? '' : ` AND archived = ${opts.archived ? 1 : 0}`)
    const rows = this
      .stmt(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`)
      .all() as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  /** Append to the log: the row gets its seq and ts now (subscribers are
   *  pushed the returned row at once) and lands with the tick's other rows
   *  in flushEvents(). */
  appendEvent(sessionId: string, event: AgentEvent): EventRow {
    const ts = Date.now()
    const seq = this.nextSeq.get(sessionId) ?? this.maxSeq(sessionId) + 1
    this.nextSeq.set(sessionId, seq + 1)
    // A row for a cold session lands in the cold file, where its log is.
    const table = this.eventsTable(sessionId)
    this.pendingEvents.push({ sessionId, seq, ts, payload: JSON.stringify(event), text: turnText(event), table })
    if (!this.flushScheduled) {
      this.flushScheduled = true
      setImmediate(() => this.flushEvents())
    }
    return { sessionId, seq, ts, event }
  }

  private maxSeq(sessionId: string): number {
    const r = this
      .stmt(`SELECT COALESCE(MAX(seq), 0) AS max FROM ${this.eventsTable(sessionId)} WHERE session_id = ?`)
      .get(sessionId) as { max: number }
    return r.max
  }

  /** Land the rows appended since the last flush in one transaction. */
  flushEvents(): void {
    this.flushScheduled = false
    if (this.pendingEvents.length === 0) return
    const rows = this.pendingEvents
    this.pendingEvents = []
    try {
      this.db.exec('BEGIN')
    } catch (error) {
      // Closed under us: the owner flushed before close(), these are strays.
      if ((error as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE') return
      throw error
    }
    try {
      // Named in stalls.log: a long commit here is the WAL checkpoint the
      // writer ran inline (dbWorkers.ts moves it off the loop) or the disk.
      timed('event flush', () => {
        for (const row of rows) {
          const insert = this.stmtFor(`INSERT INTO ${row.table} (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)`, [row.payload])
          try {
            insert.run(row.sessionId, row.seq, row.ts, row.payload)
          } catch (error) {
            if (!/constraint/i.test(String((error as Error).message))) throw error
            // Something else wrote this session's log: re-seed from disk once.
            const seq = this.maxSeq(row.sessionId) + 1
            insert.run(row.sessionId, seq, row.ts, row.payload)
            this.nextSeq.set(row.sessionId, seq + 1)
            row.seq = seq
          }
        }
        this.turnIndex.insertLanded(rows)
        this.db.exec('COMMIT')
      })
    } catch (error) {
      this.db.exec('ROLLBACK')
      for (const row of rows) this.nextSeq.delete(row.sessionId)
      console.error('[db] event flush failed, rows dropped:', rows.length, error)
    }
  }

  // ── workspaces & projects ──────────────────────────────────────────

  insertWorkspace(w: WorkspaceMeta): void {
    this
      .stmt(
        `INSERT INTO workspaces (id, name, path, git, created_at, github_repo, github_repo_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(w.id, w.name, w.path, w.git ? 1 : 0, w.createdAt, w.githubRepo ?? null, w.githubRepoCheckedAt ?? null)
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
      github_repo: string | null
      github_repo_checked_at: number | null
      preamble: string | null
      preamble_enabled: number
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      git: !!r.git,
      accountPins: parseAccountPins(r.account_pins),
      githubRepo: r.github_repo,
      githubRepoCheckedAt: r.github_repo_checked_at,
      preamble: r.preamble,
      preambleEnabled: r.preamble_enabled !== 0,
      createdAt: r.created_at
    }))
  }

  /** The workspace's default preamble: null text clears it; `enabled`
   *  keeps the text while it does not apply. */
  setWorkspacePreamble(id: string, preamble: string | null, enabled: boolean): void {
    this
      .stmt(`UPDATE workspaces SET preamble = ?, preamble_enabled = ? WHERE id = ?`)
      .run(preamble, enabled ? 1 : 0, id)
  }

  /** Records the workspace's GitHub `owner/name` (null when it has none) and when it was read. */
  setWorkspaceGithubRepo(id: string, repo: string | null, checkedAt: number): void {
    this
      .stmt(`UPDATE workspaces SET github_repo = ?, github_repo_checked_at = ? WHERE id = ?`)
      .run(repo, checkedAt, id)
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
      preamble: string | null
      preamble_enabled: number
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
      preamble: r.preamble,
      preambleEnabled: r.preamble_enabled !== 0,
      createdAt: r.created_at
    }))
  }

  /** The project's own preamble: null text falls back to the workspace's
   *  default; `enabled: false` keeps the text while nothing is prepended. */
  setProjectPreamble(id: string, preamble: string | null, enabled: boolean): void {
    this
      .stmt(`UPDATE projects SET preamble = ?, preamble_enabled = ? WHERE id = ?`)
      .run(preamble, enabled ? 1 : 0, id)
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
      .stmt(`SELECT * FROM sessions WHERE project_id = ? AND ${VISIBLE}`)
      .all(projectId) as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  /** One-off chats hung directly off a workspace (no project). */
  sessionsOfWorkspace(workspaceId: string): SessionMeta[] {
    const rows = this
      .stmt(`SELECT * FROM sessions WHERE workspace_id = ? AND ${VISIBLE}`)
      .all(workspaceId) as unknown as SessionRowRaw[]
    return rows.map(toMeta)
  }

  // ── settings (key/value, e.g. orchestrator policy) ─────────────────

  // ── GitHub inbox snapshot ──────────────────────────────────────────

  listGithubInboxRepos(): GithubInboxRepo[] {
    const rows = this.stmt(`SELECT repo, fetched_at, error, items FROM github_inbox_repos ORDER BY repo`).all() as unknown as {
      repo: string
      fetched_at: number
      error: string | null
      items: string
    }[]
    return rows.map((r) => ({
      repo: r.repo,
      fetchedAt: r.fetched_at,
      error: r.error,
      items: JSON.parse(r.items) as GithubInboxRepo['items']
    }))
  }

  putGithubInboxRepo(row: GithubInboxRepo): void {
    const items = JSON.stringify(row.items)
    this
      .stmtFor(
        `INSERT INTO github_inbox_repos (repo, fetched_at, error, items) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error, items = excluded.items`,
        [items]
      )
      .run(row.repo, row.fetchedAt, row.error, items)
  }

  /** Drops every snapshot row whose repo is not in `keep`. */
  deleteGithubInboxRepos(keep: string[]): void {
    const rows = this.stmt(`SELECT repo FROM github_inbox_repos`).all() as unknown as { repo: string }[]
    const del = this.stmt(`DELETE FROM github_inbox_repos WHERE repo = ?`)
    for (const { repo } of rows) if (!keep.includes(repo)) del.run(repo)
  }

  /** Every setting whose key starts with `prefix`, keyed in full. */
  settingsWithPrefix(prefix: string): Map<string, string> {
    const rows = this
      .stmt(`SELECT key, value FROM settings WHERE key = ? OR key LIKE ?`)
      .all(prefix, `${prefix}%`) as unknown as { key: string; value: string }[]
    return new Map(rows.map((r) => [r.key, r.value]))
  }

  getSetting(key: string): string | null {
    const r = this.stmt(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined
    return r?.value ?? null
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.stmt(`DELETE FROM settings WHERE key = ?`).run(key)
    else
      this
        .stmtFor(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [value]
        )
        .run(key, value)
  }

  /** Has this session ever received a user message? (drives first-send preambles) */
  /** Case-insensitive substring search over every stored user and assistant
   *  text row, newest first, so the renderer finds threads it never opened.
   *  Deltas and in-harness subagent prose are skipped: the full block that
   *  follows a delta stream repeats its text, and nested output has no row
   *  of its own in the transcript. Capped at 200 hits. */
  /** Full-text walk of the log. Runs on the reader worker while it is up
   *  (the writer's loop stays free for 0.2–9 s per call on a 4 GB file),
   *  else on the writer; the same SQL either way. The SELECT cuts the
   *  snippet, so at most 201 short rows cross the thread boundary and no
   *  whole message is lowercased or sliced here. */
  async searchEvents(options: {
    query: string
    workspaceId?: string
    limit?: number
    /** Also walk the cold file (archived threads' logs). */
    archived?: boolean
  }): Promise<SessionSearchResult> {
    const needle = options.query.trim().toLowerCase()
    const limit = Math.min(options.limit ?? SEARCH_CAP, SEARCH_CAP)
    if (!needle) return { hits: [], truncated: false }
    this.flushEvents()
    const ws = options.workspaceId
    const tables: ('events' | 'cold.events')[] = options.archived ? ['events', 'cold.events'] : ['events']
    // The scan the search was before the index: every turn row of a table,
    // or only the rows of sessions the backfill has not reached yet.
    const scan = (table: string, pendingOnly: boolean): string =>
      `SELECT e.session_id AS sessionId, e.seq AS seq, e.ts AS ts,
              json_extract(e.payload, '$.type') AS type,
              substr(json_extract(e.payload, '$.text'),
                     max(1, instr(lower(json_extract(e.payload, '$.text')), ?) - 60), 180) AS snippet,
              0 AS rank
       FROM ${table} e JOIN sessions s ON s.id = e.session_id
       WHERE ${TURN_ROW_SQL}
         AND instr(lower(json_extract(e.payload, '$.text')), ?) > 0
         ${ws ? 'AND s.workspace_id = ?' : ''}
         ${pendingOnly ? `AND e.session_id IN (SELECT p.id FROM sessions p LEFT JOIN turn_index ti ON ti.session_id = p.id AND ti.ready = 1 WHERE ti.session_id IS NULL)` : ''}`
    const parts: string[] = []
    const params: (string | number)[] = []
    const match = this.turnIndex.available ? ftsQuery(options.query) : ''
    if (match) {
      for (const table of tables) {
        parts.push(this.turnIndex.matchSql(table, !!ws))
        params.push(match)
        if (ws) params.push(ws)
      }
    }
    if (!match || this.turnIndex.hasPending()) {
      for (const table of tables) {
        parts.push(scan(table, !!match))
        params.push(needle, needle)
        if (ws) params.push(ws)
      }
    }
    // bm25 is negative, better first; a scanned row (rank 0) follows the
    // ranked ones, newest first within a rank.
    const sql = `${parts.join('\n UNION ALL \n')}
         ORDER BY rank, ts DESC, seq DESC
         LIMIT ?`
    params.push(limit + 1)
    type Row = { sessionId: string; seq: number; ts: number; type: string; snippet: string; rank: number }
    let rows: Row[] | null = null
    if (this.reader?.available) {
      try {
        rows = await this.reader.query<Row>(sql, params)
      } catch {
        // The worker ended under this call: answer from the writer, as
        // every later call will.
        rows = null
      }
    }
    rows ??= this.stmt(sql).all(...params) as unknown as Row[]
    // The threads' working notes (threadNotes.ts) search beside the
    // transcript rows: one hit per thread, newest first, ahead of the rows
    // (what a thread chose to keep outranks what it said), under the same cap.
    const notes: SessionSearchHit[] = this.searchNotes({ query: needle, workspaceId: options.workspaceId, limit }).map((n) => ({
      sessionId: n.sessionId,
      seq: 0,
      role: 'assistant',
      snippet: n.snippet.replace(/\s+/g, ' ').trim(),
      ts: n.updatedAt,
      source: 'notes'
    }))
    const fromRows: SessionSearchHit[] = rows.map((row) => ({
      sessionId: row.sessionId,
      seq: row.seq,
      role: row.type === 'user-text' ? 'user' : 'assistant',
      snippet: (row.snippet ?? '').trim(),
      ts: row.ts,
      ...(row.rank ? { rank: row.rank } : {})
    }))
    const all = [...notes, ...fromRows]
    return { hits: all.slice(0, limit), truncated: all.length > limit }
  }

  hasUserText(sessionId: string): boolean {
    this.flushEvents()
    const r = this
      .stmt(
        `SELECT 1 AS x FROM ${this.eventsTable(sessionId)} WHERE session_id = ? AND payload LIKE '%"user-text"%' LIMIT 1`
      )
      .get(sessionId)
    return !!r
  }

  /** The project preamble the session's first message carried, or null
   *  when it opened without one (projectPreamble.ts). */
  firstUserPreamble(sessionId: string): PreambleStamp | null {
    this.flushEvents()
    const rows = this
      .stmt(
        `SELECT payload FROM ${this.eventsTable(sessionId)} WHERE session_id = ? AND payload LIKE '%"user-text"%' ORDER BY seq LIMIT 5`
      )
      .all(sessionId) as unknown as { payload: string }[]
    for (const r of rows) {
      const e = JSON.parse(r.payload) as AgentEvent
      if (e.type === 'user-text') return e.preamble ?? null
    }
    return null
  }

  /** Whether the assistant has ever answered in this session — a thread
   *  with history worth replaying to a harness that cannot resume it. */
  hasAssistantText(sessionId: string): boolean {
    this.flushEvents()
    const r = this
      .stmt(
        `SELECT 1 AS x FROM ${this.eventsTable(sessionId)} WHERE session_id = ? AND payload LIKE '%"assistant-text"%' LIMIT 1`
      )
      .get(sessionId)
    return !!r
  }

  eventsAfter(sessionId: string, afterSeq: number): EventRow[] {
    return this.eventsRange(sessionId, afterSeq, -1)
  }

  /** One persisted row by seq, whole (`session.rowBody`); null when the
   *  session has no such row. */
  eventAt(sessionId: string, seq: number): EventRow | null {
    this.flushEvents()
    const r = this
      .stmt(`SELECT seq, ts, payload FROM ${this.eventsTable(sessionId)} WHERE session_id = ? AND seq = ?`)
      .get(sessionId, seq) as unknown as { seq: number; ts: number; payload: string } | undefined
    return r ? { sessionId, seq: r.seq, ts: r.ts, event: JSON.parse(r.payload) as AgentEvent } : null
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
    opts: { afterSeq?: number; beforeSeq?: number; tail?: number; limit?: number } = {}
  ): EventRow[] {
    this.flushEvents()
    const table = this.eventsTable(sessionId)
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
               FROM ${table}
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
        `SELECT seq, ts, payload FROM ${table} WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq LIMIT ?`
      )
      .all(sessionId, fromSeq, beforeSeq, opts.limit && opts.limit > 0 ? opts.limit : -1) as unknown as {
      seq: number
      ts: number
      payload: string
    }[]
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
    this.flushEvents()
    const rows = this
      .stmt(
        `SELECT seq, ts, payload FROM ${this.eventsTable(sessionId)} WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`
      )
      .all(sessionId, afterSeq, limit) as unknown as { seq: number; ts: number; payload: string }[]
    return rows.map((r) => ({
      sessionId,
      seq: r.seq,
      ts: r.ts,
      event: JSON.parse(r.payload) as AgentEvent
    }))
  }

  /** The newest `limit` rows of a session, oldest first: the window a
   *  pending prompt or the last words sit in (remote/facade.ts). */
  lastEvents(sessionId: string, limit: number): EventRow[] {
    this.flushEvents()
    const rows = this
      .stmt(
        `SELECT seq, ts, payload FROM ${this.eventsTable(sessionId)} WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
      )
      .all(sessionId, limit) as unknown as { seq: number; ts: number; payload: string }[]
    return rows.reverse().map((r) => ({
      sessionId,
      seq: r.seq,
      ts: r.ts,
      event: JSON.parse(r.payload) as AgentEvent
    }))
  }

  /** Highest hot event seq per unarchived session: one index seek per
   *  session (the MIN/MAX optimisation on the primary key), never a walk
   *  of the table. The GROUP BY it replaces read every key of a 7.5M-row
   *  log on each boot. Archived sessions and the cold file are not asked. */
  maxSeqs(): Map<string, number> {
    this.flushEvents()
    const rows = this
      .stmt(
        `SELECT s.id AS session_id,
                (SELECT MAX(e.seq) FROM events e WHERE e.session_id = s.id) AS max
           FROM sessions s WHERE s.archived = 0`
      )
      .all() as unknown as { session_id: string; max: number | null }[]
    return new Map(rows.filter((r) => r.max !== null).map((r) => [r.session_id, r.max as number]))
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
           (session_id, folded_seq, fold_version, tasks_done, tasks_total, tasks_current, goal, can_continue, failure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           folded_seq = excluded.folded_seq, fold_version = excluded.fold_version,
           tasks_done = excluded.tasks_done, tasks_total = excluded.tasks_total,
           tasks_current = excluded.tasks_current, goal = excluded.goal,
           can_continue = excluded.can_continue, failure = excluded.failure`
      )
      .run(
        fold.sessionId,
        fold.foldedSeq,
        fold.foldVersion,
        fold.tasks?.done ?? null,
        fold.tasks?.total ?? null,
        fold.tasks?.current ?? null,
        fold.goal ? JSON.stringify(fold.goal) : null,
        fold.canContinue ? 1 : 0,
        fold.failure ? JSON.stringify(fold.failure) : null
      )
  }

  deleteFold(sessionId: string): void {
    this.stmt(`DELETE FROM session_folds WHERE session_id = ?`).run(sessionId)
  }
}
