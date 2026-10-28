import { nanoid } from 'nanoid'
import { existsSync, readFileSync } from 'node:fs'
import { modelInfo, resolveModel } from '@shared/catalog'
import type { SessionMeta } from '@shared/events'
import { GATE_TEXT_TAIL, gateLine, logTail, type GateNotice, type GateStep, gateFailureDetail } from '@shared/gate'
import {
  MERGE_BRANCH_TOOL_NAME,
  REPORT_FINDINGS_TOOL_NAME,
  ReportFindingsSchema,
  reviewLine,
  splitFindings,
  type ReportFindings,
  type ReviewFinding,
  type ReviewNotice,
  type ReviewSettings
} from '@shared/review'
import {
  MergeRefusal,
  branchOf,
  buildMergeBundle,
  defaultBranchOf,
  fastForwardMerge,
  hasOrigin,
  rebaseOnto,
  targetMoved,
  worktreeOf,
  type MergeBundle,
  type MergeResult
} from './mergeBranch'
import { gateQueue, type GateQueue, type GateWait } from './gateQueue'
import { runGateStep } from './gateRun'
import { suppressSettleReports, waitForSettled } from './orchestration'
import type { SessionRegistry } from './sessions'

/**
 * Review before merge (shared/review.ts). An implementation thread lands
 * its branch through the `merge_branch` app tool; when the project's set
 * says so, this module runs a second model over the branch first.
 *
 * Why a tool and not an intercepted `git merge`: the harnesses run the
 * model's shell themselves (Claude's Bash, Codex's sandbox), so catching a
 * merge there would mean a git shim on every PATH, which still misses
 * `git -C`, aliases, scripts and a push typed by hand, and could hand the
 * model nothing back — a merge held by a review has to be READ by the
 * model as the next thing in its turn. The tool is that read: its result
 * is the verdict, every provider reaches it (claude in-process, codex over
 * the bridge), and the preamble tells a reviewed project's threads to use
 * it and never merge by hand.
 *
 * One call = one run. The reviewer is an ordinary child session (parentId
 * = the implementation thread, agentType reviewer), so it sits in the
 * thread's subagent list and archives with it; it reports once through
 * `report_findings`. The run's state is persisted (`review:run:<id>`) so
 * "Merge anyway" on the card works after a restart.
 *
 * The gate out of the children (shared/gate.ts): after the review and
 * before the fast-forward, the branch is gated on the host's one queue
 * (gateQueue.ts). A batch child (a session with `masterId`) runs typecheck
 * alone in its worktree, so a break is named to its thread and the batch's
 * end runs the whole commit tier once; a thread outside any batch runs the
 * commit tier itself, as its preamble used to tell it to, serialized the
 * same way. A red run holds the merge and lands a `gate` row.
 */

export interface MergeReviewGit {
  branchOf: typeof branchOf
  defaultBranchOf: typeof defaultBranchOf
  buildMergeBundle: typeof buildMergeBundle
  fastForwardMerge: typeof fastForwardMerge
  worktreeOf: typeof worktreeOf
  hasOrigin(cwd: string): Promise<boolean>
  /** Has the target moved since the branch forked (then the landing rebases first, under the lock)? */
  targetMoved: typeof targetMoved
  /** The rebase a landing runs in the branch's worktree when the target moved. */
  rebaseOnto: typeof rebaseOnto
}

export interface MergeReviewDeps {
  registry: Pick<
    SessionRegistry,
    'create' | 'send' | 'get' | 'eventsAfter' | 'subscribe' | 'append' | 'interrupt' | 'getProject' | 'effectiveReview'
  >
  store: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string | null): void
    settingsWithPrefix?(prefix: string): Map<string, string>
  }
  git?: Partial<MergeReviewGit>
  now?: () => number
  /** a stub brief for the proof (TEMP_CODE_REVIEW_STUB_FILE): the reviewer reports this file's findings */
  stubFile?: string | null
  /** the gate step runner (gateRun.ts) and the host's queue; tests pass their own */
  runGate?: typeof runGateStep
  queue?: GateQueue
  /** a merge landed: the batch records it (batch.ts) */
  onLanded?: (landed: Landed) => void
  /** before a batch child's fast-forward: the batch may hold it (all-at-once) and answer the text instead (batch.ts;
   *  for a thread of another host's batch, remote/crossHostThreads.ts asks that host, so it may take a moment or refuse) */
  hold?: (session: SessionMeta, landing: { cwd: string; branch: string; target: string; push: boolean; subjects: string[] }) => string | null | Promise<string | null>
}

/** The gate step's verdict, as the landing's text reads it. */
interface GateVerdict {
  ok: boolean
  line: string
  ms: number
  log: string
}

/** What one run under the landing lock came to. */
type Landing =
  | { kind: 'refused'; why: string; gate: GateVerdict | null; rebased: boolean }
  | { kind: 'gate'; gate: GateVerdict; rebased: boolean }
  | { kind: 'held'; text: string; gate: GateVerdict; rebased: boolean }
  | { kind: 'landed'; result: MergeResult; gate: GateVerdict; rebased: boolean }

/** What a landed merge tells the batch. */
export interface Landed {
  session: SessionMeta
  branch: string
  target: string
  sha: string
  /** the branch's commit subjects, oldest first */
  subjects: string[]
}

export type RunState = 'reviewing' | 'held' | 'passed' | 'done'

/** What survives a restart: enough to merge anyway, and to skip a second
 *  review of a head that already passed. */
export interface ReviewRun {
  runId: string
  sessionId: string
  reviewerId: string | null
  provider: string
  model: string
  branch: string
  target: string
  head: string
  cwd: string
  push: boolean
  blockOn: ReviewSettings['blockOn']
  maxMinutes: number
  startedAt: number
  state: RunState
  blocking: ReviewFinding[]
  minor: ReviewFinding[]
  /** the merge-base the gate's `--since` names; absent on rows from before the gate */
  base?: string
  /** the branch's commit subjects, for the batch's release notes */
  subjects?: string[]
}

/** The subjects of a bundle's `%h %s%n%b` log. */
export function subjectsOf(commits: string): string[] {
  return commits
    .split('\n')
    .map((l) => /^[0-9a-f]{6,40} (.+)$/.exec(l)?.[1]?.trim() ?? '')
    .filter(Boolean)
}

const RUN_PREFIX = 'review:run:'
const BRIEF_CAP = 6000

const defaultGit: MergeReviewGit = {
  branchOf,
  defaultBranchOf,
  buildMergeBundle,
  fastForwardMerge,
  worktreeOf,
  hasOrigin,
  targetMoved,
  rebaseOnto
}

const label = (provider: string, model: string): string => {
  try {
    return modelInfo(provider as never, model)?.label ?? model
  } catch {
    return model
  }
}

export class MergeReviews {
  private readonly git: MergeReviewGit
  private readonly now: () => number
  /** live runs by id, and the reviewer → run index the tool gate reads */
  private readonly runs = new Map<string, ReviewRun>()
  private readonly byReviewer = new Map<string, string>()
  private readonly reports = new Map<string, (r: ReportFindings) => void>()
  /** one merge_branch at a time per thread: a second call waits on the first */
  private readonly inFlight = new Map<string, Promise<string>>()
  /** Every reviewer this host started, for the life of the process: its
   *  settle must never wake the implementation thread with a subagent
   *  report (the verdict already came back through merge_branch), even
   *  after its run is forgotten. */
  private readonly reviewerIds = new Set<string>()

  private readonly runGate: typeof runGateStep
  private readonly queue: GateQueue

  constructor(private readonly deps: MergeReviewDeps) {
    this.git = { ...defaultGit, ...(deps.git ?? {}) }
    this.now = deps.now ?? Date.now
    this.runGate = deps.runGate ?? runGateStep
    this.queue = deps.queue ?? gateQueue()
    this.restore()
    suppressSettleReports((child) => this.reviewerIds.has(child.id) || this.isReviewTitle(child))
  }

  /** A reviewer from before a restart: its run row is gone, its title stays. */
  private isReviewTitle(child: SessionMeta): boolean {
    return child.agentType === 'reviewer' && child.title.startsWith('Review: ') && child.title.includes(' → ')
  }

  // ── persistence ───────────────────────────────────────────────────────

  private restore(): void {
    // Runs that were reviewing when the host died cannot resume (the
    // reviewer's report is gone with its process); held and passed ones
    // carry on: the card's Merge anyway, and the skip of a reviewed head.
    for (const [key, raw] of this.allRuns()) {
      try {
        const run = JSON.parse(raw) as ReviewRun
        if (run.state === 'reviewing') {
          this.deps.store.setSetting(key, null)
          continue
        }
        this.runs.set(run.runId, run)
        if (run.reviewerId) this.byReviewer.set(run.reviewerId, run.runId)
      } catch {
        this.deps.store.setSetting(key, null)
      }
    }
  }

  private allRuns(): [string, string][] {
    return [...(this.deps.store.settingsWithPrefix?.(RUN_PREFIX) ?? new Map<string, string>())]
  }

  private save(run: ReviewRun): void {
    this.runs.set(run.runId, run)
    if (run.reviewerId) {
      this.byReviewer.set(run.reviewerId, run.runId)
      this.reviewerIds.add(run.reviewerId)
    }
    this.deps.store.setSetting(`${RUN_PREFIX}${run.runId}`, JSON.stringify(run))
  }

  private forget(run: ReviewRun): void {
    this.runs.delete(run.runId)
    if (run.reviewerId) this.byReviewer.delete(run.reviewerId)
    this.deps.store.setSetting(`${RUN_PREFIX}${run.runId}`, null)
  }

  /** The run a reviewer session reports into, if it is one. */
  runOfReviewer(sessionId: string): ReviewRun | null {
    const id = this.byReviewer.get(sessionId)
    return id ? (this.runs.get(id) ?? null) : null
  }

  isReviewer(sessionId: string): boolean {
    return this.byReviewer.has(sessionId)
  }

  /** The held run a thread can merge past, if any. */
  heldRun(sessionId: string, runId: string): ReviewRun | null {
    const run = this.runs.get(runId) ?? this.loadRun(runId)
    return run && run.sessionId === sessionId && run.state === 'held' ? run : null
  }

  private loadRun(runId: string): ReviewRun | null {
    const raw = this.deps.store.getSetting(`${RUN_PREFIX}${runId}`)
    if (!raw) return null
    try {
      const run = JSON.parse(raw) as ReviewRun
      this.runs.set(run.runId, run)
      return run
    } catch {
      return null
    }
  }

  // ── merge_branch ─────────────────────────────────────────────────────

  /** The tool: resolves the branch and target, reviews when the project
   *  says so, merges, and answers the model. Never throws: every outcome
   *  is text the model reads. */
  mergeBranch(session: SessionMeta, args: { branch?: string; push?: boolean }): Promise<string> {
    const waiting = this.inFlight.get(session.id)
    const run = (waiting ?? Promise.resolve('')).then(() => this.mergeBranchNow(session, args))
    this.inFlight.set(session.id, run.catch(() => ''))
    return run
  }

  private async mergeBranchNow(session: SessionMeta, args: { branch?: string; push?: boolean }): Promise<string> {
    const project = session.projectId ? this.deps.registry.getProject(session.projectId) : null
    const repoCwd = project?.cwd ?? session.cwd
    const target = project?.branch ?? (await this.git.defaultBranchOf(repoCwd))
    if (!target) return `refused: ${repoCwd} has no project branch and no master or main to merge into`
    const branch = args.branch?.trim() || (await this.git.branchOf(session.cwd))
    if (!branch) return `refused: ${session.cwd} is not on a branch; pass \`branch\``
    const push = args.push ?? (await this.git.hasOrigin(repoCwd))
    let bundle: MergeBundle
    try {
      bundle = await this.git.buildMergeBundle(repoCwd, branch, target)
    } catch (err) {
      return `refused: ${err instanceof Error ? err.message : String(err)}`
    }
    if (bundle.empty) {
      return branch === target
        ? `nothing to do: ${target} has nothing unpushed. If your work is on another branch (a worktree of your own), pass \`branch\`.`
        : `nothing to merge: ${branch} is already in ${target}`
    }
    const { settings } = this.deps.registry.effectiveReview(session.projectId)
    if (!settings.beforeMerge) {
      return this.mergeAndRow(session, {
        runId: nanoid(10),
        sessionId: session.id,
        reviewerId: null,
        provider: settings.provider,
        model: settings.model,
        branch,
        target,
        head: bundle.head,
        cwd: repoCwd,
        push,
        blockOn: settings.blockOn,
        maxMinutes: settings.maxMinutes,
        startedAt: this.now(),
        state: 'done',
        blocking: [],
        minor: [],
        base: bundle.base,
        subjects: subjectsOf(bundle.commits)
      }, 'skipped')
    }
    // A head this thread already got through review merges without a second one.
    const passed = [...this.runs.values()].find(
      (r) => r.sessionId === session.id && r.state === 'passed' && r.head === bundle.head && r.branch === branch
    )
    if (passed) {
      passed.push = push
      return this.mergeAndRow(session, passed, 'pass', 'already reviewed')
    }
    return this.review(session, bundle, settings, push)
  }

  private async review(session: SessionMeta, bundle: MergeBundle, settings: ReviewSettings, push: boolean): Promise<string> {
    const runId = nanoid(10)
    const { provider, model } = resolveModel(settings.provider, settings.model)
    const run: ReviewRun = {
      runId,
      sessionId: session.id,
      reviewerId: null,
      provider,
      model,
      branch: bundle.branch,
      target: bundle.target,
      head: bundle.head,
      cwd: bundle.cwd,
      push,
      blockOn: settings.blockOn,
      maxMinutes: settings.maxMinutes,
      startedAt: this.now(),
      state: 'reviewing',
      blocking: [],
      minor: [],
      base: bundle.base,
      subjects: subjectsOf(bundle.commits)
    }
    // The reviewer reads the change where it is checked out: the thread's
    // own directory when that is the branch, else the worktree that has it,
    // else the project checkout (where `git show <branch>:<file>` answers).
    const reviewerCwd =
      (await this.git.branchOf(session.cwd)) === bundle.branch
        ? session.cwd
        : ((await this.git.worktreeOf(bundle.cwd, bundle.branch)) ?? bundle.cwd)
    const live = this.deps.registry.get(session.id) ?? session
    let reviewer: SessionMeta
    try {
      reviewer = await this.deps.registry.create({
        projectId: session.projectId,
        provider,
        model,
        reasoning: settings.reasoning,
        agentType: 'reviewer',
        permission: live.permission,
        cwd: reviewerCwd,
        title: `Review: ${bundle.branch} → ${bundle.target}`,
        parentId: session.id
      })
    } catch (err) {
      run.state = 'done'
      return this.mergeAndRow(session, run, 'failed', `could not start the reviewer: ${err instanceof Error ? err.message : String(err)}`)
    }
    run.reviewerId = reviewer.id
    // Registered BEFORE the first send: the harness boots on it, and the
    // report_findings tool is offered only to a session this index knows.
    this.save(run)
    const report = new Promise<ReportFindings>((resolve) => this.reports.set(runId, resolve))
    try {
      await this.deps.registry.send(reviewer.id, this.brief(session, bundle, reviewerCwd !== bundle.cwd || (await this.git.branchOf(bundle.cwd)) === bundle.branch))
    } catch (err) {
      this.reports.delete(runId)
      this.forget(run)
      run.state = 'done'
      return this.mergeAndRow(session, run, 'failed', `could not brief the reviewer: ${err instanceof Error ? err.message : String(err)}`)
    }
    const timeoutMs = settings.maxMinutes * 60_000
    const outcome = await Promise.race<
      { kind: 'report'; report: ReportFindings } | { kind: 'settled'; status: string } | { kind: 'timeout' }
    >([
      report.then((r) => ({ kind: 'report' as const, report: r })),
      waitForSettled(this.deps.registry as SessionRegistry, reviewer.id, 0).then((m) => ({
        kind: 'settled' as const,
        status: m?.status ?? 'gone'
      })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs))
    ])
    this.reports.delete(runId)
    if (outcome.kind === 'report') {
      const { blocking, minor } = splitFindings(outcome.report.findings, settings.blockOn)
      run.blocking = blocking
      run.minor = minor
      if (blocking.length) {
        run.state = 'held'
        this.save(run)
        this.row(session.id, run, 'held', false)
        return this.heldText(run)
      }
      run.state = 'passed'
      this.save(run)
      return this.mergeAndRow(session, run, 'pass')
    }
    if (outcome.kind === 'timeout') {
      void this.deps.registry.interrupt(reviewer.id).catch(() => {})
      run.state = 'done'
      return this.mergeAndRow(session, run, 'timeout')
    }
    // Settled without a report: the review failed to run (its own status
    // says why; an errored reviewer shows as failed in the list).
    run.state = 'done'
    return this.mergeAndRow(session, run, 'failed', `the reviewer ended ${outcome.status} without reporting`)
  }

  /** The reviewer's first message. */
  brief(session: SessionMeta, bundle: MergeBundle, checkedOut = true): string {
    const rows = this.deps.registry.eventsAfter(session.id, 0)
    const first = rows.find((r) => r.event.type === 'user-text')
    const task = first && first.event.type === 'user-text' ? first.event.text.trim() : ''
    const brief = task.length > BRIEF_CAP ? `${task.slice(0, BRIEF_CAP)}\n[brief truncated]` : task
    const stub = this.stubBrief()
    return `<merge-review>
You are the reviewer for a merge of branch ${bundle.branch} into ${bundle.target} in ${bundle.cwd}. ${checkedOut ? 'The change is checked out in your working directory.' : `Your working directory is the project checkout on ${bundle.target}; read the branch's files with \`git show ${bundle.branch}:<path>\`.`} Read-only: edit nothing, run nothing that changes the tree; read files and run git's read commands as you need.
Find correctness defects in this change — behaviour that goes wrong under concrete inputs or states — not style, not taste. Verify every candidate against the code before reporting it: a finding you confirmed is CONFIRMED, one you could not is PLAUSIBLE. Rank the most severe first.
When done, call ${REPORT_FINDINGS_TOOL_NAME} ONCE with every finding (file, 1-indexed line, one-sentence summary, the concrete failure scenario, verdict), an empty list when the change is sound, then stop. Only that call counts; prose in your reply is not read.${stub}

## The implementation thread's brief
${brief || '(none recorded)'}

## Commits on the branch
${bundle.commits.trim() || '(none)'}

## Files changed
${bundle.files.join('\n') || '(none)'}

## Diff (${bundle.base.slice(0, 10)}..${bundle.head.slice(0, 10)})${bundle.diffTruncated ? ' — truncated; read the rest with git diff' : ''}
\`\`\`diff
${bundle.diff}
\`\`\`
</merge-review>`
  }

  private stubBrief(): string {
    const file = this.deps.stubFile ?? process.env.TEMP_CODE_REVIEW_STUB_FILE ?? null
    if (!file || !existsSync(file)) return ''
    try {
      const json = readFileSync(file, 'utf8').trim()
      JSON.parse(json)
      return `\n\nPROOF RUN: do not read the diff or the code. Call ${REPORT_FINDINGS_TOOL_NAME} immediately with exactly these arguments and stop:\n${json}`
    } catch {
      return ''
    }
  }

  // ── report_findings ──────────────────────────────────────────────────

  /** The reviewer's one report; refused outside a run or after the first. */
  reportFindings(session: SessionMeta, raw: unknown): string {
    const run = this.runOfReviewer(session.id)
    if (!run) return 'refused: this thread is not the reviewer of a merge review'
    const parsed = ReportFindingsSchema.safeParse(raw)
    if (!parsed.success) return `refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    const resolve = this.reports.get(run.runId)
    if (!resolve) return 'refused: this review already has its report'
    this.reports.delete(run.runId)
    resolve(parsed.data)
    const n = parsed.data.findings.length
    return `reported ${n} finding${n === 1 ? '' : 's'}; the merge decides from them. You are done.`
  }

  // ── Merge anyway ─────────────────────────────────────────────────────

  /** The person merges past a held review: no gate, but the same landing
   *  lock and the rebase onto a target that moved. */
  async override(sessionId: string, runId: string): Promise<MergeResult> {
    const run = this.heldRun(sessionId, runId)
    if (!run) throw new Error('no held review to merge past')
    const session = this.deps.registry.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    const result = await this.queue.run(`land ${run.branch}`, async () => {
      const cwd = await this.gateCwd(session, run)
      if (cwd) await this.rebaseIfMoved(run, cwd)
      return this.git.fastForwardMerge(run.cwd, run.branch, run.target, run.push)
    })
    run.state = 'done'
    this.forget(run)
    this.row(sessionId, run, 'merged-anyway', true, result.pushed)
    this.deps.onLanded?.({ session, branch: run.branch, target: run.target, sha: result.sha, subjects: run.subjects ?? [] })
    return result
  }

  // ── rows and texts ───────────────────────────────────────────────────

  /**
   * The landing, after the review: ONE run on the host's gate queue holds
   * the whole of it, from the gate step to the push's return, so no other
   * landing on this host slips in between (the fast-forward used to lose
   * that race to every landing during its own typecheck). Under the lock,
   * a target that moved since the branch forked is rebased onto first, in
   * the branch's worktree, and the gate step runs on the rebased head.
   */
  private async mergeAndRow(
    session: SessionMeta,
    run: ReviewRun,
    outcome: ReviewNotice['outcome'],
    reason?: string
  ): Promise<string> {
    const step = MergeReviews.stepFor(session)
    const cwd = await this.gateCwd(session, run)
    if (!cwd) {
      if (run.state === 'done') this.forget(run)
      return `refused: ${run.branch} is not checked out in any worktree of ${run.cwd}; the ${step === 'typecheck' ? 'typecheck' : 'gate'} needs its tree. Check it out (git worktree add) and call ${MERGE_BRANCH_TOOL_NAME} again.`
    }
    const started = this.now()
    let wait: GateWait | null = null
    const landing = await this.queue.run(
      `land ${run.branch}`,
      () => this.land(session, run, step, cwd),
      (w) => (wait = w)
    )
    const waited = wait ? ` after ${fmtMs(this.now() - started - (landing.gate?.ms ?? 0))} in the gate queue behind ${(wait as GateWait).ahead.length}` : ''
    if (landing.kind === 'refused') {
      // The review stands (a passed head stays passed); the merge did not.
      if (run.state === 'done') this.forget(run)
      const verdict = outcome === 'pass' ? `Review passed${run.minor.length ? ` (${run.minor.length} minor)` : ''}, but ` : outcome === 'timeout' || outcome === 'failed' ? `${reviewLine(this.notice(run, outcome, false, false, reason), label(run.provider, run.model)).replace(/ — merged without it$/, '')}; ` : ''
      return `refused: ${verdict}${landing.why}`
    }
    const gate = landing.gate
    const gateText = gate.ok
      ? `${gate.line} in ${fmtMs(gate.ms)}${waited}.`
      : `HELD: ${gate.line.toLowerCase()} in ${fmtMs(gate.ms)}${waited}; the merge did not run.\n\n${logTail(gate.log, GATE_TEXT_TAIL)}\n\nFix it on ${run.branch}, commit, and call ${MERGE_BRANCH_TOOL_NAME} again.`
    if (landing.kind === 'gate') {
      if (run.state === 'done') this.forget(run)
      return gateText
    }
    if (landing.kind === 'held') {
      // A batch that lands all at once: the branch is recorded, the merge waits for the end.
      this.forget(run)
      this.row(session.id, run, outcome, false, false, reason)
      return `${landing.text} ${gateText}`
    }
    const result = landing.result
    this.forget(run)
    const notice = this.row(session.id, run, outcome, result.merged || run.branch === run.target, result.pushed, reason)
    this.deps.onLanded?.({ session, branch: run.branch, target: run.target, sha: result.sha, subjects: run.subjects ?? [] })
    const minor = run.minor.length ? this.findingsText('Minor findings (not blocking)', run.minor) : ''
    return `${reviewLine(notice, label(run.provider, run.model))}. ${run.target} is at ${result.sha.slice(0, 10)}${result.pushed ? ', pushed to origin' : ''}${landing.rebased ? ` (rebased onto ${run.target} first)` : ''}. ${gateText}${minor}`
  }

  /** What happened under the lock: the gate step's verdict, then the batch's hold or the merge, or a refusal on the way. */
  private async land(session: SessionMeta, run: ReviewRun, step: GateStep, cwd: string): Promise<Landing> {
    let rebased = false
    try {
      rebased = await this.rebaseIfMoved(run, cwd)
    } catch (err) {
      return { kind: 'refused', why: err instanceof Error ? err.message : String(err), gate: null, rebased: false }
    }
    const gate = await this.gate(session, run, step, cwd)
    if (!gate.ok) return { kind: 'gate', gate, rebased }
    let held: string | null
    try {
      held = (await this.deps.hold?.(session, { cwd: run.cwd, branch: run.branch, target: run.target, push: run.push, subjects: run.subjects ?? [] })) ?? null
    } catch (err) {
      // The batch could not be asked (the master's host out of reach, the push refused): the review stands, the merge does not.
      return { kind: 'refused', why: err instanceof Error ? err.message : String(err), gate, rebased }
    }
    if (held) return { kind: 'held', text: held, gate, rebased }
    try {
      const result = await this.git.fastForwardMerge(run.cwd, run.branch, run.target, run.push)
      return { kind: 'landed', result, gate, rebased }
    } catch (err) {
      return { kind: 'refused', why: err instanceof Error ? err.message : String(err), gate, rebased }
    }
  }

  /** The target moved since the branch forked: rebase the branch in its
   *  worktree (under the lock, so it cannot move again) and move the run's
   *  head and base with it. A branch that IS the target has nothing to
   *  rebase. True when a rebase ran. */
  private async rebaseIfMoved(run: ReviewRun, cwd: string): Promise<boolean> {
    if (run.branch === run.target) return false
    if (!(await this.git.targetMoved(run.cwd, run.branch, run.target))) return false
    const { head, base, rebased } = await this.git.rebaseOnto(cwd, run.branch, run.target)
    run.head = head
    run.base = base
    if (run.state !== 'done') this.save(run)
    return rebased
  }

  // ── the gate ─────────────────────────────────────────────────────────

  /** The step a caller gets: typecheck alone for a batch child, the commit tier otherwise. */
  static stepFor(session: Pick<SessionMeta, 'masterId'>): GateStep {
    return session.masterId ? 'typecheck' : 'gate'
  }

  /** Where the branch is checked out: the thread's directory when that is
   *  the branch, else its worktree; the project checkout when the branch IS
   *  the target. Null when nowhere: the gate needs a tree to run on. */
  private async gateCwd(session: SessionMeta, run: ReviewRun): Promise<string | null> {
    if (run.branch === run.target) return run.cwd
    if ((await this.git.branchOf(session.cwd)) === run.branch) return session.cwd
    return this.git.worktreeOf(run.cwd, run.branch)
  }

  /** Runs the branch's gate step (the caller holds the landing lock) and
   *  lands its row; the caller words the text from the verdict. */
  private async gate(session: SessionMeta, run: ReviewRun, step: GateStep, cwd: string): Promise<GateVerdict> {
    const result = await this.runGate({ cwd, step, branch: run.branch, since: step === 'gate' ? run.base : undefined })
    const notice: GateNotice = {
      step,
      branch: run.branch,
      ok: result.ok,
      log: result.log,
      at: this.now(),
      ...(result.ok ? {} : { detail: gateFailureDetail(step, result.log, result.firstError) })
    }
    this.deps.registry.append(session.id, { type: 'notice', kind: 'gate', message: gateLine(notice), gate: notice })
    return { ok: result.ok, line: gateLine(notice), ms: result.ms, log: result.log }
  }

  private heldText(run: ReviewRun): string {
    return `HELD: ${reviewLine(this.notice(run, 'held', false, false), label(run.provider, run.model))}. Address these before merging, then call ${MERGE_BRANCH_TOOL_NAME} again (the next call reviews the new head).${this.findingsText('Blocking findings', run.blocking)}${run.minor.length ? this.findingsText('Minor findings (not blocking)', run.minor) : ''}\nThe user can merge anyway from the review card in the thread.`
  }

  private findingsText(title: string, list: ReviewFinding[]): string {
    return `\n\n${title}:\n${list
      .map((f, i) => `${i + 1}. ${f.file}${f.line ? `:${f.line}` : ''}${f.verdict ? ` [${f.verdict}]` : ''} — ${f.summary}${f.failure_scenario ? `\n   Failure: ${f.failure_scenario}` : ''}`)
      .join('\n')}`
  }

  private notice(run: ReviewRun, outcome: ReviewNotice['outcome'], merged: boolean, pushed: boolean, reason?: string): ReviewNotice {
    return {
      runId: run.runId,
      ...(run.reviewerId ? { reviewerId: run.reviewerId } : {}),
      provider: run.provider,
      model: run.model,
      outcome,
      branch: run.branch,
      target: run.target,
      blocking: run.blocking,
      minor: run.minor,
      merged,
      pushed,
      ...(reason ? { reason } : {}),
      minutes: run.maxMinutes
    }
  }

  private row(sessionId: string, run: ReviewRun, outcome: ReviewNotice['outcome'], merged: boolean, pushed = false, reason?: string): ReviewNotice {
    const notice = this.notice(run, outcome, merged, pushed, reason)
    this.deps.registry.append(sessionId, {
      type: 'notice',
      kind: 'review',
      message: reviewLine(notice, label(run.provider, run.model)),
      review: notice
    })
    return notice
  }
}

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** Set by server/index.ts at boot; the app tools and the WS methods read it. */
let current: MergeReviews | null = null
export function setMergeReviews(m: MergeReviews | null): void {
  current = m
}
export function mergeReviews(): MergeReviews | null {
  return current
}

export { MergeRefusal }
