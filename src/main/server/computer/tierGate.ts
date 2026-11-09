import type { ActionClass } from '@shared/computer/tools'
import type { ComputerAction, SessionChange } from '@shared/computer/protocol'
import type { PermissionPolicy } from '@shared/events'
import { SESSION_REFUSAL_WORDS, type SessionTierRefusal } from '@shared/computer/hostErrors'

/**
 * Whether a step may use the `session` tier, the one that takes the Mac: it
 * activates the app, moves the real pointer and types at the focused field.
 * During the spec build's fixture recording a scratch TextEdit came to the
 * front while the person typed and two of their keystrokes landed in it.
 * Until the tier scheduling thread's rule exists (its schedule.ts registers a
 * gate here at boot), every session-tier step is refused `no-scheduler`.
 */

export type { SessionTierRefusal }

export interface TierGateContext {
  threadId: string
  rootId: string
  permission: PermissionPolicy
  app: { pid: number; bundleId: string | null; name: string }
  window: { id: number; title: string } | null
  classes: ActionClass[]
}

export type TierDecision = { admit: true } | { admit: false; reason: SessionTierRefusal; message: string }

export interface SessionTierGate {
  /** Before a call: may its tiers include 'session'? Fast, no wait. */
  admitted(ctx: TierGateContext): boolean
  /** A step needs the session tier the call did not allow: admit it (after any wait the gate owns) or refuse with a reason. */
  request(ctx: TierGateContext & { step: number; action: ComputerAction; signal: AbortSignal }): Promise<TierDecision>
  /** A session-tier step ran: what it took (input plan A6), for the scheduler's restore. */
  ran?(ctx: TierGateContext, change: SessionChange | undefined): void
}

export const REFUSE_SESSION_TIER: SessionTierGate = {
  admitted: () => false,
  request: async () => ({ admit: false, reason: 'no-scheduler', message: SESSION_REFUSAL_WORDS['no-scheduler'] })
}

let current: SessionTierGate = REFUSE_SESSION_TIER

/** The tier scheduling thread's gate; null puts the refusal back. */
export function setSessionTierGate(gate: SessionTierGate | null): void {
  current = gate ?? REFUSE_SESSION_TIER
}

export function currentSessionTierGate(): SessionTierGate {
  return current
}
