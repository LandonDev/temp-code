import type { BackgroundTaskKind, BackgroundWork, SessionMeta } from './events'

/** A thread watching this long without waking is stale: its age turns
 *  amber and Stop all appears (the strip, the banner, the Activity rows). */
export const STALE_WATCH_MS = 30 * 60_000

const TASK_WORDS: [BackgroundTaskKind, string, string][] = [
  ['shell', 'a command', 'commands'],
  ['monitor', 'a monitor', 'monitors'],
  ['agent', 'a background agent', 'background agents'],
  ['workflow', 'a workflow', 'workflows'],
  ['cron', 'a wake-up', 'wake-ups'],
  ['other', 'a background task', 'background tasks']
]

function counted(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`
}

/** What a wait is made of: one task alone (no subagents, no batch thread
 *  out) by its label, in the model's words; else counted, "3 subagents, a
 *  monitor", batch first, then subagents, then each task kind; "" when
 *  there is nothing. */
export function watchPhrase(bg: BackgroundWork | null | undefined): string {
  if (!bg) return ''
  const lone = bg.tasks.length === 1 && !bg.agents.length && !(bg.batch && bg.batch.out > 0)
  const label = lone ? bg.tasks[0].label.trim() : ''
  if (label) return label
  const parts: string[] = []
  if (bg.batch && bg.batch.out > 0) parts.push(counted(bg.batch.out, 'a batch thread', 'batch threads'))
  if (bg.agents.length) parts.push(counted(bg.agents.length, 'a subagent', 'subagents'))
  for (const [kind, one, many] of TASK_WORDS) {
    const n = bg.tasks.filter((t) => t.kind === kind).length
    if (n) parts.push(counted(n, one, many))
  }
  return parts.join(', ')
}

/** What a watching thread waits on, never empty: the counted phrase, else
 *  a master's batch steps (every batch thread is done), else background work. */
export function watchSubject(bg: BackgroundWork | null | undefined): string {
  return watchPhrase(bg) || (bg?.batch ? "the batch's steps" : 'background work')
}

/** Watching for longer than STALE_WATCH_MS without waking, on nothing but
 *  its own tasks: live subagents and a master's batch (its threads, its
 *  steps) have liveness of their own, so a wait on them is never stale (and
 *  Stop all, which ends the thread's own background work, could not stop them). */
export function isStaleWatch(meta: Pick<SessionMeta, 'status' | 'background'>, now: number): boolean {
  const bg = meta.background
  const since = bg?.watchingSince
  if (meta.status !== 'watching' || since == null || now - since <= STALE_WATCH_MS) return false
  return !bg?.agents.length && !bg?.batch
}
