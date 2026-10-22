import type { ClientRequest } from '@shared/contract'
import {
  BatchRulesSchema,
  DEFAULT_BATCH_RULES,
  emptyBatch,
  rulesLine,
  stepsFor,
  type BatchRules,
  type BatchState,
  type BatchStep,
  type BatchStepId
} from '@shared/contract-batch'
import type { SessionMeta } from '@shared/events'
import { gateLine, type GateNotice } from '@shared/gate'
import { BATCH_GATE_TOOL_NAME, BATCH_RULES_TOOL_NAME, GATE_TEXT_TAIL, logTail } from '@shared/gate'
import { gateQueue, type GateQueue, type GateWait } from './gateQueue'
import { runGateStep } from './gateRun'
import { branchOf, fastForwardMerge, hasOrigin, type MergeResult } from './mergeBranch'
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
 * `release` (`bun scripts/release.ts "<notes>"` after a green gate, pushed);
 * `deploy` none or box (the box's deploy trigger, docs/box.md "Deploy from
 * the app"); `then` notify (a notice row on the master and a wake) or
 * archive-children (the same, and every done child archived).
 *
 * The engine runs when the last child is done: every unarchived root
 * carrying the masterId is `done`, or `idle` after at least one turn. A
 * child that errored or stopped blocks the end, `blocked` names it and the
 * master is told once. Steps run in order on the host's gate queue, each
 * outcome a `gate` notice row on the master; a red step stops the rest and
 * the master is told; the engine arms again when a child changes or a new
 * one appears. `batch_gate` is the master's way to run the gate and the
 * release early, with children still out (left out of the land step).
 *
 * State lives in one settings row per master (`batch:<masterId>`) so a
 * restart keeps it; `pending` is computed from the sessions table on every
 * read. Every change is pushed as `batch` (contract.ts) so a board follows
 * without polling. `open(masterId)` is what keeps the master `watching`
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

/** What the row keeps beyond the wire shape: each landed child's branch and subjects (the notes), the held landings. */
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
}

const freshRow = (masterId: string, rules: BatchRules = DEFAULT_BATCH_RULES): StoredBatch => ({
  ...emptyBatch(masterId, [], rules),
  armed: true,
  branches: {},
  subjects: {},
  holds: {}
})

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
  /** the fast-forward of a held branch at the end (mergeBranch.ts) */
  merge?: typeof fastForwardMerge
  hasOrigin?: typeof hasOrigin
  /** the box's deploy trigger (hostJobs.ts `host.deploy`); absent where there is none */
  deploy?: (ref: string) => Promise<unknown>
  now?: () => number
}

const ROW_PREFIX = 'batch:'
const DONE = new Set<SessionMeta['status']>(['done'])
const BLOCKS: Partial<Record<SessionMeta['status'], 'errored' | 'stopped'>> = { error: 'errored', stopped: 'stopped' }

export class Batches {
  private readonly rows = new Map<string, StoredBatch>()
  private readonly listeners = new Set<(state: BatchState) => void>()
  private readonly runGate: typeof runGateStep
  private readonly queue: GateQueue
  private readonly branchOf: typeof branchOf
  private readonly merge: typeof fastForwardMerge
  private readonly hasOrigin: typeof hasOrigin
  private readonly now: () => number
  /** one batch_gate or engine run at a time per master */
  private readonly gating = new Set<string>()
  /** masters whose review is queued behind the current microtask */
  private readonly dirty = new Set<string>()
  /** the blocked reports already delivered: `<child>:<why>` */
  private readonly toldBlocked = new Set<string>()
  private detach: (() => void) | null = null

  constructor(private readonly deps: BatchesDeps) {
    this.runGate = deps.runGate ?? runGateStep
    this.queue = deps.queue ?? gateQueue()
    this.branchOf = deps.branchOf ?? branchOf
    this.merge = deps.merge ?? fastForwardMerge
    this.hasOrigin = deps.hasOrigin ?? hasOrigin
    this.now = deps.now ?? Date.now
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

  // ── reads ────────────────────────────────────────────────────────────

  /** The live state: the persisted steps and landings, the pending children from the sessions table. */
  get(masterId: string): BatchState {
    const row = this.row(masterId)
    const children = batchChildren(this.deps.registry, masterId).map((s) => s.id)
    const known = (id: string): boolean => children.includes(id) || !!this.deps.registry.get(id)
    return {
      masterId,
      rules: { ...row.rules },
      steps: row.steps.map((s) => ({ ...s })),
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

  /** Set some or all of the rules (the `batch_rules` tool, `batch.setRules`); the step list follows `deploy`. */
  setRules(masterId: string, patch: Partial<BatchRules>): BatchState {
    const row = this.row(masterId)
    const next = BatchRulesSchema.parse({ ...row.rules, ...patch })
    if (next.summary !== undefined && !next.summary.trim()) delete next.summary
    row.rules = next
    row.steps = stepsFor(next).map((id) => this.step(row, id) ?? { id, status: 'pending', detail: '', at: null })
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
    return !this.allDone(children) || row.armed
  }

  private row(masterId: string): StoredBatch {
    let row = this.rows.get(masterId)
    if (!row) {
      row = parseRow(this.deps.store.getSetting(`${ROW_PREFIX}${masterId}`)) ?? freshRow(masterId)
      this.rows.set(masterId, row)
    }
    return row
  }

  private save(row: StoredBatch): void {
    this.rows.set(row.masterId, row)
    this.deps.store.setSetting(`${ROW_PREFIX}${row.masterId}`, JSON.stringify(row))
    const state = this.get(row.masterId)
    for (const l of this.listeners) l(state)
  }

  private step(row: StoredBatch, id: BatchStepId): BatchStep | undefined {
    return row.steps.find((s) => s.id === id)
  }

  private set(row: StoredBatch, id: BatchStepId, status: BatchStep['status'], detail: string): void {
    let step = this.step(row, id)
    if (!step) {
      step = { id, status, detail, at: null }
      row.steps.push(step)
    }
    step.status = status
    step.detail = detail
    step.at = this.now()
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
    // A landing after the release: a new cycle. After a red gate, or a
    // late child after the gate ran: the gate has to run again.
    if (this.step(row, 'release')?.status === 'done' || row.finishedAt) {
      Object.assign(row, freshRow(masterId, row.rules))
    } else if (this.step(row, 'gate')?.status !== 'pending' && !this.gating.has(masterId)) {
      this.set(row, 'gate', 'pending', '')
      this.set(row, 'release', 'pending', '')
      if (this.step(row, 'deploy')) this.set(row, 'deploy', 'pending', '')
    }
    if (!row.landed.includes(sessionId)) row.landed.push(sessionId)
    row.held = row.held.filter((id) => id !== sessionId)
    delete row.holds[sessionId]
    row.branches[sessionId] = branch
    row.subjects[sessionId] = subjects
    row.armed = true
    const left = batchChildren(this.deps.registry, masterId).filter((s) => !row.landed.includes(s.id)).length
    this.set(row, 'land', left === 0 ? 'done' : 'running', this.landDetail(row))
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
    this.set(row, 'land', 'running', `${row.held.length} held for the end${row.landed.length ? ` · ${row.landed.length} landed` : ''}`)
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
    try {
      const target = project.branch ?? (await this.branchOf(project.cwd))
      const fail = (step: BatchStepId, text: string): void => {
        this.set(row, step, 'failed', text.split('\n')[0].slice(0, 160))
        this.save(row)
        this.tell(master, 'failed', text)
      }
      // land: merge what was held, in landing order.
      for (const id of [...row.held]) {
        const h = row.holds[id]
        if (!h) continue
        let result: MergeResult
        try {
          result = await this.merge(h.cwd, h.branch, h.target, h.push)
        } catch (err) {
          return fail('land', `The batch's merge of ${h.branch} failed: ${err instanceof Error ? err.message : String(err)}. Rebase it on a child and call merge_branch there again; the batch finishes once every thread is done.`)
        }
        this.record(row, id, h.branch, h.subjects)
        this.deps.registry.append(id, { type: 'notice', kind: 'batch', message: `Merged by the batch: ${h.branch} → ${h.target} at ${result.sha.slice(0, 10)}${result.pushed ? ', pushed' : ''}` })
        this.save(row)
      }
      const leftOut = children.filter((s) => !row.landed.includes(s.id)).length
      this.set(row, 'land', 'done', this.landDetail(row, leftOut))
      this.save(row)
      const nothing = row.landed.length === 0
      const skip = (step: BatchStepId, why: string): void => {
        if (this.step(row, step)) this.set(row, step, 'done', why)
      }
      // gate
      let gateText = ''
      if (!row.rules.gate || nothing) {
        skip('gate', nothing ? 'nothing landed' : 'off by the rules')
      } else {
        if (!target || (await this.branchOf(project.cwd)) !== target) {
          return fail('gate', `The project checkout at ${project.cwd} is not on ${target ?? 'the project branch'}; check it out there and send a message to run the batch's end again.`)
        }
        const gate = await this.runStep(master, row, 'gate', { cwd: project.cwd, branch: target })
        if (!gate.ok) {
          return fail('gate', `The batch's gate FAILED at ${failedAt(gate.log)} in ${fmtMs(gate.ms)}${gate.waited}; nothing was tagged.\n\n${logTail(gate.log, GATE_TEXT_TAIL)}\n\nFix it on a child branch and land it; the gate runs again once every thread is done.`)
        }
        gateText = `gate passed in ${fmtMs(gate.ms)}`
      }
      // release
      let releaseText = ''
      if (!row.rules.release || nothing) {
        skip('release', nothing ? 'nothing landed' : 'off by the rules')
      } else {
        const notes = this.notes(master, row).replace(/\s+/g, ' ')
        const release = await this.runStep(master, row, 'release', { cwd: project.cwd, branch: target!, notes })
        if (!release.ok) return fail('release', `The batch's release FAILED: ${lastLine(release.log)}\n\n${logTail(release.log, GATE_TEXT_TAIL)}`)
        releaseText = `${releaseTag(release.log) ?? lastLine(release.log)} tagged`
        if (await this.hasOrigin(project.cwd)) {
          try {
            await this.merge(project.cwd, target!, target!, true)
          } catch (err) {
            return fail('release', `${releaseText}, but the push of ${target} failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      // deploy
      let deployText = ''
      if (row.rules.deploy === 'box') {
        if (nothing || !row.rules.release) {
          skip('deploy', nothing ? 'nothing landed' : 'needs a release')
        } else if (!this.deps.deploy) {
          return fail('deploy', 'The batch asked for a box deploy, but this host has no deploy trigger (docs/box.md "Deploy from the app").')
        } else {
          this.set(row, 'deploy', 'running', 'requested')
          this.save(row)
          try {
            await this.deps.deploy(target!)
          } catch (err) {
            return fail('deploy', `The box deploy was refused: ${err instanceof Error ? err.message : String(err)}`)
          }
          this.set(row, 'deploy', 'done', `${target} requested`)
          deployText = `deploy of ${target} requested`
        }
      }
      // then
      row.finishedAt = this.now()
      this.save(row)
      const line = [this.landDetail(row, leftOut), gateText, releaseText, deployText].filter(Boolean).join(' · ')
      this.deps.registry.append(master.id, { type: 'notice', kind: 'batch', message: `Batch done: ${line}` })
      if (row.rules.then === 'archive-children') {
        for (const s of children) if (this.done(s)) await this.deps.registry.setArchived?.(s.id, true)
      }
      this.tell(
        master,
        'done',
        `The batch is done: ${line}.${row.rules.then === 'archive-children' ? ` The ${children.length} done thread${children.length === 1 ? '' : 's'} are archived.` : ''} Tell the person what landed and what is left, then end your turn.`
      )
    } finally {
      this.gating.delete(master.id)
    }
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
    const target = project.branch ?? (await this.branchOf(project.cwd))
    const onBranch = await this.branchOf(project.cwd)
    if (!target || onBranch !== target) {
      return `refused: the project checkout at ${project.cwd} is on ${onBranch ?? 'a detached HEAD'}, not ${target ?? 'the project branch'}`
    }
    // Children still unlanded are left out: the land step says so.
    const left = batchChildren(this.deps.registry, master.id).filter((s) => !row.landed.includes(s.id)).length
    this.set(row, 'land', 'done', this.landDetail(row, left))
    this.gating.add(master.id)
    try {
      const gate = await this.runStep(master, row, 'gate', { cwd: project.cwd, branch: target })
      if (!gate.ok) {
        return `FAILED at ${failedAt(gate.log)} in ${fmtMs(gate.ms)}${gate.waited}; nothing was tagged.\n\n${logTail(gate.log, GATE_TEXT_TAIL)}\n\nFix it on a child branch, land it with merge_branch, and call ${BATCH_GATE_TOOL_NAME} again.`
      }
      const passed = `passed in ${fmtMs(gate.ms)}${gate.waited}`
      if (args.release === false) {
        this.set(row, 'release', 'pending', '')
        this.save(row)
        return `${passed}. Release left for later (release: false).`
      }
      const notes = (args.notes?.trim() || this.notes(master, row)).replace(/\s+/g, ' ')
      const release = await this.runStep(master, row, 'release', { cwd: project.cwd, branch: target, notes })
      const tag = releaseTag(release.log)
      if (!release.ok) return `${passed}, but the release FAILED: ${lastLine(release.log)}\n\n${logTail(release.log, GATE_TEXT_TAIL)}`
      return `${passed} · ${tag ? `${tag} tagged` : lastLine(release.log)}`
    } finally {
      this.gating.delete(master.id)
    }
  }

  /** One step on the queue: its detail follows the queue position, then
   *  the run's `✓` lines; its outcome lands as a gate row on the master. */
  private async runStep(
    master: SessionMeta,
    row: StoredBatch,
    id: 'gate' | 'release',
    opts: { cwd: string; branch: string; notes?: string }
  ): Promise<{ ok: boolean; log: string; ms: number; waited: string }> {
    const started = this.now()
    let wait: GateWait | null = null
    this.set(row, id, 'running', 'queued')
    this.save(row)
    const result = await this.queue.run(
      `${id} ${master.title}`,
      () => {
        this.set(row, id, 'running', id === 'gate' ? 'running' : 'tagging')
        this.save(row)
        return this.runGate({
          cwd: opts.cwd,
          step: id,
          branch: opts.branch,
          notes: opts.notes,
          onLine: (line) => {
            const m = /[✓✗] \S+(?: \S+)?/.exec(line)
            if (!m) return
            this.set(row, id, 'running', m[0])
            this.save(row)
          }
        })
      },
      (w) => {
        wait = w
        this.set(row, id, 'running', `queued · ${ordinal(w.position)} in line`)
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
    this.set(row, id, result.ok ? 'done' : 'failed', detail)
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
  }
}

function parseRow(raw: string | null | undefined): StoredBatch | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<StoredBatch>
    if (!v || typeof v.masterId !== 'string' || !Array.isArray(v.steps)) return null
    const parsed = BatchRulesSchema.safeParse({ ...DEFAULT_BATCH_RULES, ...(v.rules ?? {}) })
    const rules = parsed.success ? parsed.data : { ...DEFAULT_BATCH_RULES }
    const steps = stepsFor(rules).map(
      (id) => v.steps!.find((s) => s.id === id) ?? { id, status: 'pending' as const, detail: '', at: null }
    )
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
      holds: v.holds ?? {}
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

export function handleBatch(
  req: ClientRequest,
  batches: Pick<Batches, 'get' | 'setRules'>,
  registry: Pick<SessionRegistry, 'list'>
): { handled: true; result: unknown } | { handled: false } {
  switch (req.method) {
    case 'batch.get':
      return { handled: true, result: batches.get(req.params.masterId) }
    case 'batch.children':
      return { handled: true, result: { children: batchChildren(registry, req.params.masterId) } }
    case 'batch.setRules':
      return { handled: true, result: batches.setRules(req.params.masterId, req.params.rules) }
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
