import { z } from 'zod'
import type { Reasoning } from './catalog'
import type { SessionMeta } from './events'

/**
 * Plan settings — what happens when a planning thread's plan is complete
 * (the planner calls `plan_complete`, and the thread settles). Stored like
 * the thread defaults: a global set plus whole-object per-project
 * overrides in the settings table (`plans`, `plans:project:<id>`), resolved
 * server-side so every entry point gets the same answer.
 */
export const PlanSettingsSchema = z.object({
  /** Start the implementation thread the moment the plan is complete. */
  autoImplement: z.boolean().default(true),
  /** Archive the planning thread once its build has started. */
  archiveAfterStart: z.boolean().default(true),
  /** Model for the build; '' = the planning thread's own. */
  implementModel: z.string().default(''),
  /** Reasoning for the build; '' = the planning thread's own. */
  implementReasoning: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default(''),
  /** Context window for the build: '' = the planning thread's own, '1m' or '200k'. */
  implementContext: z.enum(['', '1m', '200k']).default('')
})
export type PlanSettings = z.infer<typeof PlanSettingsSchema>

/** What `plans.get` answers: the set a scope runs under, and whether the
 *  scope has its own (the phone's generated contract pins this shape). */
export const PlanScopeSchema = z.object({ settings: PlanSettingsSchema, overridden: z.boolean() })
export type PlanScope = z.infer<typeof PlanScopeSchema>

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  autoImplement: true,
  archiveAfterStart: true,
  implementModel: '',
  implementReasoning: '',
  implementContext: ''
}

/** Parse stored JSON; anything invalid falls back to null (scope unset). */
export function parsePlanSettings(raw: string | null): PlanSettings | null {
  if (!raw) return null
  try {
    return PlanSettingsSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/** The run settings an implementation thread inherits from its plan thread:
 *  the same model, effort and context window unless a plans.implement*
 *  setting fixes one. A fixed model names its provider through the
 *  catalog later (resolveModel); here it is just the id. */
export function buildSpecFor(
  plan: Pick<SessionMeta, 'provider' | 'model' | 'reasoning' | 'context1m'>,
  settings: PlanSettings
): { provider: SessionMeta['provider']; model: string; reasoning: Reasoning; context1m: boolean } {
  return {
    provider: plan.provider,
    model: settings.implementModel || plan.model,
    reasoning: (settings.implementReasoning || plan.reasoning) as Reasoning,
    context1m:
      settings.implementContext === '1m' ? true : settings.implementContext === '200k' ? false : plan.context1m
  }
}

/** The implementation thread's title: the plan's own, without a "Plan:" prefix. */
export function buildTitleFor(planTitle: string, planHeading?: string | null): string {
  const base = (planHeading?.trim() || planTitle).replace(/^Plan:?\s*/i, '').trim()
  return base || 'Implementation'
}

/** The first `# heading` of a plan document, if any. */
export function planHeadingOf(doc: string): string | null {
  const m = doc.match(/^#\s+(.+?)\s*$/m)
  return m ? m[1].trim() : null
}

/** The notice the thread that started a plan receives when the plan is
 *  complete: what finished, where the file is, and whether a build runs. */
export function planDoneNotice(args: {
  title: string
  planPath: string
  planId: string
  implementation: { id: string; host: string } | null
  autoImplement: boolean
}): string {
  const tail = args.implementation
    ? `Implementation thread ${args.implementation.id} started on ${args.implementation.host}.`
    : args.autoImplement
      ? 'The implementation thread could not be started; start it from the plan view.'
      : 'Waiting for you to start it (app_start_thread with this plan, or the plan view).'
  return `Plan "${args.title}" is done: ${args.planPath}. ${tail}`
}
