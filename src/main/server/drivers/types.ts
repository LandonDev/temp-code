import type { ProviderId } from '@shared/catalog'
import type { AgentEvent, SessionMeta } from '@shared/events'

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

export interface DriverCtx {
  session: SessionMeta
  emit: (event: AgentEvent) => void
  /** Persist the provider-native session/thread id once known (resume). */
  setNativeId: (nativeId: string) => void
}

export interface DriverHandle {
  send: (text: string) => Promise<void>
  interrupt: () => void
  /** Answer a pending approval-request (drivers that support approvals). */
  approve?: (requestId: string, allow: boolean) => void
  dispose: () => Promise<void>
}

export interface HarnessDriver {
  id: ProviderId
  start: (ctx: DriverCtx) => Promise<DriverHandle>
}
