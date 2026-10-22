import type { SessionMeta } from '@shared/events'
import { indexByParent, type ParentIndex } from '@shared/session-lifecycle'
import type { SessionRowChange } from './db'

/**
 * The registry's lookups over every visible sessions row (sessions.ts):
 * built once from the table, then kept current row by row from the store's
 * writes (Store.observeSessionRows), so a meta push, a scheduler pass or a
 * liveness sweep never re-reads the table. A write the store cannot
 * describe bumps `sessionsVersion` and the next read builds it again.
 *
 * Groups are copied on write: a caller walking one while a write lands
 * keeps the array it started with.
 */
export interface SessionIndex {
  byId: Map<string, SessionMeta>
  byParent: ParentIndex
  /** Root threads keyed by their master's id (CLAUDE.md "Master threads"), archived ones included. */
  byMaster: Map<string, SessionMeta[]>
  /** Unarchived queued threads, roots and subagents: the scheduler's pass reads only these. */
  queued: Map<string, SessionMeta>
  /** Unarchived rows in a live status (starting, running, waiting, watching): the running cap counts these with the live handles (admission.ts). */
  live: Map<string, SessionMeta>
}

const masterOf = (s: SessionMeta | null | undefined): string | null => (s && !s.parentId ? (s.masterId ?? null) : null)
const isQueued = (s: SessionMeta): boolean => s.status === 'queued' && !s.archived
const LIVE: ReadonlySet<SessionMeta['status']> = new Set(['starting', 'running', 'waiting', 'watching'])
const isLive = (s: SessionMeta): boolean => LIVE.has(s.status) && !s.archived

export function buildSessionIndex(rows: SessionMeta[]): SessionIndex {
  const byMaster = new Map<string, SessionMeta[]>()
  const queued = new Map<string, SessionMeta>()
  const live = new Map<string, SessionMeta>()
  for (const s of rows) {
    const master = masterOf(s)
    if (master) {
      const group = byMaster.get(master)
      if (group) group.push(s)
      else byMaster.set(master, [s])
    }
    if (isQueued(s)) queued.set(s.id, s)
    if (isLive(s)) live.set(s.id, s)
  }
  return { byId: new Map(rows.map((s) => [s.id, s])), byParent: indexByParent(rows), byMaster, queued, live }
}

/** One write, applied: the row replaces its old self in every lookup. */
export function applyRowChange(index: SessionIndex, change: SessionRowChange): void {
  const prev = index.byId.get(change.id)
  let next: SessionMeta | null
  if ('context' in change) {
    if (!prev) return
    next = { ...prev, context: change.context }
  } else next = change.row
  if (!prev && !next) return
  if (next) index.byId.set(next.id, next)
  else index.byId.delete(change.id)
  regroup(index.byParent, prev?.parentId ?? null, next?.parentId ?? null, change.id, next)
  regroup(index.byMaster, masterOf(prev), masterOf(next), change.id, next)
  if (next && isQueued(next)) index.queued.set(next.id, next)
  else index.queued.delete(change.id)
  if (next && isLive(next)) index.live.set(next.id, next)
  else index.live.delete(change.id)
}

/** Move a row between groups (or replace it in place); a new row goes
 *  first, as the table's newest-first order would put it. */
function regroup(
  groups: Map<string, SessionMeta[]>,
  from: string | null,
  to: string | null,
  id: string,
  next: SessionMeta | null
): void {
  if (from && from !== to) {
    const rest = (groups.get(from) ?? []).filter((s) => s.id !== id)
    if (rest.length) groups.set(from, rest)
    else groups.delete(from)
  }
  if (!to || !next) return
  const cur = groups.get(to) ?? []
  const at = cur.findIndex((s) => s.id === id)
  groups.set(to, at < 0 ? [next, ...cur] : cur.map((s, i) => (i === at ? next : s)))
}
