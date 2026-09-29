import type { AgentEvent, SessionMeta } from './events'

/** Events after an error that prove the conversation moved on. Status and
 * accounting rows do not settle the error because providers can emit them
 * while a failed turn winds down. */
export function foldContinuableError(current: boolean, event: AgentEvent): boolean {
  switch (event.type) {
    case 'error':
      // A user Stop is not a failure, and neither is the Claude driver's
      // "turn ended: <subtype>" wind-down note (interrupts, max turns —
      // the session stays usable and settles idle). Matching the message
      // also heals threads persisted before the stopped stamp existed.
      return event.stopped || event.message.startsWith('turn ended:') ? current : true
    case 'errors-cleared':
    case 'user-text':
    case 'assistant-text':
    case 'tool-call':
    case 'tool-result':
      return false
    default:
      return current
  }
}

/** One goal at a time: set/updated replace it, met/cleared end it. A pure
 *  function of the previous state and one event, so the persisted state
 *  is complete — no log walk ever re-derives it. */
export type GoalState = NonNullable<SessionMeta['goal']> | null
export function foldGoal(prev: GoalState, event: AgentEvent, ts: number): GoalState {
  if (event.type !== 'goal') return prev
  if (event.phase === 'met' || event.phase === 'cleared') return null
  return {
    condition: event.condition,
    iterations: event.iterations ?? (event.phase === 'set' ? 0 : (prev?.iterations ?? 0)),
    setAt: event.phase === 'updated' && prev ? prev.setAt : ts
  }
}

export interface RootTreeSummary {
  canContinueError: boolean
  hasLiveWork: boolean
  hasPaused: boolean
  frozenActiveElapsed: number | null
}

/** Statuses with a live harness process doing or awaiting work — a
 *  watching thread's background tasks die with its process, so it is live. */
export const LIVE_STATUSES = new Set<SessionMeta['status']>([
  'starting',
  'running',
  'waiting',
  'watching'
])

export type ParentIndex = Map<string, SessionMeta[]>

/** Children keyed by parent id — built once per list, shared by every
 *  root's summary so decorating n sessions stays linear. */
export function indexByParent(sessions: SessionMeta[]): ParentIndex {
  const byParent: ParentIndex = new Map()
  for (const session of sessions) {
    if (!session.parentId) continue
    const siblings = byParent.get(session.parentId) ?? []
    siblings.push(session)
    byParent.set(session.parentId, siblings)
  }
  return byParent
}

/** Summarize one visible root without double-counting its descendants. */
export function summarizeRootTree(
  root: SessionMeta,
  byParent: ParentIndex,
  canContinue: (sessionId: string) => boolean
): RootTreeSummary {
  const tree: SessionMeta[] = []
  const pending = [root]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const session = pending.pop()!
    if (seen.has(session.id)) continue
    seen.add(session.id)
    tree.push(session)
    pending.push(...(byParent.get(session.id) ?? []))
  }

  // A tree with work still moving reads as working, not failed: an error
  // a live sibling or child left behind waits until the tree settles, so
  // no running thread wears a recovery label it cannot act on.
  const hasLiveWork = tree.some((session) => LIVE_STATUSES.has(session.status))
  // Only the root's own trailing error makes the thread read failed. A
  // subagent's error never gets follow-up events of its own, so counting
  // descendants held threads red long after the root moved past the
  // failure and finished; a child death always wakes the parent, so the
  // failure surfaces through the root's transcript when it matters.
  return {
    canContinueError: !hasLiveWork && canContinue(root.id),
    hasLiveWork,
    hasPaused: tree.some((session) => session.status === 'paused'),
    frozenActiveElapsed: root.frozenActiveElapsed
  }
}
