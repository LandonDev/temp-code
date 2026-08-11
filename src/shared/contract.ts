import { z } from 'zod'
import { AGENT_TYPES } from './catalog'
import { PermissionPolicySchema } from './events'
import type { EventRow, SessionMeta } from './events'

/**
 * The websocket contract. One socket per client; JSON frames.
 * Client → server: requests ({ id, method, params }) answered by
 * ({ id, ok, result } | { id, ok: false, error }).
 * Server → client: pushes ({ push, ... }) for subscribed sessions.
 *
 * T3-style rule: the server never broadcasts blindly — a client only
 * receives events for sessions it subscribed to (plus session-meta
 * updates, which are cheap and drive the sidebar).
 */

const providerEnum = z.enum(['claude', 'codex', 'cursor'])
const reasoningEnum = z.enum(['low', 'medium', 'high', 'max'])

export const CreateSessionParams = z.object({
  provider: providerEnum,
  model: z.string(),
  reasoning: reasoningEnum.default('medium'),
  agentType: z.enum(AGENT_TYPES).default('implementer'),
  cwd: z.string(),
  title: z.string().optional(),
  parentId: z.string().nullable().default(null),
  permission: PermissionPolicySchema.default('edits')
})
export type CreateSessionParams = z.infer<typeof CreateSessionParams>

export const ClientRequestSchema = z.discriminatedUnion('method', [
  z.object({ id: z.string(), method: z.literal('catalog.get') }),
  // Per-provider health: binary found on the login-shell PATH, version.
  z.object({ id: z.string(), method: z.literal('doctor.get') }),
  z.object({ id: z.string(), method: z.literal('session.create'), params: CreateSessionParams }),
  z.object({ id: z.string(), method: z.literal('session.list') }),
  z.object({
    id: z.string(),
    method: z.literal('session.events'),
    params: z.object({ sessionId: z.string(), afterSeq: z.number().default(0) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.send'),
    params: z.object({ sessionId: z.string(), text: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.interrupt'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.subscribe'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.unsubscribe'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.archive'),
    params: z.object({ sessionId: z.string(), archived: z.boolean() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.delete'),
    params: z.object({ sessionId: z.string() })
  }),
  // Drop the live handle (if any) and reset an errored session to idle;
  // the next send lazily starts a fresh harness that resumes via nativeId.
  z.object({
    id: z.string(),
    method: z.literal('session.restart'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.approve'),
    params: z.object({ sessionId: z.string(), requestId: z.string(), allow: z.boolean() })
  })
])
export type ClientRequest = z.infer<typeof ClientRequestSchema>

export type ServerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string }

export type ServerPush =
  | { push: 'event'; row: EventRow }
  | { push: 'session'; session: SessionMeta }
  | { push: 'session-removed'; sessionIds: string[] }

export type ServerFrame = ServerResponse | ServerPush
