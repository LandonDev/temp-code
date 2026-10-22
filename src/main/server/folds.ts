import type { EventRow, Failure, SessionMeta } from '@shared/events'
import { foldContinuableError, foldFailure, foldGoal, type GoalState } from '@shared/session-lifecycle'
import { FOLD_VERSION, type FoldRow, type Store } from './db'
import { untilLoopIdle } from './stalls'
import { foldTodo, newTodoFold, tallyOf, type TodoFold } from './todos'

/**
 * The three per-session folds the sidebar is drawn from — task tally, goal,
 * trailing error — walked together so a log is read once, and persisted
 * as a `session_folds` row so list() never reads events at all.
 */
export interface FoldState {
  todo: TodoFold
  goal: GoalState
  canContinue: boolean
  failure: Failure | null
  /** highest seq folded in */
  seq: number
}

export function newFoldState(): FoldState {
  return { todo: newTodoFold(), goal: null, canContinue: false, failure: null, seq: 0 }
}

export function foldEvent(state: FoldState, row: EventRow): void {
  foldTodo(state.todo, row.event, row.ts)
  state.goal = foldGoal(state.goal, row.event, row.ts)
  state.canContinue = foldContinuableError(state.canContinue, row.event)
  state.failure = foldFailure(state.failure, row.event)
  state.seq = row.seq
}

export function toFoldRow(sessionId: string, state: FoldState): FoldRow {
  return {
    sessionId,
    foldedSeq: state.seq,
    foldVersion: FOLD_VERSION,
    tasks: tallyOf(state.todo),
    goal: state.goal,
    canContinue: state.canContinue,
    failure: state.failure,
    todo: serializeTodo(state.todo, state.seq)
  }
}

// ── the task fold, persisted ─────────────────────────────────────────

/** The task fold as JSON, stamped with the seq it has folded through: a
 *  snapshot older than its fold row is still a valid starting point, since
 *  it says where it stands. */
export function serializeTodo(todo: TodoFold, seq: number): string {
  return JSON.stringify({
    seq,
    list: todo.list,
    taskIdx: [...todo.taskIdx],
    byCall: [...todo.byCall],
    seen: [...todo.seen],
    turnOpen: todo.turnOpen,
    sawUser: todo.sawUser,
    lastTs: todo.lastTs
  })
}

/** A stored snapshot back as a live task fold; null when there is none or it does not read. */
export function reviveTodo(json: string | null | undefined): { todo: TodoFold; seq: number } | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as {
      seq: number
      list: TodoFold['list']
      taskIdx: [string, number][]
      byCall: [string, number][]
      seen: string[]
      turnOpen: boolean
      sawUser: boolean
      lastTs: number
    }
    if (typeof v.seq !== 'number' || !Array.isArray(v.list)) return null
    return {
      seq: v.seq,
      todo: {
        list: v.list,
        taskIdx: new Map(v.taskIdx),
        byCall: new Map(v.byCall),
        seen: new Set(v.seen),
        turnOpen: !!v.turnOpen,
        sawUser: !!v.sawUser,
        lastTs: v.lastTs ?? 0
      }
    }
  } catch {
    return null
  }
}

/** The tool calls whose input the task fold reads (todos.ts foldTodo). */
const TODO_TOOLS = `('TodoWrite', 'update_plan', 'TaskCreate', 'TaskUpdate')`

/**
 * Each row's payload cut, in SQL on the reader worker, to what the folds
 * read (foldTodo, foldGoal, foldContinuableError, foldFailure): a tool
 * call's input only for the task tools, the head of a tool result (a
 * TaskCreate result names its "#N" in its first words), no message text.
 * Every other row stays whole. A big log's bodies never cross to the loop.
 */
export const FOLD_PAYLOAD_SQL = `CASE WHEN NOT json_valid(payload) THEN payload ELSE
  CASE json_extract(payload, '$.type')
    WHEN 'tool-call' THEN CASE WHEN json_extract(payload, '$.name') IN ${TODO_TOOLS} THEN payload
                              ELSE json_remove(payload, '$.input', '$.preview') END
    WHEN 'tool-result' THEN json_replace(payload, '$.output', substr(json_extract(payload, '$.output'), 1, 512))
    WHEN 'assistant-text' THEN json_remove(payload, '$.text')
    WHEN 'thinking' THEN json_remove(payload, '$.text')
    WHEN 'user-text' THEN json_remove(payload, '$.text', '$.attachments', '$.preamble')
    ELSE payload
  END
END`

const LOG_CHUNK = 2_000

/**
 * Fold a session's log into `state` from where it stands, through `through`:
 * the task fold from `todoSeq`, the other three from `state.seq` (a stored
 * row and its task snapshot may stand at different seqs). Read in chunks on
 * the reader worker (Store.readRows) with the payload cut to what the folds
 * read, a quiet loop awaited between chunks.
 */
export async function foldLog(
  store: Pick<Store, 'readRows'>,
  sessionId: string,
  state: FoldState,
  todoSeq: number,
  through: number,
  opts: { chunk?: number; between?: () => Promise<void> } = {}
): Promise<void> {
  const chunk = opts.chunk ?? LOG_CHUNK
  const between = opts.between ?? (() => untilLoopIdle())
  let after = Math.min(state.seq, todoSeq)
  for (;;) {
    if (after >= through) return
    const rows = await store.readRows(sessionId, { afterSeq: after, throughSeq: through, limit: chunk, payloadSql: FOLD_PAYLOAD_SQL })
    for (const row of rows) {
      if (row.seq > todoSeq) foldTodo(state.todo, row.event, row.ts)
      if (row.seq > state.seq) {
        state.goal = foldGoal(state.goal, row.event, row.ts)
        state.canContinue = foldContinuableError(state.canContinue, row.event)
        state.failure = foldFailure(state.failure, row.event)
        state.seq = row.seq
      }
    }
    if (rows.length < chunk) return
    after = rows[rows.length - 1].seq
    await between()
    await new Promise((r) => setImmediate(r))
  }
}

/** Is this row current for a log whose highest seq is `maxSeq`? */
export function foldIsCurrent(row: FoldRow | undefined, maxSeq: number): row is FoldRow {
  return !!row && row.foldVersion === FOLD_VERSION && row.foldedSeq >= maxSeq
}

/** What the sweep needs from the registry: its fold map, whether a session
 *  has a warm in-memory fold (append() owns it then), and a way to land
 *  finished rows that also pushes meta so the sidebar fills in live. */
export interface FoldHost {
  foldOf(sessionId: string): FoldRow | undefined
  isFoldWarm(sessionId: string): boolean
  commitFolds(rows: FoldRow[]): void
}

export interface SweepOptions {
  /** events read per yield */
  chunk?: number
  /** finished rows landed per commitFolds push */
  batch?: number
  /** yield point between chunks (tests pass a no-op) */
  yieldNow?: () => Promise<void>
  /** called after every batch lands, with the running total */
  onProgress?: (folded: number, total: number) => void
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * One-time catch-up: every session whose fold row is missing or behind its
 * log (or behind FOLD_VERSION) is re-walked, newest first, in chunks with a
 * yield between them, so the main thread never stalls for more than one
 * chunk. A session append() warmed meanwhile is dropped — append() has
 * already persisted a current row. Returns how many sessions it folded.
 */
export async function sweepFolds(
  store: Store,
  host: FoldHost,
  opts: SweepOptions = {}
): Promise<number> {
  const chunk = opts.chunk ?? 5_000
  const batch = opts.batch ?? 50
  const yieldNow = opts.yieldNow ?? yieldToLoop
  // Archived sessions are skipped outright: their rows are (or are on
  // their way to) the cold file, and append() re-folds a revived thread.
  const maxSeqs = store.maxSeqs()
  const sessions = store.listSessions({ archived: false }).sort((a, b) => b.updatedAt - a.updatedAt)
  const stale = sessions.filter(
    (s) => !foldIsCurrent(host.foldOf(s.id), maxSeqs.get(s.id) ?? 0) && !host.isFoldWarm(s.id)
  )
  let pending: FoldRow[] = []
  let folded = 0
  const flush = (): void => {
    if (pending.length === 0) return
    host.commitFolds(pending)
    folded += pending.length
    pending = []
    opts.onProgress?.(folded, stale.length)
  }
  for (const session of stale) {
    const row = await foldSession(store, host, session, chunk, yieldNow)
    if (row) pending.push(row)
    if (pending.length >= batch) flush()
    await yieldNow()
  }
  flush()
  return folded
}

async function foldSession(
  store: Store,
  host: FoldHost,
  session: SessionMeta,
  chunk: number,
  yieldNow: () => Promise<void>
): Promise<FoldRow | null> {
  const state = newFoldState()
  for (;;) {
    const rows = store.eventsRange(session.id, state.seq, chunk)
    for (const row of rows) foldEvent(state, row)
    if (rows.length < chunk) break
    await yieldNow()
    // append() took the session while we yielded; its row is the truth.
    if (host.isFoldWarm(session.id)) return null
  }
  return host.isFoldWarm(session.id) ? null : toFoldRow(session.id, state)
}
