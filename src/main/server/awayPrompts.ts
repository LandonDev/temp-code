import { NOTE_DECISION_TOOL_NAME } from '@shared/away'

/**
 * What a harness is told about Away from computer (away.ts): the mechanics
 * every thread carries (claude's system prompt through mechanicsFor, other
 * harnesses' first message through threads.ts), the block whispered into a
 * running turn on each flip and caught up at a thread's next turn
 * (sessions.ts awayChanged, takeNotices), and the host's own answers to a
 * question or an approval while the person is away (sessions.ts interceptAway).
 */

export const AWAY_ON = `<away state="on">
The person is away from the computer until further notice and wants the work finished without them.
Do not ask questions. Decide from the scope you were given, the code and the project's notes, and keep going. Call ${NOTE_DECISION_TOOL_NAME} once for each choice you would have asked about: one line saying what you chose and why.
Do not stop to wait for the person, and do not end a turn with "let me know" or "when you're back". Find a way to finish.
Approvals your permission mode would ask about are denied while they are away. Prefer ways that need none: work inside your worktree, read instead of write, do a dry run. If the work truly needs one, finish everything around it and say what is left in your report.
For anything that needs the screen, the iOS simulator, a browser or a Mac app, spawn a gpt-6.1-sol subagent on the Mac with spawn_agent (environmentId "mac"; leave it out when you already run on the Mac) and tell it to use computer use.
End your final report with a section "Decisions made while you were away" listing every decision.
</away>`

export const AWAY_OFF = `<away state="off">The person is back. Ask when you need to, as usual. If you made decisions while they were away and have not reported them, list them under "Decisions made while you were away" in your next report.</away>`

/** The host's typed answer to each question a thread asks while the person is away. */
export const AWAY_QUESTION_REPLY = `The person is away. Decide yourself from the scope you were given, call ${NOTE_DECISION_TOOL_NAME} with what you chose, and carry on.`

/** The reason an approval is denied with while the person is away. */
export const AWAY_APPROVAL_REPLY = 'Denied: the person is away. Find a way that needs no approval, or finish everything around this and name it in your report.'

/** The Mac bridge's answer to a call that would ask the person at the Mac while they are away (remote/macBridge.ts); the box writes an away row when it comes back (macTools.ts). */
export const MAC_AWAY_REFUSAL = 'refused: the person is away; find another way or name it in your report'

/** The rule every harness carries, beside the steer mechanics. */
export const AWAY_MECHANICS = `## When the person is away
The person may switch "Away from computer" on or off. The app tells you in an <away> block, here or inside your turn. While it is on, it wins over any earlier instruction to ask the person or wait for them: decide, call ${NOTE_DECISION_TOOL_NAME} for each choice, and finish. When it turns off, ask as usual.`

/** The block for a state: what a flip whispers and a catch-up sends. */
export const awayBlock = (enabled: boolean): string => (enabled ? AWAY_ON : AWAY_OFF)

/** What a harness reads at spawn: the mechanics, and the block while away is on. */
export const awayMechanics = (enabled: boolean): string =>
  enabled ? `${AWAY_MECHANICS}\n\n${AWAY_ON}` : AWAY_MECHANICS
