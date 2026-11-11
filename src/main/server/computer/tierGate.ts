import type { ActionClass } from '@shared/computer/tools'
import type { ActionResult, BatchResult, ComputerAction, SessionChange, Tier } from '@shared/computer/protocol'
import type { PermissionPolicy } from '@shared/events'
import { sessionRefusalWords, type AdmitVia, type SessionTierRefusal } from '@shared/computer/scheduleRules'
import type { ApprovalRequest } from '../drivers/types'

/**
 * Whether a step may use the `session` tier, the one that takes the Mac: it
 * activates the app, moves the real pointer and types at the focused field.
 * During the spec build's fixture recording a scratch TextEdit came to the
 * front while the person typed and two of their keystrokes landed in it.
 * The tier scheduler (schedule.ts) is the gate the server sets at boot on a
 * host with a person to watch for; without it every session-tier step is
 * refused `no-scheduler`.
 */

export type { SessionTierRefusal }

export interface TierGateContext {
  threadId: string
  rootId: string
  permission: PermissionPolicy
  app: { pid: number; bundleId: string | null; name: string }
  window: { id: number; title: string } | null
  classes: ActionClass[]
  /** the thread's session on the service, for `session/interrupted` */
  serviceSession: string
  /** claude's tool_use id: a card sits under the tool's row */
  callId?: string
  /** the call's own card path: registry.requestApproval here, the Mac bridge's card for a box thread */
  approve?: (req: ApprovalRequest) => Promise<boolean>
  /** a bridged call's reader (pending.ts): a session-tier call takes the person's Mac only while someone will read its result */
  reader?: { present(): boolean; whenPresent(signal: AbortSignal): Promise<void> }
}

export interface TierGateRequest extends TierGateContext {
  step: number
  action: ComputerAction
  /** the step in words, as the call's card names it (words.ts actionWords): `click button "Save"` */
  words: string
  /** the call, unique on the host: a paste's deadline holds across its re-runs */
  call: string
  signal: AbortSignal
  /** the tier the step needs: `session` when left out; `front` waits only under "wait until I'm away" (§25.6) */
  needed?: 'front' | 'session'
}

export interface TierGateRun extends TierGateContext {
  tiers: Tier[]
  actions: ComputerAction[]
  signal: AbortSignal
}

export type TierDecision =
  | { admit: true; via?: AdmitVia; waitedMs?: number }
  | { admit: false; reason: SessionTierRefusal; message: string }

export type ClipboardDecision = { ok: true; waitedMs: number } | { ok: false; cancelled?: true; message: string }

export interface SessionTierGate {
  /** Before a call: may its tiers include 'session'? Fast, no wait. */
  admitted(ctx: TierGateContext): boolean
  /** Before a call: may its tiers include 'front' (§25.6)? Fast, no wait; absent reads as no. */
  frontAdmitted?(ctx: TierGateContext): boolean
  /** A step needs the session tier the call did not allow: admit it (after any wait the gate owns) or refuse with a reason. */
  request(ctx: TierGateRequest): Promise<TierDecision>
  /** A session-tier step ran: what it took (input plan A6). */
  ran?(ctx: TierGateContext, change: SessionChange | undefined): void
  /** Around every acting request: the gate may take `session` out of the tiers, holds the Mac for the call, and puts it back after. */
  run<T extends ActionResult | BatchResult>(ctx: TierGateRun, send: (tiers: Tier[]) => Promise<T>): Promise<T>
  /** A paste the service held off for the person's copy: wait until the clipboard is quiet, or say why not. */
  clipboard?(ctx: TierGateRequest): Promise<ClipboardDecision>
  /** sent with every acting request: a paste within this long of the person's copy fails `recent-copy` */
  readonly pasteQuietMs?: number
  /** The person's idle at the acting request's start, with the app's own input taken out. */
  personIdleMs?(): number
  /** The call's own card (safe, edits) named the session tier and was allowed at `at`. */
  cardAllowed?(ctx: TierGateContext, at: number): void
  /** The thread's turn ended, a Stop, a pause or its end: what the gate holds for it goes. */
  settle?(threadId: string, why: 'turn-end' | 'stopped' | 'paused' | 'ended'): Promise<void>
}

/** With no scheduler (headless, a host with no person to watch for) neither `session` nor `front` runs. */
export const REFUSE_SESSION_TIER: SessionTierGate = {
  admitted: () => false,
  frontAdmitted: () => false,
  request: async () => ({ admit: false, reason: 'no-scheduler', message: sessionRefusalWords('no-scheduler') }),
  run: (ctx, send) => send(ctx.tiers.filter((t) => t !== 'session' && t !== 'front'))
}

let current: SessionTierGate = REFUSE_SESSION_TIER

/** The tier scheduler; null puts the refusal back. */
export function setSessionTierGate(gate: SessionTierGate | null): void {
  current = gate ?? REFUSE_SESSION_TIER
}

export function currentSessionTierGate(): SessionTierGate {
  return current
}
