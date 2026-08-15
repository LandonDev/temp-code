import { z } from 'zod'
import { AGENT_TYPES } from './catalog'
import { AttachmentSchema, PermissionPolicySchema } from './events'
import { ProjectModeSchema, ThreadTypeSchema } from './domain'
import { OrchestrationRulesSchema } from './rules'
import { ThreadDefaultsSchema } from './defaults'
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
const reasoningEnum = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export const CreateSessionParams = z.object({
  // provider/model/reasoning/permission omitted → the server fills them
  // from the thread defaults (workspace override, else global).
  provider: providerEnum.optional(),
  model: z.string().optional(),
  reasoning: reasoningEnum.optional(),
  agentType: z.enum(AGENT_TYPES).default('implementer'),
  /** required unless projectId is set (then derived from the project) */
  cwd: z.string().optional(),
  title: z.string().optional(),
  parentId: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
  threadType: ThreadTypeSchema.nullable().default(null),
  /** planning handoff: seed an implementation/orchestration thread from this plan file */
  planPath: z.string().optional(),
  permission: PermissionPolicySchema.optional()
})
export type CreateSessionParams = z.infer<typeof CreateSessionParams>
/** Pre-parse shape (defaults still optional) — what callers construct. */
export type CreateSessionInput = z.input<typeof CreateSessionParams>

export const ClientRequestSchema = z.discriminatedUnion('method', [
  z.object({ id: z.string(), method: z.literal('catalog.get') }),
  // Per-provider health: binary found on the login-shell PATH, version.
  z.object({ id: z.string(), method: z.literal('doctor.get') }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.create'),
    params: z.object({ path: z.string(), name: z.string().optional() })
  }),
  z.object({ id: z.string(), method: z.literal('workspace.list') }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.delete'),
    params: z.object({ workspaceId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.create'),
    params: z.object({
      workspaceId: z.string(),
      name: z.string(),
      mode: ProjectModeSchema
    })
  }),
  z.object({ id: z.string(), method: z.literal('project.list') }),
  z.object({
    id: z.string(),
    method: z.literal('project.delete'),
    params: z.object({ projectId: z.string() })
  }),
  // Changed files in the project's working tree (git-derived).
  z.object({
    id: z.string(),
    method: z.literal('project.changes'),
    params: z.object({ projectId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.diff'),
    params: z.object({ projectId: z.string(), path: z.string() })
  }),
  // All file paths in a project's working tree (@-mention autocomplete).
  z.object({
    id: z.string(),
    method: z.literal('project.files'),
    params: z.object({ projectId: z.string() })
  }),
  // Read a file the app owns or a project contains (plan documents).
  z.object({
    id: z.string(),
    method: z.literal('file.read'),
    params: z.object({ path: z.string() })
  }),
  // Orchestration rules: structured conduct bounds + routing table. Global
  // (workspaceId null) with whole-object per-workspace overrides.
  z.object({
    id: z.string(),
    method: z.literal('rules.get'),
    params: z.object({ workspaceId: z.string().nullable().default(null) })
  }),
  // Thread defaults (provider/model/reasoning/security for new threads):
  // global with whole-object per-workspace overrides, same as rules.*.
  z.object({
    id: z.string(),
    method: z.literal('defaults.get'),
    params: z.object({ workspaceId: z.string().nullable().default(null) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('defaults.set'),
    params: z.object({
      workspaceId: z.string().nullable().default(null),
      defaults: ThreadDefaultsSchema.nullable()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('rules.set'),
    // rules null clears the scope (global → defaults, override → gone).
    params: z.object({
      workspaceId: z.string().nullable().default(null),
      rules: OrchestrationRulesSchema.nullable()
    })
  }),
  // Slash commands the provider's harness understands in this cwd
  // (Claude skills/commands, codex prompts, cursor commands).
  z.object({
    id: z.string(),
    method: z.literal('commands.list'),
    params: z.object({ provider: providerEnum, cwd: z.string() })
  }),
  // Persist pasted bytes (screenshots) so they have a path like any file.
  z.object({
    id: z.string(),
    method: z.literal('attachment.save'),
    params: z.object({ name: z.string(), dataBase64: z.string() })
  }),
  // Data URL for an attachment/image (transcript thumbnails).
  z.object({
    id: z.string(),
    method: z.literal('attachment.read'),
    params: z.object({ path: z.string() })
  }),
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
    // Model/reasoning ride along per message; a change restarts the harness
    // with resume, so a thread has no fixed model. A provider change goes
    // further: native resume can't cross harnesses, so the registry starts a
    // fresh native session seeded with a transcript handoff.
    params: z.object({
      sessionId: z.string(),
      text: z.string(),
      provider: providerEnum.optional(),
      model: z.string().optional(),
      reasoning: reasoningEnum.optional(),
      attachments: z.array(AttachmentSchema).optional()
    })
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
    method: z.literal('session.rename'),
    params: z.object({ sessionId: z.string(), title: z.string().min(1).max(120) })
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
  }),
  // Answer a pending question-request; answers[i] = chosen labels (or typed
  // text) for questions[i], null = dismissed.
  z.object({
    id: z.string(),
    method: z.literal('session.answer'),
    params: z.object({
      sessionId: z.string(),
      requestId: z.string(),
      answers: z.array(z.array(z.string())).nullable()
    })
  }),
  // Change the approval policy mid-thread; the harness restarts with resume
  // on the next send, same as a model change.
  z.object({
    id: z.string(),
    method: z.literal('session.permission'),
    params: z.object({ sessionId: z.string(), permission: PermissionPolicySchema })
  })
])
export type ClientRequest = z.infer<typeof ClientRequestSchema>

export type ServerResponse =
  { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string }

export type ServerPush =
  | { push: 'event'; row: EventRow }
  | { push: 'session'; session: SessionMeta }
  | { push: 'session-removed'; sessionIds: string[] }

export type ServerFrame = ServerResponse | ServerPush
