import { waitedWords } from './scheduleRules'

/**
 * A held computer call on the bridge (docs/computer-protocol.md §17 "A held
 * call on the bridge"). Codex runs an MCP tool inside a code-mode cell that
 * yields after about 30 s with nothing but "Script running"; Muse blocks the
 * whole time. So a bridged call held for HELD_ANSWER_MS answers anyway with an
 * id, stays on the host as a pending call that runs only while someone reads
 * it, and `computer_result` reads or cancels it. Claude calls in process and
 * keeps blocking its turn: none of this reaches it.
 */

/** A bridged call held this long answers with its id (under Codex's 30 s yield). */
export const HELD_ANSWER_MS = 20_000
/** `computer_result` on a call still held waits this long, then says so. */
export const WAIT_ANSWER_MS = 20_000
/** A pending call nobody reads this long is cancelled. */
export const UNREAD_CANCEL_MS = 60_000
/** The box waits this long for the Mac to acknowledge a reader notice. */
export const READER_ACK_MS = 5_000

export const COMPUTER_RESULT_TOOL = 'computer_result'

export interface HeldTimings {
  answerMs: number
  waitMs: number
  unreadMs: number
}

export const HELD_TIMINGS: Readonly<HeldTimings> = { answerMs: HELD_ANSWER_MS, waitMs: WAIT_ANSWER_MS, unreadMs: UNREAD_CANCEL_MS }

/**
 * The proof's seam, `TEMP_CODE_COMPUTER_HELD_MS=<answer>,<wait>,<unread>`,
 * honoured only on an isolated instance (TEMP_CODE_USER_DATA); anything
 * malformed keeps the defaults.
 */
export function heldTimings(env: Record<string, string | undefined> = process.env): HeldTimings {
  const raw = env.TEMP_CODE_COMPUTER_HELD_MS
  if (!env.TEMP_CODE_USER_DATA || !raw) return { ...HELD_TIMINGS }
  const parts = raw.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n <= 0)) return { ...HELD_TIMINGS }
  const [answerMs, waitMs, unreadMs] = parts
  return { answerMs, waitMs, unreadMs }
}

/** The row and the cancel's cause while a pending call waits for someone to read it. */
export const READER_WAIT_WORDS = 'Ready, waiting for the thread'
/** A local call's row while its own card waits. */
export const LOCAL_CARD_WORDS = 'Waiting for your approval'
/** Why a pending call nobody read was cancelled. */
export const UNREAD_WORDS = 'the thread stopped waiting for it'

/** The answer of a call held past HELD_ANSWER_MS: what holds it, its id, what to do. */
export function heldAnswerLine(id: string, waitedMs: number, line: string): string {
  return `Held after ${waitedWords(waitedMs)}: ${line}. Nothing runs until you ask for it: call computer_result with id "${id}". Your next other computer call cancels it.`
}

/** `computer_result` on a call still held after WAIT_ANSWER_MS. */
export function stillHeldLine(waitedMs: number, line: string): string {
  return `Still held, ${waitedWords(waitedMs)}: ${line}. Call computer_result again, or go on: your next other computer call cancels it.`
}

/** A pending call cancelled before anything ran: `Cancelled c4 (perform raise in TextEdit) before it ran.` */
export function cancelledPendingLine(id: string, what: string | null): string {
  return `Cancelled ${id}${what ? ` (${what})` : ''} before it ran.`
}

/** A pending call cancelled after some of its steps ran: the step lines follow. */
export function cancelledAfterStepsLine(id: string, what: string | null): string {
  return `Cancelled ${id}${what ? ` (${what})` : ''}; these steps ran first:`
}

/** `computer_result` with an id nothing is held under. */
export const unknownHeldLine = (id: string): string => `nothing held under "${id}": its result was given, or it was cancelled`

/** A pending call that ended on its own before anyone read it (a Stop, a denied card): what it said. */
export function endedUnreadLine(id: string, what: string | null, body: string | null): string {
  return `${id}${what ? ` (${what})` : ''} ended before its result was read${body ? `: ${body.split('\n')[0]}` : ''}`
}

/** The call in a few words for those lines: `perform raise in TextEdit`, `3 steps in Finder`, `observe Notes`. */
export function heldCallWhat(tool: string, args: Record<string, unknown>): string | null {
  const app = typeof args.app === 'string' ? args.app : null
  const where = app ? ` in ${app}` : ''
  if (tool === 'computer_apps') return typeof args.launch === 'string' ? `launch ${args.launch}` : 'list the apps'
  if (tool === 'computer_observe') return app ? `observe ${app}` : 'observe'
  if (tool === 'computer_batch') return `${Array.isArray(args.actions) ? args.actions.length : 0} steps${where}`
  const action = typeof args.action === 'string' ? args.action : tool.startsWith('computer_') ? tool.slice('computer_'.length) : tool
  const detail = [args.name, args.key, typeof args.element === 'number' ? `[${args.element}]` : undefined].find((d) => typeof d === 'string')
  return `${action}${detail ? ` ${detail}` : ''}${where}`
}
