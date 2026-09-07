import type { ToolPreview } from '@shared/events'

/**
 * The event stream the ported engines (fx, grok, pi, omp, opencode) emit.
 * Same shape as src/lib/harness/types.ts so an engine ports with import
 * changes only; toAgentEvent.ts turns it into AgentEvents. One widening:
 * tool.started/updated carry the engine's structured `input` when it has
 * one (pi/opencode args, grok's ACP rawInput).
 */

export type { ToolPreview }
export type ToolPreviewKind = ToolPreview['kind']
export type ToolPreviewLine = NonNullable<ToolPreview['lines']>[number]

export type HarnessEvent =
  | { type: 'session.started' }
  | { type: 'session.ended'; code?: number | null }
  | { type: 'session.error'; message: string }
  | { type: 'session.providerBound'; providerSessionId: string }
  | { type: 'status'; text: string }
  | { type: 'message.delta'; text: string }
  | { type: 'message.completed' }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'reasoning.completed' }
  | {
      type: 'tool.started'
      callId: string
      title: string
      kind?: string
      status?: string
      preview?: ToolPreview
      input?: unknown
    }
  | {
      type: 'tool.updated'
      callId: string
      title?: string
      kind?: string
      status?: string
      detail?: string
      preview?: ToolPreview
      input?: unknown
    }
  | {
      type: 'approval.requested'
      requestId: number
      title: string
      kind?: string
      callId?: string
      preview?: ToolPreview
    }
  | {
      type: 'approval.resolved'
      requestId: number
      /** "cancelled" = a PermissionRequest hook decided before the user could. */
      decision: 'allow' | 'deny' | 'cancelled'
    }
  | { type: 'plan'; text: string }
  /** Context-window level after the harness's latest request. */
  | { type: 'context'; used?: number; window?: number }

export type ApprovalDecision = 'allow' | 'deny'
