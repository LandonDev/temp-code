import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_TYPES, CATALOG, type ProviderId } from '@shared/catalog'
import type { EventRow, SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'

const execFileP = promisify(execFile)

/**
 * Orchestration (docs/PLAN.md M6). The orchestrator is not special: any
 * claude session whose agentType is 'orchestrator' gets this MCP toolset
 * (spawn_agent / send_to_agent / wait_for_agent / list_agents) plus a
 * router rubric appended to the system prompt. Children are ordinary
 * sessions with parentId set — the sidebar tree and agent-spawned events
 * already exist, so subagents are visible for free.
 */

// server/index.ts injects the registry at boot (avoids a driver→registry
// import cycle).
let registry: SessionRegistry | null = null
export function setOrchestrationRegistry(r: SessionRegistry): void {
  registry = r
}

const providerIds = Object.keys(CATALOG) as [ProviderId, ...ProviderId[]]

/** Writing subagents get a git worktree by default so parallel edits
 *  can't collide. Falls back to the parent cwd outside a git repo. */
async function worktreeFor(parentCwd: string, sessionTag: string): Promise<string | null> {
  try {
    await execFileP('git', ['-C', parentCwd, 'rev-parse', '--git-dir'])
    const dir = join(homedir(), '.temp-code', 'worktrees', sessionTag)
    mkdirSync(join(homedir(), '.temp-code', 'worktrees'), { recursive: true })
    await execFileP('git', ['-C', parentCwd, 'worktree', 'add', dir, '-b', `tc/${sessionTag}`])
    return dir
  } catch {
    return null
  }
}

const lastAssistantText = (rows: EventRow[]): string =>
  rows
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta && !('parentCallId' in r.event && r.event.parentCallId))
    .map((r) => (r.event as { text: string }).text)
    .join('\n')

/** Wait until the child finishes its current turn (idle/error/waiting). */
function waitForSettled(reg: SessionRegistry, sessionId: string, timeoutMs: number): Promise<SessionMeta | null> {
  return new Promise((resolve) => {
    const check = (): SessionMeta | null => {
      const meta = reg.list().find((s) => s.id === sessionId) ?? null
      return meta && meta.status !== 'running' ? meta : null
    }
    const now = check()
    if (now) return resolve(now)
    const timer = setTimeout(() => {
      off()
      resolve(null)
    }, timeoutMs)
    const off = reg.subscribe(sessionId, (row) => {
      if (row.event.type === 'status' && row.event.status !== 'running') {
        clearTimeout(timer)
        off()
        resolve(check())
      }
    })
  })
}

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: t }]
})

export function orchestratorMcp(parent: SessionMeta): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'orchestrator',
    version: '0.1.0',
    tools: [
      tool(
        'spawn_agent',
        'Spawn a subagent session and send it its task. Returns the agent id. The agent works asynchronously — use wait_for_agent to collect its result.',
        {
          provider: z.enum(providerIds).describe('Which harness runs the agent'),
          model: z.string().optional().describe(`Model id. Defaults per provider: ${providerIds.map((p) => `${p}=${CATALOG[p].defaultModel}`).join(', ')}`),
          reasoning: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
          agentType: z.enum(AGENT_TYPES).default('implementer'),
          task: z.string().describe('The complete, self-contained task prompt'),
          useWorktree: z
            .boolean()
            .default(true)
            .describe('Isolate a writing agent in its own git worktree (default true; ignored outside a git repo)')
        },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          const writer = args.agentType === 'implementer'
          const cwd = (writer && args.useWorktree ? await worktreeFor(parent.cwd, `${parent.id}-${Date.now() % 100000}`) : null) ?? parent.cwd
          // Children follow the master orchestrator's permission policy —
          // the user granted it once, and the fleet works under that grant.
          // Read it fresh: the user may have changed it since spawn time.
          const parentNow = registry.list().find((s) => s.id === parent.id) ?? parent
          const child = await registry.create({
            projectId: parent.projectId,
            provider: args.provider,
            model: args.model ?? CATALOG[args.provider].defaultModel,
            reasoning: args.reasoning,
            agentType: args.agentType,
            permission: parentNow.permission,
            cwd,
            // The task IS the identity — boards, tabs and the sidebar all
            // lead with it. Provider/type stay visible as metadata.
            title: args.task.trim().split('\n')[0].slice(0, 80) || `${args.provider} · ${args.agentType}`,
            parentId: parent.id
          })
          await registry.send(child.id, args.task)
          return text(JSON.stringify({ agentId: child.id, cwd, note: 'working — use wait_for_agent to collect the result' }))
        }
      ),
      tool(
        'send_to_agent',
        'Send a follow-up message to a subagent you spawned.',
        { agentId: z.string(), message: z.string() },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          await registry.send(args.agentId, args.message)
          return text('sent')
        }
      ),
      tool(
        'wait_for_agent',
        'Block until a subagent finishes its current turn, then return its latest reply and status.',
        {
          agentId: z.string(),
          timeoutSeconds: z.number().default(600).describe('Give up waiting after this long (the agent keeps running)')
        },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          const meta = await waitForSettled(registry, args.agentId, args.timeoutSeconds * 1000)
          if (!meta) return text(JSON.stringify({ status: 'timeout', note: 'agent still running' }))
          const rows = registry.eventsAfter(args.agentId, 0)
          return text(
            JSON.stringify({
              status: meta.status,
              reply: lastAssistantText(rows).slice(-8000) || '(no reply yet)'
            })
          )
        }
      ),
      tool(
        'list_agents',
        'List the subagents of this session with their status.',
        {},
        async () => {
          if (!registry) return text('orchestration registry not ready')
          const children = registry
            .list()
            .filter((s) => s.parentId === parent.id)
            .map((s) => ({ agentId: s.id, provider: s.provider, model: s.model, agentType: s.agentType, status: s.status, cwd: s.cwd }))
          return text(JSON.stringify(children))
        }
      )
    ]
  })
}

export const ORCHESTRATOR_TOOLS = [
  'mcp__orchestrator__spawn_agent',
  'mcp__orchestrator__send_to_agent',
  'mcp__orchestrator__wait_for_agent',
  'mcp__orchestrator__list_agents'
]

/** Router rubric appended to the orchestrator's system prompt. */
export const ORCHESTRATOR_PROMPT = `
You can orchestrate subagents across providers with the orchestrator tools
(spawn_agent, send_to_agent, wait_for_agent, list_agents). Routing rubric:
- codex (gpt-5.x): bulk or mechanical work with a clear spec — migrations,
  data analysis, wide refactors. Cheap; use freely and in parallel.
- claude: anything user-facing (UI, copy, API design) and anything that
  needs judgment with limited supervision.
- cursor: quick scoped edits.
Reviews of plans or implementations: prefer a claude reviewer, optionally
adding a codex reviewer as an independent second opinion.
Give each agent a complete, self-contained task prompt — it cannot see this
conversation. Implementer agents get an isolated git worktree by default;
tell the user which worktree branches hold finished work. Parallelize
independent tasks; wait_for_agent collects results.`.trim()
