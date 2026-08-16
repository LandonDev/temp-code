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
      mode: ProjectModeSchema,
      /** worktree fork point (a ref like origin/main); default: workspace HEAD */
      baseRef: z.string().optional(),
      /** adopt an existing branch instead of creating tc/<slug> */
      existingBranch: z.string().optional()
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
  // ── file service (docs/PLAN-3.md M11) — project-scoped, cwd-jailed ──
  z.object({
    id: z.string(),
    method: z.literal('fs.list'),
    params: z.object({ projectId: z.string(), dir: z.string().default('') })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.read'),
    params: z.object({ projectId: z.string(), path: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.write'),
    params: z.object({ projectId: z.string(), path: z.string(), content: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.create'),
    params: z.object({ projectId: z.string(), path: z.string(), kind: z.enum(['file', 'dir']) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.rename'),
    params: z.object({ projectId: z.string(), path: z.string(), to: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.delete'),
    params: z.object({ projectId: z.string(), path: z.string() })
  }),
  // Per-connection watcher subscription; events arrive as file-event pushes.
  z.object({
    id: z.string(),
    method: z.literal('fs.watch'),
    params: z.object({ projectId: z.string(), subscribe: z.boolean() })
  }),
  // ── git flow (docs/PLAN-3.md M12) — always `git -C <project cwd>` ───
  z.object({
    id: z.string(),
    method: z.literal('project.commit'),
    params: z.object({
      projectId: z.string(),
      message: z.string().min(1),
      /** commit only these paths; omitted = everything changed */
      paths: z.array(z.string()).optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.push'),
    params: z.object({ projectId: z.string(), targetBranch: z.string().optional() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.log'),
    params: z.object({ projectId: z.string(), limit: z.number().default(20) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.branches'),
    params: z.object({ workspaceId: z.string() })
  }),
  // `git show HEAD:<path>` — the diff surface's left (original) side.
  z.object({
    id: z.string(),
    method: z.literal('project.show'),
    params: z.object({ projectId: z.string(), path: z.string() })
  }),
  // ── language servers (docs/PLAN-3.md M13) — lifecycle only; the LSP
  // protocol itself rides a dedicated /lsp/<serverId> WS path.
  z.object({
    id: z.string(),
    method: z.literal('lsp.ensure'),
    params: z.object({ projectId: z.string(), lang: z.enum(['java', 'web']) })
  }),
  z.object({ id: z.string(), method: z.literal('lsp.status') }),
  // ── AI ghost text (docs/PLAN-3.md M14) — fill-in-the-middle over the
  // user's existing Claude auth; the app holds no credentials.
  z.object({
    id: z.string(),
    method: z.literal('fim.complete'),
    params: z.object({
      projectId: z.string(),
      path: z.string(),
      prefix: z.string(),
      suffix: z.string()
    })
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
  // Message queue: messages composed while a turn runs wait in a
  // per-session FIFO and auto-send as turns settle. Steer sends into the
  // live turn instead (providers that can't steer front-queue).
  z.object({
    id: z.string(),
    method: z.literal('queue.list'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('queue.add'),
    params: z.object({
      sessionId: z.string(),
      text: z.string().min(1),
      provider: providerEnum.optional(),
      model: z.string().optional(),
      reasoning: reasoningEnum.optional(),
      attachments: z.array(AttachmentSchema).optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('queue.remove'),
    params: z.object({ sessionId: z.string(), messageId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('queue.update'),
    params: z.object({ sessionId: z.string(), messageId: z.string(), text: z.string().min(1) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('queue.reorder'),
    params: z.object({ sessionId: z.string(), order: z.array(z.string()) })
  }),
  // Send a queued message NOW, into the running turn where the provider
  // supports it; otherwise it jumps to the front of the queue.
  z.object({
    id: z.string(),
    method: z.literal('queue.steer'),
    params: z.object({ sessionId: z.string(), messageId: z.string() })
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
  }),
  // Session tuning: fast mode / 1M context. Harness restarts with resume
  // on the next send, same as a model change.
  z.object({
    id: z.string(),
    method: z.literal('session.tune'),
    params: z.object({
      sessionId: z.string(),
      fast: z.boolean().optional(),
      context1m: z.boolean().optional()
    })
  }),
  // Live context-window usage breakdown (claude: the /context data);
  // null when the provider has no live handle or no accounting.
  z.object({
    id: z.string(),
    method: z.literal('session.context'),
    params: z.object({ sessionId: z.string() })
  }),
  // App tools over WS (docs/PLAN-2.md M10): what the in-process claude
  // toolset does, reachable by the codex stdio bridge. sessionId is the
  // calling thread — validated against the registry like any other method.
  z.object({
    id: z.string(),
    method: z.literal('app.listThreads'),
    params: z.object({ sessionId: z.string(), allProjects: z.boolean().default(false) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.readThread'),
    params: z.object({ sessionId: z.string(), threadId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.startThread'),
    params: z.object({
      sessionId: z.string(),
      threadType: ThreadTypeSchema,
      provider: providerEnum,
      model: z.string().optional(),
      reasoning: reasoningEnum.optional(),
      projectId: z.string().optional(),
      planPath: z.string().optional(),
      seedThreadIds: z.array(z.string()).optional(),
      firstMessage: z.string(),
      title: z.string().optional()
    })
  })
])
export type ClientRequest = z.infer<typeof ClientRequestSchema>

export type ServerResponse =
  { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string }

/** One waiting message in a session's queue. */
export interface QueuedMessage {
  id: string
  text: string
  ts: number
  provider?: string
  model?: string
  reasoning?: string
  attachments?: import('./events').Attachment[]
}

export type ServerPush =
  | { push: 'event'; row: EventRow }
  | { push: 'session'; session: SessionMeta }
  | { push: 'queue'; sessionId: string; items: QueuedMessage[] }
  | { push: 'session-removed'; sessionIds: string[] }
  // Watcher spine (M11): project-relative path, debounced ~100 ms.
  | { push: 'file-event'; projectId: string; path: string; kind: 'changed' | 'created' | 'deleted' }

export type ServerFrame = ServerResponse | ServerPush
