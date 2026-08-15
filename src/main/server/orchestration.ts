import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance
} from '@anthropic-ai/claude-agent-sdk'
import { AGENT_TYPES, CATALOG, type ProviderId } from '@shared/catalog'
import { DEFAULT_RULES, ruleModel, type OrchestrationRules } from '@shared/rules'
import type { EventRow, SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'

const execFileP = promisify(execFile)

/**
 * Orchestration (docs/PLAN.md M6, supervision in docs/PLAN-2.md M7). The
 * orchestrator is not special: any claude session whose agentType is
 * 'orchestrator' gets this MCP toolset plus a router rubric appended to the
 * system prompt. Children are ordinary sessions with parentId set — the
 * sidebar tree and agent-spawned events already exist, so subagents are
 * visible for free. Supervision tools are pure reads of the event log, so
 * they work identically for claude, codex and cursor children.
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

// ── event-log readers (shared with the transcript mirrors, M8) ─────────

/** Rows of the latest turn: everything after the last user-text row. */
export function latestTurnRows(rows: EventRow[]): EventRow[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].event.type === 'user-text') return rows.slice(i + 1)
  }
  return rows
}

/** Final assistant text of the given rows (deltas and subagent lanes excluded). */
export const turnText = (rows: EventRow[]): string =>
  rows
    .filter(
      (r) =>
        r.event.type === 'assistant-text' &&
        !r.event.delta &&
        !('parentCallId' in r.event && r.event.parentCallId)
    )
    .map((r) => (r.event as { text: string }).text)
    .join('\n')

/** One-line human summary of a tool call: "Edit src/foo.ts", "Bash: npm test". */
export function toolLine(name: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pathKey = ['file_path', 'path', 'notebook_path'].find((k) => typeof obj[k] === 'string')
  if (pathKey) return `${name} ${obj[pathKey]}`
  const valKey = ['command', 'pattern', 'query', 'url', 'description', 'prompt', 'task'].find(
    (k) => typeof obj[k] === 'string'
  )
  if (valKey) return `${name}: ${String(obj[valKey]).replace(/\s+/g, ' ').slice(0, 100)}`
  return name
}

/** Tool activity in the given rows, one line per call, failures marked.
 *  Later events with the same callId replace earlier ones (early-start
 *  previews carry no input yet). */
export function toolLinesOf(rows: EventRow[], limit = 10): string[] {
  const failed = new Set<string>()
  for (const { event } of rows) {
    if (event.type === 'tool-result' && event.isError) failed.add(event.callId)
  }
  const calls = new Map<string, string>()
  for (const { event } of rows) {
    if (event.type === 'tool-call') calls.set(event.callId, toolLine(event.name, event.input))
  }
  return [...calls.entries()]
    .map(([id, line]) => (failed.has(id) ? `${line} (failed)` : line))
    .slice(-limit)
}

type Pending =
  | { kind: 'question'; requestId: string; questions: unknown }
  | { kind: 'approval'; requestId: string; toolName: string; title?: string; note: string }

/** The unresolved question/approval a waiting child is stuck on, if any. */
export function pendingOf(rows: EventRow[]): Pending | null {
  const resolved = new Set<string>()
  for (const { event } of rows) {
    if (event.type === 'question-resolved' || event.type === 'approval-resolved') {
      resolved.add(event.requestId)
    }
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i].event
    if (e.type === 'question-request' && !resolved.has(e.requestId)) {
      return { kind: 'question', requestId: e.requestId, questions: e.questions }
    }
    if (e.type === 'approval-request' && !resolved.has(e.requestId)) {
      return {
        kind: 'approval',
        requestId: e.requestId,
        toolName: e.toolName,
        title: e.title,
        note: 'permission approvals are answered by the user, never by you — tell the user this agent is waiting on approval and keep working on other agents'
      }
    }
  }
  return null
}

/** Session accounting from turn-complete events. claude and codex report
 *  cumulative session totals (take the latest); cursor reports per turn
 *  (sum). */
function tokensOf(
  rows: EventRow[],
  provider: ProviderId
): { input: number; output: number; costUsd: number } {
  let input = 0
  let output = 0
  let costUsd = 0
  for (const { event } of rows) {
    if (event.type !== 'turn-complete') continue
    if (provider === 'cursor') {
      input += event.inputTokens ?? 0
      output += event.outputTokens ?? 0
      costUsd += event.costUsd ?? 0
    } else {
      input = event.inputTokens ?? input
      output = event.outputTokens ?? output
      costUsd = event.costUsd ?? costUsd
    }
  }
  return { input, output, costUsd: Math.round(costUsd * 10000) / 10000 }
}

/** Wait until the child finishes its current turn (idle/error/waiting). */
function waitForSettled(
  reg: SessionRegistry,
  sessionId: string,
  timeoutMs: number
): Promise<SessionMeta | null> {
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

/** First of several children to settle, with its id; null on timeout. */
function waitForAnySettled(
  reg: SessionRegistry,
  ids: string[],
  timeoutMs: number
): Promise<{ id: string; meta: SessionMeta } | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: { id: string; meta: SessionMeta } | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    for (const id of ids) {
      void waitForSettled(reg, id, timeoutMs).then((meta) => {
        if (meta) finish({ id, meta })
      })
    }
  })
}

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: t }]
})

export function orchestratorMcp(parent: SessionMeta): McpSdkServerConfigWithInstance {
  /** Every agentId-taking tool works only on this session's own children. */
  const childOf = (agentId: string): SessionMeta | null =>
    registry?.list().find((s) => s.id === agentId && s.parentId === parent.id) ?? null
  const notChild = (agentId: string): { content: [{ type: 'text'; text: string }] } =>
    text(
      `refused: ${agentId} is not a subagent of this session. list_agents shows your agents and their ids.`
    )
  const idleSeconds = (id: string): number =>
    Math.max(0, Math.round((Date.now() - (registry?.lastActivityAt(id) ?? Date.now())) / 1000))
  /** The settled-agent report wait_for_agent returns. */
  const settledReport = (id: string, meta: SessionMeta): Record<string, unknown> => {
    const turn = latestTurnRows(registry!.eventsAfter(id, 0))
    const pending = meta.status === 'waiting' ? pendingOf(turn) : null
    return {
      agentId: id,
      status: meta.status,
      reply: turnText(turn).slice(-8000) || '(no reply yet)',
      ...(pending ? { pending } : {})
    }
  }

  return createSdkMcpServer({
    name: 'orchestrator',
    version: '0.1.0',
    tools: [
      tool(
        'spawn_agent',
        'Spawn a subagent session and send it its task. Returns the agent id. The agent works asynchronously — use wait_for_agent to collect its result.',
        {
          provider: z.enum(providerIds).describe('Which harness runs the agent'),
          model: z
            .string()
            .optional()
            .describe(
              `Model id. Defaults per provider: ${providerIds.map((p) => `${p}=${CATALOG[p].defaultModel}`).join(', ')}`
            ),
          reasoning: z
            .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
            .default('medium')
            .describe('Must be one of the efforts the chosen model supports (see system prompt)'),
          agentType: z.enum(AGENT_TYPES).default('implementer'),
          task: z.string().describe('The complete, self-contained task prompt'),
          useWorktree: z
            .boolean()
            .default(true)
            .describe(
              'Isolate a writing agent in its own git worktree (default true; ignored outside a git repo)'
            )
        },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          // Enforce the user's conduct rules — these are settings, not
          // suggestions. The refusal text tells the model how to proceed.
          const rules = rulesFor(parent)
          const children = registry.list().filter((s) => s.parentId === parent.id)
          const live = children.filter(
            (s) => s.status === 'running' || s.status === 'starting' || s.status === 'waiting'
          )
          if (rules.conduct.maxAgents > 0 && children.length >= rules.conduct.maxAgents) {
            return text(
              `refused: the user capped this thread at ${rules.conduct.maxAgents} subagents total (${children.length} already spawned). Reuse an existing agent via send_to_agent, or tell the user the cap is reached.`
            )
          }
          if (rules.conduct.maxParallel > 0 && live.length >= rules.conduct.maxParallel) {
            return text(
              `refused: the user capped parallelism at ${rules.conduct.maxParallel} concurrent subagents (${live.length} active). wait_for_agent on one of them first, then retry.`
            )
          }
          const writer = args.agentType === 'implementer'
          const cwd =
            (writer && args.useWorktree && rules.conduct.useWorktrees
              ? await worktreeFor(parent.cwd, `${parent.id}-${Date.now() % 100000}`)
              : null) ?? parent.cwd
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
            title:
              args.task.trim().split('\n')[0].slice(0, 80) ||
              `${args.provider} · ${args.agentType}`,
            parentId: parent.id
          })
          await registry.send(child.id, args.task)
          return text(
            JSON.stringify({
              agentId: child.id,
              title: child.title,
              cwd,
              note: 'working — use wait_for_agent to collect the result'
            })
          )
        }
      ),
      tool(
        'send_to_agent',
        'Send a follow-up message to a subagent you spawned.',
        { agentId: z.string(), message: z.string() },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          if (!childOf(args.agentId)) return notChild(args.agentId)
          await registry.send(args.agentId, args.message)
          return text('sent')
        }
      ),
      tool(
        'check_agent',
        'Non-blocking look at what a subagent is doing right now: status, recent tool activity, latest streamed text, anything it is stuck on, token usage. Use it to supervise long-running agents without waiting.',
        { agentId: z.string() },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          const meta = childOf(args.agentId)
          if (!meta) return notChild(args.agentId)
          const rows = registry.eventsAfter(args.agentId, 0)
          const turn = latestTurnRows(rows)
          // Mid-turn, streamed deltas are all there is — fold them per block
          // so lastText shows what the agent is saying right now.
          const finals = turnText(turn)
          const deltas = turn
            .filter(
              (r) =>
                r.event.type === 'assistant-text' &&
                r.event.delta &&
                !('parentCallId' in r.event && r.event.parentCallId)
            )
            .map((r) => (r.event as { text: string }).text)
            .join('')
          return text(
            JSON.stringify({
              agentId: args.agentId,
              title: meta.title,
              status: meta.status,
              idleForSeconds: idleSeconds(args.agentId),
              currentTurn: {
                toolCalls: toolLinesOf(turn),
                lastText: (finals || deltas).slice(-2000)
              },
              pending: pendingOf(turn),
              tokens: tokensOf(rows, meta.provider)
            })
          )
        }
      ),
      tool(
        'wait_for_agent',
        'Block until a subagent (or the first of several) finishes its current turn, then return its latest reply and status. Timeouts are normal for long tasks — check_agent, then wait again.',
        {
          agentId: z.string().optional().describe('One agent to wait for'),
          agentIds: z
            .array(z.string())
            .optional()
            .describe('Several agents — with mode "any", results arrive in completion order'),
          mode: z
            .enum(['any', 'all'])
            .default('any')
            .describe('any: return the first to settle; all: wait for every one'),
          timeoutSeconds: z
            .number()
            .default(600)
            .describe('Give up waiting after this long (the agents keep running)')
        },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          const ids = [...(args.agentIds ?? []), ...(args.agentId ? [args.agentId] : [])]
          if (ids.length === 0) return text('refused: pass agentId or agentIds')
          for (const id of ids) if (!childOf(id)) return notChild(id)
          const timeoutMs = args.timeoutSeconds * 1000
          if (args.mode === 'all' && ids.length > 1) {
            const metas = await Promise.all(
              ids.map((id) => waitForSettled(registry!, id, timeoutMs))
            )
            return text(
              JSON.stringify(
                ids.map((id, i) => {
                  const meta = metas[i]
                  return meta
                    ? settledReport(id, meta)
                    : { agentId: id, status: 'timeout', note: 'still running' }
                })
              )
            )
          }
          const settled = await waitForAnySettled(registry, ids, timeoutMs)
          if (!settled) {
            return text(
              JSON.stringify({
                status: 'timeout',
                note: 'still running — check_agent shows progress'
              })
            )
          }
          return text(JSON.stringify(settledReport(settled.id, settled.meta)))
        }
      ),
      tool(
        'answer_agent',
        'Answer a subagent\'s pending structured question (the "pending" payload from wait_for_agent/check_agent). answers[i] = chosen option labels (or freeform text) for questions[i]. Permission approvals cannot be answered this way — those belong to the user.',
        {
          agentId: z.string(),
          requestId: z.string().describe('pending.requestId from wait_for_agent/check_agent'),
          answers: z.array(z.array(z.string()))
        },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          if (!childOf(args.agentId)) return notChild(args.agentId)
          const pending = pendingOf(registry.eventsAfter(args.agentId, 0))
          if (!pending || pending.requestId !== args.requestId) {
            return text(
              `refused: ${args.requestId} is not this agent's pending request${pending ? ` (current: ${pending.requestId})` : ' (nothing pending)'}.`
            )
          }
          if (pending.kind === 'approval') {
            return text(
              'refused: this agent is waiting on a permission approval, which only the user can grant. Tell the user and keep working on other agents.'
            )
          }
          await registry.answer(args.agentId, args.requestId, args.answers)
          return text('answered — the agent resumes; wait_for_agent to collect its result')
        }
      ),
      tool(
        'interrupt_agent',
        "Stop a subagent's current turn (it stays alive and can be redirected with send_to_agent). For runaway or off-track agents.",
        { agentId: z.string() },
        async (args) => {
          if (!registry) return text('orchestration registry not ready')
          if (!childOf(args.agentId)) return notChild(args.agentId)
          await registry.interrupt(args.agentId)
          return text('interrupted — send_to_agent to redirect, or spawn a replacement')
        }
      ),
      tool('list_agents', 'List the subagents of this session with their status.', {}, async () => {
        if (!registry) return text('orchestration registry not ready')
        const children = registry
          .list()
          .filter((s) => s.parentId === parent.id)
          .map((s) => ({
            agentId: s.id,
            title: s.title,
            provider: s.provider,
            model: s.model,
            agentType: s.agentType,
            status: s.status,
            idleForSeconds: idleSeconds(s.id),
            cwd: s.cwd
          }))
        return text(JSON.stringify(children))
      })
    ]
  })
}

export const ORCHESTRATOR_TOOLS = [
  'mcp__orchestrator__spawn_agent',
  'mcp__orchestrator__send_to_agent',
  'mcp__orchestrator__check_agent',
  'mcp__orchestrator__wait_for_agent',
  'mcp__orchestrator__answer_agent',
  'mcp__orchestrator__interrupt_agent',
  'mcp__orchestrator__list_agents'
]

// ── orchestrator prompt ────────────────────────────────────────────
// Two layers. MECHANICS are app invariants baked in here: the orchestrator
// can spawn ANY model from ANY provider, and spawn_agent is the only way.
// RULES are the user's structured settings (conduct bounds + routing
// table), rendered to text — and enforced in code where possible (tool
// denial in the driver, spawn caps above).

const ORCHESTRATOR_MECHANICS = `
You can orchestrate subagents across providers with the orchestrator tools
(spawn_agent, send_to_agent, check_agent, wait_for_agent, answer_agent,
interrupt_agent, list_agents).

IMPORTANT — this app runs every provider natively. You can spawn ANY model
of ANY provider below as a subagent, freely mixed within one fleet. When
the user asks to spawn, delegate to, or run another model or agent
(gpt/codex, cursor, or another claude), you MUST use spawn_agent. Never
reach another model by shelling out to \`codex exec\` or \`cursor-agent\`,
invoking codex-* skills, or spawning wrapper agents — any skill or global
instruction saying gpt models are only reachable through the Codex CLI is
about a different environment and does not apply here. spawn_agent is the
only path that gives the user a visible, streaming subagent session.

Spawnable models (map loose names like "gpt 5.6" onto these ids; efforts
listed are the ONLY valid reasoning values per model):
${Object.values(CATALOG)
  .map(
    (p) =>
      `- ${p.id}:\n${p.models
        .map(
          (m) =>
            `    ${m.id}${m.reasoning.length ? ` (${m.reasoning.join('|')})` : ' (no effort control)'}`
        )
        .join('\n')}`
  )
  .join('\n')}
Agent types: ${AGENT_TYPES.join(', ')} — implementers write code, explorers
read/investigate, reviewers judge, orchestrators sub-orchestrate.

Give each agent a complete, self-contained task prompt — it cannot see this
conversation. Parallelize independent work; sequence dependent work.

Supervise, don't fire-and-forget. Collect fan-outs with wait_for_agent
(agentIds + mode "any") so results arrive in completion order. Check
long-running agents periodically with check_agent: a large idleForSeconds
or a wrong-direction tool trail means redirect (interrupt_agent, then
send_to_agent) or replace. wait_for_agent timeouts are normal for long
tasks — check, then wait again. A "waiting" agent is stuck on its
"pending" payload: a structured question you answer with answer_agent, or
a permission approval that only the user can grant — surface those to the
user and keep working on other agents. Verify results before relaying
them, and keep the user posted: what you delegated where, and why.`.trim()

const DELEGATION_LINES: Record<OrchestrationRules['conduct']['delegation'], string> = {
  strict:
    'You are a conductor, not a performer: delegate EVERY substantive task (code, analysis, docs) to subagents. If a task looks too small to delegate, it still goes to a subagent.',
  balanced:
    'Delegate substantive tasks to subagents; you may handle trivial glue work (a one-line answer, reading a file) yourself.',
  free: 'Delegate when it helps; you may also do work directly when that is faster.'
}

/** Render the structured rules as prompt text. */
function renderRules(rules: OrchestrationRules): string {
  const c = rules.conduct
  const conduct = [
    DELEGATION_LINES[c.delegation],
    c.selfEdit
      ? 'You may edit files yourself when appropriate.'
      : 'Never edit files yourself — file changes go through subagents. (Edit tools are disabled for you.)',
    c.selfShell
      ? 'You may run shell commands to gather context and verify results.'
      : 'Do not run shell commands yourself. (Shell is disabled for you.)',
    c.verifyResults &&
      'Verify what subagents report (read the diff, run a check via an agent) before relaying it as done.',
    c.escalate &&
      "Standing permission to escalate: when a cheaper model's output misses the bar, rerun the task on a smarter model without asking. Judge the output, not the price — escalating costs less than shipping mediocre work.",
    c.useWorktrees
      ? 'Writing subagents are isolated in git worktrees — tell the user which branches hold finished work.'
      : 'Subagents work in the shared checkout — never run writers in parallel on the same files.',
    c.maxParallel > 0 && `At most ${c.maxParallel} subagents run at once (enforced).`,
    c.maxAgents > 0 && `At most ${c.maxAgents} subagents total in this thread (enforced).`
  ]
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n')

  const active = rules.routing.filter((r) => r.enabled)
  const routing = active.length
    ? `Routing table — for each task, use the FIRST matching row's exact
provider/model/effort (deviate only when the user explicitly names a
model, and say so):
${active.map((r, i) => `${i + 1}. ${r.task} → ${r.provider} · ${ruleModel(r)} · ${r.reasoning}`).join('\n')}
No row matches → claude · ${CATALOG.claude.defaultModel} · medium.`
    : `No routing table configured — pick provider/model/effort by judgment:
cheap models for mechanical work, capable models for judgment and
user-facing work, low effort for trivial tasks.`

  return `## Conduct (user-defined, binding)\n\n${conduct}\n\n## Routing (user-defined, binding)\n\n${routing}`
}

/** Prompt appended to an orchestrator's system prompt: fixed mechanics
 *  plus the user's structured rules (workspace override or global). */
export function orchestratorPrompt(session: SessionMeta): string {
  const rules = rulesFor(session)
  return `${ORCHESTRATOR_MECHANICS}\n\n${renderRules(rules)}`
}

/** The rules governing a session: its workspace's override, else global. */
export function rulesFor(session: SessionMeta): OrchestrationRules {
  const workspaceId = session.projectId
    ? (registry?.getProject(session.projectId)?.workspaceId ?? null)
    : null
  return (
    (workspaceId ? registry?.getOrchestrationRules(workspaceId) : null) ??
    registry?.getOrchestrationRules(null) ??
    DEFAULT_RULES
  )
}
