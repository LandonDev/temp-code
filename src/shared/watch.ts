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

/** A subagent's title by its id, when one is known. */
export type AgentTitleOf = (id: string) => string | undefined

/** The session id inside an agent id: a cross-host child's `env_…:<sid>`
 *  names `<sid>` on its own host; any other id is itself. */
export function bareAgentId(id: string): string {
  return /^env_[A-Za-z0-9_-]+:(.+)$/.exec(id)?.[1] ?? id
}

/** The longest title a wait names in full; past it, cut at a word with "…". */
const WAIT_TITLE_MAX = 48

/** `text` cut to `max` at the last word boundary, "…" after; unchanged when it fits. */
export function cutAtWord(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const head = t.slice(0, max)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head.slice(0, max - 1)).trimEnd()}…`
}

/** One agent's title as the wait words name it, or undefined when none is known. */
function titleIn(id: string, titleOf: AgentTitleOf | undefined): string | undefined {
  const title = titleOf?.(bareAgentId(id))?.trim()
  return title ? cutAtWord(title, WAIT_TITLE_MAX) : undefined
}

/** What a wait on these agents names: one by its title ("a subagent"
 *  while none is known), several counted, "3 subagents". */
export function waitSubject(ids: readonly string[], titleOf?: AgentTitleOf): string {
  if (ids.length === 0) return 'a subagent'
  if (ids.length === 1) return titleIn(ids[0], titleOf) ?? 'a subagent'
  return counted(ids.length, 'a subagent', 'subagents')
}

/** The working line while a turn waits on its agents: "Waiting on Review the payment flow". */
export function waitLine(ids: readonly string[], titleOf?: AgentTitleOf): string {
  return `Waiting on ${waitSubject(ids, titleOf)}`
}

/** What a wait is made of: one task alone (no subagents, no batch thread
 *  out) by its label, in the model's words, and one subagent alone by its
 *  title when `titleOf` knows it; else counted, "3 subagents, a monitor",
 *  batch first, then subagents, then each task kind; "" when there is
 *  nothing. */
export function watchPhrase(bg: BackgroundWork | null | undefined, titleOf?: AgentTitleOf): string {
  if (!bg) return ''
  const batchOut = !!(bg.batch && bg.batch.out > 0)
  const lone = bg.tasks.length === 1 && !bg.agents.length && !batchOut
  const label = lone ? bg.tasks[0].label.trim() : ''
  if (label) return label
  const loneAgent = bg.agents.length === 1 && !bg.tasks.length && !batchOut
  const agentTitle = loneAgent ? titleIn(bg.agents[0], titleOf) : undefined
  if (agentTitle) return agentTitle
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
export function watchSubject(bg: BackgroundWork | null | undefined, titleOf?: AgentTitleOf): string {
  return watchPhrase(bg, titleOf) || (bg?.batch ? "the batch's steps" : 'background work')
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
