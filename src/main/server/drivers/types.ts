import type { AccountRoute } from '@shared/accounts'
import type { ProviderId } from '@shared/catalog'
import type { AgentEvent, Attachment, SessionMeta } from '@shared/events'
import type { SendPhase } from '../sendSpans'

/**
 * The per-harness contract. A driver owns exactly one running harness
 * process/loop for one session and translates its native stream into
 * normalized AgentEvents via emit().
 *
 * Rules:
 *  - The driver NEVER holds provider credentials. It runs the official
 *    harness (Agent SDK / codex app-server / cursor-agent) under the
 *    user's own local login.
 *  - Everything user-visible must go through emit() — the event log is
 *    the source of truth, drivers are stateless from the UI's view.
 */

/** A tool call awaiting the user's Allow/Deny. */
export interface ApprovalRequest {
  /** the harness's own id when it has one; minted otherwise */
  requestId?: string
  toolName: string
  input: unknown
  title?: string
  callId?: string
  /** the harness gave up waiting (turn interrupted) */
  signal?: AbortSignal
}

export interface DriverCtx {
  session: SessionMeta
  /** The Aliax account this process spends from, baked into its gateway URL; absent or null sends unscoped. */
  route?: AccountRoute | null
  emit: (event: AgentEvent) => void
  /** Persist the provider-native session/thread id once known (resume). */
  setNativeId: (nativeId: string) => void
  /** The harness answered the resume with "no such session": its transcript
   *  store never had the id (the thread's history came here from another
   *  host) or lost it. The registry forgets the id, reboots fresh once the
   *  turn settles, seeded with the thread's own transcript, and continues. */
  nativeSessionLost?: () => void
  /** Ask the user: emits approval-request + status waiting, resolves on
   *  session.approve (false after the timeout, on abort, or on dispose),
   *  then emits approval-resolved + status running. One path for harness
   *  permission prompts and the app tools' own gate. */
  requestApproval: (req: ApprovalRequest) => Promise<boolean>
  /** Resolves once the session's undo baseline (taken off the send path)
   *  has landed; a driver's first write-capable tool waits on it. */
  awaitBaseline?: () => Promise<void>
  /** A line the host adds to a finished shell call's result (a dev server it
   *  opened was forwarded: "Forwarded to http://localhost:5174 on the Mac");
   *  null adds nothing. A driver with a post-tool hook asks it; the host
   *  whispers the line into the turn for one without (threadPorts.ts). */
  toolResultTail?: (callId: string, output: string) => Promise<string | null>
  /** A phase of the current send landed (sendSpans.ts): `handle` with
   *  `warm` or `cold` when the process is made, `init` at the harness's
   *  own init, `first-message` on anything back, `first-content` on the
   *  first text delta or tool call. Cheap and idempotent; absent in tests. */
  mark?: (phase: SendPhase, note?: string) => void
}

export interface DriverHandle {
  /** Images should reach the model as native content where the harness
   *  supports it; other attachments ride along as path references. */
  send: (text: string, attachments?: Attachment[]) => Promise<void>
  interrupt: () => void
  /** Stop one background task by the CLI's id (claude's query.stopTask);
   *  its settle arrives as the usual task notification. */
  stopTask?: (taskId: string) => Promise<void>
  /** Answer a pending approval-request. Returns whether the request was
   *  still pending here — false lets the registry handle a stale one
   *  (asked by a previous process of this harness). */
  approve?: (requestId: string, allow: boolean) => boolean
  /** Answer a pending question-request; null = dismissed without
   *  answering. Returns whether the request was still pending here. */
  answer?: (requestId: string, answers: string[][] | null) => boolean
  /** Context-window usage breakdown (claude: /context data). */
  contextUsage?: () => Promise<unknown>
  /** Set/replace the goal condition on the harness (claude /goal, codex
   *  thread/goal/set). Confirmation arrives as a goal event, never here. */
  setGoal?: (condition: string) => Promise<void>
  clearGoal?: () => Promise<void>
  /** Squeeze the conversation in place (claude /compact, codex
   *  thread/compact/start). Progress and the result arrive as compaction
   *  events; the status settles through the turn, never here. */
  compact?: () => Promise<void>
  /** Whether the harness process behind this handle is still there. A
   *  driver that cannot tell leaves it out; false lets the registry's
   *  liveness sweep (sessions.ts) read a running row as stopped. */
  alive?: () => boolean
  /** The harness process's pid, for the admission sampler's RSS reading
   *  (admission.ts); null or absent when the driver has no process of its own. */
  pid?: () => number | null
  dispose: () => Promise<void>
}

export interface HarnessDriver {
  id: ProviderId
  start: (ctx: DriverCtx) => Promise<DriverHandle>
}
