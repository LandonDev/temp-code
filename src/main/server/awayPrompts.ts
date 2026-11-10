import { NOTE_DECISION_TOOL_NAME } from '@shared/away'

/**
 * What a harness is told about Away from computer (away.ts): the mechanics
 * every thread carries (claude's system prompt through mechanicsFor, other
 * harnesses' first message through threads.ts), the block whispered into a
 * running turn on each flip and caught up at a thread's next turn
 * (sessions.ts awayChanged, takeNotices), and the host's own answers to a
 * question while the person is away (sessions.ts interceptAway), and the one
 * denial Away keeps: a computer act that spends money.
 */

export const AWAY_ON = `<away state="on">
The person is away from the computer until further notice and wants the work finished without them.
Do not ask questions. Decide from the scope you were given, the code and the project's notes, and keep going. Call ${NOTE_DECISION_TOOL_NAME} once for each choice you would have asked about: one line saying what you chose and why.
Do not stop to wait for the person, and do not end a turn with "let me know" or "when you're back". Find a way to finish.
While they are away, anything your permission mode or the Mac would ask them about is allowed, and each one is recorded for them to review. Do only what the task needs: an allow is not a reason to do more. One exception: a computer act flagged pay or subscribe is denied. Finish everything around it and name it in your report.
For anything that needs a Mac app's screen, use the computer tools when this thread has them; otherwise spawn a gpt-6.1-sol subagent on the Mac with spawn_agent (environmentId "mac"; leave it out when you already run on the Mac) and tell it to use its computer tools.
End your final report with a section "Decisions made while you were away" listing every decision.
</away>`

export const AWAY_OFF = `<away state="off">The person is back. Ask when you need to, as usual. If you made decisions while they were away and have not reported them, list them under "Decisions made while you were away" in your next report.</away>`

/** The host's typed answer to each question a thread asks while the person is away. */
export const AWAY_QUESTION_REPLY = `The person is away. Decide yourself from the scope you were given, call ${NOTE_DECISION_TOOL_NAME} with what you chose, and carry on.`

/** The reason an approval is denied with while the person is away: only a computer act that spends money (@shared/away awayAllowsKind); every other card is allowed. */
export const AWAY_APPROVAL_REPLY = 'Denied: the person is away and this spends money. Finish everything around it and name it in your report.'

/** The Mac's answer to a box thread's computer act that spends money while the person is away (remote/macComputer.ts); the box writes the denied row when it comes back (computer/bridge.ts). */
export const MAC_AWAY_REFUSAL = 'refused: the person is away and this act spends money; finish around it and name it in your report'

/** What a Mac on the build before 2026-11-10 refuses every asking call with while away; the box still words it as a denied row (macTools.ts, computer/bridge.ts). */
export const MAC_AWAY_REFUSAL_LEGACY = 'refused: the person is away; find another way or name it in your report'

/** Whether a Mac's refusal is Away's (either build's words). */
export const isMacAwayRefusal = (message: string): boolean =>
  message.includes(MAC_AWAY_REFUSAL) || message.includes(MAC_AWAY_REFUSAL_LEGACY)

/** The rule every harness carries, beside the steer mechanics. */
export const AWAY_MECHANICS = `## When the person is away
The person may switch "Away from computer" on or off. The app tells you in an <away> block, here or inside your turn. While it is on, it wins over any earlier instruction to ask the person or wait for them: decide, call ${NOTE_DECISION_TOOL_NAME} for each choice, and finish. When it turns off, ask as usual.`

/** The block for a state: what a flip whispers and a catch-up sends. */
export const awayBlock = (enabled: boolean): string => (enabled ? AWAY_ON : AWAY_OFF)

/** What a harness reads at spawn: the mechanics, and the block while away is on. */
export const awayMechanics = (enabled: boolean): string =>
  enabled ? `${AWAY_MECHANICS}\n\n${AWAY_ON}` : AWAY_MECHANICS
