import { nanoid } from 'nanoid'
import { sweepThreadAttachments } from './attachmentUploads'
import { attachmentDir } from './attachmentDir'
import { ThreadNotes } from './threadNotes'
import {
  isCommitCall,
  isNotesCall,
  notesAfterCompaction,
  notesForPlanHandoff,
  NOTES_REMINDER_COMMIT,
  NOTES_REMINDER_CONTEXT,
  NOTES_REMINDER_FRACTION,
  NOTES_REMINDER_RESET_FRACTION
} from './notesPrompts'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { CreateSessionParams, type CreateSessionInput } from '@shared/contract'
import type { SessionBatchResult } from '@shared/contract'
import { batchChildIds, runSessionBatch, type SessionBatchAction } from './sessionBatch'
import { ThreadScheduler } from './scheduler'
import type { Admission } from './admission'
import { CATALOG, resolveModel, visibleModels, type ProviderId } from '@shared/catalog'
import type {
  AgentEvent,
  Attachment,
  BackgroundTask,
  BackgroundWork,
  EventRow,
  Failure,
  SessionMeta,
  SessionStatus
} from '@shared/events'
import { watchSubject } from '@shared/watch'
import { classifyFailure, type GatewayRefusal } from './failureKind'
import {
  LIVE_STATUSES,
  foldContinuableError,
  foldFailure,
  foldGoal,
  summarizeRootTree,
  type GoalState
} from '@shared/session-lifecycle'
import { isRoutedProvider, type AccountPins, type AccountProvider, type AccountRoute } from '@shared/accounts'
import { resolvePin, type ResolvedPin, type RouteOptions } from './accountRouting'
import type { LimitWindow } from '@shared/events'
import { foldEvent, foldLog, newFoldState, reviveTodo, serializeTodo, toFoldRow } from './folds'
import { FOLD_VERSION, type FoldRow, type ResumeAfterBootRow } from './db'

/** How a harness words a 401 the gateway could not route around (codex: "workspace routing discovery unauthorized (401)"). */
const UNAUTHORIZED_WORDING = /unauthorized|\(401\)/i
/** How long a gateway refusal explains the error row that follows it. */
const REFUSAL_FRESH_MS = 2 * 60_000

/** How long a delta-only stream may run before its fold watermark lands. */
const FOLD_LAND_MS = 2_000
const isDelta = (event: AgentEvent): boolean =>
  (event.type === 'assistant-text' || event.type === 'thinking') && event.delta
import type {
  ProjectCleanup,
  ProjectMeta,
  ProjectMode,
  ThreadType,
  WorkspaceMeta
} from '@shared/domain'
import { BUILT_IN_DRIVERS } from './drivers'
import { generateTitle } from './drivers/title'
import type { ApprovalRequest, DriverHandle } from './drivers/types'
import type { Store } from './db'
import { checkpointCwd } from './checkpoint'
import type { CheckpointTurns } from './checkpointTurns'
import {
  addProjectWorktree,
  currentBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  ensureLocalExclude,
  isGitRepo,
  removeWorktree,
  strayWorktrees,
  switchBranch
} from './git'
import { gitConfigMtime, githubRepoFromRemote, originRemoteUrl } from './gitRemote'
import { stopProjectLsp } from './lsp'
import { explicitModels, parseRules, type OrchestrationRules } from '@shared/rules'
import { DEFAULT_THREAD_DEFAULTS, parseDefaults, type ThreadDefaults } from '@shared/defaults'
import type { PlanSettings } from '@shared/plans'
import {
  completePlan,
  getPlanSettings,
  implementPlan,
  isPlanSettle,
  linkPlanHandoff,
  reopenPlan,
  resolvePlanSettings,
  setPlanSettings,
  settlePlan,
  type CompleteResult,
  type ImplementOptions,
  type PlanFlowRegistry
} from './planFlow'
import { parseTurnPass, passActions, passEnabled, type TurnPass } from '@shared/turnpass'
import { effectiveReviewSettings, parseReviewSettings, type ReviewSettings } from '@shared/review'
import { parseBuildConfig, type BuildConfig, type EffectiveBuild } from '@shared/build'
import { detectBuild } from './build'
import {
  AppshotSettingsSchema,
  DEFAULT_APPSHOT_SETTINGS,
  type AppshotSettings
} from '@shared/appshots'
import { CITE_CLAIM_MAX, type CiteSourceArgs } from '@shared/research'
import { isProjectPlanPath, projectPlanPathFor } from '@shared/projectPlan'
import { inheritMilestoneLink } from './projectPlan'
import {
  isReportPath,
  planPathFor,
  planSeed,
  projectContext,
  reportPathFor,
  threadPreamble
} from './threads'
import { batchMembershipOf, isMasterSession, notifyParentOfSettle, settleTargets } from './orchestration'
import { batches } from './batch'
import { foldTodo, newTodoFold, tallyOf, type TaskTally, type TodoFold } from './todos'
import { liveDiffOnStatus } from './livediff'
import { recordSendSpan, timed, whenLoopIdle } from './stalls'
import { FIRST_OUTPUT_GAVE_UP, FIRST_OUTPUT_SILENCE } from './drivers/silence'
import { SendSpans } from './sendSpans'
import { applyRowChange, buildSessionIndex, type SessionIndex } from './sessionIndex'
import {
  appendJournal,
  INLINE_DIGEST_MAX_CHARS,
  threadDigestTail,
  removeMirror,
  scheduleMirror,
  seedJournal,
  writeDigestFile,
  writeThreadDigest
} from './mirror'
import type { ForeignThreadRead } from './crossHostAgents'
import { removePages } from './htmlRender'
import { composePreambled, decidePreamble, normalizePreamble } from './projectPreamble'
import {
  newProjectLinkId,
  newWorkspaceLinkId,
  type CatalogLinkArgs,
  type ProjectLinkFacts,
  type ProjectSettingsBundle
} from '@shared/projectLinks'

const THREAD_TITLES = {
  chat: 'New chat',
  planning: 'New plan',
  'project-plan': 'Project plan',
  implementation: 'New task',
  orchestration: 'New orchestration',
  research: 'New research'
} as const

type SessionListener = (row: EventRow) => void
/** `producer` is notifyMeta's tag: which code pushed (the stall log's `pushes=` breakdown). */
type MetaListener = (session: SessionMeta, producer: string) => void

/** Cap for the transcript handoff sent to a new harness on provider switch. */
const HANDOFF_MAX_CHARS = 24_000

/** Providers whose harness resumes a thread by the native id the driver
 *  persists on every boot. One of their threads with history but no id has
 *  lost its native session (see recoverLostNativeSession). */
const NATIVE_RESUME_PROVIDERS = new Set<string>(['claude', 'codex', 'cursor'])

/**
 * Serialize the dialogue for a cross-provider switch: the new harness has no
 * native session to resume, so the conversation replays as context. Text
 * only — thinking and tool internals stay with the old harness.
 */
function transcriptHandoff(rows: EventRow[]): string {
  const turns: { role: 'User' | 'Assistant'; text: string }[] = []
  for (const { event } of rows) {
    let role: 'User' | 'Assistant'
    if (event.type === 'user-text') role = 'User'
    else if (event.type === 'assistant-text' && !event.delta && !event.parentCallId) {
      role = 'Assistant'
    } else continue
    const last = turns.at(-1)
    if (last?.role === role) last.text += `\n${event.text}`
    else turns.push({ role, text: event.text })
  }
  if (turns.length === 0) return ''
  let body = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n')
  if (body.length > HANDOFF_MAX_CHARS) {
    body = `[earlier conversation trimmed]\n\n…${body.slice(-HANDOFF_MAX_CHARS)}`
  }
  return `<conversation-handoff>\nYou are taking over an ongoing conversation from another assistant. The transcript so far:\n\n${body}\n\nContinue seamlessly — do not re-introduce yourself or revisit settled questions.\n</conversation-handoff>`
}
type RemovedListener = (sessionIds: string[]) => void
type MovedListener = (rootId: string, sessionIds: string[], to: string) => void
type QueueListener = (sessionId: string, items: QueuedMessage[]) => void

/** Options a queued message carries to its eventual send. */
interface QueuedSendOpts {
  provider?: ProviderId
  model?: string
  reasoning?: SessionMeta['reasoning']
  attachments?: Attachment[]
  newPass?: boolean
  /** A retry of a message whose user row is already on the transcript (the
   *  harness refused it); `first` is whether it opened the thread. */
  echoed?: { first: boolean }
  /** Into the live turn now (the composer's Steer), whatever the thread;
   *  a master steers without it. Never stored on the queued item. */
  steer?: boolean
}

/** What queueAdd did with the message: queued it, or steered it into the live turn. */
export type QueueAddResult = { kind: 'queued'; item: QueuedMessage } | { kind: 'steered'; id: string }

export interface QueuedMessage extends QueuedSendOpts {
  id: string
  text: string
  ts: number
}

/** A subagent settle report headed for its parent's harness. */
interface AgentReport {
  text: string
  agentId: string
  title: string
  status: string
}

/** Dispose idle harness handles after this long; resume restores them. */
const IDLE_DISPOSE_MS = 10 * 60 * 1000
/** An idle harness holds its slot this long before a queued thread may take it (reclaimIdle). */
const RECLAIM_GRACE_MS = 3000
/** How long a running thread may stand with no harness behind it before it reads stopped. */
export const HARNESS_GONE_GRACE_MS = 20_000
const HARNESS_GONE_SWEEP_MS = 5_000

/** What an event says the thread is doing, for the tab strip — text plus
 *  the kind that tints the spinner (investigate/edit/think).
 *  value = new activity, null = turn settled (clear), undefined = no
 *  opinion (deltas, results, and other chatter never churn the tabs). */
type Activity = { text: string; kind: NonNullable<SessionMeta['activityKind']> }

/** A send's or a continue's asked-for model; absent fields keep the row's. */
export type RunSettings = {
  provider?: ProviderId
  model?: string
  reasoning?: SessionMeta['reasoning']
}

// ── thread references (send) ─────────────────────────────────────────

/** Every form of a reference's token becomes the mention; with none in the text, the mention is appended. */
export function replaceTokens(text: string, tokens: string[], mention: string): string {
  const present = tokens.filter((t) => text.includes(t))
  if (!present.length) return `${text}\n\n${mention}`
  // The longest token first: `@thread:<host>:<id>` before a bare `@thread:<id>`.
  return present.sort((a, b) => b.length - a.length).reduce((out, t) => out.replaceAll(t, mention), text)
}

/** A projectless session reads a reference inline, after the message. */
function inlineReference(text: string, tokens: string[], title: string, digest: string, host?: string): string {
  const named = tokens.some((t) => text.includes(t))
  const out = named ? replaceTokens(text, tokens, `thread "${title}" (referenced below)`) : text
  const hostAttr = host ? ` host=${JSON.stringify(host)}` : ''
  return `${out}\n\n<thread-reference title=${JSON.stringify(title)}${hostAttr}>\n${digest}\n</thread-reference>`
}

/**
 * A reference to a thread on another host: its digest (read there) lands in
 * the same `.temp-code/refs/<id>.md` a local reference gets, or inline for a
 * projectless session; a host out of reach leaves one line saying so.
 */
export function foreignReference(text: string, tokens: string[], name: string, read: ForeignThreadRead, cwd: string | null): string {
  if (!read.ok) return replaceTokens(text, tokens, `thread "${name}" on ${read.hostName} is unreachable (${read.why})`)
  let digest = read.digest
  if (digest.length > INLINE_DIGEST_MAX_CHARS) digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
  if (!cwd) return inlineReference(text, tokens, read.title, digest, read.hostName)
  const rel = writeDigestFile(cwd, read.sessionId, digest)
  const from = read.projectName ? ` from project "${read.projectName}"` : ''
  return replaceTokens(text, tokens, `@${rel} (thread "${read.title}"${from} on ${read.hostName})`)
}

/** The header line of a watching thread: what it waits on. One task is
 *  named in the model's words; anything more is counted (watchPhrase). */
const WATCH_LINE_MAX = 120
export function watchLine(bg: BackgroundWork | null | undefined): string {
  const lone = bg && bg.tasks.length === 1 && !bg.agents.length && !(bg.batch && bg.batch.out > 0)
  const line = `Waiting on ${lone ? bg.tasks[0].label : watchSubject(bg)}`
  return line.length > WATCH_LINE_MAX ? `${line.slice(0, WATCH_LINE_MAX - 1)}…` : line
}

/** The words of a turn's phase before its first content (events.ts `phase`). */
export function phaseLine(event: Extract<AgentEvent, { type: 'phase' }>): string | null {
  switch (event.phase) {
    case 'cli-starting':
      return 'Starting the CLI'
    case 'initializing':
      return 'Initializing'
    case 'waiting-provider':
      return 'Waiting for the provider'
    case 'retrying': {
      const r = event.retry
      if (!r) return 'Retrying'
      const wait = r.delayMs > 0 ? ` in ${Math.max(1, Math.round(r.delayMs / 1000))} s` : ''
      if (r.reason?.startsWith('of ')) return `Reconnecting · retry ${r.attempt} ${r.reason}`
      const why = r.reason === 'HTTP 429' ? 'Rate limited' : r.reason === 'HTTP 529' || r.reason === 'HTTP 503' ? 'Provider overloaded' : 'Retrying'
      return `${why} · retry ${r.attempt}${wait}`
    }
    default:
      return null
  }
}

function activityOf(event: AgentEvent): Activity | null | undefined {
  if (event.type === 'status') {
    return event.status === 'running' ? { text: 'Thinking', kind: 'think' } : null
  }
  // A phase is the turn's own word for its wait; cleared, the turn is back to thinking.
  if (event.type === 'phase') {
    const text = phaseLine(event)
    return { text: text ?? 'Thinking', kind: 'think' }
  }
  if (event.type === 'tool-call' && !event.partial && !event.parentCallId) {
    if (event.display?.app) {
      return {
        text: event.display.action ? `${event.display.action}` : `Using ${event.display.app}`,
        kind: 'investigate'
      }
    }
    return describeTool(event.name, event.input)
  }
  return undefined
}

const fileOf = (p: unknown): string | null =>
  typeof p === 'string' && p ? (p.split('/').pop() ?? null) : null

function describeTool(name: string, input: unknown): Activity {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'Read':
      return { text: `Reading ${fileOf(i.file_path) ?? 'a file'}`, kind: 'investigate' }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return {
        text: `Editing ${fileOf(i.file_path ?? i.notebook_path) ?? 'a file'}`,
        kind: 'edit'
      }
    case 'Bash': {
      const cmd = typeof i.command === 'string' ? i.command.trim().split(/\s+/)[0] : ''
      return { text: cmd ? `Running ${fileOf(cmd) ?? cmd}` : 'Running a command', kind: 'edit' }
    }
    case 'Grep':
    case 'Glob':
      return { text: 'Searching', kind: 'investigate' }
    case 'WebSearch':
    case 'WebFetch':
      return { text: 'Browsing', kind: 'investigate' }
    case 'Task':
      return { text: 'Delegating', kind: 'think' }
    case 'TodoWrite':
      return { text: 'Planning', kind: 'think' }
    case 'AskUserQuestion':
      return { text: 'Asking you', kind: 'think' }
    default: {
      const mcp = /^mcp__([^_]+)__/.exec(name)
      return { text: `Using ${mcp ? mcp[1] : name}`, kind: 'investigate' }
    }
  }
}

/** Tools that write the disk, across all three harnesses (claude / codex /
 *  cursor) — the set that makes a session a candidate owner of a live
 *  disk change. */
const DISK_TOOLS = new Set([
  'Bash',
  'shell',
  'Shell',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'apply_patch',
  'Delete'
])
/** A write can flush moments after its tool result lands. */
const DISK_TOOL_GRACE_MS = 2_500

/** Unanswered approvals deny themselves after this long. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The session registry: owns the session tree, the append-only event log,
 * live driver handles, and per-session subscriptions. The single write
 * path — everything user-visible flows through append().
 */
export function isPlaceholderTitle(meta: SessionMeta): boolean {
  return (Object.values(THREAD_TITLES) as string[]).includes(meta.title) ||
    meta.title === `${meta.provider} · ${meta.agentType}`
}

export interface Switched {
  from: string
  to: string
}
/** Where a thread's account comes from: the accounts service, set by the server. */
export interface AccountRouter {
  /** The account a thread's child should spend from at spawn, and the account its row should show.
   *  `fresh` ignores the thread's sticky account: the best pick for its model, as after a model change.
   *  `load` is the live load when the caller already has it (a whole-list refresh reads it once). */
  routeFor(meta: SessionMeta, pin: ResolvedPin | null, opts?: RouteOptions): { route: AccountRoute | null; current: string | null; vanished?: { pin?: string; sticky?: string } }
  /** A thread's error named a usage limit: move that thread to another account with room, or null. */
  failover(
    sessionId: string,
    info: { provider: AccountProvider; model: string | null; window: LimitWindow; account: string | null }
  ): Promise<Switched | null>
}
/** @deprecated use AccountRouter */
export type LimitFailover = AccountRouter
/** How long after the limited session settles before its tree continues: siblings that hit the same limit settle in this window. */
export const LIMIT_CONTINUE_DELAY_MS = 250

/** The public http(s) urls a shell command reads with curl or wget — a
 *  research agent's page reads outside any fetch tool. Nothing else
 *  matches (git clone, bun install, gh api), and localhost or private
 *  hosts never board. */
export function shellReadUrls(command: string): string[] {
  if (!/(^|[\s;|&(`])(curl|wget)(\s|$)/.test(command)) return []
  const out: string[] = []
  for (const m of command.matchAll(/https?:\/\/[^\s'"`<>()\]]+/g)) {
    const url = m[0].replace(/[.,;:!?)]+$/, '')
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      continue
    }
    if (
      /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|\[::1\]$)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /\.(local|internal|localhost)$/.test(host) ||
      !host.includes('.')
    ) {
      continue
    }
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/** `owner/name` of a checkout's github.com origin, or null (no spawn). */
async function githubRepoOf(path: string): Promise<string | null> {
  const url = await originRemoteUrl(path)
  return url ? githubRepoFromRemote(url) : null
}

/** Which status moves wake a dormant parent with a report (orchestration.ts
 *  notifyParentOfSettle): a turn ending (idle, error, waiting, watching —
 *  the reply is complete, background work keeps the thread alive — or
 *  stopped, the harness gone), and a watching thread erroring, stopping or
 *  asking something. watching → idle is the work finishing, not a settle. */
export function isSettleReport(from: SessionMeta['status'] | undefined, to: SessionMeta['status']): boolean {
  if (from === 'running') return to === 'idle' || to === 'error' || to === 'waiting' || to === 'watching' || to === 'stopped'
  if (from === 'watching') return to === 'error' || to === 'waiting' || to === 'stopped'
  return false
}

/** A request at the provider this long with nothing back reads "Waiting for the provider" on the row. */
export const PROVIDER_WAIT_MS = 15_000
/** Every foreign thread reference of one send resolves inside this, together. */
export const FOREIGN_REFS_BUDGET_MS = 15_000
const PROVIDER_TICK_MS = 5_000

export class SessionRegistry {
  private catalogListeners = new Set<(kind: 'workspaces' | 'projects') => void>()

  onCatalog(listener: (kind: 'workspaces' | 'projects') => void): () => void {
    this.catalogListeners.add(listener)
    return () => this.catalogListeners.delete(listener)
  }

  private notifyCatalog(kind: 'workspaces' | 'projects'): void {
    for (const listener of this.catalogListeners) listener(kind)
  }

  setPinned(sessionId: string, pinned: boolean): void {
    const next = this.store.updateSession(sessionId, { pinned })
    if (!next) throw new Error(`unknown session: ${sessionId}`)
    this.notifyMeta(next)
  }

  private handles = new Map<string, DriverHandle>()
  /** Approvals raised through requestApproval, per session: requestId →
   *  settle. Drivers with their own prompt loop (codex) keep theirs. */
  private pendingApprovals = new Map<string, Map<string, (allow: boolean, auto?: boolean) => void>>()
  private starting = new Map<string, Promise<DriverHandle>>()
  private subscribers = new Map<string, Set<SessionListener>>()
  private metaListeners = new Set<MetaListener>()
  /** Every persisted row of every session (the remote notifier). */
  private eventListeners = new Set<SessionListener>()
  private removedListeners = new Set<RemovedListener>()
  private movedListeners = new Set<MovedListener>()
  /** Per-session message queue: composed mid-turn, drained on idle. */
  private queues = new Map<string, QueuedMessage[]>()
  /** Threads whose create asked to queue (`queue: true`); a master's children queue by their row. */
  private queueOptIn = new Set<string>()
  /** The lines queued rows carry (scheduler.ts): what the rail and the strip read. */
  private queuedLines = new Map<string, string>()
  /** wait_for_agent calls waiting for the person's next steer into the thread's turn (nextSteer). */
  private steerWaiters = new Map<string, Set<(text: string) => void>>()
  /** The user row (its seq) the first-output watchdog re-queued once; a second silence on it fails the turn. */
  private readonly silenced = new Map<string, number>()
  /** Threads whose next idle is an error: the message went unanswered twice. */
  private readonly silenceFailed = new Set<string>()
  /** The gateway's open requests per thread, id → when it went out (providerRequest). */
  private readonly providerOpen = new Map<string, Map<number, number>>()
  private providerTicker: NodeJS.Timeout | null = null
  /** The agent ids a live wait_for_agent of each thread covers, with how many waits name each (setAwaiting). */
  private readonly awaiting = new Map<string, Map<string, number>>()
  /** The thread scheduler: `after` and the running cap (CLAUDE.md "Master threads"). */
  readonly scheduler: ThreadScheduler
  /** One phase line per send in stalls.log (sendSpans.ts): where a slow send spent its time. */
  private readonly spans = new SendSpans({ write: recordSendSpan })
  /** The running cap and the memory floor (admission.ts). Set by the server; null runs uncapped. */
  admission: Pick<Admission, 'cap' | 'memoryLow'> | null = null
  /** Boot-resume threads past the cap, queued with their nudge (the restart's time) until a slot frees. */
  private readonly queuedResumes = new Map<string, number>()
  /** Queued threads whose start is in flight: Start now and the scheduler never start one twice. */
  private readonly startingQueued = new Set<string>()
  private queueListeners = new Set<QueueListener>()
  private draining = new Set<string>()
  /** Subagent settle reports awaiting a busy parent — delivered straight
   *  to the harness on idle, ahead of the user queue, never through it. */
  private pendingReports = new Map<string, AgentReport[]>()
  /** Completed-turn pass state: armed at turn-complete, fired at idle. */
  private passPending = new Map<string, TurnPass>()
  private passActive = new Set<string>()
  /** Turns that emitted an error event (usage limit, execution failure) —
   *  such a turn is not a "completed turn", so the pass never runs on it.
   *  The status-level guard below misses these: drivers often emit the
   *  error event and still settle with status idle. */
  private erroredTurns = new Set<string>()
  /** Sessions the user just hit Stop on. Drivers report an interrupt as an
   *  error event ("turn ended: …"); while this flag is up that event is
   *  stamped stopped:true so a stop never reads as a failure. Cleared when
   *  the turn settles. */
  private stopping = new Set<string>()
  /** Threads told their account needs sign-in, and which account: one row per account, the harness's 401 wording dropped meanwhile. */
  private readonly signIns = new Map<string, string>()
  /** Sessions whose harness must reboot once the current turn settles —
   *  a tune saved mid-turn. Disposing a streaming handle mutes the turn
   *  (events drop, the thread wedges on "working"), so the drop waits
   *  for the settling status event. */
  private pendingReboot = new Set<string>()
  /** Disk-writing tool calls in flight per session (callId → closedAt,
   *  null while open). The live change stream asks which watching session
   *  was actually writing when a file changed — ownership at the source,
   *  instead of broadcasting every edit to every session in the cwd. */
  private diskToolCalls = new Map<string, Map<string, number | null>>()
  private lastActivity = new Map<string, number>()
  /** "Where it's at" per working thread ("Editing PromptBar.tsx") —
   *  transient by design: server memory only, cleared when the turn
   *  settles, attached to every meta push for the tab strip. */
  private activities = new Map<string, Activity>()
  /** What a watching thread waits on (background task and cron
   *  descriptions from the driver's background-tasks event) — transient
   *  like activities; decorate() turns it into the "Waiting on …" line. */
  private watching = new Map<string, BackgroundTask[]>()
  /** When each watching thread's current watching stretch began: set when
   *  a status moves the row INTO watching, gone on any other status. */
  private watchingSince = new Map<string, number>()
  /** Per-session derived folds (task tally, goal, trailing error) — the
   *  persisted session_folds rows, loaded once at construction and kept
   *  current by append(). list() reads these and never the event log. */
  private folds = new Map<string, FoldRow>()
  /** Sessions whose in-memory fold is ahead of its stored row: a streamed
   *  delta moves only the watermark, so the write waits for the next
   *  non-delta event or the timer instead of running once per token. */
  private foldDirty = new Set<string>()
  private foldTimer: ReturnType<typeof setTimeout> | null = null
  /** The richer in-memory task fold (list, call bookkeeping, turn state)
   *  that the tally is emitted from. Not persisted: seeded from the log
   *  the first time a session is appended to in this process, then kept
   *  live event by event. A warm entry means append() owns that
   *  session's fold row. */
  private todoFolds = new Map<string, TodoFold>()
  /** Live context footprint per thread, straight off each harness stream;
   *  rides every meta push so all rings stay current without any thread
   *  being subscribed. Seeded from the session rows at boot and written
   *  back on every reading, so a relaunch starts from the last one. */
  private liveContexts = new Map<string, { tokens: number; window: number | null }>()
  /** create()-with-goal: applied on the kickoff send, ahead of the
   *  message, so the goal precedes the work on both providers. */
  private pendingGoals = new Map<string, string>()
  /** threads titled by slicing their first message, awaiting a real title:
   *  sessionId → the placeholder (to detect a user rename) + the message */
  private pendingTitles = new Map<string, { placeholder: string; text: string }>()
  /** research boards: fetches (and single-url shell reads) awaiting a
   *  title from their result (key = the boarded event's callId), and per
   *  root the boarded queries/urls → their row, so repeats never bloat the
   *  root's log and a citation of a fetched url lands on the fetch's row.
   *  In memory only: after a restart dedupe starts over. */
  private researchFetches = new Map<
    string,
    { rootId: string; url: string; agentId: string; agentLabel: string }
  >()
  private researchSeen = new Map<string, Map<string, { callId: string; claimed: boolean }>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  /** Undo checkpoints; armed at every harness send so the baseline is
   *  snapshotted before the provider can write. Set by the server. */
  checkpoints: Pick<CheckpointTurns, 'ensure'> | null = null
  /** The baseline snapshot in flight per session (armBaseline). A send
   *  never waits on it; the harness's first write does (awaitBaseline). */
  private baselines = new Map<string, Promise<void>>()
  /** Chooses each thread's Aliax account and moves a thread when its error
   *  names a usage limit. Set by the server; null sends unscoped and leaves
   *  such errors to the Continue button. */
  limits: AccountRouter | null = null
  /** Whether an account is on file for a provider; null when the host cannot say (no snapshot yet). Set by the server. */
  accountKnown: ((provider: AccountProvider, name: string) => boolean | null) | null = null
  /** The gateway's last refusal per thread (a 401, a 429), read once by the failure classifier while fresh. */
  private refusals = new Map<string, GatewayRefusal & { ts: number }>()
  /** Opens the upstream socket a thread's next request will ride (preconnect.ts). Set by the server; null does nothing. */
  preconnect: ((provider: string, account: string | null) => void) | null = null
  /** Sessions whose turn a usage limit cut off, until they continue: the
   *  pending switch continues the root tree once the session settles. */
  private limited = new Map<string, { switching: Promise<Switched | null> }>()
  /** The pin each live handle was spawned under, so a pin change respawns on the next send. */
  private spawnedPin = new Map<string, string | null>()
  /** Threads told their account left this host, and which: one notice row per account per thread. */
  private accountsGone = new Map<string, string>()
  /** Per root: the switch to continue on, and the short timer that lets
   *  every member of the tree settle so the tree continues once. */
  private limitContinues = new Map<string, { switched: Switched; timer: ReturnType<typeof setTimeout> }>()

  /** Each thread's working notes (threadNotes.ts): notes.md beside its
   *  attachments, mirrored in the store. The dir resolves through
   *  attachmentDir once the server set its context; before that (unit
   *  tests) the mirror alone holds them. */
  readonly notes: ThreadNotes
  /** Lines from the app to the harness outside any user message, waiting
   *  for the next message when no turn was live to take them (whisper). */
  private notices = new Map<string, string[]>()
  /** Threads reminded to write notes in the current context window. */
  private notesReminded = new Set<string>()
  /** The running turn committed or merged / called update_notes. */
  private turnCommitted = new Set<string>()
  private turnNoted = new Set<string>()
  /** A turn ended with a commit and no notes update: a reminder turn is owed. */
  private notesDue = new Set<string>()
  /** One reminder turn per user turn: a model that ignores it is not nagged. */
  private notesReminderSent = new Set<string>()

  constructor(private store: Store) {
    this.notes = new ThreadNotes(store, (sessionId) => {
      try {
        return attachmentDir(sessionId)
      } catch {
        return null
      }
    })
    this.notes.onChange((sessionId, _doc, source) => {
      if (source === 'tool') this.turnNoted.add(sessionId)
    })
    for (const fold of store.listFolds()) this.folds.set(fold.sessionId, fold)
    // The index follows every row the store writes (sessionIndex.ts); a
    // stale one (a version bump) is read again on its next use.
    store.observeSessionRows((change) => {
      if ('row' in change && change.row === null) this.roots.clear()
      const cache = this.indexCache
      if (cache && cache.version === this.store.sessionsVersion) applyRowChange(cache.index, change)
    })
    for (const s of this.indexOf().byId.values()) if (s.context) this.liveContexts.set(s.id, s.context)
    this.scheduler = new ThreadScheduler({
      session: (id) => this.indexOf().byId.get(id) ?? null,
      queued: () => [...this.indexOf().queued.values()],
      hasUserText: (id) => this.store.hasUserText(id),
      startQueued: (id) => this.startQueued(id),
      setQueuedLine: (id, line) => {
        if (line === null) this.queuedLines.delete(id)
        else this.queuedLines.set(id, line)
        const meta = this.store.getSession(id)
        if (meta) this.notifyMeta(meta)
      },
      onMeta: (l) => this.onMeta(l),
      onRemoved: (l) => this.onRemoved(l),
      liveIds: () => this.liveIds(),
      cap: () => this.admission?.cap() ?? Number.POSITIVE_INFINITY,
      reclaimIdle: (n) => this.reclaimIdle(n),
      memoryLow: () => this.admission?.memoryLow() ?? false,
      log: (line) => console.log(line)
    })
    this.scheduler.attach()
  }

  // ── the queue: `after` ───────────────────────────────────────────────

  /** Did the thread's create ask to queue, or does its master make it? */
  private wantsQueue(meta: SessionMeta): boolean {
    return this.queueOptIn.has(meta.id) || !!meta.masterId
  }

  /** Every id holding a running slot (admission.ts): a live harness, or a row in a live status. */
  liveIds(): Set<string> {
    // The index's live rows (unarchived, in a live status) and every harness up or booting; no table read.
    return new Set<string>([...this.handles.keys(), ...this.starting.keys(), ...this.indexOf().live.keys()])
  }

  /** How long a thread sits idle before its harness may give its slot to the queue. */
  reclaimGraceMs = RECLAIM_GRACE_MS

  /** Put down up to `n` idle harnesses, longest idle first, so queued
   *  threads get their slots (scheduler.ts); what the idle sweep does after
   *  ten minutes, sooner because someone waits. A thread with anything
   *  still coming at its idle (the turn pass, queued messages, reports, a
   *  drain) keeps its harness; one idle under the grace is counted in
   *  `nextAt`. */
  reclaimIdle(n: number, now = Date.now()): { freed: number; nextAt: number | null } {
    const ready: { id: string; last: number }[] = []
    let nextAt: number | null = null
    const index = this.indexOf()
    for (const id of this.handles.keys()) {
      if (index.byId.get(id)?.status !== 'idle') continue
      if (this.passActive.has(id) || this.passPending.has(id) || this.draining.has(id)) continue
      if ((this.queues.get(id)?.length ?? 0) > 0 || (this.pendingReports.get(id)?.length ?? 0) > 0) continue
      const last = this.lastActivity.get(id) ?? 0
      if (now - last < this.reclaimGraceMs) {
        nextAt = Math.min(nextAt ?? Infinity, last + this.reclaimGraceMs)
        continue
      }
      ready.push({ id, last })
    }
    ready.sort((a, b) => a.last - b.last)
    const picked = ready.slice(0, n)
    for (const { id } of picked) {
      const handle = this.handles.get(id)
      this.handles.delete(id)
      void handle?.dispose().catch(() => {})
    }
    return { freed: picked.length, nextAt: picked.length < n ? nextAt : null }
  }

  /** The pids of the live harness processes, for the admission sampler. */
  harnessPids(): number[] {
    const pids: number[] = []
    for (const handle of this.handles.values()) {
      const pid = handle.pid?.()
      if (pid) pids.push(pid)
    }
    return pids
  }

  /** The line the host adds to a finished shell call's result (index.ts: a dev server's forward). */
  toolResultTail: ((sessionId: string, callId: string, output: string) => Promise<string | null>) | null = null

  /** One thread's harness pid, null without a live process (threadPorts.ts walks its tree). */
  harnessPid(sessionId: string): number | null {
    return this.handles.get(sessionId)?.pid?.() ?? null
  }

  /** The line a queued row carries ("Queued · 120 of 120 running"), null when not queued. */
  queuedLine(sessionId: string): string | null {
    const line = this.queuedLines.get(sessionId)
    if (line) return line
    const meta = this.indexOf().byId.get(sessionId)
    return meta?.status === 'queued' ? this.scheduler.describe(meta) : null
  }

  /** The boot resume's room (resumeAfterBoot.ts): slots free under the cap,
   *  not counting the threads it is about to resume, whose rows still say
   *  running with no harness behind them. */
  bootResumeRoom(pending: readonly string[]): number {
    const cap = this.admission?.cap() ?? Number.POSITIVE_INFINITY
    const waiting = new Set(pending)
    let live = 0
    for (const id of this.liveIds()) {
      if (waiting.has(id) && !this.handles.has(id) && !this.starting.has(id)) continue
      live++
    }
    return Math.max(0, cap - live)
  }

  /** A boot-resume thread past the cap: queued with its nudge, started by the
   *  scheduler as a slot frees (startQueued → resumeStopped). Its ledger row
   *  stays, so another restart before then resumes it all the same. */
  queueResume(sessionId: string, restartedAt: number): void {
    this.resumePending.delete(sessionId)
    const meta = this.store.getSession(sessionId)
    if (!meta || meta.archived || meta.status === 'paused') return
    this.queuedResumes.set(sessionId, restartedAt)
    this.scheduler.noteQueued(sessionId)
    this.append(sessionId, { type: 'status', status: 'queued' })
    this.scheduler.schedule()
  }

  /** Start a queued thread now: boot the harness and send the message it
   *  holds — the path a send takes, past `after` and past the cap (the
   *  scheduler when the sibling settles or a slot frees; the strip's Start
   *  now). A boot-resume thread is resumed with its nudge instead. */
  async startQueued(sessionId: string): Promise<boolean> {
    const meta = this.store.getSession(sessionId)
    if (!meta || meta.status !== 'queued' || meta.archived) return false
    if (this.startingQueued.has(sessionId)) return false
    this.assertNotMoving(sessionId)
    this.startingQueued.add(sessionId)
    try {
      const restartedAt = this.queuedResumes.get(sessionId)
      if (restartedAt !== undefined) {
        this.queuedResumes.delete(sessionId)
        return await this.resumeStopped(sessionId, { restartedAt })
      }
      const q = this.queues.get(sessionId) ?? []
      const held = q.shift()
      if (held) {
        this.queues.set(sessionId, q)
        this.notifyQueue(sessionId)
        await this.send(sessionId, held.text, held)
        return true
      }
      // Nothing held (the host restarted since): the last user row is the
      // message; its stamp is read back the way an echoed send does.
      const row = this.store.lastUserRow(sessionId)
      if (!row || row.event.type !== 'user-text') {
        this.append(sessionId, { type: 'status', status: 'idle' })
        return false
      }
      await this.send(sessionId, row.event.text, { attachments: row.event.attachments, echoed: { first: row.first } })
      return true
    } finally {
      this.startingQueued.delete(sessionId)
    }
  }

  // ── folds ───────────────────────────────────────────────────────────

  foldOf(sessionId: string): FoldRow | undefined {
    return this.folds.get(sessionId)
  }

  /** append() owns this session's fold row: its task fold is warm, or being
   *  read (warmFold), so the sweep leaves it alone. */
  isFoldWarm(sessionId: string): boolean {
    return this.todoFolds.has(sessionId) || this.warming.has(sessionId)
  }

  /** Resolves once a warm-up in flight for the session has landed (tests, and
   *  anything that must read the fold row a send just started). */
  whenFoldWarm(sessionId: string): Promise<void> {
    return this.warming.get(sessionId)?.done ?? Promise.resolve()
  }

  private putFold(fold: FoldRow): void {
    this.store.putFold(fold)
    this.folds.set(fold.sessionId, fold)
    this.foldDirty.delete(fold.sessionId)
  }

  /** Keep the fold in memory and land its row later (see foldDirty). */
  private deferFold(fold: FoldRow): void {
    this.folds.set(fold.sessionId, fold)
    this.foldDirty.add(fold.sessionId)
    if (!this.foldTimer) this.foldTimer = setTimeout(() => this.flushFolds(), FOLD_LAND_MS)
  }

  /** Write every deferred fold row now. */
  flushFolds(): void {
    if (this.foldTimer) clearTimeout(this.foldTimer)
    this.foldTimer = null
    for (const id of this.foldDirty) {
      const fold = this.folds.get(id)
      if (fold) this.store.putFold(fold)
    }
    this.foldDirty.clear()
  }

  /** Land swept rows and push each session's meta so its sidebar row
   *  fills in live — one shared index for the whole batch. */
  commitFolds(rows: FoldRow[]): void {
    // A session append() took meanwhile has a newer row than the sweep's.
    rows = rows.filter((fold) => !this.isFoldWarm(fold.sessionId))
    for (const fold of rows) this.putFold(fold)
    const index = this.indexOf()
    for (const fold of rows) {
      const meta = index.byId.get(fold.sessionId)
      if (!meta) continue
      const decorated = this.decorate(meta, index)
      for (const l of this.metaListeners) l(decorated, 'folds')
    }
  }

  /**
   * The in-memory task fold, or null while it is being read. A session first
   * appended to in this process starts from its stored fold row: when the row
   * and its task snapshot stand at the log's last row (the usual case: every
   * non-delta append writes them) the fold is warm at once, with no read. A
   * row behind the log, or none, is caught up off the loop (warmFold): the
   * rows through the log's last seq now are read on the reader worker, and
   * every row appended from here on waits in `warming` and folds in after
   * them, so no row is lost or folded twice.
   */
  private todoFoldOf(sessionId: string): TodoFold | null {
    const warm = this.todoFolds.get(sessionId)
    if (warm) return warm
    if (this.warming.has(sessionId)) return null
    const last = this.store.lastSeq(sessionId)
    const fold = this.folds.get(sessionId)
    const current = fold && fold.foldVersion === FOLD_VERSION ? fold : null
    const snap = reviveTodo(current?.todo)
    if (last === 0 || (current && snap && current.foldedSeq >= last && snap.seq >= last)) {
      const todo = snap?.todo ?? newTodoFold()
      this.todoFolds.set(sessionId, todo)
      return todo
    }
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    this.warming.set(sessionId, { live: [], done })
    void this.warmFold(sessionId, current, snap, last).finally(finish)
    return null
  }

  /** Rows appended while a warm-up reads, folded in after it (todoFoldOf). */
  private warming = new Map<string, { live: EventRow[]; done: Promise<void> }>()

  /** Catch a session's folds up to `through` off the loop, fold the rows
   *  appended meanwhile, land the row and push the meta when the sidebar's
   *  view of it moved. */
  private async warmFold(
    sessionId: string,
    current: FoldRow | null,
    snap: { todo: TodoFold; seq: number } | null,
    through: number
  ): Promise<void> {
    const state = current
      ? { todo: snap?.todo ?? newTodoFold(), goal: current.goal, canContinue: current.canContinue, failure: current.failure ?? null, seq: current.foldedSeq }
      : newFoldState()
    const todoSeq = current && snap ? snap.seq : 0
    try {
      await foldLog(this.store, sessionId, state, todoSeq, through)
    } catch (error) {
      // The store closed under the read (shutdown, a test): nothing to land.
      console.warn(`[folds] ${sessionId}: warm-up read failed:`, error instanceof Error ? error.message : error)
      this.warming.delete(sessionId)
      return
    }
    const waiting = this.warming.get(sessionId)
    // Deleted or moved away meanwhile: nothing to keep.
    if (!waiting) return
    this.warming.delete(sessionId)
    for (const row of waiting.live) foldEvent(state, row)
    this.todoFolds.set(sessionId, state.todo)
    const before = this.folds.get(sessionId)
    const next = toFoldRow(sessionId, state)
    this.putFold(next)
    const moved =
      JSON.stringify([before?.tasks ?? null, before?.goal ?? null, before?.canContinue ?? false, before?.failure ?? null]) !==
      JSON.stringify([next.tasks, next.goal, next.canContinue, next.failure])
    const meta = moved ? this.row(sessionId) : null
    if (meta) this.notifyMeta(meta)
  }

  /** A status event appended outside append() (boot reset, pause, resume):
   *  it changes no persisted fold output, so a current row just advances
   *  its watermark; a stale or missing row stays for the sweep. */
  private appendStatus(sessionId: string, status: SessionStatus): EventRow {
    const event: AgentEvent = { type: 'status', status }
    const row = this.store.appendEvent(sessionId, event)
    const waiting = this.warming.get(sessionId)
    if (waiting) {
      waiting.live.push(row)
      return row
    }
    const warm = this.todoFolds.get(sessionId)
    if (warm) foldTodo(warm, event, row.ts)
    const fold = this.folds.get(sessionId)
    if (fold && fold.foldedSeq === row.seq - 1 && fold.foldVersion === FOLD_VERSION) {
      this.putFold({ ...fold, foldedSeq: row.seq, todo: warm ? serializeTodo(warm, row.seq) : fold.todo })
    }
    return row
  }

  /** Snapshot the session's already-dirty files once per session and cwd,
   *  off the send path: a message reaches the harness while this runs. The
   *  store's per-session chain orders every later record behind this
   *  ensure, and the claude driver's write tools wait on it (awaitBaseline),
   *  so the snapshot still precedes the agent's first write. Never throws:
   *  a failure here only costs undo for that turn. */
  private armBaseline(sessionId: string): Promise<void> {
    const cwd = checkpointCwd(this.store.getSession(sessionId))
    if (!this.checkpoints || !cwd) return Promise.resolve()
    const armed = this.checkpoints.ensure(sessionId, cwd).catch(() => {})
    this.baselines.set(sessionId, armed)
    void armed.then(() => {
      if (this.baselines.get(sessionId) === armed) this.baselines.delete(sessionId)
    })
    return armed
  }

  /** Resolves once the session's in-flight baseline (if any) has landed. */
  awaitBaseline(sessionId: string): Promise<void> {
    return this.baselines.get(sessionId) ?? Promise.resolve()
  }

  /**
   * Idle disposal — what keeps dozens of sessions cheap. A handle whose
   * session has sat idle past the threshold is dropped; the session stays
   * listed and the next send lazily restarts the harness via resume.
   * A 'watching' session is never swept, with no cap: its background
   * tasks and crons live in the harness process and resume cannot bring
   * them back. It settles idle on its own when the work lands.
   */
  startIdleSweep(idleMs = IDLE_DISPOSE_MS): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, handle] of this.handles) {
        const meta = this.store.getSession(id)
        const last = this.lastActivity.get(id) ?? 0
        if (meta?.status === 'idle' && now - last > idleMs) {
          this.handles.delete(id)
          void handle.dispose().catch(() => {})
          // A slot freed: the queue moves.
          this.scheduler.schedule()
        }
      }
    }, 60_000)
  }

  /** Shutdown (SIGTERM, before-quit): every thread whose turn is in flight,
   *  with a harness behind it (or one queued for a resume that this process
   *  never got to), so the next boot can resume it (resumeAfterBoot.ts). A
   *  paused thread is never recorded: the user stopped it and it stays so.
   *  The ledger already holds these rows (append() writes one on every
   *  running status and clears it when the turn settles, so a death that
   *  skips this handler, Chromium's D-Bus abort under systemd's group
   *  SIGTERM for one, leaves the right set behind); this pass stamps the
   *  shutdown's time on them for the nudge. Synchronous end to end, because
   *  it runs from a signal handler that exits right after; the batched event
   *  rows land first so the recorded user seq is the one on disk. Returns
   *  the recorded ids. */
  recordForResume(now = Date.now()): string[] {
    this.store.flushEvents()
    const rows: ResumeAfterBootRow[] = []
    for (const s of this.store.listSessions({ archived: false })) {
      if (s.status !== 'running' && s.status !== 'starting') continue
      const inFlight =
        this.handles.has(s.id) || this.starting.has(s.id) || this.resumePending.has(s.id)
      if (!inFlight) continue
      rows.push({
        sessionId: s.id,
        recordedAt: now,
        lastUserSeq: this.store.lastUserTurnSeq(s.id),
        shutdownAt: now
      })
    }
    this.store.recordResumeAfterBoot(rows)
    return rows.map((r) => r.sessionId)
  }

  /** The seq of each session's latest user turn this process appended; the
   *  ledger row written on the running status carries it. */
  private readonly lastUserSeq = new Map<string, number>()

  /** The ledger row for a thread whose turn a harness is working now. */
  private recordMidTurn(sessionId: string, at: number): void {
    this.store.recordResumeAfterBoot([
      { sessionId, recordedAt: at, lastUserSeq: this.lastUserSeq.get(sessionId) ?? null, shutdownAt: null }
    ])
  }

  /** Boot a fresh harness on a thread whose last one is gone, and tell it to
   *  pick the turn back up. The one Resume path for a dead harness: the boot
   *  resumer (resumeAfterBoot.ts, with the shutdown's time), the strip's
   *  Resume button and `session.resume` on a stopped thread all come here.
   *  The row may still say running (boot, before the liveness sweep) or
   *  stopped. A paused, archived or missing thread is left alone (false).
   *  Throws when the harness cannot boot or refuses the nudge; the row then
   *  reads error, as a failed Continue does. */
  async resumeStopped(sessionId: string, opts: { restartedAt?: number } = {}): Promise<boolean> {
    this.resumePending.delete(sessionId)
    const meta = this.store.getSession(sessionId)
    if (!meta || meta.archived || meta.status === 'paused') return false
    this.assertNotMoving(sessionId)
    await this.dropHandle(sessionId)
    this.harnessGoneSince.delete(sessionId)
    // The working clock carries on from where the dead harness left it.
    const frozen = Math.max(
      0,
      meta.status === 'stopped'
        ? (meta.frozenActiveElapsed ?? 0)
        : meta.busySince
          ? Date.now() - meta.busySince
          : 0
    )
    const when = opts.restartedAt ? new Date(opts.restartedAt).toISOString() : null
    try {
      void this.armBaseline(sessionId)
      const handle = await this.handleFor(sessionId)
      this.lastActivity.set(sessionId, Date.now())
      const cause = when
        ? `The host restarted during your turn at ${when}; continue where you left off.`
        : 'The harness behind your turn was gone and has been started again; continue where you left off.'
      await handle.send(
        `<host-restarted>\n${cause} Check your task list and your last few actions, finish anything half-done, and keep going. Do not restart completed work. If the work was already complete, say so in one short line.\n</host-restarted>`
      )
    } catch (error) {
      const current = this.store.getSession(sessionId)
      if (current && current.status !== 'paused') {
        this.append(sessionId, { type: 'status', status: 'error' })
      }
      throw error
    }
    const now = Date.now()
    this.append(sessionId, {
      type: 'status',
      status: 'running',
      detail: when ? `Resumed after the host restarted at ${when}` : 'Resumed on a fresh harness'
    })
    const next = this.store.updateSession(sessionId, {
      status: 'running',
      busySince: now - frozen,
      pausedAt: null,
      frozenActiveElapsed: null
    })
    this.lastActivity.set(sessionId, now)
    if (next) this.notifyMeta(next)
    return true
  }

  /** Every few seconds: a running (or starting) thread with no live harness
   *  behind it, for longer than the grace, reads stopped. That is a thread
   *  the boot found running with nothing recorded for it (a crash, a
   *  SIGKILL), a boot resume that never produced a handle, or a harness
   *  process that died without the driver settling the status. */
  startLivenessSweep(graceMs = HARNESS_GONE_GRACE_MS, everyMs = HARNESS_GONE_SWEEP_MS): void {
    this.livenessTimer = setInterval(() => whenLoopIdle(() => this.sweepLiveness(graceMs)), everyMs)
    this.livenessTimer.unref?.()
  }

  /** One pass of the liveness sweep; returns the threads it flipped to stopped. */
  sweepLiveness(graceMs = HARNESS_GONE_GRACE_MS, now = Date.now()): string[] {
    const flipped: string[] = []
    // The index, copied: markStopped writes rows while this walks.
    for (const s of [...this.indexOf().byId.values()]) {
      if (s.archived) continue
      const candidate =
        (s.status === 'running' || s.status === 'starting') &&
        !this.starting.has(s.id) &&
        !this.resumePending.has(s.id) &&
        !this.store.movingTo(s.id)
      const handle = candidate ? this.handles.get(s.id) : undefined
      if (!candidate || (handle && handle.alive?.() !== false)) {
        this.harnessGoneSince.delete(s.id)
        continue
      }
      const since = this.harnessGoneSince.get(s.id)
      if (since === undefined) {
        this.harnessGoneSince.set(s.id, now)
        continue
      }
      if (now - since < graceMs) continue
      this.harnessGoneSince.delete(s.id)
      this.markStopped(s.id, now)
      flipped.push(s.id)
    }
    return flipped
  }

  /** The harness behind a running turn is gone for good: the row reads
   *  stopped with its working time frozen (Resume carries it on), the dead
   *  handle is dropped, and the transcript gets the line that says why. */
  private markStopped(sessionId: string, now: number): void {
    const meta = this.store.getSession(sessionId)
    if (!meta) return
    const handle = this.handles.get(sessionId)
    if (handle) {
      this.handles.delete(sessionId)
      void handle.dispose().catch(() => {})
    }
    this.denyPendingApprovals(sessionId)
    const frozen = Math.max(0, meta.busySince ? now - meta.busySince : (meta.frozenActiveElapsed ?? 0))
    this.append(sessionId, { type: 'status', status: 'stopped', detail: 'The harness behind this turn is gone' })
    this.activities.delete(sessionId)
    this.watching.delete(sessionId)
    const next = this.store.updateSession(sessionId, {
      status: 'stopped',
      busySince: null,
      frozenActiveElapsed: frozen
    })
    if (next) this.notifyMeta(next)
  }

  private livenessTimer: ReturnType<typeof setInterval> | null = null

  /** Sessions a boot resume still owes a harness (resumeAfterBoot.ts): the
   *  liveness sweep leaves them alone while they wait their turn in the pool,
   *  and a shutdown meanwhile records them again. */
  readonly resumePending = new Set<string>()
  /** When a running thread was first seen with no harness behind it (the
   *  liveness sweep, startLivenessSweep): past the grace it reads stopped. */
  private readonly harnessGoneSince = new Map<string, number>()

  /** At boot no harness handles exist, so a session persisted as waiting or
   *  watching is stale from a previous process — reset it, or the sidebar
   *  shows a question nobody can answer and background work that died with
   *  the process. The dead process also never wrote its closing status
   *  event, so refolds would see a forever-open turn: append the synthetic
   *  idle directly (none of append()'s live-session side effects — queue
   *  drain, parent supervision — belong at boot). A running or starting row
   *  is left as it is: the boot resume (resumeAfterBoot.ts) brings back the
   *  ones the shutdown recorded, and the liveness sweep flips the rest to
   *  stopped once the grace is up, so a crash mid-turn reads as what it is
   *  and offers Resume, instead of a quiet idle. */
  resetStaleStatuses(): void {
    for (const s of this.store.listSessions()) {
      if (s.status === 'waiting' || s.status === 'watching') {
        this.appendStatus(s.id, 'idle')
        this.store.updateSession(s.id, { status: 'idle', busySince: null })
      }
    }
  }

  /** Decorated sessions: the unarchived ones by default, the archived ones
   *  with `archived: true`, all of them with `archived: undefined`. The
   *  index that decorates is always built over every row, so a child of an
   *  archived root still decorates right. */
  list(opts: { archived?: boolean; projectId?: string } = { archived: false }): SessionMeta[] {
    return timed('registry.list', () => {
      const sessions = this.store.listSessions()
      const index = this.indexOf(sessions)
      const wanted = sessions.filter(
        (s) =>
          (opts.archived === undefined || s.archived === opts.archived) &&
          (opts.projectId === undefined || s.projectId === opts.projectId)
      )
      return wanted.map((s) => this.decorate(s, index))
    })
  }

  /** One decorated session — the lookup-by-id every caller used to do
   *  with list().find(), which decorated all n sessions to read one. */
  get(sessionId: string): SessionMeta | null {
    const index = this.indexOf()
    const meta = index.byId.get(sessionId)
    return meta ? this.decorate(meta, index) : null
  }

  /** A parent's direct children, decorated. */
  childrenOf(parentId: string): SessionMeta[] {
    const index = this.indexOf()
    return this.store.childrenOf(parentId).map((s) => this.decorate(s, index))
  }

  /** The lookups decorate(), the scheduler, the liveness sweep and the
   *  batch read (sessionIndex.ts): built once, then kept current by every
   *  row the store writes, so a context tick or a status change patches one
   *  row instead of re-reading the table (3-4 ms on a 3k-session table, and
   *  a running fleet changed rows 175 times a second). Built again only
   *  when the store bumps its version (a move's raw writes). */
  private indexCache: { version: number; index: SessionIndex } | null = null
  private indexOf(sessions?: SessionMeta[]): SessionIndex {
    const version = this.store.sessionsVersion
    if (this.indexCache?.version === version) return this.indexCache.index
    this.roots.clear()
    const index = buildSessionIndex(sessions ?? this.store.listSessions())
    this.indexCache = { version, index }
    return index
  }

  /** The unarchived root threads of a master, decorated, oldest first
   *  (batch.ts batchChildren): read off the index's byMaster, never the table. */
  batchChildren(masterId: string): SessionMeta[] {
    const index = this.indexOf()
    return (index.byMaster.get(masterId) ?? [])
      .filter((s) => !s.archived)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => this.decorate(s, index))
  }

  /** Was this session running a disk-writing tool at ts (with grace for
   *  writes that flush just after the result)? Livediff's ownership probe. */
  diskActiveAt(sessionId: string, ts: number): boolean {
    const calls = this.diskToolCalls.get(sessionId)
    if (!calls) return false
    for (const closed of calls.values()) {
      if (closed === null || ts <= closed + DISK_TOOL_GRACE_MS) return true
    }
    return false
  }

  /** Roots already walked: a thread's parent chain never changes. Cleared
   *  when a row leaves the index or the index is read again. */
  private roots = new Map<string, string>()

  /** Root thread of a subagent chain — the board that displays its work.
   *  Asked on every appended row (the notifier, every meta push of a
   *  subagent): walked once over the index, then remembered. */
  rootSessionOf(sessionId: string): string {
    const known = this.roots.get(sessionId)
    if (known !== undefined) return known
    const index = this.indexOf()
    let cur = index.byId.get(sessionId)
    if (!cur) return sessionId
    for (let hops = 0; cur.parentId && hops < 20; hops++) {
      const parent: SessionMeta | undefined = index.byId.get(cur.parentId)
      if (!parent) break
      cur = parent
    }
    this.roots.set(sessionId, cur.id)
    return cur.id
  }

  /** A thread's parent off the index, never the table (focus.ts). */
  parentOf(sessionId: string): string | null {
    return this.row(sessionId)?.parentId ?? null
  }

  /** A root thread's master off the index; null for a subagent or a thread in no batch. */
  masterOf(sessionId: string): string | null {
    const row = this.row(sessionId)
    return row && !row.parentId ? (row.masterId ?? null) : null
  }

  /** The stored row, from the index: no SELECT (the append path, get()). */
  private row(sessionId: string): SessionMeta | null {
    return this.indexOf().byId.get(sessionId) ?? null
  }

  /** The thread's current task tally: the warm fold if append() has
   *  touched it this process, else the persisted row, else (not swept
   *  yet) none. Never reads the event log. */
  private tasksOf(sessionId: string): TaskTally | null {
    const warm = this.todoFolds.get(sessionId)
    return warm ? tallyOf(warm) : (this.folds.get(sessionId)?.tasks ?? null)
  }

  /** The thread's current task list for a master's board (boardDigest.ts):
   *  the warm fold, else the stored snapshot (revived once per row). Never
   *  reads the event log. */
  todoListOf(sessionId: string): readonly { status: string; name: string }[] | null {
    const warm = this.todoFolds.get(sessionId)
    if (warm) return warm.list
    const fold = this.folds.get(sessionId)
    if (!fold?.todo) return null
    const cached = this.revivedTodos.get(fold)
    if (cached !== undefined) return cached
    const list = reviveTodo(fold.todo)?.todo.list ?? null
    this.revivedTodos.set(fold, list)
    return list
  }

  private revivedTodos = new WeakMap<FoldRow, { status: string; name: string }[] | null>()

  /** The thread's active goal, from its persisted fold row. */
  private goalOf(sessionId: string): GoalState {
    return this.folds.get(sessionId)?.goal ?? null
  }

  /** Whether stored work still ends in an uncleared, unsuperseded error. */
  private storedContinuableError(sessionId: string): boolean {
    return this.folds.get(sessionId)?.canContinue ?? false
  }

  /** Whether the user can still recover this session. Work that is moving
   *  again — restarted by hand, by its parent, or by a queued message —
   *  never advertises failure, even before its first new event lands. The
   *  stored fold is untouched, so an error nothing superseded comes back
   *  if the session settles without producing anything. */
  private canContinueError(meta: SessionMeta): boolean {
    if (LIVE_STATUSES.has(meta.status)) return false
    return this.storedContinuableError(meta.id)
  }

  /** Where a session's report and angle files live: the workspace root (the
   *  repo's main checkout), so they outlive a worktree project's teardown and
   *  every project of the repo can cite them. A loose session uses its
   *  workspace's path, else its cwd. */
  reportsRootFor(meta: Pick<SessionMeta, 'projectId' | 'workspaceId' | 'cwd'>): string {
    const project = meta.projectId ? this.store.getProject(meta.projectId) : null
    const workspaceId = project?.workspaceId ?? meta.workspaceId
    const ws = workspaceId ? this.store.listWorkspaces().find((w) => w.id === workspaceId) : null
    return ws?.path ?? meta.cwd
  }

  /** The explicit pin that applies to a thread (its project's, else its workspace's). */
  pinOf(meta: SessionMeta): ResolvedPin | null {
    const project = meta.projectId ? this.store.getProject(meta.projectId) : null
    const workspaceId = project?.workspaceId ?? meta.workspaceId
    const workspace = workspaceId ? (this.store.listWorkspaces().find((w) => w.id === workspaceId) ?? null) : null
    return resolvePin(meta, project, workspace)
  }

  /** The gateway refused a thread's request upstream: kept for the next
   *  error row's classification (a 401 token_expired on a non-owner
   *  instance, a 429), while it is fresh. */
  noteRefusal(sessionId: string, refusal: GatewayRefusal): void {
    this.refusals.set(sessionId, { ...refusal, ts: Date.now() })
  }

  private takeRefusal(sessionId: string): GatewayRefusal | null {
    const r = this.refusals.get(sessionId)
    if (!r) return null
    this.refusals.delete(sessionId)
    if (Date.now() - r.ts > REFUSAL_FRESH_MS) return null
    const { ts: _ts, ...refusal } = r
    return refusal
  }

  /** The host's verdict on an error row: the harness's words, the gateway's
   *  last refusal and the routing (is the account still on file, does the
   *  catalog offer the model), stamped once so every surface reads it. */
  private classify(sessionId: string, event: Extract<AgentEvent, { type: 'error' }>): Failure {
    const meta = this.store.getSession(sessionId)
    const provider = meta?.provider ?? 'claude'
    const account = meta?.account ?? null
    const model = meta?.model ?? null
    const listed = model ? CATALOG[provider]?.models.some((m) => m.id === model) : false
    return classifyFailure({
      message: event.message,
      provider,
      model,
      account,
      accountKnown: account && isRoutedProvider(provider) ? (this.accountKnown?.(provider, account) ?? null) : null,
      limit: event.limit ?? null,
      // A row the catalog lists but hides here (minCodexVersion) is unavailable; a model it never listed is not ours to judge.
      modelVisible: !listed || visibleModels(provider).some((m) => m.id === model),
      gateway: this.takeRefusal(sessionId)
    })
  }

  /** The failure card's "Route automatically": forget the thread's sticky
   *  account and the sign-in row's filter, take the best account for its
   *  model now (a dead one is out of routing), and if that is somewhere
   *  new drop the harness so the next send respawns there. Answers where
   *  the thread landed and whether it moved. */
  async reroute(sessionId: string): Promise<{ account: string | null; moved: boolean }> {
    const meta = this.store.getSession(sessionId)
    if (!meta) throw new Error(`unknown session ${sessionId}`)
    if (LIVE_STATUSES.has(meta.status) || this.starting.has(sessionId)) throw new Error('the thread is still working')
    const before = meta.account ?? null
    this.signIns.delete(sessionId)
    this.expectAccount(sessionId, { fresh: true })
    const after = this.store.getSession(sessionId)?.account ?? null
    const moved = after !== before
    if (moved) await this.dropHandle(sessionId)
    return { account: after, moved }
  }

  /**
   * The account a thread's next request will spend from: the row's (the
   * gateway keeps it current), else what the router would choose now for
   * an unscoped start. Only Claude and Codex ride the gateway.
   */
  private preconnectFor(meta: SessionMeta): void {
    if (!this.preconnect || (meta.provider !== 'claude' && meta.provider !== 'codex')) return
    const account = meta.account ?? this.limits?.routeFor(meta, this.pinOf(meta)).current ?? null
    this.preconnect(meta.provider, account)
  }

  /** The composer of an idle thread gained focus: a turn may follow. A live turn already holds its socket. */
  preconnectIdle(sessionId: string): boolean {
    const meta = this.store.getSession(sessionId)
    if (!meta) throw new Error(`unknown session: ${sessionId}`)
    if (meta.status === 'running' || meta.status === 'starting' || meta.status === 'waiting') return false
    this.preconnectFor(meta)
    return true
  }

  /** The gateway (or a text-path failover) moved a thread: its row follows. */
  setAccount(sessionId: string, account: string | null): void {
    // Landing elsewhere lifts the sign-in row's filter; coming back to the
    // same dead account (nothing else had room) does not.
    if (this.signIns.get(sessionId) !== account) this.signIns.delete(sessionId)
    const meta = this.store.getSession(sessionId)
    if (!meta || (meta.account ?? null) === account) return
    const next = this.store.setSessionAccount(sessionId, account)
    if (next) this.notifyMeta(next)
  }

  /**
   * The gateway had nothing to route a thread's request under: its account's
   * sign-in is dead (401) and no other account has room. One row names the
   * account; the harness's own wording for the same 401 ("workspace routing
   * discovery unauthorized (401)") is dropped while the thread stays there.
   */
  signInNeeded(sessionId: string, account: string): void {
    if (this.signIns.get(sessionId) === account) return
    this.signIns.set(sessionId, account)
    this.append(sessionId, { type: 'error', message: `Aliax account ${account} needs sign-in` })
  }

  /** The account a thread is expected to spend from, computed ahead of its
   *  spawn so its row shows it at once: the pin that applies, else the
   *  sticky current account while it has room, else the best account for
   *  its model. The same pick the spawn makes; it becomes the sticky input
   *  to that spawn, and the gateway corrects the row when traffic lands
   *  elsewhere. `fresh` drops the sticky account (a model change: the
   *  prompt cache is per model, so nothing is kept by staying) and takes
   *  the best pick for the model. An empty snapshot (no accounts known
   *  yet) changes nothing. */
  expectAccount(sessionId: string, opts?: RouteOptions): void {
    const meta = this.store.getSession(sessionId)
    if (!meta || !this.limits || !isRoutedProvider(meta.provider)) return
    const pin = this.pinOf(meta)
    const { current, vanished } = this.limits.routeFor(meta, pin, opts)
    if (vanished) this.accountGone(meta, pin, vanished)
    // A vanished sticky account with nothing picked yet clears the row: the chip says Auto.
    if (current || vanished) this.setAccount(sessionId, current)
  }

  /**
   * The thread's pinned or sticky account is no longer on this host (deleted
   * here, or dropped on its owner's word, remote/accountSync.ts): the pin at
   * its level loses that provider, so every thread under it routes
   * automatically from now on, and the thread gets one plain row saying so,
   * once per account. The next send respawns under the new route (the pin
   * the harness was spawned with no longer applies).
   */
  private accountGone(meta: SessionMeta, pin: ResolvedPin | null, vanished: { pin?: string; sticky?: string }): void {
    if (vanished.pin && pin && pin.name === vanished.pin && isRoutedProvider(meta.provider)) {
      const provider = meta.provider
      if (pin.level === 'project' && meta.projectId) {
        const project = this.store.getProject(meta.projectId)
        if (project?.accountPins?.[provider] === pin.name) {
          const { [provider]: _gone, ...rest } = project.accountPins
          this.store.setProjectAccounts(meta.projectId, rest)
          this.notifyCatalog('projects')
        }
      } else if (pin.level === 'workspace') {
        const workspaceId = (meta.projectId ? this.store.getProject(meta.projectId)?.workspaceId : null) ?? meta.workspaceId
        const workspace = workspaceId ? this.store.listWorkspaces().find((w) => w.id === workspaceId) : null
        if (workspace?.accountPins?.[provider] === pin.name) {
          const { [provider]: _gone, ...rest } = workspace.accountPins
          this.store.setWorkspaceAccounts(workspace.id, rest)
          this.notifyCatalog('workspaces')
        }
      }
    }
    const name = vanished.pin ?? vanished.sticky
    if (!name || this.accountsGone.get(meta.id) === name) return
    this.accountsGone.set(meta.id, name)
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    this.append(meta.id, { type: 'notice', kind: 'account-gone', account: name, message: `Account ${name} is gone from this host; routing automatically from here (${time})` })
    console.log(`[accounts] ${meta.id}: account ${name} is gone from this host${vanished.pin ? ' (pin cleared)' : ''}; routing automatically`)
  }

  /** Threads with a live status right now (the stall log's `running=`). */
  runningCount(): number {
    let n = 0
    for (const s of this.indexOf().byId.values()) if (LIVE_STATUSES.has(s.status)) n++
    return n
  }

  /** Live threads per account for a provider: running, watching, or still
   *  starting. What the account picker spreads new threads by. Walks only
   *  the threads holding a process: a live status never outlives its
   *  handle, and refreshAccounts asks this once per open thread, so a
   *  whole-table read here re-read 3k rows 1.8k times per snapshot. */
  liveLoad(provider: SessionMeta['provider']): Record<string, number> {
    const load: Record<string, number> = {}
    for (const id of new Set([...this.handles.keys(), ...this.starting.keys()])) {
      const s = this.store.getSession(id)
      if (!s || s.archived || s.provider !== provider || !s.account) continue
      if (!LIVE_STATUSES.has(s.status) && !this.starting.has(s.id)) continue
      load[s.account] = (load[s.account] ?? 0) + 1
    }
    return load
  }

  /** Keep a thread's shown account the one its next send will use. With
   *  no live process nothing is warm on its account, so it re-picks fresh:
   *  the best account for its model now. With a process the sticky pick
   *  stands while it has room and is not outclassed (an Opus thread on an
   *  account whose Fable window came back leaves it for one whose Fable
   *  window is spent — chooseAccount); when it moved the process is
   *  dropped so the next send respawns under the new account (resume keeps
   *  the conversation; the prompt cache is lost). A thread mid-turn is
   *  left alone: the gateway moves that one itself. */
  refreshAccount(sessionId: string, load?: (provider: SessionMeta['provider']) => Record<string, number>): void {
    const meta = this.store.getSession(sessionId)
    if (!meta || meta.archived || !isRoutedProvider(meta.provider)) return
    if (LIVE_STATUSES.has(meta.status) || this.starting.has(sessionId)) return
    const live = this.handles.has(sessionId)
    this.expectAccount(sessionId, { fresh: !live, load: load?.(meta.provider) })
    if (live && (this.store.getSession(sessionId)?.account ?? null) !== (meta.account ?? null)) {
      void this.dropHandle(sessionId)
    }
  }

  /** Every open thread: at boot (once the accounts service knows any
   *  account) and whenever the snapshot changes, so coming back to a
   *  thread never shows a stale pick. */
  refreshAccounts(): void {
    this.expectAccountsUnder(() => true)
  }

  /** A scope pin changed: threads under it show their new pick now. The
   *  live load is read once per provider for the whole pass: refreshing a
   *  thread never changes it (live threads are skipped), and reading it per
   *  thread made a pass cost threads × live threads. */
  private expectAccountsUnder(match: (meta: SessionMeta) => boolean): void {
    const loads = new Map<SessionMeta['provider'], Record<string, number>>()
    const load = (provider: SessionMeta['provider']): Record<string, number> => {
      let l = loads.get(provider)
      if (!l) loads.set(provider, (l = this.liveLoad(provider)))
      return l
    }
    // 224 idle threads re-picked on every snapshot once held the loop 2.2 s:
    // the pass walks the index (copied: it writes rows as it goes), runs only
    // when the pickable set moved (index.ts), and notifies once it is written.
    const outer = this.deferredMeta
    const deferred = (this.deferredMeta ??= new Map())
    try {
      for (const s of [...this.indexOf().byId.values()]) if (!s.archived && match(s)) this.refreshAccount(s.id, load)
    } finally {
      if (!outer) {
        this.deferredMeta = null
        for (const meta of deferred.values()) this.notifyMeta(meta, 'accounts')
      }
    }
  }

  /** A thread's error named a usage limit: ask for the next account now
   *  (the poll runs while the turn winds down) and continue the root tree
   *  once this session settles. One switch per session per limit event. */
  private onLimitError(sessionId: string, window: LimitWindow): void {
    if (window === 'transient' || !this.limits || this.limited.has(sessionId)) return
    const meta = this.store.getSession(sessionId)
    if (!meta || !isRoutedProvider(meta.provider)) return
    const switching = this.limits
      .failover(sessionId, { provider: meta.provider, model: meta.model ?? null, window, account: meta.account ?? null })
      .then((switched) => {
        if (switched) this.setAccount(sessionId, switched.to)
        return switched
      })
      .catch((err) => {
        console.warn(`[limits] failover for ${sessionId} failed:`, err)
        return null
      })
    this.limited.set(sessionId, { switching })
    if (!LIVE_STATUSES.has(meta.status)) this.continueAfterLimit(sessionId)
  }

  /** The limited session has settled: once the switch lands, continue its
   *  root tree after a short delay so siblings on the same limit join. */
  private continueAfterLimit(sessionId: string): void {
    const entry = this.limited.get(sessionId)
    if (!entry) return
    void entry.switching.then((switched) => {
      if (this.limited.get(sessionId) !== entry) return
      if (!switched) {
        // No account has room: the error stays and the Continue button waits.
        this.limited.delete(sessionId)
        return
      }
      const rootId = this.rootSessionOf(sessionId)
      const pending = this.limitContinues.get(rootId)
      if (pending) clearTimeout(pending.timer)
      const timer = setTimeout(() => {
        this.limitContinues.delete(rootId)
        void this.continueRun(rootId, `a usage limit on ${switched.from}; the app switched to ${switched.to}`).catch((err) => {
          console.warn(`[limits] automatic continue of ${rootId} failed:`, err)
        })
      }, LIMIT_CONTINUE_DELAY_MS)
      this.limitContinues.set(rootId, { switched, timer })
    }).catch((err) => {
      console.warn(`[limits] continue after limit for ${sessionId} failed:`, err)
    })
  }

  /** When the session last produced or received anything (drives
   *  idleForSeconds in the orchestrator's supervision tools). */
  lastActivityAt(sessionId: string): number {
    return this.lastActivity.get(sessionId) ?? this.store.getSession(sessionId)?.updatedAt ?? 0
  }

  // ── workspaces & projects ──────────────────────────────────────────

  async createWorkspace(path: string, name?: string, opts: { linkId?: string } = {}): Promise<WorkspaceMeta> {
    const existing = this.store.listWorkspaces().find((w) => w.path === path)
    if (existing) return existing
    // A workspace names a folder on this host. A client that has not yet
    // heard which host owns a folder (another host's catalog still loading)
    // falls back to this one; a folder that is not here is not ours.
    if (!isDirectory(path)) throw new Error(`no such folder on this host: ${path}`)
    const git = await isGitRepo(path)
    const meta: WorkspaceMeta = {
      id: nanoid(12),
      name: name ?? basename(path),
      path,
      git,
      githubRepo: git ? await githubRepoOf(path) : null,
      githubRepoCheckedAt: git ? Date.now() : null,
      ...(opts.linkId ? { linkId: opts.linkId } : {}),
      createdAt: Date.now()
    }
    this.store.insertWorkspace(meta)
    for (const session of this.store.listSessions()) {
      if (session.projectId || session.workspaceId || session.cwd !== path) continue
      this.store.setSessionWorkspace(session.id, meta.id)
      const next = this.store.getSession(session.id)
      if (next) this.notifyMeta(next)
    }
    this.notifyCatalog('workspaces')
    return meta
  }

  listWorkspaces(): WorkspaceMeta[] {
    return this.store.listWorkspaces()
  }

  /** Re-reads the GitHub repo of every git workspace whose git config changed
   *  since it was last read (or was never read). Reads files only, never
   *  spawns, and pushes the catalog only when a slug changed. The inbox
   *  refresh calls this; nothing runs it at boot. */
  async refreshWorkspaceRepos(): Promise<WorkspaceMeta[]> {
    let changed = false
    for (const ws of this.store.listWorkspaces()) {
      if (!ws.git) continue
      const checkedAt = ws.githubRepoCheckedAt ?? null
      if (checkedAt !== null) {
        const mtime = await gitConfigMtime(ws.path)
        if (mtime !== null && mtime <= checkedAt) continue
      }
      const repo = await githubRepoOf(ws.path)
      this.store.setWorkspaceGithubRepo(ws.id, repo, Date.now())
      if (repo !== (ws.githubRepo ?? null)) changed = true
    }
    if (changed) this.notifyCatalog('workspaces')
    return this.store.listWorkspaces()
  }

  /** Removes the workspace, its projects, and their threads (worktrees stay on disk). */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    for (const s of this.store.sessionsOfWorkspace(workspaceId)) {
      if (!s.parentId) await this.delete(s.id) // one-off chats; roots cascade
    }
    const projectIds = this.store.deleteWorkspace(workspaceId)
    for (const pid of projectIds) await this.deleteProjectSessions(pid)
    this.notifyCatalog('workspaces')
    this.notifyCatalog('projects')
  }

  async createProject(
    workspaceId: string,
    name: string,
    mode: ProjectMode,
    opts: { branch?: string; baseRef?: string; linkId?: string } = {}
  ): Promise<ProjectMeta> {
    const ws = this.store.listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) throw new Error(`unknown workspace: ${workspaceId}`)
    let cwd = ws.path
    let branch: string | null = null
    if (mode === 'worktree') {
      if (!ws.git) throw new Error('worktree projects need a git workspace')
      const wt = await addProjectWorktree(ws.path, name, opts)
      cwd = wt.cwd
      branch = wt.branch
    } else {
      branch = await currentBranch(ws.path)
    }
    const meta: ProjectMeta = {
      id: nanoid(12),
      workspaceId,
      name,
      mode,
      branch,
      cwd,
      archived: false,
      ...(opts.linkId ? { linkId: opts.linkId } : {}),
      createdAt: Date.now()
    }
    this.store.insertProject(meta)
    void ensureLocalExclude(cwd) // plan docs (.temp-code/) stay out of git
    seedJournal(meta) // PROJECT.md — the shared journal threads append to
    this.notifyCatalog('projects')
    return meta
  }

  listProjects(): ProjectMeta[] {
    return this.store.listProjects()
  }

  getProject(projectId: string): ProjectMeta | null {
    return this.store.getProject(projectId)
  }

  renameProject(projectId: string, name: string): void {
    const t = name.trim()
    if (!t) return
    this.store.renameProject(projectId, t)
    this.touchProjectSettings(projectId)
  }

  setProjectAccounts(projectId: string, pins: AccountPins): void {
    if (!this.store.getProject(projectId)) throw new Error(`unknown project: ${projectId}`)
    this.store.setProjectAccounts(projectId, pins)
    this.touchProjectSettings(projectId)
    this.expectAccountsUnder((s) => s.projectId === projectId)
  }

  /** A project's preamble: edits reach new threads only (a running thread
   *  keeps the text it opened with, on its first user-text row). */
  setProjectPreamble(projectId: string, preamble: string | null, enabled: boolean): void {
    if (!this.store.getProject(projectId)) throw new Error(`unknown project: ${projectId}`)
    this.store.setProjectPreamble(projectId, normalizePreamble(preamble), enabled)
    this.touchProjectSettings(projectId)
  }

  /** A setting of the project changed here: stamp `settings_updated_at` and
   *  push the catalog, so a follower on another host (the Mac, for a project
   *  whose home is the box) hears it (shared/projectLinks.ts). */
  private touchProjectSettings(projectId: string, at: number = Date.now()): void {
    this.store.touchProjectSettings(projectId, at)
    this.notifyCatalog('projects')
  }

  /** One project across hosts (shared/projectLinks.ts): the linker on the
   *  peer holder stamping this host's rows with the ids their copies share.
   *  A row that already carries the id is untouched; an unknown id is skipped. */
  linkCatalog(args: CatalogLinkArgs): void {
    const workspaces = this.store.listWorkspaces()
    const projects = this.store.listProjects()
    let ws = false
    let pr = false
    for (const { id, linkId } of args.workspaces) {
      const row = workspaces.find((w) => w.id === id)
      if (!row || row.linkId === linkId) continue
      this.store.setWorkspaceLink(id, linkId)
      ws = true
    }
    for (const { id, linkId } of args.projects) {
      const row = projects.find((p) => p.id === id)
      if (!row || row.linkId === linkId) continue
      this.store.setProjectLink(id, linkId)
      pr = true
    }
    if (ws) this.notifyCatalog('workspaces')
    if (pr) this.notifyCatalog('projects')
  }

  /** A project's link facts for a start on another host (crossHostAgents.ts):
   *  the far host finds or creates its copy by them (projectLinks.ts). A
   *  project or workspace with no link id yet gets one minted and stamped
   *  here, and the catalog pushed, so the far copy carries a durable id. */
  projectLinkFacts(projectId: string): ProjectLinkFacts | null {
    const p = this.store.getProject(projectId)
    const ws = p ? this.store.listWorkspaces().find((w) => w.id === p.workspaceId) : null
    if (!p || !ws) return null
    const workspaceLinkId = ws.linkId || newWorkspaceLinkId()
    const linkId = p.linkId || newProjectLinkId()
    if (!ws.linkId) {
      this.store.setWorkspaceLink(ws.id, workspaceLinkId)
      this.notifyCatalog('workspaces')
    }
    if (!p.linkId) {
      this.store.setProjectLink(p.id, linkId)
      this.notifyCatalog('projects')
    }
    return {
      linkId,
      workspaceLinkId,
      name: p.name,
      branch: p.branch,
      mode: p.mode,
      workspacePath: ws.path,
      cwd: p.cwd,
      ...(ws.githubRepo ? { workspaceGithubRepo: ws.githubRepo } : {})
    }
  }

  /** Everything the project's settings home holds for it, as one bundle. */
  getProjectSettings(projectId: string): ProjectSettingsBundle {
    const p = this.store.getProject(projectId)
    if (!p) throw new Error(`unknown project: ${projectId}`)
    return {
      name: p.name,
      archived: p.archived,
      preamble: p.preamble ?? null,
      preambleEnabled: p.preambleEnabled !== false,
      accountPins: p.accountPins ?? {},
      review: this.getReviewSettings(projectId),
      plans: this.getPlanSettings(projectId),
      build: this.getProjectBuild(projectId),
      turnPass: this.getProjectTurnPass(projectId),
      updatedAt: p.settingsUpdatedAt ?? null
    }
  }

  /** Writes the bundle whole. The home stamps now; a follower passes the
   *  home's stamp (`at`) so the copies agree on when it changed. */
  setProjectSettings(projectId: string, bundle: ProjectSettingsBundle, at: number = Date.now()): void {
    const p = this.store.getProject(projectId)
    if (!p) throw new Error(`unknown project: ${projectId}`)
    const name = bundle.name.trim()
    if (name && name !== p.name) this.store.renameProject(projectId, name)
    if (bundle.archived !== p.archived) this.store.setProjectArchived(projectId, bundle.archived)
    this.store.setProjectPreamble(projectId, normalizePreamble(bundle.preamble), bundle.preambleEnabled)
    this.store.setProjectAccounts(projectId, bundle.accountPins)
    this.store.setSetting(`review:project:${projectId}`, bundle.review ? JSON.stringify(bundle.review) : null)
    setPlanSettings(this.store, projectId, bundle.plans)
    this.store.setSetting(`build:project:${projectId}`, bundle.build ? JSON.stringify(bundle.build) : null)
    this.store.setSetting(`turn-pass:project:${projectId}`, bundle.turnPass ? JSON.stringify(bundle.turnPass) : null)
    this.touchProjectSettings(projectId, at)
    this.expectAccountsUnder((s) => s.projectId === projectId)
  }

  /** Pin a root thread as a master (CLAUDE.md "Master threads"), or unpin
   *  it. Several per project may be; a subagent never. Clients hear it as
   *  the thread's meta; its harness reads the pin at its next spawn. */
  setMaster(sessionId: string, master: boolean): void {
    const thread = this.store.getSession(sessionId)
    if (!thread) throw new Error(`unknown session: ${sessionId}`)
    if (thread.parentId) throw new Error(`session ${sessionId} is a subagent; only a root thread can be a master`)
    if (!!thread.isMaster === master) return
    const next = this.store.updateSession(sessionId, { isMaster: master })
    if (next) this.notifyMeta(next)
  }

  /** An existing root thread joins a master's batch (batch.ts adopt): its
   *  masterId, and its startedBy when it had none. */
  setBatchMembership(sessionId: string, masterId: string): void {
    const thread = this.store.getSession(sessionId)
    if (!thread) throw new Error(`unknown session: ${sessionId}`)
    const next = this.store.updateSession(sessionId, { masterId, ...(thread.startedBy ? {} : { startedBy: masterId }) })
    if (next) this.notifyMeta(next)
  }

  setWorkspacePreamble(workspaceId: string, preamble: string | null, enabled: boolean): void {
    if (!this.store.listWorkspaces().some((w) => w.id === workspaceId)) throw new Error(`unknown workspace: ${workspaceId}`)
    this.store.setWorkspacePreamble(workspaceId, normalizePreamble(preamble), enabled)
    this.notifyCatalog('workspaces')
  }

  setWorkspaceAccounts(workspaceId: string, pins: AccountPins): void {
    if (!this.store.listWorkspaces().some((w) => w.id === workspaceId)) throw new Error(`unknown workspace: ${workspaceId}`)
    this.store.setWorkspaceAccounts(workspaceId, pins)
    this.notifyCatalog('workspaces')
    const projects = new Set(this.store.listProjects().filter((p) => p.workspaceId === workspaceId).map((p) => p.id))
    this.expectAccountsUnder((s) => (s.projectId ? projects.has(s.projectId) : s.workspaceId === workspaceId))
  }

  /** Switch a worktree project's checkout to another branch (existing or
   *  new from baseRef) and record it. Local projects follow the checkout
   *  and can't be switched from here. */
  async setProjectBranch(projectId: string, branch: string, baseRef?: string): Promise<void> {
    const p = this.store.getProject(projectId)
    if (!p) throw new Error(`unknown project: ${projectId}`)
    if (p.mode !== 'worktree') throw new Error('only worktree projects can switch branches')
    const local = await switchBranch(p.cwd, branch, { baseRef })
    this.store.setProjectBranch(projectId, local)
    this.notifyCatalog('projects')
  }

  /** Tear down the chosen git leftovers of a worktree project. Runs
   *  against the workspace repo; order matters — a branch can't die while
   *  its worktree has it checked out. Touches no setting. */
  async cleanupProjectGit(projectId: string, cleanup: ProjectCleanup): Promise<void> {
    const p = this.store.getProject(projectId)
    if (!p || p.mode !== 'worktree') return
    const ws = this.store.listWorkspaces().find((w) => w.id === p.workspaceId)
    if (!ws) return
    if (cleanup.worktree || cleanup.localBranch) {
      // Engines rooted in the worktree die first — a survivor's restart
      // would respawn from the deleted directory.
      await stopProjectLsp(projectId)
      await removeWorktree(ws.path, p.cwd)
    }
    if (cleanup.localBranch && p.branch) await deleteLocalBranch(ws.path, p.branch)
    if (cleanup.remoteBranch && p.branch) await deleteRemoteBranch(ws.path, p.branch)
  }

  async archiveProject(
    projectId: string,
    archived: boolean,
    cleanup?: ProjectCleanup
  ): Promise<void> {
    if (archived && cleanup) await this.cleanupProjectGit(projectId, cleanup)
    this.store.setProjectArchived(projectId, archived)
    this.touchProjectSettings(projectId)
  }

  async deleteProject(projectId: string, cleanup?: ProjectCleanup): Promise<void> {
    if (cleanup) await this.cleanupProjectGit(projectId, cleanup)
    await this.deleteProjectSessions(projectId)
    this.store.deleteProject(projectId)
    this.store.setSetting(`turn-pass:project:${projectId}`, null)
    this.notifyCatalog('projects')
  }

  private async deleteProjectSessions(projectId: string): Promise<void> {
    for (const s of this.store.sessionsOfProject(projectId)) {
      if (!s.parentId) await this.delete(s.id) // roots cascade to children
    }
  }

  /** Rows read off the loop on the reader worker, cut in SQL (Store.readRows): the mirror's read. */
  readLogRows(sessionId: string, opts: Parameters<Store['readRows']>[1]): Promise<EventRow[]> {
    return this.store.readRows(sessionId, opts)
  }

  eventsAfter(sessionId: string, afterSeq: number): EventRow[] {
    return this.store.eventsAfter(sessionId, afterSeq)
  }

  /** Up to `limit` rows after `afterSeq` (the remote resume probe). */
  eventsRange(sessionId: string, afterSeq: number, limit: number): EventRow[] {
    return this.store.eventsRange(sessionId, afterSeq, limit)
  }

  /** One persisted row whole (`session.rowBody`), or null. */
  eventAt(sessionId: string, seq: number): EventRow | null {
    return this.store.eventAt(sessionId, seq)
  }

  /** A window of the log, tail-first when asked (see `Store.events`). */
  events(sessionId: string, opts: { afterSeq?: number; beforeSeq?: number; tail?: number; limit?: number }): EventRow[] {
    return this.store.events(sessionId, opts)
  }

  /** The newest `limit` rows, oldest first (a pending prompt sits here). */
  lastEvents(sessionId: string, limit: number): EventRow[] {
    return this.store.lastEvents(sessionId, limit)
  }

  // ── orchestration rules & thread defaults (global + workspace) ─────

  /** Structured orchestration rules for a scope; null = not set there
   *  (global falls back to defaults at the call site, a workspace to
   *  the global rules). */
  getOrchestrationRules(workspaceId: string | null): OrchestrationRules | null {
    const key = workspaceId ? `orchestration-rules:${workspaceId}` : 'orchestration-rules'
    const rules = parseRules(this.store.getSetting(key))
    // A copy saved while a missing model meant approved is written out
    // whole once (`explicitModels`); from then on a missing model is off.
    if (!rules || this.store.getSetting(`${key}:explicit`)) return rules
    const upgraded = explicitModels(rules)
    this.store.setSetting(key, JSON.stringify(upgraded))
    this.store.setSetting(`${key}:explicit`, '1')
    return upgraded
  }

  /** null clears: global reverts to defaults, an override goes away.
   *  Applies to orchestrators started after the change (resume keeps
   *  running ones on the old prompt until they idle out). */
  setOrchestrationRules(workspaceId: string | null, rules: OrchestrationRules | null): void {
    const key = workspaceId ? `orchestration-rules:${workspaceId}` : 'orchestration-rules'
    this.store.setSetting(`${key}:explicit`, rules ? '1' : null)
    this.setSyncedSetting(key, rules ? JSON.stringify(rules) : null)
  }

  /** Thread defaults for a scope; null = not set there. */
  getThreadDefaults(workspaceId: string | null): ThreadDefaults | null {
    const key = workspaceId ? `thread-defaults:${workspaceId}` : 'thread-defaults'
    return parseDefaults(this.store.getSetting(key))
  }

  setThreadDefaults(workspaceId: string | null, defaults: ThreadDefaults | null): void {
    const key = workspaceId ? `thread-defaults:${workspaceId}` : 'thread-defaults'
    this.setSyncedSetting(key, defaults ? JSON.stringify(defaults) : null)
  }

  /** Rules and defaults have one copy across hosts (remote/rulesSync.ts):
   *  a change re-sends the workspaces push, which a linked Mac follows. */
  private setSyncedSetting(key: string, value: string | null): void {
    if (this.store.getSetting(key) === value) return
    this.store.setSetting(key, value)
    this.notifyCatalog('workspaces')
  }

  // ── plans: what happens when a plan is complete (planFlow.ts) ────────

  /** The plan settings stored at a scope (null = unset there). */
  getPlanSettings(projectId: string | null): PlanSettings | null {
    return getPlanSettings(this.store, projectId)
  }

  setPlanSettings(projectId: string | null, settings: PlanSettings | null): void {
    setPlanSettings(this.store, projectId, settings)
    if (projectId) this.touchProjectSettings(projectId)
  }

  /** What applies to a project: override → global → defaults. */
  resolvePlanSettings(projectId: string | null): PlanSettings {
    return resolvePlanSettings(this.store, projectId)
  }

  /** The planner's `plan_complete`: stamp the plan and say what follows. */
  completePlan(sessionId: string, args: { summary?: string } = {}): Promise<CompleteResult> {
    return completePlan(this.planFlow(), sessionId, args)
  }

  /** Start the implementation thread from a finished plan (the plan view,
   *  the wire's plan.implement); the auto path calls the same function. */
  implementPlan(planId: string, opts: ImplementOptions = {}): Promise<SessionMeta> {
    return implementPlan(this.planFlow(), planId, opts, 'manual')
  }

  /** This host's name, as notices name it; set by the server. */
  hostName: () => string = () => 'this host'

  /** Reads an `@thread:<host>:<id>` reference from its host
   *  (crossHostAgents.readThread); null from it means the id is this host.
   *  Set by the server; absent, a foreign reference resolves locally or not at all. */
  readForeignThread: ((caller: SessionMeta, environmentId: string, sessionId: string) => Promise<ForeignThreadRead | null>) | null = null

  /** The registry as the plan flow reads it. */
  private planFlow(): PlanFlowRegistry {
    return {
      get: (id) => this.get(id),
      listSessions: () => this.store.listSessions(),
      getSetting: (key) => this.store.getSetting(key),
      setSetting: (key, value) => this.store.setSetting(key, value),
      create: (input) => this.create(input),
      send: (id, text, opts) => this.send(id, text, opts),
      patch: (id, patch) => {
        const next = this.store.updateSession(id, patch)
        if (next) this.notifyMeta(next)
        return next
      },
      append: (id, event) => this.append(id, event),
      setArchived: (id, archived) => this.setArchived(id, archived),
      deliverAgentReport: (id, report) => this.deliverAgentReport(id, report),
      hostName: () => this.hostName(),
      log: (line) => console.log(line)
    }
  }

  /** Review before merge (shared/review.ts): the global set, or one
   *  project's whole-object override; null = not set there. */
  getReviewSettings(projectId: string | null): ReviewSettings | null {
    const key = projectId ? `review:project:${projectId}` : 'review'
    return parseReviewSettings(this.store.getSetting(key))
  }

  setReviewSettings(projectId: string | null, settings: ReviewSettings | null): void {
    const key = projectId ? `review:project:${projectId}` : 'review'
    this.store.setSetting(key, settings ? JSON.stringify(settings) : null)
    if (projectId) this.touchProjectSettings(projectId)
  }

  /** The set a project's threads run under: its override → global → defaults. */
  effectiveReview(projectId: string | null): ReturnType<typeof effectiveReviewSettings> {
    return effectiveReviewSettings(projectId ? this.getReviewSettings(projectId) : null, this.getReviewSettings(null))
  }

  /** Completed-turn pass for a workspace; null = not configured. */
  getTurnPass(workspaceId: string): TurnPass | null {
    return parseTurnPass(this.store.getSetting(`turn-pass:${workspaceId}`))
  }

  setTurnPass(workspaceId: string, pass: TurnPass | null): void {
    this.store.setSetting(`turn-pass:${workspaceId}`, pass ? JSON.stringify(pass) : null)
  }

  /** A project's override of the workspace pass; null = inherits. An
   *  all-off pass is a real override: that project runs nothing. */
  getProjectTurnPass(projectId: string): TurnPass | null {
    return parseTurnPass(this.store.getSetting(`turn-pass:project:${projectId}`))
  }

  setProjectTurnPass(projectId: string, pass: TurnPass | null): void {
    this.store.setSetting(`turn-pass:project:${projectId}`, pass ? JSON.stringify(pass) : null)
    this.touchProjectSettings(projectId)
  }

  /** Build command for a workspace (Build rail); null = not configured. */
  getBuild(workspaceId: string): BuildConfig | null {
    return parseBuildConfig(this.store.getSetting(`build:${workspaceId}`))
  }

  setBuild(workspaceId: string, config: BuildConfig | null): void {
    this.store.setSetting(`build:${workspaceId}`, config ? JSON.stringify(config) : null)
  }

  /** A project's override of the workspace build; null = inherits. */
  getProjectBuild(projectId: string): BuildConfig | null {
    return parseBuildConfig(this.store.getSetting(`build:project:${projectId}`))
  }

  setProjectBuild(projectId: string, config: BuildConfig | null): void {
    this.store.setSetting(`build:project:${projectId}`, config ? JSON.stringify(config) : null)
    this.touchProjectSettings(projectId)
  }

  /** What a project builds with: override → workspace → detected → null.
   *  `cwd` is the checkout detection looks at (another branch's worktree). */
  async effectiveBuild(projectId: string, cwd?: string): Promise<EffectiveBuild | null> {
    const project = this.store.getProject(projectId)
    if (!project) return null
    const own = this.getProjectBuild(projectId)
    if (own) return { ...own, source: 'project' }
    const ws = this.getBuild(project.workspaceId)
    if (ws) return { ...ws, source: 'workspace' }
    const detected = await detectBuild(cwd ?? project.cwd)
    return detected ? { ...detected, source: 'detected' } : null
  }

  /** Appshot capture settings — global, defaults until the user changes them. */
  getAppshotSettings(): AppshotSettings {
    const raw = this.store.getSetting('appshots')
    if (raw) {
      const parsed = AppshotSettingsSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    }
    return DEFAULT_APPSHOT_SETTINGS
  }

  setAppshotSettings(settings: AppshotSettings): void {
    this.store.setSetting('appshots', JSON.stringify(settings))
  }

  /** Whether the one first-boot permission prompt has already fired (ever). */
  getAppshotPrompted(): boolean {
    return this.store.getSetting('appshots-prompted') !== null
  }

  markAppshotPrompted(): void {
    this.store.setSetting('appshots-prompted', '1')
  }

  /** What a new thread starts with here: workspace override → global → built-in. */
  resolveThreadDefaults(workspaceId: string | null): ThreadDefaults {
    return (
      (workspaceId ? this.getThreadDefaults(workspaceId) : null) ??
      this.getThreadDefaults(null) ??
      DEFAULT_THREAD_DEFAULTS
    )
  }

  async create(raw: CreateSessionInput): Promise<SessionMeta> {
    const params = CreateSessionParams.parse(raw)
    const now = Date.now()
    if (params.id && this.store.getSession(params.id)) throw new Error(`session id already taken: ${params.id}`)
    const membership = batchMembershipOf(params.startedBy ? this.store.getSession(params.startedBy) : null)
    const id = params.id ?? nanoid(12)
    const project = params.projectId ? this.store.getProject(params.projectId) : null
    // One-off chats: a workspace chat runs at the workspace root, a fully
    // loose chat in the home directory.
    let workspace =
      !project && params.workspaceId
        ? this.store.listWorkspaces().find((w) => w.id === params.workspaceId)
        : null
    if (!project && params.workspaceId && !workspace) {
      throw new Error(`unknown workspace: ${params.workspaceId}`)
    }
    if (!project && !workspace && !params.workspaceId && params.cwd) {
      workspace = this.store.listWorkspaces().find((w) => w.path === params.cwd) ?? null
    }
    const cwd = project?.cwd ?? workspace?.path ?? params.cwd ?? homedir()
    const reportsRoot = this.reportsRootFor({
      projectId: params.projectId,
      workspaceId: workspace?.id ?? null,
      cwd
    })
    // Fields the caller left open come from the thread defaults
    // (workspace override → global → built-in).
    const d = this.resolveThreadDefaults(project?.workspaceId ?? workspace?.id ?? null)
    // A model id names its harness: a session asked to run another
    // provider's model routes to that provider instead of erroring.
    const requested = params.provider ?? d.provider
    const { provider, model } = resolveModel(
      requested,
      params.model ?? (d.model || CATALOG[requested].defaultModel)
    )
    const meta: SessionMeta = {
      id,
      parentId: params.parentId,
      projectId: params.projectId,
      workspaceId: workspace?.id ?? null,
      threadType: params.threadType,
      // Planning threads own a plan file, research threads a report file;
      // seeded threads point at their source.
      planPath:
        params.threadType === 'planning'
          ? planPathFor(cwd, id)
          : params.threadType === 'project-plan'
            ? projectPlanPathFor(cwd)
            : params.threadType === 'research'
              ? reportPathFor(reportsRoot, id)
              : (params.planPath ?? null),
      provider,
      model,
      reasoning: params.reasoning ?? d.reasoning,
      // Orchestration threads ARE orchestrator sessions (MCP toolset attaches).
      agentType: params.threadType === 'orchestration' ? 'orchestrator' : params.agentType,
      title:
        params.title ??
        (params.threadType
          ? THREAD_TITLES[params.threadType]
          : `${provider} · ${params.agentType}`),
      cwd,
      // The harness boots lazily on first send; a new session is simply
      // ready for input.
      status: 'idle',
      archived: false,
      pinned: false,
      permission: params.permission ?? d.permission,
      fast: false,
      ultrafast: false,
      context1m: params.context1m ?? false,
      account: null,
      busySince: null,
      pausedAt: null,
      frozenActiveElapsed: null,
      threadRules: params.threadRules ?? null,
      nativeId: null,
      planCompletedAt: null,
      implementationId: null,
      planThreadId: null,
      startedBy: params.startedBy ?? null,
      // The batch follows the starter (orchestration.ts batchMembershipOf):
      // a thread a master starts, or one a batch thread starts (a plan's
      // build), carries the master's id unless the caller said otherwise.
      masterId: params.masterId ?? ('masterId' in membership ? membership.masterId : null),
      after: params.after ?? null,
      createdAt: now,
      updatedAt: now
    }
    this.store.insertSession(meta)
    if (params.queue) this.queueOptIn.add(id)
    // Born folded: an empty row at seq 0, and a warm task fold so the
    // first append never walks a log.
    this.putFold(toFoldRow(id, newFoldState()))
    this.todoFolds.set(id, newTodoFold())
    this.notifyMeta(meta)
    // The account the thread will spend from, shown before its first spawn.
    this.expectAccount(id)
    const created = this.store.getSession(id) ?? meta
    if (params.parentId) {
      this.append(params.parentId, { type: 'agent-spawned', childSessionId: created.id })
    }
    // A build starting from a plan links to its planning thread and back,
    // leaves a handoff row there, and archives it when plans.archiveAfterStart
    // says so (planFlow.ts): the conversation is over, the plan file carries
    // the context. Archiving touches nothing the models use — mirrors and
    // the plan doc stay, and any send into the thread revives it.
    linkPlanHandoff(this.planFlow(), created)
    // A plan written for one milestone of the project plan hands that
    // milestone to the build: landing the build ticks it (projectPlan.ts).
    if (created.planPath && (created.threadType === 'implementation' || created.threadType === 'orchestration')) {
      inheritMilestoneLink(
        this.store,
        created,
        this.store.listSessions().find((s) => s.threadType === 'planning' && s.planPath === created.planPath)
      )
    }
    // A requested goal waits for the kickoff message (send() applies it
    // just before the text), so goal and work arrive in order.
    if (params.goal?.trim()) this.pendingGoals.set(id, params.goal.trim())
    // Start the harness eagerly so status/errors surface immediately; a
    // thread that will queue (its `after`, the running cap) boots when it
    // starts instead, so a queued thread holds no process.
    if (this.scheduler.admit(created, { first: true, optIn: this.wantsQueue(created) }) === 'start') {
      void this.handleFor(created.id).catch(() => {})
    }
    return created
  }

  /** Point a thread at the run settings a send or a continue asks for.
   *  A model id names its harness (resolveModel): asking this thread for
   *  another provider's model switches the thread to that provider rather
   *  than handing the harness a model it will reject. Returns the updated
   *  row and, on a provider switch, the transcript handoff the first
   *  message to the new harness must carry. */
  private async applyRunSettings(
    sessionId: string,
    meta: SessionMeta,
    opts?: RunSettings
  ): Promise<{ meta: SessionMeta; handoff: string }> {
    const routed = opts?.model
      ? resolveModel(opts?.provider ?? meta.provider, opts.model)
      : { provider: opts?.provider ?? meta.provider, model: undefined }
    const provider = routed.provider
    const reasoning = opts?.reasoning ?? meta.reasoning
    let handoff = ''
    if (provider !== meta.provider) {
      // Cross-harness switch: native resume can't follow, so the next
      // harness starts a fresh native session seeded with the transcript.
      handoff = transcriptHandoff(this.store.eventsAfter(sessionId, 0))
      await this.dropHandle(sessionId)
      // The old engine's accounting means nothing to the new one.
      this.liveContexts.delete(sessionId)
      this.store.setSessionContext(sessionId, null)
      const next = this.store.updateSession(sessionId, {
        provider,
        model: routed.model ?? CATALOG[provider].defaultModel,
        reasoning,
        nativeId: null
      })
      if (next) {
        meta = next
        this.notifyMeta(next)
        // Another harness, another provider's accounts.
        this.setAccount(sessionId, null)
        this.expectAccount(sessionId, { fresh: true })
        meta = this.store.getSession(sessionId) ?? meta
      }
    } else {
      // Per-message model/reasoning: persist the change and drop the live
      // handle — the next handleFor() boots the harness fresh (resume keeps
      // the conversation) with the new settings.
      const model = routed.model ?? meta.model
      const modelChanged = model !== meta.model
      if (modelChanged || reasoning !== meta.reasoning) {
        await this.dropHandle(sessionId)
        const next = this.store.updateSession(sessionId, { model, reasoning })
        if (next) {
          meta = next
          this.notifyMeta(next)
          // The pick depends on the model's windows (a Fable cap, say).
          if (modelChanged) {
            this.expectAccount(sessionId, { fresh: true })
            meta = this.store.getSession(sessionId) ?? meta
          }
        }
      }
    }
    return { meta, handoff }
  }

  async send(
    sessionId: string,
    text: string,
    opts?: RunSettings & {
      attachments?: Attachment[]
      newPass?: boolean
      echoed?: QueuedSendOpts['echoed']
      /** `false`: the spawner opted this thread out of the project preamble */
      preamble?: boolean
    }
  ): Promise<void> {
    let meta = this.store.getSession(sessionId)
    if (!meta) throw new Error(`unknown session: ${sessionId}`)
    this.assertNotMoving(sessionId)
    // The send's phase line (sendSpans.ts) opens here; a send that ends up
    // queued instead of in a harness is dropped from it.
    this.spans.begin(sessionId)
    // A paused tree accepts no harness input. User work stays ordered in the
    // same queue and releases only after the resumed turn settles.
    if (this.isTreePaused(sessionId)) {
      this.spans.drop(sessionId)
      this.queueAdd(sessionId, text, opts)
      return
    }
    // A real message starts a fresh turn — the error taint belongs to the
    // one that died. (The pass's own handle.send bypasses this method.)
    this.erroredTurns.delete(sessionId)
    // A completed plan that takes input again is open until plan_complete
    // is called anew (one whose build started keeps its mark).
    reopenPlan(this.planFlow(), meta)
    meta = this.store.getSession(sessionId) ?? meta
    // Zeron unarchive-on-send: a message into an archived thread revives it.
    if (meta.archived) {
      const next = this.store.updateSession(sessionId, { archived: false })
      if (next) {
        meta = next
        this.notifyMeta(next)
      }
    }
    // Typed goal control: codex parses no slash commands, so `/goal …` on
    // a codex thread routes to the goal RPCs instead of a turn (claude
    // runs /goal natively — it passes through as a normal message). The
    // typed text is not logged; the harness's goal event is the record.
    if (meta.provider === 'codex') {
      const goalCmd = /^\/goal(?:\s+([\s\S]+))?$/.exec(text.trim())
      if (goalCmd) {
        const condition = goalCmd[1]?.trim()
        if (condition && condition.toLowerCase() !== 'clear') {
          await this.setGoal(sessionId, condition)
        } else {
          await this.clearGoal(sessionId)
        }
        this.spans.drop(sessionId)
        return
      }
    }
    const switched = await this.applyRunSettings(sessionId, meta, opts)
    meta = switched.meta
    const handoff = switched.handoff || this.lostNativeHandoff(meta)
    // A pin change (project or workspace) since the harness was
    // spawned: its URL names the old account, so boot fresh under the new one.
    if (this.handles.has(sessionId) && this.spawnedPin.get(sessionId) !== (this.pinOf(meta)?.name ?? null)) {
      await this.dropHandle(sessionId)
    }
    // The visible transcript carries only what the user typed; thread-type
    // preambles ride along on the first message, provider-agnostic.
    const first = opts?.echoed ? opts.echoed.first : !this.store.hasUserText(sessionId)
    this.notesReminderSent.delete(sessionId)
    const attachments = opts?.attachments?.length ? opts.attachments : undefined
    // The project preamble (projectPreamble.ts) rides the FIRST message of
    // every thread started in a project, on every start path — all of them
    // end here. A retry of an echoed send reads the stamp its row already
    // carries, so the harness gets the same text the transcript shows.
    const stamp = !first
      ? null
      : opts?.echoed
        ? this.store.firstUserPreamble(sessionId)
        : decidePreamble({
            store: this.store,
            // An untitled thread is about to take its title from the first line.
            session: isPlaceholderTitle(meta) ? { ...meta, title: '' } : meta,
            text,
            optOut: opts?.preamble === false
          })
    // What the user sees moves NOW: the user row and a 'starting' status
    // land before the harness boots and before the undo baseline is taken,
    // so busySince anchors to the send and the header chip goes live at
    // once. A message that waited minutes here once sat behind a slow
    // checkpoint status on the store's per-session chain.
    if (!opts?.echoed) {
      // Stamp the run settings that will execute this message — the board's
      // pass history reads them off the round's opening event — and whether
      // this send opens a NEW pass (the pass button) or continues the
      // current one (typed under the banner).
      this.append(sessionId, {
        type: 'user-text',
        text,
        attachments,
        ...(stamp ? { preamble: stamp } : {}),
        model: meta.model,
        reasoning: meta.reasoning,
        context1m: meta.context1m,
        fast: meta.fast,
        ultrafast: meta.ultrafast,
        newPass: opts?.newPass === true
      })
      // Cursor-style: an untitled thread takes its name from the first
      // message right away; a generated title replaces the raw slice once
      // the first turn completes (maybeRetitle).
      if (first && isPlaceholderTitle(meta)) {
        const title = text.trim().split('\n')[0].slice(0, 60)
        if (title) {
          const next = this.store.updateSession(sessionId, { title })
          if (next) this.notifyMeta(next)
          this.pendingTitles.set(sessionId, { placeholder: title, text })
        }
      }
    }
    // The queue (scheduler.ts) holds a send here for two reasons: a first
    // message on a thread that opted in (`queue: true`, or a master's
    // child) whose `after` sibling has not settled, and the running cap
    // (admission.ts) for any send that needs a harness not there (a thread
    // whose create found no slot, one whose handle the idle sweep dropped);
    // a thread with a harness up already holds its slot. The user row and
    // its stamp are stored exactly as a held-back boot stores them; the
    // message waits at the front of the queue and `startQueued` sends it.
    const harness = this.handles.has(sessionId) || this.starting.has(sessionId)
    if (!opts?.echoed && this.scheduler.admit(meta, { first, optIn: this.wantsQueue(meta), harness }) === 'queue') {
      this.spans.drop(sessionId)
      this.queueOptIn.delete(sessionId)
      this.append(sessionId, { type: 'status', status: 'queued' })
      this.queueAdd(sessionId, text, { ...opts, echoed: { first } }, true)
      this.scheduler.schedule()
      return
    }
    this.queueOptIn.delete(sessionId)
    // A steer into a live turn keeps its running status; everything else
    // (idle, error, watching) is starting a turn.
    const status = this.store.getSession(sessionId)?.status
    if (status !== 'running' && status !== 'starting' && status !== 'waiting') {
      this.append(sessionId, { type: 'status', status: 'starting' })
      // The socket the turn's first request will ride, opened while the
      // harness boots or wakes; a steer into a live turn already has one.
      this.preconnectFor(meta)
    }
    void this.armBaseline(sessionId)
    const retry: QueuedSendOpts = { ...opts, echoed: { first } }
    let handle: DriverHandle
    const hadHandle = this.handles.has(sessionId)
    try {
      handle = await this.handleFor(sessionId)
    } catch {
      // The harness never started — a missing binary, a logged-out CLI.
      // handleFor has already put the reason on the transcript; hold the
      // message at the front of the queue instead of dropping it, so once
      // the cause is fixed the thread runs what the user actually asked for
      // rather than an empty continue.
      this.spans.drop(sessionId)
      this.queueAdd(sessionId, text, retry, true)
      return
    }
    // A handle that was up is `live`; a fresh one said `warm` or `cold` itself (the claude driver).
    this.spans.mark(sessionId, 'handle', hadHandle ? 'live' : undefined)
    this.lastActivity.set(sessionId, Date.now())
    // A goal passed to session.create lands here, ahead of the kickoff:
    // claude queues its /goal turn first, codex sets the RPC before
    // turn/start. Failure (no goal support, logged out) never blocks the
    // kickoff itself.
    const pendingGoal = this.pendingGoals.get(sessionId)
    if (pendingGoal) {
      this.pendingGoals.delete(sessionId)
      try {
        await handle.setGoal?.(pendingGoal)
      } catch {
        // Goal support is optional; the kickoff still proceeds.
      }
    }
    let out = stamp ? composePreambled(stamp, text) : text
    // A retyped thread re-instructs on its next message: the new type's
    // preamble rides along once, prefaced so the model knows it replaces
    // the instructions the thread opened with.
    const retyped = !first && this.store.getRetyped(sessionId)
    if (retyped) this.store.setRetyped(sessionId, false)
    if (first || retyped) {
      const parts = [threadPreamble(meta)]
      // Planning and research threads WRITE their planPath file (plan /
      // report) — only executing types read it as a brief. A subagent's
      // planPath is its findings file (a research explorer's angle file),
      // which its task already describes — never a plan to work from.
      if (
        meta.threadType !== 'planning' &&
        meta.threadType !== 'project-plan' &&
        meta.threadType !== 'research' &&
        meta.planPath &&
        !meta.parentId
      ) {
        parts.push(planSeed(meta.planPath))
        // The planning thread's notes travel with its plan: the decisions
        // and pointers it kept, ahead of any transcript digest.
        const planner = this.store
          .listSessions()
          .find((s) => s.id !== meta.id && s.threadType === 'planning' && s.planPath === meta.planPath)
        const planNotes = planner ? this.notes.textFor(planner.id) : null
        if (planner && planNotes) parts.push(notesForPlanHandoff(planNotes, planner.title))
      }
      const preamble = parts.filter(Boolean).join('\n\n')
      if (preamble) {
        const note = retyped
          ? `The user CHANGED this thread's type mid-conversation. The instructions below REPLACE the ones this thread opened with — earlier turns may follow the old shape; from this message on, follow these.\n\n`
          : ''
        out = `<thread-instructions>\n${note}${preamble}\n</thread-instructions>\n\n${out}`
      }
      // Shared context (M8): root project threads open knowing the project —
      // the journal, the sibling transcripts, the journal-append contract.
      if (first && !meta.parentId && meta.projectId) {
        const project = this.store.getProject(meta.projectId)
        if (project) {
          const ws = this.store.listWorkspaces().find((w) => w.id === project.workspaceId)
          const ctx = projectContext(
            meta,
            project,
            ws?.name ?? null,
            this.store.sessionsOfProject(meta.projectId),
            this.reportsRootFor(meta)
          )
          out = `${ctx}\n\n${out}`
        }
      }
    }
    // A NEW pass re-arms the task-list contract in-band: the thread
    // preamble that demanded it rode the FIRST message only, and by later
    // passes (or after a compaction) it can be gone from context — so
    // every pass opener carries the instruction itself.
    if (
      opts?.newPass &&
      !first &&
      (meta.threadType === 'implementation' || meta.threadType === 'orchestration')
    ) {
      out = `<new-pass>\nThis message begins a NEW pass. Your FIRST tool call — before any exploration, edit, or subagent — creates the fresh task list for THIS pass with whichever task tool this session has (one TaskCreate per task, or TodoWrite/update_plan), containing ONLY this pass's tasks. This holds for every pass no matter how small the request — the board renders nothing without it. Then work the list: one item in_progress at a time, completed the moment it's done.\n</new-pass>\n\n${out}`
    }
    if (handoff) out = `${handoff}\n\n${out}`
    // Lines the app held for the harness (the notes block after a
    // compaction, a reminder that found no live turn) ride ahead of this
    // message, inside the same send.
    const notices = this.takeNotices(sessionId)
    if (notices) out = `${notices}\n\n${out}`
    // Thread references (M9): each referenced thread becomes a fresh local
    // digest file; the @thread:<id> token is rewritten to its path (every
    // harness follows @path). Projectless sessions get the digest inline.
    // A thread on another host (`@thread:<host>:<id>`, the attachment's
    // environmentId) is read from its host (thread.read) into the same
    // file, or named as unreachable.
    const here = meta.projectId ? this.store.getProject(meta.projectId) : null
    const threadRefs = attachments?.filter((a) => a.kind === 'thread' && a.sessionId) ?? []
    // Threads on other hosts are read at once, all of them under ONE budget
    // (each read has its own link timeout; serial reads once cost 15 s
    // apiece): a host that does not answer in time names the thread as
    // unreachable rather than holding the send.
    const foreignReads = new Map<Attachment, Promise<ForeignThreadRead | null>>()
    if (this.readForeignThread) {
      let timer: NodeJS.Timeout | null = null
      const budget = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FOREIGN_REFS_BUDGET_MS)
        timer.unref?.()
      })
      for (const ref of threadRefs) {
        if (!ref.environmentId) continue
        foreignReads.set(ref, Promise.race([this.readForeignThread(meta, ref.environmentId, ref.sessionId!).catch(() => null), budget]))
      }
      if (foreignReads.size) await Promise.allSettled([...foreignReads.values()])
      if (timer) clearTimeout(timer)
    }
    for (const ref of threadRefs) {
      const tokens = [`@thread:${ref.sessionId}`, ...(ref.environmentId ? [`@thread:${ref.environmentId}:${ref.sessionId}`] : [])]
      const foreign = (await foreignReads.get(ref)) ?? null
      if (foreign) {
        out = foreignReference(out, tokens, ref.name, foreign, here?.cwd ?? null)
        continue
      }
      const refMeta = this.store.getSession(ref.sessionId!)
      if (!refMeta) continue
      const refProject = refMeta.projectId ? this.store.getProject(refMeta.projectId) : null
      if (here) {
        const rel = writeThreadDigest(this, refMeta, here.cwd)
        out = replaceTokens(out, tokens, `@${rel} (thread "${refMeta.title}"${refProject ? ` from project "${refProject.name}"` : ''})`)
      } else {
        // The rows the cap keeps, read from the log's end; never the whole log.
        let digest = threadDigestTail(this, refMeta, INLINE_DIGEST_MAX_CHARS)
        if (digest.length > INLINE_DIGEST_MAX_CHARS) {
          digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
        }
        out = inlineReference(out, tokens, refMeta.title, digest)
      }
    }
    this.spans.mark(sessionId, 'prepared')
    // Thread references are resolved above; appshots expand into the plain
    // image + text-file pair every harness understands (the persisted event
    // keeps the appshot itself, so the transcript renders the chip).
    const sendAttachments = attachments
      ?.filter((a) => a.kind !== 'thread')
      .flatMap((a) => {
        if (a.kind !== 'appshot') return [a]
        const shot: Attachment = {
          path: a.path,
          name: a.name,
          mime: a.mime ?? 'image/jpeg',
          kind: 'image'
        }
        return a.textPath
          ? [shot, { path: a.textPath, name: `${a.name} (window text)`, kind: 'file' as const }]
          : [shot]
      })
    try {
      await handle.send(out, sendAttachments)
      this.spans.mark(sessionId, 'delivered')
      // A message into a live turn is a steer: a wait_for_agent in flight
      // there returns on it (orchestration.ts), whoever sent it.
      if (status === 'running' || status === 'starting' || status === 'waiting') this.resolveSteerWaiters(sessionId, text)
    } catch (err) {
      // A steer at a provider that can't take mid-turn input (cursor's
      // process-per-turn) front-queues instead of erroring the composer.
      if (err instanceof Error && err.message.includes('still running')) {
        this.spans.drop(sessionId)
        this.queueAdd(sessionId, text, retry, true)
        return
      }
      // The handle's harness is gone (watchdog recovery, stream death) —
      // boot a fresh one and deliver there; resume keeps the conversation.
      if (err instanceof Error && err.message.includes('harness gone')) {
        await this.dropHandle(sessionId)
        const fresh = await this.handleFor(sessionId)
        await fresh.send(out, sendAttachments)
        this.spans.mark(sessionId, 'delivered')
        return
      }
      this.spans.drop(sessionId)
      throw err
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const meta = this.store.getSession(sessionId)
    if (meta?.status === 'paused') {
      this.appendStatus(sessionId, 'idle')
      const next = this.store.updateSession(sessionId, {
        status: 'idle',
        busySince: null,
        pausedAt: null,
        frozenActiveElapsed: null
      })
      if (next) this.notifyMeta(next)
      await this.dropHandle(sessionId)
      return
    }
    // Watching: the harness is idle behind its background tasks, so there
    // is no turn to interrupt. Stop means drop the process, tasks and all;
    // dropHandle settles the row idle.
    if (meta?.status === 'watching') {
      await this.dropHandle(sessionId)
      return
    }
    const handle = this.handles.get(sessionId)
    if (handle) {
      this.stopping.add(sessionId)
      handle.interrupt()
      return
    }
    // No live harness (crashed, disposed, or the app restarted) — nothing is
    // actually running, whatever the persisted status says. Stop must still
    // work: clear the stale status so the UI settles.
    if (meta && meta.status !== 'idle' && meta.status !== 'error') {
      this.append(sessionId, { type: 'status', status: 'idle' })
    }
  }

  /** User-facing hard Stop ends every active or paused member of the visible
   *  root tree. Agent supervision still uses interrupt() for one child. */
  async stopRun(sessionId: string): Promise<void> {
    await this.stopTree(this.rootSessionOf(sessionId))
  }

  /** Interrupt every live member of the subtree at rootId — Stop semantics
   *  for flows (delete, archive) that act on the given thread, not the
   *  visible root. */
  private async stopTree(rootId: string): Promise<void> {
    const tree = this.sessionTree(rootId).filter(
      (session) => session.status === 'paused' || LIVE_STATUSES.has(session.status)
    )
    await Promise.allSettled(tree.map((session) => this.interrupt(session.id)))
  }

  /** Pause a visible root and every live descendant. State lands before any
   *  provider interrupt, so late callbacks can only observe `paused`. */
  async pauseRun(sessionId: string): Promise<void> {
    const rootId = this.rootSessionOf(sessionId)
    await this.pauseTree(rootId)
    await this.cascadeBatch('pause', rootId)
  }

  private async pauseTree(rootId: string): Promise<void> {
    const tree = this.sessionTree(rootId)
    const live = tree.filter(
      (session) =>
        session.status === 'starting' ||
        session.status === 'running' ||
        session.status === 'waiting'
    )
    if (live.length === 0) return

    const root = tree.find((session) => session.id === rootId)
    const targets = root && !live.some((session) => session.id === rootId) ? [root, ...live] : live
    const now = Date.now()
    for (const session of targets) {
      const frozenActiveElapsed = Math.max(
        0,
        session.busySince === null ? (session.frozenActiveElapsed ?? 0) : now - session.busySince
      )
      this.appendStatus(session.id, 'paused')
      const next = this.store.updateSession(session.id, {
        status: 'paused',
        busySince: null,
        pausedAt: now,
        frozenActiveElapsed
      })
      // Paused by the user: no boot brings it back on its own.
      this.store.clearResumeAfterBoot([session.id])
      this.activities.delete(session.id)
      if (next) this.notifyMeta(next)
    }

    await Promise.allSettled(
      targets.map(async (session) => {
        const handle =
          this.handles.get(session.id) ??
          (await this.starting.get(session.id)?.catch(() => undefined))
        handle?.interrupt()
      })
    )
  }

  /** Resume paused descendants deepest-first. Each session stays paused
   *  until its replacement handle accepts the control send. */
  async resumePausedRun(sessionId: string): Promise<void> {
    const rootId = this.rootSessionOf(sessionId)
    await this.resumeTree(rootId)
    await this.cascadeBatch('resume', rootId)
  }

  /** Pause and Resume on a master reach every root of its batch on this
   *  host, four at a time (sessionBatch.ts); Stop stays per thread. A
   *  child that fails is logged and the rest still move. */
  private async cascadeBatch(action: 'pause' | 'resume', rootId: string): Promise<void> {
    if (!this.isMaster(rootId)) return
    const ids = batchChildIds(this.store.listSessions(), rootId)
    if (ids.length === 0) {
      await batches()?.cascade(rootId, action)
      return
    }
    const result = await runSessionBatch(action, ids, {
      rootOf: (id) => this.rootSessionOf(id),
      run: (what, id) => (what === 'pause' ? this.pauseTree(id) : this.resumeTree(id))
    })
    for (const f of result.failed) console.log(`[master] ${action} of batch thread ${f.sessionId} failed: ${f.error}`)
    // The batch's threads on other hosts follow over their links (batch.ts cascade).
    await batches()?.cascade(rootId, action)
  }

  private async resumeTree(rootId: string): Promise<void> {
    const tree = this.sessionTree(rootId)
    const depth = new Map<string, number>()
    for (const session of tree) {
      let value = 0
      let cursor = session
      while (cursor.parentId) {
        value++
        const parent = tree.find((candidate) => candidate.id === cursor.parentId)
        if (!parent) break
        cursor = parent
      }
      depth.set(session.id, value)
    }
    const paused = tree
      .filter((session) => session.status === 'paused')
      .sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0))
    const failures: unknown[] = []
    for (const session of paused) {
      try {
        await this.resumePausedSession(session.id)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to resume ${failures.length} paused session(s)`)
    }
  }

  private async resumePausedSession(sessionId: string): Promise<void> {
    const before = this.store.getSession(sessionId)
    if (!before || before.status !== 'paused') return
    const frozen = Math.max(0, before.frozenActiveElapsed ?? 0)
    await this.dropHandle(sessionId)
    void this.armBaseline(sessionId)
    const handle = await this.handleFor(sessionId)
    await handle.send(
      '<continue-paused-run>\nThe user paused this turn and has now continued it. Inspect your task list and your last actions, then continue the interrupted work exactly where you left off. Do not restart completed work.\n</continue-paused-run>'
    )
    const now = Date.now()
    this.appendStatus(sessionId, 'running')
    const next = this.store.updateSession(sessionId, {
      status: 'running',
      busySince: now - frozen,
      pausedAt: null,
      frozenActiveElapsed: null
    })
    this.recordMidTurn(sessionId, now)
    this.lastActivity.set(sessionId, now)
    if (next) this.notifyMeta(next)
  }

  /**
   * A proof's seam (index.ts `session.markStatus`, isolated instances only):
   * a status with no harness behind it, so scripts/e2e-mac-bridge.ts can
   * pause a thread and continue it. Straight to the row, as pauseRun writes
   * its own: append() would drop a status while the row says paused.
   */
  markStatusForProof(sessionId: string, status: 'running' | 'idle' | 'done'): void {
    if (!this.store.getSession(sessionId)) throw new Error(`unknown session: ${sessionId}`)
    this.appendStatus(sessionId, status)
    const next = this.store.updateSession(sessionId, {
      status,
      busySince: status === 'running' ? Date.now() : null,
      pausedAt: null,
      frozenActiveElapsed: null
    })
    if (next) this.notifyMeta(next)
  }

  private sessionTree(rootId: string): SessionMeta[] {
    const index = this.indexOf()
    const tree: SessionMeta[] = []
    const pending = [rootId]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const id = pending.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const session = index.byId.get(id)
      if (!session) continue
      tree.push(session)
      for (const child of index.byParent.get(id) ?? []) pending.push(child.id)
    }
    return tree
  }

  private isTreePaused(sessionId: string): boolean {
    return this.sessionTree(this.rootSessionOf(sessionId)).some(
      (session) => session.status === 'paused'
    )
  }

  /** Set or replace the thread's goal. The harness confirms with a goal
   *  event — nothing is emitted here, so there are never duplicate rows. */
  async setGoal(sessionId: string, condition: string): Promise<void> {
    await this.goalCall(sessionId, (h) => {
      if (!h.setGoal) throw new Error('this provider has no goal support')
      return h.setGoal(condition)
    })
  }

  async clearGoal(sessionId: string): Promise<void> {
    await this.goalCall(sessionId, (h) => {
      if (!h.clearGoal) throw new Error('this provider has no goal support')
      return h.clearGoal()
    })
  }

  /** Compact the conversation in place. Boots a handle for an idle thread
   *  (resume keeps the transcript); the harness reports progress as
   *  compaction events and settles the status through the turn. */
  async compact(sessionId: string): Promise<void> {
    await this.goalCall(sessionId, (h) => {
      if (!h.compact) throw new Error('this provider cannot compact')
      return h.compact()
    })
  }

  /** Kill the background work a watching thread waits on: drop the
   *  harness of every watching member of the tree (its monitors, crons and
   *  background shells die with the process) and settle those rows idle.
   *  A running turn is never touched; Stop is for that. */
  /** Stop one background task of a live thread (session.stopTask). The
   *  CLI's stopped notification retires it through the usual path. */
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle?.stopTask) throw new Error('no live harness')
    await handle.stopTask(taskId)
  }

  async killBackground(sessionId: string): Promise<void> {
    const tree = this.sessionTree(this.rootSessionOf(sessionId)).filter((s) => s.status === 'watching')
    await Promise.allSettled(tree.map((s) => this.dropHandle(s.id)))
  }

  private async goalCall(sessionId: string, fn: (h: DriverHandle) => Promise<void>): Promise<void> {
    const handle = await this.handleFor(sessionId)
    this.lastActivity.set(sessionId, Date.now())
    try {
      await fn(handle)
    } catch (err) {
      // Same recovery as send(): a dead harness reboots (resume keeps the
      // conversation) and takes the call.
      if (err instanceof Error && err.message.includes('harness gone')) {
        await this.dropHandle(sessionId)
        await fn(await this.handleFor(sessionId))
        return
      }
      throw err
    }
  }

  /**
   * Ask the user to approve a tool call and wait for the answer. Emits the
   * approval-request and waiting status, resolves through approve(), and
   * auto-denies on timeout, abort, or when the session's handle drops.
   */
  requestApproval(sessionId: string, req: ApprovalRequest): Promise<boolean> {
    const requestId = req.requestId ?? `a-${nanoid(8)}`
    let pending = this.pendingApprovals.get(sessionId)
    if (!pending) {
      pending = new Map()
      this.pendingApprovals.set(sessionId, pending)
    }
    const map = pending
    this.append(sessionId, {
      type: 'approval-request',
      requestId,
      toolName: req.toolName,
      input: req.input,
      title: req.title,
      callId: req.callId
    })
    this.append(sessionId, { type: 'status', status: 'waiting', detail: 'awaiting approval' })
    return new Promise((resolve) => {
      const finish = (allow: boolean, auto = false): void => {
        if (!map.delete(requestId)) return
        clearTimeout(timer)
        this.append(sessionId, { type: 'approval-resolved', requestId, allow, auto })
        this.append(sessionId, { type: 'status', status: 'running' })
        resolve(allow)
      }
      const timer = setTimeout(() => finish(false, true), APPROVAL_TIMEOUT_MS)
      map.set(requestId, finish)
      req.signal?.addEventListener('abort', () => finish(false, true), { once: true })
    })
  }

  private denyPendingApprovals(sessionId: string): void {
    const pending = this.pendingApprovals.get(sessionId)
    if (!pending) return
    for (const finish of [...pending.values()]) finish(false, true)
    this.pendingApprovals.delete(sessionId)
  }

  async approve(sessionId: string, requestId: string, allow: boolean): Promise<void> {
    const finish = this.pendingApprovals.get(sessionId)?.get(requestId)
    if (finish) {
      finish(allow)
      return
    }
    if (this.handles.get(sessionId)?.approve?.(requestId, allow)) return
    // Stale request: asked by a previous process of this harness, whose
    // resolver died with it. Settle the card so it can't wedge the UI —
    // the tool call it guarded is gone either way.
    if (this.unresolvedRequest(sessionId, requestId, 'approval')) {
      this.append(sessionId, { type: 'approval-resolved', requestId, allow })
    }
  }

  async answer(sessionId: string, requestId: string, answers: string[][] | null): Promise<void> {
    if (this.handles.get(sessionId)?.answer?.(requestId, answers)) return
    // Stale request: settle the card, then deliver the answers as an
    // ordinary message so the model still receives the decisions.
    const req = this.unresolvedRequest(sessionId, requestId, 'question')
    if (!req || req.type !== 'question-request') return
    this.append(sessionId, { type: 'question-resolved', requestId, answers })
    if (answers?.some((a) => a.length)) {
      const lines = req.questions
        .map((q, i) => (answers[i]?.length ? `- ${q.question} → ${answers[i].join(', ')}` : null))
        .filter(Boolean)
      await this.send(sessionId, `Answers to your earlier questions:\n${lines.join('\n')}`)
    }
  }

  /** The still-unresolved question/approval request for an id, if any. */
  private unresolvedRequest(
    sessionId: string,
    requestId: string,
    kind: 'question' | 'approval'
  ): Extract<AgentEvent, { type: 'question-request' | 'approval-request' }> | null {
    const rows = this.store.eventsAfter(sessionId, 0)
    const resolved = kind === 'question' ? 'question-resolved' : 'approval-resolved'
    if (rows.some((r) => r.event.type === resolved && r.event.requestId === requestId)) return null
    const reqType = kind === 'question' ? 'question-request' : 'approval-request'
    const req = rows.find(
      (r) => r.event.type === reqType && (r.event as { requestId?: string }).requestId === requestId
    )
    return req
      ? (req.event as Extract<AgentEvent, { type: 'question-request' | 'approval-request' }>)
      : null
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const t = title.trim().slice(0, 120)
    if (!t) return
    // A deliberate rename wins over any generated title still in flight.
    this.pendingTitles.delete(sessionId)
    const next = this.store.updateSession(sessionId, { title: t })
    if (next) this.notifyMeta(next)
  }

  /** After the first turn: swap the sliced-first-message placeholder for a
   *  generated title. Skips silently if the user renamed meanwhile. */
  private maybeRetitle(sessionId: string): void {
    const pending = this.pendingTitles.get(sessionId)
    if (!pending) return
    this.pendingTitles.delete(sessionId)
    if (this.store.getSession(sessionId)?.title !== pending.placeholder) return
    void generateTitle(pending.text).then((title) => {
      if (!title) return
      const cur = this.store.getSession(sessionId)
      if (!cur || cur.title !== pending.placeholder) return
      const next = this.store.updateSession(sessionId, { title })
      if (next) this.notifyMeta(next)
    })
  }

  /** Fast mode / context window / model: persist and drop the handle — the
   *  next send boots the harness fresh (resume keeps the conversation).
   *  Mid-turn the drop waits for the turn to settle, so the stream is not
   *  cut. A model of another provider is left to send(), which switches
   *  the harness with a transcript handoff; the same provider's model
   *  lands now, so the thread's account re-picks for it at once. */
  async tune(
    sessionId: string,
    patch: { fast?: boolean; ultrafast?: boolean; context1m?: boolean; model?: string }
  ): Promise<void> {
    const meta = this.store.getSession(sessionId)
    if (!meta) throw new Error(`unknown session: ${sessionId}`)
    const { model: requested, ...rest } = patch
    // One service tier at a time: turning either speed on turns the other off.
    if (rest.ultrafast) rest.fast = false
    else if (rest.fast) rest.ultrafast = false
    const routed = requested ? resolveModel(meta.provider, requested) : null
    const model = routed && routed.provider === meta.provider ? routed.model : undefined
    const modelChanged = model !== undefined && model !== meta.model
    if (LIVE_STATUSES.has(meta.status)) this.pendingReboot.add(sessionId)
    else await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, modelChanged ? { ...rest, model } : rest)
    if (next) this.notifyMeta(next)
    if (modelChanged) this.expectAccount(sessionId, { fresh: true })
  }

  /** Edit a live orchestration thread's per-run tune. The handle drops so
   *  the next send boots with the new prompt/rules (resume keeps the
   *  conversation); spawn caps read rules per call and apply at once.
   *  Mid-turn the drop is deferred to the settling status event — a
   *  disposed streaming handle would mute the rest of the turn. */
  async setThreadRules(
    sessionId: string,
    threadRules: SessionMeta['threadRules'] | null
  ): Promise<void> {
    const status = this.store.getSession(sessionId)?.status
    if (status && LIVE_STATUSES.has(status)) {
      this.pendingReboot.add(sessionId)
    } else {
      await this.dropHandle(sessionId)
    }
    const hasContent =
      threadRules &&
      ((threadRules.conduct && Object.keys(threadRules.conduct).length > 0) ||
        threadRules.instructions?.trim())
    const next = this.store.updateSession(sessionId, {
      threadRules: hasContent ? threadRules : null
    })
    if (next) this.notifyMeta(next)
  }

  /** Change the thread's type mid-conversation. Persists the new identity
   *  (plan file for planning, orchestrator agent for orchestration), drops
   *  the handle so the harness reboots with the right system prompt, and —
   *  when the conversation is already underway — flags the thread so the
   *  next send carries the new type's instructions. */
  async retype(sessionId: string, threadType: ThreadType): Promise<void> {
    const meta = this.store.getSession(sessionId)
    // Subagents (parentId set) have no thread identity to change.
    if (!meta || meta.parentId || !meta.threadType || meta.threadType === threadType) return
    await this.dropHandle(sessionId)
    const patch: Parameters<Store['updateSession']>[1] = { threadType }
    // Research owns the planPath slot outright — it is the report
    // destination, minted on entry and released on exit (a report path
    // must never masquerade as a plan for the next type).
    if (threadType === 'research') {
      patch.planPath = reportPathFor(this.reportsRootFor(meta), sessionId)
    } else if (threadType === 'project-plan') {
      // The project plan is one file per project, whatever thread writes it.
      patch.planPath = projectPlanPathFor(meta.cwd)
    } else if (meta.planPath && (isReportPath(meta.planPath) || isProjectPlanPath(meta.planPath))) {
      patch.planPath = threadType === 'planning' ? planPathFor(meta.cwd, sessionId) : null
    } else if (threadType === 'planning' && !meta.planPath) {
      patch.planPath = planPathFor(meta.cwd, sessionId)
    }
    if (threadType === 'orchestration') patch.agentType = 'orchestrator'
    else if (meta.agentType === 'orchestrator') patch.agentType = 'implementer'
    // A still-untitled thread follows its type's placeholder title.
    if ((Object.values(THREAD_TITLES) as string[]).includes(meta.title)) {
      patch.title = THREAD_TITLES[threadType]
    }
    this.store.setRetyped(sessionId, this.store.hasUserText(sessionId))
    const next = this.store.updateSession(sessionId, patch)
    if (next) this.notifyMeta(next)
  }

  /** Live context usage from the session's harness, if it can report it. */
  async contextUsage(sessionId: string): Promise<unknown> {
    // Never poke a streaming harness. Mid-turn control requests can't be
    // answered until the turn settles, and a queue of them at result time
    // can cost the stream its result message — wedging the thread on
    // "working" forever.
    const status = this.store.getSession(sessionId)?.status
    if (status === 'running' || status === 'starting') return null
    const handle = this.handles.get(sessionId)
    if (!handle?.contextUsage) return null
    try {
      return await handle.contextUsage()
    } catch {
      return null
    }
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    // Archiving a running thread is a Stop: the harness and every live
    // subagent get interrupted — dropHandle alone only mutes the handle,
    // leaving the turn (and the fleet) working on a shelved thread.
    if (archived) {
      await this.stopTree(sessionId)
      await this.dropHandle(sessionId, { orphan: true })
    }
    const next = this.store.updateSession(sessionId, { archived })
    if (next) this.notifyMeta(next)
    // Its rows leave the hot file in the background; an unarchive moved
    // them back inside updateSession, before anything reads the thread.
    if (archived) this.coldMover?.kick()
  }

  /** Moves archived threads' rows to the cold file; set by the server. */
  coldMover: { kick(): void } | null = null

  // ── moving a thread to another host (sessionMove.ts) ─────────────────

  /** A thread frozen for a move takes no input: no send, no queue, no harness. */
  private assertNotMoving(sessionId: string): void {
    const to = this.store.movingTo(sessionId)
    if (to) throw new Error('this thread is moving to another host; try again once it lands')
  }

  /** Why the subtree at rootId cannot move now, or null when it is at rest:
   *  nothing live or paused, no approval or question waiting, nothing
   *  queued, no report or pass pending, no harness starting. */
  moveBlocker(rootId: string): string | null {
    const tree = this.sessionTree(rootId)
    if (tree.length === 0) return `unknown session: ${rootId}`
    for (const s of tree) {
      const who = s.id === rootId ? 'the thread' : `its subagent "${s.title}"`
      if (LIVE_STATUSES.has(s.status) || this.starting.has(s.id)) return `${who} is working; stop it or wait for it to finish`
      if (s.status === 'paused') return `${who} is paused; stop it first`
      if (this.pendingApprovals.get(s.id)?.size) return `${who} is waiting on an approval`
      if (this.queues.get(s.id)?.length) return `${who} has queued messages`
      if (this.pendingReports.get(s.id)?.length || this.passActive.has(s.id) || this.passPending.has(s.id) || this.draining.has(s.id))
        return `${who} is still settling its last turn`
      if (this.store.movingTo(s.id)) return 'the thread is already moving'
    }
    return null
  }

  /** The subtree's ids, root first, as the registry sees them. */
  treeIds(rootId: string): string[] {
    return this.sessionTree(rootId).map((s) => s.id)
  }

  /** Check the subtree is at rest and freeze it toward `to` in the same tick,
   *  then let go of its idle harnesses (a frozen thread spawns none). */
  async freezeForMove(rootId: string, freeze: (ids: string[]) => void): Promise<string[]> {
    const blocker = this.moveBlocker(rootId)
    if (blocker) throw new Error(blocker)
    const ids = this.treeIds(rootId)
    freeze(ids)
    for (const id of ids) await this.dropHandle(id)
    return ids
  }

  /** The thread left for `to`: forget it here the way delete() does, and
   *  tell clients where it went before they hear it was removed. */
  async departed(rootId: string, ids: string[], to: string): Promise<void> {
    for (const id of ids) {
      await this.dropHandle(id)
      this.queues.delete(id)
      this.passPending.delete(id)
      this.passActive.delete(id)
      this.stopping.delete(id)
      this.pendingReboot.delete(id)
      this.pendingApprovals.delete(id)
      this.lastActivity.delete(id)
      this.activities.delete(id)
      this.todoFolds.delete(id)
      this.warming.delete(id)
      this.folds.delete(id)
      this.foldDirty.delete(id)
      this.pendingGoals.delete(id)
      this.liveContexts.delete(id)
    }
    for (const l of this.movedListeners) l(rootId, ids, to)
    for (const l of this.removedListeners) l(ids)
    for (const id of ids) this.subscribers.delete(id)
  }

  /** A thread landed here from another host: load its folds and announce it. */
  arrived(ids: string[]): void {
    for (const id of ids) {
      const fold = this.store.getFold(id)
      if (fold) this.folds.set(id, fold)
      else this.folds.delete(id)
      this.todoFolds.delete(id)
      this.warming.delete(id)
      const meta = this.store.getSession(id)
      if (meta?.context) this.liveContexts.set(id, meta.context)
    }
    for (const id of ids) {
      const meta = this.store.getSession(id)
      if (meta) this.notifyMeta(meta)
    }
  }

  /** A freeze lifted with the thread still here: clients see it as it was. */
  thawed(ids: string[]): void {
    for (const id of ids) {
      const meta = this.store.getSession(id)
      if (meta) this.notifyMeta(meta)
    }
  }

  onMoved(listener: MovedListener): () => void {
    this.movedListeners.add(listener)
    return () => this.movedListeners.delete(listener)
  }

  async delete(sessionId: string): Promise<void> {
    // Same Stop-first rule as archive: interrupt the whole subtree while
    // the rows still exist, so no harness keeps executing (or spawning)
    // against a thread that is about to be gone.
    await this.stopTree(sessionId)
    this.queues.delete(sessionId)
    this.passPending.delete(sessionId)
    this.passActive.delete(sessionId)
    const all = this.store.listSessions()
    const root = all.find((s) => s.id === sessionId)
    const ids = this.store.deleteSessionTree(sessionId)
    this.store.clearResumeAfterBoot(ids)
    for (const id of ids) {
      await this.dropHandle(id)
      this.stopping.delete(id)
      this.pendingReboot.delete(id)
      this.pendingApprovals.delete(id)
      this.subscribers.delete(id)
      this.lastActivity.delete(id)
      this.activities.delete(id)
      this.todoFolds.delete(id)
      this.warming.delete(id)
      this.folds.delete(id)
      this.foldDirty.delete(id)
      this.pendingGoals.delete(id)
      this.liveContexts.delete(id)
      this.notices.delete(id)
      this.notesReminded.delete(id)
      this.turnCommitted.delete(id)
      this.turnNoted.delete(id)
      this.notesDue.delete(id)
      this.notesReminderSent.delete(id)
      const meta = all.find((s) => s.id === id)
      if (meta) removeMirror(this, meta) // mirrors die with the thread
      if (meta) sweepThreadAttachments(meta) // and so do its uploaded attachments
    }
    await removePages(ids) // and so do the agent's HTML pages
    // The journal never dangles into a missing plan file.
    if (root?.threadType === 'planning' && root.projectId) {
      const cwd = this.store.getProject(root.projectId)?.cwd
      if (cwd) await appendJournal(cwd, `plan "${root.title}" thread deleted`)
    }
    for (const l of this.removedListeners) l(ids)
  }

  /** Change approval policy; the harness restarts (with resume) on next send. */
  async setPermission(sessionId: string, permission: SessionMeta['permission']): Promise<void> {
    await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, { permission })
    if (next) this.notifyMeta(next)
  }

  async restart(sessionId: string): Promise<void> {
    await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, {
      status: 'idle',
      busySince: null,
      pausedAt: null,
      frozenActiveElapsed: null
    })
    this.store.clearResumeAfterBoot([sessionId])
    if (next) this.notifyMeta(next)
  }

  /** The Continue button on an errored thread: the user fixed what killed
   *  the turn (switched accounts on a session limit), so settle the shown
   *  errors, reboot the harness (resume keeps the conversation), and tell
   *  it to pick the work back up. Errored subagents continue first, so an
   *  orchestrator wakes to a fleet that is already moving again. `run`
   *  restarts every one of them on another model or effort first. */
  async continueRun(sessionId: string, reason?: string, run?: RunSettings): Promise<void> {
    const tree = this.sessionTree(sessionId)
    if (tree.length === 0) return
    const affected = tree.filter((session) => this.canContinueError(session))
    if (affected.length === 0) return

    const affectedIds = new Set(affected.map((session) => session.id))
    const depth = new Map<string, number>()
    for (const session of tree) {
      let value = 0
      let cursor = session
      while (cursor.parentId) {
        value++
        const parent = tree.find((candidate) => candidate.id === cursor.parentId)
        if (!parent) break
        cursor = parent
      }
      depth.set(session.id, value)
    }
    // Failed descendants restart first. The requested session also wakes
    // when only its descendants failed, so an orchestrator resumes with its
    // fleet already moving.
    const targets = tree
      .filter((session) => affectedIds.has(session.id) || session.id === sessionId)
      .sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0))
    const failures: unknown[] = []
    for (const target of targets) {
      try {
        await this.continueErroredSession(
          target.id,
          affected.some((session) => session.parentId === target.id),
          reason,
          run
        )
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to continue ${failures.length} session(s)`)
    }
  }

  async continueAllErrors(): Promise<SessionBatchResult> {
    const roots = this.list().filter(
      (session) => !session.parentId && !session.archived && session.treeCanContinue
    )
    return this.runRootBatch(roots, (root) => this.continueRun(root.id))
  }

  /** Pause every root that still has live work. */
  async pauseAllRunning(): Promise<SessionBatchResult> {
    const roots = this.list().filter(
      (session) => !session.parentId && !session.archived && session.treeHasLiveWork
    )
    return this.runRootBatch(roots, (root) => this.pauseRun(root.id))
  }

  async resumeAllPaused(): Promise<SessionBatchResult> {
    const roots = this.list().filter(
      (session) => !session.parentId && !session.archived && session.treeHasPaused
    )
    return this.runRootBatch(roots, (root) => this.resumePausedRun(root.id))
  }

  /** One action over the given threads (each through its root, once), at
   *  most four calls in flight, every id answered: the menus' Pause all,
   *  Resume all, Stop all and Archive done. Resume covers a paused tree;
   *  Stop interrupts a running or waiting one; Archive stops first, as a
   *  single archive does. `cleanup` also runs `resourceCleanup` after each
   *  archive when a host has one. */
  async batch(
    action: SessionBatchAction,
    ids: readonly string[],
    options: { cleanup?: boolean } = {}
  ): Promise<SessionBatchResult> {
    return runSessionBatch(action, ids, {
      rootOf: (id) => this.rootSessionOf(id),
      run: (what, rootId) => {
        switch (what) {
          case 'pause':
            return this.pauseRun(rootId)
          case 'resume':
            return this.resumePausedRun(rootId)
          case 'stop':
            // Stop on a queued root is "Remove from queue": it holds no turn.
            return this.store.getSession(rootId)?.status === 'queued'
              ? this.setArchived(rootId, true)
              : this.stopRun(rootId)
          case 'archive':
            return this.setArchived(rootId, true)
        }
      },
      cleanup: this.resourceCleanup ?? undefined
    }, options)
  }

  /** Releases what an archived thread held (worktree, simulator, …); set
   *  by the server when the host has such a thing, else null and the
   *  batch's `cleanup` is a no-op. */
  resourceCleanup: ((sessionId: string) => Promise<void>) | null = null

  private async runRootBatch(
    roots: SessionMeta[],
    action: (root: SessionMeta) => Promise<void>
  ): Promise<SessionBatchResult> {
    const attempted = [...new Set(roots.map((root) => root.id))]
    const settled = await Promise.allSettled(
      attempted.map((id) => action(roots.find((root) => root.id === id)!))
    )
    const succeeded: string[] = []
    const failed: SessionBatchResult['failed'] = []
    settled.forEach((result, index) => {
      const sessionId = attempted[index]
      if (result.status === 'fulfilled') succeeded.push(sessionId)
      else {
        failed.push({
          sessionId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        })
      }
    })
    return { attempted, succeeded, failed }
  }

  /** The transcript a native-resume provider's harness needs when the
   *  thread has history but no native id to resume: the driver forgot one
   *  its harness had no transcript for (recoverLostNativeSession), so the
   *  fresh process gets the thread's own dialogue as context, the way a
   *  provider switch seeds the new harness. A new thread has no assistant
   *  text yet and a live handle already holds the context: both get nothing. */
  private lostNativeHandoff(meta: SessionMeta): string {
    if (meta.nativeId !== null || !NATIVE_RESUME_PROVIDERS.has(meta.provider)) return ''
    if (this.handles.has(meta.id) || !this.store.hasAssistantText(meta.id)) return ''
    return transcriptHandoff(this.store.eventsAfter(meta.id, 0))
  }

  /** The driver's harness had no transcript for the native id it was asked
   *  to resume (the thread's history moved here from another machine, or
   *  the CLI's store was purged); the id is forgotten. The failed turn
   *  is still settling (its result, then the stream's own error); once the
   *  status is at rest, boot fresh and continue — lostNativeHandoff replays
   *  the thread's transcript, so the last user message gets its answer. */
  private async recoverLostNativeSession(sessionId: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const meta = this.store.getSession(sessionId)
      if (!meta) return
      if (!LIVE_STATUSES.has(meta.status)) break
      await new Promise<void>((resolve): void => void setTimeout(resolve, 250))
    }
    try {
      await this.continueErroredSession(
        sessionId,
        false,
        "this host having no transcript for the thread's native session (its history moved here from another machine); the conversation so far is replayed above, so answer its last user message"
      )
    } catch (err) {
      console.error(
        `[sessions] lost native session: recovery failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async continueErroredSession(
    sessionId: string,
    restartedDescendants: boolean,
    reason = 'a harness error (a session limit or similar) that the user has since fixed',
    run?: RunSettings
  ): Promise<void> {
    const meta = this.store.getSession(sessionId)
    if (
      !meta ||
      meta.status === 'running' ||
      meta.status === 'starting' ||
      meta.status === 'paused'
    ) {
      if (meta?.status === 'paused') throw new Error(`session ${sessionId} is manually paused`)
      return
    }
    await this.dropHandle(sessionId)
    const switched = run ? await this.applyRunSettings(sessionId, meta, run) : { handoff: '' }
    const handoff = switched.handoff || this.lostNativeHandoff(this.store.getSession(sessionId) ?? meta)
    try {
      void this.armBaseline(sessionId)
      const handle = await this.handleFor(sessionId)
      this.lastActivity.set(sessionId, Date.now())
      await handle.send(
        `${handoff ? `${handoff}\n\n` : ''}<continue-run>\nThe previous turn was cut off by ${reason}. ${restartedDescendants ? 'Your failed subagents were restarted first and are picking their work back up. ' : ''}Continue exactly where you left off: check your task list and your last few actions, finish anything half-done, and keep going. If the work was already complete, say so in one short line.\n</continue-run>`
      )
      // The replacement accepted the work. Only now settle the old chips;
      // a boot or send failure leaves the fold true for another retry.
      if (this.storedContinuableError(sessionId)) this.append(sessionId, { type: 'errors-cleared' })
      this.erroredTurns.delete(sessionId)
      this.limited.delete(sessionId)
    } catch (error) {
      this.limited.delete(sessionId)
      const current = this.store.getSession(sessionId)
      if (current && current.status !== 'paused') {
        this.append(sessionId, { type: 'status', status: 'error' })
      }
      throw error
    }
  }

  /** Dispose a session's harness. `orphan` says no replacement will boot:
   *  the row is shelved, so an open status is settled idle here. Without
   *  it only a watching row settles — a mid-turn drop (harness gone, a
   *  reboot) hands the live turn to a fresh handle with no status write,
   *  and marking it idle would show a running turn as finished. */
  private async dropHandle(sessionId: string, opts: { orphan?: boolean } = {}): Promise<void> {
    const inflight = this.starting.get(sessionId)
    if (inflight) await inflight.catch(() => {})
    this.denyPendingApprovals(sessionId)
    const handle = this.handles.get(sessionId)
    this.handles.delete(sessionId)
    this.starting.delete(sessionId)
    if (handle) await handle.dispose().catch(() => {})
    if (handle || inflight) this.scheduler.schedule()
    // The process took its background tasks with it: a watching row has
    // nothing left to wait on (the disposed handle stays mute, so this is
    // the only idle it will get).
    // An archived row gets the same: interrupt() only asked the handle to
    // stop and left the closing idle to its stream, which the disposed
    // handle never relays — the row would stay running with no process.
    this.watching.delete(sessionId)
    const status = this.store.getSession(sessionId)?.status
    if (status === 'watching' || (opts.orphan && status && LIVE_STATUSES.has(status))) {
      this.append(sessionId, { type: 'status', status: 'idle' })
    }
  }

  /** A harness spawned into a missing cwd dies with the SDK's misleading
   *  "binary failed to launch (libc)" error. Catch it here instead — and
   *  for app-managed project worktrees, quietly remake the checkout: same
   *  slug → same path, and the branch is re-created from the repo HEAD
   *  when it was deleted along with the directory. */
  private async ensureCwd(meta: SessionMeta): Promise<void> {
    if (existsSync(meta.cwd)) return
    const project = meta.projectId ? this.store.getProject(meta.projectId) : null
    if (project && project.mode === 'worktree' && project.cwd === meta.cwd) {
      const ws = this.store.listWorkspaces().find((w) => w.id === project.workspaceId)
      if (ws) {
        const restored = await addProjectWorktree(ws.path, project.name, {
          branch: project.branch ?? undefined
        })
        if (restored.cwd === meta.cwd) return
        throw new Error(
          `this project's checkout was missing; its branch is now checked out at ${restored.cwd}, not ${meta.cwd} — repoint the project or remove that checkout`
        )
      }
    }
    throw new Error(`this thread's folder no longer exists: ${meta.cwd}`)
  }

  private async handleFor(sessionId: string): Promise<DriverHandle> {
    const existing = this.handles.get(sessionId)
    if (existing) return existing
    const inflight = this.starting.get(sessionId)
    if (inflight) return inflight

    const stored = this.store.getSession(sessionId)
    if (!stored) throw new Error(`unknown session: ${sessionId}`)
    this.assertNotMoving(sessionId)
    // Every respawn (continue, account refresh, resume) reads the row, so a
    // row holding a display slug (`fable-5.1`) must be normalized here too,
    // not only at send time: the driver launches `--model` from this.
    const routed = resolveModel(stored.provider, stored.model)
    const meta = routed.provider === stored.provider ? { ...stored, model: routed.model } : stored
    const driver = BUILT_IN_DRIVERS[meta.provider]
    // The account this process spends from: the pin that applies (its
    // project's, its workspace's), else the best account for its model by
    // the live load right now. Nothing is warm at spawn (no process), so
    // the sticky account is ignored, the same rule refreshAccount applies
    // to idle threads; a burst of resumes then spreads instead of stacking
    // on the last snapshot's favourite. The row shows the pick at once; the
    // gateway corrects it.
    const pin = this.pinOf(meta)
    const { route, current, vanished } = this.limits?.routeFor(meta, pin, { fresh: true }) ?? { route: null, current: null }
    if (vanished) this.accountGone(meta, pin, vanished)
    this.spawnedPin.set(sessionId, vanished?.pin ? null : (pin?.name ?? null))
    this.setAccount(sessionId, current)

    const startP = this.ensureCwd(meta)
      .then(() =>
        driver.start({
          // Drivers seed goal state from here (resume dedup, watcher init).
          session: { ...meta, goal: this.goalOf(sessionId) },
          route,
          emit: (event) => this.append(sessionId, event),
          requestApproval: (req) => this.requestApproval(sessionId, req),
          awaitBaseline: () => this.awaitBaseline(sessionId),
          mark: (phase, note) => this.spans.mark(sessionId, phase, note),
          toolResultTail: (callId, output) => this.toolResultTail?.(sessionId, callId, output) ?? Promise.resolve(null),
          setNativeId: (nativeId) => {
            const next = this.store.updateSession(sessionId, { nativeId })
            if (next) this.notifyMeta(next)
          },
          nativeSessionLost: () => {
            const next = this.store.updateSession(sessionId, { nativeId: null })
            if (next) this.notifyMeta(next)
            void this.recoverLostNativeSession(sessionId)
          }
        })
      )
      .then((handle) => {
        this.handles.set(sessionId, handle)
        this.starting.delete(sessionId)
        // A thread that went idle while its harness booted can now give its
        // slot to the queue (reclaimIdle only puts down a booted harness).
        if (this.indexOf().byId.get(sessionId)?.status === 'idle') this.scheduler.schedule()
        return handle
      })
      .catch((err) => {
        this.starting.delete(sessionId)
        this.append(sessionId, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
        this.append(sessionId, { type: 'status', status: 'error' })
        throw err
      })
    this.starting.set(sessionId, startP)
    return startP
  }

  append(sessionId: string, event: AgentEvent): void {
    // Streaming previews (partial tool input) are broadcast-only: each one
    // carries the whole input so far, so persisting them would write the
    // same growing payload into the log over and over. The final tool-call
    // event has everything replay needs. A streamed Write sends many a
    // second: they leave before any lookup.
    if (event.type === 'tool-call' && event.partial) {
      const row: EventRow = { sessionId, seq: -1, ts: Date.now(), event, ephemeral: true }
      for (const listener of this.subscribers.get(sessionId) ?? []) listener(row)
      return
    }
    // A manual pause wins races with the old provider and with a replacement
    // handle that has not accepted its continuation yet. Pause never gains
    // an error chip or loses its state through a late status callback.
    // Every row read on this path is the index's (sessionIndex.ts), never a SELECT.
    const persisted = this.row(sessionId)
    if (persisted?.status === 'paused' && (event.type === 'status' || event.type === 'error')) {
      return
    }
    // A master whose batch is open never idles (CLAUDE.md "Master threads"):
    // its harness stays up as `watching` and the batch's settles and reports
    // wake it; batch.ts open() says when the batch is done and the next idle
    // is a real one. Below, such a watching counts as idle for the queue,
    // the completed-turn pass and the boot ledger.
    // A second silence on one message (the first-output watchdog): the idle
    // the driver settles with is an error, with the row that says why.
    if (event.type === 'status' && event.status === 'idle' && this.silenceFailed.delete(sessionId)) {
      this.append(sessionId, { type: 'error', message: FIRST_OUTPUT_GAVE_UP })
      event = { type: 'status', status: 'error' }
    }
    const masterWatch = event.type === 'status' && event.status === 'idle' && this.masterKeepsWatching(sessionId)
    if (masterWatch) event = { type: 'status', status: 'watching' }
    // Research boards: web tool calls anywhere in a research thread's agent
    // tree surface as research-source events on the ROOT session (partials
    // returned above, so every tool-call here is final).
    if (event.type === 'tool-call') this.harvestResearchCall(sessionId, event)
    else if (event.type === 'tool-result') this.harvestResearchTitle(sessionId, event)
    // A turn's phase before its first content is activity, never a row:
    // folded onto the meta and pushed, then dropped.
    if (event.type === 'phase') {
      const act = activityOf(event)
      if (act === null) this.activities.delete(sessionId)
      else if (act) this.activities.set(sessionId, act)
      const meta = this.row(sessionId)
      if (meta) this.notifyMeta(meta)
      return
    }
    // Live context accounting is meta, not transcript: fold it onto the
    // session row and push, never into the log.
    if (event.type === 'context') {
      const prev = this.liveContexts.get(sessionId)
      const window = event.window ?? prev?.window ?? null
      if (prev?.tokens === event.tokens && prev?.window === window) return
      const context = { tokens: event.tokens, window }
      this.liveContexts.set(sessionId, context)
      this.store.setSessionContext(sessionId, context)
      const meta = this.row(sessionId)
      if (meta) this.notifyMeta(meta)
      this.checkNotesReminder(sessionId, event.tokens, window)
      return
    }
    // The window was squeezed: the next thing this harness reads is the
    // thread's own notes (threadNotes.ts), ahead of whatever comes next —
    // into the live turn now, else ahead of the next message. The window
    // is fresh again for the pre-compaction reminder.
    if (event.type === 'compaction' && event.phase === 'done') {
      this.notesReminded.delete(sessionId)
      const text = this.notes.textFor(sessionId)
      if (text) this.whisper(sessionId, notesAfterCompaction(text))
    }
    // What the running turn did, for the post-commit reminder: a shell
    // call that commits or merges, and whether update_notes ran.
    if (event.type === 'tool-call') {
      if (isNotesCall(event.name)) this.turnNoted.add(sessionId)
      else if (isCommitCall(event.name, event.input)) this.turnCommitted.add(sessionId)
    }
    // The thread already has its "needs sign-in" row: the harness's own
    // report of the same 401 adds nothing.
    if (event.type === 'error' && this.signIns.has(sessionId) && UNAUTHORIZED_WORDING.test(event.message)) return
    // The user hit Stop: the driver reports the cut-off turn as an error
    // ("turn ended: …") — stamp it so it reads as a stop, not a failure.
    if (event.type === 'error' && this.stopping.has(sessionId)) {
      event = { ...event, stopped: true }
    }
    // A failure (never a stop or a wind-down note) carries the host's
    // verdict from here on; a driver that already classified keeps its own.
    if (event.type === 'error' && !event.stopped && !event.failure && !event.message.startsWith('turn ended:')) {
      event = { ...event, failure: this.classify(sessionId, event) }
    }
    if (event.type === 'status') {
      this.stopping.delete(sessionId)
      // A tune saved mid-turn waits here: the turn has settled, so the
      // harness can now reboot with the new rules (resume keeps the
      // conversation).
      if (
        (event.status === 'idle' || event.status === 'error') &&
        this.pendingReboot.delete(sessionId)
      ) {
        void this.dropHandle(sessionId)
      }
    }
    // The task fold is taken before the insert, so a warm-up it starts
    // reads only the rows before this one (todoFoldOf); null while one
    // reads, and this row waits for it.
    const warm = this.todoFoldOf(sessionId)
    const prev = this.folds.get(sessionId) ?? toFoldRow(sessionId, newFoldState())
    const row = this.store.appendEvent(sessionId, event)
    this.lastActivity.set(sessionId, row.ts)
    if (event.type === 'user-text') this.lastUserSeq.set(sessionId, row.seq)
    let tasksMoved = false
    let recoveryMoved = false
    let failureMoved = false
    // A goal event pushes meta so the prompt-bar indicator flips without
    // a status change.
    let goalMoved = false
    if (warm) {
      const before = tallyOf(warm)
      foldTodo(warm, event, row.ts)
      const after = tallyOf(warm)
      tasksMoved = before?.done !== after?.done || before?.total !== after?.total || before?.current !== after?.current
      const afterRecovery = foldContinuableError(prev.canContinue, event)
      recoveryMoved = prev.canContinue !== afterRecovery
      const afterFailure = foldFailure(prev.failure ?? null, event)
      failureMoved = (prev.failure ?? null) !== afterFailure
      goalMoved = event.type === 'goal'
      // The task snapshot rides along at turn edges and when the list moved;
      // between them the row keeps an older one, which says where it stands.
      const snapshot = tasksMoved || event.type === 'status' || event.type === 'turn-complete' || event.type === 'user-text'
      const next: FoldRow = {
        sessionId,
        foldedSeq: row.seq,
        foldVersion: FOLD_VERSION,
        tasks: after,
        goal: foldGoal(prev.goal, event, row.ts),
        canContinue: afterRecovery,
        failure: afterFailure,
        todo: snapshot ? serializeTodo(warm, row.seq) : (prev.todo ?? null)
      }
      // A streamed delta changes no fold output, only the watermark: it
      // waits for the next non-delta event (a tool call, a status) or the
      // timer, so a token stream costs no fold writes.
      if (tasksMoved || goalMoved || recoveryMoved || failureMoved || !isDelta(event)) this.putFold(next)
      else this.deferFold(next)
    } else this.warming.get(sessionId)?.live.push(row)
    // A finished first turn upgrades the sliced-first-message title to a
    // generated one (fire-and-forget; the slice stays if the call fails).
    if (event.type === 'turn-complete') this.maybeRetitle(sessionId)
    // Track "where it's at" for the tabs; a change on a non-status event
    // pushes its own meta update (status events notify below regardless).
    const act = activityOf(event)
    const actMoved = act !== undefined && act?.text !== this.activities.get(sessionId)?.text
    if (actMoved) {
      if (act === null) this.activities.delete(sessionId)
      else this.activities.set(sessionId, act)
    }
    // What a watching thread waits on, for the header line. Any settle
    // (idle, error, done) ends the wait whatever the driver last listed.
    let watchMoved = false
    if (event.type === 'background-tasks') {
      // An old driver's row (replayed) has only the strings: each is a task.
      const items =
        event.items ?? event.tasks.map((label, i) => ({ id: `task:${i}`, label, kind: 'other' as const, startedAt: row.ts }))
      watchMoved = JSON.stringify(this.watching.get(sessionId) ?? []) !== JSON.stringify(items)
      if (items.length) this.watching.set(sessionId, items)
      else this.watching.delete(sessionId)
    } else if (
      event.type === 'status' &&
      (event.status === 'idle' || event.status === 'error' || event.status === 'done')
    ) {
      this.watching.delete(sessionId)
    }
    if ((actMoved || tasksMoved || goalMoved || recoveryMoved || failureMoved || watchMoved) && event.type !== 'status') {
      const meta = this.row(sessionId)
      if (meta) this.notifyMeta(meta)
    }
    let settleToReport: SessionMeta | null = null
    // Status events also update the session row (drives the sidebar).
    // busySince anchors the "working for" timers: it is set when a stretch
    // of work begins and holds through steers and queue drains, so the
    // clock counts from the first message, not the latest wake-up.
    if (event.type === 'status') {
      const cur = this.row(sessionId)
      const busySince =
        event.status === 'idle'
          ? (this.queues.get(sessionId)?.length ?? 0) > 0
            ? (cur?.busySince ?? null)
            : null
          : (cur?.busySince ?? row.ts)
      if (event.status !== 'watching') this.watchingSince.delete(sessionId)
      else if (cur?.status !== 'watching' || !this.watchingSince.has(sessionId)) this.watchingSince.set(sessionId, row.ts)
      const next = this.store.updateSession(sessionId, { status: event.status, busySince })
      if (next) this.notifyMeta(next)
      // The parent's live subagents and a master's batch count change with
      // this row's status: push them again (the root already went out above).
      if (next && cur?.status !== next.status) this.notifyWaiters(next)
      // The ledger of threads mid-turn (resumeAfterBoot.ts): a row while a
      // harness works the turn, gone the moment it settles, so a boot after
      // any kind of death knows exactly what to bring back.
      if (event.status === 'running' || event.status === 'starting' || masterWatch) this.recordMidTurn(sessionId, row.ts)
      else if (!(event.status === 'queued' && this.queuedResumes.has(sessionId))) {
        this.queuedResumes.delete(sessionId)
        this.store.clearResumeAfterBoot([sessionId])
      }
      // Live change stream (M22): watchers follow running sessions.
      if (next) liveDiffOnStatus(this, next, cur?.status)
      // A settled turn runs the pending completed-turn pass first; only a
      // fully settled session (pass included) releases queued messages. A
      // settle into watching (background tasks live, or a master's open
      // batch) is a settle too: the harness is idle behind its work, so the
      // reports parked for it and then the person's next message go in as
      // turns of their own, as they would on idle.
      if (event.status === 'idle' || event.status === 'watching') {
        const pass = this.passActive.has(sessionId) ? null : this.passPending.get(sessionId)
        this.passActive.delete(sessionId)
        if (pass) {
          this.passPending.delete(sessionId)
          this.passActive.add(sessionId)
          void this.runTurnPass(sessionId, pass)
        } else if (this.notesDue.delete(sessionId) && !this.notesReminderSent.has(sessionId)) {
          // A commit without a notes update: the reminder is its own short
          // turn when nothing else waits, else a line ahead of what does.
          this.notesReminderSent.add(sessionId)
          const busy = (this.queues.get(sessionId)?.length ?? 0) > 0 || (this.pendingReports.get(sessionId)?.length ?? 0) > 0
          if (busy) {
            this.holdNotice(sessionId, NOTES_REMINDER_COMMIT)
            this.drainSettled(sessionId)
          } else void this.runNotesReminder(sessionId)
        } else {
          this.drainSettled(sessionId)
        }
      }
      if (event.status === 'error') {
        this.passPending.delete(sessionId)
        this.passActive.delete(sessionId)
      }
      // Dormant supervision: a subagent leaving "running" wakes its parent
      // with an automatic report — immediately when the parent is idle,
      // queued behind its current work otherwise. Skipped when a
      // wait_for_agent already covers this child. running → watching IS a
      // settle (the reply is complete; the report says what it still
      // waits on) and watching → idle adds nothing; a watching child that
      // errors, stops (its harness died) or asks something reports again.
      // A root thread of a master's batch (masterId) wakes the master the
      // same way, and the thread that started it (startedBy) too, once
      // each; a settle is one report per listener whoever sent the message
      // that started the turn, the master included.
      if (next && settleTargets(next).length > 0 && isSettleReport(cur?.status, event.status)) {
        settleToReport = next
      }
      // A planning thread settling with a complete plan (plan_complete was
      // called this turn) runs the plan flow: the build starts when the
      // settings say so, and whoever started the plan hears of it. A batch
      // thread's master hears of it through that one report, not two.
      if (isPlanSettle(cur?.status, event.status, next)) {
        if (!next!.parentId) settleToReport = null
        void settlePlan(this.planFlow(), next!)
      }
    }
    // Track disk-writing tools in flight — the live change stream's
    // ownership source. Partial calls open early (execution starts later,
    // so the window is a harmless superset); the result closes.
    if (event.type === 'tool-call' && DISK_TOOLS.has(event.name)) {
      let calls = this.diskToolCalls.get(sessionId)
      if (!calls) {
        calls = new Map()
        this.diskToolCalls.set(sessionId, calls)
      }
      if (!calls.has(event.callId)) calls.set(event.callId, null)
    } else if (event.type === 'tool-result') {
      const calls = this.diskToolCalls.get(sessionId)
      if (calls?.get(event.callId) === null) calls.set(event.callId, row.ts)
    } else if (event.type === 'status' && event.status !== 'running' && event.status !== 'waiting') {
      // Turn boundary: close anything still open (a died turn never sends
      // results) and drop entries long past the grace. 'waiting' is not a
      // boundary: a supervised tool call sits open behind its approval and
      // writes only after the user allows it.
      const calls = this.diskToolCalls.get(sessionId)
      if (calls) {
        for (const [id, closed] of calls) {
          if (closed === null) calls.set(id, row.ts)
          else if (row.ts - closed > 60_000) calls.delete(id)
        }
      }
    }
    // An error event taints the whole turn (drivers emit it and still
    // settle with status idle — seen with usage-limit errors).
    if (event.type === 'error') {
      this.erroredTurns.add(sessionId)
      this.passPending.delete(sessionId)
      if (event.limit && !event.stopped) this.onLimitError(sessionId, event.limit.window)
      if (event.message === FIRST_OUTPUT_SILENCE) this.recoverSilence(sessionId)
    }
    // A limited session settling lets its pending switch continue the tree;
    // one moving again by other means no longer waits on it.
    if (event.type === 'status' && this.limited.has(sessionId)) {
      if (event.status === 'idle' || event.status === 'error') this.continueAfterLimit(sessionId)
      else if (event.status === 'running') this.limited.delete(sessionId)
    }
    // Shared context (M8): a finished turn refreshes the thread's mirror.
    if (event.type === 'turn-complete') {
      // A root thread that committed or merged this turn without touching
      // its notes owes a reminder turn once it settles (idle below).
      if (this.turnCommitted.has(sessionId) && !this.turnNoted.has(sessionId) && !persisted?.parentId) {
        this.notesDue.add(sessionId)
      }
      this.turnCommitted.delete(sessionId)
      this.turnNoted.delete(sessionId)
    }
    if (event.type === 'turn-complete' && persisted?.status !== 'paused') {
      if (this.row(sessionId)?.projectId) scheduleMirror(this, sessionId)
      if (!this.erroredTurns.has(sessionId)) {
        this.armTurnPass(sessionId)
        // A turn went through: the sign-in works again, so a later 401 posts afresh.
        this.signIns.delete(sessionId)
      }
    }
    for (const listener of this.subscribers.get(sessionId) ?? []) listener(row)
    for (const listener of this.eventListeners) listener(row)
    if (settleToReport) notifyParentOfSettle(this, settleToReport)
  }

  // ── research boards (sources harvested from the agent tree) ─────────

  /** The research thread this session's ancestor chain roots in, if any. */
  researchRootOf(sessionId: string): SessionMeta | null {
    const root = this.row(this.rootSessionOf(sessionId))
    return root?.threadType === 'research' ? root : null
  }

  private researchSeenOf(rootId: string): Map<string, { callId: string; claimed: boolean }> {
    let seen = this.researchSeen.get(rootId)
    if (!seen) {
      seen = new Map()
      this.researchSeen.set(rootId, seen)
    }
    return seen
  }

  /** A final tool call in a research tree becomes a research-source event
   *  on the root: WebSearch/web_search board their query, WebFetch its
   *  url, and a Bash/shell command that runs curl or wget boards every
   *  public url it names (codex has no fetch tool; it reads through curl).
   *  Deduped per (agent, query/url); callIds are prefixed with the calling
   *  session so agents' "call_1"s never collide in one log. */
  private harvestResearchCall(
    sessionId: string,
    event: Extract<AgentEvent, { type: 'tool-call' }>
  ): void {
    const isSearch = /^(websearch|web_search)$/i.test(event.name)
    const isFetch = /^(webfetch|web_fetch)$/i.test(event.name)
    const isShell = /^(bash|shell)$/i.test(event.name)
    if (!isSearch && !isFetch && !isShell) return
    const root = this.researchRootOf(sessionId)
    if (!root) return
    const input = (
      event.input && typeof event.input === 'object' ? event.input : {}
    ) as Record<string, unknown>
    const agentLabel = this.row(sessionId)?.title ?? 'research'
    const callId = `${sessionId}:${event.callId}`
    if (isSearch) {
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      const seen = this.researchSeenOf(root.id)
      if (!query || seen.has(`q:${sessionId}:${query}`)) return
      seen.set(`q:${sessionId}:${query}`, { callId, claimed: false })
      this.append(root.id, { type: 'research-source', callId, query, agentId: sessionId, agentLabel })
    } else if (isFetch) {
      const url = typeof input.url === 'string' ? input.url.trim() : ''
      if (url) this.boardUrl(root.id, sessionId, agentLabel, callId, url, true)
    } else {
      const urls = shellReadUrls(typeof input.command === 'string' ? input.command : '')
      // One url: its result can carry the page title. Several: bare rows.
      urls.forEach((url, i) =>
        this.boardUrl(
          root.id,
          sessionId,
          agentLabel,
          urls.length === 1 ? callId : `${callId}:${i}`,
          url,
          urls.length === 1
        )
      )
    }
  }

  /** One consulted url on the root's board, once per agent. */
  private boardUrl(
    rootId: string,
    sessionId: string,
    agentLabel: string,
    callId: string,
    url: string,
    enrichTitle: boolean
  ): void {
    const seen = this.researchSeenOf(rootId)
    const key = `u:${sessionId}:${url}`
    if (seen.has(key)) return
    seen.set(key, { callId, claimed: false })
    if (enrichTitle) this.researchFetches.set(callId, { rootId, url, agentId: sessionId, agentLabel })
    this.append(rootId, { type: 'research-source', callId, url, agentId: sessionId, agentLabel })
  }

  /** cite_source: a claim pinned to a source. A url this agent already
   *  boarded (fetch or shell read) and has not cited yet gets the claim on
   *  its own row — the same callId, which the fold treats as enrichment;
   *  anything else is a fresh row with a `cite:` callId that no restart can
   *  repeat. Refuses outside a research tree. */
  citeSource(sessionId: string, args: CiteSourceArgs): string {
    const root = this.researchRootOf(sessionId)
    if (!root) {
      return 'refused: cite_source only works inside a research thread or its subagents; this thread is not one.'
    }
    const url = args.url.trim()
    const claim = args.claim.trim().replace(/\s+/g, ' ').slice(0, CITE_CLAIM_MAX)
    if (!url || !claim) return 'refused: url and a one-line claim are both required.'
    const title = args.title?.trim() || undefined
    const agentLabel = this.row(sessionId)?.title ?? 'research'
    const seen = this.researchSeenOf(root.id)
    const key = `u:${sessionId}:${url}`
    const row = seen.get(key)
    const merged = row !== undefined && !row.claimed
    const callId = merged ? row.callId : `cite:${nanoid(8)}`
    if (merged) row.claimed = true
    else if (!row) seen.set(key, { callId, claimed: true })
    this.append(root.id, {
      type: 'research-source',
      callId,
      url,
      agentId: sessionId,
      agentLabel,
      claim,
      ...(title ? { title } : {})
    })
    return `cited ${url}${merged ? ' (on its fetched row)' : ''}`
  }

  /** A boarded fetch's (or single-url shell read's) result upgrades its
   *  row in place (same callId, now with a title) when one is recoverable
   *  from the output — the whole output: raw HTML puts <title> past any
   *  short head. */
  private harvestResearchTitle(
    sessionId: string,
    event: Extract<AgentEvent, { type: 'tool-result' }>
  ): void {
    const callId = `${sessionId}:${event.callId}`
    const pending = this.researchFetches.get(callId)
    if (!pending) return
    this.researchFetches.delete(callId)
    if (event.isError) return
    const out = event.output
    const m =
      out.match(/<title[^>]*>\s*([^<]{1,200}?)\s*<\/title>/i) ??
      out.match(/^#\s+(.{1,200})$/m) ??
      out.match(/^Title:\s*(.{1,200})$/im)
    const title = m?.[1]?.replace(/\s+/g, ' ').trim()
    if (!title) return
    this.append(pending.rootId, {
      type: 'research-source',
      callId,
      url: pending.url,
      agentId: pending.agentId,
      agentLabel: pending.agentLabel,
      title
    })
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    let set = this.subscribers.get(sessionId)
    if (!set) {
      set = new Set()
      this.subscribers.set(sessionId, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }

  /** Every persisted row, any session: one listener for the whole registry. */
  onEvent(listener: SessionListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onMeta(listener: MetaListener): () => void {
    this.metaListeners.add(listener)
    return () => this.metaListeners.delete(listener)
  }

  onRemoved(listener: RemovedListener): () => void {
    this.removedListeners.add(listener)
    return () => this.removedListeners.delete(listener)
  }

  // ── app lines to the harness (notes reminders, the post-compaction block) ──

  /** A line from the app to the harness outside any user message: into
   *  the live turn now when one runs (both drivers take mid-turn input),
   *  else held ahead of the next message the harness gets. */
  whisper(sessionId: string, text: string): void {
    const status = this.store.getSession(sessionId)?.status
    const handle = this.handles.get(sessionId)
    if (handle && (status === 'running' || status === 'starting')) {
      this.lastActivity.set(sessionId, Date.now())
      handle.send(text).catch(() => this.holdNotice(sessionId, text))
      return
    }
    this.holdNotice(sessionId, text)
  }

  // ── the master thread (CLAUDE.md "Master threads") ────────────────────

  /** Has the thread finished a turn (batch.ts: an idle child is done only then)? */
  hasCompletedTurn(sessionId: string): boolean {
    return this.store.hasCompletedTurn(sessionId)
  }

  /** Is the thread a master (the pin on its row)? */
  isMaster(sessionId: string): boolean {
    const meta = this.store.getSession(sessionId)
    return !!meta && isMasterSession(meta, null)
  }

  /** A master with an open batch (children not all done, or the engine
   *  still at work) takes `watching` in place of `idle`. */
  private masterKeepsWatching(sessionId: string): boolean {
    return this.isMaster(sessionId) && (batches()?.open(sessionId) ?? false)
  }

  /** The batch closed with nothing coming (batch.ts review): a master left
   *  watching, with no report on its way, idles. */
  masterIdle(sessionId: string): void {
    if (this.store.getSession(sessionId)?.status !== 'watching') return
    if ((this.pendingReports.get(sessionId)?.length ?? 0) > 0 || this.draining.has(sessionId)) return
    this.append(sessionId, { type: 'status', status: 'idle' })
  }

  /** A person's message into a live turn (running or starting, not
   *  paused): the user row, the text whispered as a steer, the waiters told
   *  (a wait_for_agent in flight returns on it). False when the thread is
   *  not mid-turn, so the caller queues as usual. A handle whose harness is
   *  gone is dropped and a fresh one takes the text as a plain message (the
   *  user row is already there); a provider that cannot take mid-turn input
   *  front-queues it, so it sends next. */
  private steerLive(sessionId: string, text: string): boolean {
    const status = this.store.getSession(sessionId)?.status
    if (status !== 'running' && status !== 'starting') return false
    const handle = this.handles.get(sessionId)
    if (!handle || this.isTreePaused(sessionId)) return false
    this.append(sessionId, { type: 'user-text', text })
    const wrapped = `<user-steer>\n${text}\n</user-steer>`
    const again: QueuedSendOpts = { echoed: { first: false } }
    const deliver = async (): Promise<void> => {
      if (handle.alive?.() === false) throw new Error('harness gone')
      this.lastActivity.set(sessionId, Date.now())
      await handle.send(wrapped)
    }
    void deliver()
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('harness gone')) {
          // The process behind the turn is gone: a fresh harness takes the
          // message as a turn of its own (resume keeps the conversation).
          await this.dropHandle(sessionId)
          await this.send(sessionId, text, again)
        } else if (message.includes('still running')) {
          this.queueAdd(sessionId, text, again, true)
        } else {
          this.holdNotice(sessionId, wrapped)
        }
      })
      .catch(() => {})
    this.resolveSteerWaiters(sessionId, text)
    return true
  }

  /** The first-output watchdog settled the turn with nothing back: the
   *  message it carried goes to the front of the queue once, so the idle
   *  that follows sends it into a fresh harness; a second silence on the
   *  same message leaves the row errored (harness_crashed) instead. */
  private recoverSilence(sessionId: string): void {
    const last = this.store.lastUserRow(sessionId)
    if (!last || last.event.type !== 'user-text') return
    if (this.silenced.get(sessionId) === last.seq) {
      this.silenced.delete(sessionId)
      this.silenceFailed.add(sessionId)
      return
    }
    this.silenced.set(sessionId, last.seq)
    this.queueAdd(sessionId, last.event.text, { attachments: last.event.attachments, echoed: { first: last.first } }, true)
  }

  /** The gateway's word on a request of this thread: `since` when one went
   *  out, null when it ended (answered, failed, cut). An open request past
   *  PROVIDER_WAIT_MS reads "Waiting for the provider · 25 s" on the row
   *  while nothing finer is known (decorate); a ticker re-pushes such rows
   *  every 5 s so the seconds move. */
  providerRequest(sessionId: string, id: number, since: number | null): void {
    let open = this.providerOpen.get(sessionId)
    if (since !== null) {
      if (!open) this.providerOpen.set(sessionId, (open = new Map()))
      open.set(id, since)
    } else if (open) {
      open.delete(id)
      if (open.size === 0) this.providerOpen.delete(sessionId)
    }
    const meta = this.row(sessionId)
    if (meta) this.notifyMeta(meta)
    if (this.providerOpen.size > 0 && !this.providerTicker) {
      this.providerTicker = setInterval(() => {
        const now = Date.now()
        for (const [id, requests] of this.providerOpen) {
          if (![...requests.values()].some((t) => now - t >= PROVIDER_WAIT_MS)) continue
          const row = this.row(id)
          if (row) this.notifyMeta(row)
        }
        if (this.providerOpen.size === 0 && this.providerTicker) {
          clearInterval(this.providerTicker)
          this.providerTicker = null
        }
      }, PROVIDER_TICK_MS)
      this.providerTicker.unref?.()
    }
  }

  /** The provider-wait line for a running row: the oldest open request past the threshold, else null. */
  private providerWaitLine(sessionId: string, now = Date.now()): string | null {
    const open = this.providerOpen.get(sessionId)
    if (!open?.size) return null
    const oldest = Math.min(...open.values())
    const waited = now - oldest
    return waited >= PROVIDER_WAIT_MS ? `Waiting for the provider · ${Math.round(waited / 1000)} s` : null
  }

  /** The person spoke into the thread's turn: every wait_for_agent in
   *  flight there returns with the message (nextSteer). */
  private resolveSteerWaiters(sessionId: string, text: string): void {
    const waiters = this.steerWaiters.get(sessionId)
    if (!waiters) return
    this.steerWaiters.delete(sessionId)
    for (const w of waiters) w(text)
  }

  /** A wait_for_agent of `parentId` holds (on) or releases (off) these
   *  agent ids: the meta's `awaiting`, so a queued message can say it waits
   *  for the wait (orchestration.ts holdAwaited). */
  setAwaiting(parentId: string, ids: string[], on: boolean): void {
    let set = this.awaiting.get(parentId)
    if (on) {
      if (!set) this.awaiting.set(parentId, (set = new Map()))
      for (const id of ids) set.set(id, (set.get(id) ?? 0) + 1)
    } else if (set) {
      for (const id of ids) {
        const n = (set.get(id) ?? 1) - 1
        if (n <= 0) set.delete(id)
        else set.set(id, n)
      }
      if (set.size === 0) this.awaiting.delete(parentId)
    }
    const meta = this.row(parentId)
    if (meta) this.notifyMeta(meta)
  }

  /** The next steer into a thread's turn (orchestration.ts: a wait_for_agent
   *  there returns on it). `cancel` drops the waiter. */
  nextSteer(sessionId: string): { promise: Promise<string>; cancel: () => void } {
    let resolve!: (text: string) => void
    const promise = new Promise<string>((r) => (resolve = r))
    const set = this.steerWaiters.get(sessionId) ?? new Set()
    set.add(resolve)
    this.steerWaiters.set(sessionId, set)
    return {
      promise,
      cancel: () => {
        set.delete(resolve)
        if (set.size === 0 && this.steerWaiters.get(sessionId) === set) this.steerWaiters.delete(sessionId)
      }
    }
  }

  private holdNotice(sessionId: string, text: string): void {
    const list = this.notices.get(sessionId) ?? []
    if (!list.includes(text)) list.push(text)
    this.notices.set(sessionId, list)
  }

  /** The held lines, once; '' when none. */
  private takeNotices(sessionId: string): string {
    const list = this.notices.get(sessionId)
    if (!list?.length) return ''
    this.notices.delete(sessionId)
    return list.join('\n\n')
  }

  /** Test seam: what waits for the next message. */
  heldNotices(sessionId: string): string[] {
    return [...(this.notices.get(sessionId) ?? [])]
  }

  /** The context meter moved: once per window, near the compaction point,
   *  the thread is told to write its notes while the window still holds
   *  what they should say. Below half the window counts as a fresh window. */
  private checkNotesReminder(sessionId: string, tokens: number, window: number | null): void {
    if (!window || window <= 0) return
    if (tokens < window * NOTES_REMINDER_RESET_FRACTION) {
      this.notesReminded.delete(sessionId)
      return
    }
    if (tokens < window * NOTES_REMINDER_FRACTION || this.notesReminded.has(sessionId)) return
    this.notesReminded.add(sessionId)
    this.whisper(sessionId, NOTES_REMINDER_CONTEXT)
  }

  /** The reminder turn after a commit without a notes update: the app's
   *  own short turn, marked on the transcript like a completed-turn pass. */
  private async runNotesReminder(sessionId: string): Promise<void> {
    if (this.isTreePaused(sessionId)) return
    try {
      const handle = await this.handleFor(sessionId)
      this.append(sessionId, { type: 'turn-pass', actions: ['Notes'] })
      this.lastActivity.set(sessionId, Date.now())
      await handle.send(NOTES_REMINDER_COMMIT)
    } catch {
      this.drainSettled(sessionId)
    }
  }

  // ── message queue (queueing + steering) ────────────────────────────

  onQueue(listener: QueueListener): () => void {
    this.queueListeners.add(listener)
    return () => this.queueListeners.delete(listener)
  }

  queueList(sessionId: string): QueuedMessage[] {
    return this.queues.get(sessionId) ?? []
  }

  private notifyQueue(sessionId: string): void {
    const items = this.queueList(sessionId)
    for (const l of this.queueListeners) l(sessionId, items)
  }

  /** A message composed mid-turn. With `opts.steer` (the composer's Steer),
   *  and for a master always (CLAUDE.md "Master threads"), it goes straight
   *  into the live turn: the transcript keeps the user row, the harness
   *  reads it now, and a wait_for_agent in flight returns on it (nextSteer).
   *  Attachments and a front-queued retry always queue. The answer says
   *  which happened, so a caller never looks for its text in the list. */
  queueAdd(sessionId: string, text: string, opts?: QueuedSendOpts, front = false): QueueAddResult {
    this.assertNotMoving(sessionId)
    const { steer, ...rest } = opts ?? {}
    const item: QueuedMessage = { id: nanoid(10), text, ts: Date.now(), ...rest }
    if (!front && !rest.attachments?.length && (steer || this.isMaster(sessionId)) && this.steerLive(sessionId, text)) {
      return { kind: 'steered', id: item.id }
    }
    const q = this.queues.get(sessionId) ?? []
    if (front) q.unshift(item)
    else q.push(item)
    this.queues.set(sessionId, q)
    this.notifyQueue(sessionId)
    // The turn may have settled while the user was typing; a watching
    // thread's harness is idle behind its background work and takes a turn.
    const status = this.store.getSession(sessionId)?.status
    if ((status === 'idle' || status === 'watching') && !this.isTreePaused(sessionId)) {
      this.drainQueue(sessionId)
    }
    return { kind: 'queued', item }
  }

  queueRemove(sessionId: string, messageId: string): void {
    const q = this.queues.get(sessionId)
    if (!q) return
    this.queues.set(
      sessionId,
      q.filter((m) => m.id !== messageId)
    )
    this.notifyQueue(sessionId)
  }

  queueUpdate(
    sessionId: string,
    messageId: string,
    patch: {
      text?: string
      provider?: string | null
      model?: string | null
      reasoning?: string | null
    }
  ): void {
    const q = this.queues.get(sessionId)
    if (!q) return
    const field = <T extends string>(value: T | null | undefined, current: T | undefined) =>
      value === undefined ? current : value === null ? undefined : value
    const apply = (m: QueuedMessage): QueuedMessage => ({
      ...m,
      text: patch.text ?? m.text,
      provider: field(patch.provider as ProviderId | null | undefined, m.provider),
      model: field(patch.model, m.model),
      reasoning: field(patch.reasoning as SessionMeta['reasoning'] | null, m.reasoning)
    })
    this.queues.set(
      sessionId,
      q.map((m) => (m.id === messageId ? apply(m) : m))
    )
    this.notifyQueue(sessionId)
  }

  queueReorder(sessionId: string, order: string[]): void {
    const q = this.queues.get(sessionId)
    if (!q) return
    const byId = new Map(q.map((m) => [m.id, m]))
    const next = order.flatMap((id) => byId.get(id) ?? [])
    for (const m of q) if (!order.includes(m.id)) next.push(m)
    this.queues.set(sessionId, next)
    this.notifyQueue(sessionId)
  }

  /** Send a queued message NOW. Claude injects into the live turn; a
   *  provider that can't steer throws mid-turn, and the message falls
   *  back to the FRONT of the queue (sends next). */
  async queueSteer(sessionId: string, messageId: string): Promise<void> {
    if (this.isTreePaused(sessionId)) return
    const q = this.queues.get(sessionId) ?? []
    const item = q.find((m) => m.id === messageId)
    if (!item) return
    this.queues.set(
      sessionId,
      q.filter((m) => m.id !== messageId)
    )
    this.notifyQueue(sessionId)
    try {
      await this.send(sessionId, item.text, item)
    } catch {
      this.queueAdd(sessionId, item.text, item, true)
    }
  }

  // ── completed-turn pass (workspace setting) ────────────────────────

  /** At turn-complete: arm the pass when the session's workspace asks for
   *  one. Root implementation/orchestration threads only, and never off
   *  the pass's own turn. */
  private armTurnPass(sessionId: string): void {
    if (this.passActive.has(sessionId)) return
    const meta = this.store.getSession(sessionId)
    if (!meta || meta.parentId || this.isTreePaused(sessionId)) return
    if (meta.threadType !== 'implementation' && meta.threadType !== 'orchestration') return
    const workspaceId = meta.projectId
      ? this.store.getProject(meta.projectId)?.workspaceId
      : meta.workspaceId
    if (!workspaceId) return
    const pass =
      (meta.projectId && this.getProjectTurnPass(meta.projectId)) || this.getTurnPass(workspaceId)
    if (passEnabled(pass)) this.passPending.set(sessionId, pass)
  }

  /** Inject the pass as its own turn: a `turn-pass` marker event (the
   *  transcript's highlight boundary), then the instruction straight to
   *  the harness — no user-text bubble, this is the app talking. */
  private async runTurnPass(sessionId: string, pass: TurnPass): Promise<void> {
    if (this.isTreePaused(sessionId)) return
    try {
      const handle = await this.handleFor(sessionId)
      this.append(sessionId, { type: 'turn-pass', actions: passActions(pass) })
      this.lastActivity.set(sessionId, Date.now())
      const meta = this.store.getSession(sessionId)
      const project = meta?.projectId ? this.store.getProject(meta.projectId) : null
      const steps: string[] = []
      // A skill's own git flow (side worktrees, feature branches) must not
      // strand the turn's work: the pass checks the repo's real state and
      // opens with fold-back steps when it diverged — detected, not
      // trusted to the model's memory.
      if (project && (await isGitRepo(project.cwd))) {
        const known = [
          ...this.store.listProjects().map((p) => p.cwd),
          ...this.store.listWorkspaces().map((w) => w.path)
        ]
        const strays = await strayWorktrees(project.cwd, known)
        if (strays.length) {
          const list = strays
            .map((s) => `${s.dir}${s.branch ? ` (branch ${s.branch})` : ''}`)
            .join(', ')
          steps.push(
            `This repo has git worktree(s) the app does not manage: ${list}. If this work created one, land its changes in the project checkout at ${project.cwd} FIRST, then remove it (git worktree remove) and delete its temporary branch. Leave any you did not create alone.`
          )
        }
        const now = await currentBranch(project.cwd)
        if (project.branch && now && now !== project.branch) {
          steps.push(
            `The project checkout ${project.cwd} is on branch ${now}, not the project branch ${project.branch}. Carry the work onto ${project.branch} and check it out before anything else.`
          )
        }
      }
      if (pass.verify) {
        steps.push(
          "Verify the work from the turn that just ended: run the project's checks (typecheck, tests, lint — whatever the project defines) and fix what fails."
        )
      }
      if (pass.build) {
        const build = project ? await this.effectiveBuild(project.id) : null
        steps.push(
          build
            ? `Create a build by running \`${build.command}\` in ${project!.cwd} and say where it landed; fix the build if it breaks.`
            : "Create a build with the project's build command and say where it landed; fix the build if it breaks."
        )
      }
      if (pass.commit !== 'off') {
        const where = project?.branch
          ? ` in ${project.cwd} to the project branch ${project.branch}`
          : ' to the current branch'
        // A reviewed project lands through merge_branch (mergeReview.ts):
        // the push is the tool's, after the review.
        const reviewed = this.effectiveReview(meta?.projectId ?? null).settings.beforeMerge
        steps.push(
          `Commit every change from this work${where} with a clear message${
            pass.commit === 'push'
              ? reviewed
                ? ', then land it with the merge_branch app tool (this project reviews before merge; never git push or fast-forward the project branch yourself)'
                : ', then push that branch to origin'
              : ''
          }.`
        )
      }
      // A settle with an unfinished list is housekeeping, not a finish
      // line — the pass must not read as "the work is done".
      const tally = this.tasksOf(sessionId)
      const unfinished =
        tally && tally.done < tally.total
          ? `\nThe task list shows only ${tally.done}/${tally.total} tasks completed — this pass only tidies what exists. End by saying plainly that the work is UNFINISHED and what remains, so the user can resume it.`
          : ''
      void this.armBaseline(sessionId)
      const notices = this.takeNotices(sessionId)
      await handle.send(
        `${notices ? `${notices}\n\n` : ''}<turn-pass>\nThe turn settled. The completed-turn setting now asks you to:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nThese are the project's own completion settings — they OVERRIDE any branch, worktree, PR, or completion convention a skill or other instruction gave earlier in this thread. If the turn changed nothing to verify, build, or commit, say so in one short line and stop. Never start new feature work in this pass.${unfinished}\n</turn-pass>`
      )
    } catch {
      // Harness refused (gone, mid-restart) — settle back to normal flow.
      this.passActive.delete(sessionId)
      this.drainSettled(sessionId)
    }
  }

  // ── subagent settle reports (dormant supervision) ──────────────────

  /** Hand a subagent's settle report to the parent harness directly — the
   *  model must see it, the chat must not: no user-text event, no queue
   *  entry, no pass stamping. Idle parents get it now, busy ones at their
   *  next settle, ahead of queued user messages (a queued message opens a
   *  fresh round; the report belongs to the round that spawned the agent). */
  deliverAgentReport(sessionId: string, report: AgentReport): void {
    const list = this.pendingReports.get(sessionId) ?? []
    list.push(report)
    this.pendingReports.set(sessionId, list)
    const status = this.store.getSession(sessionId)?.status
    if ((status === 'idle' || status === 'watching') && !this.isTreePaused(sessionId)) {
      this.drainSettled(sessionId)
    }
  }

  /** A settled thread takes what waits for it as ONE turn: the person's
   *  next message when one is queued, carrying the held notices and every
   *  parked report ahead of it (drainQueue), else the reports alone. The
   *  app's own lines never spend a turn of their own while the person's
   *  text waits, and a report never wakes the thread without it. */
  private drainSettled(sessionId: string): void {
    if ((this.queues.get(sessionId)?.length ?? 0) > 0) this.drainQueue(sessionId)
    else this.drainReports(sessionId)
  }

  /** The parked reports, off the list and onto the transcript as their
   *  rows; their texts joined, '' when none. The caller sends them. */
  private takeReports(sessionId: string): { items: AgentReport[]; text: string } {
    const list = this.pendingReports.get(sessionId)
    if (!list?.length) return { items: [], text: '' }
    const items = list.splice(0)
    this.pendingReports.delete(sessionId)
    for (const item of items) {
      this.append(sessionId, {
        type: 'agent-report',
        agentId: item.agentId,
        title: item.title,
        status: item.status
      })
    }
    return { items, text: items.map((item) => item.text).join('\n\n') }
  }

  /** Reports the harness refused (gone, mid-restart) go back to the front of the list for the next settle. */
  private parkReports(sessionId: string, items: AgentReport[]): void {
    if (!items.length) return
    const q = this.pendingReports.get(sessionId) ?? []
    q.unshift(...items)
    this.pendingReports.set(sessionId, q)
  }

  /** On settle with nothing of the person's waiting: send every parked
   *  report to the harness in ONE turn (one agent-report row each), the
   *  held notices ahead of them — several children settling behind a busy
   *  parent used to cost a wake turn apiece. Returns whether reports took
   *  this settle. */
  private drainReports(sessionId: string): boolean {
    if (this.isTreePaused(sessionId)) return false
    if (this.draining.has(sessionId)) return false
    if (!this.pendingReports.get(sessionId)?.length) return false
    this.draining.add(sessionId)
    let taken: AgentReport[] = []
    void (async () => {
      const handle = await this.handleFor(sessionId)
      const { items, text } = this.takeReports(sessionId)
      taken = items
      this.lastActivity.set(sessionId, Date.now())
      void this.armBaseline(sessionId)
      const notices = this.takeNotices(sessionId)
      await handle.send(`${notices ? `${notices}\n\n` : ''}${text}`)
    })()
      .catch(() => this.parkReports(sessionId, taken))
      .finally(() => this.draining.delete(sessionId))
    return true
  }

  /** On a settle: send the next queued message, one per settle, with the
   *  reports parked meanwhile riding ahead of it in the same send (their
   *  rows land first, the user row last; send() puts the held notices
   *  ahead of everything), so the person's text is never behind a wake
   *  turn of the app's own. */
  private drainQueue(sessionId: string): void {
    if (this.isTreePaused(sessionId)) return
    if (this.draining.has(sessionId)) return
    const q = this.queues.get(sessionId)
    if (!q?.length) return
    const item = q.shift()!
    this.notifyQueue(sessionId)
    this.draining.add(sessionId)
    const reports = this.takeReports(sessionId)
    if (reports.text) this.holdNotice(sessionId, reports.text)
    // A queued message released after the pass finished IS the next pass —
    // the same stamp the board's pass button sends. Without it, send()
    // stamps newPass:false and the message glues onto the finished round.
    const meta = this.store.getSession(sessionId)
    const tally = this.tasksOf(sessionId)
    const newPass =
      !!meta &&
      !meta.parentId &&
      (meta.threadType === 'implementation' || meta.threadType === 'orchestration') &&
      !!tally &&
      tally.done === tally.total
    void this.send(sessionId, item.text, newPass ? { ...item, newPass: true } : item)
      .catch(() => {
        q.unshift(item)
        this.notifyQueue(sessionId)
        this.parkReports(sessionId, reports.items)
      })
      .finally(() => this.draining.delete(sessionId))
  }

  /** A child's status moved: its non-root parent and its master read it in
   *  their `background` (notifyMeta already pushed the root). */
  private notifyWaiters(child: SessionMeta): void {
    const parent = child.parentId ? this.row(child.parentId) : null
    if (parent?.parentId) this.notifyMeta(parent)
    const master = !child.parentId && child.masterId ? this.row(child.masterId) : null
    if (master) this.notifyMeta(master)
  }

  /** What a thread waits on in the background: its own tasks, its live
   *  subagents, a pinned master's local batch, the watching stretch. Null
   *  when there is nothing and the thread is not watching. */
  private backgroundOf(session: SessionMeta, index: SessionIndex): BackgroundWork | null {
    const tasks = this.watching.get(session.id) ?? []
    const agents = (index.byParent.get(session.id) ?? [])
      .filter((c) => !c.archived && LIVE_STATUSES.has(c.status))
      .map((c) => c.id)
    let batch: BackgroundWork['batch'] = null
    if (session.isMaster && !session.parentId) {
      const kids = (index.byMaster.get(session.id) ?? []).filter((c) => !c.archived)
      if (kids.length) {
        const out = kids.filter((c) => LIVE_STATUSES.has(c.status) || c.status === 'queued' || c.status === 'paused')
        batch = { out: out.length, total: kids.length }
      }
    }
    const watching = session.status === 'watching'
    if (!watching && !tasks.length && !agents.length && !batch) return null
    return { tasks, agents, batch, watchingSince: watching ? (this.watchingSince.get(session.id) ?? null) : null }
  }

  /** Everything the tab strip needs that isn't in the stored row: what the
   *  thread is doing, and how far through its task list it is. */
  private decorate(session: SessionMeta, index: SessionIndex = this.indexOf()): SessionMeta {
    const act = this.activities.get(session.id)
    let root = session
    for (let hops = 0; root.parentId && hops < 20; hops++) {
      const parent = index.byId.get(root.parentId)
      if (!parent) break
      root = parent
    }
    const tree = summarizeRootTree(root, index.byParent, (id) => {
      const meta = index.byId.get(id)
      return !!meta && this.canContinueError(meta)
    })
    const background = this.backgroundOf(session, index)
    const awaiting = this.awaiting.get(session.id)
    return {
      ...session,
      ...(awaiting?.size ? { awaiting: [...awaiting.keys()] } : {}),
      background,
      activity:
        session.status === 'watching'
          ? watchLine(background)
          : session.status === 'queued'
            ? (this.queuedLines.get(session.id) ?? 'Queued')
            : // A request out at the provider past the threshold, with nothing finer known: say so.
              (session.status === 'running' || session.status === 'starting') && (!act || act.text === 'Thinking')
              ? (this.providerWaitLine(session.id) ?? act?.text ?? null)
              : (act?.text ?? null),
      activityKind: act?.kind ?? null,
      tasks: this.tasksOf(session.id),
      goal: this.goalOf(session.id),
      context: this.liveContexts.get(session.id) ?? null,
      canContinue: this.canContinueError(session),
      failure: this.folds.get(session.id)?.failure ?? null,
      treeCanContinue: tree.canContinueError,
      treeHasLiveWork: tree.hasLiveWork,
      treeHasPaused: tree.hasPaused,
      treeFrozenActiveElapsed: tree.frozenActiveElapsed
    }
  }

  /** Set during an account refresh pass: metas wait here and go out once
   *  the pass is written (latest per session). */
  private deferredMeta: Map<string, SessionMeta> | null = null

  /** `producer` names the code that pushed, for the stall log's `pushes=`
   *  breakdown: `status` by default, `accounts` for a pass over the picks. */
  private notifyMeta(session: SessionMeta, producer = 'status'): void {
    if (this.deferredMeta) {
      this.deferredMeta.set(session.id, session)
      return
    }
    const index = this.indexOf()
    const decorated = this.decorate(session, index)
    for (const l of this.metaListeners) l(decorated, producer)
    if (session.parentId) {
      const root = index.byId.get(this.rootSessionOf(session.id))
      if (root) {
        const decoratedRoot = this.decorate(root, index)
        for (const l of this.metaListeners) l(decoratedRoot, producer)
      }
    }
  }

  async disposeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.scheduler.dispose()
    this.flushFolds()
    for (const id of [...this.pendingApprovals.keys()]) this.denyPendingApprovals(id)
    await Promise.allSettled([...this.handles.values()].map((h) => h.dispose()))
    this.handles.clear()
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
