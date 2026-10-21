import { z } from 'zod'

/**
 * The project plan over the wire (docs/PROJECT-PLAN.md): one file per
 * project that a `project-plan` thread writes, which the project header
 * pins and whose milestones tick as their builds land. The file itself
 * comes through `file.read` like every plan; these methods carry the state
 * around it: pinned or not, the thread that wrote it, and the ticks.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const ProjectPlanMilestoneSchema = z.object({
  index: z.number().int(),
  title: z.string(),
  done: z.boolean()
})
export type ProjectPlanMilestone = z.infer<typeof ProjectPlanMilestoneSchema>

/** What `projectPlan.get` answers; null when the project has no plan file and no plan thread. */
export const ProjectPlanStateSchema = z.object({
  projectId: z.string(),
  /** the plan file, whether or not it exists yet */
  path: z.string(),
  exists: z.boolean(),
  /** "Keep as the project's plan" was chosen */
  pinned: z.boolean(),
  /** the newest project-plan thread of the project, archived or not */
  sessionId: z.string().nullable(),
  /** the thread called plan_complete (frontmatter status) */
  complete: z.boolean(),
  milestones: z.array(ProjectPlanMilestoneSchema),
  /** the fixed sections the document still lacks */
  missing: z.array(z.string())
})
export type ProjectPlanState = z.infer<typeof ProjectPlanStateSchema>

/** A thread's link to one milestone of its project's plan: the planning
 *  thread "Plan the next milestone" started, the orchestration thread for a
 *  milestone, and every build started from such a plan. */
export const MilestoneLinkSchema = z.object({ projectId: z.string(), milestone: z.number().int() })
export type MilestoneLink = z.infer<typeof MilestoneLinkSchema>

export const ProjectPlanRequestSchemas = [
  request('projectPlan.get', z.object({ projectId: z.string() })),
  request('projectPlan.pin', z.object({ projectId: z.string(), pinned: z.boolean() })),
  // Tick (or untick) one milestone by hand; the build that lands ticks on its own.
  request(
    'projectPlan.tick',
    z.object({ projectId: z.string(), milestone: z.number().int().positive(), done: z.boolean() })
  ),
  // Remember which milestone a thread works: a build started from that
  // thread's plan inherits it, and landing the build ticks it.
  request('projectPlan.link', z.object({ sessionId: z.string(), projectId: z.string(), milestone: z.number().int().positive() })),
  request('projectPlan.linkOf', z.object({ sessionId: z.string() }))
] as const
