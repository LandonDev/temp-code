import { z } from 'zod'
import { REASONING_LEVELS } from './catalog'

/**
 * "New threads start on": which copy of a project linked across hosts a new
 * thread starts in when nothing on screen decides it. `box` is a host that is
 * not a Mac (the rule `settingsHomeOf` reads), `mac` a Mac. The global value
 * rides the thread defaults (one copy, on the box); a project may override it
 * (`ProjectMeta.startOn`, `project.setStartOn`).
 */
export const StartOnSchema = z.enum(['box', 'mac'])
export type StartOn = z.infer<typeof StartOnSchema>
export const DEFAULT_START_ON: StartOn = 'box'

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
  provider: z.enum(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx', 'muse']).default('claude'),
  /** model id; '' = the provider's catalog default */
  model: z.string().default(''),
  reasoning: z.enum(REASONING_LEVELS).default('medium'),
  /** security: safe = ask first, edits = auto-edits, auto = full access */
  permission: z.enum(['safe', 'edits', 'auto']).default('edits'),
  /** The host a new thread of a linked project starts on (`StartOnSchema`);
   *  only the global set's counts, absent = the box. */
  startOn: StartOnSchema.optional()
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
