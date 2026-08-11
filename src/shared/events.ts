import { z } from 'zod'
import type { AgentType, ProviderId, Reasoning } from './catalog'

/**
 * The normalized event schema. Every driver (Claude Agent SDK, Codex
 * app-server, cursor-agent stream-json) translates its native stream into
 * these events. The UI renders ONLY this schema — it never sees a
 * provider-native payload.
 */

export const SessionStatusSchema = z.enum(['starting', 'idle', 'running', 'error', 'done'])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const AgentEventSchema = z.discriminatedUnion('type', [
  // A message the user (or the orchestrator, for subagents) sent in.
  z.object({ type: z.literal('user-text'), text: z.string() }),

  // Assistant output. delta=true → streaming chunk to append;
  // delta=false → authoritative full block (replaces accumulated deltas).
  z.object({ type: z.literal('assistant-text'), text: z.string(), delta: z.boolean() }),

  // Reasoning/thinking stream, same delta semantics.
  z.object({ type: z.literal('thinking'), text: z.string(), delta: z.boolean() }),

  // Tool lifecycle. callId ties call to result.
  z.object({
    type: z.literal('tool-call'),
    callId: z.string(),
    name: z.string(),
    input: z.unknown()
  }),
  z.object({
    type: z.literal('tool-result'),
    callId: z.string(),
    output: z.string(),
    isError: z.boolean()
  }),

  // Session lifecycle.
  z.object({ type: z.literal('status'), status: SessionStatusSchema, detail: z.string().optional() }),

  // End of a turn, with whatever accounting the provider reports.
  z.object({
    type: z.literal('turn-complete'),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional()
  }),

  // Orchestration: this session spawned a child session.
  z.object({ type: z.literal('agent-spawned'), childSessionId: z.string() }),

  z.object({ type: z.literal('error'), message: z.string() })
])
export type AgentEvent = z.infer<typeof AgentEventSchema>

/** A persisted, ordered event row. seq is per-session and monotonic. */
export interface EventRow {
  sessionId: string
  seq: number
  ts: number
  event: AgentEvent
}

export interface SessionMeta {
  id: string
  parentId: string | null
  provider: ProviderId
  model: string
  reasoning: Reasoning
  agentType: AgentType
  title: string
  cwd: string
  status: SessionStatus
  /** Provider-native session/thread id, once known (for resume). */
  nativeId: string | null
  createdAt: number
  updatedAt: number
}
