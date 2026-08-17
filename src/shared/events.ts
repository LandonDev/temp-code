import { z } from 'zod'
import type { AgentType, ProviderId, Reasoning } from './catalog'
import type { ThreadType } from './domain'

/**
 * The normalized event schema. Every driver (Claude Agent SDK, Codex
 * app-server, cursor-agent stream-json) translates its native stream into
 * these events. The UI renders ONLY this schema — it never sees a
 * provider-native payload.
 */

export const SessionStatusSchema = z.enum([
  'starting',
  'idle',
  'running',
  'waiting',
  'error',
  'done'
])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

/**
 * Per-session approval policy: safe → the harness asks for everything
 * dangerous, edits → file edits auto-accepted (default), auto → no
 * prompts at all (trusted/worktree sessions).
 */
export const PermissionPolicySchema = z.enum(['safe', 'edits', 'auto'])
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>

/**
 * Block identity: a turn can span several provider messages (text → tool →
 * text). Deltas and their authoritative finals carry (msgId, blockIndex) so
 * folding replaces the right block instead of "the last one of that kind".
 * parentCallId marks output that belongs to an in-harness subagent (e.g. the
 * Task tool) — the UI nests it under that tool call instead of the main flow.
 */
const blockIdentity = {
  msgId: z.string().optional(),
  blockIndex: z.number().optional(),
  parentCallId: z.string().optional()
}

/** A file the user attached to a message. Images go to the model as
 *  content; other files ride along as path references the harness reads.
 *  kind 'thread' references another thread (M9): the server writes a local
 *  digest file and rewrites the message's @thread:<id> token to its path —
 *  thread attachments never reach the harness as files.
 *  kind 'appshot' is a window capture (M10): path is the screenshot PNG,
 *  textPath the window's accessibility text. The server expands it into a
 *  plain image + file pair before the harness sees it. */
export const AttachmentSchema = z.object({
  path: z.string(),
  name: z.string(),
  mime: z.string().optional(),
  kind: z.enum(['image', 'file', 'thread', 'appshot']),
  /** kind 'thread': the referenced thread's session id */
  sessionId: z.string().optional(),
  /** kind 'appshot': the captured window's AX text (absent when thin) */
  textPath: z.string().optional()
})
export type Attachment = z.infer<typeof AttachmentSchema>

export const AgentEventSchema = z.discriminatedUnion('type', [
  // A message the user (or the orchestrator, for subagents) sent in.
  z.object({
    type: z.literal('user-text'),
    text: z.string(),
    attachments: z.array(AttachmentSchema).optional(),
    /** run settings at send time — the board's pass history renders them */
    model: z.string().optional(),
    reasoning: z.string().optional(),
    context1m: z.boolean().optional()
  }),

  // Assistant output. delta=true → streaming chunk to append;
  // delta=false → authoritative full block (replaces accumulated deltas).
  z.object({
    type: z.literal('assistant-text'),
    text: z.string(),
    delta: z.boolean(),
    ...blockIdentity
  }),

  // Reasoning/thinking stream, same delta semantics.
  z.object({ type: z.literal('thinking'), text: z.string(), delta: z.boolean(), ...blockIdentity }),

  // Tool lifecycle. callId ties call to result. An event with the same
  // callId replaces the earlier one (early "tool started" → full input).
  // partial=true → a streaming preview of the input while it's still being
  // generated; a later event without the flag carries the complete input.
  z.object({
    type: z.literal('tool-call'),
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
    partial: z.boolean().optional(),
    parentCallId: z.string().optional(),
    /** humanized face for addon calls (codex appContext): app + action */
    display: z.object({ app: z.string().optional(), action: z.string().optional() }).optional()
  }),
  z.object({
    type: z.literal('tool-result'),
    callId: z.string(),
    output: z.string(),
    /** a connector answered "reauthenticate" — the link fixes it */
    reauth: z.object({ app: z.string(), url: z.string() }).optional(),
    isError: z.boolean(),
    parentCallId: z.string().optional()
  }),

  // Session lifecycle.
  z.object({
    type: z.literal('status'),
    status: SessionStatusSchema,
    detail: z.string().optional()
  }),

  // End-of-turn pass (the workspace "completed turn" setting): the server
  // injected a follow-up instruction after the turn settled. Everything
  // from here to the next turn-complete belongs to the pass — the UI
  // highlights those tool calls apart from the turn's own work.
  z.object({ type: z.literal('turn-pass'), actions: z.array(z.string()) }),

  // End of a turn, with whatever accounting the provider reports.
  z.object({
    type: z.literal('turn-complete'),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional()
  }),

  // The harness asked permission for a tool call; the user answers in the
  // UI (session.approve). callId ties the card to its tool chip.
  z.object({
    type: z.literal('approval-request'),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    title: z.string().optional(),
    callId: z.string().optional()
  }),
  // auto=true → resolved by policy (timeout/interrupt), not the user.
  z.object({
    type: z.literal('approval-resolved'),
    requestId: z.string(),
    allow: z.boolean(),
    auto: z.boolean().optional()
  }),

  // The model stopped to ask the user structured questions (claude's
  // AskUserQuestion, codex's item/tool/requestUserInput). Answered in the
  // UI via session.answer.
  z.object({
    type: z.literal('question-request'),
    requestId: z.string(),
    questions: z.array(
      z.object({
        question: z.string(),
        /** short chip label, e.g. "Auth method" */
        header: z.string().optional(),
        multiSelect: z.boolean().optional(),
        /** a typed free-text answer is accepted ("Other") */
        allowFreeform: z.boolean().optional(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() }))
      })
    ),
    callId: z.string().optional()
  }),
  // answers[i] = chosen labels (or the typed text) for questions[i];
  // null → dismissed without answering.
  z.object({
    type: z.literal('question-resolved'),
    requestId: z.string(),
    answers: z.array(z.array(z.string())).nullable()
  }),

  // Context compaction lifecycle (claude): the harness squeezes the
  // conversation. UI renders this distinctly from normal working.
  z.object({
    type: z.literal('compaction'),
    phase: z.enum(['start', 'done', 'failed']),
    trigger: z.enum(['auto', 'manual']).optional(),
    preTokens: z.number().optional(),
    postTokens: z.number().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional()
  }),

  // Cumulative token-counter snapshot mid-turn (codex emits these
  // throttled from tokenUsage/updated; claude only reports at turn end).
  // Per-task token deltas derive from snapshots at task boundaries —
  // where no snapshot brackets a task, the UI shows nothing, never a guess.
  z.object({
    type: z.literal('usage'),
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
  /** broadcast-only row (streaming preview) — never in the log, seq -1 */
  ephemeral?: boolean
}

export interface SessionMeta {
  id: string
  parentId: string | null
  /** project this thread belongs to (null: legacy or orphan) */
  projectId: string | null
  /** one-off chats outside a project: the workspace they hang off (null
   *  when the thread has a project, or floats outside workspaces entirely) */
  workspaceId: string | null
  /** null for subagent children — they render on the parent's board, not the strip */
  threadType: ThreadType | null
  /** planning threads: where the plan document lives; seeded threads: the source plan */
  planPath: string | null
  provider: ProviderId
  model: string
  reasoning: Reasoning
  agentType: AgentType
  title: string
  cwd: string
  status: SessionStatus
  archived: boolean
  permission: PermissionPolicy
  /** Claude fast mode (faster output on supported models); harness restarts on change. */
  fast: boolean
  /** Opt into the 1M-token context window beta (claude). */
  context1m: boolean
  /** When the current working stretch began (first message of the run);
   *  survives steers and queue drains, null while truly idle. */
  busySince: number | null
  /** Provider-native session/thread id, once known (for resume). */
  nativeId: string | null
  /** What a working thread is doing right now ("Editing PromptBar.tsx") —
   *  transient, server-memory only, null the moment the turn settles. */
  activity?: string | null
  createdAt: number
  updatedAt: number
}
