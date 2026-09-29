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
  // Harness idle, but non-ambient background tasks or session crons are
  // live: the process stays up and the thread wakes itself when they land.
  'watching',
  'paused',
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

/** A rendered face for a tool call (file read, diff, shell, search) the
 *  driver already worked out — the UI shows it instead of guessing from
 *  the raw input. Mirrors MonoCode's ToolPreview. */
export const ToolPreviewSchema = z.object({
  kind: z.enum(['read', 'write', 'shell', 'search']),
  title: z.string().optional(),
  path: z.string().optional(),
  fileName: z.string().optional(),
  startLine: z.number().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  query: z.string().optional(),
  lines: z
    .array(
      z.object({
        number: z.number().optional(),
        kind: z.enum(['add', 'del', 'context']),
        text: z.string()
      })
    )
    .optional(),
  output: z.string().optional()
})
export type ToolPreview = z.infer<typeof ToolPreviewSchema>

/** Which bucket a usage limit hit: the rolling 5h or weekly window, credits, a per-model cap, or a per-minute limiter that lifts by itself. */
export const LimitWindowSchema = z.union([
  z.enum(['5h', 'weekly', 'credits', 'transient']),
  z.object({ model: z.string() })
])
export type LimitWindow = z.infer<typeof LimitWindowSchema>

export const AgentEventSchema = z.discriminatedUnion('type', [
  // A message the user (or the orchestrator, for subagents) sent in.
  z.object({
    type: z.literal('user-text'),
    text: z.string(),
    attachments: z.array(AttachmentSchema).optional(),
    /** run settings at send time — the board's pass history renders them */
    model: z.string().optional(),
    reasoning: z.string().optional(),
    context1m: z.boolean().optional(),
    fast: z.boolean().optional(),
    /** the user pressed the pass button for this send (true) or typed under
     *  the banner (false) — absent on logs from before the stamp, where the
     *  fold falls back to inferring pass boundaries */
    newPass: z.boolean().optional()
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
    display: z.object({ app: z.string().optional(), action: z.string().optional() }).optional(),
    /** driver-rendered face (ported harnesses that mine their own previews) */
    preview: ToolPreviewSchema.optional()
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

  // A web source consulted anywhere in a research thread's agent tree —
  // harvested server-side from WebSearch/WebFetch tool calls and appended
  // to the ROOT research session, so the sources board gets persistence,
  // backfill, and live push for free. A query event (no url) opens a
  // query header; url events are the sources beneath it. An event with
  // the same callId replaces the earlier one (title enrichment).
  z.object({
    type: z.literal('research-source'),
    callId: z.string(),
    url: z.string().optional(),
    query: z.string().optional(),
    agentId: z.string(),
    agentLabel: z.string(),
    title: z.string().optional()
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
  // The harness produced a plan document (plan mode / a plan pane).
  z.object({ type: z.literal('plan'), text: z.string() }),

  z.object({ type: z.literal('turn-pass'), actions: z.array(z.string()) }),

  // Dormant supervision: a subagent settled and the server handed its
  // report straight to the parent harness — never through the user-visible
  // message queue. This event is the transcript's quiet record of why the
  // next turn started.
  z.object({
    type: z.literal('agent-report'),
    agentId: z.string(),
    title: z.string(),
    status: z.string()
  }),

  // Background work the harness is waiting on (descriptions of live
  // non-ambient tasks and session crons; replace semantics, empty = none).
  // Folded by the registry into the 'Waiting on …' header line; no block.
  z.object({ type: z.literal('background-tasks'), tasks: z.array(z.string()) }),

  // One background task settled — the transcript's record of why the
  // thread woke.
  z.object({
    type: z.literal('background-task'),
    taskId: z.string(),
    description: z.string(),
    status: z.enum(['completed', 'failed', 'stopped'])
  }),

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

  // Live context footprint: what the conversation occupies in the model's
  // window RIGHT NOW, updated as replies stream. Never persisted — the
  // registry folds it onto SessionMeta.context and drops the event.
  z.object({
    type: z.literal('context'),
    tokens: z.number(),
    /** the window those tokens count against, when the harness knows it */
    window: z.number().optional()
  }),

  // Goal lifecycle (claude /goal, codex thread goals): the harness confirms
  // every transition — the app never emits these optimistically.
  z.object({
    type: z.literal('goal'),
    phase: z.enum(['set', 'updated', 'met', 'cleared']),
    condition: z.string(),
    /** claude: how many end-of-turn checks the goal has survived */
    iterations: z.number().optional(),
    /** claude: the checker's last verdict ("tests still failing") */
    reason: z.string().optional(),
    /** the model set/changed the goal itself (codex create_goal/update_goal) */
    byModel: z.boolean().optional()
  }),

  // Orchestration: this session spawned a child session.
  z.object({ type: z.literal('agent-spawned'), childSessionId: z.string() }),

  // stopped: the turn ended because the user hit Stop — shown as a quiet
  // "Stopped" note, never as a failure, and it never arms recovery.
  // limit: the message named a usage limit (a CLI synthetic message or a
  // Codex turn error) — the registry switches accounts and continues by
  // itself; 'transient' names a per-minute limiter the harness retries.
  z.object({
    type: z.literal('error'),
    message: z.string(),
    stopped: z.boolean().optional(),
    limit: z.object({ window: LimitWindowSchema }).optional()
  }),

  // The user hit Continue after fixing what killed the turn (e.g. switched
  // accounts on a session limit): every error shown so far is settled —
  // the UI hides the chips and the harness picks the work back up.
  z.object({ type: z.literal('errors-cleared') })
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
  pinned: boolean
  archived: boolean
  permission: PermissionPolicy
  /** Claude fast mode (faster output on supported models); harness restarts on change. */
  fast: boolean
  /** Opt into the 1M-token context window beta (claude). */
  context1m: boolean
  /** When the current working stretch began (first message of the run);
   *  survives steers and queue drains, null while truly idle. */
  busySince: number | null
  /** Wall-clock time when a manual pause took effect. Persisted so a
   *  restart cannot turn a paused run into a stale idle run. */
  pausedAt: number | null
  /** Active working time captured at pause. This excludes the paused span
   *  and becomes the resumed busySince anchor after Continue succeeds. */
  frozenActiveElapsed: number | null
  /** Provider-native session/thread id, once known (for resume). */
  nativeId: string | null
  /** The Aliax account this thread spends from: the expected pick (its project's or
   *  workspace's pin, else the best account for its model) until the gateway routes it
   *  elsewhere; null when no account is known yet. */
  account?: string | null
  /** What a working thread is doing right now ("Editing PromptBar.tsx") —
   *  transient, server-memory only, null the moment the turn settles. */
  activity?: string | null
  /** The activity's family, tinting the busy spinner: investigating
   *  (reads/searches), editing (writes/commands), or thinking. */
  activityKind?: 'think' | 'investigate' | 'edit' | null
  /** How far through its CURRENT task list the thread is — server-folded
   *  from the log so a tab shows it without opening the thread. Null when
   *  this pass has no list yet. `current` names the in-progress task. */
  tasks?: { done: number; total: number; current?: string | null } | null
  /** The active goal, folded from goal events; null/absent when none. */
  goal?: { condition: string; iterations: number; setAt: number } | null
  /** Live context footprint from the harness stream — current the moment
   *  a reply lands, for every thread, selected or not. The last reading
   *  is kept on the session row so a relaunch starts from it. */
  context?: { tokens: number; window: number | null } | null
  /** Stored-log fold: the latest failed turn has not been cleared or
   *  superseded by later conversation work. */
  canContinue?: boolean
  /** Root-tree summaries. These count one visible root even when several
   *  descendants need recovery or carry live/paused work. */
  treeCanContinue?: boolean
  treeHasLiveWork?: boolean
  treeHasPaused?: boolean
  treeFrozenActiveElapsed?: number | null
  /** Orchestration threads: this run's tune — conduct overrides on top of
   *  the workspace/global rules, plus free-text instructions. */
  threadRules?: import('./rules').ThreadRules | null
  createdAt: number
  updatedAt: number
}
