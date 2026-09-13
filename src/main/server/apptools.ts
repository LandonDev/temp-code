import { z } from 'zod'
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance
} from '@anthropic-ai/claude-agent-sdk'
import {
  CATALOG,
  modelInfo,
  resolveModel,
  supportsContext1m,
  type ProviderId
} from '@shared/catalog'
import type { SessionMeta } from '@shared/events'
import { INLINE_DIGEST_MAX_CHARS, mirrorRelPath, threadDigest } from './mirror'
import type { SessionRegistry } from './sessions'

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
      TEMP_CODE_SESSION: sessionId
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

export function appReadThread(reg: SessionRegistry, threadId: string): string | null {
  const meta = reg.get(threadId)
  if (!meta) return null
  let digest = threadDigest(reg, meta)
  if (digest.length > INLINE_DIGEST_MAX_CHARS) {
    digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
  }
  return digest
}

export interface StartThreadArgs {
  threadType: 'chat' | 'planning' | 'implementation' | 'orchestration' | 'research'
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
}

/** Create a thread and kick it off exactly as if the user had — same
 *  preambles, plan seed, project context, thread-reference digests.
 *  Returns a corrective refusal string on invalid input. */
export async function appStartThread(
  reg: SessionRegistry,
  caller: SessionMeta,
  args: StartThreadArgs
): Promise<{ threadId: string; title: string } | string> {
  // A model id names its harness: a gpt model requested under provider
  // "claude" routes to codex. Only a model NO provider serves is refused.
  const requested = args.model || CATALOG[args.provider].defaultModel
  const { provider, model } = resolveModel(args.provider, requested)
  if (model !== requested) {
    return `refused: no provider serves model "${requested}". Valid: ${(Object.keys(CATALOG) as ProviderId[]).map((p) => `${p}: ${CATALOG[p].models.map((m) => m.id).join(', ')}`).join('; ')}`
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

// ── the MCP toolset (claude sessions, in-process) ────────────────────

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: t }]
})

export function appToolsMcp(session: SessionMeta): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'app',
    version: '0.1.0',
    tools: [
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
        'Read another thread as a readable digest (dialogue + one-line tool actions). Works across projects.',
        { threadId: z.string() },
        async (args) => {
          if (!registry) return text('app registry not ready')
          const digest = appReadThread(registry, args.threadId)
          return text(
            digest ??
              `refused: unknown thread "${args.threadId}". app_list_threads shows valid ids.`
          )
        }
      ),
      tool(
        'app_start_thread',
        'Create a new thread and send its first message — it starts working immediately, visibly. Use ONLY when the user asked for a handoff or agreed to one (e.g. plan approved → implementation thread; chat crystallized → planning thread seeded from it).',
        {
          threadType: z.enum(['chat', 'planning', 'implementation', 'orchestration', 'research']),
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
      )
    ]
  })
}

export const APP_TOOLS = [
  'mcp__app__app_list_threads',
  'mcp__app__app_read_thread',
  'mcp__app__app_start_thread'
]
