import type { AgentEvent, SessionMeta } from './events'

/** Events after an error that prove the conversation moved on. Status and
 * accounting rows do not settle the error because providers can emit them
 * while a failed turn winds down. */
export function foldContinuableError(current: boolean, event: AgentEvent): boolean {
  switch (event.type) {
    case 'error':
      return true
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

export interface RootTreeSummary {
  canContinueError: boolean
  hasLiveWork: boolean
  hasPaused: boolean
  frozenActiveElapsed: number | null
}

const LIVE_STATUSES = new Set<SessionMeta['status']>(['starting', 'running', 'waiting'])

/** Summarize one visible root without double-counting its descendants. */
export function summarizeRootTree(
  root: SessionMeta,
  sessions: SessionMeta[],
  canContinue: (sessionId: string) => boolean
): RootTreeSummary {
  const byParent = new Map<string, SessionMeta[]>()
  for (const session of sessions) {
    if (!session.parentId) continue
    const siblings = byParent.get(session.parentId) ?? []
    siblings.push(session)
    byParent.set(session.parentId, siblings)
  }

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
  return {
    canContinueError: !hasLiveWork && tree.some((session) => canContinue(session.id)),
    hasLiveWork,
    hasPaused: tree.some((session) => session.status === 'paused'),
    frozenActiveElapsed: root.frozenActiveElapsed
  }
}
