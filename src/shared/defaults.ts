import { z } from 'zod'

/**
 * Thread defaults — what a NEW thread starts with when the user doesn't
 * choose otherwise: provider, model ('' = the provider's default),
 * reasoning effort, and the security policy. Stored like the
 * orchestration rules: a global set plus whole-object per-workspace
 * overrides in the settings table; session.create resolves them
 * server-side so every entry point (strip, plan handoff, future CLI)
 * gets the same answer.
 */
export const ThreadDefaultsSchema = z.object({
  provider: z.enum(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx']).default('claude'),
  /** model id; '' = the provider's catalog default */
  model: z.string().default(''),
  reasoning: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default('medium'),
  /** security: safe = ask first, edits = auto-edits, auto = full access */
  permission: z.enum(['safe', 'edits', 'auto']).default('edits')
})
export type ThreadDefaults = z.infer<typeof ThreadDefaultsSchema>

export const DEFAULT_THREAD_DEFAULTS: ThreadDefaults = {
  provider: 'claude',
  model: '',
  reasoning: 'medium',
  permission: 'edits'
}

/** Parse stored JSON; anything invalid falls back to null (scope unset). */
export function parseDefaults(raw: string | null): ThreadDefaults | null {
  if (!raw) return null
  try {
    return ThreadDefaultsSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}
