import type { ClientRequest } from '@shared/contract'
import {
  BATCH_STEP_LOG_LINES,
  BatchRulesSchema,
  BatchStepIdSchema,
  DEFAULT_BATCH_RULES,
  emptyBatch,
  emptyStep,
  rulesLine,
  type BatchRules,
  type BatchState,
  type BatchStep,
  type BatchStepId
} from '@shared/contract-batch'
import type { DeployStatus, HostLogPush } from '@shared/contract-host'
import type { SessionMeta } from '@shared/events'
import { gateLine, type GateNotice } from '@shared/gate'
import { BATCH_GATE_TOOL_NAME, BATCH_RULES_TOOL_NAME, GATE_TEXT_TAIL, logTail } from '@shared/gate'
import { gateQueue, type GateQueue, type GateWait } from './gateQueue'
import { runGateStep } from './gateRun'
import { branchOf, fastForwardMerge, revParse, type MergeResult } from './mergeBranch'
import type { Landed } from './mergeReview'
import type { SessionRegistry } from './sessions'

/**
 * A master thread's batch (contract-batch.ts): the steps its children
 * never run themselves, run by the app under the rules the master set.
 *
 * The rules (`batch_rules` from the master, `batch.setRules` from a person):
 * `land` as-they-finish (merge_branch fast-forwards each child's branch as
 * it lands) or all-at-once (merge_branch answers HELD and records the
 * branch; the engine merges them in landing order at the end); `gate` (the
 * commit tier once on the project checkout at the project branch's head);
 * `release` (`bun scripts/release.ts "<notes>" --push` after a green gate:
 * the tag, and master with it pushed to origin); `publish` (the Mac's
 * publish job for that commit over the peer link, remote/peerPublish.ts);
 * `deploy` none or box (the box's deploy trigger, docs/box.md "Deploy from
 * the app": v1.0.N when published, master otherwise); `then` notify (a
 * notice row on the master and a wake) or archive-children (the same, and
 * every done child archived).
 *
 * The engine runs when the last child is done: every unarchived root
 * carrying the masterId is `done`, or `idle` after at least one turn. A
 * child that errored or stopped blocks the end, `blocked` names it and the
 * master is told once. Steps run in order on the host's gate queue, each
 * with its own log, progress and times on the wire (the board's foot draws
 * a console per running step); a red step stops the rest and the master is
 * told; the engine arms again when a child changes or a new one appears.
 * `batch_gate` is the master's way to run the gate and the release early,
 * with children still out (left out of the land step).
 *
 * The deploy restarts this very process on the box, so the row is
 * persisted before the trigger fires and `resumeAfterBoot` reads the
 * trigger's files to close the step and run `then`. State lives in one
 * settings row per master (`batch:<masterId>`); `pending` is computed
 * from the sessions table on every read. Every change is pushed as `batch`
 * (contract.ts), coalesced to at most four pushes a second while a step's
 * log streams. `open(masterId)` is what keeps the master `watching`
 * (sessions.ts): children exist and the engine has not finished with them.
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

/** What the engine needs of remote/peerPublish.ts: the box's side of the Mac's publish job. */
export interface PublishLike {
  resolveMac(sessionId: string): string
  start(
    sessionId: string,
    args: { sha: string; branch: string; version: string; notes: string },
    onLine: (line: string) => void
  ): { done: Promise<PublishRun>; stop: () => Promise<void> }
}

/** What the engine needs of hostJobs.ts's DeployTrigger. */
export interface DeployLike {
  deploy(ref: string): Promise<unknown>
  status(): DeployStatus
  subscribe(connection: number, send: (push: HostLogPush) => void): () => void
}

export interface BatchesDeps {
  registry: Pick<SessionRegistry, 'list' | 'get' | 'getProject' | 'append'> & {
    hasUserText?(sessionId: string): boolean
    setArchived?(sessionId: string, archived: boolean): Promise<void>
    deliverAgentReport?(sessionId: string, report: { text: string; agentId: string; title: string; status: string }): void
    onMeta?(listener: (session: SessionMeta) => void): () => void
    onRemoved?(listener: (sessionIds: string[]) => void): () => void
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

export class Batches {
  private readonly rows = new Map<string, StoredBatch>()
  private readonly listeners = new Set<(state: BatchState) => void>()
  private readonly runGate: typeof runGateStep
  private readonly queue: GateQueue
  private readonly branchOf: typeof branchOf
  private readonly revParse: typeof revParse
  private readonly merge: typeof fastForwardMerge
  private readonly now: () => number
  private readonly pushEveryMs: number
  /** one batch_gate or engine run at a time per master */
  private readonly gating = new Set<string>()
  /** masters whose review is queued behind the current microtask */
  private readonly dirty = new Set<string>()
  /** the blocked reports already delivered: `<child>:<why>` */
  private readonly toldBlocked = new Set<string>()
  /** the publish in flight per master, for Stop */
  private readonly publishing = new Map<string, { stop: () => Promise<void> }>()
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
   *  trigger's files, or followed on, and `then` runs; a publish in flight
   *  is lost with the process and its step says so. */
  async resumeAfterBoot(): Promise<void> {
    for (const row of this.rows.values()) {
      const publish = this.step(row, 'publish')
      if (publish.status === 'running') {
        this.end(row, 'publish', 'failed', 'the host restarted during the publish; its outcome is on the Mac')
        this.save(row)
        const master = this.deps.registry.get(row.masterId)
        if (master) this.tell(master, 'failed', `The batch's publish was running on the Mac when this host restarted; check the Mac's publish log, then send a message to run the end of the batch again.`)
        continue
      }
      const deploy = this.step(row, 'deploy')
      if (deploy.status !== 'running' || !row.deployRef) continue
      this.gating.add(row.masterId)
      this.logLine(row, 'deploy', `== host restarted; following the deploy of ${row.deployRef}`)
      void this.followDeploy(row)
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
      rules: { ...row.rules },
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
    return { ...this.row(masterId).rules }
  }

  /** Set some or all of the rules (the `batch_rules` tool, `batch.setRules`). */
  setRules(masterId: string, patch: Partial<BatchRules>): BatchState {
    const row = this.row(masterId)
    const next = BatchRulesSchema.parse({ ...row.rules, ...patch })
    if (next.summary !== undefined && !next.summary.trim()) delete next.summary
    row.rules = next
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

  /** Stop the running step that can be stopped: the Mac's publish job. */
  async stopStep(masterId: string): Promise<{ stopped: boolean }> {
    const run = this.publishing.get(masterId)
    if (!run) return { stopped: false }
    await run.stop()
    return { stopped: true }
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

  private step(row: StoredBatch, id: BatchStepId): BatchStep {
    let step = row.steps.find((s) => s.id === id)
    if (!step) {
      step = emptyStep(id)
      row.steps.push(step)
      row.steps.sort((a, b) => BatchStepIdSchema.options.indexOf(a.id) - BatchStepIdSchema.options.indexOf(b.id))
    }
    return step
  }

  /** A step starts: its log and progress start afresh. */
  private begin(row: StoredBatch, id: BatchStepId, detail: string): void {
    const step = this.step(row, id)
    step.status = 'running'
    step.detail = detail
    step.at = this.now()
    step.startedAt = this.now()
    delete step.endedAt
    delete step.progress
    step.log = []
  }

  private end(row: StoredBatch, id: BatchStepId, status: 'passed' | 'failed' | 'skipped', detail: string): void {
    const step = this.step(row, id)
    step.status = status
    step.detail = detail
    step.at = this.now()
    step.endedAt = this.now()
  }

  private detail(row: StoredBatch, id: BatchStepId, detail: string): void {
    const step = this.step(row, id)
    step.detail = detail
    step.at = this.now()
  }

  private reset(row: StoredBatch, id: BatchStepId): void {
    const i = row.steps.findIndex((s) => s.id === id)
    if (i >= 0) row.steps[i] = emptyStep(id)
  }

  private logLine(row: StoredBatch, id: BatchStepId, line: string): void {
    const step = this.step(row, id)
    step.log.push(line)
    if (step.log.length > BATCH_STEP_LOG_LINES) step.log.splice(0, step.log.length - BATCH_STEP_LOG_LINES)
    this.touch(row)
  }

  private progress(row: StoredBatch, id: BatchStepId, p: NonNullable<BatchStep['progress']>): void {
    this.step(row, id).progress = p
    this.touch(row)
  }

  private landDetail(row: StoredBatch, leftOut = 0): string {
    const total = batchChildren(this.deps.registry, row.masterId).length
    const n = row.landed.length
    return `${n} of ${Math.max(total, n)} landed${leftOut ? ` · ${leftOut} left out` : ''}`
  }

  // ── land ─────────────────────────────────────────────────────────────

  /** merge_branch landed a child's branch (mergeReview.ts onLanded). */
  landed(l: Landed): void {
    const masterId = l.session.masterId
    if (!masterId) return
    const row = this.row(masterId)
    this.record(row, l.session.id, l.branch, l.subjects)
    this.save(row)
    this.schedule(masterId)
  }

  private record(row: StoredBatch, sessionId: string, branch: string, subjects: string[]): void {
    const masterId = row.masterId
    // A landing after the end: a new cycle. After a red step, or a late
    // child after the gate ran: the steps after land have to run again.
    if (row.finishedAt) {
      Object.assign(row, freshRow(masterId, row.rules))
    } else if (this.step(row, 'gate').status !== 'pending' && !this.gating.has(masterId)) {
      for (const id of ['gate', 'release', 'publish', 'deploy'] as const) this.reset(row, id)
      row.version = null
    }
    if (!row.landed.includes(sessionId)) row.landed.push(sessionId)
    row.held = row.held.filter((id) => id !== sessionId)
    delete row.holds[sessionId]
    row.branches[sessionId] = branch
    row.subjects[sessionId] = subjects
    row.armed = true
    const children = batchChildren(this.deps.registry, masterId)
    const step = this.step(row, 'land')
    if (step.status !== 'running') this.begin(row, 'land', '')
    this.logLine(row, 'land', `${branch} landed`)
    this.progress(row, 'land', { done: row.landed.length, total: Math.max(children.length, row.landed.length) })
    this.detail(row, 'land', this.landDetail(row))
  }

  /** merge_branch asks before a batch child's fast-forward: under
   *  all-at-once the landing is recorded and held, and the answer is the
   *  text the child reads; under as-they-finish, null (merge now). */
  hold(session: SessionMeta, landing: Omit<HeldLanding, 'sessionId'>): string | null {
    if (!session.masterId) return null
    const row = this.row(session.masterId)
    if (row.rules.land !== 'all-at-once') return null
    if (!row.held.includes(session.id)) row.held.push(session.id)
    row.holds[session.id] = { sessionId: session.id, ...landing }
    row.armed = true
    if (this.step(row, 'land').status !== 'running') this.begin(row, 'land', '')
    this.logLine(row, 'land', `${landing.branch} held for the end`)
    this.detail(row, 'land', `${row.held.length} held for the end${row.landed.length ? ` · ${row.landed.length} landed` : ''}`)
    this.save(row)
    this.schedule(session.masterId)
    return `HELD: the batch lands all at once; the master will merge ${landing.branch} when every thread is done. Your work is recorded; you are done with it.`
  }

  // ── the end of the batch ─────────────────────────────────────────────

  private done(s: SessionMeta): boolean {
    if (DONE.has(s.status)) return true
    return s.status === 'idle' && (this.deps.registry.hasUserText?.(s.id) ?? true)
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
    if (!master || master.archived) return
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
    if (children.length === 0 || !row.armed || this.gating.has(masterId)) return
    if (!this.allDone(children)) return
    await this.finish(master, row, children)
  }

  /** The steps the rules name, in order; a red one stops the rest. */
  private async finish(master: SessionMeta, row: StoredBatch, children: SessionMeta[]): Promise<void> {
    const project = master.projectId ? this.deps.registry.getProject(master.projectId) : null
    if (!project) return
    row.armed = false
    this.gating.add(master.id)
    let handedOff = false
    try {
      const target = project.branch ?? (await this.branchOf(project.cwd))
      const fail = (step: BatchStepId, text: string): void => {
        this.end(row, step, 'failed', text.split('\n')[0].slice(0, 160))
        this.save(row)
        this.tell(master, 'failed', text)
      }
      // land: merge what was held, in landing order.
      if (this.step(row, 'land').status !== 'running') this.begin(row, 'land', this.landDetail(row))
      const toMerge = [...row.held]
      for (const [i, id] of toMerge.entries()) {
        const h = row.holds[id]
        if (!h) continue
        this.progress(row, 'land', { done: i, total: toMerge.length, label: h.branch })
        let result: MergeResult
        try {
          result = await this.merge(h.cwd, h.branch, h.target, h.push)
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          this.logLine(row, 'land', `✗ ${h.branch}: ${why}`)
          return fail('land', `The batch's merge of ${h.branch} failed: ${why}. Rebase it on a child and call merge_branch there again; the batch finishes once every thread is done.`)
        }
        this.record(row, id, h.branch, h.subjects)
        this.deps.registry.append(id, { type: 'notice', kind: 'batch', message: `Merged by the batch: ${h.branch} → ${h.target} at ${result.sha.slice(0, 10)}${result.pushed ? ', pushed' : ''}` })
        this.save(row)
      }
      row.leftOut = children.filter((s) => !row.landed.includes(s.id)).length
      this.progress(row, 'land', { done: row.landed.length, total: Math.max(children.length, row.landed.length) })
      this.end(row, 'land', 'passed', this.landDetail(row, row.leftOut))
      this.save(row)
      const nothing = row.landed.length === 0
      const skip = (step: BatchStepId, why: string): void => {
        this.end(row, step, 'skipped', why)
        this.save(row)
      }
      // gate
      if (!row.rules.gate || nothing) {
        skip('gate', nothing ? 'nothing landed' : 'off by the rules')
      } else {
        if (!target || (await this.branchOf(project.cwd)) !== target) {
          this.begin(row, 'gate', '')
          return fail('gate', `The project checkout at ${project.cwd} is not on ${target ?? 'the project branch'}; check it out there and send a message to run the batch's end again.`)
        }
        const gate = await this.runStep(master, row, 'gate', { cwd: project.cwd, branch: target })
        if (!gate.ok) {
          return fail('gate', `The batch's gate FAILED at ${failedAt(gate.log)} in ${fmtMs(gate.ms)}${gate.waited}; nothing was tagged.\n\n${logTail(gate.log, GATE_TEXT_TAIL)}\n\nFix it on a child branch and land it; the gate runs again once every thread is done.`)
        }
      }
      // release
      if (!row.rules.release || nothing) {
        skip('release', nothing ? 'nothing landed' : 'off by the rules')
      } else {
        const notes = this.notes(master, row).replace(/\s+/g, ' ')
        const release = await this.runStep(master, row, 'release', { cwd: project.cwd, branch: target!, notes })
        if (!release.ok) return fail('release', `The batch's release FAILED: ${lastLine(release.log)}\n\n${logTail(release.log, GATE_TEXT_TAIL)}`)
        const tag = releaseTag(release.log)
        row.version = tag ? `1.0.${tag.slice('release-'.length)}` : null
        this.save(row)
      }
      // publish: the Mac's job for the released commit
      if (!row.rules.publish) {
        skip('publish', 'off by the rules')
      } else if (!row.version) {
        skip('publish', nothing ? 'nothing landed' : 'needs a release')
      } else if (!this.deps.publish) {
        this.begin(row, 'publish', '')
        return fail('publish', 'The batch asked for a publish, but this host has no peer link to a Mac.')
      } else {
        let mac: string
        try {
          mac = this.deps.publish.resolveMac(master.id)
        } catch (err) {
          this.begin(row, 'publish', '')
          return fail('publish', `The batch's publish cannot run: ${err instanceof Error ? err.message : String(err)}`)
        }
        const sha = await this.revParse(project.cwd, target!)
        this.begin(row, 'publish', `v${row.version} on the Mac`)
        this.progress(row, 'publish', { done: 0, total: 1, label: 'pulling' })
        this.save(row)
        const run = this.deps.publish.start(master.id, { sha, branch: target!, version: row.version, notes: this.notes(master, row) }, (line) => {
          this.logLine(row, 'publish', line)
          const stage = publishStage(line)
          if (stage) this.progress(row, 'publish', { done: 0, total: 1, label: stage })
        })
        this.publishing.set(master.id, run)
        let outcome: PublishRun
        try {
          outcome = await run.done
        } catch (err) {
          this.publishing.delete(master.id)
          return fail('publish', `The Mac's publish (${mac}) failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        this.publishing.delete(master.id)
        if (!outcome.ok) return fail('publish', `The Mac's publish of v${row.version} FAILED (exit ${outcome.exit ?? '?'}): ${outcome.text}`)
        this.progress(row, 'publish', { done: 1, total: 1 })
        this.end(row, 'publish', 'passed', `v${row.version} published`)
        this.save(row)
      }
      // deploy: the box's trigger; the process may not survive it.
      if (row.rules.deploy !== 'box') {
        skip('deploy', 'off by the rules')
      } else if (nothing || !row.rules.release) {
        skip('deploy', nothing ? 'nothing landed' : 'needs a release')
      } else if (!this.deps.deploy) {
        this.begin(row, 'deploy', '')
        return fail('deploy', 'The batch asked for a box deploy, but this host has no deploy trigger (docs/box.md "Deploy from the app").')
      } else {
        const ref = this.step(row, 'publish').status === 'passed' && row.version ? `v${row.version}` : target!
        row.deployRef = ref
        this.begin(row, 'deploy', `${ref} requested`)
        this.logLine(row, 'deploy', `== deploy ${ref} requested`)
        // Persisted before the trigger fires: the deploy restarts this process.
        this.save(row)
        this.flush()
        try {
          await this.deps.deploy.deploy(ref)
        } catch (err) {
          row.deployRef = null
          return fail('deploy', `The box deploy was refused: ${err instanceof Error ? err.message : String(err)}`)
        }
        handedOff = true
        void this.followDeploy(row)
        return
      }
      await this.thenPhase(master, row)
    } finally {
      if (!handedOff) this.gating.delete(master.id)
    }
  }

  /** Follow the deploy trigger's log and exit into the step, then `then`. Holds the gating until it closes. */
  private async followDeploy(row: StoredBatch): Promise<void> {
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
        this.logLine(row, 'deploy', line)
        const stage = deployStage(line)
        if (stage) this.progress(row, 'deploy', { done: 0, total: 1, label: stage })
      }
    }
    const close = (status: DeployStatus): void => {
      this.following.get(row.masterId)?.()
      this.following.delete(row.masterId)
      row.deployRef = null
      if (status.exit === 0) {
        this.progress(row, 'deploy', { done: 1, total: 1 })
        this.end(row, 'deploy', 'passed', `${status.target ?? ''} deployed`.trim())
        this.save(row)
        void this.thenPhase(master, row).finally(() => this.gating.delete(row.masterId))
      } else {
        this.end(row, 'deploy', 'failed', status.exit === null ? 'the deploy did not run' : `exit ${status.exit}`)
        this.save(row)
        this.tell(master, 'failed', `The box deploy of ${status.target ?? row.deployRef ?? ''} FAILED${status.exit === null ? '' : ` (exit ${status.exit})`}: ${lastLine(this.step(row, 'deploy').log.join('\n'))}`)
        this.gating.delete(row.masterId)
      }
    }
    const off = deploy.subscribe(DEPLOY_LOG_CONNECTION, (push) => {
      if (push.append) feed(push.append)
      if (push.status.phase === 'done') close(push.status as DeployStatus)
    })
    this.following.set(row.masterId, off)
    const now = deploy.status()
    if (now.phase === 'done') close(now)
    else if (now.phase === 'idle') close({ ...now, exit: null })
  }

  /** `then`: the done row and the wake, the children archived when asked. */
  private async thenPhase(master: SessionMeta, row: StoredBatch): Promise<void> {
    const children = batchChildren(this.deps.registry, row.masterId)
    row.finishedAt = this.now()
    this.save(row)
    const outcome = (id: BatchStepId): string | null => {
      const s = this.step(row, id)
      return s.status === 'passed' ? s.detail : null
    }
    const line = [this.landDetail(row, row.leftOut), outcome('gate') && `gate ${outcome('gate')}`, outcome('release'), outcome('publish'), outcome('deploy')]
      .filter(Boolean)
      .join(' · ')
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

  /** Who may call: the project's master. Null when the caller is. */
  private refusal(master: SessionMeta, tool: string): string | null {
    const project = master.projectId ? this.deps.registry.getProject(master.projectId) : null
    if (!project) return 'refused: this thread has no project'
    if (project.masterThreadId !== master.id) return `refused: ${tool} is for the project's master thread; this thread is not pinned as one`
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
    const state = this.setRules(master.id, parsed.data)
    const n = state.pending.length + state.landed.length
    return `Rules set: ${rulesLine(state.rules)}${state.rules.summary ? ` — "${state.rules.summary}"` : ''}. The app runs them when every thread of the batch is done${n ? ` (${n} now)` : ''}. State them to the person.`
  }

  /** The `batch_gate` tool: the gate and the release now, with children still out left out. Never throws. */
  async gate(master: SessionMeta, args: { notes?: string; release?: boolean } = {}): Promise<string> {
    const refused = this.refusal(master, BATCH_GATE_TOOL_NAME)
    if (refused) return refused
    const project = this.deps.registry.getProject(master.projectId!)!
    const row = this.row(master.id)
    if (this.gating.has(master.id)) return "refused: the batch's gate is already running"
    if (row.landed.length === 0) return `refused: nothing has landed yet; children land through merge_branch first`
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
      this.end(row, 'land', 'passed', this.landDetail(row, left))
      const gate = await this.runStep(master, row, 'gate', { cwd: project.cwd, branch: target })
      if (!gate.ok) {
        return `FAILED at ${failedAt(gate.log)} in ${fmtMs(gate.ms)}${gate.waited}; nothing was tagged.\n\n${logTail(gate.log, GATE_TEXT_TAIL)}\n\nFix it on a child branch, land it with merge_branch, and call ${BATCH_GATE_TOOL_NAME} again.`
      }
      const passed = `passed in ${fmtMs(gate.ms)}${gate.waited}`
      if (args.release === false) {
        this.reset(row, 'release')
        this.save(row)
        return `${passed}. Release left for later (release: false).`
      }
      const notes = (args.notes?.trim() || this.notes(master, row)).replace(/\s+/g, ' ')
      const release = await this.runStep(master, row, 'release', { cwd: project.cwd, branch: target, notes })
      const tag = releaseTag(release.log)
      if (!release.ok) return `${passed}, but the release FAILED: ${lastLine(release.log)}\n\n${logTail(release.log, GATE_TEXT_TAIL)}`
      row.version = tag ? `1.0.${tag.slice('release-'.length)}` : null
      this.save(row)
      return `${passed} · ${tag ? `${tag} tagged` : lastLine(release.log)}`
    } finally {
      this.gating.delete(master.id)
    }
  }

  /** One step on the queue: its detail follows the queue position, then
   *  the run's lines stream into its log with the tier's progress; its
   *  outcome lands as a gate row on the master. */
  private async runStep(
    master: SessionMeta,
    row: StoredBatch,
    id: 'gate' | 'release',
    opts: { cwd: string; branch: string; notes?: string }
  ): Promise<{ ok: boolean; log: string; ms: number; waited: string }> {
    const started = this.now()
    let wait: GateWait | null = null
    this.begin(row, id, 'queued')
    this.save(row)
    let total = 0
    let done = 0
    const result = await this.queue.run(
      `${id} ${master.title}`,
      () => {
        this.detail(row, id, id === 'gate' ? 'running' : 'tagging')
        this.save(row)
        return this.runGate({
          cwd: opts.cwd,
          step: id,
          branch: opts.branch,
          notes: opts.notes,
          push: id === 'release',
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
    const notice: GateNotice = { step: id, branch: opts.branch, ok: result.ok, log: result.log, at: this.now() }
    this.deps.registry.append(master.id, { type: 'notice', kind: 'gate', message: gateLine(notice), gate: notice })
    const detail =
      id === 'release' && result.ok
        ? `${releaseTag(result.log) ?? lastLine(result.log)} tagged`
        : result.ok
          ? `passed in ${fmtMs(result.ms)}`
          : `${id === 'gate' ? `failed at ${failedAt(result.log)}` : 'failed'} · ${lastLine(result.log)}`
    this.end(row, id, result.ok ? 'passed' : 'failed', detail)
    this.save(row)
    return { ...result, waited }
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

function parseRow(raw: string | null | undefined): StoredBatch | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<StoredBatch>
    if (!v || typeof v.masterId !== 'string' || !Array.isArray(v.steps)) return null
    const parsed = BatchRulesSchema.safeParse({ ...DEFAULT_BATCH_RULES, ...(v.rules ?? {}) })
    const rules = parsed.success ? parsed.data : { ...DEFAULT_BATCH_RULES }
    const steps = BatchStepIdSchema.options.map((id) => {
      const s = v.steps!.find((x) => x.id === id) as (Partial<BatchStep> & { status?: string }) | undefined
      if (!s) return emptyStep(id)
      // A row from before the telemetry: `done` was the passed state.
      const status = ((s.status as string) === 'done' ? 'passed' : s.status) as BatchStep['status']
      return { ...emptyStep(id), ...s, status, log: Array.isArray(s.log) ? s.log : [] }
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

/** The stage a box-update or deploy-runner line names ("== stage 40: build", "[deploy] trial"), for the progress label. */
export function deployStage(line: string): string | null {
  const m = /^(?:==|\[deploy\]|\[box-update\])\s*(.+)$/.exec(line.trim())
  return m ? m[1].trim().slice(0, 80) : null
}

/** The stage a release-publish.sh line names ("== notarizing", "== uploading"). */
export function publishStage(line: string): string | null {
  const m = /^(?:==|›)\s*(.+)$/.exec(line.trim())
  return m ? m[1].trim().slice(0, 80) : null
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
  batches: Pick<Batches, 'get' | 'setRules' | 'stopStep'>,
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
      return { handled: true, result: await batches.stopStep(req.params.masterId) }
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
