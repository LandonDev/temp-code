import type { EventRow, SessionMeta } from '@shared/events'
import { foldContinuableError, foldGoal, type GoalState } from '@shared/session-lifecycle'
import { FOLD_VERSION, type FoldRow, type Store } from './db'
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
  /** highest seq folded in */
  seq: number
}

export function newFoldState(): FoldState {
  return { todo: newTodoFold(), goal: null, canContinue: false, seq: 0 }
}

export function foldEvent(state: FoldState, row: EventRow): void {
  foldTodo(state.todo, row.event, row.ts)
  state.goal = foldGoal(state.goal, row.event, row.ts)
  state.canContinue = foldContinuableError(state.canContinue, row.event)
  state.seq = row.seq
}

export function toFoldRow(sessionId: string, state: FoldState): FoldRow {
  return {
    sessionId,
    foldedSeq: state.seq,
    foldVersion: FOLD_VERSION,
    tasks: tallyOf(state.todo),
    goal: state.goal,
    canContinue: state.canContinue
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
  const maxSeqs = store.maxSeqs()
  const sessions = store.listSessions().sort((a, b) => b.updatedAt - a.updatedAt)
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
