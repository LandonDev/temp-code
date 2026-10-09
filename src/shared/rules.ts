import { z } from 'zod'
import { CATALOG, modelInfo, type ProviderId, type Reasoning } from './catalog'

/**
 * Structured orchestration rules — objective settings, not prose. Two
 * halves: CONDUCT bounds what the orchestrator itself may do (enforced in
 * code where possible: tool denial, spawn caps), ROUTING is an ordered
 * table mapping kinds of work to an exact provider/model/effort. The
 * ability to spawn any model from any provider is app mechanics, baked
 * into the prompt — these rules only decide what gets picked.
 */

const ReasoningEnum = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/** Per-model spawn policy, keyed `provider:modelId` in rules.models.
 *  A missing entry means approved with the model's full effort ladder. */
export const ModelPolicySchema = z.object({
  approved: z.boolean().default(true),
  /** effort bounds, clamped to the model's ladder; absent = ladder end */
  minReasoning: ReasoningEnum.optional(),
  maxReasoning: ReasoningEnum.optional()
})
export type ModelPolicy = z.infer<typeof ModelPolicySchema>

export const RoutingRuleSchema = z.object({
  id: z.string(),
  /** when this rule applies — shown to the orchestrator verbatim */
  task: z.string(),
  provider: z.enum(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx']),
  /** model id; '' = the provider's default */
  model: z.string().default(''),
  reasoning: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default('medium'),
  enabled: z.boolean().default(true)
})
export type RoutingRule = z.infer<typeof RoutingRuleSchema>

export const OrchestrationRulesSchema = z.object({
  conduct: z.object({
    /** strict: delegate everything; balanced: trivial glue itself; free */
    delegation: z.enum(['strict', 'balanced', 'free']).default('strict'),
    /** may the orchestrator edit files itself? (enforced: tool denial) */
    selfEdit: z.boolean().default(false),
    /** may it run shell commands itself? (enforced: tool denial) */
    selfShell: z.boolean().default(true),
    /** verify subagent reports before relaying them */
    verifyResults: z.boolean().default(true),
    /** rerun weak output on a smarter model without asking */
    escalate: z.boolean().default(true),
    /** isolate writing subagents in git worktrees */
    useWorktrees: z.boolean().default(true),
    /** subagents running at once; 0 = unlimited (enforced in spawn_agent) */
    maxParallel: z.number().int().min(0).max(32).default(4),
    /** total subagents per thread; 0 = unlimited (enforced in spawn_agent) */
    maxAgents: z.number().int().min(0).max(200).default(0)
  }),
  /** subagent model policies by `provider:modelId`; {} = all approved */
  models: z.record(z.string(), ModelPolicySchema).default({}),
  routing: z.array(RoutingRuleSchema)
})
export type OrchestrationRules = z.infer<typeof OrchestrationRulesSchema>

// Defaults mirror the user's model policy (~/.claude/CLAUDE.md): gpt-5.5
// for bulk work (effectively free), taste ≥ 7 for anything user-facing
// with intelligence > taste > cost when axes conflict (→ fable-5),
// reviews by fable-5/opus-4.8 with gpt-5.5 as an optional independent
// second opinion. Never Haiku.
export const DEFAULT_RULES: OrchestrationRules = {
  conduct: {
    delegation: 'strict',
    selfEdit: false,
    selfShell: true,
    verifyResults: true,
    escalate: true,
    useWorktrees: true,
    maxParallel: 4,
    maxAgents: 0
  },
  models: {},
  routing: [
    {
      id: 'trivial',
      task: 'Trivial or small tasks — tiny fixes, renames, one-file changes',
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: 'low',
      enabled: true
    },
    {
      id: 'bulk',
      task: 'Bulk or mechanical work with a clear spec — implementation, migrations, data analysis',
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: 'medium',
      enabled: true
    },
    {
      id: 'user-facing',
      task: 'User-facing work — UI, copy, API design',
      provider: 'claude',
      model: 'claude-fable-5',
      reasoning: 'medium',
      enabled: true
    },
    {
      id: 'hard',
      task: 'Hard problems — debugging, architecture, novel design',
      provider: 'claude',
      model: 'claude-fable-5',
      reasoning: 'high',
      enabled: true
    },
    {
      id: 'review',
      task: 'Reviews of plans or implementations',
      provider: 'claude',
      model: 'claude-opus-4-8',
      reasoning: 'high',
      enabled: true
    },
    {
      id: 'second-opinion',
      task: 'Independent second review opinion, when one is wanted',
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: 'high',
      enabled: true
    }
  ]
}

/**
 * Per-thread tune, set when an orchestration thread is created: the
 * workspace/global rules stay the DEFAULT, each conduct setting can be
 * overridden for this one run, and free-text instructions ride along
 * into the orchestrator's prompt. Absent keys inherit.
 */
export const ThreadRulesSchema = z.object({
  // Spelled out rather than derived from OrchestrationRulesSchema: that
  // schema's .default()s would fill every missing key at parse time,
  // turning "inherit" into a frozen copy of today's defaults.
  conduct: z
    .object({
      delegation: z.enum(['strict', 'balanced', 'free']).optional(),
      selfEdit: z.boolean().optional(),
      selfShell: z.boolean().optional(),
      verifyResults: z.boolean().optional(),
      escalate: z.boolean().optional(),
      useWorktrees: z.boolean().optional(),
      maxParallel: z.number().int().min(0).max(32).optional(),
      maxAgents: z.number().int().min(0).max(200).optional()
    })
    .optional(),
  instructions: z.string().optional()
})
export type ThreadRules = z.infer<typeof ThreadRulesSchema>
export type ConductOverride = NonNullable<ThreadRules['conduct']>

/** The effective rules: base (workspace → global → defaults) with this
 *  thread's conduct overrides laid on top. Routing always inherits. */
export function mergeThreadRules(
  base: OrchestrationRules,
  tune: ThreadRules | null | undefined
): OrchestrationRules {
  if (!tune?.conduct || Object.keys(tune.conduct).length === 0) return base
  return { ...base, conduct: { ...base.conduct, ...tune.conduct } }
}

/** Parse a stored per-thread tune; invalid or empty → null. */
export function parseThreadRules(raw: string | null): ThreadRules | null {
  if (!raw) return null
  try {
    const t = ThreadRulesSchema.parse(JSON.parse(raw))
    const hasConduct = t.conduct && Object.keys(t.conduct).length > 0
    return hasConduct || t.instructions?.trim() ? t : null
  } catch {
    return null
  }
}

/** Parse stored JSON; anything invalid falls back to the defaults. */
export function parseRules(raw: string | null): OrchestrationRules | null {
  if (!raw) return null
  try {
    return OrchestrationRulesSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Model label helper for prompt text ('' = provider default). */
export function ruleModel(r: RoutingRule): string {
  return r.model || CATALOG[r.provider].defaultModel
}

// ── model policy (approved subagent models + effort bounds) ──────────

export const modelKey = (provider: ProviderId, modelId: string): string =>
  `${provider}:${modelId}`

export function modelApproved(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string
): boolean {
  return rules.models[modelKey(provider, modelId)]?.approved ?? true
}

/** The effort ladder the policy leaves open for a model — its catalog
 *  ladder sliced to [minReasoning, maxReasoning]. Bounds off the ladder
 *  (or crossed) are ignored rather than emptying it. */
export function approvedLadder(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string
): Reasoning[] {
  const ladder = modelInfo(provider, modelId)?.reasoning ?? []
  const p = rules.models[modelKey(provider, modelId)]
  if (!p || ladder.length === 0) return ladder
  let lo = p.minReasoning ? ladder.indexOf(p.minReasoning) : 0
  let hi = p.maxReasoning ? ladder.indexOf(p.maxReasoning) : ladder.length - 1
  if (lo < 0) lo = 0
  if (hi < 0) hi = ladder.length - 1
  return lo <= hi ? ladder.slice(lo, hi + 1) : ladder
}

/** Requested effort fitted to the approved ladder: kept when inside,
 *  clamped to the nearer bound when the model serves it outside the
 *  approved range, else the default (itself fitted). */
export function fitReasoning(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string,
  requested: string | undefined
): Reasoning {
  const ladder = approvedLadder(rules, provider, modelId)
  if (ladder.length === 0) return 'medium'
  if (requested && ladder.includes(requested as Reasoning)) return requested as Reasoning
  const full = modelInfo(provider, modelId)?.reasoning ?? []
  const want = requested && full.includes(requested as Reasoning) ? (requested as Reasoning) : null
  const pick = want ?? modelInfo(provider, modelId)?.defaultReasoning ?? ladder[0]
  const ix = full.indexOf(pick)
  if (ix >= 0 && ix < full.indexOf(ladder[0])) return ladder[0]
  if (ix > full.indexOf(ladder[ladder.length - 1])) return ladder[ladder.length - 1]
  return ladder.includes(pick) ? pick : ladder[0]
}
