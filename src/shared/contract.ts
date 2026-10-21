import { z } from 'zod'
import { M3aRequestSchemas } from './contract-m3a'
import { FsGitRequestSchemas } from './contract-fsgit'
import { CheckpointRequestSchemas } from './contract-checkpoint'
import { LinearRequestSchemas } from './contract-linear'
import { GithubRequestSchemas } from './contract-github'
import { EnvironmentRequestSchemas, RemoteRequestSchemas } from './contract-remote'
import { HarnessRequestSchemas } from './contract-harness'
import { MemoryRequestSchemas } from './contract-memory'
import { AttachmentRequestSchemas } from './contract-attachments'
import { SessionMoveRequestSchemas } from './contract-session-move'
import { MacBridgeRequestSchemas } from './contract-macbridge'
import { CrossHostRequestSchemas } from './contract-crosshost'
import { MacBridgeRulesRequestSchemas } from './contract-macbridge-rules'
import { ProjectPlanRequestSchemas } from './contract-projectplan'
import { BatchRequestSchemas, BatchRulesSchema } from './contract-batch'
import { MacJobRequestSchemas } from './contract-macjobs'
import { HostRequestSchemas } from './contract-host'
import { HostDevicesRequestSchemas } from './contract-hostdevices'
import { ResourcesRequestSchemas } from './contract-resources'
import { AGENT_TYPES } from './catalog'
import { AttachmentSchema, PermissionPolicySchema } from './events'
import { ProjectModeSchema, ThreadTypeSchema } from './domain'
import { OrchestrationRulesSchema, ThreadRulesSchema } from './rules'
import { ThreadDefaultsSchema } from './defaults'
import { PlanSettingsSchema } from './plans'
import { AppshotSettingsSchema } from './appshots'
import { AccountPinsSchema } from './contract-m3a'
import { TurnPassSchema } from './turnpass'
import { ReportFindingsSchema, ReviewSettingsSchema } from './review'
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
  goal: z.string().optional(),
  /** the thread that starts this one through app_start_thread (told when a plan here completes) */
  startedBy: z.string().optional(),
  /** master threads: the master this root thread belongs to */
  masterId: z.string().optional(),
  /** master threads: the sibling a queued thread waits for before it boots */
  after: z.string().optional(),
  /** Queue instead of booting when the host is over its running cap or
   *  `after` is unmet (scheduler.ts); a master's children always queue. */
  queue: z.boolean().optional()
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
  environmentId: z.string().optional(),
  /** `false`: start the child without the project preamble (projectPreamble.ts). */
  preamble: z.boolean().optional()
})

/** Cap on a thread's notes text: a brief, never a transcript. */
export const NOTES_MAX_CHARS = 64_000

export const ClientRequestSchema = z.discriminatedUnion('method', [
  ...M3aRequestSchemas,
  ...FsGitRequestSchemas,
  ...CheckpointRequestSchemas,
  ...LinearRequestSchemas,
  ...GithubRequestSchemas,
  ...RemoteRequestSchemas,
  ...EnvironmentRequestSchemas,
  ...HarnessRequestSchemas,
  ...MemoryRequestSchemas,
  ...AttachmentRequestSchemas,
  ...SessionMoveRequestSchemas,
  ...MacBridgeRequestSchemas,
  ...CrossHostRequestSchemas,
  ...MacBridgeRulesRequestSchemas,
  // The project plan (contract-projectplan.ts): pin, ticks, milestone links.
  ...ProjectPlanRequestSchemas,
  // A master thread's batch (contract-batch.ts): its steps and its children.
  ...BatchRequestSchemas,
  ...MacJobRequestSchemas,
  ...HostRequestSchemas,
  ...HostDevicesRequestSchemas,
  ...ResourcesRequestSchemas,
  // refresh: re-probe the installed CLIs of the probed providers first.
  z.object({
    id: z.string(),
    method: z.literal('catalog.get'),
    params: z.object({ refresh: z.boolean().optional() }).optional()
  }),
  // Per-provider health: binary found on the login-shell PATH, version.
  z.object({ id: z.string(), method: z.literal('doctor.get') }),
  // The warm harness processes (drivers/warm.ts): counts and ages, never a
  // session. `retire` kills them; the next thread start warms again.
  z.object({ id: z.string(), method: z.literal('harness.warm'), params: z.object({ retire: z.boolean().optional() }).optional() }),
  // → MasterRelease | null: master's release.json as this host last read it (local; src/main/deployDrift.ts).
  z.object({ id: z.string(), method: z.literal('deploy.master'), params: z.object({}).optional() }),
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
  // Project preambles (projectPreamble.ts): the project's own text, or
  // the workspace default its projects without one fall back to.
  z.object({
    id: z.string(),
    method: z.literal('project.setPreamble'),
    params: z.object({ projectId: z.string(), preamble: z.string().nullable(), enabled: z.boolean() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.setPreamble'),
    params: z.object({ workspaceId: z.string(), preamble: z.string().nullable(), enabled: z.boolean() })
  }),
  // The project's master thread (CLAUDE.md "Master threads"): pin one, or null to unpin.
  z.object({
    id: z.string(),
    method: z.literal('project.setMaster'),
    params: z.object({ projectId: z.string(), threadId: z.string().nullable() })
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
  // Plan settings (plans.ts): what happens when a plan is complete. Global
  // with whole-object per-project overrides, same shape as defaults.*.
  z.object({
    id: z.string(),
    method: z.literal('plans.get'),
    params: z.object({ projectId: z.string().nullable().default(null) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('plans.set'),
    params: z.object({
      projectId: z.string().nullable().default(null),
      settings: PlanSettingsSchema.nullable()
    })
  }),
  // Start the implementation thread from a finished plan: the one function
  // behind the auto-start, the plan view's button and the phone's sheet.
  z.object({
    id: z.string(),
    method: z.literal('plan.implement'),
    params: z.object({
      sessionId: z.string(),
      provider: providerEnum.optional(),
      model: z.string().optional(),
      reasoning: reasoningEnum.optional(),
      context1m: z.boolean().optional(),
      permission: PermissionPolicySchema.optional(),
      threadType: z.enum(['implementation', 'orchestration']).optional(),
      goal: z.string().optional(),
      threadRules: ThreadRulesSchema.optional()
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
  // Review before merge (shared/review.ts): global set, whole-object
  // per-project override; get answers the override, the global set and
  // the effective one so a dialog shows what a project inherits.
  z.object({
    id: z.string(),
    method: z.literal('review.get'),
    params: z.object({ projectId: z.string().nullable().default(null) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('review.set'),
    params: z.object({
      projectId: z.string().nullable().default(null),
      settings: ReviewSettingsSchema.nullable()
    })
  }),
  // The person merges past a held review ("Merge anyway" on the card).
  z.object({
    id: z.string(),
    method: z.literal('review.override'),
    params: z.object({ sessionId: z.string(), runId: z.string() })
  }),
  // The codex bridge's merge_branch and report_findings (apptools.ts).
  z.object({
    id: z.string(),
    method: z.literal('app.mergeBranch'),
    params: z.object({
      sessionId: z.string(),
      branch: z.string().optional(),
      push: z.boolean().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('app.reportFindings'),
    params: ReportFindingsSchema.extend({ sessionId: z.string() })
  }),
  // The codex bridge's batch_gate (batch.ts): the master's gate once, then the release.
  z.object({
    id: z.string(),
    method: z.literal('app.batchGate'),
    params: z.object({ sessionId: z.string(), notes: z.string().optional(), release: z.boolean().optional() })
  }),
  // The codex bridge's batch_rules (batch.ts): read the rules, or set some of them.
  z.object({
    id: z.string(),
    method: z.literal('app.batchRules'),
    params: z.object({ sessionId: z.string(), rules: BatchRulesSchema.partial().optional() })
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
  // What the session list did since `afterSeq` of `generation` (the
  // server's listChanges.ts): the metas that changed and the ids that
  // left, or `reset` when the log cannot say, and the client lists whole.
  // `afterSeq: 0` with no generation asks for the head alone.
  z.object({
    id: z.string(),
    method: z.literal('session.changes'),
    params: z.object({ afterSeq: z.number().int().nonnegative(), generation: z.string().optional() })
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
  // The composer of an idle thread gained focus: open the upstream socket its
  // next turn will ride (one per account per minute). Answers whether it was
  // asked (false: the thread is mid-turn and already holds one).
  z.object({
    id: z.string(),
    method: z.literal('session.preconnect'),
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
  // Start one queued thread now, past the host's cap and its `after`
  // (the strip's Start now; scheduler.ts).
  z.object({
    id: z.string(),
    method: z.literal('session.start'),
    params: z.object({ sessionId: z.string() })
  }),
  // A proof's seam (local; isolated instances only, TEMP_CODE_E2E_STATUS=1):
  // set a thread's status without a harness, so a pause has something to pause.
  z.object({
    id: z.string(),
    method: z.literal('session.markStatus'),
    params: z.object({ sessionId: z.string(), status: z.enum(['running', 'idle']) })
  }),
  z.object({ id: z.string(), method: z.literal('session.continueAllErrors') }),
  z.object({ id: z.string(), method: z.literal('session.pauseAllRunning') }),
  z.object({ id: z.string(), method: z.literal('session.resumeAllPaused') }),
  /** One action over many threads, four at a time, each id answered:
   *  the rail's Pause all, Resume all, Stop all and Archive done. A
   *  subagent's id acts on its root. `cleanup` (archive only) also
   *  releases each thread's worktree and devices when the host can. */
  z.object({
    id: z.string(),
    method: z.literal('session.batch'),
    params: z.object({
      action: z.enum(['pause', 'resume', 'stop', 'archive']),
      ids: z.array(z.string()),
      cleanup: z.boolean().optional()
    })
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
    method: z.literal('session.setThreadRules'),
    params: z.object({ sessionId: z.string(), threadRules: ThreadRulesSchema.nullable() })
  }),
  // A thread's working notes (src/main/server/threadNotes.ts): the file
  // beside its attachments, mirrored in the database. `get` answers a
  // ThreadNotesDoc; `set` is the person's whole-text edit from the panel.
  z.object({
    id: z.string(),
    method: z.literal('session.notes.get'),
    params: z.object({ sessionId: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.notes.set'),
    params: z.object({ sessionId: z.string(), text: z.string().max(NOTES_MAX_CHARS) })
  }),
  // The codex bridge's update_notes (scripts/app-mcp-bridge.mjs): one
  // section replaced or appended, same as the claude tool.
  z.object({
    id: z.string(),
    method: z.literal('app.updateNotes'),
    params: z.object({
      sessionId: z.string(),
      section: z.string().min(1).max(80),
      mode: z.enum(['replace', 'append']).optional(),
      content: z.string().max(NOTES_MAX_CHARS)
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('session.archive'),
    /** removeResources: archiving also removes the thread's live resources on their hosts (contract-resources.ts). */
    params: z.object({ sessionId: z.string(), archived: z.boolean(), removeResources: z.boolean().optional() })
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
  // The failure card's "Route automatically": re-pick the thread's account
  // fresh (a dead one is out of routing) and respawn there on the next send.
  // Answers { account, moved }.
  z.object({
    id: z.string(),
    method: z.literal('session.reroute'),
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
  // A stored agent page by id, for the desktop showing a thread of another
  // host: the Mac's asset handler asks the thread's host over the peer link.
  z.object({
    id: z.string(),
    method: z.literal('page.read'),
    params: z.object({
      sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      pageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
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
  // plan_complete over WS (the codex bridge): the planner says its plan is done.
  z.object({
    id: z.string(),
    method: z.literal('app.planComplete'),
    params: z.object({ sessionId: z.string(), title: z.string().optional(), summary: z.string().optional() })
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
      environmentId: z.string().optional(),
      /** A master only: the sibling batch thread this one waits for. */
      after: z.string().optional()
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

/** A thread's notes as `session.notes.get` answers and the `notes` push carries. */
export interface ThreadNotesDoc {
  text: string
  /** When the text last changed; null when the thread has no notes yet. */
  updatedAt: number | null
  /** The notes.md on the thread's host, or null when it has no directory yet. */
  path: string | null
}

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
      /** What the host runs (release number, version, commit, platform); the deploy-drift mark reads it. */
      build?: import('./deployDrift').BuildFacts
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
  // A thread's notes changed (the harness's update_notes, the person's
  // edit, or the file edited behind the mirror). Every client gets it;
  // the phone's decoder folds it into its unknown case.
  | { push: 'notes'; sessionId: string; doc: ThreadNotesDoc }
  // A master's batch changed a step (batch.ts: a child landed, the gate or
  // the release moved). Every client gets it; not in the phone's subset.
  | { push: 'batch'; state: import('./contract-batch').BatchState }
  | { push: 'session-removed'; sessionIds: string[] }
  // A thread (`id`, with its subagents `sessionIds`) moved to environment `to`
  // (contract-session-move.ts); sent ahead of the session-removed for it.
  | { push: 'session-moved'; id: string; sessionIds: string[]; to: string }
  // Once per boot, when threads cut mid-turn by the last shutdown came back
  // (resumeAfterBoot.ts): how many, and the boot's time the toast dedupes by.
  // Sent to every open socket when the resume finishes and to each later socket after hello.
  | { push: 'boot-resume'; count: number; at: number }
  // Aliax accounts: the whole snapshot, whenever it is rebuilt.
  | { push: 'accounts'; snapshot: import('./accounts').AccountsSnapshot }
  // Master's release number as this host last read it from GitHub (deployDrift.ts); local sockets only.
  | { push: 'deploy-master'; master: import('./deployDrift').MasterRelease | null }
  // Account sync (thread V): an owner rotated a grant; only sockets that
  // pulled (another host's main process) get these, never a renderer.
  | { push: 'account'; from: string; transfer: import('aliax-core/sync').Transfer }
  // Account sync: a host deleted profiles; the same sockets as `account`.
  | { push: 'accounts-removed'; from: string; removed: import('./accounts').AccountRemoval[] }
  // The Mac bridge (contract-macbridge.ts): `peer.call` to a registered Mac's
  // link only; `macBridge.*` to the Mac's own local sockets only.
  | import('./contract-macbridge').MacBridgePush
  // Deploy and publish from the app (contract-host.ts): to the sockets that asked for the job's log.
  | import('./contract-host').HostLogPush
  // Devices on a Mac (contract-hostdevices.ts): to a socket with a viewer open, every 30 s.
  | import('./contract-hostdevices').HostDevicesPush
  // Memory sync (contract-memory.ts): a receiver's nudge down a driver's link.
  | import('./contract-memory').MemoryNudgePush
  // Thread resources (contract-resources.ts): a thread's ledger rows after any change.
  | import('./contract-resources').ResourcesPush
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
