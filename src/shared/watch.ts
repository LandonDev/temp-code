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

/** What a wait is made of, counted: "3 subagents, a monitor". Batch first,
 *  then subagents, then each task kind; "" when there is nothing. */
export function watchPhrase(bg: BackgroundWork | null | undefined): string {
  if (!bg) return ''
  const parts: string[] = []
  if (bg.batch && bg.batch.out > 0) parts.push(counted(bg.batch.out, 'a batch thread', 'batch threads'))
  if (bg.agents.length) parts.push(counted(bg.agents.length, 'a subagent', 'subagents'))
  for (const [kind, one, many] of TASK_WORDS) {
    const n = bg.tasks.filter((t) => t.kind === kind).length
    if (n) parts.push(counted(n, one, many))
  }
  return parts.join(', ')
}

/** Watching for longer than STALE_WATCH_MS without waking. */
export function isStaleWatch(meta: Pick<SessionMeta, 'status' | 'background'>, now: number): boolean {
  const since = meta.background?.watchingSince
  return meta.status === 'watching' && since != null && now - since > STALE_WATCH_MS
}
