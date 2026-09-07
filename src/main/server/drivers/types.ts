import type { ProviderId } from '@shared/catalog'
import type { AgentEvent, Attachment, SessionMeta } from '@shared/events'

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
  emit: (event: AgentEvent) => void
  /** Persist the provider-native session/thread id once known (resume). */
  setNativeId: (nativeId: string) => void
  /** Ask the user: emits approval-request + status waiting, resolves on
   *  session.approve (false after the timeout, on abort, or on dispose),
   *  then emits approval-resolved + status running. One path for harness
   *  permission prompts and the app tools' own gate. */
  requestApproval: (req: ApprovalRequest) => Promise<boolean>
}

export interface DriverHandle {
  /** Images should reach the model as native content where the harness
   *  supports it; other attachments ride along as path references. */
  send: (text: string, attachments?: Attachment[]) => Promise<void>
  interrupt: () => void
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
  dispose: () => Promise<void>
}

export interface HarnessDriver {
  id: ProviderId
  start: (ctx: DriverCtx) => Promise<DriverHandle>
}
