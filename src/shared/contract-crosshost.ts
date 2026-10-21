import { z } from 'zod'
import { AGENT_TYPES } from './catalog'
import { ThreadTypeSchema } from './domain'
import { PermissionPolicySchema, type SessionStatus } from './events'

// Threads on another host (docs/box.md "Starting a thread on the Mac from
// the box"). A thread on the box starts a thread, or spawns a subagent, on
// the Mac and supervises it from there, so work that needs Xcode, the
// simulator or a Mac app runs where those are. The transport is the Mac
// bridge's reverse RPC (contract-macbridge.ts, remote/peerCalls.ts): the
// Mac registers the `threads` offer on its admin link to the box and the
// box sends `peer.call` pushes naming the thread.* methods below; the Mac
// serves them against its own registry (remote/crossHostThreads.ts) and
// the box routes the app tools to them (crossHostAgents.ts).
//
// None of these methods is a contract request: they ride only inside
// `peer.call`, whose register/reply/chunk frames are admin, so a remote key
// never names them. The app tools that reach them stay local.

/** The offer a Mac makes in `peer.register` when it will run threads for a host. */
export const CROSS_HOST_OFFER = 'threads'

export const CROSS_HOST_PEER_METHODS = [
  'thread.start',
  'thread.spawn',
  'thread.send',
  'thread.list',
  'thread.events',
  'thread.check',
  'thread.wait',
  'thread.interrupt',
  'thread.answer'
] as const
export type CrossHostPeerMethod = (typeof CROSS_HOST_PEER_METHODS)[number]
export const isCrossHostPeerMethod = (m: string): m is CrossHostPeerMethod =>
  (CROSS_HOST_PEER_METHODS as readonly string[]).includes(m)

/** One thread.wait rides a peer call no longer than this; the box loops, so a dropped link is seen within a window. */
export const CROSS_HOST_WAIT_WINDOW_MS = 60_000
/** Travel time on top of what the Mac may spend on one call. */
export const CROSS_HOST_CALL_SLACK_MS = 30_000
/** A plain call (start, send, list, events, check, interrupt, answer) gets this long. */
export const CROSS_HOST_CALL_MS = 120_000
/** thread.events answers at most this many rows per call. */
export const CROSS_HOST_EVENTS_MAX = 500
/** A row's text (assistant text, tool input/result) is cut to this many characters on the wire. */
export const CROSS_HOST_ROW_TEXT_MAX = 4_000
/** The settled report's reply tail. */
export const CROSS_HOST_REPLY_MAX = 8_000

// ── agent ids ────────────────────────────────────────────────────────
// A thread on another host is named `<environmentId>:<sessionId>` wherever
// an agent id is handed to a model, so every later call routes to that host
// without the model knowing. A local id has no colon (nanoid alphabet), an
// environment id is `env_<22 chars>` (remote/environment.ts).

const ENV_ID = /^env_[A-Za-z0-9_-]{22}$/
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/

export interface RemoteAgentId {
  environmentId: string
  sessionId: string
}

export const encodeAgentId = (environmentId: string, sessionId: string): string =>
  `${environmentId}:${sessionId}`

/** The host and session an agent id names, or null for a local id (no colon). Malformed ids throw. */
export function decodeAgentId(agentId: string): RemoteAgentId | null {
  const at = agentId.indexOf(':')
  if (at < 0) return null
  const environmentId = agentId.slice(0, at)
  const sessionId = agentId.slice(at + 1)
  if (!ENV_ID.test(environmentId) || !SESSION_ID.test(sessionId))
    throw new Error(`not an agent id: ${agentId}`)
  return { environmentId, sessionId }
}

export const isRemoteAgentId = (agentId: string): boolean => {
  try {
    return decodeAgentId(agentId) !== null
  } catch {
    return false
  }
}

// ── what the box names in a call ─────────────────────────────────────

/** The box thread behind a call: shown on the Mac's thread as its origin, and the owner every later call must match. */
export const CrossHostCallerSchema = z.object({
  /** The box's environment id. */
  environmentId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  title: z.string().max(300),
  /** The box thread's permission: what the thread on the Mac inherits. */
  permission: PermissionPolicySchema
})
export type CrossHostCaller = z.infer<typeof CrossHostCallerSchema>

const providerArg = z.enum(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx'])
const reasoningArg = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/** thread.start: app.startThread's fields, plus where on the box the caller works (translated on the Mac). */
export const ThreadStartArgsSchema = z.object({
  threadType: ThreadTypeSchema,
  provider: providerArg,
  model: z.string().max(200).optional(),
  reasoning: reasoningArg.optional(),
  context1m: z.boolean().optional(),
  firstMessage: z.string().min(1).max(200_000),
  title: z.string().max(300).optional(),
  /** The plan file on the box, when the type executes one; sent as text, since the Mac may not have it. */
  planPath: z.string().max(2_000).optional(),
  /** The box path the thread would work in (its project cwd); the Mac maps it onto its own checkout. */
  cwd: z.string().max(2_000),
  /** The box's work root, so `<root>/<name>` maps onto the Mac's work root when no map names it. */
  workRoot: z.string().max(2_000).optional()
})
export type ThreadStartArgs = z.infer<typeof ThreadStartArgsSchema>

/** thread.spawn: one subagent, already resolved against the box thread's rules. */
export const ThreadSpawnArgsSchema = z.object({
  provider: providerArg,
  model: z.string().max(200),
  reasoning: reasoningArg,
  context1m: z.boolean(),
  agentType: z.enum(AGENT_TYPES),
  task: z.string().min(1).max(200_000),
  title: z.string().max(300),
  useWorktree: z.boolean(),
  cwd: z.string().max(2_000),
  workRoot: z.string().max(2_000).optional()
})
export type ThreadSpawnArgs = z.infer<typeof ThreadSpawnArgsSchema>

export const ThreadSendArgsSchema = z.object({
  sessionId: z.string().min(1).max(200),
  message: z.string().min(1).max(200_000)
})
export const ThreadListArgsSchema = z.object({
  /** The threads to describe; absent: every thread this caller started or spawned here. */
  sessionIds: z.array(z.string().min(1).max(200)).max(200).optional()
})
export const ThreadEventsArgsSchema = z.object({
  sessionId: z.string().min(1).max(200),
  afterSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(CROSS_HOST_EVENTS_MAX).optional()
})
export const ThreadCheckArgsSchema = z.object({ sessionId: z.string().min(1).max(200) })
export const ThreadWaitArgsSchema = z.object({
  sessionId: z.string().min(1).max(200),
  /** How long this call may wait before answering the state as it stands (≤ CROSS_HOST_WAIT_WINDOW_MS). */
  deadlineMs: z.number().int().min(0).max(CROSS_HOST_WAIT_WINDOW_MS)
})
export const ThreadInterruptArgsSchema = z.object({ sessionId: z.string().min(1).max(200) })
export const ThreadAnswerArgsSchema = z.object({
  sessionId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  /** A structured question's answers; absent for an approval. */
  answers: z.array(z.array(z.string().max(10_000)).max(50)).max(50).optional(),
  /** An approval's decision. */
  allow: z.boolean().optional()
})

export type ThreadSendArgs = z.infer<typeof ThreadSendArgsSchema>
export type ThreadListArgs = z.infer<typeof ThreadListArgsSchema>
export type ThreadEventsArgs = z.infer<typeof ThreadEventsArgsSchema>
export type ThreadCheckArgs = z.infer<typeof ThreadCheckArgsSchema>
export type ThreadWaitArgs = z.infer<typeof ThreadWaitArgsSchema>
export type ThreadInterruptArgs = z.infer<typeof ThreadInterruptArgsSchema>
export type ThreadAnswerArgs = z.infer<typeof ThreadAnswerArgsSchema>

export type CrossHostArgs =
  | ThreadStartArgs
  | ThreadSpawnArgs
  | ThreadSendArgs
  | ThreadListArgs
  | ThreadEventsArgs
  | ThreadCheckArgs
  | ThreadWaitArgs
  | ThreadInterruptArgs
  | ThreadAnswerArgs

/** `peer.call` params for a thread.* method: the args plus the box thread asking. */
export interface CrossHostCallParams {
  caller: CrossHostCaller
  args: CrossHostArgs
}

// ── what the Mac answers ─────────────────────────────────────────────

/** What a thread.list or thread.check row says of a thread on the Mac. */
export interface CrossHostThreadState {
  sessionId: string
  title: string
  provider: string
  model: string
  agentType: string
  threadType: string | null
  status: SessionStatus
  cwd: string
  idleForSeconds: number
  /** The box thread it was started or spawned by. */
  parentSessionId: string | null
}

export interface ThreadStartResult {
  sessionId: string
  title: string
  /** Where the thread works on the Mac. */
  cwd: string
  projectId: string | null
  /** Set when the box path had no checkout on the Mac and the thread started in the Mac's work root instead. */
  cwdNote?: string
}
export type ThreadSpawnResult = ThreadStartResult

export interface ThreadPending {
  kind: 'question' | 'approval'
  requestId: string
  questions?: unknown
  toolName?: string
  title?: string
}

/** thread.wait and the settled part of thread.check. */
export interface ThreadWaitResult {
  sessionId: string
  status: SessionStatus
  /** The thread's turn ended (idle, waiting, error, done, paused); false when the deadline passed first. */
  settled: boolean
  reply: string
  pending: ThreadPending | null
  title: string
}

export interface ThreadCheckResult extends CrossHostThreadState {
  currentTurn: { toolCalls: string[]; lastText: string }
  pending: ThreadPending | null
  tasks: { done: number; total: number } | null
}

export interface ThreadEventRow {
  seq: number
  ts: number
  /** The event, its long text fields cut to CROSS_HOST_ROW_TEXT_MAX. */
  event: Record<string, unknown>
}
export interface ThreadEventsResult {
  sessionId: string
  rows: ThreadEventRow[]
  /** The last seq on the Mac; more rows wait when it is past the last row here. */
  lastSeq: number
  status: SessionStatus
}

/** The alias a model may pass for the host: the thread's Mac, or the only one registered. */
export const MAC_HOST_ALIAS = 'mac'

// ── the Mac → the box, over the peer link (admin) ────────────────────

/** A thread this Mac runs for the box settled: the box wakes the thread that started it, as a local child's settle would. */
export const CrossHostSettledSchema = z.object({
  /** The Mac's environment id. */
  from: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  /** The box thread it was spawned by (null for a thread started with app.startThread). */
  parentSessionId: z.string().max(200).nullable(),
  title: z.string().max(300),
  status: z.string().max(40),
  reply: z.string().max(2_000),
  pending: z
    .object({
      kind: z.enum(['question', 'approval']),
      requestId: z.string().max(200),
      questions: z.unknown().optional(),
      toolName: z.string().max(200).optional(),
      title: z.string().max(300).optional()
    })
    .nullable()
})
export type CrossHostSettled = z.infer<typeof CrossHostSettledSchema>

export const CrossHostRequestSchemas = [
  z.object({ id: z.string(), method: z.literal('crossHost.settled'), params: CrossHostSettledSchema })
] as const
