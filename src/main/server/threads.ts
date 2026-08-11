import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta } from '@shared/events'

/**
 * Thread-type behavior. Provider-agnostic: instead of per-driver system
 * prompts, the registry prefixes the FIRST message of a thread with a
 * preamble (the visible user-text event carries only what the user typed).
 */

export const PLANS_DIR = join(homedir(), '.temp-code', 'plans')

export const planPathFor = (sessionId: string): string => join(PLANS_DIR, `${sessionId}.md`)

export function threadPreamble(session: SessionMeta): string | null {
  switch (session.threadType) {
    case 'planning':
      return `You are running a PLANNING thread. Your deliverable is a plan document, not code.
Write the full plan to ${planPathFor(session.id)} (create parent directories) as soon as you have a first draft, and keep that file updated with Edit as the discussion evolves — it is rendered live to the user.
Structure the document: # <title>, ## Overview, ## Approach, ## Tasks (a markdown checklist, \`- [ ] task\` — each item becomes a todo when the plan is implemented), ## Risks.
Explore the codebase as needed, ask clarifying questions, but never implement anything in this thread.`
    case 'implementation':
      return `You are running an IMPLEMENTATION thread. Before touching code, create a todo list covering the whole task (TodoWrite or your plan tool) and keep statuses current as you work — exactly one item in_progress at a time; the UI renders your progress from it.`
    default:
      return null
  }
}

/** Extra first-message context when a thread is seeded from a plan file. */
export function planSeed(planPath: string): string {
  return `The plan for this work is in ${planPath}. Read it first; its ## Tasks section is your task list.`
}
