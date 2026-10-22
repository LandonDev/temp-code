import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ClientRequest, SessionBatchResult } from '@shared/contract'
import {
  BATCH_STEP_LOG_LINES,
  BatchRulesSchema,
  DEFAULT_BATCH_RULES,
  DEFAULT_BATCH_STEPS,
  emptyBatch,
  emptyStep,
  rulesLine,
  stepsProblem,
  withLandStep,
  type BatchAdoptResult,
  type BatchRules,
  type BatchState,
  type BatchStep,
  type BatchStepSpec
} from '@shared/contract-batch'
import type { DeployStatus, HostLogPush } from '@shared/contract-host'
import type { SessionMeta } from '@shared/events'
import { gateLine, type GateNotice } from '@shared/gate'
import { ADOPT_THREAD_TOOL_NAME, BATCH_GATE_TOOL_NAME, BATCH_RULES_TOOL_NAME, GATE_TEXT_TAIL, logTail } from '@shared/gate'
import { PUBLISH_PHASES, PhaseTracker, deployProgress, formatDuration } from '@shared/releasePhases'
import { gateQueue, type GateQueue, type GateWait } from './gateQueue'
import { runGateStep } from './gateRun'
import { loginShell } from './loginShell'
import { branchOf, fastForwardMerge, revParse, type MergeResult } from './mergeBranch'
import type { Landed } from './mergeReview'
import type { SessionBatchAction } from './sessionBatch'
import type { SessionRegistry } from './sessions'

/**
 * A master thread's batch (contract-batch.ts): the steps its children
 * never run themselves, run by the app under the rules the master wrote.
 *
 * The rules (`batch_rules` from the master, `batch.setRules` from a person):
 * `land` as-they-finish (merge_branch fast-forwards each child's branch as
 * it lands) or all-at-once (merge_branch answers HELD and records the
 * branch; the engine merges them in landing order at the end); `steps`,
 * the list in order, each a built-in kind or a `shell` of the master's
 * own; `then` notify (a notice row on the master and a wake) or
 * archive-children (the same, and every done child archived). The
 * built-in kinds: `gate` (the commit tier once on the project checkout at
 * the project branch's head); `release` (`bun scripts/release.ts
 * "<notes>" --push` after a green gate: the tag, and master with it pushed
 * to origin); `publish` (the Mac's publish job for that commit: over the
 * peer link from the box, remote/peerPublish.ts, or the Mac's own
 * Publisher when the master lives on the Mac, remote/macPublish.ts
 * LocalPublish); `deploy` (the box's deploy trigger, docs/box.md "Deploy
 * from the app": v1.0.N when published, master otherwise; from the Mac
 * over its link to the box, remote/peerDeploy.ts). A `shell` step runs its
 * `run` through the login shell in its `cwd` (default the project
 * checkout) on the host's gate queue, its stdout and stderr streamed into
 * the step's log, exit 0 passes; `when: 'each-landing'` runs it again
 * after every landing instead of at the end. The default list is land,
 * gate, release.
 *
 * Each step's telemetry on the wire (contract-batch.ts): the publish step
 * counts the script's phases (releasePhases.ts: gate, build, sign, zip,
 * pack, upload, feed, and the app's own update) with the running one as
 * the label and every line in its log; the deploy step counts box-update's
 * stages; the gate and release steps the gate's lines. A green publish or
 * a green deploy of a v1.0.N tells the installed Mac app to fetch it that
 * second (`announce`: releaseAnnounce.ts), and the final <batch-report>
 * names what each step did with its time.
 *
 * The engine runs when the last child is done: every unarchived root
 * carrying the masterId is `done`, or `idle` with a turn completed. A
 * child that errored or stopped blocks the end, `blocked` names it and the
 * master is told once. Steps run in order on the host's gate queue, each
 * with its own log, progress and times on the wire (the board's foot draws
 * a console per running step); a red step stops the rest and the master is
 * told; the engine arms again when a child changes or a new one appears.
 * `batch_gate` is the master's way to run the gate and release steps
 * early, with children still out (left out of the land step).
 *
 * The deploy restarts this very process on the box, so the row is
 * persisted before the trigger fires and `resumeAfterBoot` reads the
 * trigger's files to close the step, run the steps after it and `then`.
 * State lives in one settings row per master (`batch:<masterId>`);
 * `pending` is computed from the sessions table on every read. Every
 * change is pushed as `batch` (contract.ts), coalesced to at most four
 * pushes a second while a step's log streams. `open(masterId)` is what
 * keeps the master `watching` (sessions.ts): children exist and the engine
 * has not finished with them. The batch's membership moves through
 * `adopt` (an existing root joins) and `archive` (the children leave, the
 * master stays).
 */

/** The unarchived root threads of a master, oldest first. */
export function batchChildren(registry: Pick<SessionRegistry, 'list'>, masterId: string): SessionMeta[] {
  return registry
    .list({ archived: false })
    .filter((s) => s.masterId === masterId && !s.parentId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** A branch merge_branch held under all-at-once: what the engine merges at the end. */
export interface HeldLanding {
  sessionId: string
  cwd: string
  branch: string
  target: string
  push: boolean
  subjects: string[]
}

/** What the row keeps beyond the wire shape: each landed child's branch and subjects (the notes), the held landings, the deploy in flight. */
interface StoredBatch {
  masterId: string
  rules: BatchRules
  /** the telemetry of `withLandStep(rules.steps)`, in that order */
  steps: BatchStep[]
  landed: string[]
  held: string[]
  blocked: BatchState['blocked']
  finishedAt: number | null
  /** the engine runs on the next all-done; cleared when it has run, set by any change since */
  armed: boolean
  branches: Record<string, string>
  subjects: Record<string, string[]>
  holds: Record<string, HeldLanding>
  /** the release this cycle cut: "1.0.N" */
  version: string | null
  /** the ref the deploy trigger was fired with, until the step closes */
  deployRef: string | null
  /** the land step's left-out count at the end, for the done line after a restart */
  leftOut: number
}

const freshRow = (masterId: string, rules: BatchRules = DEFAULT_BATCH_RULES): StoredBatch => ({
  ...emptyBatch(masterId, [], rules),
  armed: true,
  branches: {},
  subjects: {},
  holds: {},
  version: null,
  deployRef: null,
  leftOut: 0
})

/** The outcome of the Mac's publish job (remote/peerPublish.ts). */
export interface PublishRun {
  ok: boolean
  exit: number | null
  version: string | null
  text: string
}

/** What the engine needs of the publish job: remote/peerPublish.ts on the box, remote/macPublish.ts's LocalPublish on the Mac. */
export interface PublishLike {
  resolveMac(sessionId: string): string
  start(
    sessionId: string,
    args: { sha: string; branch: string; version: string; notes: string },
    onLine: (line: string) => void
  ): { done: Promise<PublishRun>; stop: () => Promise<void> }
}

/** What the engine needs of the deploy: hostJobs.ts's DeployTrigger on the box, remote/peerDeploy.ts on the Mac. */
export interface DeployLike {
  deploy(ref: string): Promise<unknown>
  status(): DeployStatus | Promise<DeployStatus>
  subscribe(connection: number, send: (push: HostLogPush) => void): () => void
}

/** A shell step's process: its lines, its exit, and Stop (the process group). */
export interface ShellRun {
  done: Promise<{ code: number | null; signal: string | null }>
  stop: () => void
}

export interface BatchesDeps {
  registry: Pick<SessionRegistry, 'list' | 'get' | 'getProject' | 'append'> & {
    /** has the thread finished a turn: an idle child counts as done only then (a fresh thread between its first row and its first turn is idle too) */
    hasCompletedTurn?(sessionId: string): boolean
    setArchived?(sessionId: string, archived: boolean): Promise<void>
    deliverAgentReport?(sessionId: string, report: { text: string; agentId: string; title: string; status: string }): void
    /** the batch closed with nothing coming: a master left watching idles (sessions.ts) */
    masterIdle?(sessionId: string): void
    onMeta?(listener: (session: SessionMeta) => void): () => void
    onRemoved?(listener: (sessionIds: string[]) => void): () => void
    /** adopt: an existing root thread takes the master's id (and startedBy when it had none) */
    setBatchMembership?(sessionId: string, masterId: string): void
    /** archive: the fleet's own action over many threads, with its resource cleanup */
    batch?(action: SessionBatchAction, ids: readonly string[], options?: { cleanup?: boolean }): Promise<SessionBatchResult>
  }
  store: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string | null): void
    settingsWithPrefix?(prefix: string): Map<string, string>
  }
  runGate?: typeof runGateStep
  queue?: GateQueue
  /** the branch a checkout is on; tests pass their own */
  branchOf?: typeof branchOf
  /** a ref's commit in a checkout */
  revParse?: typeof revParse
  /** the fast-forward of a held branch at the end (mergeBranch.ts) */
  merge?: typeof fastForwardMerge
  /** the Mac's publish job over the peer link; absent where there is no peer link */
  publish?: PublishLike
  /** the box's deploy trigger (hostJobs.ts `host.deploy`); absent where there is none */
  deploy?: DeployLike
  /** a release landed (a green publish, a green deploy of a v1.0.N): the installed app fetches it now (releaseAnnounce.ts) */
  announce?: (version: string) => void
  /** this host's running version ("1.0.N"): a publish step found running at boot passed when the host restarted into its version */
  version?: string
  /** a shell step's process; the default runs `run` through the login shell in `cwd`, its own process group */
  shell?: (run: string, cwd: string, onLine: (line: string) => void) => ShellRun
  now?: () => number
  /** how often at most the `batch` push goes out while a log streams (ms) */
  pushEveryMs?: number
}

const ROW_PREFIX = 'batch:'
const DONE = new Set<SessionMeta['status']>(['done'])
const BLOCKS: Partial<Record<SessionMeta['status'], 'errored' | 'stopped'>> = { error: 'errored', stopped: 'stopped' }
/** The connection number the engine subscribes to the deploy log with (never a socket's). */
const DEPLOY_LOG_CONNECTION = -7
const PUSH_EVERY_MS = 250

/** `run` through the login shell in `cwd`, detached so Stop kills the whole process group. */
export function spawnShellStep(run: string, cwd: string, onLine: (line: string) => void): ShellRun {
  const child = spawn(loginShell(), ['-lc', run], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) createInterface({ input: stream }).on('line', onLine)
  }
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('error', (err) => {
      onLine(`✗ ${err.message}`)
      resolve({ code: null, signal: null })
    })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const stop = (): void => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        // already gone
      }
    }
  }
  return { done, stop }
}

type StepsOutcome = 'done' | 'failed' | 'handed-off'

export class Batches {
  private readonly rows = new Map<string, StoredBatch>()
  private readonly listeners = new Set<(state: BatchState) => void>()
  private readonly runGate: typeof runGateStep
  private readonly queue: GateQueue
  private readonly branchOf: typeof branchOf
  private readonly revParse: typeof revParse
  private readonly merge: typeof fastForwardMerge
  private readonly shell: NonNullable<BatchesDeps['shell']>
  private readonly now: () => number
  private readonly pushEveryMs: number
  /** one batch_gate, engine run or landing run at a time per master */
  private readonly gating = new Set<string>()
  /** masters whose review is queued behind the current microtask */
  private readonly dirty = new Set<string>()
  /** the blocked reports already delivered: `<child>:<why>` */
  private readonly toldBlocked = new Set<string>()
  /** the publish in flight per master, for Stop */
  private readonly publishing = new Map<string, { stop: () => Promise<void> }>()
  /** the shell steps in flight: `<master>/<step>` → Stop */
  private readonly shells = new Map<string, { stop: () => void; stopped: boolean }>()
  /** the each-landing runs per master, serialized */
  private readonly landingRuns = new Map<string, Promise<void>>()
  /** the deploy log follower per master */
  private readonly following = new Map<string, () => void>()
  /** coalesced pushes: rows changed since the last push, and the trailing timer */
  private readonly pushPending = new Set<string>()
  private pushTimer: NodeJS.Timeout | null = null
  private lastPush = 0
  private detach: (() => void) | null = null

  constructor(private readonly deps: BatchesDeps) {
    this.runGate = deps.runGate ?? runGateStep
    this.queue = deps.queue ?? gateQueue()
    this.branchOf = deps.branchOf ?? branchOf
    this.revParse = deps.revParse ?? revParse
    this.merge = deps.merge ?? fastForwardMerge
    this.shell = deps.shell ?? spawnShellStep
    this.now = deps.now ?? Date.now
    this.pushEveryMs = deps.pushEveryMs ?? PUSH_EVERY_MS
    for (const [key, raw] of deps.store.settingsWithPrefix?.(ROW_PREFIX) ?? []) {
      const row = parseRow(raw)
      if (row) this.rows.set(row.masterId, row)
      else deps.store.setSetting(key, null)
    }
  }

  onChange(listener: (state: BatchState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Follow the registry: a child's status change, archive or removal reviews its batch. */
  attach(): () => void {
    if (this.detach) return this.detach
    const offMeta = this.deps.registry.onMeta?.((m) => {
      if (m.masterId && !m.parentId) this.schedule(m.masterId)
    })
    const offRemoved = this.deps.registry.onRemoved?.(() => {
      for (const id of this.rows.keys()) this.schedule(id)
    })
    this.detach = () => {
      offMeta?.()
      offRemoved?.()
      this.detach = null
    }
    return this.detach
  }

  /** After the BootResumer: a deploy that was running when this process
   *  restarted (the deploy restarts the box's service) is closed from the
   *  trigger's files, or followed on, and the rest runs; a publish or a
   *  shell step in flight is lost with the process and its step says so. */
  async resumeAfterBoot(): Promise<void> {
    for (const row of this.rows.values()) {
      const master = this.deps.registry.get(row.masterId)
      const publish = this.byKind(row, 'publish')
      if (publish && this.step(row, publish.id).status === 'running') {
        if (row.version && this.deps.version === row.version) {
          // The Mac restarted into the release its own publish step made: the step is done, the rest waits for a message.
          this.end(row, publish.id, 'passed', `v${row.version} published; this host restarted into it`)
          this.save(row)
          if (master) this.tell(master, 'done', `The batch's publish of v${row.version} landed and this host restarted into it; the steps after it did not run. Send a message to run the end of the batch again if the rules name a deploy.`)
          continue
        }
        this.end(row, publish.id, 'failed', 'the host restarted during the publish; its outcome is on the Mac')
        this.save(row)
        if (master) this.tell(master, 'failed', `The batch's publish was running on the Mac when this host restarted; check the Mac's publish log, then send a message to run the end of the batch again.`)
        continue
      }
      const shell = row.steps.find((s) => s.kind === 'shell' && s.status === 'running')
      if (shell) {
        this.end(row, shell.id, 'failed', 'the host restarted during the step')
        this.save(row)
        if (master) this.tell(master, 'failed', `The batch's step "${shell.name}" was running when this host restarted; send a message to run the end of the batch again.`)
        continue
      }
      const deploy = this.byKind(row, 'deploy')
      if (!deploy || this.step(row, deploy.id).status !== 'running' || !row.deployRef) continue
      this.gating.add(row.masterId)
      this.logLine(row, deploy.id, `== host restarted; following the deploy of ${row.deployRef}`)
      void this.followDeploy(row, deploy)
    }
  }

  // ── reads ────────────────────────────────────────────────────────────

  /** The live state: the persisted steps and landings, the pending children from the sessions table. */
  get(masterId: string): BatchState {
    const row = this.row(masterId)
    const children = batchChildren(this.deps.registry, masterId).map((s) => s.id)
    const known = (id: string): boolean => children.includes(id) || !!this.deps.registry.get(id)
    return {
      masterId,
      rules: { ...row.rules, steps: row.rules.steps.map((s) => ({ ...s })) },
      steps: row.steps.map((s) => ({ ...s, log: [...s.log], ...(s.progress ? { progress: { ...s.progress } } : {}) })),
      landed: row.landed.filter(known),
      pending: children.filter((id) => !row.landed.includes(id)),
      held: row.held.filter(known),
      blocked: row.blocked,
      finishedAt: row.finishedAt
    }
  }

  /** The rules as they stand. */
  rules(masterId: string): BatchRules {
    const row = this.row(masterId)
    return { ...row.rules, steps: row.rules.steps.map((s) => ({ ...s })) }
  }

  /** Set some or all of the rules (the `batch_rules` tool, `batch.setRules`).
   *  A steps list keeps the telemetry of every step whose id and kind stay. */
  setRules(masterId: string, patch: Partial<BatchRules>): BatchState {
    const row = this.row(masterId)
    const next = BatchRulesSchema.parse({ ...row.rules, ...patch })
    if (next.summary !== undefined && !next.summary.trim()) delete next.summary
    const problem = stepsProblem(next.steps)
    if (problem) throw new Error(problem)
    row.rules = next
    row.steps = reconcileSteps(row.steps, withLandStep(next.steps))
    row.armed = true
    this.save(row)
    this.schedule(masterId)
    return this.get(masterId)
  }

  /** Is the batch still the master's business: children exist and the
   *  engine has not run on them all done (sessions.ts keeps such a master
   *  `watching` instead of `idle`). */
  open(masterId: string): boolean {
    const children = batchChildren(this.deps.registry, masterId)
    if (children.length === 0) return false
    if (this.gating.has(masterId)) return true
    const row = this.row(masterId)
    return !this.allDone(children) || row.armed || row.steps.some((s) => s.status === 'running')
  }

  /** Stop a running step that can be stopped: a shell step's process group, or the Mac's publish job. */
  async stopStep(masterId: string, stepId: string): Promise<{ stopped: boolean }> {
    const shell = this.shells.get(`${masterId}/${stepId}`)
    if (shell) {
      shell.stopped = true
      shell.stop()
      return { stopped: true }
    }
    const row = this.row(masterId)
    const spec = this.specs(row).find((s) => s.id === stepId)
    if (spec?.kind !== 'publish') return { stopped: false }
    const run = this.publishing.get(masterId)
    if (!run) return { stopped: false }
    await run.stop()
    return { stopped: true }
  }

  // ── membership ───────────────────────────────────────────────────────

  /** Existing unarchived root threads join the batch (`batch.adopt`, the
   *  `adopt_thread` tool): each takes the master's id, and `startedBy` when
   *  it had none, so its next settle reaches the master. Refused: the
   *  master itself, another master, a subagent, an archived thread, a
   *  thread of another batch, an unknown id. Never throws. */
  adopt(masterId: string, sessionIds: readonly string[]): BatchAdoptResult {
    const master = this.deps.registry.get(masterId)
    const adopted: string[] = []
    const refused: BatchAdoptResult['refused'] = []
    if (!master || !master.isMaster || master.parentId) {
      for (const id of sessionIds) refused.push({ sessionId: id, why: `${masterId} is not a master thread` })
      return { adopted, refused, state: this.get(masterId) }
    }
    for (const id of new Set(sessionIds)) {
      const s = this.deps.registry.get(id)
      const why = !s
        ? 'unknown thread'
        : s.id === masterId
          ? 'it is the master itself'
          : s.parentId
            ? 'it is a subagent'
            : s.isMaster
              ? 'it is a master thread'
              : s.archived
                ? 'it is archived'
                : s.masterId && s.masterId !== masterId
                  ? `it is in the batch of ${s.masterId}`
                  : null
      if (why) {
        refused.push({ sessionId: id, why })
        continue
      }
      if (s!.masterId !== masterId) this.deps.registry.setBatchMembership?.(id, masterId)
      adopted.push(id)
    }
    if (adopted.length) {
      const row = this.row(masterId)
      row.armed = true
      this.save(row)
      this.schedule(masterId)
    }
    return { adopted, refused, state: this.get(masterId) }
  }

  /** The `adopt_thread` tool: one thread into the caller's batch. Never throws. */
  adoptTool(master: SessionMeta, args: { threadId: string }): string {
    const refusal = this.refusal(master, ADOPT_THREAD_TOOL_NAME)
    if (refusal) return refusal
    const result = this.adopt(master.id, [args.threadId])
    if (result.refused.length) return `refused: ${result.refused[0].why}`
    const thread = this.deps.registry.get(args.threadId)
    return `Adopted "${thread?.title ?? args.threadId}" (${args.threadId}) into your batch: its settles reach you from here, and it counts toward the batch's end.`
  }

  /** The batch's children leave (`batch.archive`): `done` = the done ones
   *  (done, or idle after a turn), `all` = every one, the live ones
   *  stopped first; through the fleet's own batch action, four at a time,
   *  with its resource cleanup when asked. The master stays. */
  async archive(masterId: string, which: 'done' | 'all', removeResources = false): Promise<SessionBatchResult> {
    const children = batchChildren(this.deps.registry, masterId)
    const targets = (which === 'all' ? children : children.filter((s) => this.done(s))).map((s) => s.id)
    if (targets.length === 0 || !this.deps.registry.batch) return { attempted: [], succeeded: [], failed: [] }
    if (which === 'all') {
      const live = children.filter((s) => !this.done(s) && s.status !== 'queued').map((s) => s.id)
      if (live.length) await this.deps.registry.batch('stop', live)
    }
    const result = await this.deps.registry.batch('archive', targets, { cleanup: removeResources })
    this.schedule(masterId)
    return result
  }

  private row(masterId: string): StoredBatch {
    let row = this.rows.get(masterId)
    if (!row) {
      row = parseRow(this.deps.store.getSetting(`${ROW_PREFIX}${masterId}`)) ?? freshRow(masterId)
      this.rows.set(masterId, row)
    }
    return row
  }

  /** Persist the row and push it (coalesced). */
  private save(row: StoredBatch): void {
    this.rows.set(row.masterId, row)
    this.deps.store.setSetting(`${ROW_PREFIX}${row.masterId}`, JSON.stringify(row))
    this.touch(row)
  }

  /** The `batch` push, at most one per pushEveryMs per burst: the first at once, the rest trailing. */
  private touch(row: StoredBatch): void {
    this.pushPending.add(row.masterId)
    const since = this.now() - this.lastPush
    if (since >= this.pushEveryMs) return this.flush()
    if (!this.pushTimer) {
      this.pushTimer = setTimeout(() => this.flush(), Math.max(1, this.pushEveryMs - since))
      this.pushTimer.unref?.()
    }
  }

  /** Push every changed row now (tests call it to see the trailing push). */
  flush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    this.lastPush = this.now()
    const ids = [...this.pushPending]
    this.pushPending.clear()
    for (const id of ids) {
      const row = this.rows.get(id)
      if (!row) continue
      // A streamed log is persisted with its push, not on every line.
      this.deps.store.setSetting(`${ROW_PREFIX}${id}`, JSON.stringify(row))
      const state = this.get(id)
      for (const l of this.listeners) l(state)
    }
  }

  // ── the steps' telemetry ─────────────────────────────────────────────

  /** The rules' steps with a land step first. */
  private specs(row: StoredBatch): BatchStepSpec[] {
    return withLandStep(row.rules.steps)
  }

  /** The one step of a built-in kind, when the list has it. */
  private byKind(row: StoredBatch, kind: Exclude<BatchStepSpec['kind'], 'shell'>): BatchStepSpec | null {
    return this.specs(row).find((s) => s.kind === kind) ?? null
  }

  private landId(row: StoredBatch): string {
    return this.byKind(row, 'land')!.id
  }

  private step(row: StoredBatch, id: string): BatchStep {
    let step = row.steps.find((s) => s.id === id)
    if (!step) {
      const spec = this.specs(row).find((s) => s.id === id) ?? { id, name: id, kind: 'shell' as const }
      row.steps = reconcileSteps(row.steps, this.specs(row))
      step = row.steps.find((s) => s.id === id) ?? emptyStep(spec)
      if (!row.steps.includes(step)) row.steps.push(step)
    }
    return step
  }

  /** A step starts: its log and progress start afresh. The land step keeps
   *  its log across cycles: its lines are the landings, which stay. */
  private begin(row: StoredBatch, id: string, detail: string): void {
    const step = this.step(row, id)
    step.status = 'running'
    step.detail = detail
    step.at = this.now()
    step.startedAt = this.now()
    delete step.endedAt
    if (step.kind !== 'land') {
      delete step.progress
      step.log = []
    }
  }

  private end(row: StoredBatch, id: string, status: 'passed' | 'failed' | 'skipped', detail: string): void {
    const step = this.step(row, id)
    step.status = status
    step.detail = detail
    step.at = this.now()
    step.endedAt = this.now()
  }

  private detail(row: StoredBatch, id: string, detail: string): void {
    const step = this.step(row, id)
    step.detail = detail
    step.at = this.now()
  }

  private reset(row: StoredBatch, id: string): void {
    const i = row.steps.findIndex((s) => s.id === id)
    if (i >= 0) row.steps[i] = emptyStep(row.steps[i])
  }

  private logLine(row: StoredBatch, id: string, line: string): void {
    const step = this.step(row, id)
    step.log.push(line)
    if (step.log.length > BATCH_STEP_LOG_LINES) step.log.splice(0, step.log.length - BATCH_STEP_LOG_LINES)
    this.touch(row)
  }

  private progress(row: StoredBatch, id: string, p: NonNullable<BatchStep['progress']>): void {
    this.step(row, id).progress = p
    this.touch(row)
  }

  private landDetail(row: StoredBatch, leftOut = 0): string {
    const total = batchChildren(this.deps.registry, row.masterId).length
    const n = row.landed.length
    return `${n} of ${Math.max(total, n)} landed${leftOut ? ` · ${leftOut} left out` : ''}`
  }

  // ── land ─────────────────────────────────────────────────────────────

  /** merge_branch landed a child's branch (mergeReview.ts onLanded): the
   *  landing is recorded, then the each-landing steps run. */
  landed(l: Landed): void {
    const masterId = l.session.masterId
    if (!masterId) return
    const row = this.row(masterId)
    this.record(row, l.session.id, l.branch, l.subjects)
    this.save(row)
    this.runLandingSteps(row)
    this.schedule(masterId)
  }

  private record(row: StoredBatch, sessionId: string, branch: string, subjects: string[]): void {
    const masterId = row.masterId
    const land = this.landId(row)
    // A landing after the end, after a red step, or after any end step ran:
    // the steps after land run again on the new head. What landed before
    // stays landed (it is on the branch); only the steps reopen. An
    // each-landing step keeps its last outcome until it runs again.
    const endSteps = this.specs(row).filter((s) => s.kind !== 'land' && s.when !== 'each-landing')
    if ((row.finishedAt || endSteps.some((s) => this.step(row, s.id).status !== 'pending')) && !this.gating.has(masterId)) {
      for (const s of endSteps) this.reset(row, s.id)
      row.finishedAt = null
      row.version = null
      row.deployRef = null
    }
    if (!row.landed.includes(sessionId)) row.landed.push(sessionId)
    row.held = row.held.filter((id) => id !== sessionId)
    delete row.holds[sessionId]
    row.branches[sessionId] = branch
    row.subjects[sessionId] = subjects
    row.armed = true
    const children = batchChildren(this.deps.registry, masterId)
    if (this.step(row, land).status !== 'running') this.begin(row, land, '')
    this.logLine(row, land, `${branch} landed`)
    this.progress(row, land, { done: row.landed.length, total: Math.max(children.length, row.landed.length) })
    this.detail(row, land, this.landDetail(row))
  }

  /** The `each-landing` steps, in order, after a landing: serialized per
   *  master, holding the gating so the end waits for them; a red one tells
   *  the master and never blocks the end. */
  private runLandingSteps(row: StoredBatch): void {
    const specs = this.specs(row).filter((s) => s.when === 'each-landing')
    if (specs.length === 0) return
    const masterId = row.masterId
    const prev = this.landingRuns.get(masterId) ?? Promise.resolve()
    const run = prev.then(async () => {
      const master = this.deps.registry.get(masterId)
      const project = master?.projectId ? this.deps.registry.getProject(master.projectId) : null
      if (!master || !project) return
      this.gating.add(masterId)
      try {
        for (const spec of specs) {
          const ok = await this.runShell(master, row, spec, project.cwd)
          if (!ok) {
            const step = this.step(row, spec.id)
            this.tell(master, 'failed', `The batch's step "${spec.name}" FAILED after a landing: ${step.detail}\n\n${logTail(step.log.join('\n'), GATE_TEXT_TAIL)}`)
            break
          }
        }
      } finally {
        this.gating.delete(masterId)
        this.schedule(masterId)
      }
    })
    this.landingRuns.set(masterId, run.catch(() => undefined))
  }

  /** merge_branch asks before a batch child's fast-forward: under
   *  all-at-once the landing is recorded and held, and the answer is the
   *  text the child reads; under as-they-finish, null (merge now). */
  hold(session: SessionMeta, landing: Omit<HeldLanding, 'sessionId'>): string | null {
    if (!session.masterId) return null
    const row = this.row(session.masterId)
    if (row.rules.land !== 'all-at-once') return null
    const land = this.landId(row)
    if (!row.held.includes(session.id)) row.held.push(session.id)
    row.holds[session.id] = { sessionId: session.id, ...landing }
    row.armed = true
    if (this.step(row, land).status !== 'running') this.begin(row, land, '')
    this.logLine(row, land, `${landing.branch} held for the end`)
    this.detail(row, land, `${row.held.length} held for the end${row.landed.length ? ` · ${row.landed.length} landed` : ''}`)
    this.save(row)
    this.schedule(session.masterId)
    return `HELD: the batch lands all at once; the master will merge ${landing.branch} when every thread is done. Your work is recorded; you are done with it.`
  }

  // ── the end of the batch ─────────────────────────────────────────────

  private done(s: SessionMeta): boolean {
    if (DONE.has(s.status)) return true
    return s.status === 'idle' && (this.deps.registry.hasCompletedTurn?.(s.id) ?? true)
  }

  private allDone(children: SessionMeta[]): boolean {
    return children.every((s) => this.done(s))
  }

  /** Something changed for a master's batch: review it soon, once per burst. */
  schedule(masterId: string): void {
    if (this.dirty.has(masterId)) return
    this.dirty.add(masterId)
    void Promise.resolve().then(() => {
      this.dirty.delete(masterId)
      this.review(masterId).catch((err) => console.log(`[batch] ${masterId}: ${err instanceof Error ? err.message : String(err)}`))
    })
  }

  /** Blocked by an errored or stopped child (the master told once), or
   *  all done and armed: run the steps. Nothing otherwise. */
  async review(masterId: string): Promise<void> {
    const master = this.deps.registry.get(masterId)
    if (!master || master.archived || !master.isMaster) return
    const row = this.row(masterId)
    const children = batchChildren(this.deps.registry, masterId)
    // Any child moving again arms the engine for the next all-done.
    if (children.some((s) => !this.done(s) && !BLOCKS[s.status]) && !row.armed) {
      row.armed = true
      this.save(row)
    }
    const blocker = children.find((s) => BLOCKS[s.status])
    const blocked = blocker ? { sessionId: blocker.id, why: BLOCKS[blocker.status]! } : null
    if (JSON.stringify(blocked) !== JSON.stringify(row.blocked)) {
      row.blocked = blocked
      this.save(row)
    }
    if (blocker && blocked) {
      const key = `${blocker.id}:${blocked.why}`
      if (!this.toldBlocked.has(key)) {
        this.toldBlocked.add(key)
        this.tell(master, 'blocked', `The batch cannot finish: batch thread "${blocker.title}" (${blocker.id}) ${blocked.why}. Fix it (a message, a new thread) or remove it (archive); the batch's steps run once every thread is done.`)
      }
      return
    }
    if (children.length === 0 || !row.armed || this.gating.has(masterId)) {
      if (master.status === 'watching' && !this.open(masterId)) this.deps.registry.masterIdle?.(masterId)
      return
    }
    if (!this.allDone(children)) return
    await this.finish(master, row, children)
  }

  /** The land step (what was held, in landing order), then the steps the
   *  rules name in order; a red one stops the rest. */
  private async finish(master: SessionMeta, row: StoredBatch, children: SessionMeta[]): Promise<void> {
    const project = master.projectId ? this.deps.registry.getProject(master.projectId) : null
    if (!project) return
    row.armed = false
    row.finishedAt = null
    this.gating.add(master.id)
    let handedOff = false
    try {
      const target = project.branch ?? (await this.branchOf(project.cwd))
      const land = this.landId(row)
      // land: merge what was held, in landing order.
      if (this.step(row, land).status !== 'running') this.begin(row, land, this.landDetail(row))
      const toMerge = [...row.held]
      for (const [i, id] of toMerge.entries()) {
        const h = row.holds[id]
        if (!h) continue
        this.progress(row, land, { done: i, total: toMerge.length, label: h.branch })
        let result: MergeResult
        try {
          result = await this.merge(h.cwd, h.branch, h.target, h.push)
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          this.logLine(row, land, `✗ ${h.branch}: ${why}`)
          return this.fail(master, row, land, `The batch's merge of ${h.branch} failed: ${why}. Rebase it on a child and call merge_branch there again; the batch finishes once every thread is done.`)
        }
        this.record(row, id, h.branch, h.subjects)
        this.deps.registry.append(id, { type: 'notice', kind: 'batch', message: `Merged by the batch: ${h.branch} → ${h.target} at ${result.sha.slice(0, 10)}${result.pushed ? ', pushed' : ''}` })
        this.save(row)
      }
      row.leftOut = children.filter((s) => !row.landed.includes(s.id)).length
      this.progress(row, land, { done: row.landed.length, total: Math.max(children.length, row.landed.length) })
      this.end(row, land, 'passed', this.landDetail(row, row.leftOut))
      this.save(row)
      const outcome = await this.runSteps(master, row, project, target, 0)
      if (outcome === 'handed-off') {
        handedOff = true
        return
      }
      if (outcome === 'failed') return
      await this.thenPhase(master, row)
    } finally {
      if (!handedOff) this.gating.delete(master.id)
    }
  }

  private fail(master: SessionMeta, row: StoredBatch, stepId: string, text: string): void {
    this.end(row, stepId, 'failed', text.split('\n')[0].slice(0, 160))
    this.save(row)
    this.tell(master, 'failed', text)
  }

  /** The steps from index `from` of the list, the land step and the
   *  each-landing ones passed over: each by its kind. 'handed-off' when
   *  the deploy fired (the process may not survive it; `followDeploy`
   *  continues after it). */
  private async runSteps(
    master: SessionMeta,
    row: StoredBatch,
    project: { cwd: string; branch: string | null },
    target: string | null,
    from: number
  ): Promise<StepsOutcome> {
    const specs = this.specs(row)
    const nothing = row.landed.length === 0
    const skip = (id: string, why: string): void => {
      this.end(row, id, 'skipped', why)
      this.save(row)
    }
    for (let i = from; i < specs.length; i++) {
      const spec = specs[i]
      if (spec.kind === 'land' || spec.when === 'each-landing') continue
      if (nothing) {
        skip(spec.id, 'nothing landed')
        continue
      }
      switch (spec.kind) {
        case 'gate': {
          if (!target || (await this.branchOf(project.cwd)) !== target) {
            this.begin(row, spec.id, '')
            this.fail(master, row, spec.id, `The project checkout at ${project.cwd} is not on ${target ?? 'the project branch'}; check it out there and send a message to run the batch's end again.`)
            return 'failed'
          }
          const gate = await this.runStep(master, row, spec, { cwd: project.cwd, branch: target })
          if (!gate.ok) {
            this.fail(master, row, spec.id, `The batch's gate FAILED at ${failedAt(gate.log)} in ${fmtMs(gate.ms)}${gate.waited}; nothing was tagged.\n\n${logTail(gate.log, GATE_TEXT_TAIL)}\n\nFix it on a child branch and land it; the gate runs again once every thread is done.`)
            return 'failed'
          }
          break
        }
        case 'release': {
          const notes = this.notes(master, row).replace(/\s+/g, ' ')
          const release = await this.runStep(master, row, spec, { cwd: project.cwd, branch: target!, notes })
          if (!release.ok) {
            this.fail(master, row, spec.id, `The batch's release FAILED: ${lastLine(release.log)}\n\n${logTail(release.log, GATE_TEXT_TAIL)}`)
            return 'failed'
          }
          const tag = releaseTag(release.log)
          row.version = tag ? `1.0.${tag.slice('release-'.length)}` : null
          this.save(row)
          break
        }
        case 'publish': {
          if (!row.version) {
            skip(spec.id, 'needs a release')
            break
          }
          if (!this.deps.publish) {
            this.begin(row, spec.id, '')
            this.fail(master, row, spec.id, 'The batch asked for a publish, but this host has no peer link to a Mac.')
            return 'failed'
          }
          let mac: string
          try {
            mac = this.deps.publish.resolveMac(master.id)
          } catch (err) {
            this.begin(row, spec.id, '')
            this.fail(master, row, spec.id, `The batch's publish cannot run: ${err instanceof Error ? err.message : String(err)}`)
            return 'failed'
          }
          const sha = await this.revParse(project.cwd, target!)
          this.begin(row, spec.id, `v${row.version} on ${mac === 'this Mac' ? 'this Mac' : 'the Mac'}`)
          const phases = new PhaseTracker(PUBLISH_PHASES)
          this.progress(row, spec.id, { done: 0, total: PUBLISH_PHASES.length, label: 'pulling' })
          this.save(row)
          const run = this.deps.publish.start(master.id, { sha, branch: target!, version: row.version, notes: this.notes(master, row) }, (line) => {
            this.logLine(row, spec.id, line)
            if (phases.feed(line)) this.progress(row, spec.id, phases.progress())
          })
          this.publishing.set(master.id, run)
          let outcome: PublishRun
          try {
            outcome = await run.done
          } catch (err) {
            this.publishing.delete(master.id)
            this.fail(master, row, spec.id, `The Mac's publish (${mac}) failed: ${err instanceof Error ? err.message : String(err)}`)
            return 'failed'
          }
          this.publishing.delete(master.id)
          if (!outcome.ok) {
            this.fail(master, row, spec.id, `The Mac's publish of v${row.version} FAILED (exit ${outcome.exit ?? '?'}): ${outcome.text}`)
            return 'failed'
          }
          const version = outcome.version ?? row.version
          const took = formatDuration(this.now() - (this.step(row, spec.id).startedAt ?? this.now()))
          this.logLine(row, spec.id, `== v${version} published in ${took}${phases.summary() ? ` (${phases.summary()})` : ''}`)
          this.progress(row, spec.id, { done: PUBLISH_PHASES.length, total: PUBLISH_PHASES.length })
          this.end(row, spec.id, 'passed', `v${version} published in ${took}`)
          this.save(row)
          this.deps.announce?.(version)
          break
        }
        case 'deploy': {
          if (!specs.slice(0, i).some((s) => s.kind === 'release')) {
            skip(spec.id, 'needs a release')
            break
          }
          if (!this.deps.deploy) {
            this.begin(row, spec.id, '')
            this.fail(master, row, spec.id, 'The batch asked for a box deploy, but this host has no deploy trigger (docs/box.md "Deploy from the app").')
            return 'failed'
          }
          const publish = this.byKind(row, 'publish')
          const ref = publish && this.step(row, publish.id).status === 'passed' && row.version ? `v${row.version}` : target!
          row.deployRef = ref
          this.begin(row, spec.id, `${ref} requested`)
          this.logLine(row, spec.id, `== deploy ${ref} requested`)
          // Persisted before the trigger fires: the deploy restarts this process.
          this.save(row)
          this.flush()
          try {
            await this.deps.deploy.deploy(ref)
          } catch (err) {
            row.deployRef = null
            this.fail(master, row, spec.id, `The box deploy was refused: ${err instanceof Error ? err.message : String(err)}`)
            return 'failed'
          }
          void this.followDeploy(row, spec)
          return 'handed-off'
        }
        case 'shell': {
          const ok = await this.runShell(master, row, spec, project.cwd)
          if (!ok) {
            const step = this.step(row, spec.id)
            this.save(row)
            this.tell(master, 'failed', `The batch's step "${spec.name}" FAILED: ${step.detail}\n\n${logTail(step.log.join('\n'), GATE_TEXT_TAIL)}\n\nFix it and send a message to run the end of the batch again.`)
            return 'failed'
          }
          break
        }
      }
    }
    return 'done'
  }

  /** Follow the deploy trigger's log and exit into the step, then the
   *  steps after it and `then`. Holds the gating until it closes. */
  private async followDeploy(row: StoredBatch, spec: BatchStepSpec): Promise<void> {
    const deploy = this.deps.deploy
    const master = this.deps.registry.get(row.masterId)
    if (!deploy || !master) {
      this.gating.delete(row.masterId)
      return
    }
    this.following.get(row.masterId)?.()
    let partial = ''
    const feed = (text: string): void => {
      partial += text
      const parts = partial.split('\n')
      partial = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        this.logLine(row, spec.id, line)
        this.progress(row, spec.id, deployProgress(this.step(row, spec.id).log))
      }
    }
    const after = async (): Promise<void> => {
      const project = master.projectId ? this.deps.registry.getProject(master.projectId) : null
      if (!project) return
      const target = project.branch ?? (await this.branchOf(project.cwd))
      const i = this.specs(row).findIndex((s) => s.id === spec.id)
      const outcome = await this.runSteps(master, row, project, target, i + 1)
      if (outcome === 'done') await this.thenPhase(master, row)
    }
    const close = (status: DeployStatus): void => {
      this.following.get(row.masterId)?.()
      this.following.delete(row.masterId)
      const ref = status.target ?? row.deployRef ?? ''
      row.deployRef = null
      if (status.exit === 0) {
        const step = this.step(row, spec.id)
        const took = formatDuration(this.now() - (step.startedAt ?? this.now()))
        this.logLine(row, spec.id, `== ${ref} deployed in ${took}`)
        this.progress(row, spec.id, { done: deployProgress(step.log).total, total: deployProgress(step.log).total })
        this.end(row, spec.id, 'passed', `${ref} deployed in ${took}`.trim())
        this.save(row)
        if (/^v\d+\.\d+\.\d+$/.test(ref)) this.deps.announce?.(ref.slice(1))
        void after().finally(() => this.gating.delete(row.masterId))
      } else {
        this.end(row, spec.id, 'failed', status.exit === null ? 'the deploy did not run' : `exit ${status.exit}`)
        this.save(row)
        this.tell(master, 'failed', `The box deploy of ${status.target ?? row.deployRef ?? ''} FAILED${status.exit === null ? '' : ` (exit ${status.exit})`}: ${lastLine(this.step(row, spec.id).log.join('\n'))}`)
        this.gating.delete(row.masterId)
      }
    }
    const off = deploy.subscribe(DEPLOY_LOG_CONNECTION, (push) => {
      if (push.append) feed(push.append)
      if (push.status.phase === 'done') close(push.status as DeployStatus)
    })
    this.following.set(row.masterId, off)
    let now: DeployStatus
    try {
      now = await deploy.status()
    } catch (err) {
      // The box is out of reach right now (its deploy restarts it): the pushes close the step when it is back.
      this.logLine(row, spec.id, `== waiting for the box: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (now.phase === 'done') close(now)
    else if (now.phase === 'idle') close({ ...now, exit: null })
  }

  /** `then`: the done row and the wake, the children archived when asked. */
  private async thenPhase(master: SessionMeta, row: StoredBatch): Promise<void> {
    const children = batchChildren(this.deps.registry, row.masterId)
    row.finishedAt = this.now()
    this.save(row)
    const outcome = (s: BatchStep): string | null => {
      if (s.status !== 'passed') return null
      // Each step with its time: the detail already says it for publish, deploy and a shell step.
      const took = s.startedAt !== undefined && s.endedAt !== undefined && !/ in \d/.test(s.detail) ? ` in ${formatDuration(s.endedAt - s.startedAt)}` : ''
      const text = `${s.detail}${took}`
      return s.kind === 'gate' ? `gate ${text}` : s.kind === 'shell' ? `${s.name} ${text}` : text
    }
    const line = [this.landDetail(row, row.leftOut), ...row.steps.filter((s) => s.kind !== 'land').map(outcome)].filter(Boolean).join(' · ')
    this.deps.registry.append(master.id, { type: 'notice', kind: 'batch', message: `Batch done: ${line}` })
    if (row.rules.then === 'archive-children') {
      for (const s of children) if (this.done(s)) await this.deps.registry.setArchived?.(s.id, true)
    }
    this.tell(
      master,
      'done',
      `The batch is done: ${line}.${row.rules.then === 'archive-children' ? ` The ${children.length} done thread${children.length === 1 ? '' : 's'} are archived.` : ''} Tell the person what landed and what is left, then end your turn.`
    )
  }

  /** A wake for the master: the batch's news as an agent report (sessions.ts delivers it idle or at the next settle). */
  private tell(master: SessionMeta, status: 'done' | 'failed' | 'blocked', text: string): void {
    this.deps.registry.deliverAgentReport?.(master.id, {
      agentId: master.id,
      title: 'Batch',
      status,
      text: `<batch-report>\n${text}\n</batch-report>`
    })
  }

  // ── the tools ────────────────────────────────────────────────────────

  /** Who may call: a master thread of a project. Null when the caller is. */
  private refusal(master: SessionMeta, tool: string): string | null {
    if (!master.isMaster || master.parentId) return `refused: ${tool} is for a master thread; this thread is not pinned as one`
    const project = master.projectId ? this.deps.registry.getProject(master.projectId) : null
    if (!project) return 'refused: this thread has no project'
    return null
  }

  /** `batch_rules`: with no field, the rules as they stand; else set and answer. Never throws. */
  rulesTool(master: SessionMeta, args: Partial<BatchRules> = {}): string {
    const refused = this.refusal(master, BATCH_RULES_TOOL_NAME)
    if (refused) return refused
    const patch = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) as Partial<BatchRules>
    if (Object.keys(patch).length === 0) {
      const rules = this.rules(master.id)
      return `Rules: ${rulesLine(rules)}${rules.summary ? ` — "${rules.summary}"` : ''}.`
    }
    const parsed = BatchRulesSchema.partial().safeParse(patch)
    if (!parsed.success) return `refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    let state: BatchState
    try {
      state = this.setRules(master.id, parsed.data)
    } catch (err) {
      return `refused: ${err instanceof Error ? err.message : String(err)}`
    }
    const n = state.pending.length + state.landed.length
    return `Rules set: ${rulesLine(state.rules)}${state.rules.summary ? ` — "${state.rules.summary}"` : ''}. The app runs the steps when every thread of the batch is done${n ? ` (${n} now)` : ''}. State them to the person.`
  }

  /** The `batch_gate` tool: the gate and release steps now, with children still out left out. Never throws. */
  async gate(master: SessionMeta, args: { notes?: string; release?: boolean } = {}): Promise<string> {
    const refused = this.refusal(master, BATCH_GATE_TOOL_NAME)
    if (refused) return refused
    const project = this.deps.registry.getProject(master.projectId!)!
    const row = this.row(master.id)
    if (this.gating.has(master.id)) return "refused: the batch's gate is already running"
    if (row.landed.length === 0) return `refused: nothing has landed yet; children land through merge_branch first`
    const gateSpec = this.byKind(row, 'gate')
    if (!gateSpec) return `refused: the batch's steps name no gate; add one with ${BATCH_RULES_TOOL_NAME}`
    const releaseSpec = this.byKind(row, 'release')
    this.gating.add(master.id)
    try {
      const target = project.branch ?? (await this.branchOf(project.cwd))
      const onBranch = await this.branchOf(project.cwd)
      if (!target || onBranch !== target) {
        return `refused: the project checkout at ${project.cwd} is on ${onBranch ?? 'a detached HEAD'}, not ${target ?? 'the project branch'}`
      }
      // Children still unlanded are left out: the land step says so.
      const left = batchChildren(this.deps.registry, master.id).filter((s) => !row.landed.includes(s.id)).length
      row.leftOut = left
      this.end(row, this.landId(row), 'passed', this.landDetail(row, left))
      const gate = await this.runStep(master, row, gateSpec, { cwd: project.cwd, branch: target })
      if (!gate.ok) {
        return `FAILED at ${failedAt(gate.log)} in ${fmtMs(gate.ms)}${gate.waited}; nothing was tagged.\n\n${logTail(gate.log, GATE_TEXT_TAIL)}\n\nFix it on a child branch, land it with merge_branch, and call ${BATCH_GATE_TOOL_NAME} again.`
      }
      const passed = `passed in ${fmtMs(gate.ms)}${gate.waited}`
      if (args.release === false || !releaseSpec) {
        if (releaseSpec) this.reset(row, releaseSpec.id)
        this.save(row)
        return `${passed}. ${releaseSpec ? 'Release left for later (release: false).' : 'The batch\'s steps name no release.'}`
      }
      const notes = (args.notes?.trim() || this.notes(master, row)).replace(/\s+/g, ' ')
      const release = await this.runStep(master, row, releaseSpec, { cwd: project.cwd, branch: target, notes })
      const tag = releaseTag(release.log)
      if (!release.ok) return `${passed}, but the release FAILED: ${lastLine(release.log)}\n\n${logTail(release.log, GATE_TEXT_TAIL)}`
      row.version = tag ? `1.0.${tag.slice('release-'.length)}` : null
      this.save(row)
      return `${passed} · ${tag ? `${tag} tagged` : lastLine(release.log)}`
    } finally {
      this.gating.delete(master.id)
    }
  }

  /** A gate or release step on the queue: its detail follows the queue
   *  position, then the run's lines stream into its log with the tier's
   *  progress; its outcome lands as a gate row on the master. */
  private async runStep(
    master: SessionMeta,
    row: StoredBatch,
    spec: BatchStepSpec,
    opts: { cwd: string; branch: string; notes?: string }
  ): Promise<{ ok: boolean; log: string; ms: number; waited: string }> {
    const id = spec.id
    const kind = spec.kind as 'gate' | 'release'
    const started = this.now()
    let wait: GateWait | null = null
    this.begin(row, id, 'queued')
    this.save(row)
    let total = 0
    let done = 0
    const result = await this.queue.run(
      `${spec.name} ${master.title}`,
      () => {
        this.detail(row, id, kind === 'gate' ? 'running' : 'tagging')
        this.save(row)
        return this.runGate({
          cwd: opts.cwd,
          step: kind,
          branch: opts.branch,
          notes: opts.notes,
          push: kind === 'release',
          onLine: (line) => {
            this.logLine(row, id, line)
            const header = /gate: .*?, (\d+) steps?:/.exec(line)
            if (header) total = Number(header[1])
            const start = /› (\S+)/.exec(line)
            if (start) this.progress(row, id, { done, total: Math.max(total, done + 1), label: start[1] })
            const m = /[✓✗–] (\S+)(?: \S+)?/.exec(line)
            if (!m) return
            done++
            this.progress(row, id, { done, total: Math.max(total, done) })
            this.detail(row, id, m[0])
          }
        })
      },
      (w) => {
        wait = w
        this.detail(row, id, `queued · ${ordinal(w.position)} in line`)
        this.save(row)
      }
    )
    const waited = wait ? ` after ${fmtMs(this.now() - started - result.ms)} in the gate queue behind ${(wait as GateWait).ahead.length}` : ''
    const notice: GateNotice = { step: kind, branch: opts.branch, ok: result.ok, log: result.log, at: this.now() }
    this.deps.registry.append(master.id, { type: 'notice', kind: 'gate', message: gateLine(notice), gate: notice })
    const detail =
      kind === 'release' && result.ok
        ? `${releaseTag(result.log) ?? lastLine(result.log)} tagged`
        : result.ok
          ? `passed in ${fmtMs(result.ms)}`
          : `${kind === 'gate' ? `failed at ${failedAt(result.log)}` : 'failed'} · ${lastLine(result.log)}`
    this.end(row, id, result.ok ? 'passed' : 'failed', detail)
    this.save(row)
    return { ...result, waited }
  }

  /** A shell step on the queue: `run` through the login shell in its cwd
   *  (default the project checkout), every line into the log, exit 0
   *  passes; Stop (`stopStep`) kills its process group and fails it as
   *  "stopped". */
  private async runShell(master: SessionMeta, row: StoredBatch, spec: BatchStepSpec, projectCwd: string): Promise<boolean> {
    const id = spec.id
    const cwd = spec.cwd?.trim() || projectCwd
    const key = `${master.id}/${id}`
    const started = this.now()
    this.begin(row, id, 'queued')
    this.save(row)
    const result = await this.queue.run(
      `${spec.name} ${master.title}`,
      async () => {
        this.detail(row, id, 'running')
        this.logLine(row, id, `$ ${spec.run}`)
        this.save(row)
        const run = this.shell(spec.run ?? '', cwd, (line) => this.logLine(row, id, line))
        const handle = { stop: run.stop, stopped: false }
        this.shells.set(key, handle)
        try {
          return { ...(await run.done), stopped: handle.stopped }
        } finally {
          this.shells.delete(key)
        }
      },
      (w) => {
        this.detail(row, id, `queued · ${ordinal(w.position)} in line`)
        this.save(row)
      }
    )
    const took = fmtMs(this.now() - started)
    const ok = result.code === 0 && !result.stopped
    const last = lastLine(this.step(row, id).log.join('\n'))
    const detail = ok
      ? `passed in ${took}`
      : result.stopped
        ? `stopped after ${took}`
        : `exit ${result.code ?? result.signal ?? '?'} after ${took}${last && !last.startsWith('$ ') ? ` · ${last}` : ''}`
    this.logLine(row, id, `== ${spec.name} ${detail}`)
    this.end(row, id, ok ? 'passed' : 'failed', detail)
    this.save(row)
    return ok
  }

  /** The release's notes: the master's title, then the landed children's subjects. */
  notes(master: SessionMeta, row: StoredBatch): string {
    const subjects = row.landed.flatMap((id) => row.subjects[id] ?? [])
    return [master.title.trim(), ...subjects].filter(Boolean).join('; ')
  }

  dispose(): void {
    this.detach?.()
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    for (const off of this.following.values()) off()
    this.following.clear()
  }
}

/** The telemetry for a steps list: what a step with the same id and kind
 *  had, else pending; in the list's order, with the list's names. */
function reconcileSteps(had: readonly BatchStep[], specs: readonly BatchStepSpec[]): BatchStep[] {
  return specs.map((spec) => {
    const old = had.find((s) => s.id === spec.id && s.kind === spec.kind)
    return old ? { ...old, name: spec.name } : emptyStep(spec)
  })
}

/** A row from the fixed-five days: its booleans as a list. */
function legacySteps(rules: Record<string, unknown>): BatchStepSpec[] {
  const steps: BatchStepSpec[] = [DEFAULT_BATCH_STEPS[0]]
  if (rules.gate !== false) steps.push(DEFAULT_BATCH_STEPS[1])
  if (rules.release !== false) steps.push(DEFAULT_BATCH_STEPS[2])
  if (rules.publish === true) steps.push({ id: 'publish', name: 'Publish', kind: 'publish' })
  if (rules.deploy === 'box') steps.push({ id: 'deploy', name: 'Deploy', kind: 'deploy' })
  return steps
}

function parseRow(raw: string | null | undefined): StoredBatch | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Omit<Partial<StoredBatch>, 'rules'> & { rules?: Record<string, unknown> }
    if (!v || typeof v.masterId !== 'string' || !Array.isArray(v.steps)) return null
    const given: Record<string, unknown> = v.rules ?? {}
    const parsed = BatchRulesSchema.safeParse({
      ...DEFAULT_BATCH_RULES,
      ...given,
      steps: Array.isArray(given.steps) ? given.steps : legacySteps(given)
    })
    const rules = parsed.success && !stepsProblem(parsed.data.steps) ? parsed.data : { ...DEFAULT_BATCH_RULES }
    const specs = withLandStep(rules.steps)
    const steps = specs.map((spec) => {
      const s = v.steps!.find((x) => x.id === spec.id) as (Partial<BatchStep> & { status?: string }) | undefined
      if (!s) return emptyStep(spec)
      // A row from before the telemetry: `done` was the passed state.
      const status = ((s.status as string) === 'done' ? 'passed' : s.status) as BatchStep['status']
      return { ...emptyStep(spec), ...s, id: spec.id, name: spec.name, kind: spec.kind, status, log: Array.isArray(s.log) ? s.log : [] }
    })
    return {
      masterId: v.masterId,
      rules,
      steps,
      landed: v.landed ?? [],
      held: v.held ?? [],
      blocked: v.blocked ?? null,
      finishedAt: v.finishedAt ?? null,
      armed: v.armed ?? true,
      branches: v.branches ?? {},
      subjects: v.subjects ?? {},
      holds: v.holds ?? {},
      version: v.version ?? null,
      deployRef: v.deployRef ?? null,
      leftOut: v.leftOut ?? 0
    }
  } catch {
    return null
  }
}

function lastLine(log: string): string {
  return log.split('\n').filter((l) => l.trim()).at(-1)?.trim() ?? ''
}

/** The failed step from the gate's own `✗ vitest 40s failed` line, else "the gate". */
function failedAt(log: string): string {
  for (const line of log.split('\n').reverse()) {
    const m = /✗ (\S+)/.exec(line)
    if (m) return m[1]
  }
  return 'the gate'
}

/** release.ts's last line names the tag: "released v277 (tag release-277, …)". */
export function releaseTag(log: string): string | null {
  return /tag (release-\d+)/.exec(log)?.[1] ?? null
}

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? 'th'
  return `${n}${s}`
}

export async function handleBatch(
  req: ClientRequest,
  batches: Pick<Batches, 'get' | 'setRules' | 'stopStep' | 'adopt' | 'archive'>,
  registry: Pick<SessionRegistry, 'list'>
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (req.method) {
    case 'batch.get':
      return { handled: true, result: batches.get(req.params.masterId) }
    case 'batch.children':
      return { handled: true, result: { children: batchChildren(registry, req.params.masterId) } }
    case 'batch.setRules':
      return { handled: true, result: batches.setRules(req.params.masterId, req.params.rules) }
    case 'batch.stopStep':
      return { handled: true, result: await batches.stopStep(req.params.masterId, req.params.stepId) }
    case 'batch.adopt':
      return { handled: true, result: batches.adopt(req.params.masterId, req.params.sessionIds) }
    case 'batch.archive':
      return { handled: true, result: await batches.archive(req.params.masterId, req.params.which, req.params.removeResources ?? false) }
    default:
      return { handled: false }
  }
}

/** Set by server/index.ts at boot; the app tools read it. */
let current: Batches | null = null
export function setBatches(b: Batches | null): void {
  current = b
}
export function batches(): Batches | null {
  return current
}
