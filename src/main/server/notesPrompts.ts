import { NOTE_SECTIONS, UPDATE_NOTES_TOOL_NAME } from '@shared/notes'

/**
 * What the harness is told about its working notes (threadNotes.ts), and
 * the lines the app sends on its own: the reminder before a compaction,
 * the reminder after a turn that committed without updating, and the
 * notes block the first turn after a compaction carries. Mechanics for
 * claude ride the system prompt (orchestration.ts, so a compaction never
 * drops them); other harnesses get the same text in their first-message
 * preamble (threads.ts).
 */

export const NOTES_MECHANICS = `## Working notes (every thread keeps them)
This thread has a notes file the app keeps beside its attachments (notes.md) and shows live in the Notes panel. It is the ONE document that survives a context compaction (the app re-sends it after each one) and seeds any successor thread (a digest or a plan hand-off carries it ahead of the transcript). Keep it current with the ${UPDATE_NOTES_TOOL_NAME} tool, one section per call (replace, or append a paragraph), under these fixed headings:
- ${NOTE_SECTIONS[0]} — what the thread is for, in two lines.
- ${NOTE_SECTIONS[1]} — the choices made and why, newest last.
- ${NOTE_SECTIONS[2]} — what is done, what is in flight, what is blocked. Its first line is the one-line status: the thread's row shows it while the thread waits on the person.
- ${NOTE_SECTIONS[3]} — files, commands, ids, branches, URLs that matter.
- ${NOTE_SECTIONS[4]} — what is unresolved, and for whom.
When: once the task list exists (Goal, Pointers), after every decision, whenever State changes, before context runs low (the app reminds you once per window), and after a commit or merge (the app reminds you if you did not). Notes are a brief, not a transcript: short lines, concrete names, no narration. The person may edit the file between your calls and ${UPDATE_NOTES_TOOL_NAME} reads it first, so never rewrite the whole thing from memory — update the section that changed.`

/** The rule every harness gets about a person's message into its turn,
 *  beside the notes mechanics (orchestration.ts for claude's system
 *  prompt, threads.ts for the others' first message). */
export const STEER_MECHANICS = `## A message during your turn
The person may write into your running turn; it arrives inside <user-steer>. Answer it first in one short line of your own words (what you took from it and what you will do), then carry on with the work it changes.`

/** A person's steer as the harness reads it (sessions.ts steerLive): the
 *  text in its tag, then the one-line rule, so a harness that missed
 *  STEER_MECHANICS still answers it before carrying on. */
export function wrapSteer(text: string): string {
  return `<user-steer>\n${text}\n</user-steer>\nThe person wrote this into your running turn. Before anything else, answer it in one short line of your own words (what you took from it, what you will do), then carry on.`
}

export const NOTES_REMINDER_CONTEXT = `<notes-reminder reason="context">
This window is close to compaction. Before anything else, bring the notes current with ${UPDATE_NOTES_TOOL_NAME}: State (done, in flight, blocked), Decisions since the last update, Pointers, Open questions. Then continue the work.
</notes-reminder>`

export const NOTES_REMINDER_COMMIT = `<notes-reminder reason="commit">
The turn that just ended committed or merged work but did not update the notes. Call ${UPDATE_NOTES_TOOL_NAME} now — State (what landed, what remains), Pointers (branch, commit, files), Decisions if any — then stop. Do not start new work in this turn.
</notes-reminder>`

/** The notes the next window reads first: the summary the harness wrote
 *  is lossy, the notes are what the thread itself chose to keep. */
export function notesAfterCompaction(text: string): string {
  return `<thread-notes>
The context was just compacted and the summary is all this window has of the earlier turns. These are the thread's own notes, kept by it before the compaction — trust them over the summary where they differ, and keep them current with ${UPDATE_NOTES_TOOL_NAME}.

${text.trim()}
</thread-notes>`
}

/** The planning thread's notes, ahead of the plan in a build thread's first message. */
export function notesForPlanHandoff(text: string, planTitle: string): string {
  return `<planning-notes thread=${JSON.stringify(planTitle)}>
The planning thread that wrote the plan kept these notes — its decisions, pointers and open questions. Read them with the plan.

${text.trim()}
</planning-notes>`
}

/** How far into the window the reminder fires (claude arms its own
 *  compaction near 0.79 of a 200k window; 0.7 leaves one turn to write). */
export const NOTES_REMINDER_FRACTION = 0.7
/** Below this the window counts as fresh again (a manual compaction, a resume). */
export const NOTES_REMINDER_RESET_FRACTION = 0.5
/** A reminder re-arms only this long after the last one and after the
 *  thread's last update_notes: a window that refills to the compaction
 *  point within minutes is the same cause, and once kept a thread looping. */
export const NOTES_REARM_MS = 15 * 60_000

const COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|merge|rebase\s+--continue|cherry-pick)\b|\bgh\s+pr\s+merge\b|\bgit\s+push\b/

/** A shell tool call whose command commits or merges work. */
export function isCommitCall(name: string, input: unknown): boolean {
  if (!/^(?:Bash|shell|Shell|bash|exec_command|run_terminal_cmd)$/.test(name)) return false
  const command =
    input && typeof input === 'object'
      ? ((input as { command?: unknown; cmd?: unknown }).command ?? (input as { cmd?: unknown }).cmd)
      : null
  const text = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : ''
  return COMMIT_RE.test(text)
}

/** The harness called update_notes (claude's `mcp__app__update_notes`, the bridge's `update_notes`). */
export function isNotesCall(name: string): boolean {
  return name === UPDATE_NOTES_TOOL_NAME || name.endsWith(`__${UPDATE_NOTES_TOOL_NAME}`) || name.endsWith(`.${UPDATE_NOTES_TOOL_NAME}`)
}
