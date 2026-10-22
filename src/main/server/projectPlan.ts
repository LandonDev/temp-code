import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import type { MilestoneLink, ProjectPlanState, ProjectPlanTickAnswer } from '@shared/contract-projectplan'
import type { SessionMeta } from '@shared/events'
import {
  isProjectPlanPath,
  parseProjectPlan,
  projectPlanPathFor,
  setMilestoneDone,
  setPlanStatus
} from '@shared/projectPlan'
import type { Store } from './db'

/**
 * The project plan around its file (docs/PROJECT-PLAN.md): which project
 * keeps it pinned, which thread works which milestone, and the ticks. The
 * file is the one source of truth for the milestones and their done marks;
 * the settings table holds only the pin and the links.
 *
 *   projectPlan.pinned:<projectId>   '1' while "Keep as the project's plan"
 *   projectPlan.milestone:<sessionId> {"projectId","milestone"}
 */

const PIN_KEY = (projectId: string): string => `projectPlan.pinned:${projectId}`
const LINK_KEY = (sessionId: string): string => `projectPlan.milestone:${sessionId}`

export function milestoneLinkOf(store: Store, sessionId: string): MilestoneLink | null {
  const raw = store.getSetting(LINK_KEY(sessionId))
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as MilestoneLink
    return typeof v.projectId === 'string' && typeof v.milestone === 'number' ? v : null
  } catch {
    return null
  }
}

export function setMilestoneLink(store: Store, sessionId: string, link: MilestoneLink | null): void {
  store.setSetting(LINK_KEY(sessionId), link ? JSON.stringify(link) : null)
}

/** A build started from a plan carries the plan thread's milestone: the
 *  planning thread "Plan the next milestone" started links to milestone N,
 *  so the implementation (or orchestration) built from its plan does too,
 *  and landing that build ticks N. */
export function inheritMilestoneLink(store: Store, created: SessionMeta, planThread: SessionMeta | null | undefined): void {
  if (!planThread) return
  if (created.threadType !== 'implementation' && created.threadType !== 'orchestration') return
  const link = milestoneLinkOf(store, planThread.id)
  if (link && !milestoneLinkOf(store, created.id)) setMilestoneLink(store, created.id, link)
}

export interface ProjectPlanDeps {
  getProject: (projectId: string) => { id: string; cwd: string } | null
  sessionsOfProject: (projectId: string) => SessionMeta[]
  getSession: (sessionId: string) => SessionMeta | null
}

export class ProjectPlans {
  private listeners = new Set<(projectId: string) => void>()

  constructor(
    private readonly store: Store,
    private readonly deps: ProjectPlanDeps
  ) {}

  /** Fires after anything about a project's plan changed (pin, tick, completion). */
  onChange(listener: (projectId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(projectId: string): void {
    for (const l of this.listeners) l(projectId)
  }

  pathFor(projectId: string): string | null {
    const project = this.deps.getProject(projectId)
    return project ? projectPlanPathFor(project.cwd) : null
  }

  read(projectId: string): string | null {
    const path = this.pathFor(projectId)
    if (!path || !existsSync(path)) return null
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }

  /** The newest project-plan thread of the project, archived or not. */
  threadOf(projectId: string): SessionMeta | null {
    const threads = this.deps
      .sessionsOfProject(projectId)
      .filter((s) => s.threadType === 'project-plan' && !s.parentId)
      .sort((a, b) => b.createdAt - a.createdAt)
    return threads[0] ?? null
  }

  pinned(projectId: string): boolean {
    return this.store.getSetting(PIN_KEY(projectId)) === '1'
  }

  state(projectId: string): ProjectPlanState | null {
    const path = this.pathFor(projectId)
    if (!path) return null
    const text = this.read(projectId)
    const thread = this.threadOf(projectId)
    if (text === null && !thread) return null
    const plan = text === null ? null : parseProjectPlan(text)
    return {
      projectId,
      path,
      exists: text !== null,
      pinned: this.pinned(projectId),
      sessionId: thread?.id ?? null,
      complete: plan?.status === 'complete',
      milestones: (plan?.milestones ?? []).map((m) => ({ index: m.index, title: m.title, done: m.done })),
      missing: plan ? [...plan.missing] : []
    }
  }

  pin(projectId: string, pinned: boolean): ProjectPlanState | null {
    if (!this.deps.getProject(projectId)) throw new Error(`unknown project: ${projectId}`)
    this.store.setSetting(PIN_KEY(projectId), pinned ? '1' : null)
    this.changed(projectId)
    return this.state(projectId)
  }

  /** Tick one milestone in the file; false when the file or the milestone is missing. */
  tick(projectId: string, milestone: number, done: boolean): boolean {
    const path = this.pathFor(projectId)
    const text = this.read(projectId)
    if (!path || text === null) return false
    const next = setMilestoneDone(text, milestone, done)
    if (next === text) return parseProjectPlan(text).milestones.some((m) => m.index === milestone && m.done === done)
    writeFileSync(path, next)
    this.changed(projectId)
    return true
  }

  link(sessionId: string, link: MilestoneLink): void {
    if (!this.deps.getSession(sessionId)) throw new Error(`unknown session: ${sessionId}`)
    if (!this.deps.getProject(link.projectId)) throw new Error(`unknown project: ${link.projectId}`)
    setMilestoneLink(this.store, sessionId, link)
  }

  linkOf(sessionId: string): MilestoneLink | null {
    return milestoneLinkOf(this.store, sessionId)
  }

  /** A build landed on the project's branch (project.mergeInto succeeded):
   *  every implementation or orchestration thread of the project that works
   *  a milestone ticks it. Returns the milestones ticked. */
  landed(projectId: string): number[] {
    const text = this.read(projectId)
    if (text === null) return []
    const done = new Set(parseProjectPlan(text).milestones.filter((m) => m.done).map((m) => m.index))
    const ticked: number[] = []
    for (const s of this.deps.sessionsOfProject(projectId)) {
      if (s.parentId || (s.threadType !== 'implementation' && s.threadType !== 'orchestration')) continue
      const link = milestoneLinkOf(this.store, s.id)
      if (!link || link.projectId !== projectId || done.has(link.milestone)) continue
      if (this.tick(projectId, link.milestone, true)) {
        ticked.push(link.milestone)
        done.add(link.milestone)
      }
    }
    return ticked
  }

  /** The thread says its plan is done. A project plan gets `status:
   *  complete` in its frontmatter (the options card and the project header
   *  read nothing else); an ordinary plan is acknowledged. Never starts a
   *  thread of any kind. */
  complete(sessionId: string): string {
    const session = this.deps.getSession(sessionId)
    if (!session) return `refused: unknown session "${sessionId}"`
    if (session.threadType !== 'project-plan') {
      return session.threadType === 'planning'
        ? 'noted: the plan is marked complete; the user starts the build from the plan header.'
        : `refused: plan_complete is for planning and project-plan threads, not a ${session.threadType ?? 'chat'} thread.`
    }
    const path = session.planPath
    if (!path || !isProjectPlanPath(path)) return `refused: this thread has no project plan file.`
    if (!existsSync(path)) return `refused: ${path} does not exist yet — write the plan first.`
    const text = readFileSync(path, 'utf8')
    const plan = parseProjectPlan(text)
    if (plan.missing.length) {
      return `refused: the plan lacks the section${plan.missing.length > 1 ? 's' : ''} ${plan.missing.map((m) => `## ${m}`).join(', ')}. Add them, then call plan_complete again.`
    }
    if (plan.milestones.length === 0) {
      return 'refused: ## Milestones has no `### [ ] N. <title>` milestone yet. Add at least one, then call plan_complete again.'
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, setPlanStatus(text, 'complete'))
    if (session.projectId) this.changed(session.projectId)
    const n = plan.milestones.length
    return `The project plan is complete: ${n} milestone${n === 1 ? '' : 's'}. Stop here — the user picks the next milestone from the plan's options; nothing starts from this thread.`
  }
}

export function handleProjectPlan(
  req: ClientRequest,
  plans: ProjectPlans
): { handled: true; result: unknown } | { handled: false } {
  // The answers are typed against the contract's schemas: the phone decodes
  // these shapes from the generated Swift, so a drift here fails typecheck.
  switch (req.method) {
    case 'projectPlan.get': {
      const answer: ProjectPlanState | null = plans.state(req.params.projectId)
      return { handled: true, result: answer }
    }
    case 'projectPlan.pin': {
      const answer: ProjectPlanState | null = plans.pin(req.params.projectId, req.params.pinned)
      return { handled: true, result: answer }
    }
    case 'projectPlan.tick': {
      const ticked = plans.tick(req.params.projectId, req.params.milestone, req.params.done)
      const answer: ProjectPlanTickAnswer = { ticked, state: plans.state(req.params.projectId) }
      return { handled: true, result: answer }
    }
    case 'projectPlan.link':
      plans.link(req.params.sessionId, { projectId: req.params.projectId, milestone: req.params.milestone })
      return { handled: true, result: null }
    case 'projectPlan.linkOf':
      return { handled: true, result: plans.linkOf(req.params.sessionId) }
    default:
      return { handled: false }
  }
}
