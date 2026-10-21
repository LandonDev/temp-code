/**
 * Project preambles, the pure part: what the renderer's editor and the
 * main process's start path share (src/main/server/projectPreamble.ts
 * decides and applies; src/renderer/src/chrome/PreambleDialog.tsx edits).
 */
import type { ProjectMeta, WorkspaceMeta } from './domain'
import type { PreambleStamp } from './events'

export const PREAMBLE_HEADING = '## Project rules'
export const TASK_HEADING = '## The task'

/** The variables a preamble may name; substituted once, at start. */
export interface PreambleVars {
  /** a slug from the thread's title, for the worktree and branch name */
  worktree: string
  /** the project's name */
  project: string
  /** the host the thread runs on (its machine name) */
  host: string
}

export const PREAMBLE_VARIABLES: { name: keyof PreambleVars; meaning: string }[] = [
  { name: 'worktree', meaning: 'a slug from the thread title' },
  { name: 'project', meaning: 'the project name' },
  { name: 'host', meaning: 'the machine the thread runs on' }
]

/** Longest slug: a branch and a worktree dir name that stay readable. */
const SLUG_MAX = 40

/** `Project preambles: house rules once` → `project-preambles-house-rules-once`.
 *  Lowercase ASCII words joined by dashes, cut at a word boundary under
 *  SLUG_MAX; a title with no word at all gives `thread`. */
export function worktreeSlug(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  let out = ''
  for (const w of words) {
    const next = out ? `${out}-${w}` : w
    if (next.length > SLUG_MAX) {
      if (!out) out = w.slice(0, SLUG_MAX)
      break
    }
    out = next
  }
  return out || 'thread'
}

/** Words as a person counts them: runs of non-whitespace. */
export function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** `{{name}}` (spaces inside the braces allowed) → the variable; an
 *  unknown name stays as written, so a stray brace pair never vanishes. */
export function substitutePreamble(template: string, vars: PreambleVars): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name: string) =>
    name === 'worktree' || name === 'project' || name === 'host' ? vars[name] : whole
  )
}

/** Stored text as the editor saves it: trimmed, null when empty. */
export function normalizePreamble(text: string | null | undefined): string | null {
  const t = text?.replace(/\r\n/g, '\n').trim()
  return t ? t : null
}

/** The template that applies to a project: its own text when it has one
 *  (and is enabled), else the workspace default (when enabled). A project
 *  switched off carries nothing, whatever the workspace says. */
export function effectivePreamble(
  project: ProjectMeta | null | undefined,
  workspace: WorkspaceMeta | null | undefined
): string | null {
  if (!project) return null
  if (project.preambleEnabled === false) return null
  const own = normalizePreamble(project.preamble)
  if (own) return own
  if (!workspace || workspace.preambleEnabled === false) return null
  return normalizePreamble(workspace.preamble)
}

/** What the harness reads: the rules as their own block, then the task. */
export function composePreambled(stamp: PreambleStamp, task: string): string {
  return `${PREAMBLE_HEADING}\n\n${stamp.text}\n\n${TASK_HEADING}\n\n${task}`
}

export function stampOf(text: string): PreambleStamp {
  return { text, words: wordCount(text) }
}
