import type { ClientRequest } from '@shared/contract'
import {
  BatchRulesSchema,
  DEFAULT_BATCH_RULES,
  emptyBatch,
  stepsFor,
  type BatchRules,
  type BatchState,
  type BatchStep,
  type BatchStepId
} from '@shared/contract-batch'
import type { SessionMeta } from '@shared/events'
import { gateLine, type GateNotice } from '@shared/gate'
import { BATCH_GATE_TOOL_NAME, GATE_TEXT_TAIL, logTail } from '@shared/gate'
import { gateQueue, type GateQueue, type GateWait } from './gateQueue'
import { runGateStep } from './gateRun'
import { branchOf } from './mergeBranch'
import type { Landed } from './mergeReview'
import type { SessionRegistry } from './sessions'

/**
 * A master thread's batch (contract-batch.ts): the three steps its children
 * never run themselves. `land` follows merge_branch: every child that lands
 * (mergeReview.ts, through `landed`) counts, "3 of 7 landed", done when
 * every unarchived child has, or when the master calls `batch_gate` with
 * the rest left out. `gate` is that tool: the commit tier once on the
 * project checkout at the project branch's head, on the host's gate queue
 * so it never overlaps a child's typecheck; its detail is the gate's last
 * `✓ step 12s` line while it runs. `release` follows a green gate:
 * `bun scripts/release.ts "<notes>"` with the master's title and the landed
 * children's commit subjects, "release-N tagged".
 *
 * State lives in one settings row per master (`batch:<masterId>`, the way
 * `review:run:<id>` persists) so a restart keeps it; `pending` is computed
 * from the sessions table on every read. Every step change is pushed as
 * `batch` (contract.ts) so a board follows without polling.
 */

/** The unarchived root threads of a master, oldest first. */
export function batchChildren(registry: Pick<SessionRegistry, 'list'>, masterId: string): SessionMeta[] {
  return registry
    .list({ archived: false })
    .filter((s) => s.masterId === masterId && !s.parentId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** What the row keeps beyond the wire shape: each landed child's branch and subjects (the notes). */
interface StoredBatch {
  masterId: string
  rules: BatchRules
  steps: BatchStep[]
  landed: string[]
  held: string[]
  blocked: BatchState['blocked']
  finishedAt: number | null
  branches: Record<string, string>
  subjects: Record<string, string[]>
}

const freshRow = (masterId: string, rules: BatchRules = DEFAULT_BATCH_RULES): StoredBatch => ({
  ...emptyBatch(masterId, [], rules),
  branches: {},
  subjects: {}
})

export interface BatchesDeps {
  registry: Pick<SessionRegistry, 'list' | 'get' | 'getProject' | 'append'>
  store: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string | null): void
    settingsWithPrefix?(prefix: string): Map<string, string>
  }
  runGate?: typeof runGateStep
  queue?: GateQueue
  /** the branch a checkout is on; tests pass their own */
  branchOf?: typeof branchOf
  now?: () => number
}

const ROW_PREFIX = 'batch:'

export class Batches {
  private readonly rows = new Map<string, StoredBatch>()
  private readonly listeners = new Set<(state: BatchState) => void>()
  private readonly runGate: typeof runGateStep
  private readonly queue: GateQueue
  private readonly branchOf: typeof branchOf
  private readonly now: () => number
  /** one batch_gate at a time per master */
  private readonly gating = new Set<string>()

  constructor(private readonly deps: BatchesDeps) {
    this.runGate = deps.runGate ?? runGateStep
    this.queue = deps.queue ?? gateQueue()
    this.branchOf = deps.branchOf ?? branchOf
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
    this.save(row)
    return this.get(masterId)
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
    // A landing after the release: a new cycle. After a red gate, or a
    // late child after the gate ran: the gate has to run again.
    if (this.step(row, 'release')?.status === 'done') {
      Object.assign(row, freshRow(masterId, row.rules))
    } else if (this.step(row, 'gate')?.status !== 'pending' && !this.gating.has(masterId)) {
      this.set(row, 'gate', 'pending', '')
      this.set(row, 'release', 'pending', '')
    }
    if (!row.landed.includes(l.session.id)) row.landed.push(l.session.id)
    row.branches[l.session.id] = l.branch
    row.subjects[l.session.id] = l.subjects
    const left = batchChildren(this.deps.registry, masterId).filter((s) => !row.landed.includes(s.id)).length
    this.set(row, 'land', left === 0 ? 'done' : 'running', this.landDetail(row))
    this.save(row)
  }

  // ── gate and release: the batch_gate tool ────────────────────────────

  /** Who may call: the project's master. Null when the caller is. */
  private refusal(master: SessionMeta): string | null {
    const project = master.projectId ? this.deps.registry.getProject(master.projectId) : null
    if (!project) return 'refused: this thread has no project'
    if (project.masterThreadId !== master.id) return `refused: ${BATCH_GATE_TOOL_NAME} is for the project's master thread; this thread is not pinned as one`
    return null
  }

  /** The tool. Never throws: every outcome is text the master reads. */
  async gate(master: SessionMeta, args: { notes?: string; release?: boolean } = {}): Promise<string> {
    const refused = this.refusal(master)
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
      branches: v.branches ?? {},
      subjects: v.subjects ?? {}
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
