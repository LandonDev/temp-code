import type { SessionBatchResult } from '@shared/contract'
import type { SessionMeta } from '@shared/events'

/** What `session.batch` does to each thread, in the registry's own words. */
export type SessionBatchAction = 'pause' | 'resume' | 'stop' | 'archive'

export const SESSION_BATCH_ACTIONS: readonly SessionBatchAction[] = ['pause', 'resume', 'stop', 'archive']

/** How many per-session calls run at once. */
export const SESSION_BATCH_WIDTH = 4

/** The unarchived root threads of a master's batch, oldest first: what a
 *  pause or resume of the master cascades to (CLAUDE.md "Master threads").
 *  Stop stays per thread. */
export function batchChildIds(
  sessions: readonly Pick<SessionMeta, 'id' | 'parentId' | 'masterId' | 'archived' | 'createdAt'>[],
  masterId: string
): string[] {
  return sessions
    .filter((s) => s.masterId === masterId && !s.parentId && !s.archived && s.id !== masterId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s) => s.id)
}

export type SessionBatchDeps = {
  /** The visible root of a thread: a subagent follows its parent. */
  rootOf: (sessionId: string) => string
  /** The per-session call for each action; the registry's own methods. */
  run: (action: SessionBatchAction, rootId: string) => Promise<void>
  /** Optional: release a thread's worktree, simulator and the like after
   *  an archive. Called only when the caller asked (`cleanup`). */
  cleanup?: (rootId: string) => Promise<void>
  width?: number
}

/**
 * The ids as the batch attempts them: each mapped to its root, in the
 * order given, each root once. Fifteen subagents of one thread are one
 * pause, not fifteen.
 */
export function batchRoots(ids: readonly string[], rootOf: (id: string) => string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    let root: string
    try {
      root = rootOf(id)
    } catch {
      root = id
    }
    if (seen.has(root)) continue
    seen.add(root)
    out.push(root)
  }
  return out
}

/**
 * Run one action over many threads: at most `width` calls in flight, each
 * started in the order given, every outcome kept per id. A failure never
 * stops the rest; the caller reads `failed` for the toast.
 */
export async function runSessionBatch(
  action: SessionBatchAction,
  ids: readonly string[],
  deps: SessionBatchDeps,
  options: { cleanup?: boolean } = {}
): Promise<SessionBatchResult> {
  const attempted = batchRoots(ids, deps.rootOf)
  const width = Math.max(1, deps.width ?? SESSION_BATCH_WIDTH)
  const succeeded: string[] = []
  const failed: SessionBatchResult['failed'] = []
  const outcomes = new Map<string, string | null>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < attempted.length) {
      const id = attempted[next++]
      try {
        await deps.run(action, id)
        if (action === 'archive' && options.cleanup && deps.cleanup) await deps.cleanup(id)
        outcomes.set(id, null)
      } catch (error) {
        outcomes.set(id, error instanceof Error ? error.message : String(error))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, attempted.length) }, worker))
  for (const id of attempted) {
    const error = outcomes.get(id)
    if (error === null) succeeded.push(id)
    else failed.push({ sessionId: id, error: error ?? 'not attempted' })
  }
  return { attempted, succeeded, failed }
}
