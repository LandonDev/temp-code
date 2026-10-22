import { existsSync, readFileSync } from 'node:fs'
import { modelInfo, resolveModel, supportsContext1m, type ProviderId, type Reasoning } from '@shared/catalog'
import type { CreateSessionInput } from '@shared/contract'
import type { AgentEvent, Attachment, SessionMeta } from '@shared/events'
import type { ThreadRules } from '@shared/rules'
import {
  buildSpecFor,
  buildTitleFor,
  DEFAULT_PLAN_SETTINGS,
  parsePlanSettings,
  planDoneNotice,
  planHeadingOf,
  type PlanSettings
} from '@shared/plans'

/**
 * The plan flow: what happens once a planning thread's plan is complete.
 *
 * "Complete" is not a guess from the transcript. The planning mechanics
 * tell the planner to call the `plan_complete` app tool when the plan is
 * written and every decision is settled; that call stamps
 * `planCompletedAt` on the thread (refused while the plan file is missing
 * or empty). The flow then fires when that thread next SETTLES (idle or
 * watching) — never mid-turn, so the planner's closing message lands and
 * nothing stops the harness while it still speaks — and, with
 * `plans.autoImplement` on, starts the implementation thread: same host,
 * same cwd, the plan's own model, effort and context window unless a
 * `plans.implement*` setting fixes one, the plan file as planPath, the plan
 * thread seeded as a thread reference (its digest, and the notes a thread
 * keeps), titled from the plan's heading. The plan thread records the
 * build in `implementationId`, keeps a `plan-handoff` row pointing at it,
 * and is archived when `plans.archiveAfterStart` is on; the build points
 * back through `planThreadId`.
 *
 * Whoever started the plan hears about it: a thread that started it
 * through app_start_thread (`startedBy`) or spawned it (`parentId`) gets a
 * `<subagent-report>`-shaped wake through the same channel subagent
 * settles use; a person-started plan reaches the person through the
 * notifier's finished notice and the tab's "Plan ready" mark.
 *
 * Every entry point starts a build through `implementPlan`: the auto path,
 * the plan view's Start, `plan.implement` over the wire. A thread created
 * by hand with a planPath (the phone's sheet, app_start_thread) still links
 * both ways through `linkPlanHandoff`, which `create()` runs for every
 * build thread born with a plan.
 */

export interface PlanFlowRegistry {
  get(sessionId: string): SessionMeta | null
  listSessions(): SessionMeta[]
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
  create(input: CreateSessionInput): Promise<SessionMeta>
  send(sessionId: string, text: string, opts?: { attachments?: Attachment[] }): Promise<void>
  patch(
    sessionId: string,
    patch: Partial<Pick<SessionMeta, 'planCompletedAt' | 'implementationId' | 'planThreadId'>>
  ): SessionMeta | null
  append(sessionId: string, event: AgentEvent): void
  setArchived(sessionId: string, archived: boolean): Promise<void>
  deliverAgentReport(sessionId: string, report: { agentId: string; title: string; status: string; text: string }): void
  /** This host's name, as the notice names it. */
  hostName(): string
  log?(line: string): void
}

export interface ImplementOptions {
  provider?: ProviderId
  model?: string
  reasoning?: Reasoning
  context1m?: boolean
  permission?: SessionMeta['permission']
  threadType?: 'implementation' | 'orchestration'
  goal?: string
  threadRules?: ThreadRules
}

const LIVE = new Set<SessionMeta['status']>(['starting', 'running'])

/** The brief the build opens with — the plan file is the real brief. */
export const IMPLEMENT_BRIEF = (title: string): string => `Implement the plan "${title}".`
export const ORCHESTRATE_BRIEF = 'Orchestrate implementation of the plan across subagents.'

/** The goal a build works toward, from the plan's checklist. */
export function goalFor(doc: string): string {
  return countTasks(doc) > 0
    ? "Every task in the plan's checklist is checked off and typecheck passes"
    : 'The plan is fully implemented and typecheck passes'
}

/** `- [ ]` / `- [x]` lines: the plan's tasks. */
export function countTasks(doc: string): number {
  return doc.split('\n').filter((line) => /^\s*[-*]\s+\[[ xX]\]\s+\S/.test(line)).length
}

/** The plan document, or null when the file is missing or blank. */
export function readPlanDoc(planPath: string | null | undefined): string | null {
  if (!planPath || !existsSync(planPath)) return null
  try {
    const doc = readFileSync(planPath, 'utf8')
    return doc.trim() ? doc : null
  } catch {
    return null
  }
}

// ── settings ──────────────────────────────────────────────────────────

const settingsKey = (projectId: string | null): string => (projectId ? `plans:project:${projectId}` : 'plans')

/** The set stored at a scope (null = unset there). */
export function getPlanSettings(reg: Pick<PlanFlowRegistry, 'getSetting'>, projectId: string | null): PlanSettings | null {
  return parsePlanSettings(reg.getSetting(settingsKey(projectId)))
}

export function setPlanSettings(
  reg: Pick<PlanFlowRegistry, 'setSetting'>,
  projectId: string | null,
  settings: PlanSettings | null
): void {
  reg.setSetting(settingsKey(projectId), settings ? JSON.stringify(settings) : null)
}

/** What applies to a project: its override, else the global set, else the defaults. */
export function resolvePlanSettings(reg: Pick<PlanFlowRegistry, 'getSetting'>, projectId: string | null): PlanSettings {
  return (
    (projectId ? getPlanSettings(reg, projectId) : null) ??
    getPlanSettings(reg, null) ??
    DEFAULT_PLAN_SETTINGS
  )
}

// ── the planner says the plan is done ─────────────────────────────────

export type CompleteResult =
  | { ok: true; planPath: string; title: string; implementationId: string | null; next: string }
  | string

/** `plan_complete`: stamp the thread, and tell the planner what follows.
 *  Refused outside a planning thread and while the plan file is empty. A
 *  thread that is not mid-turn (the bridge after a settle) fires the flow
 *  at once; a running one fires when its turn settles. */
export async function completePlan(
  reg: PlanFlowRegistry,
  sessionId: string,
  args: { summary?: string } = {}
): Promise<CompleteResult> {
  const meta = reg.get(sessionId)
  if (!meta) return `refused: unknown session "${sessionId}".`
  if (meta.threadType !== 'planning' || !meta.planPath) {
    return 'refused: plan_complete is for planning threads — this thread has no plan document.'
  }
  const doc = readPlanDoc(meta.planPath)
  if (!doc) {
    return `refused: the plan file ${meta.planPath} is missing or empty — write the full plan there first, then call plan_complete.`
  }
  const title = buildTitleFor(meta.title, planHeadingOf(doc))
  const existing = meta.implementationId ? reg.get(meta.implementationId) : null
  if (existing && !existing.archived) {
    return {
      ok: true,
      planPath: meta.planPath,
      title,
      implementationId: existing.id,
      next: `already complete: implementation thread ${existing.id} ("${existing.title}") is working this plan.`
    }
  }
  const stamped = reg.patch(sessionId, { planCompletedAt: meta.planCompletedAt ?? Date.now() }) ?? meta
  if (args.summary?.trim()) reg.log?.(`[plans] ${sessionId} complete: ${args.summary.trim()}`)
  const settings = resolvePlanSettings(reg, meta.projectId)
  if (!LIVE.has(stamped.status)) {
    const impl = await settlePlan(reg, stamped)
    return {
      ok: true,
      planPath: meta.planPath,
      title,
      implementationId: impl?.id ?? null,
      next: impl
        ? `implementation thread ${impl.id} ("${impl.title}") started on ${reg.hostName()}.`
        : settings.autoImplement
          ? 'the implementation thread could not be started; the person starts it from the plan view.'
          : 'auto-start is off here: the person starts the build from the plan view (or you, with app_start_thread, only if they asked).'
    }
  }
  return {
    ok: true,
    planPath: meta.planPath,
    title,
    implementationId: null,
    next: settings.autoImplement
      ? `the implementation thread starts on ${reg.hostName()} the moment this turn ends — say the plan is ready and STOP; do not start it yourself.`
      : 'auto-start is off here: say the plan is ready and STOP; the person starts the build from the plan view (or you, with app_start_thread, only if they asked).'
  }
}

/** A planning thread took input again after completing: the plan is open
 *  once more until the planner calls plan_complete anew. A plan whose build
 *  already started keeps its mark. */
export function reopenPlan(reg: Pick<PlanFlowRegistry, 'patch'>, meta: SessionMeta): void {
  if (meta.threadType === 'planning' && meta.planCompletedAt && !meta.implementationId) {
    reg.patch(meta.id, { planCompletedAt: null })
  }
}

// ── the thread settled with a complete plan ───────────────────────────

const settling = new Set<string>()
const autoStarts = new Set<string>()

/** Whether a status change is the settle the flow waits for. */
export function isPlanSettle(
  before: SessionMeta['status'] | undefined,
  after: SessionMeta['status'],
  next: SessionMeta | null
): boolean {
  return (
    !!next &&
    next.threadType === 'planning' &&
    !!next.planCompletedAt &&
    !next.implementationId &&
    (before === 'running' || before === 'starting') &&
    (after === 'idle' || after === 'watching')
  )
}

/** The flow itself: start the build when the settings say so, then tell
 *  whoever started the plan. Returns the build thread, if one started. */
export async function settlePlan(reg: PlanFlowRegistry, meta: SessionMeta): Promise<SessionMeta | null> {
  if (settling.has(meta.id)) return null
  settling.add(meta.id)
  try {
    const settings = resolvePlanSettings(reg, meta.projectId)
    let impl: SessionMeta | null = null
    if (settings.autoImplement) {
      try {
        impl = await implementPlan(reg, meta.id, {}, 'auto')
      } catch (err) {
        reg.log?.(`[plans] auto-start of plan ${meta.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    notifyStarter(reg, reg.get(meta.id) ?? meta, impl, settings)
    return impl
  } finally {
    settling.delete(meta.id)
  }
}

/** The thread that started this plan (app_start_thread's caller, else a
 *  parent) hears the outcome the way it hears a subagent settle. */
export function notifyStarter(
  reg: PlanFlowRegistry,
  plan: SessionMeta,
  impl: SessionMeta | null,
  settings: PlanSettings
): boolean {
  const targetId = plan.startedBy ?? plan.parentId
  if (!targetId) return false
  const target = reg.get(targetId)
  if (!target || target.archived) return false
  const doc = readPlanDoc(plan.planPath)
  const title = buildTitleFor(plan.title, doc ? planHeadingOf(doc) : null)
  const notice = planDoneNotice({
    title,
    planPath: plan.planPath ?? '',
    planId: plan.id,
    implementation: impl ? { id: impl.id, host: reg.hostName() } : null,
    autoImplement: settings.autoImplement
  })
  reg.deliverAgentReport(targetId, {
    agentId: plan.id,
    title: plan.title,
    status: impl ? 'done' : 'idle',
    text: `<subagent-report>\nAutomatic notification: planning thread "${plan.title}" (${plan.id}) completed its plan.\n${notice}\nRead the plan with app_read_thread or the file; ${impl ? 'follow the build with app_read_thread.' : 'start the build with app_start_thread only if the person asked for it.'} Continue your work accordingly — do not reply to this notification itself.\n</subagent-report>`
  })
  return true
}

// ── starting the build ────────────────────────────────────────────────

/** Start the implementation thread from a plan: the plan's own run
 *  settings unless a plans.implement* setting or an explicit override
 *  fixes one; the plan file as planPath; the plan thread seeded; titled
 *  from the plan's heading. Idempotent: a plan whose build is live
 *  answers that build. */
export async function implementPlan(
  reg: PlanFlowRegistry,
  planId: string,
  opts: ImplementOptions = {},
  how: 'auto' | 'manual' = 'manual'
): Promise<SessionMeta> {
  const plan = reg.get(planId)
  if (!plan) throw new Error(`unknown session: ${planId}`)
  if (plan.threadType !== 'planning' || !plan.planPath) throw new Error('not a planning thread')
  const existing = plan.implementationId ? reg.get(plan.implementationId) : null
  if (existing && !existing.archived) return existing
  const doc = readPlanDoc(plan.planPath)
  if (!doc) throw new Error(`the plan file ${plan.planPath} is missing or empty`)
  const settings = resolvePlanSettings(reg, plan.projectId)
  const spec = buildSpecFor(plan, settings)
  // A fixed model may belong to another provider: the id names its harness.
  const routed = resolveModel(opts.provider ?? spec.provider, opts.model ?? spec.model)
  const info = modelInfo(routed.provider, routed.model)
  let reasoning = opts.reasoning ?? spec.reasoning
  if (info && info.reasoning.length && !info.reasoning.includes(reasoning)) {
    reasoning = (info.defaultReasoning ?? info.reasoning[0]) as Reasoning
  }
  const context1m = (opts.context1m ?? spec.context1m) && supportsContext1m(routed.provider, routed.model)
  const threadType = opts.threadType ?? 'implementation'
  const title = buildTitleFor(plan.title, planHeadingOf(doc))
  if (how === 'auto') autoStarts.add(plan.id)
  try {
    const created = await reg.create({
      provider: routed.provider,
      model: routed.model,
      reasoning,
      ...(context1m ? { context1m: true } : {}),
      permission: opts.permission ?? plan.permission,
      projectId: plan.projectId,
      workspaceId: plan.workspaceId,
      ...(plan.projectId ? {} : { cwd: plan.cwd }),
      threadType,
      planPath: plan.planPath,
      title,
      goal: opts.goal ?? goalFor(doc),
      ...(threadType === 'orchestration' && opts.threadRules ? { threadRules: opts.threadRules } : {}),
      // A plan child's build stays in the batch (CLAUDE.md "Master threads"):
      // the master's id and the sibling it waited for travel, and the master
      // that started the plan hears the build's settles as it heard the plan's.
      ...(plan.masterId ? { masterId: plan.masterId } : {}),
      ...(plan.after ? { after: plan.after } : {}),
      ...(plan.startedBy ? { startedBy: plan.startedBy } : {}),
      parentId: null
    })
    await reg.send(created.id, threadType === 'orchestration' ? ORCHESTRATE_BRIEF : IMPLEMENT_BRIEF(title), {
      attachments: [{ path: `thread:${plan.id}`, name: plan.title, kind: 'thread', sessionId: plan.id }]
    })
    return reg.get(created.id) ?? created
  } finally {
    autoStarts.delete(plan.id)
  }
}

/** Every build thread born with a plan links to the planning thread that
 *  owns the file (and back), leaves a handoff row on it, and archives it
 *  when the settings say so — unless the planner is still mid-turn, in
 *  which case the plan stays until it settles (nothing stops a harness
 *  while it speaks). Runs inside create(), so the phone's sheet and
 *  app_start_thread link exactly as the auto path does. */
export function linkPlanHandoff(reg: PlanFlowRegistry, created: SessionMeta): void {
  if (!created.planPath || (created.threadType !== 'implementation' && created.threadType !== 'orchestration')) return
  const plan = reg
    .listSessions()
    .filter((s) => s.threadType === 'planning' && s.planPath === created.planPath && s.id !== created.id)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt)[0]
  if (!plan) return
  reg.patch(created.id, { planThreadId: plan.id })
  // The first build owns the link; a second one started by hand leaves it.
  const linked = plan.implementationId ? reg.get(plan.implementationId) : null
  if (!linked || linked.archived) {
    reg.patch(plan.id, { implementationId: created.id, planCompletedAt: plan.planCompletedAt ?? Date.now() })
  }
  reg.append(plan.id, {
    type: 'plan-handoff',
    sessionId: created.id,
    title: created.title,
    how: autoStarts.has(plan.id) ? 'auto' : 'manual'
  })
  const settings = resolvePlanSettings(reg, plan.projectId)
  if (settings.archiveAfterStart && !plan.archived && !LIVE.has(plan.status)) {
    void reg.setArchived(plan.id, true)
  }
}

/** Test seam: forget in-flight state between cases. */
export function resetPlanFlowForTests(): void {
  settling.clear()
  autoStarts.clear()
}
