import type { AgentEvent } from '@shared/events'

/** done/total of a thread's CURRENT task list (earlier passes archived). */
export interface TaskTally {
  done: number
  total: number
}

/**
 * The task list a thread is working, folded straight from its event log —
 * the server's copy of the renderer's todo model (state/blocks.ts), so the
 * tab strip, the board, and the orchestrator's supervision tools always
 * count the same tasks. Incremental by design: the registry feeds it one
 * event at a time, and a long thread never gets re-walked.
 *
 * TodoWrite/update_plan replace the list per call; the SDK task tools
 * (TaskCreate/TaskUpdate — what Fable-era CLIs offer instead) build it up,
 * addressing items by the "#3" the create call's result reported.
 */
export interface TodoFold {
  list: { status: string }[]
  /** "3" (from "Task #3 created") → its index in the list */
  taskIdx: Map<string, number>
  /** pending TaskCreate calls waiting for the result that names them */
  byCall: Map<string, number>
  seen: Set<string>
  turnOpen: boolean
  sawUser: boolean
  /** ts of the last event — how a dead or abandoned pass is recognized */
  lastTs: number
}

/** A turn silent this long is dead, not open (crash, kill). */
const STALE_TURN_MS = 10 * 60_000
/** How long unfinished work stays warm enough to resume. */
const RESUME_WINDOW_MS = 30 * 60_000

export function newTodoFold(): TodoFold {
  return {
    list: [],
    taskIdx: new Map(),
    byCall: new Map(),
    seen: new Set(),
    turnOpen: false,
    sawUser: false,
    lastTs: 0
  }
}

function reset(s: TodoFold): void {
  s.list = []
  s.taskIdx.clear()
  s.byCall.clear()
  s.seen.clear()
}

/** Mirrors blocks.ts beginTurn: a message on a closed turn opens a new
 *  pass and archives the old list. Explicit beats inferred — a send the
 *  user stamped with the pass button decides directly; unstamped sends
 *  fall back to "unfinished and warm means resume". */
function beginTurn(s: TodoFold, ts: number, newPass?: boolean): void {
  const gap = s.lastTs ? ts - s.lastTs : 0
  const stale = s.turnOpen && s.lastTs > 0 && gap > STALE_TURN_MS
  const unfinished = s.list.length > 0 && s.list.some((t) => t.status !== 'completed')
  const resuming = unfinished && gap <= RESUME_WINDOW_MS
  const wantNew =
    newPass !== undefined ? newPass && (!s.turnOpen || stale) : (!s.turnOpen || stale) && !resuming
  if (wantNew && s.sawUser) reset(s)
  s.turnOpen = true
  s.sawUser = true
}

export function foldTodo(s: TodoFold, e: AgentEvent, ts: number): void {
  // Subagent work belongs to the child's own list, never the parent's.
  if ('parentCallId' in e && e.parentCallId) return
  switch (e.type) {
    case 'user-text':
      beginTurn(s, ts, (e as { newPass?: boolean }).newPass)
      break
    case 'status':
      if (e.status === 'idle' || e.status === 'error') s.turnOpen = false
      break
    case 'turn-complete':
      s.turnOpen = false
      break
    case 'tool-result': {
      const created = s.byCall.get(e.callId)
      if (created !== undefined) {
        s.byCall.delete(e.callId)
        const m = /#(\d+)/.exec(e.output)
        if (m) s.taskIdx.set(m[1], created)
      }
      break
    }
    case 'tool-call': {
      if (e.partial) break
      if (e.name === 'TodoWrite' || e.name === 'update_plan') {
        const input = e.input as { todos?: unknown; plan?: unknown } | null
        let items = e.name === 'TodoWrite' ? input?.todos : input?.plan
        if (typeof items === 'string') {
          try {
            items = JSON.parse(items)
          } catch {
            items = null
          }
        }
        if (Array.isArray(items)) {
          s.list = items.map((t) => ({ status: String((t as { status?: string })?.status ?? '') }))
        }
      } else if (e.name === 'TaskCreate' && !s.seen.has(e.callId)) {
        const subject = (e.input as { subject?: string } | null)?.subject
        if (subject) {
          s.seen.add(e.callId)
          s.list = [...s.list, { status: 'pending' }]
          s.byCall.set(e.callId, s.list.length - 1)
        }
      } else if (e.name === 'TaskUpdate' && !s.seen.has(e.callId)) {
        const i = e.input as { taskId?: unknown; status?: string } | null
        const idx = s.taskIdx.get(String(i?.taskId))
        const status = i?.status
        if (
          idx !== undefined &&
          idx < s.list.length &&
          (status === 'pending' || status === 'in_progress' || status === 'completed')
        ) {
          s.seen.add(e.callId)
          s.list = s.list.map((t, n) => (n === idx ? { status } : t))
        }
      }
      break
    }
    default:
      break
  }
  if (ts > s.lastTs) s.lastTs = ts
}

export function tallyOf(s: TodoFold): TaskTally | null {
  if (s.list.length === 0) return null
  return { done: s.list.filter((t) => t.status === 'completed').length, total: s.list.length }
}
