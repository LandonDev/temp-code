import { z } from 'zod'
import { M3aRequestSchemas } from './contract-m3a'
import { FsGitRequestSchemas } from './contract-fsgit'
import { CheckpointRequestSchemas } from './contract-checkpoint'
import { LinearRequestSchemas } from './contract-linear'
import { GithubRequestSchemas } from './contract-github'
import { EnvironmentRequestSchemas, RemoteRequestSchemas } from './contract-remote'
import { HarnessRequestSchemas } from './contract-harness'
import { AttachmentRequestSchemas } from './contract-attachments'
import { SessionMoveRequestSchemas } from './contract-session-move'
import { MacBridgeRequestSchemas } from './contract-macbridge'
import { CrossHostRequestSchemas } from './contract-crosshost'
import { MacBridgeRulesRequestSchemas } from './contract-macbridge-rules'
import { MacJobRequestSchemas } from './contract-macjobs'
import { AGENT_TYPES } from './catalog'
import { AttachmentSchema, PermissionPolicySchema } from './events'
import { ProjectModeSchema, ThreadTypeSchema } from './domain'
import { OrchestrationRulesSchema, ThreadRulesSchema } from './rules'
import { ThreadDefaultsSchema } from './defaults'
import { AppshotSettingsSchema } from './appshots'
import { AccountPinsSchema } from './contract-m3a'
import { TurnPassSchema } from './turnpass'
import { BuildConfigSchema } from './build'
import type { BuildRun } from './build'
import type { EventRow, SessionMeta } from './events'

/** Git teardown options when a worktree project is archived or deleted. */
const ProjectCleanupSchema = z.object({
  worktree: z.boolean().optional(),
  localBranch: z.boolean().optional(),
  remoteBranch: z.boolean().optional()
})

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

const providerEnum = z.enum(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx'])
const reasoningEnum = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export const CreateSessionParams = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
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
  /** one-off chat outside a project: hang it off this workspace (cwd = its path) */
  workspaceId: z.string().nullable().default(null),
  threadType: ThreadTypeSchema.nullable().default(null),
  /** planning handoff: seed an implementation/orchestration thread from this plan file */
  planPath: z.string().optional(),
  permission: PermissionPolicySchema.optional(),
  /** claude models with a 1M-capable window: start on the full window */
  context1m: z.boolean().optional(),
  /** orchestration: per-run conduct overrides + custom instructions */
  threadRules: ThreadRulesSchema.optional(),
  /** set this goal on the harness before the kickoff message (plan Start) */
  goal: z.string().optional()
})
export type CreateSessionParams = z.infer<typeof CreateSessionParams>
/** Pre-parse shape (defaults still optional) — what callers construct. */
export type CreateSessionInput = z.input<typeof CreateSessionParams>

export interface SessionBatchResult {
  attempted: string[]
  succeeded: string[]
  failed: { sessionId: string; error: string }[]
}

/** One spawn_agent entry (single call or batch member). Deliberately
 *  loose: models mangle enums ("anthropic", agentType "worker"). The op
 *  aliases, resolves, and clamps instead of failing — a hard schema error
 *  here reads as "the app rejected the model". */
const SpawnAgentSpecSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  agentType: z.string().optional(),
  task: z.string().optional(),
  useWorktree: z.boolean().optional(),
  context1m: z.boolean().optional(),
  /** Run on another host: `mac`, or an environment id (contract-crosshost.ts). */
  environmentId: z.string().optional()
})

export const ClientRequestSchema = z.discriminatedUnion('method', [
  ...M3aRequestSchemas,
  ...FsGitRequestSchemas,
  ...CheckpointRequestSchemas,
  ...LinearRequestSchemas,
  ...GithubRequestSchemas,
  ...RemoteRequestSchemas,
  ...EnvironmentRequestSchemas,
  ...HarnessRequestSchemas,
  ...AttachmentRequestSchemas,
  ...SessionMoveRequestSchemas,
  ...MacBridgeRequestSchemas,
  ...CrossHostRequestSchemas,
  ...MacBridgeRulesRequestSchemas,
  ...MacJobRequestSchemas,
  // refresh: re-probe the installed CLIs of the probed providers first.
  z.object({
    id: z.string(),
    method: z.literal('catalog.get'),
    params: z.object({ refresh: z.boolean().optional() }).optional()
  }),
  // Per-provider health: binary found on the login-shell PATH, version.
  z.object({ id: z.string(), method: z.literal('doctor.get') }),
  // Update a provider's CLI in place; returns its fresh health row.
  z.object({
    id: z.string(),
    method: z.literal('providers.update'),
    params: z.object({ provider: providerEnum })
  }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.create'),
    params: z.object({ path: z.string(), name: z.string().optional() })
  }),
  z.object({ id: z.string(), method: z.literal('workspace.list') }),
  /** → WorkRoot: where new workspaces go on this host, for a client with no dialog here. */
  z.object({ id: z.string(), method: z.literal('workspace.root') }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.delete'),
    params: z.object({ workspaceId: z.string() })
  }),
  // Sidebar logo: repo favicon / GitHub avatar as a data URL, else the git host.
  z.object({
    id: z.string(),
    method: z.literal('workspace.icon'),
    params: z.object({ workspaceId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.create'),
    params: z.object({
      workspaceId: z.string(),
      name: z.string(),
      mode: ProjectModeSchema,
      /** branch the worktree targets: adopted when it exists, created when
       *  it doesn't; omitted = auto tc/<slug> */
      branch: z.string().optional(),
      /** where a new branch forks from (a ref like origin/main); default: workspace HEAD */
      baseRef: z.string().optional()
    })
  }),
  z.object({ id: z.string(), method: z.literal('project.list') }),
  z.object({
    id: z.string(),
    method: z.literal('project.rename'),
    params: z.object({ projectId: z.string(), name: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.setAccounts'),
    params: z.object({ projectId: z.string(), pins: AccountPinsSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.setAccounts'),
    params: z.object({ workspaceId: z.string(), pins: AccountPinsSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.setBranch'),
    params: z.object({
      projectId: z.string(),
      /** existing name switches the checkout; a new one is created from baseRef */
      branch: z.string(),
      baseRef: z.string().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.archive'),
    params: z.object({
      projectId: z.string(),
      archived: z.boolean(),
      cleanup: ProjectCleanupSchema.optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('project.delete'),
    params: z.object({ projectId: z.string(), cleanup: ProjectCleanupSchema.optional() })
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
  // `git show <ref>:<path>` — the diff surface's left (original) side;
  // ref defaults to HEAD, the Branch rail passes the merge base.
  z.object({
    id: z.string(),
    method: z.literal('project.show'),
    params: z.object({ projectId: z.string(), path: z.string(), ref: z.string().optional() })
  }),
  // ── branch compare / merge (Branch rail) ─────────────────────────────
  // No target → the server's default (origin/HEAD, main, master, …); the
  // result names the target it used.
  z.object({
    id: z.string(),
    method: z.literal('project.compare'),
    params: z.object({ projectId: z.string(), target: z.string().optional() })
  }),
  // Bring the target's commits into this checkout (merge or rebase).
  // Conflicts abort and come back as { ok: false, conflicts }.
  z.object({
    id: z.string(),
    method: z.literal('project.mergeFrom'),
    params: z.object({
      projectId: z.string(),
      target: z.string(),
      mode: z.enum(['merge', 'rebase']).default('merge')
    })
  }),
  // Land this branch on a local target: in the checkout holding it when
  // one exists (and is clean), else via merge-tree without any checkout.
  z.object({
    id: z.string(),
    method: z.literal('project.mergeInto'),
    params: z.object({ projectId: z.string(), target: z.string() })
  }),
  // ── build (Build rail) ───────────────────────────────────────────────
  // Config mirrors turnpass.*: workspace default, optional project override.
  z.object({
    id: z.string(),
    method: z.literal('build.get'),
    params: z.object({ workspaceId: z.string(), projectId: z.string().optional() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('build.set'),
    params: z.object({
      workspaceId: z.string(),
      projectId: z.string().optional(),
      config: BuildConfigSchema.nullable()
    })
  }),
  // What a project would run: override → workspace → detected → null.
  // `branch` points detection at that branch's checkout instead.
  z.object({
    id: z.string(),
    method: z.literal('build.effective'),
    params: z.object({ projectId: z.string(), branch: z.string().optional() })
  }),
  // Branches a project can build without switching its checkout.
  z.object({
    id: z.string(),
    method: z.literal('build.targets'),
    params: z.object({ projectId: z.string() })
  }),
  // The build branch vs origin: ahead/behind as last fetched, and whether
  // origin has moved since (ls-remote).
  z.object({
    id: z.string(),
    method: z.literal('build.remote'),
    params: z.object({ projectId: z.string(), branch: z.string().optional() })
  }),
  // Fetch origin/<branch> (progress arrives as `sync` pushes) and
  // fast-forward the local branch where it lives; resolves with the new
  // remote status.
  z.object({
    id: z.string(),
    method: z.literal('build.pull'),
    params: z.object({ projectId: z.string(), branch: z.string().optional() })
  }),
  // Detected defaults for a path (settings placeholders).
  z.object({
    id: z.string(),
    method: z.literal('build.detect'),
    params: z.object({ path: z.string() })
  }),
  // `branch` (default: the project's own) picks where the build runs — a
  // checkout holding it, else an app-managed detached build worktree.
  z.object({
    id: z.string(),
    method: z.literal('build.run'),
    params: z.object({ projectId: z.string(), branch: z.string().optional() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('build.cancel'),
    params: z.object({ projectId: z.string() })
  }),
  // Last run + buffered log lines, so a re-opened panel replays.
  z.object({
    id: z.string(),
    method: z.literal('build.status'),
    params: z.object({ projectId: z.string() })
  }),
  // Code Vision (docs/PLAN-4.md follow-up): last editor of a method range.
  z.object({
    id: z.string(),
    method: z.literal('project.blame'),
    params: z.object({
      projectId: z.string(),
      path: z.string(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive()
    })
  }),
  // ── language servers (docs/PLAN-3.md M13) — lifecycle only; the LSP
  // protocol itself rides a dedicated /lsp/<serverId> WS path.
  z.object({
    id: z.string(),
    method: z.literal('lsp.ensure'),
    params: z.object({ projectId: z.string(), lang: z.enum(['java', 'web', 'idea']) })
  }),
  z.object({ id: z.string(), method: z.literal('lsp.status') }),
  // ── IntelliJ engine (docs/PLAN-4.md M15): EULA gate for intellij-server.
  z.object({ id: z.string(), method: z.literal('idea.eula') }),
  z.object({ id: z.string(), method: z.literal('idea.acceptEula') }),
  z.object({ id: z.string(), method: z.literal('idea.checkUpdate') }),
  // ── debugger (docs/PLAN-4.md M20): bridge a DAP TCP port into a WS tunnel.
  z.object({
    id: z.string(),
    method: z.literal('dap.connect'),
    params: z.object({ port: z.number().int().positive() })
  }),
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
  // Completed-turn pass: actions the model runs after every settled turn
  // (verify / build / commit / push). The workspace holds the default; a
  // projectId targets that project's override instead (get: null =
  // inherits; set null: back to inheriting).
  z.object({
    id: z.string(),
    method: z.literal('turnpass.get'),
    params: z.object({ workspaceId: z.string(), projectId: z.string().optional() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('turnpass.set'),
    params: z.object({
      workspaceId: z.string(),
      projectId: z.string().optional(),
      pass: TurnPassSchema.nullable()
    })
  }),
  // Appshots (M10): global capture settings, one settings-table row.
  z.object({
    id: z.string(),
    method: z.literal('appshots.get'),
    params: z.object({})
  }),
  z.object({
    id: z.string(),
    method: z.literal('appshots.set'),
    params: z.object({ settings: AppshotSettingsSchema })
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
  // Unarchived sessions by default; `archived: true` lists the archived ones.
  // A remote connection gets one page (`SessionPage` in wire.ts) and walks
  // the rest with `cursor`; a local one gets the whole array, as before.
  z.object({
    id: z.string(),
    method: z.literal('session.list'),
    params: z
      .object({
        archived: z.boolean().optional(),
        projectId: z.string().optional(),
        cursor: z.string().optional()
      })
      .optional()
  }),
  // One renderer-measured stall line for <userData>/logs/stalls.log.
  z.object({ id: z.string(), method: z.literal('stall.report'), params: z.object({ line: z.string() }) }),
  z.object({
    id: z.string(),
    method: z.literal('session.events'),
    // `tail`: only the last N user turns (the renderer paints those first and
    // asks for the rest with `beforeSeq`); a shorter log comes back whole.
    params: z.object({
      sessionId: z.string(),
      afterSeq: z.number().int().default(0),
      beforeSeq: z.number().int().optional(),
      tail: z.number().int().positive().optional(),
      // At most this many rows from afterSeq on: the renderer walks a long
      // head in slices so no one call reads a 40k-row log in one go.
      limit: z.number().int().positive().optional()
    })
  }),
  // One persisted row whole, bodies and all: what a remote connection asks
  // for when a row it holds with an OmittedBody opens (wire.ts).
  z.object({
    id: z.string(),
    method: z.literal('session.rowBody'),
    params: z.object({ sessionId: z.string(), seq: z.number().int().positive() })
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
      attachments: z.array(AttachmentSchema).optional(),
      /** this send starts a new pass (the board's pass button) */
      newPass: z.boolean().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.interrupt'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.pause'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.resume'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({ id: z.string(), method: z.literal('session.continueAllErrors') }),
  z.object({ id: z.string(), method: z.literal('session.pauseAllRunning') }),
  z.object({ id: z.string(), method: z.literal('session.resumeAllPaused') }),
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
    method: z.literal('session.setThreadRules'),
    params: z.object({ sessionId: z.string(), threadRules: ThreadRulesSchema.nullable() })
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
    method: z.literal('session.continue'),
    // With a model, every restarted thread in the tree switches to it first.
    params: z.object({
      sessionId: z.string(),
      provider: providerEnum.optional(),
      model: z.string().optional(),
      reasoning: reasoningEnum.optional()
    })
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
    // Text and the per-message run settings edit independently; null clears
    // a setting so the message follows the thread again.
    params: z.object({
      sessionId: z.string(),
      messageId: z.string(),
      text: z.string().min(1).optional(),
      provider: providerEnum.nullable().optional(),
      model: z.string().nullable().optional(),
      reasoning: reasoningEnum.nullable().optional()
    })
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
  // Session tuning: fast mode / 1M context / model. Harness restarts with
  // resume on the next send. A model of another provider is ignored here
  // (send() switches the harness); the same provider's model lands at once.
  z.object({
    id: z.string(),
    method: z.literal('session.tune'),
    params: z.object({
      sessionId: z.string(),
      fast: z.boolean().optional(),
      ultrafast: z.boolean().optional(),
      context1m: z.boolean().optional(),
      model: z.string().min(1).optional()
    })
  }),
  // Change the thread's type mid-conversation. The harness restarts with
  // resume on the next send, which also carries the new type's instructions.
  z.object({
    id: z.string(),
    method: z.literal('session.retype'),
    params: z.object({ sessionId: z.string(), threadType: ThreadTypeSchema })
  }),
  // Goal (claude /goal, codex thread goals): a finish condition the agent
  // works toward until the harness confirms it is met. The fold onto
  // SessionMeta.goal comes only from harness-confirmed goal events.
  z.object({
    id: z.string(),
    method: z.literal('session.setGoal'),
    params: z.object({ sessionId: z.string(), condition: z.string().min(1) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.clearGoal'),
    params: z.object({ sessionId: z.string() })
  }),
  // Compact the conversation in place (claude /compact, codex
  // thread/compact/start); progress arrives as compaction events.
  z.object({
    id: z.string(),
    method: z.literal('session.compact'),
    params: z.object({ sessionId: z.string() })
  }),
  // Kill the background tasks a watching thread waits on: every watching
  // member of the tree drops its harness and settles idle. Running turns
  // are left alone.
  z.object({
    id: z.string(),
    method: z.literal('session.killBackground'),
    params: z.object({ sessionId: z.string() })
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
    method: z.literal('app.htmlPreview'),
    params: z.object({
      sessionId: z.string(),
      html: z.string().min(1).max(512_000),
      width: z.number().int().min(240).max(1600).optional(),
      appearance: z.enum(['dark', 'light']).optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.htmlRender'),
    params: z.object({
      sessionId: z.string(),
      html: z.string().min(1).max(512_000),
      title: z.string().min(1).max(200),
      height: z.number().int().min(80).max(2000)
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.citeSource'),
    params: z.object({
      sessionId: z.string(),
      url: z.string().min(1).max(2000),
      claim: z.string().min(1).max(300),
      title: z.string().max(300).optional()
    })
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
      context1m: z.boolean().optional(),
      projectId: z.string().optional(),
      planPath: z.string().optional(),
      seedThreadIds: z.array(z.string()).optional(),
      firstMessage: z.string(),
      title: z.string().optional(),
      /** Start it on another host: `mac`, or an environment id (contract-crosshost.ts). */
      environmentId: z.string().optional()
    })
  }),
  // Orchestration over WS — the codex bridge's spawn/supervise path. Same
  // ops the in-process claude toolset wraps; sessionId is the caller and
  // every agentId is validated to be that caller's own child.
  z.object({
    id: z.string(),
    method: z.literal('app.spawnAgent'),
    params: SpawnAgentSpecSchema.extend({
      sessionId: z.string(),
      // A batch: up to 16 entries, each its own task; top-level fields
      // are defaults. The op refuses an over-long or half-empty batch.
      agents: z.array(SpawnAgentSpecSchema).optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.sendToAgent'),
    params: z.object({ sessionId: z.string(), agentId: z.string(), message: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.checkAgent'),
    params: z.object({ sessionId: z.string(), agentId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.waitForAgent'),
    params: z.object({
      sessionId: z.string(),
      agentId: z.string().optional(),
      agentIds: z.array(z.string()).optional(),
      mode: z.enum(['any', 'all']).optional(),
      timeoutSeconds: z.number().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.answerAgent'),
    params: z.object({
      sessionId: z.string(),
      agentId: z.string(),
      requestId: z.string(),
      answers: z.array(z.array(z.string())).optional(),
      /** An approval on another host (a `<host>:<id>` agent): true allows, false denies. */
      allow: z.boolean().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.interruptAgent'),
    params: z.object({ sessionId: z.string(), agentId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.listAgents'),
    params: z.object({ sessionId: z.string() })
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
  // First frame on every socket: which environment answered, the contract
  // it speaks and what this caller may do (plan 5jtfkIC45Cbr).
  | {
      push: 'hello'
      environmentId: string
      contract: number
      caps: import('./capabilities').Capability[]
      key?: { id: string; name: string }
    }
  | { push: 'workspaces'; workspaces: import('./domain').WorkspaceMeta[] }
  | { push: 'projects'; projects: import('./domain').ProjectMeta[] }
  | { push: 'event'; row: EventRow }
  | { push: 'session'; session: SessionMeta }
  // Remote connections only (wire.ts PushCoalescer): the pushes of about
  // 100 ms as one frame per kind. `events` holds one session's rows in
  // order, `sessions` the newest meta per session, `live-edits` the edits
  // in order, `builds` one entry per run with its lines joined. A local
  // connection keeps the singular frames above.
  | { push: 'events'; sessionId: string; rows: EventRow[] }
  | { push: 'sessions'; sessions: SessionMeta[] }
  | { push: 'live-edits'; items: Omit<Extract<ServerPush, { push: 'live-edit' }>, 'push'>[] }
  | { push: 'builds'; items: Omit<Extract<ServerPush, { push: 'build' }>, 'push'>[] }
  | { push: 'queue'; sessionId: string; items: QueuedMessage[] }
  | { push: 'session-removed'; sessionIds: string[] }
  // A thread (`id`, with its subagents `sessionIds`) moved to environment `to`
  // (contract-session-move.ts); sent ahead of the session-removed for it.
  | { push: 'session-moved'; id: string; sessionIds: string[]; to: string }
  // Aliax accounts: the whole snapshot, whenever it is rebuilt.
  | { push: 'accounts'; snapshot: import('./accounts').AccountsSnapshot }
  // Account sync (thread V): an owner rotated a grant; only sockets that
  // pulled (another host's main process) get these, never a renderer.
  | { push: 'account'; from: string; transfer: import('aliax-core/sync').Transfer }
  // The Mac bridge (contract-macbridge.ts): `peer.call` to a registered Mac's
  // link only; `macBridge.*` to the Mac's own local sockets only.
  | import('./contract-macbridge').MacBridgePush
  // Watcher spine (M11): project-relative path, debounced ~100 ms.
  | { push: 'file-event'; projectId: string; path: string; kind: 'changed' | 'created' | 'deleted' }
  // Build rail: run state plus any new log lines (batched ~50 ms). A new
  // run id means the renderer starts a fresh log.
  | { push: 'build'; projectId: string; run: BuildRun; lines?: string[] }
  // build.pull progress: git's latest progress line and its percent, if any.
  | { push: 'sync'; projectId: string; branch: string; line: string; percent: number | null }
  // Live change stream (docs/PLAN-5.md M22): disk-truth diffs while a
  // session runs. Ephemeral — never persisted; renderer state only.
  | {
      push: 'live-edit'
      cwd: string
      sessionIds: string[]
      edit: {
        path: string
        kind: 'changed' | 'created' | 'deleted'
        adds?: number
        dels?: number
        diff: string | null
        bytes?: number
        burst?: boolean
        settled?: boolean
        ts: number
      }
    }

export type ServerFrame = ServerResponse | ServerPush
