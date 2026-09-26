import { nanoid } from 'nanoid'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { CreateSessionParams, type CreateSessionInput } from '@shared/contract'
import type { SessionBatchResult } from '@shared/contract'
import { CATALOG, resolveModel, type ProviderId } from '@shared/catalog'
import type { AgentEvent, Attachment, EventRow, SessionMeta, SessionStatus } from '@shared/events'
import {
  LIVE_STATUSES,
  foldContinuableError,
  foldGoal,
  indexByParent,
  summarizeRootTree,
  type GoalState,
  type ParentIndex
} from '@shared/session-lifecycle'
import { isRoutedProvider, type AccountPins, type AccountProvider, type AccountRoute } from '@shared/accounts'
import { resolvePin, type ResolvedPin } from './accountRouting'
import type { LimitWindow } from '@shared/events'
import { foldEvent, newFoldState, toFoldRow } from './folds'
import { FOLD_VERSION, type FoldRow } from './db'
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
import type { CheckpointStore } from './checkpoint'
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
import { stopProjectLsp } from './lsp'
import { parseRules, type OrchestrationRules } from '@shared/rules'
import { DEFAULT_THREAD_DEFAULTS, parseDefaults, type ThreadDefaults } from '@shared/defaults'
import { parseTurnPass, passActions, passEnabled, type TurnPass } from '@shared/turnpass'
import { parseBuildConfig, type BuildConfig, type EffectiveBuild } from '@shared/build'
import { detectBuild } from './build'
import {
  AppshotSettingsSchema,
  DEFAULT_APPSHOT_SETTINGS,
  type AppshotSettings
} from '@shared/appshots'
import { planPathFor, planSeed, projectContext, reportPathFor, threadPreamble } from './threads'
import { notifyParentOfSettle } from './orchestration'
import { foldTodo, newTodoFold, tallyOf, type TaskTally, type TodoFold } from './todos'
import { liveDiffOnStatus } from './livediff'
import {
  appendJournal,
  INLINE_DIGEST_MAX_CHARS,
  removeMirror,
  scheduleMirror,
  seedJournal,
  threadDigest,
  writeThreadDigest
} from './mirror'

const THREAD_TITLES = {
  chat: 'New chat',
  planning: 'New plan',
  implementation: 'New task',
  orchestration: 'New orchestration',
  research: 'New research'
} as const

type SessionListener = (row: EventRow) => void
type MetaListener = (session: SessionMeta) => void
/** Lookups decorate() needs — built once per list(), never per session. */
type SessionIndex = { byId: Map<string, SessionMeta>; byParent: ParentIndex }

/** Cap for the transcript handoff sent to a new harness on provider switch. */
const HANDOFF_MAX_CHARS = 24_000

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
type QueueListener = (sessionId: string, items: QueuedMessage[]) => void

/** Options a queued message carries to its eventual send. */
interface QueuedSendOpts {
  provider?: ProviderId
  model?: string
  reasoning?: SessionMeta['reasoning']
  attachments?: Attachment[]
  newPass?: boolean
}

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

/** What an event says the thread is doing, for the tab strip — text plus
 *  the kind that tints the spinner (investigate/edit/think).
 *  value = new activity, null = turn settled (clear), undefined = no
 *  opinion (deltas, results, and other chatter never churn the tabs). */
type Activity = { text: string; kind: NonNullable<SessionMeta['activityKind']> }

function activityOf(event: AgentEvent): Activity | null | undefined {
  if (event.type === 'status') {
    return event.status === 'running' ? { text: 'Thinking', kind: 'think' } : null
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
  /** The account a thread's child should spend from at spawn, and the account its row should show. */
  routeFor(meta: SessionMeta, pin: ResolvedPin | null): { route: AccountRoute | null; current: string | null }
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
  private removedListeners = new Set<RemovedListener>()
  /** Per-session message queue: composed mid-turn, drained on idle. */
  private queues = new Map<string, QueuedMessage[]>()
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
  /** Per-session derived folds (task tally, goal, trailing error) — the
   *  persisted session_folds rows, loaded once at construction and kept
   *  current by append(). list() reads these and never the event log. */
  private folds = new Map<string, FoldRow>()
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
  /** research boards: WebFetch calls awaiting a title from their result
   *  (key = the boarded event's callId), and per-root dedupe of already
   *  boarded queries/urls so repeats never bloat the root's log */
  private researchFetches = new Map<
    string,
    { rootId: string; url: string; agentId: string; agentLabel: string }
  >()
  private researchSeen = new Map<string, Set<string>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  /** Undo checkpoints; armed before every harness send so the baseline
   *  is snapshotted before the provider can write. Set by the server. */
  checkpoints: CheckpointStore | null = null
  /** Chooses each thread's Aliax account and moves a thread when its error
   *  names a usage limit. Set by the server; null sends unscoped and leaves
   *  such errors to the Continue button. */
  limits: AccountRouter | null = null
  /** Sessions whose turn a usage limit cut off, until they continue: the
   *  pending switch continues the root tree once the session settles. */
  private limited = new Map<string, { switching: Promise<Switched | null> }>()
  /** The pin each live handle was spawned under, so a pin change respawns on the next send. */
  private spawnedPin = new Map<string, string | null>()
  /** Per root: the switch to continue on, and the short timer that lets
   *  every member of the tree settle so the tree continues once. */
  private limitContinues = new Map<string, { switched: Switched; timer: ReturnType<typeof setTimeout> }>()

  constructor(private store: Store) {
    for (const fold of store.listFolds()) this.folds.set(fold.sessionId, fold)
    for (const s of store.listSessions()) if (s.context) this.liveContexts.set(s.id, s.context)
  }

  // ── folds ───────────────────────────────────────────────────────────

  foldOf(sessionId: string): FoldRow | undefined {
    return this.folds.get(sessionId)
  }

  isFoldWarm(sessionId: string): boolean {
    return this.todoFolds.has(sessionId)
  }

  private putFold(fold: FoldRow): void {
    this.store.putFold(fold)
    this.folds.set(fold.sessionId, fold)
  }

  /** Land swept rows and push each session's meta so its sidebar row
   *  fills in live — one shared index for the whole batch. */
  commitFolds(rows: FoldRow[]): void {
    for (const fold of rows) this.putFold(fold)
    const index = this.indexOf()
    for (const fold of rows) {
      const meta = index.byId.get(fold.sessionId)
      if (!meta) continue
      const decorated = this.decorate(meta, index)
      for (const l of this.metaListeners) l(decorated)
    }
  }

  /** The in-memory task fold, seeded from the stored log the first time a
   *  session is appended to in this process (one walk, all three folds
   *  together). A session with no current fold row gets one from the
   *  same walk, so a send into a never-swept thread heals it at once. */
  private warmTodoFold(sessionId: string): TodoFold {
    const warm = this.todoFolds.get(sessionId)
    if (warm) return warm
    const state = newFoldState()
    for (const row of this.store.eventsAfter(sessionId, 0)) foldEvent(state, row)
    this.todoFolds.set(sessionId, state.todo)
    const fold = this.folds.get(sessionId)
    if (!fold || fold.foldedSeq < state.seq || fold.foldVersion !== FOLD_VERSION) {
      this.putFold(toFoldRow(sessionId, state))
    }
    return state.todo
  }

  /** A status event appended outside append() (boot reset, pause, resume):
   *  it changes no persisted fold output, so a current row just advances
   *  its watermark; a stale or missing row stays for the sweep. */
  private appendStatus(sessionId: string, status: SessionStatus): EventRow {
    const event: AgentEvent = { type: 'status', status }
    const row = this.store.appendEvent(sessionId, event)
    const warm = this.todoFolds.get(sessionId)
    if (warm) foldTodo(warm, event, row.ts)
    const fold = this.folds.get(sessionId)
    if (fold && fold.foldedSeq === row.seq - 1 && fold.foldVersion === FOLD_VERSION) {
      this.putFold({ ...fold, foldedSeq: row.seq })
    }
    return row
  }

  /** Snapshot the session's already-dirty files once per session and cwd.
   *  Never blocks a turn: a failure here only costs undo for that turn. */
  private async armCheckpoint(sessionId: string): Promise<void> {
    const cwd = this.store.getSession(sessionId)?.cwd?.trim()
    if (!this.checkpoints || !cwd || cwd === '~') return
    await this.checkpoints.ensure(sessionId, cwd).catch(() => {})
  }

  /**
   * Idle disposal — what keeps dozens of sessions cheap. A handle whose
   * session has sat idle past the threshold is dropped; the session stays
   * listed and the next send lazily restarts the harness via resume.
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
        }
      }
    }, 60_000)
  }

  /** At boot no harness handles exist, so a session persisted as running,
   *  waiting, or starting is stale from a previous process — reset it, or
   *  the sidebar and working strip show work that isn't happening (and
   *  can't be stopped). The dead process also never wrote its closing
   *  status event, so refolds would see a forever-open turn: append the
   *  synthetic idle directly (none of append()'s live-session side effects
   *  — queue drain, parent supervision — belong at boot). */
  resetStaleStatuses(): void {
    for (const s of this.store.listSessions()) {
      if (s.status === 'running' || s.status === 'waiting' || s.status === 'starting') {
        this.appendStatus(s.id, 'idle')
        this.store.updateSession(s.id, { status: 'idle', busySince: null })
      }
    }
  }

  list(): SessionMeta[] {
    const sessions = this.store.listSessions()
    const index = this.indexOf(sessions)
    return sessions.map((s) => this.decorate(s, index))
  }

  /** One decorated session — the lookup-by-id every caller used to do
   *  with list().find(), which decorated all n sessions to read one. */
  get(sessionId: string): SessionMeta | null {
    const meta = this.store.getSession(sessionId)
    return meta ? this.decorate(meta) : null
  }

  /** A parent's direct children, decorated. */
  childrenOf(parentId: string): SessionMeta[] {
    const index = this.indexOf()
    return this.store.childrenOf(parentId).map((s) => this.decorate(s, index))
  }

  /** The two lookups decorate() needs, built once per list. */
  private indexOf(sessions: SessionMeta[] = this.store.listSessions()): SessionIndex {
    return { byId: new Map(sessions.map((s) => [s.id, s])), byParent: indexByParent(sessions) }
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

  /** Root thread of a subagent chain — the board that displays its work. */
  rootSessionOf(sessionId: string): string {
    let cur = this.store.getSession(sessionId)
    for (let hops = 0; cur?.parentId && hops < 20; hops++) {
      const parent = this.store.getSession(cur.parentId)
      if (!parent) break
      cur = parent
    }
    return cur?.id ?? sessionId
  }

  /** The thread's current task tally: the warm fold if append() has
   *  touched it this process, else the persisted row, else (not swept
   *  yet) none. Never reads the event log. */
  private tasksOf(sessionId: string): TaskTally | null {
    const warm = this.todoFolds.get(sessionId)
    return warm ? tallyOf(warm) : (this.folds.get(sessionId)?.tasks ?? null)
  }

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
    const status = meta.status
    if (status === 'starting' || status === 'running' || status === 'waiting') return false
    return this.storedContinuableError(meta.id)
  }

  /** The explicit pin that applies to a thread (its own, its project's, its workspace's). */
  pinOf(meta: SessionMeta): ResolvedPin | null {
    const project = meta.projectId ? this.store.getProject(meta.projectId) : null
    const workspaceId = project?.workspaceId ?? meta.workspaceId
    const workspace = workspaceId ? (this.store.listWorkspaces().find((w) => w.id === workspaceId) ?? null) : null
    return resolvePin(meta, project, workspace)
  }

  /** The gateway (or a text-path failover) moved a thread: its row follows. */
  setAccount(sessionId: string, account: string | null): void {
    const meta = this.store.getSession(sessionId)
    if (!meta || (meta.account ?? null) === account) return
    const next = this.store.setSessionAccount(sessionId, account)
    if (next) this.notifyMeta(next)
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

  async createWorkspace(path: string, name?: string): Promise<WorkspaceMeta> {
    const existing = this.store.listWorkspaces().find((w) => w.path === path)
    if (existing) return existing
    const meta: WorkspaceMeta = {
      id: nanoid(12),
      name: name ?? basename(path),
      path,
      git: await isGitRepo(path),
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
    opts: { branch?: string; baseRef?: string } = {}
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
    this.notifyCatalog('projects')
  }

  setProjectAccounts(projectId: string, pins: AccountPins): void {
    if (!this.store.getProject(projectId)) throw new Error(`unknown project: ${projectId}`)
    this.store.setProjectAccounts(projectId, pins)
    this.notifyCatalog('projects')
  }

  setWorkspaceAccounts(workspaceId: string, pins: AccountPins): void {
    if (!this.store.listWorkspaces().some((w) => w.id === workspaceId)) throw new Error(`unknown workspace: ${workspaceId}`)
    this.store.setWorkspaceAccounts(workspaceId, pins)
    this.notifyCatalog('workspaces')
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
   *  its worktree has it checked out. */
  private async cleanupProjectGit(projectId: string, cleanup: ProjectCleanup): Promise<void> {
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
    this.notifyCatalog('projects')
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

  eventsAfter(sessionId: string, afterSeq: number): EventRow[] {
    return this.store.eventsAfter(sessionId, afterSeq)
  }

  /** A window of the log, tail-first when asked (see `Store.events`). */
  events(sessionId: string, opts: { afterSeq?: number; beforeSeq?: number; tail?: number }): EventRow[] {
    return this.store.events(sessionId, opts)
  }

  // ── orchestration rules & thread defaults (global + workspace) ─────

  /** Structured orchestration rules for a scope; null = not set there
   *  (global falls back to defaults at the call site, a workspace to
   *  the global rules). */
  getOrchestrationRules(workspaceId: string | null): OrchestrationRules | null {
    const key = workspaceId ? `orchestration-rules:${workspaceId}` : 'orchestration-rules'
    return parseRules(this.store.getSetting(key))
  }

  /** null clears: global reverts to defaults, an override goes away.
   *  Applies to orchestrators started after the change (resume keeps
   *  running ones on the old prompt until they idle out). */
  setOrchestrationRules(workspaceId: string | null, rules: OrchestrationRules | null): void {
    const key = workspaceId ? `orchestration-rules:${workspaceId}` : 'orchestration-rules'
    this.store.setSetting(key, rules ? JSON.stringify(rules) : null)
  }

  /** Thread defaults for a scope; null = not set there. */
  getThreadDefaults(workspaceId: string | null): ThreadDefaults | null {
    const key = workspaceId ? `thread-defaults:${workspaceId}` : 'thread-defaults'
    return parseDefaults(this.store.getSetting(key))
  }

  setThreadDefaults(workspaceId: string | null, defaults: ThreadDefaults | null): void {
    const key = workspaceId ? `thread-defaults:${workspaceId}` : 'thread-defaults'
    this.store.setSetting(key, defaults ? JSON.stringify(defaults) : null)
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
          : params.threadType === 'research'
            ? reportPathFor(cwd, id)
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
      context1m: params.context1m ?? false,
      busySince: null,
      pausedAt: null,
      frozenActiveElapsed: null,
      threadRules: params.threadRules ?? null,
      nativeId: null,
      createdAt: now,
      updatedAt: now
    }
    this.store.insertSession(meta)
    // Born folded: an empty row at seq 0, and a warm task fold so the
    // first append never walks a log.
    this.putFold(toFoldRow(id, newFoldState()))
    this.todoFolds.set(id, newTodoFold())
    this.notifyMeta(meta)
    if (params.parentId) {
      this.append(params.parentId, { type: 'agent-spawned', childSessionId: meta.id })
    }
    // A build starting from a plan auto-archives its planning thread: the
    // conversation is over, the plan file carries the context. Archiving
    // touches nothing the models use — mirrors and the plan doc stay, and
    // any send into the thread revives it.
    if (
      meta.planPath &&
      (meta.threadType === 'implementation' || meta.threadType === 'orchestration')
    ) {
      const planThread = this.store
        .listSessions()
        .find((s) => s.threadType === 'planning' && s.planPath === meta.planPath && !s.archived)
      if (planThread) void this.setArchived(planThread.id, true)
    }
    // A requested goal waits for the kickoff message (send() applies it
    // just before the text), so goal and work arrive in order.
    if (params.goal?.trim()) this.pendingGoals.set(id, params.goal.trim())
    // Start the harness eagerly so status/errors surface immediately.
    void this.handleFor(meta.id).catch(() => {})
    return meta
  }

  async send(
    sessionId: string,
    text: string,
    opts?: {
      provider?: ProviderId
      model?: string
      reasoning?: SessionMeta['reasoning']
      attachments?: Attachment[]
      newPass?: boolean
    }
  ): Promise<void> {
    let meta = this.store.getSession(sessionId)
    if (!meta) throw new Error(`unknown session: ${sessionId}`)
    // A paused tree accepts no harness input. User work stays ordered in the
    // same queue and releases only after the resumed turn settles.
    if (this.isTreePaused(sessionId)) {
      this.queueAdd(sessionId, text, opts)
      return
    }
    // A real message starts a fresh turn — the error taint belongs to the
    // one that died. (The pass's own handle.send bypasses this method.)
    this.erroredTurns.delete(sessionId)
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
        return
      }
    }
    // A model id names its harness (resolveModel): a message asking this
    // thread for another provider's model switches the thread to that
    // provider rather than handing the harness a model it will reject.
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
      }
    } else {
      // Per-message model/reasoning: persist the change and drop the live
      // handle — the next handleFor() boots the harness fresh (resume keeps
      // the conversation) with the new settings.
      const model = routed.model ?? meta.model
      if (model !== meta.model || reasoning !== meta.reasoning) {
        await this.dropHandle(sessionId)
        const next = this.store.updateSession(sessionId, { model, reasoning })
        if (next) {
          meta = next
          this.notifyMeta(next)
        }
      }
    }
    // A pin change (thread, project or workspace) since the harness was
    // spawned: its URL names the old account, so boot fresh under the new one.
    if (this.handles.has(sessionId) && this.spawnedPin.get(sessionId) !== (this.pinOf(meta)?.name ?? null)) {
      await this.dropHandle(sessionId)
    }
    let handle: DriverHandle
    try {
      handle = await this.handleFor(sessionId)
    } catch {
      // The harness never started — a missing binary, a logged-out CLI.
      // handleFor has already put the reason on the transcript; hold the
      // message at the front of the queue instead of dropping it, so once
      // the cause is fixed the thread runs what the user actually asked for
      // rather than an empty continue.
      this.queueAdd(sessionId, text, opts, true)
      return
    }
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
    // The visible transcript carries only what the user typed; thread-type
    // preambles ride along on the first message, provider-agnostic.
    const first = !this.store.hasUserText(sessionId)
    const attachments = opts?.attachments?.length ? opts.attachments : undefined
    // Stamp the run settings that will execute this message — the board's
    // pass history reads them off the round's opening event — and whether
    // this send opens a NEW pass (the pass button) or continues the
    // current one (typed under the banner).
    this.append(sessionId, {
      type: 'user-text',
      text,
      attachments,
      model: meta.model,
      reasoning: meta.reasoning,
      context1m: meta.context1m,
      fast: meta.fast,
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
    let out = text
    // A retyped thread re-instructs on its next message: the new type's
    // preamble rides along once, prefaced so the model knows it replaces
    // the instructions the thread opened with.
    const retyped = !first && this.store.getRetyped(sessionId)
    if (retyped) this.store.setRetyped(sessionId, false)
    if (first || retyped) {
      const parts = [threadPreamble(meta)]
      // Planning and research threads WRITE their planPath file (plan /
      // report) — only executing types read it as a brief.
      if (meta.threadType !== 'planning' && meta.threadType !== 'research' && meta.planPath) {
        parts.push(planSeed(meta.planPath))
      }
      const preamble = parts.filter(Boolean).join('\n\n')
      if (preamble) {
        const note = retyped
          ? `The user CHANGED this thread's type mid-conversation. The instructions below REPLACE the ones this thread opened with — earlier turns may follow the old shape; from this message on, follow these.\n\n`
          : ''
        out = `<thread-instructions>\n${note}${preamble}\n</thread-instructions>\n\n${text}`
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
            this.store.sessionsOfProject(meta.projectId)
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
    // Thread references (M9): each referenced thread becomes a fresh local
    // digest file; the @thread:<id> token is rewritten to its path (every
    // harness follows @path). Projectless sessions get the digest inline.
    for (const ref of attachments?.filter((a) => a.kind === 'thread' && a.sessionId) ?? []) {
      const refMeta = this.store.getSession(ref.sessionId!)
      if (!refMeta) continue
      const refProject = refMeta.projectId ? this.store.getProject(refMeta.projectId) : null
      const token = `@thread:${refMeta.id}`
      const here = meta.projectId ? this.store.getProject(meta.projectId) : null
      if (here) {
        const rel = writeThreadDigest(this, refMeta, here.cwd)
        const mention = `@${rel} (thread "${refMeta.title}"${refProject ? ` from project "${refProject.name}"` : ''})`
        out = out.includes(token) ? out.replaceAll(token, mention) : `${out}\n\n${mention}`
      } else {
        let digest = threadDigest(this, refMeta)
        if (digest.length > INLINE_DIGEST_MAX_CHARS) {
          digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
        }
        const mention = `thread "${refMeta.title}" (referenced below)`
        if (out.includes(token)) out = out.replaceAll(token, mention)
        out = `${out}\n\n<thread-reference title=${JSON.stringify(refMeta.title)}>\n${digest}\n</thread-reference>`
      }
    }
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
      await this.armCheckpoint(sessionId)
      await handle.send(out, sendAttachments)
    } catch (err) {
      // A steer at a provider that can't take mid-turn input (cursor's
      // process-per-turn) front-queues instead of erroring the composer.
      if (err instanceof Error && err.message.includes('still running')) {
        this.queueAdd(sessionId, text, opts, true)
        return
      }
      // The handle's harness is gone (watchdog recovery, stream death) —
      // boot a fresh one and deliver there; resume keeps the conversation.
      if (err instanceof Error && err.message.includes('harness gone')) {
        await this.dropHandle(sessionId)
        const fresh = await this.handleFor(sessionId)
        await fresh.send(out, sendAttachments)
        return
      }
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
      (session) =>
        session.status === 'paused' ||
        session.status === 'starting' ||
        session.status === 'running' ||
        session.status === 'waiting'
    )
    await Promise.allSettled(tree.map((session) => this.interrupt(session.id)))
  }

  /** Pause a visible root and every live descendant. State lands before any
   *  provider interrupt, so late callbacks can only observe `paused`. */
  async pauseRun(sessionId: string): Promise<void> {
    const rootId = this.rootSessionOf(sessionId)
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
    const handle = await this.handleFor(sessionId)
    await this.armCheckpoint(sessionId)
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
    this.lastActivity.set(sessionId, now)
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

  /** Pin this thread to one Aliax account (null: inherit the project's,
   *  then the workspace's, else auto). Takes effect on the next send, which
   *  respawns the harness when the resolved pin differs from the one its
   *  process was started with. */
  setAccountPin(sessionId: string, account: string | null): void {
    const next = this.store.updateSession(sessionId, { accountPin: account?.trim() || null })
    if (!next) throw new Error(`unknown session: ${sessionId}`)
    this.notifyMeta(next)
  }

  /** Fast mode / context window: persist and drop the handle — the next
   *  send boots the harness fresh (resume keeps the conversation). */
  async tune(sessionId: string, patch: { fast?: boolean; context1m?: boolean }): Promise<void> {
    await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, patch)
    if (next) this.notifyMeta(next)
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
    if (status === 'running' || status === 'starting' || status === 'waiting') {
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
    const reportPath = reportPathFor(meta.cwd, sessionId)
    if (threadType === 'research') {
      patch.planPath = reportPath
    } else if (meta.planPath === reportPath) {
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
      await this.dropHandle(sessionId)
    }
    const next = this.store.updateSession(sessionId, { archived })
    if (next) this.notifyMeta(next)
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
    for (const id of ids) {
      await this.dropHandle(id)
      this.stopping.delete(id)
      this.pendingReboot.delete(id)
      this.pendingApprovals.delete(id)
      this.subscribers.delete(id)
      this.lastActivity.delete(id)
      this.activities.delete(id)
      this.todoFolds.delete(id)
      this.folds.delete(id)
      this.pendingGoals.delete(id)
      this.liveContexts.delete(id)
      const meta = all.find((s) => s.id === id)
      if (meta) removeMirror(this, meta) // mirrors die with the thread
    }
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
    if (next) this.notifyMeta(next)
  }

  /** The Continue button on an errored thread: the user fixed what killed
   *  the turn (switched accounts on a session limit), so settle the shown
   *  errors, reboot the harness (resume keeps the conversation), and tell
   *  it to pick the work back up. Errored subagents continue first, so an
   *  orchestrator wakes to a fleet that is already moving again. */
  async continueRun(sessionId: string, reason?: string): Promise<void> {
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
          reason
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

  private async continueErroredSession(
    sessionId: string,
    restartedDescendants: boolean,
    reason = 'a harness error (a session limit or similar) that the user has since fixed'
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
    try {
      const handle = await this.handleFor(sessionId)
      this.lastActivity.set(sessionId, Date.now())
      await this.armCheckpoint(sessionId)
      await handle.send(
        `<continue-run>\nThe previous turn was cut off by ${reason}. ${restartedDescendants ? 'Your failed subagents were restarted first and are picking their work back up. ' : ''}Continue exactly where you left off: check your task list and your last few actions, finish anything half-done, and keep going. If the work was already complete, say so in one short line.\n</continue-run>`
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

  private async dropHandle(sessionId: string): Promise<void> {
    const inflight = this.starting.get(sessionId)
    if (inflight) await inflight.catch(() => {})
    this.denyPendingApprovals(sessionId)
    const handle = this.handles.get(sessionId)
    this.handles.delete(sessionId)
    this.starting.delete(sessionId)
    if (handle) await handle.dispose().catch(() => {})
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

    const meta = this.store.getSession(sessionId)
    if (!meta) throw new Error(`unknown session: ${sessionId}`)
    const driver = BUILT_IN_DRIVERS[meta.provider]
    // The account this process spends from: the thread's pin (its own, its
    // project's, its workspace's) or the best account for its model. The
    // row shows the expected account at once; the gateway corrects it.
    const pin = this.pinOf(meta)
    const { route, current } = this.limits?.routeFor(meta, pin) ?? { route: null, current: null }
    this.spawnedPin.set(sessionId, pin?.name ?? null)
    this.setAccount(sessionId, current)

    const startP = this.ensureCwd(meta)
      .then(() =>
        driver.start({
          // Drivers seed goal state from here (resume dedup, watcher init).
          session: { ...meta, goal: this.goalOf(sessionId) },
          route,
          emit: (event) => this.append(sessionId, event),
          requestApproval: (req) => this.requestApproval(sessionId, req),
          setNativeId: (nativeId) => {
            const next = this.store.updateSession(sessionId, { nativeId })
            if (next) this.notifyMeta(next)
          }
        })
      )
      .then((handle) => {
        this.handles.set(sessionId, handle)
        this.starting.delete(sessionId)
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
    // A manual pause wins races with the old provider and with a replacement
    // handle that has not accepted its continuation yet. Pause never gains
    // an error chip or loses its state through a late status callback.
    const persisted = this.store.getSession(sessionId)
    if (persisted?.status === 'paused' && (event.type === 'status' || event.type === 'error')) {
      return
    }
    // Streaming previews (partial tool input) are broadcast-only: each one
    // carries the whole input so far, so persisting them would write the
    // same growing payload into the log over and over. The final tool-call
    // event has everything replay needs.
    if (event.type === 'tool-call' && event.partial) {
      const row: EventRow = { sessionId, seq: -1, ts: Date.now(), event, ephemeral: true }
      for (const listener of this.subscribers.get(sessionId) ?? []) listener(row)
      return
    }
    // Research boards: web tool calls anywhere in a research thread's agent
    // tree surface as research-source events on the ROOT session (partials
    // returned above, so every tool-call here is final).
    if (event.type === 'tool-call') this.harvestResearchCall(sessionId, event)
    else if (event.type === 'tool-result') this.harvestResearchTitle(sessionId, event)
    // Live context accounting is meta, not transcript: fold it onto the
    // session row and push, never into the log.
    if (event.type === 'context') {
      const prev = this.liveContexts.get(sessionId)
      const window = event.window ?? prev?.window ?? null
      if (prev?.tokens === event.tokens && prev?.window === window) return
      const context = { tokens: event.tokens, window }
      this.liveContexts.set(sessionId, context)
      this.store.setSessionContext(sessionId, context)
      const meta = this.store.getSession(sessionId)
      if (meta) this.notifyMeta(meta)
      return
    }
    // The user hit Stop: the driver reports the cut-off turn as an error
    // ("turn ended: …") — stamp it so it reads as a stop, not a failure.
    if (event.type === 'error' && this.stopping.has(sessionId)) {
      event = { ...event, stopped: true }
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
    // Seed the task fold before the insert so its walk excludes this
    // event; the walk also lands a fold row for a never-swept session.
    const warm = this.warmTodoFold(sessionId)
    const prev = this.folds.get(sessionId) ?? toFoldRow(sessionId, newFoldState())
    const row = this.store.appendEvent(sessionId, event)
    this.lastActivity.set(sessionId, row.ts)
    const before = tallyOf(warm)
    foldTodo(warm, event, row.ts)
    const after = tallyOf(warm)
    const tasksMoved =
      before?.done !== after?.done ||
      before?.total !== after?.total ||
      before?.current !== after?.current
    const afterRecovery = foldContinuableError(prev.canContinue, event)
    const recoveryMoved = prev.canContinue !== afterRecovery
    // A goal event pushes meta so the prompt-bar indicator flips without
    // a status change.
    const goalMoved = event.type === 'goal'
    this.putFold({
      sessionId,
      foldedSeq: row.seq,
      foldVersion: FOLD_VERSION,
      tasks: after,
      goal: foldGoal(prev.goal, event, row.ts),
      canContinue: afterRecovery
    })
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
    if ((actMoved || tasksMoved || goalMoved || recoveryMoved) && event.type !== 'status') {
      const meta = this.store.getSession(sessionId)
      if (meta) this.notifyMeta(meta)
    }
    let settleToReport: SessionMeta | null = null
    // Status events also update the session row (drives the sidebar).
    // busySince anchors the "working for" timers: it is set when a stretch
    // of work begins and holds through steers and queue drains, so the
    // clock counts from the first message, not the latest wake-up.
    if (event.type === 'status') {
      const cur = this.store.getSession(sessionId)
      const busySince =
        event.status === 'idle'
          ? (this.queues.get(sessionId)?.length ?? 0) > 0
            ? (cur?.busySince ?? null)
            : null
          : (cur?.busySince ?? row.ts)
      const next = this.store.updateSession(sessionId, { status: event.status, busySince })
      if (next) this.notifyMeta(next)
      // Live change stream (M22): watchers follow running sessions.
      if (next) liveDiffOnStatus(this, next, cur?.status)
      // A settled turn runs the pending completed-turn pass first; only a
      // fully settled session (pass included) releases queued messages.
      if (event.status === 'idle') {
        const pass = this.passActive.has(sessionId) ? null : this.passPending.get(sessionId)
        this.passActive.delete(sessionId)
        if (pass) {
          this.passPending.delete(sessionId)
          this.passActive.add(sessionId)
          void this.runTurnPass(sessionId, pass)
        } else if (!this.drainReports(sessionId)) {
          this.drainQueue(sessionId)
        }
      }
      if (event.status === 'error') {
        this.passPending.delete(sessionId)
        this.passActive.delete(sessionId)
      }
      // Dormant supervision: a subagent leaving "running" wakes its parent
      // with an automatic report — immediately when the parent is idle,
      // queued behind its current work otherwise. Skipped when a
      // wait_for_agent already covers this child.
      if (
        next?.parentId &&
        cur?.status === 'running' &&
        (event.status === 'idle' || event.status === 'error' || event.status === 'waiting')
      ) {
        settleToReport = next
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
    }
    // A limited session settling lets its pending switch continue the tree;
    // one moving again by other means no longer waits on it.
    if (event.type === 'status' && this.limited.has(sessionId)) {
      if (event.status === 'idle' || event.status === 'error') this.continueAfterLimit(sessionId)
      else if (event.status === 'running') this.limited.delete(sessionId)
    }
    // Shared context (M8): a finished turn refreshes the thread's mirror.
    if (event.type === 'turn-complete' && persisted?.status !== 'paused') {
      if (this.store.getSession(sessionId)?.projectId) scheduleMirror(this, sessionId)
      if (!this.erroredTurns.has(sessionId)) this.armTurnPass(sessionId)
    }
    for (const listener of this.subscribers.get(sessionId) ?? []) listener(row)
    if (settleToReport) notifyParentOfSettle(this, settleToReport)
  }

  // ── research boards (sources harvested from the agent tree) ─────────

  /** The research thread this session's ancestor chain roots in, if any. */
  private researchRoot(sessionId: string): SessionMeta | null {
    let cur = this.store.getSession(sessionId)
    for (let i = 0; cur?.parentId && i < 16; i++) cur = this.store.getSession(cur.parentId)
    return cur?.threadType === 'research' ? cur : null
  }

  /** A final web tool call in a research tree becomes a research-source
   *  event on the root: WebSearch/web_search board their query, WebFetch
   *  its url. Deduped per (agent, query/url); callIds are prefixed with
   *  the calling session so agents' "call_1"s never collide in one log. */
  private harvestResearchCall(
    sessionId: string,
    event: Extract<AgentEvent, { type: 'tool-call' }>
  ): void {
    const isSearch = /^(websearch|web_search)$/i.test(event.name)
    const isFetch = /^(webfetch|web_fetch)$/i.test(event.name)
    if (!isSearch && !isFetch) return
    const root = this.researchRoot(sessionId)
    if (!root) return
    const input = (
      event.input && typeof event.input === 'object' ? event.input : {}
    ) as Record<string, unknown>
    const agentLabel = this.store.getSession(sessionId)?.title ?? 'research'
    let seen = this.researchSeen.get(root.id)
    if (!seen) {
      seen = new Set()
      this.researchSeen.set(root.id, seen)
    }
    const callId = `${sessionId}:${event.callId}`
    if (isSearch) {
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      if (!query || seen.has(`q:${sessionId}:${query}`)) return
      seen.add(`q:${sessionId}:${query}`)
      this.append(root.id, { type: 'research-source', callId, query, agentId: sessionId, agentLabel })
    } else {
      const url = typeof input.url === 'string' ? input.url.trim() : ''
      if (!url || seen.has(`u:${sessionId}:${url}`)) return
      seen.add(`u:${sessionId}:${url}`)
      this.researchFetches.set(callId, { rootId: root.id, url, agentId: sessionId, agentLabel })
      this.append(root.id, { type: 'research-source', callId, url, agentId: sessionId, agentLabel })
    }
  }

  /** A boarded fetch's result upgrades its row in place (same callId, now
   *  with a title) when one is recoverable from the processed output. */
  private harvestResearchTitle(
    sessionId: string,
    event: Extract<AgentEvent, { type: 'tool-result' }>
  ): void {
    const callId = `${sessionId}:${event.callId}`
    const pending = this.researchFetches.get(callId)
    if (!pending) return
    this.researchFetches.delete(callId)
    if (event.isError) return
    const head = event.output.slice(0, 4000)
    const m =
      head.match(/<title[^>]*>\s*([^<]{1,200}?)\s*<\/title>/i) ??
      head.match(/^#\s+(.{1,200})$/m) ??
      head.match(/^Title:\s*(.{1,200})$/im)
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

  onMeta(listener: MetaListener): () => void {
    this.metaListeners.add(listener)
    return () => this.metaListeners.delete(listener)
  }

  onRemoved(listener: RemovedListener): () => void {
    this.removedListeners.add(listener)
    return () => this.removedListeners.delete(listener)
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

  queueAdd(sessionId: string, text: string, opts?: QueuedSendOpts, front = false): QueuedMessage {
    const item: QueuedMessage = { id: nanoid(10), text, ts: Date.now(), ...opts }
    const q = this.queues.get(sessionId) ?? []
    if (front) q.unshift(item)
    else q.push(item)
    this.queues.set(sessionId, q)
    this.notifyQueue(sessionId)
    // The turn may have settled while the user was typing.
    if (this.store.getSession(sessionId)?.status === 'idle' && !this.isTreePaused(sessionId)) {
      this.drainQueue(sessionId)
    }
    return item
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
        steps.push(
          `Commit every change from this work${where} with a clear message${pass.commit === 'push' ? ', then push that branch to origin' : ''}.`
        )
      }
      // A settle with an unfinished list is housekeeping, not a finish
      // line — the pass must not read as "the work is done".
      const tally = this.tasksOf(sessionId)
      const unfinished =
        tally && tally.done < tally.total
          ? `\nThe task list shows only ${tally.done}/${tally.total} tasks completed — this pass only tidies what exists. End by saying plainly that the work is UNFINISHED and what remains, so the user can resume it.`
          : ''
      await this.armCheckpoint(sessionId)
      await handle.send(
        `<turn-pass>\nThe turn settled. The completed-turn setting now asks you to:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nThese are the project's own completion settings — they OVERRIDE any branch, worktree, PR, or completion convention a skill or other instruction gave earlier in this thread. If the turn changed nothing to verify, build, or commit, say so in one short line and stop. Never start new feature work in this pass.${unfinished}\n</turn-pass>`
      )
    } catch {
      // Harness refused (gone, mid-restart) — settle back to normal flow.
      this.passActive.delete(sessionId)
      if (!this.drainReports(sessionId)) this.drainQueue(sessionId)
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
    if (this.store.getSession(sessionId)?.status === 'idle' && !this.isTreePaused(sessionId)) {
      this.drainReports(sessionId)
    }
  }

  /** On idle: send one parked report straight to the harness. Returns
   *  whether a report took this settle (the queue then waits its turn). */
  private drainReports(sessionId: string): boolean {
    if (this.isTreePaused(sessionId)) return false
    if (this.draining.has(sessionId)) return false
    const list = this.pendingReports.get(sessionId)
    if (!list?.length) return false
    const item = list.shift()!
    if (!list.length) this.pendingReports.delete(sessionId)
    this.draining.add(sessionId)
    void (async () => {
      const handle = await this.handleFor(sessionId)
      this.append(sessionId, {
        type: 'agent-report',
        agentId: item.agentId,
        title: item.title,
        status: item.status
      })
      this.lastActivity.set(sessionId, Date.now())
      await this.armCheckpoint(sessionId)
      await handle.send(item.text)
    })()
      .catch(() => {
        // Harness refused (gone, mid-restart) — park it for the next settle.
        const q = this.pendingReports.get(sessionId) ?? []
        q.unshift(item)
        this.pendingReports.set(sessionId, q)
      })
      .finally(() => this.draining.delete(sessionId))
    return true
  }

  /** On idle: send the next queued message, one per settle. */
  private drainQueue(sessionId: string): void {
    if (this.isTreePaused(sessionId)) return
    if (this.draining.has(sessionId)) return
    const q = this.queues.get(sessionId)
    if (!q?.length) return
    const item = q.shift()!
    this.notifyQueue(sessionId)
    this.draining.add(sessionId)
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
      })
      .finally(() => this.draining.delete(sessionId))
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
    return {
      ...session,
      activity: act?.text ?? null,
      activityKind: act?.kind ?? null,
      tasks: this.tasksOf(session.id),
      goal: this.goalOf(session.id),
      context: this.liveContexts.get(session.id) ?? null,
      canContinue: this.canContinueError(session),
      treeCanContinue: tree.canContinueError,
      treeHasLiveWork: tree.hasLiveWork,
      treeHasPaused: tree.hasPaused,
      treeFrozenActiveElapsed: tree.frozenActiveElapsed
    }
  }

  private notifyMeta(session: SessionMeta): void {
    const index = this.indexOf()
    const decorated = this.decorate(session, index)
    for (const l of this.metaListeners) l(decorated)
    if (session.parentId) {
      const root = index.byId.get(this.rootSessionOf(session.id))
      if (root) {
        const decoratedRoot = this.decorate(root, index)
        for (const l of this.metaListeners) l(decoratedRoot)
      }
    }
  }

  async disposeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    for (const id of [...this.pendingApprovals.keys()]) this.denyPendingApprovals(id)
    await Promise.allSettled([...this.handles.values()].map((h) => h.dispose()))
    this.handles.clear()
  }
}
