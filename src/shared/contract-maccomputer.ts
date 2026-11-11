import { z } from 'zod'
import { MAC_APPROVAL_WAIT_MS } from './contract-macbridge'
export { MAC_BRIDGE_DEFAULT_MAX_COMPUTER, MAC_BRIDGE_MAX_COMPUTER_CAP } from './contract-macbridge'
import { ComputerSessionRowSchema } from './contract-computer'
import { ComputerToolCallSchema, ComputerToolResultSchema, type ComputerToolCall } from './computer/tools'

/**
 * Computer use through the Mac bridge (docs/box.md "Computer use from a box
 * thread", docs/computer-protocol.md "The bridge"). A box thread whose
 * `macBridge.thread.<sessionId>` names a Mac gets the four `computer_*`
 * tools; each call crosses the peer link as `mac.computer` and runs in a
 * computer session the Mac owns, keyed `macComputerKey(box, thread)`. The Mac
 * decides everything (its switch per host, its cap, its card); the box carries
 * the call, lands the pictures under its own thread and mirrors the Mac's row
 * for the thread's Activity. `mac.computerEnd` tells the Mac the box thread's
 * turn settled, was stopped, or the thread ended; the existing `mac.cancel`
 * reaches a call in flight. `mac.computerReader` tells the Mac whether anyone
 * on the box still reads a call (computer/pending.ts): a call nobody reads
 * waits at its next request.
 */

/** The offer a Mac adds to peer.register for a host whose computer use is on and possible. */
export const MAC_COMPUTER_OFFER = 'computer'
export const MAC_COMPUTER_PEER_METHODS = ['mac.computer', 'mac.computerEnd', 'mac.computerReader'] as const
export type MacComputerPeerMethod = (typeof MAC_COMPUTER_PEER_METHODS)[number]
export const isMacComputerPeerMethod = (m: string): m is MacComputerPeerMethod =>
  (MAC_COMPUTER_PEER_METHODS as readonly string[]).includes(m)

// ── settings ─────────────────────────────────────────────────────────
/** Mac: 'on', else off. */
export const COMPUTER_SWITCH_PREFIX = 'macBridge.computer.'
/** Mac: an integer 1..MAC_BRIDGE_MAX_COMPUTER_CAP, else MAC_BRIDGE_DEFAULT_MAX_COMPUTER (both in contract-macbridge.ts beside the other caps). */
export const MAX_COMPUTER_PREFIX = 'macBridge.maxComputer.'
/** Box: 'on' when the Mac's last peer.register offered computer use, kept so a thread started while the Mac is offline keeps its tools. */
export const COMPUTER_OFFER_PREFIX = 'macBridge.computerOffer.'

// ── times ────────────────────────────────────────────────────────────
/** A live Mac session with no call for this long gives its guard slot back; the next call takes one again. */
export const COMPUTER_LIVE_IDLE_MS = 3 * 60_000
/** At most this long in line on the load guard. */
export const COMPUTER_HOLD_MAX_MS = 10 * 60_000
/** Reserved for the tier scheduling rule's own wait and ask inside one call. */
export const COMPUTER_SESSION_WAIT_MS = 10 * 60_000
/** The box ends a thread's Mac session this long after its last call (the sessions build's idle close, made explicit). */
export const COMPUTER_BRIDGE_IDLE_CLOSE_MS = 10 * 60_000
/** Rows and progress frames, at most four a second. */
export const COMPUTER_ROW_MS = 250
/** What the reply needs to travel back, on top of everything the Mac may spend. */
const REPLY_TRAVEL_MS = 30_000
/** The service's base per call, and its ceiling (connection.ts COMPUTER_DEADLINES, BATCH_DEADLINE_MAX_MS). */
const CALL_BASE_MS = 60_000
const CALL_MAX_MS = 600_000

const durationMs = (a: { duration?: number }): number => Math.round((a.duration ?? 0) * 1000)

/** The service's own budget for one call: 60 s plus its actions' durations, at most 600 s. */
export function computerCallBudgetMs(call: ComputerToolCall): number {
  if (call.tool === 'computer_act') return Math.min(CALL_MAX_MS, CALL_BASE_MS + durationMs(call.args))
  if (call.tool === 'computer_batch')
    return Math.min(CALL_MAX_MS, CALL_BASE_MS + call.args.actions.reduce((n, a) => n + durationMs(a), 0))
  return CALL_BASE_MS
}

/** What the box gives a `mac.computer` peer call: the card, the line, the scheduler's wait, the call's budget, 30 s for the reply. */
export function bridgedDeadlineMs(call: ComputerToolCall): number {
  return MAC_APPROVAL_WAIT_MS + COMPUTER_HOLD_MAX_MS + COMPUTER_SESSION_WAIT_MS + computerCallBudgetMs(call) + REPLY_TRAVEL_MS
}

// ── the session a box thread owns on the Mac ─────────────────────────
const ENV_ID = /^env_[A-Za-z0-9_-]{22}$/

export const macComputerKey = (envId: string, threadId: string): string => `${envId}:${threadId}`

export function parseMacComputerKey(key: string): { envId: string; threadId: string } | null {
  const at = key.indexOf(':')
  if (at < 0) return null
  const envId = key.slice(0, at)
  const threadId = key.slice(at + 1)
  return ENV_ID.test(envId) && threadId.length > 0 ? { envId, threadId } : null
}

// ── payloads ─────────────────────────────────────────────────────────
export const MacComputerCallArgsSchema = z.object({
  call: ComputerToolCallSchema,
  /** The box thread's turn: a new value clears the Mac session's Stop for the turn. */
  turn: z.string().min(1).max(100),
  /** The box thread's root: the scheduler's rootId on the Mac is macComputerKey(env, rootId). */
  rootId: z.string().min(1).max(200)
})
export type MacComputerCallArgs = z.infer<typeof MacComputerCallArgsSchema>

export const MacComputerEndArgsSchema = z.object({ reason: z.enum(['settled', 'stopped', 'ended']) })
export type MacComputerEndArgs = z.infer<typeof MacComputerEndArgsSchema>

/** Whether anyone on the box reads these calls: `false` holds each at its next request, `true` lets it go on. */
export const MacComputerReaderArgsSchema = z.object({ callIds: z.array(z.string().min(1).max(200)).min(1).max(16), reading: z.boolean() })
export type MacComputerReaderArgs = z.infer<typeof MacComputerReaderArgsSchema>
/**
 * `held: true` when every named call now waits at a hold with no request out,
 * so nothing passes its gate unread; `false` when one has a request out (its
 * flag stays true) or is not here.
 */
export interface MacComputerReaderResult {
  held: boolean
}

/** The fields `mac.computerReader` sends: a refusal naming one of them comes from a Mac that knows the call. */
const READER_FIELDS: readonly string[] = Object.keys(MacComputerReaderArgsSchema.shape)

/**
 * Whether a refusal of `mac.computerReader` shows the Mac does not know the
 * call, so it is on a build from before it. Such a Mac has no route for the
 * method: it reads the args as a file read's and refuses them with zod's
 * issues on a field the call never sends (`path`), or a router that names the
 * method says it is unknown. Any other failure (a timeout, the link, the Mac
 * refusing this call's own fields) says nothing about its build.
 */
export function macLacksReader(message: string): boolean {
  if (/\bunknown method\b/i.test(message)) return true
  let issues: unknown
  try {
    issues = JSON.parse(message)
  } catch {
    return false
  }
  return (
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every((i) => {
      const path = (i as { path?: unknown } | null)?.path
      return Array.isArray(path) && path.length > 0 && !READER_FIELDS.includes(String(path[0]))
    })
  )
}

/**
 * What a `mac.computer` call answers: the step lines and the body apart, so
 * the box lays each picture's `screenshot` line between them as the Mac would
 * (one renderText for both hosts), and the pictures in order.
 */
export const ComputerPeerAnswerSchema = z.object({
  steps: z.array(z.string()),
  body: z.string().nullable(),
  isError: z.boolean(),
  /** A card was refused because the person is away: the box writes its away row. */
  away: z.literal(true).optional(),
  images: ComputerToolResultSchema.shape.images,
  /** The Mac's row for the session after the call. */
  row: ComputerSessionRowSchema.nullable()
})
export type ComputerPeerAnswer = z.infer<typeof ComputerPeerAnswerSchema>

/** The JSON of one peer.progress chunk during a mac.computer call. */
export const ComputerPeerProgressSchema = z.object({ row: ComputerSessionRowSchema })
export type ComputerPeerProgress = z.infer<typeof ComputerPeerProgressSchema>

export interface MacComputerEndResult {
  ended: boolean
}

// ── words ────────────────────────────────────────────────────────────
export const COMPUTER_SWITCH_OFF =
  "refused: computer use is off for this host; turn on Computer use for it in the Mac's Settings → Hosts"
export const computerUnavailableOnMac = (reason: string): string => `computer use is unavailable on the Mac: ${reason}`
export const COMPUTER_HOLD_EXPIRED = 'the Mac stayed too busy: the call ran out of time while waiting its turn'
export const COMPUTER_HOLD_STOPPED = 'stopped at the Mac while waiting its turn'
/** The peer link dropped while a call was out: as the service's own restart line says, the action may or may not have happened. */
export const COMPUTER_MAC_WENT_OFFLINE =
  'the Mac went offline during this call, so the action may or may not have happened; read the window again'
/** A box thread whose bridge names no Mac. */
export const COMPUTER_NO_MAC = 'the Mac bridge is off for this thread (turn it on from the thread menu)'
/** The Mac sent something that does not parse as an answer. */
export const COMPUTER_BAD_ANSWER = 'the Mac sent an answer this host cannot read'
/** The box row's words while a card waits on the Mac. */
export const askingWords = (macName: string): string => `Waiting for approval on ${macName}`
