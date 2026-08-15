import { z } from 'zod'
import { CATALOG } from './catalog'

/**
 * Structured orchestration rules — objective settings, not prose. Two
 * halves: CONDUCT bounds what the orchestrator itself may do (enforced in
 * code where possible: tool denial, spawn caps), ROUTING is an ordered
 * table mapping kinds of work to an exact provider/model/effort. The
 * ability to spawn any model from any provider is app mechanics, baked
 * into the prompt — these rules only decide what gets picked.
 */

export const RoutingRuleSchema = z.object({
  id: z.string(),
  /** when this rule applies — shown to the orchestrator verbatim */
  task: z.string(),
  provider: z.enum(['claude', 'codex', 'cursor']),
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
    /** isolate writing subagents in git worktrees */
    useWorktrees: z.boolean().default(true),
    /** subagents running at once; 0 = unlimited (enforced in spawn_agent) */
    maxParallel: z.number().int().min(0).max(32).default(4),
    /** total subagents per thread; 0 = unlimited (enforced in spawn_agent) */
    maxAgents: z.number().int().min(0).max(200).default(0)
  }),
  routing: z.array(RoutingRuleSchema)
})
export type OrchestrationRules = z.infer<typeof OrchestrationRulesSchema>

export const DEFAULT_RULES: OrchestrationRules = {
  conduct: {
    delegation: 'strict',
    selfEdit: false,
    selfShell: true,
    verifyResults: true,
    useWorktrees: true,
    maxParallel: 4,
    maxAgents: 0
  },
  routing: [
    {
      id: 'bulk',
      task: 'Bulk or mechanical work with a clear spec — migrations, wide refactors, data analysis',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'low',
      enabled: true
    },
    {
      id: 'user-facing',
      task: 'User-facing work — UI, copy, API design',
      provider: 'claude',
      model: 'claude-sonnet-5',
      reasoning: 'medium',
      enabled: true
    },
    {
      id: 'hard',
      task: 'Hard problems — debugging, architecture, novel design',
      provider: 'claude',
      model: 'claude-opus-5',
      reasoning: 'high',
      enabled: true
    },
    {
      id: 'quick-edit',
      task: 'Quick scoped edits — small fixes, renames, config tweaks',
      provider: 'cursor',
      model: 'composer-2.5',
      reasoning: 'medium',
      enabled: true
    },
    {
      id: 'review',
      task: 'Reviews of plans or implementations',
      provider: 'claude',
      model: 'claude-sonnet-5',
      reasoning: 'high',
      enabled: true
    }
  ]
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
