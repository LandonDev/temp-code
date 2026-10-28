import { execFileBudgeted as execFileP } from './spawnBudget'
import { NOTES_MECHANICS } from './notesPrompts'
import { nanoid } from 'nanoid'
import { anglePathFor, SHOWING_VISUALS } from './threads'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance
} from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_TYPES,
  CATALOG,
  modelInfo,
  supportsContext1m,
  visibleCatalog,
  type ProviderId
} from '@shared/catalog'
import {
  DEFAULT_RULES,
  approvedLadder,
  fitReasoning,
  mergeThreadRules,
  modelApproved,
  modelKey,
  policyRoleOf,
  type PolicyRole,
  ruleModel,
  type OrchestrationRules
} from '@shared/rules'
import type { EventRow, SessionMeta } from '@shared/events'
import { watchPhrase } from '@shared/watch'
import type { SessionRegistry } from './sessions'
import type { CrossHostAgents } from './crossHostAgents'
import { foldTodo, newTodoFold, tallyOf } from './todos'


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
// Threads on other hosts (crossHostAgents.ts): a spawn that names a host,
// and every supervision call whose agent id encodes one, route there.
let crossHost: CrossHostAgents | null = null
export function setCrossHostAgents(c: CrossHostAgents | null): void {
  crossHost = c
}

const providerIds = Object.keys(CATALOG) as [ProviderId, ...ProviderId[]]

/** Writing subagents get a git worktree by default so parallel edits
 *  can't collide. Falls back to the parent cwd outside a git repo. */
export async function worktreeFor(parentCwd: string, sessionTag: string): Promise<string | null> {
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

/** The input keys a tool line names: a path first, else a value. */
export const TOOL_PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const
export const TOOL_VALUE_KEYS = ['command', 'pattern', 'query', 'url', 'description', 'prompt', 'task'] as const

/** One-line human summary of a tool call: "Edit src/foo.ts", "Bash: npm test". */
export function toolLine(name: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pathKey = TOOL_PATH_KEYS.find((k) => typeof obj[k] === 'string')
  if (pathKey) return `${name} ${obj[pathKey]}`
  const valKey = TOOL_VALUE_KEYS.find((k) => typeof obj[k] === 'string')
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

/** Wait until the child finishes its current turn (idle, error, waiting,
 *  stopped — or watching: its reply is complete and background work keeps
 *  it alive; the report says what it waits on). Not settled: 'queued'
 *  (held at the host's running cap, scheduler.ts) and the 'starting' it
 *  leaves through: the wait covers the turn it has not begun yet.
 *  timeoutMs <= 0 waits indefinitely — dormant, no polling. */
const unsettled = (status: SessionMeta['status']): boolean =>
  status === 'running' || status === 'queued' || status === 'starting'

/** The status an agent reads as; a queued one says why ("queued · 120 of 120 running"). */
function statusOf(s: Pick<SessionMeta, 'id' | 'status'>): string {
  if (s.status !== 'queued') return s.status
  const line = registry?.queuedLine(s.id)
  return line ? line.replace(/^Queued/, 'queued') : 'queued'
}

export function waitForSettled(
  reg: SessionRegistry,
  sessionId: string,
  timeoutMs: number
): Promise<SessionMeta | null> {
  return new Promise((resolve) => {
    const check = (): SessionMeta | null => {
      const meta = reg.get(sessionId)
      return meta && !unsettled(meta.status) ? meta : null
    }
    const now = check()
    if (now) return resolve(now)
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            off()
            resolve(null)
          }, timeoutMs)
        : null
    const off = reg.subscribe(sessionId, (row) => {
      if (row.event.type === 'status' && !unsettled(row.event.status)) {
        if (timer) clearTimeout(timer)
        off()
        resolve(check())
      }
    })
  })
}

/** First of several children to settle, with its id; null on timeout
 *  (timeoutMs <= 0 = never). */
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
      if (timer) clearTimeout(timer)
      resolve(v)
    }
    const timer = timeoutMs > 0 ? setTimeout(() => finish(null), timeoutMs) : null
    for (const id of ids) {
      void waitForSettled(reg, id, timeoutMs).then((meta) => {
        if (meta) finish({ id, meta })
      })
    }
  })
}

// ── dormant supervision ──────────────────────────────────────────────
// A parent should never have to poll: wait_for_agent with no timeout
// sleeps until a child settles, and a child settling while the parent is
// NOT waiting wakes the parent through its message queue (immediately
// when idle, after its current work otherwise).

/** Children currently inside a wait_for_agent — their settle is already
 *  being delivered as that tool's result, so no wake message. The parent's
 *  meta names them (`awaiting`) while the wait holds. */
const awaited = new Map<string, number>()
const holdAwaited = (ids: string[], parentId: string): (() => void) => {
  for (const id of ids) awaited.set(id, (awaited.get(id) ?? 0) + 1)
  registry?.setAwaiting(parentId, ids, true)
  return () => {
    for (const id of ids) {
      const n = (awaited.get(id) ?? 1) - 1
      if (n <= 0) awaited.delete(id)
      else awaited.set(id, n)
    }
    registry?.setAwaiting(parentId, ids, false)
  }
}

/** Children whose settle is reported some other way (a merge review's
 *  reviewer answers through merge_branch, mergeReview.ts): no wake report. */
const settleSuppressors: ((child: SessionMeta) => boolean)[] = []
export function suppressSettleReports(fn: (child: SessionMeta) => boolean): void {
  settleSuppressors.push(fn)
}
export const settleSuppressed = (child: SessionMeta): boolean => settleSuppressors.some((f) => f(child))

/** The questions a waiting child asked, one per line with its options. */
export function questionLines(questions: unknown): string {
  if (!Array.isArray(questions)) return ''
  return questions
    .map((q) => {
      const row = q as { question?: string; options?: { label: string }[] }
      if (!row.question) return null
      const options = row.options?.map((o) => o.label).filter(Boolean) ?? []
      return `Q: ${row.question}${options.length ? ` (options: ${options.join(' | ')})` : ''}`
    })
    .filter(Boolean)
    .join('\n')
}

/** Who hears a session settle first: its parent, else (a root thread of
 *  a batch) its master. Never itself. */
export const settleTarget = (child: Pick<SessionMeta, 'id' | 'parentId' | 'masterId'>): string | null => {
  const target = child.parentId ?? child.masterId ?? null
  return target && target !== child.id ? target : null
}

/** Everyone who hears a session settle, once each: the parent or the
 *  master (settleTarget), and the thread that started it through
 *  app_start_thread (`startedBy`) when that is someone else. A plan's
 *  build started by the plan itself reports to the plan and to the
 *  master; one started by the master reports to the master once. */
export function settleTargets(child: Pick<SessionMeta, 'id' | 'parentId' | 'masterId' | 'startedBy'>): string[] {
  const out: string[] = []
  for (const id of [settleTarget(child), child.startedBy ?? null]) {
    if (id && id !== child.id && !out.includes(id)) out.push(id)
  }
  return out
}

/** The batch a thread started from `starter` belongs to (CLAUDE.md
 *  "Master threads"): a master's thread carries the master's id; a thread
 *  started by a root that is itself in a batch (a plan starting its build)
 *  inherits that batch; anything else carries none. The starter stays
 *  `startedBy`, so it hears the settles too (settleTargets). */
export function batchMembershipOf(starter: Pick<SessionMeta, 'id' | 'parentId' | 'isMaster' | 'masterId'> | null | undefined): { masterId: string } | {} {
  if (!starter) return {}
  if (isMasterSession(starter, null)) return { masterId: starter.id }
  if (starter.masterId && !starter.parentId) return { masterId: starter.masterId }
  return {}
}

/** Called by the registry when a child transitions out of running. Queues
 *  an automatic report to the parent (or the master, for a batch thread),
 *  and to the thread that started it, unless a wait already covers it. */
export function notifyParentOfSettle(reg: SessionRegistry, child: SessionMeta): void {
  const targets = settleTargets(child)
  if (targets.length === 0 || awaited.has(child.id) || settleSuppressed(child)) return
  const turn = latestTurnRows(reg.eventsAfter(child.id, 0))
  const pending = child.status === 'waiting' ? pendingOf(turn) : null
  const tail = turnText(turn).slice(-600)
  const asked = pending?.kind === 'question' ? questionLines(pending.questions) : ''
  const question = asked ? `\n${asked}` : ''
  const reply = tail ? `Latest reply:\n${tail}` : '(no reply text)'
  const body =
    child.status === 'waiting'
      ? pending?.kind === 'question'
        ? `It is WAITING on a question — answer it with answer_agent (requestId ${pending.requestId}).${question}`
        : 'It is WAITING on a permission approval — only the user can grant that.'
      : child.status === 'stopped'
        ? `Its harness died; Resume it or start another.\n${reply}`
        : child.status === 'watching'
          ? `Its turn ended; it is watching ${watchPhrase(reg.get(child.id)?.background ?? child.background)}. Its reply is complete.\n${reply}`
          : reply
  for (const targetId of targets) {
    const parent = reg.get(targetId)
    if (!parent || parent.archived) continue
    // Two threads naming each other as master would wake each other forever.
    if (parent.masterId === child.id) continue
    const what = child.parentId
      ? `subagent "${child.title}" (${child.id})`
      : child.masterId === targetId
        ? `batch thread "${child.title}" (${child.id}, ${child.threadType ?? 'thread'})`
        : `thread "${child.title}" (${child.id}, ${child.threadType ?? 'thread'}) you started`
    reg.deliverAgentReport(targetId, {
      agentId: child.id,
      title: child.title,
      status: child.status,
      text: `<subagent-report>\nAutomatic notification: ${what} settled with status ${child.status}.\n${body}\nUse check_agent for detail, send_to_agent to follow up. Continue your work accordingly — do not reply to this notification itself.\n</subagent-report>`
    })
  }
}

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: t }]
})

// ── orchestration operations ─────────────────────────────────────────
// Plain functions over the registry. The in-process MCP tools (claude)
// and the app.* WS methods (which the stdio bridge exposes to codex) are
// both thin wrappers, so every provider spawns and supervises subagents
// the same way — never by shelling out to another CLI.

/** Is this session a master thread (CLAUDE.md "Master threads")? The pin
 *  lives on the thread's row (`isMaster`, `session.setMaster`); several
 *  threads of one project may be; a subagent never is. The row is read
 *  live when the registry knows the id: the harness boots eagerly at
 *  create and the tool closures hold that meta, and a thread pinned after
 *  that must still supervise its batch and get the batch tools at spawn. */
export function isMasterSession(
  session: Pick<SessionMeta, 'id' | 'parentId' | 'isMaster'>,
  reg: Pick<SessionRegistry, 'get'> | null = registry
): boolean {
  const live = reg?.get(session.id) ?? session
  return !!live.isMaster && !live.parentId
}

/** May `caller` supervise `session`? Its own subagents (parentId), and, for
 *  a master, every root thread of its batch (masterId). */
export function supervisedBy(caller: SessionMeta, session: SessionMeta): boolean {
  if (session.id === caller.id) return false
  if (session.parentId === caller.id) return true
  return !session.parentId && session.masterId === caller.id && isMasterSession(caller)
}

/** The root threads of a master's batch, oldest first. */
const batchOf = (master: SessionMeta): SessionMeta[] =>
  isMasterSession(master) ? (registry?.batchChildren(master.id) ?? []) : []

/** Every agentId-taking op works only on what the caller supervises. */
const childOf = (parent: SessionMeta, agentId: string): SessionMeta | null => {
  const meta = registry?.get(agentId) ?? null
  return meta && supervisedBy(parent, meta) ? meta : null
}
const notChild = (agentId: string): string =>
  `refused: ${agentId} is not a subagent or batch thread of this session. list_agents shows your agents and their ids.`
const idleSeconds = (id: string): number =>
  Math.max(0, Math.round((Date.now() - (registry?.lastActivityAt(id) ?? Date.now())) / 1000))
/** The settled-agent report wait_for_agent returns. A watching child says
 *  what keeps it alive; a stopped one that its harness died. */
const settledReport = (id: string, meta: SessionMeta): Record<string, unknown> => {
  const turn = latestTurnRows(registry!.eventsAfter(id, 0))
  const pending = meta.status === 'waiting' ? pendingOf(turn) : null
  return {
    agentId: id,
    status: meta.status,
    reply: turnText(turn).slice(-8000) || '(no reply yet)',
    ...(pending ? { pending } : {}),
    ...(meta.status === 'watching'
      ? { waitingOn: watchPhrase(registry!.get(id)?.background ?? meta.background), note: 'its turn ended; background work keeps it alive, its reply is complete' }
      : {}),
    ...(meta.status === 'stopped' ? { note: 'its harness died; Resume it or start another' } : {})
  }
}

/** The spawnable model table — one source for prompts, preambles and
 *  refusals. Renders only the models the user approved, each with the
 *  effort range the policy leaves open. */
export function spawnableModels(rules: OrchestrationRules, role: PolicyRole = 'thread'): string {
  // A thread caller sees the orchestrators-only rows marked, so it can
  // start them as threads or name them when it asks the user for an
  // orchestration or master thread, rather than taking a missing row for
  // a missing model.
  let marked = 0
  const blocks = Object.values(visibleCatalog())
    .map((p) => {
      const models = p.models.filter((m) => modelApproved(rules, p.id, m.id, 'orchestrator'))
      if (models.length === 0) return null
      return `- ${p.id}:\n${models
        .map((m) => {
          const ladder = approvedLadder(rules, p.id, m.id)
          const suffix = supportsContext1m(p.id, m.id) ? ' +1m' : ''
          const own = modelApproved(rules, p.id, m.id, role)
          if (!own) marked++
          const only = own ? '' : ' (orchestrators only)'
          return `    ${m.id}${ladder.length ? ` (${ladder.join('|')})` : ' (no effort control)'}${suffix}${only}`
        })
        .join('\n')}`
    })
    .filter(Boolean)
  if (blocks.length === 0) return '(none — the user has approved no subagent models)'
  const note = marked
    ? '\n  Models marked orchestrators-only cannot be spawned as subagents from here; app_start_thread may still start them as threads (a thread is the person\'s choice and follows no model policy), or ask the user for an orchestration or master thread.'
    : ''
  return `${blocks.join('\n')}\n  +1m: spawn_agent runs that model with the 1M context window unless you pass context1m: false; app_start_thread only with context1m: true.${note}`
}

/** The role a session spawns or starts threads under: an orchestration
 *  thread, an orchestrator agent, or its project's master thread. */
export function policyRole(session: SessionMeta): PolicyRole {
  return policyRoleOf(session, isMasterSession(session))
}

/** Every refusal ends with the table, so the caller can self-correct. */
export const approvedTable = (rules: OrchestrationRules, role: PolicyRole): string =>
  `Approved models:\n${spawnableModels(rules, role)}`

/** A provider's spawn default under the policy: the catalog default when
 *  approved, else its first approved model. */
export function approvedDefault(rules: OrchestrationRules, provider: ProviderId, role: PolicyRole): string | null {
  const p = visibleCatalog()[provider]
  if (modelApproved(rules, provider, p.defaultModel, role)) return p.defaultModel
  return p.models.find((m) => modelApproved(rules, provider, m.id, role))?.id ?? null
}

/** Models name providers loosely in the wild — accept the obvious spellings. */
const PROVIDER_ALIASES: Record<string, ProviderId> = {
  claude: 'claude',
  anthropic: 'claude',
  codex: 'codex',
  openai: 'codex',
  gpt: 'codex',
  cursor: 'cursor'
}

const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]/g, '')

/**
 * Forgiving spawn-target resolution: alias the provider, match the model
 * exactly anywhere in the catalog, then loosely by id/label substring
 * ("opus" → claude-opus-5) — considering only models the user approved.
 * A miss is refused with the approved table, so the caller can
 * self-correct.
 */
function resolveSpawnTarget(
  rawProvider: string | undefined,
  rawModel: string | undefined,
  fallback: ProviderId,
  rules: OrchestrationRules,
  role: PolicyRole
): { provider: ProviderId; model: string } | { error: string } {
  const table = (): string => approvedTable(rules, role)
  const provider = rawProvider ? PROVIDER_ALIASES[rawProvider.toLowerCase().trim()] : undefined
  if (!rawModel) {
    const p = provider ?? fallback
    const model = approvedDefault(rules, p, role)
    return model
      ? { provider: p, model }
      : { error: `refused: the user has approved no ${p} models for subagents. ${table()}` }
  }
  const exactIn = (Object.keys(CATALOG) as ProviderId[]).filter((p) => modelInfo(p, rawModel))
  if (exactIn.length > 0) {
    const serving =
      provider && exactIn.includes(provider) ? [provider, ...exactIn] : exactIn
    const ok = serving.find((p) => modelApproved(rules, p, rawModel, role))
    if (ok) return { provider: ok, model: rawModel }
    // A model kept for orchestrators is named as such, so a thread knows
    // the way round: a thread is the person's choice and follows no policy,
    // so app_start_thread may start the same model as a thread.
    if (serving.some((p) => rules.models[modelKey(p, rawModel)]?.approved === 'orchestrators')) {
      const who = role === 'thread' ? 'this thread (role: thread)' : 'this orchestrator'
      return {
        error: `refused: ${rawModel} is approved for orchestrators only, and ${who} may not spawn it as a subagent. Pick an approved model, or start the work as a thread with app_start_thread (threads follow no model policy), or ask the user for an orchestration or master thread. ${table()}`
      }
    }
    return {
      error: `refused: the user has not approved ${rawModel} for subagents — pick an approved model instead. ${table()}`
    }
  }
  const q = canon(rawModel)
  const order = [...(provider ? [provider] : []), ...(Object.keys(CATALOG) as ProviderId[])]
  const visible = visibleCatalog()
  for (const p of order) {
    const hit = visible[p].models.find(
      (m) =>
        modelApproved(rules, p, m.id, role) && (canon(m.id).includes(q) || canon(m.label).includes(q))
    )
    if (hit) return { provider: p, model: hit.id }
  }
  return {
    error: `refused: no provider serves an approved model matching "${rawModel}". ${table()}`
  }
}

export interface SpawnAgentSpec {
  /** Loose: aliases like "anthropic"/"openai" accepted; omitted = derived
   *  from the model, else the caller's own provider. */
  provider?: string
  model?: string
  /** Off-ladder values clamp to the model's default instead of failing. */
  reasoning?: string
  /** Unknown types coerce to 'implementer' instead of failing. */
  agentType?: string
  task?: string
  useWorktree?: boolean
  /** Defaults to on for models with a 1M window; asking for it on any
   *  other model is refused. */
  context1m?: boolean
  /** Run on another host (crossHostAgents.ts): `mac`, or an environment id. Top-level only: one host per call. */
  environmentId?: string
  /** `false`: the child starts without the project preamble its parent carried (projectPreamble.ts). */
  preamble?: boolean
}

/** One call spawns one agent (`task`) or a batch (`agents`, up to
 *  SPAWN_BATCH_MAX). In a batch the top-level fields are defaults each
 *  entry may override. */
export interface SpawnAgentArgs extends SpawnAgentSpec {
  agents?: SpawnAgentSpec[]
}

/** Agents one spawn_agent call may start. Sixteen keeps a fan-out to one
 *  tool call while the per-call validation and worktree adds stay short. */
export const SPAWN_BATCH_MAX = 16

/** The findings-file contract appended to every research explorer's task:
 *  the file is the deliverable, written as the research goes, cited by
 *  evidence, and read by the root — never the reply. */
export function findingsContract(anglePath: string): string {
  return `<findings-file>
Your findings file is ${anglePath}. The app assigned it; it is your deliverable, and the thread that spawned you reads the FILE, not your reply.
- Create it FIRST (create parent directories) with frontmatter — title, status: in-progress, summary (one line), sources: 0 — then update it as you go, so a stopped run still leaves what it found.
- Every finding carries its evidence: the URL or file path, an excerpt or quote, and the date where the page gives one. Named examples, figures and quotes, not characterizations.
- After reading a page that supports a finding, call cite_source with the URL and the one-line claim it supports — that is how the research board shows evidence.
- Keep a Limits section: what you could not verify, where sources disagree, what you did not reach.
- Finish by setting status: complete and sources: N (distinct sources cited). Your final reply is a short summary plus the file path; the detail lives in the file.
</findings-file>`
}

/** A batch entry after validation: everything create() needs, nothing
 *  created yet, so a bad entry anywhere refuses the whole call. */
export interface ResolvedSpawn {
  provider: ProviderId
  model: string
  reasoning: SessionMeta['reasoning']
  context1m: boolean
  agentType: (typeof AGENT_TYPES)[number]
  task: string
  useWorktree: boolean
  /** false = the spawner opted out of the project preamble */
  preamble: boolean
}

/**
 * Every entry of a spawn validated against the caller's rules, nothing
 * created: a bad model in the seventh slot must not leave six agents
 * running under a refusal. Shared by the local spawn and a spawn on another
 * host (crossHostAgents.ts), so the box's rules gate both the same way.
 */
export function resolveSpawnSpecs(
  parent: SessionMeta,
  args: SpawnAgentArgs,
  opts: { extraChildren?: number; extraLive?: number } = {}
): { resolved: ResolvedSpawn[]; rules: OrchestrationRules; live: number; researchRoot: SessionMeta | null } | string {
  if (!registry) return 'orchestration registry not ready'
  // The MCP closure holds a boot-time snapshot of the caller; read it
  // fresh so a permission change or tune edit made after boot governs
  // this spawn, not the rules the harness happened to start under.
  const parentNow = registry.get(parent.id) ?? parent
  // Enforce the user's rules — these are settings, not suggestions. The
  // refusal text tells the model how to proceed. Model policy gates the
  // target and clamps effort into the approved range.
  const rules = rulesFor(parentNow)
  // An orchestration thread, an orchestrator agent or a project's master
  // may spawn the models approved for orchestrators only; any other thread
  // sees them refused.
  const role = policyRole(parentNow)
  const { agents: batch, ...defaults } = args
  const specs: SpawnAgentSpec[] = batch?.length ? batch.map((a) => ({ ...defaults, ...a })) : [defaults]
  if (specs.length > SPAWN_BATCH_MAX) {
    return `refused: one spawn_agent call starts at most ${SPAWN_BATCH_MAX} agents (${specs.length} given). Split the batch across calls.`
  }
  // A research tree's children investigate; they never edit the repo, so
  // an untyped spawn is an explorer and nobody gets a worktree.
  const researchRoot = registry.researchRootOf(parent.id)
  const resolved: ResolvedSpawn[] = []
  const where = (i: number) => (specs.length > 1 ? `agents[${i}]: ` : '')
  for (const [i, spec] of specs.entries()) {
    const task = spec.task?.trim() ?? ''
    if (!task) {
      return `refused: ${where(i)}task is empty. Pass \`task\` for one agent, or \`agents\` (each with its own task) for a batch of up to ${SPAWN_BATCH_MAX}.`
    }
    const target = resolveSpawnTarget(spec.provider, spec.model, parent.provider, rules, role)
    if ('error' in target) return target.error.replace(/^refused: /, `refused: ${where(i)}`)
    if (spec.context1m && !supportsContext1m(target.provider, target.model)) {
      return `refused: ${where(i)}${target.model} does not offer the 1M context window — only Claude models do. Spawn it without context1m, or pick a model marked +1m. ${approvedTable(rules, role)}`
    }
    resolved.push({
      provider: target.provider,
      model: target.model,
      reasoning: fitReasoning(
        rules,
        target.provider,
        target.model,
        spec.reasoning
      ) as SessionMeta['reasoning'],
      context1m: spec.context1m ?? supportsContext1m(target.provider, target.model),
      agentType: (AGENT_TYPES as readonly string[]).includes(spec.agentType ?? '')
        ? (spec.agentType as (typeof AGENT_TYPES)[number])
        : researchRoot
          ? 'explorer'
          : 'implementer',
      task,
      useWorktree: (spec.useWorktree ?? true) && rules.conduct.useWorktrees,
      preamble: spec.preamble !== false
    })
  }
  // Children on other hosts count toward the caps too (crossHostAgents.ts passes them).
  const children = registry.childrenOf(parent.id).length + (opts.extraChildren ?? 0)
  const live =
    registry
      .childrenOf(parent.id)
      .filter((s) => s.status === 'running' || s.status === 'starting' || s.status === 'waiting').length +
    (opts.extraLive ?? 0)
  const n = resolved.length
  const { maxAgents, maxParallel } = rules.conduct
  if (maxAgents > 0 && children + n > maxAgents) {
    const room = Math.max(0, maxAgents - children)
    return room > 0 && n > 1
      ? `refused: the user capped this thread at ${maxAgents} subagents total (${children} already spawned): room for ${room} more, not ${n}. Spawn at most ${room} in this batch.`
      : `refused: the user capped this thread at ${maxAgents} subagents total (${children} already spawned). Reuse an existing agent via send_to_agent, or tell the user the cap is reached.`
  }
  if (maxParallel > 0 && live + n > maxParallel) {
    const room = Math.max(0, maxParallel - live)
    return room > 0 && n > 1
      ? `refused: the user capped parallelism at ${maxParallel} concurrent subagents (${live} active): ${room} slots free, not ${n}. Spawn at most ${room} now and the rest after wait_for_agent.`
      : `refused: the user capped parallelism at ${maxParallel} concurrent subagents (${live} active). wait_for_agent on one of them first, then retry.`
  }
  return { resolved, rules, live, researchRoot }
}

export async function orchSpawnAgent(parent: SessionMeta, args: SpawnAgentArgs): Promise<string> {
  if (!registry) return 'orchestration registry not ready'
  const parentNow = registry.get(parent.id) ?? parent
  // Agents on other hosts count toward the caps like local ones.
  const remote = crossHost?.children(parent.id) ?? []
  const checked = resolveSpawnSpecs(parent, args, {
    extraChildren: remote.length,
    extraLive: remote.filter((r) => r.status === 'running' || r.status === 'starting' || r.status === 'waiting').length
  })
  if (typeof checked === 'string') return checked
  const { resolved, rules, researchRoot } = checked
  const live = { length: checked.live }
  const n = resolved.length
  const { maxParallel } = rules.conduct
  const parallel =
    maxParallel > 0 ? { parallel: `${live.length + n} of ${maxParallel} allowed slots in use` } : {}
  if (args.environmentId?.trim()) {
    if (!crossHost) return 'refused: threads on other hosts are not available here'
    if (researchRoot) return 'refused: a research tree spawns its explorers here, not on another host'
    let started: Awaited<ReturnType<CrossHostAgents['spawn']>>
    try {
      started = await crossHost.spawn(parentNow, args.environmentId, resolved)
    } catch (err) {
      return `refused: ${err instanceof Error ? err.message : String(err)}`
    }
    if (n === 1) return JSON.stringify({ ...started[0], ...parallel, note: 'working on that host — use wait_for_agent to collect the result' })
    return JSON.stringify({ agents: started, ...parallel, note: `${n} agents working on ${started[0]?.host} — wait_for_agent with agentIds and mode "any" collects them in completion order` })
  }
  const stamp = Date.now() % 100000
  const started: { agentId: string; title: string; cwd: string; findingsFile?: string; status?: string }[] = []
  for (const [i, r] of resolved.entries()) {
    const writer = r.agentType === 'implementer' && !researchRoot
    // Worktrees are added one after another: parallel `git worktree add`
    // on one repo races for index.lock, and the tag carries the slot so
    // a batch's entries never share a path.
    const cwd =
      (writer && r.useWorktree
        ? await worktreeFor(parent.cwd, n > 1 ? `${parent.id}-${stamp}-${i}` : `${parent.id}-${stamp}`)
        : null) ?? parent.cwd
    const title = r.task.split('\n')[0].slice(0, 80) || `${r.provider} · ${r.agentType}`
    // Every explorer in a research tree gets a findings file the app
    // assigns, beside the root's report: its deliverable, which survives a
    // truncated reply and a stopped run, and which the root synthesizes from.
    const childId = researchRoot ? nanoid(12) : undefined
    const anglePath = researchRoot
      ? anglePathFor(registry.reportsRootFor(researchRoot), researchRoot.id, childId!, title)
      : undefined
    // Children follow the parent's permission policy — the user granted it
    // once, and the fleet works under that grant.
    const child = await registry.create({
      ...(childId ? { id: childId } : {}),
      ...(anglePath ? { planPath: anglePath } : {}),
      projectId: parent.projectId,
      provider: r.provider,
      model: r.model,
      reasoning: r.reasoning,
      agentType: r.agentType,
      ...(r.context1m ? { context1m: true } : {}),
      permission: parentNow.permission,
      cwd,
      // The task IS the identity — boards, tabs and the sidebar all
      // lead with it. Provider/type stay visible as metadata.
      title,
      parentId: parent.id
    })
    await registry.send(child.id, anglePath ? `${r.task}\n\n${findingsContract(anglePath)}` : r.task, {
      preamble: r.preamble
    })
    const queued = registry.get(child.id)?.status === 'queued' ? statusOf({ id: child.id, status: 'queued' }) : null
    started.push({
      agentId: child.id,
      title: child.title,
      cwd,
      ...(anglePath ? { findingsFile: anglePath } : {}),
      ...(queued ? { status: queued } : {})
    })
  }
  const anyQueued = started.some((s) => s.status)
  // Live headroom rides every spawn result: the boot prompt's cap goes
  // stale when the user retunes mid-run, and a model told "at most 4"
  // self-limits — this is how it learns the current ceiling.
  if (n === 1) {
    return JSON.stringify({
      ...started[0],
      ...parallel,
      note: anyQueued
        ? 'queued at this host\'s running cap: it starts when a slot frees — wait_for_agent waits for it to run and finish'
        : 'working — use wait_for_agent to collect the result'
    })
  }
  return JSON.stringify({
    agents: started,
    ...parallel,
    note: `${n} agents ${anyQueued ? 'started (the ones marked queued start as slots free at this host\'s running cap)' : 'working'} — wait_for_agent with agentIds and mode "any" collects them in completion order`
  })
}

export async function orchSendToAgent(
  parent: SessionMeta,
  agentId: string,
  message: string
): Promise<string> {
  if (!registry) return 'orchestration registry not ready'
  if (crossHost?.isRemote(agentId)) return crossHost.send(parent, agentId, message)
  if (!childOf(parent, agentId)) return notChild(agentId)
  await registry.send(agentId, message)
  return 'sent'
}

/** Where the child stands in its current task list, folded from its log
 *  by the same reducer the tab strip reads (server/todos.ts). */
export function todoProgress(rows: EventRow[]): { done: number; total: number } | null {
  const fold = newTodoFold()
  for (const r of rows) foldTodo(fold, r.event, r.ts)
  return tallyOf(fold)
}

export async function orchCheckAgent(parent: SessionMeta, agentId: string): Promise<string> {
  if (!registry) return 'orchestration registry not ready'
  if (crossHost?.isRemote(agentId)) return crossHost.check(parent, agentId)
  const meta = childOf(parent, agentId)
  if (!meta) return notChild(agentId)
  const rows = registry.eventsAfter(agentId, 0)
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
  return JSON.stringify({
    agentId,
    title: meta.title,
    status: statusOf(meta),
    idleForSeconds: idleSeconds(agentId),
    currentTurn: {
      toolCalls: toolLinesOf(turn),
      lastText: (finals || deltas).slice(-2000)
    },
    pending: pendingOf(turn),
    tasks: todoProgress(rows),
    tokens: tokensOf(rows, meta.provider)
  })
}

export interface WaitForAgentArgs {
  agentId?: string
  agentIds?: string[]
  mode?: 'any' | 'all'
  timeoutSeconds?: number
}

export async function orchWaitForAgent(
  parent: SessionMeta,
  args: WaitForAgentArgs,
  signal?: AbortSignal
): Promise<string> {
  if (!registry) return 'orchestration registry not ready'
  const all = [...(args.agentIds ?? []), ...(args.agentId ? [args.agentId] : [])]
  if (all.length === 0) return 'refused: pass agentId or agentIds'
  const remoteIds = all.filter((id) => crossHost?.isRemote(id))
  const ids = all.filter((id) => !remoteIds.includes(id))
  for (const id of ids) if (!childOf(parent, id)) return notChild(id)
  if (signal?.aborted) return abortedReport()
  // 0 / omitted = sleep until settled — the default; a timeout is opt-in.
  const timeoutMs = (args.timeoutSeconds ?? 0) * 1000
  const release = holdAwaited(ids, parent.id)
  // Agents on other hosts wait over their links (crossHostAgents.ts); a
  // wait over both kinds races them for 'any' and gathers them for 'all'.
  const stop = { stopped: false }
  const remoteWait = (id: string) => crossHost!.wait(parent, id, timeoutMs, stop)
  // A wait never swallows the person: a message into the live turn
  // (sessions.ts steerLive, or a send into it) ends the wait with the
  // message as the reason, whatever the mode; the agents keep running.
  // Nor does it outlive the turn: the harness aborting the call (Stop, the
  // turn ending) ends it with 'aborted', and the children report through
  // the queue from then on.
  const steer = registry.nextSteer(parent.id)
  const STEERED = Symbol('steered')
  const ABORTED = Symbol('aborted')
  let onAbort: (() => void) | null = null
  const aborted = new Promise<{ [ABORTED]: true }>((resolve) => {
    if (!signal) return
    onAbort = () => resolve({ [ABORTED]: true })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const raced = <T>(p: Promise<T>): Promise<T | { [STEERED]: string } | { [ABORTED]: true }> =>
    Promise.race([p, steer.promise.then((text) => ({ [STEERED]: text })), aborted])
  const steered = (v: unknown): v is { [STEERED]: string } => !!v && typeof v === 'object' && STEERED in v
  const wasAborted = (v: unknown): v is { [ABORTED]: true } => !!v && typeof v === 'object' && ABORTED in v
  const steerReport = (text: string): string =>
    JSON.stringify({
      status: 'steered',
      message: text,
      note: 'the person sent a message into your turn; act on it, then wait_for_agent again for the agents still running'
    })
  try {
    if (args.mode === 'all' && all.length > 1) {
      const both = await raced(
        Promise.all([
          Promise.all(ids.map((id) => waitForSettled(registry!, id, timeoutMs))),
          Promise.all(remoteIds.map(remoteWait))
        ])
      )
      if (steered(both)) return steerReport(both[STEERED])
      if (wasAborted(both)) return abortedReport()
      const [metas, remotes] = both
      return JSON.stringify([
        ...ids.map((id, i) => {
          const meta = metas[i]
          return meta
            ? settledReport(id, meta)
            : { agentId: id, status: 'timeout', note: 'still running' }
        }),
        ...remotes.map((r, i) => (typeof r === 'string' ? { agentId: remoteIds[i], status: 'refused', note: r } : r))
      ])
    }
    if (remoteIds.length > 0) {
      const local = ids.length
        ? waitForAnySettled(registry, ids, timeoutMs).then((s) => (s ? settledReport(s.id, s.meta) : null))
        : null
      const first = await raced(
        Promise.race([
          ...(local ? [local] : []),
          ...remoteIds.map((id) => remoteWait(id).then((r) => (typeof r === 'string' ? { agentId: id, status: 'refused', note: r } : r)))
        ])
      )
      stop.stopped = true
      if (steered(first)) return steerReport(first[STEERED])
      if (wasAborted(first)) return abortedReport()
      if (!first) return JSON.stringify({ status: 'timeout', note: 'still running — check_agent shows progress' })
      return JSON.stringify(first)
    }
    const settled = await raced(waitForAnySettled(registry, ids, timeoutMs))
    if (steered(settled)) return steerReport(settled[STEERED])
    if (wasAborted(settled)) return abortedReport()
    if (!settled) {
      return JSON.stringify({
        status: 'timeout',
        note: 'still running — check_agent shows progress'
      })
    }
    return JSON.stringify(settledReport(settled.id, settled.meta))
  } finally {
    steer.cancel()
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    stop.stopped = true
    release()
  }
}

/** The wait's answer when the harness ended the call under it (Stop, the turn ending). */
const abortedReport = (): string =>
  JSON.stringify({ status: 'aborted', note: 'the turn ended; call wait_for_agent again to keep waiting' })

export async function orchAnswerAgent(
  parent: SessionMeta,
  args: { agentId: string; requestId: string; answers?: string[][]; allow?: boolean }
): Promise<string> {
  if (!registry) return 'orchestration registry not ready'
  if (crossHost?.isRemote(args.agentId))
    return crossHost.answer(parent, args.agentId, args.requestId, args.answers, args.allow)
  if (!childOf(parent, args.agentId)) return notChild(args.agentId)
  if (!args.answers) return 'refused: pass answers (a local agent\'s approvals belong to the user).'
  const pending = pendingOf(registry.eventsAfter(args.agentId, 0))
  if (!pending || pending.requestId !== args.requestId) {
    return `refused: ${args.requestId} is not this agent's pending request${pending ? ` (current: ${pending.requestId})` : ' (nothing pending)'}.`
  }
  if (pending.kind === 'approval') {
    return 'refused: this agent is waiting on a permission approval, which only the user can grant. Tell the user and keep working on other agents.'
  }
  await registry.answer(args.agentId, args.requestId, args.answers)
  return 'answered — the agent resumes; wait_for_agent to collect its result'
}

export async function orchInterruptAgent(parent: SessionMeta, agentId: string): Promise<string> {
  if (!registry) return 'orchestration registry not ready'
  if (crossHost?.isRemote(agentId)) return crossHost.interrupt(parent, agentId)
  if (!childOf(parent, agentId)) return notChild(agentId)
  await registry.interrupt(agentId)
  return 'interrupted — send_to_agent to redirect, or spawn a replacement'
}

export async function orchListAgents(parent: SessionMeta): Promise<string> {
  if (!registry) return 'orchestration registry not ready'
  const local = registry
    .childrenOf(parent.id)
    .map((s) => ({
      agentId: s.id,
      kind: 'subagent' as const,
      title: s.title,
      provider: s.provider,
      model: s.model,
      agentType: s.agentType,
      status: statusOf(s),
      idleForSeconds: idleSeconds(s.id),
      cwd: s.cwd,
      ...(s.parentId && s.planPath ? { findingsFile: s.planPath } : {})
    }))
  // A master's batch: root threads on this host carrying its id.
  const host = registry.hostName()
  const batch = batchOf(parent).map((s) => ({
    agentId: s.id,
    kind: 'thread' as const,
    title: s.title,
    threadType: s.threadType,
    provider: s.provider,
    model: s.model,
    reasoning: s.reasoning,
    host,
    status: statusOf(s),
    idleForSeconds: idleSeconds(s.id),
    cwd: s.cwd
  }))
  // Threads on other hosts follow: live state over the link, the last seen state with linkDown when it is down.
  const remote = crossHost ? await crossHost.list(parent) : []
  return JSON.stringify([...local, ...batch, ...remote])
}

/** Fields a single spawn and each batch entry share. */
const spawnSpecShape = {
  provider: z
    .enum(providerIds)
    .optional()
    .describe('Which harness runs the agent (omit to derive from the model)'),
  model: z
    .string()
    .optional()
    .describe(
      `Model id. Defaults per provider: ${providerIds.map((p) => `${p}=${CATALOG[p].defaultModel}`).join(', ')}`
    ),
  reasoning: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    .optional()
    .describe('Must be one of the efforts the chosen model supports (see system prompt); default medium'),
  agentType: z
    .enum(AGENT_TYPES)
    .optional()
    .describe('Defaults to implementer — explorer inside a research thread'),
  context1m: z
    .boolean()
    .optional()
    .describe(
      'Claude models only: the 1M context window, on by default for models that offer it. Pass false for 200k. true is rejected for models that do not offer it.'
    ),
  useWorktree: z
    .boolean()
    .optional()
    .describe(
      'Isolate a writing agent in its own git worktree (default true; ignored outside a git repo)'
    )
}
/** The host field a single spawn (not a batch entry) and app_start_thread take. */
export const HOST_PARAM_DESCRIPTION = "Which host runs it: omit for this machine; `mac` for this thread's Mac (or the only Mac linked here), `box` for the one host linked from here, or a host's environment id. Use the Mac for anything that needs Xcode, the iOS simulator, a Mac app, computer use, or files that live on the Mac; use the box for its checkouts and services. The thread runs there as an ordinary thread of that host, and its agent id comes back as `<host>:<id>` so every later call reaches it. Work meant for the Mac is a child ON the Mac (`environmentId: \"mac\"`), never a child here that reaches the Mac through mac_* tools. If the Mac refuses at its thread cap, wait for one of its threads to finish and retry; never start the work on this host instead."

/** The description with the hosts reachable right now appended: "Reachable now: mac = Landon Mac (env_…)". */
export function hostParamDescription(): string {
  const line = crossHost?.hostsLine()
  return line ? `${HOST_PARAM_DESCRIPTION} Reachable now: ${line}.` : HOST_PARAM_DESCRIPTION
}

export function orchestratorMcp(parent: SessionMeta): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'orchestrator',
    version: '0.1.0',
    tools: [
      tool(
        'spawn_agent',
        `Spawn a subagent session and send it its task. Returns the agent id. The agent works asynchronously — use wait_for_agent to collect its result. To fan out, pass \`agents\` (up to ${SPAWN_BATCH_MAX} entries, each with its own task) instead of \`task\`: one call starts the whole batch and returns every agent id; the top-level fields are defaults each entry may override.`,
        {
          ...spawnSpecShape,
          environmentId: z.string().optional().describe(hostParamDescription()),
          task: z
            .string()
            .optional()
            .describe('The complete, self-contained task prompt (one agent; omit when passing agents)'),
          agents: z
            .array(z.object({ ...spawnSpecShape, task: z.string().describe('This agent\'s task') }))
            .max(SPAWN_BATCH_MAX)
            .optional()
            .describe(
              `A batch of up to ${SPAWN_BATCH_MAX} agents started by this one call. Each entry takes the same fields as a single spawn; unset ones fall back to the top-level values.`
            )
        },
        async (args) => text(await orchSpawnAgent(parent, args))
      ),
      tool(
        'send_to_agent',
        'Send a follow-up message to a subagent you spawned.',
        { agentId: z.string(), message: z.string() },
        async (args) => text(await orchSendToAgent(parent, args.agentId, args.message))
      ),
      tool(
        'check_agent',
        'Non-blocking look at what a subagent is doing right now: status, recent tool activity, latest streamed text, anything it is stuck on, token usage. Use it to supervise long-running agents without waiting.',
        { agentId: z.string() },
        async (args) => text(await orchCheckAgent(parent, args.agentId))
      ),
      tool(
        'wait_for_agent',
        'Block until a subagent (or the first of several) finishes its current turn, then return its latest reply and status. The wait also returns when the person sends a message into your turn (status steered: act on it, then wait again), when your turn is stopped (aborted), when a child\'s turn ends behind background work it keeps watching (status watching, with waitingOn: its reply is complete), and when a child\'s harness dies (status stopped). Timeouts are normal for long tasks — check_agent, then wait again.',
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
            .default(0)
            .describe(
              '0 / omitted = sleep until settled (the normal case — no polling). Set only when you want control back early; the agents keep running.'
            )
        },
        async (args, extra) => text(await orchWaitForAgent(parent, args, (extra as { signal?: AbortSignal } | undefined)?.signal))
      ),
      tool(
        'answer_agent',
        'Answer a subagent\'s pending structured question (the "pending" payload from wait_for_agent/check_agent). answers[i] = chosen option labels (or freeform text) for questions[i]. A local agent\'s permission approvals belong to the user; an agent on another host (a `<host>:<id>` agent id) takes `allow` for its approval, since that thread runs under this one\'s grant there.',
        {
          agentId: z.string(),
          requestId: z.string().describe('pending.requestId from wait_for_agent/check_agent'),
          answers: z.array(z.array(z.string())).optional(),
          allow: z.boolean().optional().describe('An approval on another host: true allows, false denies')
        },
        async (args) => text(await orchAnswerAgent(parent, args))
      ),
      tool(
        'interrupt_agent',
        "Stop a subagent's current turn (it stays alive and can be redirected with send_to_agent). For runaway or off-track agents.",
        { agentId: z.string() },
        async (args) => text(await orchInterruptAgent(parent, args.agentId))
      ),
      tool('list_agents', 'List the subagents of this session with their status (those on other hosts carry host and a `<host>:<id>` agent id).', {}, async () =>
        text(await orchListAgents(parent))
      )
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

const orchestratorMechanics = (rules: OrchestrationRules, role: PolicyRole = 'thread'): string =>
  `
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
listed are the ONLY valid reasoning values per model — this table already
reflects the user's approved-model settings, and anything outside it is
refused):
${spawnableModels(rules, role)}
Agent types: ${AGENT_TYPES.join(', ')} — implementers write code, explorers
read/investigate, reviewers judge, orchestrators sub-orchestrate.

A host: spawn_agent (and app_start_thread) take \`environmentId\`: \`mac\`
for this thread's Mac (or the only Mac linked), or a host's environment id.
Use it for anything that needs Xcode, the iOS simulator, a Mac app, or files
on the Mac — the agent runs there as an ordinary thread the Mac app shows
under This Mac, its id comes back as \`<host>:<id>\`, and every supervision
tool routes by that id. If the link drops mid-wait the result says
\`linkDown\` with the last state seen; wait again once the Mac is back.
Work meant for the Mac is \`spawn_agent\` with \`environmentId: "mac"\`:
the child runs on the Mac as a Mac thread. Never spawn a child here for it
in the hope it reaches the Mac through mac_* tools. When the Mac refuses at
its thread cap, wait for one of its threads to finish and retry; do not
spawn the work on this host instead.

Give each agent a complete, self-contained task prompt — it cannot see this
conversation. Parallelize independent work; sequence dependent work. A
fan-out is ONE spawn_agent call with \`agents\` (up to ${SPAWN_BATCH_MAX} entries,
each its own task and model) — not one call per agent.

Subagents ALWAYS go through spawn_agent — spawned agents are visible,
steerable sessions in the app's fleet panel with their own transcripts.
The built-in subagent tool (named Task or Agent depending on harness
version) is disabled here for exactly that reason: its lanes are
invisible to the user. Anything you would have handed to it
(exploration, a general-purpose errand), hand to spawn_agent instead.

Supervise without polling. After spawning, keep doing your OWN work —
subagents run in parallel with you. When you need results, call
wait_for_agent (agentIds + mode "any" collects fan-outs in completion
order): with no timeoutSeconds it sleeps until an agent settles, so never
loop on check_agent to "poll". And if you simply end your turn while
agents run, a settling agent automatically wakes this thread with a
<subagent-report> message — going dormant is a valid strategy. Use
check_agent only for judgment mid-flight: a large idleForSeconds or a
wrong-direction tool trail means redirect (interrupt_agent, then
send_to_agent) or replace. A "waiting" agent is stuck on its "pending"
payload: a structured question you answer with answer_agent, or a
permission approval that only the user can grant — surface those to the
user and keep working. Verify results before relaying them, and keep the
user posted: what you delegated where, and why.

A FOLLOW-UP message after the fleet settled is a new round of work, not a
footnote: re-plan it deliberately. Reuse a settled agent via send_to_agent
when its warm context genuinely helps (same files, same subsystem);
otherwise spawn fresh agents scoped to the new request. Never leave
follow-up work implicit or bolt it onto a finished agent's stale task.

${NOTES_MECHANICS}`.trim()

const DELEGATION_LINES: Record<OrchestrationRules['conduct']['delegation'], string> = {
  strict:
    'You are a conductor, not a performer: delegate EVERY substantive task (code, analysis, docs) to subagents. If a task looks too small to delegate, it still goes to a subagent.',
  balanced:
    'Delegate substantive tasks to subagents; you may handle trivial glue work (a one-line answer, reading a file) yourself.',
  free: 'Delegate when it helps; you may also do work directly when that is faster.'
}

/** Render the structured rules as prompt text. */
function renderRules(rules: OrchestrationRules, role: PolicyRole): string {
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

  // Rows pointing at unapproved models are dropped, and each row's effort
  // is fitted to the approved range — the table never tells the model to
  // do something spawn_agent would refuse or silently adjust.
  const active = rules.routing.filter(
    (r) => r.enabled && modelApproved(rules, r.provider, ruleModel(r), role)
  )
  const fallback = approvedDefault(rules, 'claude', role)
  const routing = active.length
    ? `Routing table — for each task, use the FIRST matching row's exact
provider/model/effort (deviate only when the user explicitly names a
model, and say so):
${active.map((r, i) => `${i + 1}. ${r.task} → ${r.provider} · ${ruleModel(r)} · ${fitReasoning(rules, r.provider, ruleModel(r), r.reasoning)}`).join('\n')}
${fallback ? `No row matches → claude · ${fallback} · ${fitReasoning(rules, 'claude', fallback, 'medium')}.` : 'No row matches → pick any approved model by judgment.'}`
    : `No routing table configured — pick an approved provider/model/effort
by judgment: cheap models for mechanical work, capable models for
judgment and user-facing work, low effort for trivial tasks.`

  return `## Conduct (user-defined, binding)\n\n${conduct}\n\n## Routing (user-defined, binding)\n\n${routing}`
}

/** What a project's master thread is told, on every turn (CLAUDE.md
 *  "Master threads"). Short: it rides every prompt of the master. */
export const MASTER_MECHANICS = `## You are a master thread

Your batch is the ROOT threads you start with app_start_thread: each one
its own type, model, effort, context window and host (a thread is the
person's choice: any catalog model, no model policy; work meant for the
Mac is a thread there, \`environmentId: "mac"\`, and a refusal at the
Mac's thread cap means wait and retry, never start it here), and \`after\` names
a sibling it waits for. They carry your id, so the supervision tools
(check_agent, wait_for_agent, send_to_agent, interrupt_agent, answer_agent,
list_agents) work on them by id; list_agents marks each row \`thread\`
(a batch thread) or \`subagent\`. A thread one of them starts (a plan's
build) joins the batch too. adopt_thread brings an existing thread in.
You are woken by a <subagent-report> when a batch thread settles,
including when it waits on a question you can relay or answer with
answer_agent. You never edit code yourself: the editing tools are off for
you; the threads do the work.

When you open a batch, call batch_rules with the whole list of steps the
app runs when the last thread is done, written for THIS project: the
built-in kinds (land, gate, release, publish, deploy) and shell steps of
your own (a Minecraft plugin: build, deploy to the dev server, smoke test;
this app: gate, release, publish, deploy), plus land as they finish or all
at once and then notify or archive the children; state the steps to the
person in one line. The app runs those steps, not you and not the threads:
do not run the gate or the release from here or ask a thread to;
batch_gate exists to run the gate and release steps early. You are told by
a <batch-report> when the batch is blocked (a thread errored or stopped),
when a step failed, and when everything is done.

Prefer ending your turn to blocking in wait_for_agent: the batch's settles
and reports wake you, and you stay live (watching) until the batch is
done. A person's message reaches you at once, into a live turn as a
<user-steer> or as a wake; a wait_for_agent in flight returns on it.`

/** What a thread hears when it is pinned as a master, or unpinned, while
 *  its harness is up: the harness's prompt was built at its spawn
 *  (mechanicsFor), so until the next spawn carries the change the
 *  mechanics ride the conversation, into the live turn or ahead of the
 *  next message (sessions.ts setMaster). */
export function masterPinNotice(master: boolean): string {
  return master
    ? `<master-pinned>\nThis thread was just pinned as its project's master thread. From here on:\n\n${MASTER_MECHANICS}\n</master-pinned>`
    : '<master-unpinned>\nThis thread is no longer a master thread: it has no batch, the batch tools refuse it, and it works as an ordinary thread again.\n</master-unpinned>'
}

/** The mechanics a session is prompted with: the spawn toolset, plus the
 *  master block when the session is its project's master. */
export function mechanicsFor(session: SessionMeta): string {
  const base = orchestratorMechanics(rulesFor(session), policyRole(session))
  return isMasterSession(session) ? `${base}\n\n${MASTER_MECHANICS}` : base
}

/** Prompt appended to an orchestrator's system prompt: fixed mechanics
 *  plus the user's structured rules (workspace override or global). */
export function orchestratorPrompt(session: SessionMeta): string {
  const rules = rulesFor(session)
  const role = policyRole(session)
  const custom = session.threadRules?.instructions?.trim()
  const extra = custom ? `\n\n## This run's instructions (user-defined, binding)\n\n${custom}` : ''
  return `${mechanicsFor(session)}\n\n${SHOWING_VISUALS}\n\n${renderRules(rules, role)}${extra}`
}

/** Mechanics for claude implementation threads: the same spawn toolset
 *  without the conductor rules — the implementer works first, delegates
 *  when it genuinely helps. */
export function implementerSpawnPrompt(session: SessionMeta): string {
  return `${mechanicsFor(session)}

You are the implementer, not a conductor: do the work yourself by default.
Spawn subagents when it genuinely helps — parallel mechanical work, an
independent review, a second opinion — and supervise what you spawn.`
}

/** Mechanics for chat threads: conversation first, delegation when real
 *  work would help the discussion. */
export function chatSpawnPrompt(session: SessionMeta): string {
  return `${mechanicsFor(session)}

This is a conversation thread: think with the user by default. Spawn
subagents when concrete work would sharpen the discussion — mapping
existing code, an experiment, an independent second opinion — and
supervise what you spawn while the conversation continues.`
}

/** Mechanics for planning threads: the fleet feeds the plan document. */
export function planningSpawnPrompt(session: SessionMeta): string {
  return `${mechanicsFor(session)}

This is a PLANNING thread: your deliverable is the plan document, and
subagents exist to feed it. Spawn explorers to map code and gather
context in parallel, or a reviewer for an independent read on an
approach — never implementers: nothing gets built from this thread, and
no subagent writes anything beyond notes. Fold what they find into the
plan as their reports land.`
}

/** Mechanics for project-plan threads: explorers survey the project in
 *  parallel; nothing is built and nothing is started from here. */
export function projectPlanSpawnPrompt(session: SessionMeta): string {
  return `${mechanicsFor(session)}

This is a PROJECT PLAN thread: your deliverable is the project plan
document (Goals, Current state, Milestones, Risks, Open questions), and
subagents exist to survey the project for it. Spawn explorers to map the
codebase, the docs and the open work in parallel — one per area, each
with a self-contained brief — or a reviewer for an independent read on a
milestone split. Never implementers: nothing gets built from this thread,
no subagent writes anything beyond notes, and no thread of any type is
started from here. Fold what they find into the plan as their reports
land.`
}

/** Mechanics for research threads: the fleet IS the method — parallel
 *  explorers, each writing an app-assigned findings file the root
 *  synthesizes from. */
export function researchSpawnPrompt(session: SessionMeta): string {
  return `${mechanicsFor(session)}

This is a RESEARCH thread: your deliverable is a cited report, and
subagents are how you cover ground. Spawn parallel explorers, one per
angle, each with a self-contained brief (the question, what counts as an
answer, where to look). The app assigns every explorer a findings file
beside your report — the spawn result and list_agents name it as
findingsFile — and appends the file contract to the brief, so never name
output paths yourself. Explorers run to completion: NEVER interrupt_agent
an explorer, never tell one to stop or to cut its reply short;
wait_for_agent until it settles. Then synthesize FROM THE FILES: read
each findings file, never just the reply (replies are truncated). The
report is yours to write.`
}

/** Directories a harness must be allowed to write beyond its cwd: a
 *  session in a research tree whose reports root is not its cwd (a
 *  worktree project) writes its report or angle file there. */
export function extraWriteRoots(cwd: string, reportsRoot: string | null): string[] {
  return reportsRoot && reportsRoot !== cwd ? [reportsRoot] : []
}

/** The write roots a driver grants this session (claude's
 *  additionalDirectories, codex's writable_roots): none outside a research tree. */
export function researchWriteRoots(session: SessionMeta): string[] {
  if (!registry?.researchRootOf(session.id)) return []
  return extraWriteRoots(session.cwd, registry.reportsRootFor(session))
}

/** The rules governing a session: workspace override → global → defaults,
 *  with the thread's own per-run conduct tune laid on top. */
/** Whether the project this thread works in reviews before merge
 *  (shared/review.ts); the implementation preamble and the turn pass read it. */
export function reviewsBeforeMerge(session: SessionMeta): boolean {
  return registry?.effectiveReview(session.projectId).settings.beforeMerge ?? false
}

export function rulesFor(session: SessionMeta): OrchestrationRules {
  const workspaceId = session.projectId
    ? (registry?.getProject(session.projectId)?.workspaceId ?? null)
    : null
  const base =
    (workspaceId ? registry?.getOrchestrationRules(workspaceId) : null) ??
    registry?.getOrchestrationRules(null) ??
    DEFAULT_RULES
  return mergeThreadRules(base, session.threadRules)
}
