import { z } from 'zod'
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance
} from '@anthropic-ai/claude-agent-sdk'
import {
  CATALOG,
  visibleCatalog,
  modelInfo,
  resolveModel,
  supportsContext1m,
  type ProviderId
} from '@shared/catalog'
import type { SessionMeta } from '@shared/events'
import {
  HTML_PREVIEW_TOOL_DESCRIPTION,
  HTML_PREVIEW_TOOL_NAME,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_SHOWN_MESSAGE,
  HTML_RENDER_TOOL_DESCRIPTION,
  HTML_RENDER_TOOL_NAME,
  HTML_TOOL_PARAMS,
  type HtmlRenderAppearance,
  type HtmlRenderReference
} from '@shared/htmlRender'
import { CITE_CLAIM_MAX, CITE_TOOL_DESCRIPTION, CITE_TOOL_NAME, CITE_TOOL_PARAMS } from '@shared/research'
import { NOTES_MAX_CHARS } from '@shared/contract'
import {
  canonicalSection,
  NOTE_SECTIONS,
  sectionBody,
  UPDATE_NOTES_DESCRIPTION,
  UPDATE_NOTES_PARAMS,
  UPDATE_NOTES_TOOL_NAME
} from '@shared/notes'
import {
  MERGE_BRANCH_PARAMS,
  MERGE_BRANCH_TOOL_DESCRIPTION,
  MERGE_BRANCH_TOOL_NAME,
  REPORT_FINDINGS_PARAMS,
  REPORT_FINDINGS_TOOL_DESCRIPTION,
  REPORT_FINDINGS_TOOL_NAME,
  REVIEW_FINDINGS_MAX,
  REVIEW_FINDING_PARAMS
} from '@shared/review'
import { mergeReviews } from './mergeReview'
import { preview as previewHtml, publish as publishHtml, type HtmlPreview } from './htmlRender'
import { INLINE_DIGEST_MAX_CHARS, mirrorRelPath, threadDigest } from './mirror'
import type { SessionRegistry } from './sessions'
import { macToolsHooks } from './macTools'
import type { CrossHostAgents } from './crossHostAgents'
import type { ProjectPlans } from './projectPlan'
import { HOST_PARAM_DESCRIPTION, toolLine } from './orchestration'
import { CROSS_HOST_EVENTS_MAX, type ThreadEventsResult } from '@shared/contract-crosshost'

/**
 * App tools (docs/PLAN-2.md M10): every thread is a first-class citizen of
 * the app. list/read siblings on demand, and start new threads — a planning
 * thread whose plan is approved kicks off the implementation itself; a chat
 * that crystallized starts a planning thread seeded from itself. Attached
 * to every claude session (codex/cursor reach the same registry functions
 * through the app.* WS methods + stdio bridge).
 *
 * No delete, no archive, no rules editing — destructive and policy surfaces
 * stay human. app_start_thread's guardrail is social: instruction-gated
 * (only on user ask/agreement), loudly visible in the UI, and the new
 * thread inherits the caller's permission — never more than the user granted.
 */

let registry: SessionRegistry | null = null
// Threads on other hosts (crossHostAgents.ts): app_start_thread with environmentId goes there.
let crossHost: CrossHostAgents | null = null
export function setAppCrossHost(c: CrossHostAgents | null): void {
  crossHost = c
}
export function setAppToolsRegistry(r: SessionRegistry): void {
  registry = r
}

// ── the stdio bridge (codex; cursor lacks per-run MCP config) ────────
// scripts/app-mcp-bridge.mjs is a dependency-free stdio MCP server that
// connects back to the app's WS port and forwards the three tools as
// app.* methods. The codex driver registers it per thread.

export interface AppBridgeInfo {
  port: number
  scriptPath: string
  /** node, bun, or the Electron-as-node fallback — resolved once at boot. */
  command: string
  env: Record<string, string>
}

let bridge: AppBridgeInfo | null = null
export function setAppBridge(info: AppBridgeInfo | null): void {
  bridge = info
}
export function hasAppBridge(): boolean {
  return bridge !== null
}

/** MCP server entry for a codex thread's config override (config.toml
 *  shape: command/args/env). */
export function bridgeMcpConfig(sessionId: string): Record<string, unknown> | null {
  if (!bridge) return null
  return {
    command: bridge.command,
    args: [bridge.scriptPath],
    env: {
      ...bridge.env,
      TEMP_CODE_PORT: String(bridge.port),
      TEMP_CODE_SESSION: sessionId,
      // The Mac bridge's per-thread token, only while the thread's bridge is on (macTools.ts).
      ...(macToolsHooks.current?.bridgeEnv(sessionId) ?? {})
    },
    // wait_for_agent sleeps until a subagent settles — codex must not
    // kill the call with its default per-tool timeout.
    tool_timeout_sec: 86_400
  }
}

const providerIds = Object.keys(CATALOG) as [ProviderId, ...ProviderId[]]

const threadRow = (s: SessionMeta): Record<string, unknown> => ({
  threadId: s.id,
  title: s.title,
  threadType: s.threadType,
  status: s.status,
  model: `${s.provider} · ${s.model}`,
  ...(s.planPath ? { planPath: s.planPath } : {}),
  transcript: mirrorRelPath(s),
  updated: new Date(s.updatedAt).toISOString()
})

// ── registry-level operations (shared by the MCP tools and, later, the
// app.* WS methods the codex/cursor bridge calls) ─────────────────────

export function appListThreads(
  reg: SessionRegistry,
  caller: SessionMeta,
  allProjects: boolean
): Record<string, unknown>[] {
  return reg
    .list()
    .filter((s) => !s.parentId && !s.archived)
    .filter((s) => allProjects || (caller.projectId && s.projectId === caller.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(threadRow)
}

export async function appReadThread(
  reg: SessionRegistry,
  threadId: string,
  caller?: SessionMeta
): Promise<string | null> {
  // A `<host>:<id>` thread this caller started or spawned on another host:
  // its rows come over the link (crossHostAgents.ts) and read like a digest.
  if (caller && crossHost?.isRemote(threadId)) {
    const r = await crossHost.events(caller, threadId, 0, CROSS_HOST_EVENTS_MAX)
    if (typeof r === 'string') return r
    return remoteDigest(threadId, r)
  }
  const meta = reg.get(threadId)
  if (!meta) return null
  let digest = threadDigest(reg, meta)
  if (digest.length > INLINE_DIGEST_MAX_CHARS) {
    digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
  }
  return digest
}

/** The rows of a thread on another host as the same kind of digest: dialogue plus one-line tool actions. */
export function remoteDigest(threadId: string, r: ThreadEventsResult): string {
  const lines: string[] = [`_${threadId} on its host · status ${r.status} · ${r.rows.length} rows (through seq ${r.lastSeq})_`, '']
  for (const { event } of r.rows) {
    const e = event as { type?: string; text?: string; delta?: boolean; name?: string; input?: unknown; message?: string; status?: string; parentCallId?: string }
    switch (e.type) {
      case 'user-text':
        lines.push(`**User:** ${e.text ?? ''}`, '')
        break
      case 'assistant-text':
        if (!e.delta && !e.parentCallId && e.text) lines.push(e.text, '')
        break
      case 'tool-call':
        if (e.name) lines.push(`- ${toolLine(e.name, e.input)}`)
        break
      case 'error':
        lines.push(`_error: ${e.message ?? ''}_`, '')
        break
      case 'status':
        if (e.status && e.status !== 'running' && e.status !== 'starting') lines.push(`_status: ${e.status}_`, '')
        break
    }
  }
  let digest = lines.join('\n')
  if (digest.length > INLINE_DIGEST_MAX_CHARS) digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
  return digest
}

export interface StartThreadArgs {
  threadType: 'chat' | 'planning' | 'project-plan' | 'implementation' | 'orchestration' | 'research'
  provider: ProviderId
  model?: string
  reasoning?: string
  projectId?: string
  planPath?: string
  seedThreadIds?: string[]
  firstMessage: string
  title?: string
  /** Claude models with a 1M window only; refused for anything else. */
  context1m?: boolean
  /** Start it on another host: `mac`, or an environment id (crossHostAgents.ts). */
  environmentId?: string
}

/** Create a thread and kick it off exactly as if the user had — same
 *  preambles, plan seed, project context, thread-reference digests.
 *  Returns a corrective refusal string on invalid input. */
export async function appStartThread(
  reg: SessionRegistry,
  caller: SessionMeta,
  args: StartThreadArgs
): Promise<{ threadId: string; title: string; host?: string; cwd?: string; cwdNote?: string } | string> {
  // A model id names its harness: a gpt model requested under provider
  // "claude" routes to codex. Only a model NO provider serves is refused.
  const requested = args.model || CATALOG[args.provider].defaultModel
  const { provider, model } = resolveModel(args.provider, requested)
  if (!modelInfo(provider, model)) {
    const visible = visibleCatalog()
    return `refused: no provider serves model "${requested}". Valid: ${(Object.keys(visible) as ProviderId[]).map((p) => `${p}: ${visible[p].models.map((m) => m.id).join(', ')}`).join('; ')}`
  }
  const info = modelInfo(provider, model)!
  const reasoning = (args.reasoning ??
    info.defaultReasoning ??
    'medium') as SessionMeta['reasoning']
  if (info.reasoning.length && !info.reasoning.includes(reasoning)) {
    return `refused: ${model} supports reasoning ${info.reasoning.join('|')}, not "${reasoning}".`
  }
  if (args.context1m && !supportsContext1m(provider, model)) {
    return `refused: ${model} does not offer the 1M context window — only Claude models do. Start the thread without context1m, or pick a Claude model.`
  }
  const projectId = args.projectId ?? caller.projectId
  if (args.projectId && !reg.getProject(args.projectId)) {
    return `refused: unknown projectId "${args.projectId}".`
  }
  // On another host: the Mac maps this box's cwd onto its own checkout and
  // runs the thread as its own (remote/crossHostThreads.ts); seeds stay
  // here, since the Mac has no copy of these threads.
  if (args.environmentId?.trim()) {
    if (!crossHost) return 'refused: threads on other hosts are not available here'
    if (args.seedThreadIds?.length) return 'refused: seedThreadIds cannot ride to another host; put what the thread needs into firstMessage.'
    const callerNow = reg.get(caller.id) ?? caller
    const cwd = (projectId ? reg.getProject(projectId)?.cwd : null) ?? callerNow.cwd
    try {
      const started = await crossHost.startThread(callerNow, args.environmentId, {
        threadType: args.threadType,
        provider,
        model,
        reasoning,
        ...(args.context1m ? { context1m: true } : {}),
        firstMessage: args.firstMessage,
        ...(args.title ? { title: args.title } : {}),
        ...(args.planPath ? { planPath: args.planPath } : {}),
        cwd
      })
      return started
    } catch (err) {
      return `refused: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const seeds = (args.seedThreadIds ?? []).map((id) => reg.get(id))
  if (seeds.some((s) => !s)) {
    return `refused: seedThreadIds contains an unknown thread id. app_list_threads shows valid ids.`
  }
  // "Start implementation from this plan" is zero-config: the caller's own
  // plan file is the default for the types that execute one.
  const planPath =
    args.planPath ??
    ((args.threadType === 'implementation' || args.threadType === 'orchestration') &&
    caller.planPath
      ? caller.planPath
      : undefined)
  // Fresh read: the caller's CURRENT permission is what the new thread
  // inherits — it can never grant itself more than the user granted.
  const callerNow = reg.get(caller.id) ?? caller
  const thread = await reg.create({
    provider,
    model,
    reasoning,
    permission: callerNow.permission,
    ...(args.context1m ? { context1m: true } : {}),
    projectId,
    threadType: args.threadType,
    planPath,
    title: args.title,
    parentId: null,
    // The caller hears when a plan it started completes (planFlow.ts).
    startedBy: caller.id,
    ...(projectId ? {} : { cwd: caller.cwd })
  })
  await reg.send(thread.id, args.firstMessage, {
    attachments: seeds.length
      ? seeds.map((s) => ({
          path: `thread:${s!.id}`,
          name: s!.title,
          kind: 'thread' as const,
          sessionId: s!.id
        }))
      : undefined
  })
  const created = reg.get(thread.id) ?? thread
  return { threadId: thread.id, title: created.title }
}

// ── thread notes (threadNotes.ts) ────────────────────────────────────

export interface UpdateNotesArgs {
  section: string
  mode?: 'replace' | 'append'
  content: string
}

/** One section replaced or appended in the caller's notes; the answer
 *  names the file (the harness may read it directly) and the section's
 *  size, never the whole text — the model wrote it. */
export function appUpdateNotes(reg: SessionRegistry, caller: SessionMeta, args: UpdateNotesArgs): string {
  const section = canonicalSection(args.section)
  if (!section) return 'refused: section must name a heading.'
  if (args.content.length > NOTES_MAX_CHARS) return `refused: content over ${NOTES_MAX_CHARS} characters — notes are a brief, not a transcript.`
  const mode = args.mode ?? 'replace'
  const doc = reg.notes.update(caller.id, { section, mode, content: args.content })
  const body = sectionBody(doc.text, section)
  const lines = body ? body.split('\n').filter((l) => l.trim()).length : 0
  const known = (NOTE_SECTIONS as readonly string[]).includes(section) ? '' : ' (a heading of your own, kept after the fixed ones)'
  return `notes updated: ${section} ${mode === 'append' ? 'appended' : 'replaced'}, now ${lines} line${lines === 1 ? '' : 's'}${known}.${doc.path ? ` File: ${doc.path}` : ''}`
}

export const UPDATE_NOTES_SHAPE = {
  section: z.string().min(1).max(80).describe(UPDATE_NOTES_PARAMS.section),
  mode: z.enum(['replace', 'append']).optional().describe(UPDATE_NOTES_PARAMS.mode),
  content: z.string().max(NOTES_MAX_CHARS).describe(UPDATE_NOTES_PARAMS.content)
}

// ── agent HTML pages (ported from T3 Code) ───────────────────────────

export interface HtmlPreviewArgs {
  html: string
  width?: number
  appearance?: HtmlRenderAppearance
}

export interface HtmlRenderArgs {
  html: string
  title: string
  height: number
}

/** Screenshot + metrics of a page; throws with a message the agent can act on. */
export function appHtmlPreview(args: HtmlPreviewArgs): Promise<HtmlPreview> {
  return previewHtml(args)
}

/** Publish a page into the calling thread; throws with a message the agent can act on. */
export async function appHtmlRender(
  sessionId: string,
  args: HtmlRenderArgs
): Promise<{ htmlRender: HtmlRenderReference; message: string }> {
  const htmlRender = await publishHtml({ sessionId, ...args })
  return { htmlRender, message: HTML_RENDER_SHOWN_MESSAGE }
}

/** The MCP content parts of a preview: the metrics as JSON, then the screenshot. */
export function htmlPreviewContent(result: HtmlPreview): Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
> {
  const { png, ...metrics } = result
  return [
    { type: 'text', text: JSON.stringify(metrics) },
    { type: 'image', data: png, mimeType: 'image/png' }
  ]
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

/** Errors come back as tool results, so the model reads the message and fixes the page. */
async function htmlTool(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true
    }
  }
}

export const HTML_PREVIEW_SHAPE = {
  html: z.string().min(1).max(512_000).describe(HTML_TOOL_PARAMS.html),
  width: z.number().int().min(240).max(1600).optional().describe(HTML_TOOL_PARAMS.width),
  appearance: z.enum(['dark', 'light']).optional().describe(HTML_TOOL_PARAMS.appearance)
}

export const HTML_RENDER_SHAPE = {
  html: z.string().min(1).max(512_000).describe(HTML_TOOL_PARAMS.html),
  title: z.string().min(1).max(HTML_RENDER_MAX_TITLE_LENGTH).describe(HTML_TOOL_PARAMS.title),
  height: z
    .number()
    .int()
    .min(HTML_RENDER_MIN_HEIGHT)
    .max(HTML_RENDER_MAX_HEIGHT)
    .describe(HTML_TOOL_PARAMS.height)
}

export const htmlPreviewTool = (args: HtmlPreviewArgs): Promise<ToolResult> =>
  htmlTool(async () => ({ content: htmlPreviewContent(await appHtmlPreview(args)) }))

export const htmlRenderTool = (sessionId: string, args: HtmlRenderArgs): Promise<ToolResult> =>
  htmlTool(async () => text(JSON.stringify(await appHtmlRender(sessionId, args))))

// ── the MCP toolset (claude sessions, in-process) ────────────────────

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: t }]
})

export const CITE_SHAPE = {
  url: z.string().min(1).max(2000).describe(CITE_TOOL_PARAMS.url),
  claim: z.string().min(1).max(CITE_CLAIM_MAX).describe(CITE_TOOL_PARAMS.claim),
  title: z.string().max(300).optional().describe(CITE_TOOL_PARAMS.title)
}

let projectPlans: ProjectPlans | null = null
export function setProjectPlans(plans: ProjectPlans | null): void {
  projectPlans = plans
}

export const PLAN_COMPLETE_TOOL_NAME = 'plan_complete'
export const PLAN_COMPLETE_TOOL_DESCRIPTION =
  'Planning and project-plan threads only: say the plan is COMPLETE — the plan file is fully written and every decision is settled. Call it once, as the last tool call before your closing message. For an ordinary plan the app then starts the implementation thread itself (when auto-start is on) and tells whoever started this plan; a project plan gets `status: complete` and the user picks the next milestone from its options — nothing starts on its own. Refused while the plan file is missing or empty.'
export const PLAN_COMPLETE_SHAPE = {
  summary: z.string().optional().describe('One line on what the plan covers (optional)')
}

export const MERGE_BRANCH_SHAPE = {
  branch: z.string().optional().describe(MERGE_BRANCH_PARAMS.branch),
  push: z.boolean().optional().describe(MERGE_BRANCH_PARAMS.push)
}

export const REPORT_FINDINGS_SHAPE = {
  findings: z
    .array(
      z.object({
        file: z.string().describe(REVIEW_FINDING_PARAMS.file),
        line: z.number().int().optional().describe(REVIEW_FINDING_PARAMS.line),
        summary: z.string().describe(REVIEW_FINDING_PARAMS.summary),
        failure_scenario: z.string().describe(REVIEW_FINDING_PARAMS.failure_scenario),
        verdict: z.enum(['CONFIRMED', 'PLAUSIBLE']).optional().describe(REVIEW_FINDING_PARAMS.verdict),
        category: z.string().max(40).optional().describe(REVIEW_FINDING_PARAMS.category),
        short_summary: z.string().max(60).optional().describe(REVIEW_FINDING_PARAMS.short_summary)
      })
    )
    .max(REVIEW_FINDINGS_MAX)
    .describe(REPORT_FINDINGS_PARAMS.findings),
  level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe(REPORT_FINDINGS_PARAMS.level)
}

/** The plan tools a thread gets: plan_complete for the two types that write a plan. */
function writesPlan(session: SessionMeta): boolean {
  return (session.threadType === 'planning' || session.threadType === 'project-plan') && !session.parentId
}

export function appToolsMcp(session: SessionMeta): McpSdkServerConfigWithInstance {
  // cite_source exists only inside a research tree (the handle reboots on
  // a retype, so the check at boot is current); elsewhere it would only refuse.
  const research = registry?.researchRootOf(session.id) !== null
  return createSdkMcpServer({
    name: 'app',
    version: '0.1.0',
    tools: [
      ...(research
        ? [
            tool(CITE_TOOL_NAME, CITE_TOOL_DESCRIPTION, CITE_SHAPE, async (args) =>
              text(registry ? registry.citeSource(session.id, args) : 'app registry not ready')
            )
          ]
        : []),
      ...(writesPlan(session)
        ? [
            tool(PLAN_COMPLETE_TOOL_NAME, PLAN_COMPLETE_TOOL_DESCRIPTION, PLAN_COMPLETE_SHAPE, async (args) => {
              if (!registry) return text('app registry not ready')
              // A project plan completes into its file (projectPlan.ts); an
              // ordinary plan into the plan flow (planFlow.ts).
              if (session.threadType === 'project-plan') {
                return text(projectPlans ? projectPlans.complete(session.id) : 'app registry not ready')
              }
              const result = await registry.completePlan(session.id, args)
              return text(typeof result === 'string' ? result : JSON.stringify(result))
            })
          ]
        : []),
      tool(
        'app_list_threads',
        "List this project's threads (the live version of the project-context index): id, title, type, status, model, plan file, transcript path, last activity.",
        {
          allProjects: z
            .boolean()
            .default(false)
            .describe("true: every project's threads, not just this one's")
        },
        async (args) => {
          if (!registry) return text('app registry not ready')
          return text(JSON.stringify(appListThreads(registry, session, args.allProjects)))
        }
      ),
      tool(
        'app_read_thread',
        'Read another thread as a readable digest (dialogue + one-line tool actions). Works across projects, and for a `<host>:<id>` thread this one started or spawned on another host.',
        { threadId: z.string() },
        async (args) => {
          if (!registry) return text('app registry not ready')
          const digest = await appReadThread(registry, args.threadId, session)
          return text(
            digest ??
              `refused: unknown thread "${args.threadId}". app_list_threads shows valid ids.`
          )
        }
      ),
      tool(
        'app_start_thread',
        'Create a new thread and send its first message — it starts working immediately, visibly. Use ONLY when the user asked for a handoff or agreed to one (e.g. plan approved → implementation thread; chat crystallized → planning thread seeded from it; a research-shaped ask → research thread, which runs on claude).',
        {
          threadType: z.enum(['chat', 'planning', 'project-plan', 'implementation', 'orchestration', 'research']),
          provider: z.enum(providerIds),
          model: z
            .string()
            .optional()
            .describe(
              `Defaults per provider: ${providerIds.map((p) => `${p}=${CATALOG[p].defaultModel}`).join(', ')}`
            ),
          reasoning: z
            .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
            .optional()
            .describe("Must be on the chosen model's ladder; defaults to the model's default"),
          context1m: z
            .boolean()
            .optional()
            .describe(
              'Claude models only: run the thread with the 1M context window. Rejected for models that do not offer it.'
            ),
          projectId: z.string().optional().describe("Defaults to this thread's project"),
          environmentId: z.string().optional().describe(HOST_PARAM_DESCRIPTION),
          planPath: z
            .string()
            .optional()
            .describe(
              "implementation/orchestration: the plan file to work from. Defaults to THIS thread's plan when it has one."
            ),
          seedThreadIds: z
            .array(z.string())
            .optional()
            .describe('Digests of these threads ride along with the first message'),
          firstMessage: z
            .string()
            .describe('The kickoff message — complete and self-contained; you write it'),
          title: z.string().optional()
        },
        async (args) => {
          if (!registry) return text('app registry not ready')
          const result = await appStartThread(registry, session, args)
          if (typeof result === 'string') return text(result)
          return text(
            JSON.stringify({
              ...result,
              note: 'thread created and working — visible to the user now'
            })
          )
        }
      ),
      tool(UPDATE_NOTES_TOOL_NAME, UPDATE_NOTES_DESCRIPTION, UPDATE_NOTES_SHAPE, async (args) =>
        text(registry ? appUpdateNotes(registry, session, args) : 'app registry not ready')
      ),
      // merge_branch on every thread: the merge itself, with the project's
      // review in front of it when that is on (mergeReview.ts).
      tool(MERGE_BRANCH_TOOL_NAME, MERGE_BRANCH_TOOL_DESCRIPTION, MERGE_BRANCH_SHAPE, async (args) => {
        const reviews = mergeReviews()
        const live = registry?.get(session.id) ?? session
        return text(reviews ? await reviews.mergeBranch(live, args) : 'refused: merge reviews are not available here')
      }),
      // report_findings only for the reviewer thread of a run: the handle
      // boots after the run is registered, so the check at boot is current.
      ...(mergeReviews()?.isReviewer(session.id)
        ? [
            tool(REPORT_FINDINGS_TOOL_NAME, REPORT_FINDINGS_TOOL_DESCRIPTION, REPORT_FINDINGS_SHAPE, async (args) =>
              text(mergeReviews()?.reportFindings(session, args) ?? 'refused: merge reviews are not available here')
            )
          ]
        : []),
      tool(HTML_PREVIEW_TOOL_NAME, HTML_PREVIEW_TOOL_DESCRIPTION, HTML_PREVIEW_SHAPE, (args) =>
        htmlPreviewTool(args)
      ),
      tool(HTML_RENDER_TOOL_NAME, HTML_RENDER_TOOL_DESCRIPTION, HTML_RENDER_SHAPE, (args) =>
        htmlRenderTool(session.id, args)
      )
    ]
  })
}

export const APP_TOOLS = [
  'mcp__app__plan_complete',
  'mcp__app__app_list_threads',
  'mcp__app__app_read_thread',
  'mcp__app__app_start_thread',
  `mcp__app__${UPDATE_NOTES_TOOL_NAME}`,
  `mcp__app__${HTML_PREVIEW_TOOL_NAME}`,
  `mcp__app__${HTML_RENDER_TOOL_NAME}`,
  `mcp__app__${CITE_TOOL_NAME}`,
  `mcp__app__${PLAN_COMPLETE_TOOL_NAME}`,
  `mcp__app__${MERGE_BRANCH_TOOL_NAME}`,
  `mcp__app__${REPORT_FINDINGS_TOOL_NAME}`
]
