import { basename } from 'node:path'
import { z } from 'zod'
import { allows, type Capability, type Principal } from '@shared/capabilities'
import { CATALOG, modelInfo, resolveModel, visibleCatalog, type ProviderId } from '@shared/catalog'
import type { FileChange, ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { EventRow, SessionMeta } from '@shared/events'
import { LIVE_STATUSES } from '@shared/session-lifecycle'
import { isOmittedBody } from '@shared/wire'
import { currentBranch, fileDiff, workingTreeChanges } from '../git'
import type { SessionRegistry } from '../sessions'
import { eventsPage, sessionPage } from '../wire'

/**
 * The remote facade: twelve operations an outside agent (Grok, ChatGPT,
 * the phone) drives temp-code through, each a plain function over the
 * registry with a zod input and a compact, model-readable output. The
 * `/mcp` endpoint (mcp.ts) maps its tools one to one onto FACADE_TOOLS;
 * the same table can back a REST surface later. Reads go through the D2
 * bounded paths (wire.ts eventsPage / sessionPage) — never a whole log —
 * and transcript pages come back as rendered lines, not event rows.
 */

export type FacadeStatus = 'working' | 'waiting' | 'failed' | 'done'

/** The registry's eight statuses collapsed to the four a bot acts on. */
export function collapseStatus(status: SessionMeta['status']): FacadeStatus {
  switch (status) {
    case 'starting':
    case 'running':
    case 'watching':
    // queued: created, not yet booted (CLAUDE.md "Master threads"); it reads as starting.
    case 'queued':
      return 'working'
    case 'waiting':
    case 'paused':
      return 'waiting'
    case 'error':
      return 'failed'
    default:
      return 'done'
  }
}

export class FacadeError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid' | 'conflict',
    message: string
  ) {
    super(message)
  }
}

export interface FacadeContext {
  registry: SessionRegistry
  principal: Principal
  /** The public origin, for the thread links in answers; null when unknown. */
  origin?: string | null
}

const capsOf = (p: Principal): Capability[] => (p.kind === 'local' ? ['admin'] : p.caps)

// ── sizes ────────────────────────────────────────────────────────────

/** The newest rows scanned for a pending prompt or the last words: a
 *  blocked harness writes nothing past its request, so the window is small. */
export const PENDING_SCAN_ROWS = 200
export const TRANSCRIPT_CHARS_DEFAULT = 16_000
export const TRANSCRIPT_CHARS_MAX = 48_000
export const TRANSCRIPT_BLOCKS_DEFAULT = 60
export const TRANSCRIPT_BLOCKS_MAX = 300
export const TEXT_CHARS = 4_000
export const FACE_CHARS = 200
export const RESULT_CHARS = 240
export const DIFF_CHARS_DEFAULT = 16_000
export const DIFF_CHARS_MAX = 64_000
export const LIST_ROWS_DEFAULT = 50
export const LIST_ROWS_MAX = 200
export const PROMPT_CHARS_MAX = 100_000

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const kb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

// ── pending prompts ──────────────────────────────────────────────────

export interface PendingPrompt {
  session: string
  requestId: string
  /** `plan` is a permission prompt on the plan-mode exit: answering it starts
   *  the work the thread already has leave for, so operate suffices. */
  kind: 'permission' | 'question' | 'plan'
  seq: number
  tool?: string
  summary: string
  questions?: {
    question: string
    options: string[]
    multiSelect?: boolean
    allowFreeform?: boolean
  }[]
}

const PLAN_TOOLS = new Set(['ExitPlanMode', 'exit_plan_mode'])

/** A one-line face of a tool call's input: the command, the path, the query, else compact JSON. */
export function toolFace(
  input: unknown,
  preview?: { title?: string; path?: string; query?: string }
): string {
  if (preview?.title) return cut(oneLine(preview.title), FACE_CHARS)
  const rec =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null
  const str = (key: string): string | null => {
    const v = rec?.[key]
    if (typeof v === 'string') return v
    if (isOmittedBody(v)) return `${v.head} [${kb(v.bytes)} omitted]`
    return null
  }
  const face =
    str('command') ??
    str('cmd') ??
    str('file_path') ??
    str('path') ??
    str('pattern') ??
    str('query') ??
    str('url') ??
    str('prompt') ??
    preview?.path ??
    preview?.query ??
    (input === undefined
      ? ''
      : JSON.stringify(input, (_k, v) => (isOmittedBody(v) ? `[${kb(v.bytes)} omitted]` : v)))
  return cut(oneLine(face ?? ''), FACE_CHARS)
}

/** The prompts among `rows` (oldest first) that no later row settled. */
export function pendingPrompts(session: string, rows: EventRow[]): PendingPrompt[] {
  const resolved = new Set<string>()
  for (const { event } of rows) {
    if (event.type === 'approval-resolved' || event.type === 'question-resolved')
      resolved.add(event.requestId)
  }
  const out: PendingPrompt[] = []
  for (const { seq, event } of rows) {
    if (event.type === 'approval-request' && !resolved.has(event.requestId)) {
      const plan = PLAN_TOOLS.has(event.toolName)
      out.push({
        session,
        requestId: event.requestId,
        kind: plan ? 'plan' : 'permission',
        seq,
        tool: event.toolName,
        summary: plan
          ? 'The thread asks to leave plan mode and start the work'
          : `${event.toolName}: ${event.title ? oneLine(event.title) : toolFace(event.input)}`
      })
    } else if (event.type === 'question-request' && !resolved.has(event.requestId)) {
      out.push({
        session,
        requestId: event.requestId,
        kind: 'question',
        seq,
        summary: event.questions.map((q) => oneLine(q.question)).join(' · '),
        questions: event.questions.map((q) => ({
          question: q.question,
          options: q.options.map((o) =>
            o.description ? `${o.label} — ${o.description}` : o.label
          ),
          ...(q.multiSelect ? { multiSelect: true } : {}),
          ...(q.allowFreeform ? { allowFreeform: true } : {})
        }))
      })
    }
  }
  return out
}

function promptsOf(reg: SessionRegistry, meta: SessionMeta): PendingPrompt[] {
  if (meta.status !== 'waiting') return []
  return pendingPrompts(meta.id, reg.lastEvents(meta.id, PENDING_SCAN_ROWS))
}

// ── the transcript as lines ──────────────────────────────────────────

interface Entry {
  seq: number
  text: string
}

function resultLine(output: unknown, isError: boolean): string {
  const tag = isError ? 'result ERROR' : 'result'
  if (isOmittedBody(output))
    return `${tag}: ${cut(oneLine(output.head), RESULT_CHARS)} (${output.lines} lines, ${kb(output.bytes)})`
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  const nl = text.indexOf('\n')
  const first = nl < 0 ? text : text.slice(0, nl)
  const lines = text.split('\n').length
  const tail = lines > 1 ? ` (${lines} lines, ${kb(Buffer.byteLength(text))})` : ''
  return `${tag}: ${cut(oneLine(first), RESULT_CHARS)}${tail}`
}

/** One line per thing that happened, deltas folded into their block and a
 *  replaced tool call shown once. Thinking, usage and status chatter are
 *  left out: a model reading the thread wants what was said and done. */
export function renderRows(rows: EventRow[]): Entry[] {
  const entries: Entry[] = []
  const blocks = new Map<string, Entry>()
  const calls = new Map<string, Entry>()
  let openDelta: { key: string; entry: Entry } | null = null
  const push = (seq: number, text: string): Entry => {
    const entry = { seq, text }
    entries.push(entry)
    return entry
  }
  for (const { seq, event } of rows) {
    if (event.type !== 'assistant-text') openDelta = null
    switch (event.type) {
      case 'user-text': {
        const extra = event.attachments?.length
          ? ` [${event.attachments.length} attachment${event.attachments.length === 1 ? '' : 's'}]`
          : ''
        push(seq, `user: ${cut(event.text.trim(), TEXT_CHARS)}${extra}`)
        break
      }
      case 'assistant-text': {
        const key =
          event.msgId !== undefined
            ? `${event.msgId}:${event.blockIndex ?? 0}`
            : (openDelta?.key ?? `s${seq}`)
        const known = blocks.get(key)
        if (event.delta) {
          if (known) known.text += event.text
          else {
            const entry = push(seq, event.text)
            blocks.set(key, entry)
          }
          openDelta = { key, entry: blocks.get(key)! }
        } else {
          if (known) known.text = event.text
          else blocks.set(key, push(seq, event.text))
          openDelta = null
        }
        break
      }
      case 'tool-call': {
        const text = `tool ${event.name}: ${toolFace(event.input, event.preview)}`
        const known = calls.get(event.callId)
        if (known) known.text = text
        else calls.set(event.callId, push(seq, text))
        break
      }
      case 'tool-result':
        push(seq, resultLine(event.output, event.isError))
        break
      case 'approval-request':
        push(
          seq,
          PLAN_TOOLS.has(event.toolName)
            ? `PLAN READY ${event.requestId}: the thread asks to leave plan mode — respond with allow`
            : `PERMISSION ${event.requestId}: ${event.toolName} — ${event.title ? oneLine(event.title) : toolFace(event.input)}`
        )
        break
      case 'approval-resolved':
        push(
          seq,
          `permission ${event.requestId}: ${event.allow ? 'allowed' : 'denied'}${event.auto ? ' (auto)' : ''}`
        )
        break
      case 'question-request':
        push(
          seq,
          `QUESTION ${event.requestId}: ${event.questions.map((q) => `${oneLine(q.question)} [${q.options.map((o) => o.label).join(' | ')}${q.allowFreeform ? ' | free text' : ''}]`).join('; ')}`
        )
        break
      case 'question-resolved':
        push(
          seq,
          `answered ${event.requestId}: ${event.answers ? event.answers.map((a) => a.join(', ')).join('; ') : 'dismissed'}`
        )
        break
      case 'plan':
        push(seq, `plan: ${cut(event.text.trim(), TEXT_CHARS)}`)
        break
      case 'error':
        push(
          seq,
          `${event.stopped ? 'stopped' : 'error'}: ${cut(oneLine(event.message), TEXT_CHARS)}`
        )
        break
      case 'turn-complete':
        push(seq, '— turn complete —')
        break
      case 'agent-report':
        push(seq, `subagent "${event.title}" settled: ${event.status}`)
        break
      case 'background-task':
        push(seq, `background task ${event.status}: ${oneLine(event.description)}`)
        break
      case 'compaction':
        push(seq, `compaction ${event.phase}${event.error ? `: ${oneLine(event.error)}` : ''}`)
        break
      case 'goal':
        push(
          seq,
          `goal ${event.phase}: ${oneLine(event.condition)}${event.reason ? ` (${oneLine(event.reason)})` : ''}`
        )
        break
      default:
        break
    }
  }
  for (const entry of blocks.values())
    entry.text = `assistant: ${cut(entry.text.trim(), TEXT_CHARS)}`
  return entries
}

/** The entries joined newest-last and cut at `maxChars` from the old end. */
export function renderPage(
  entries: Entry[],
  maxChars: number
): { text: string; firstSeq: number | null; lastSeq: number | null; truncated: boolean } {
  if (entries.length === 0) return { text: '', firstSeq: null, lastSeq: null, truncated: false }
  const lines = entries.map((e) => `#${e.seq} ${e.text}`)
  let total = 0
  let start = lines.length
  while (start > 0 && total + lines[start - 1].length + 1 <= maxChars) {
    start--
    total += lines[start].length + 1
  }
  if (start === lines.length) {
    // One entry alone is past the budget: keep its tail.
    start = lines.length - 1
    lines[start] = `…${lines[start].slice(-maxChars)}`
  }
  return {
    text: lines.slice(start).join('\n'),
    firstSeq: entries[start].seq,
    lastSeq: entries[entries.length - 1].seq,
    truncated: start > 0
  }
}

// ── places: repos and projects ───────────────────────────────────────

interface Place {
  repo: WorkspaceMeta | null
  project: ProjectMeta | null
}

function placeOf(reg: SessionRegistry, meta: SessionMeta): Place {
  const project = meta.projectId ? reg.getProject(meta.projectId) : null
  const workspaces = reg.listWorkspaces()
  const repo =
    (project ? workspaces.find((w) => w.id === project.workspaceId) : null) ??
    (meta.workspaceId ? workspaces.find((w) => w.id === meta.workspaceId) : null) ??
    workspaces.find((w) => w.path === meta.cwd) ??
    null
  return { repo, project }
}

const same = (a: string | null | undefined, b: string): boolean =>
  !!a && a.toLowerCase() === b.toLowerCase()

/** A workspace by id, name, path, folder name or GitHub `owner/name`. */
export function findRepo(reg: SessionRegistry, ref: string): WorkspaceMeta {
  const workspaces = reg.listWorkspaces()
  const wanted = ref.trim()
  const hit =
    workspaces.find((w) => w.id === wanted) ??
    workspaces.find((w) => same(w.name, wanted)) ??
    workspaces.find((w) => w.path === wanted || w.path === wanted.replace(/\/+$/, '')) ??
    workspaces.find((w) => same(w.githubRepo, wanted)) ??
    workspaces.find((w) => same(basename(w.path), wanted))
  if (!hit) {
    const names = workspaces.map((w) => w.name).join(', ') || '(none added yet)'
    throw new FacadeError(
      'not_found',
      `no repo "${wanted}". list_projects shows them; known: ${names}`
    )
  }
  return hit
}

function sessionOf(reg: SessionRegistry, id: string): SessionMeta {
  const meta = reg.get(id)
  if (!meta) throw new FacadeError('not_found', `no session "${id}". list_sessions shows the ids.`)
  return meta
}

// ── rows ─────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string
  title: string
  type: SessionMeta['threadType']
  repo: string | null
  project: string | null
  branch: string | null
  provider: ProviderId
  model: string
  status: FacadeStatus
  /** The registry's own word, for when the four are not enough. */
  state: SessionMeta['status']
  /** What a waiting thread waits on, if a prompt is pending. */
  pending: PendingPrompt['kind'] | null
  queued: number
  archived: boolean
  lastActivity: string
  url?: string
}

const iso = (ts: number): string => new Date(ts).toISOString()

function rowOf(ctx: FacadeContext, meta: SessionMeta, prompts?: PendingPrompt[]): SessionRow {
  const { repo, project } = placeOf(ctx.registry, meta)
  const pending = prompts ?? promptsOf(ctx.registry, meta)
  return {
    id: meta.id,
    title: meta.title,
    type: meta.threadType,
    repo: repo?.name ?? null,
    project: project?.name ?? null,
    branch: project?.branch ?? null,
    provider: meta.provider,
    model: meta.model,
    status: collapseStatus(meta.status),
    state: meta.status,
    pending: pending[0]?.kind ?? null,
    queued: ctx.registry.queueList(meta.id).length,
    archived: meta.archived,
    lastActivity: iso(ctx.registry.lastActivityAt(meta.id) || meta.updatedAt),
    ...(ctx.origin ? { url: `${ctx.origin}/ui#thread=${meta.id}` } : {})
  }
}

// ── the operations ───────────────────────────────────────────────────

const Session = z.string().min(1).describe('The session id (from list_sessions or start_session).')
const StatusInput = z.enum(['working', 'waiting', 'failed', 'done'])

export const ListProjectsInput = z.object({}).describe('No arguments.')
export const ListSessionsInput = z.object({
  repo: z
    .string()
    .min(1)
    .optional()
    .describe('Only sessions of this repo (name, id, path or owner/name).'),
  project: z
    .string()
    .min(1)
    .optional()
    .describe('Only sessions of this project (name or id) within the repo.'),
  status: StatusInput.optional().describe('Only sessions in this status.'),
  archived: z.boolean().optional().describe('true: list archived sessions instead of live ones.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_ROWS_MAX)
    .optional()
    .describe(`Rows per page (default ${LIST_ROWS_DEFAULT}).`),
  cursor: z.string().optional().describe('The cursor from the previous page.')
})
export const StartSessionInput = z.object({
  repo: z
    .string()
    .min(1)
    .describe('The repo to work in: its name, id, path or GitHub owner/name (see list_projects).'),
  prompt: z
    .string()
    .min(1)
    .max(PROMPT_CHARS_MAX)
    .describe('The first message: what the session should do.'),
  model: z
    .string()
    .optional()
    .describe(
      '"claude" or "codex" for that provider\'s default model, or a model id such as claude-fable-5-1 or gpt-6.1-sol. Default: the repo\'s own default.'
    ),
  reasoning: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    .optional()
    .describe('Reasoning effort, within what the model offers.'),
  branch: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Work on this branch in its own worktree (created from the default branch when new). Omit to use the repo's checkout."
    ),
  project: z
    .string()
    .min(1)
    .optional()
    .describe('Work in this existing project (name or id) instead of naming a branch.'),
  type: z
    .enum(['chat', 'planning', 'implementation', 'research'])
    .optional()
    .describe(
      'The thread type. Default implementation; chat for questions, planning for a plan first.'
    ),
  title: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('A title; otherwise the first line of the prompt.'),
  permission: z
    .enum(['safe', 'edits', 'auto'])
    .optional()
    .describe(
      'safe: every risky tool asks; edits: file edits run, shell and the rest ask (default); auto: nothing asks (needs the approve capability).'
    )
})
export const SendMessageInput = z.object({
  session: Session,
  text: z.string().min(1).max(PROMPT_CHARS_MAX).describe('The message.'),
  when: z
    .enum(['after_turn', 'now', 'interrupt'])
    .optional()
    .describe(
      'after_turn (default): queue it behind the current turn, sent at once if idle. now: steer the running turn with it. interrupt: stop the current turn, then send it.'
    )
})
export const GetSessionInput = z.object({ session: Session })
export const GetTranscriptInput = z.object({
  session: Session,
  limit: z
    .number()
    .int()
    .min(1)
    .max(TRANSCRIPT_BLOCKS_MAX)
    .optional()
    .describe(
      `How many of the newest blocks (a message, a tool call with its result) to read; default ${TRANSCRIPT_BLOCKS_DEFAULT}, about one turn.`
    ),
  before: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Page older: the firstSeq of the page you hold.'),
  after: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Page newer: the lastSeq you hold; returns what came after it.'),
  chars: z
    .number()
    .int()
    .min(1000)
    .max(TRANSCRIPT_CHARS_MAX)
    .optional()
    .describe(`Character budget of the page (default ${TRANSCRIPT_CHARS_DEFAULT}).`)
})
export const ListPendingInput = z.object({
  session: Session.optional().describe('Only this session; default every waiting session.')
})
export const RespondInput = z.object({
  session: Session,
  requestId: z.string().min(1).describe('The prompt id from list_pending or the transcript.'),
  allow: z.boolean().optional().describe('For a permission or plan prompt: allow or deny.'),
  answers: z
    .array(z.array(z.string()))
    .optional()
    .describe(
      'For a question prompt: answers[i] = the chosen option labels (or typed text) for question i.'
    ),
  answer: z.string().optional().describe('For a single question: the one answer.')
})
export const StopSessionInput = z.object({ session: Session })
export const ArchiveSessionInput = z.object({
  session: Session,
  archived: z.boolean().optional().describe('false restores an archived session. Default true.')
})
export const GetDiffInput = z.object({
  session: Session,
  path: z.string().min(1).optional().describe('One changed file: include its unified diff.'),
  chars: z
    .number()
    .int()
    .min(1000)
    .max(DIFF_CHARS_MAX)
    .optional()
    .describe(`Character budget of the diff text (default ${DIFF_CHARS_DEFAULT}).`)
})

export async function listProjects(ctx: FacadeContext): Promise<{
  repos: {
    id: string
    name: string
    path: string
    github: string | null
    projects: {
      id: string
      name: string
      branch: string | null
      mode: ProjectMeta['mode']
      cwd: string
    }[]
  }[]
}> {
  const projects = ctx.registry.listProjects().filter((p) => !p.archived)
  return {
    repos: ctx.registry.listWorkspaces().map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      github: w.githubRepo ?? null,
      projects: projects
        .filter((p) => p.workspaceId === w.id)
        .map((p) => ({ id: p.id, name: p.name, branch: p.branch, mode: p.mode, cwd: p.cwd }))
    }))
  }
}

export async function listSessions(
  ctx: FacadeContext,
  input: z.infer<typeof ListSessionsInput>
): Promise<{ sessions: SessionRow[]; cursor: string | null }> {
  const reg = ctx.registry
  const repo = input.repo ? findRepo(reg, input.repo) : null
  const project = input.project ? findProject(reg, repo, input.project) : null
  let metas = reg.list({ archived: input.archived ?? false }).filter((m) => !m.parentId)
  if (project) metas = metas.filter((m) => m.projectId === project.id)
  else if (repo) metas = metas.filter((m) => placeOf(reg, m).repo?.id === repo.id)
  if (input.status) metas = metas.filter((m) => collapseStatus(m.status) === input.status)
  const page = sessionPage(metas, input.cursor, { maxRows: input.limit ?? LIST_ROWS_DEFAULT })
  return { sessions: page.sessions.map((m) => rowOf(ctx, m)), cursor: page.cursor }
}

function findProject(reg: SessionRegistry, repo: WorkspaceMeta | null, ref: string): ProjectMeta {
  const candidates = reg
    .listProjects()
    .filter((p) => !p.archived && (!repo || p.workspaceId === repo.id))
  const hit =
    candidates.find((p) => p.id === ref) ??
    candidates.find((p) => same(p.name, ref)) ??
    candidates.find((p) => same(p.branch, ref))
  if (!hit)
    throw new FacadeError(
      'not_found',
      `no project "${ref}"${repo ? ` in ${repo.name}` : ''}. list_projects shows them.`
    )
  return hit
}

/** Where a new session runs: the named project, the branch's worktree
 *  project (made when missing), else the repo's newest local project,
 *  else the repo's own checkout. */
async function placeFor(
  reg: SessionRegistry,
  repo: WorkspaceMeta,
  input: { project?: string; branch?: string }
): Promise<ProjectMeta | null> {
  if (input.project) return findProject(reg, repo, input.project)
  const live = reg.listProjects().filter((p) => !p.archived && p.workspaceId === repo.id)
  if (input.branch) {
    const branch = input.branch.replace(/^origin\//, '')
    const existing = live.find((p) => p.branch === branch)
    if (existing) return existing
    if (!repo.git)
      throw new FacadeError(
        'invalid',
        `${repo.name} is not a git repository, so it has no branches.`
      )
    return reg.createProject(repo.id, branch, 'worktree', { branch })
  }
  return live.filter((p) => p.mode === 'local').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
}

function pickModel(
  input: { model?: string; reasoning?: string },
  defaults: { provider: ProviderId; model: string; reasoning: string }
): { provider: ProviderId; model: string; reasoning: SessionMeta['reasoning'] } {
  const asked = input.model?.trim().toLowerCase()
  let provider: ProviderId
  let model: string
  if (!asked) {
    const d = resolveModel(defaults.provider, defaults.model)
    provider = d.provider
    model = d.model || CATALOG[d.provider].defaultModel
  } else if (asked === 'claude' || asked === 'codex') {
    provider = asked
    model = CATALOG[asked].defaultModel
  } else {
    const r = resolveModel(defaults.provider, input.model!.trim())
    provider = r.provider
    model = r.model
  }
  const info = modelInfo(provider, model)
  if (!info) {
    const visible = visibleCatalog()
    const known = (['claude', 'codex'] as ProviderId[])
      .map((p) => `${p}: ${visible[p].models.map((m) => m.id).join(', ')}`)
      .join('; ')
    throw new FacadeError(
      'invalid',
      `no provider serves model "${input.model}". Use "claude", "codex" or one of ${known}`
    )
  }
  const reasoning = (input.reasoning ??
    (info.reasoning.includes(defaults.reasoning as never)
      ? defaults.reasoning
      : info.defaultReasoning) ??
    'medium') as SessionMeta['reasoning']
  if (info.reasoning.length && !info.reasoning.includes(reasoning)) {
    throw new FacadeError(
      'invalid',
      `${model} offers reasoning ${info.reasoning.join('|')}, not "${reasoning}".`
    )
  }
  return { provider, model, reasoning }
}

export async function startSession(
  ctx: FacadeContext,
  input: z.infer<typeof StartSessionInput>
): Promise<SessionRow & { cwd: string }> {
  const reg = ctx.registry
  const repo = findRepo(reg, input.repo)
  const project = await placeFor(reg, repo, input)
  const d = reg.resolveThreadDefaults(repo.id)
  const { provider, model, reasoning } = pickModel(input, d)
  const permission = input.permission ?? d.permission
  if (permission === 'auto' && !allows(capsOf(ctx.principal), 'approve')) {
    if (input.permission)
      throw new FacadeError(
        'forbidden',
        'permission "auto" lets a thread act without any prompt, which needs the approve capability this key lacks. Use "edits" or "safe".'
      )
  }
  const meta = await reg.create({
    provider,
    model,
    reasoning,
    permission:
      permission === 'auto' && !allows(capsOf(ctx.principal), 'approve') ? 'edits' : permission,
    projectId: project?.id ?? null,
    workspaceId: project ? null : repo.id,
    threadType: input.type ?? 'implementation',
    title: input.title
  })
  await reg.send(meta.id, input.prompt)
  const now = reg.get(meta.id) ?? meta
  return { ...rowOf(ctx, now, []), cwd: now.cwd }
}

export async function sendMessage(
  ctx: FacadeContext,
  input: z.infer<typeof SendMessageInput>
): Promise<{
  ok: true
  session: string
  delivered: 'sent' | 'queued' | 'steered' | 'interrupted'
  status: FacadeStatus
  queued: number
}> {
  const reg = ctx.registry
  const meta = sessionOf(reg, input.session)
  const live = LIVE_STATUSES.has(meta.status) || meta.status === 'paused'
  let delivered: 'sent' | 'queued' | 'steered' | 'interrupted'
  switch (input.when ?? 'after_turn') {
    case 'now':
      await reg.send(meta.id, input.text)
      delivered = live ? 'steered' : 'sent'
      break
    case 'interrupt':
      if (live) {
        // Front of the queue first, so the settle after the stop drains it before anything older.
        reg.queueAdd(meta.id, input.text, undefined, true)
        await reg.stopRun(meta.id)
        delivered = 'interrupted'
      } else {
        await reg.send(meta.id, input.text)
        delivered = 'sent'
      }
      break
    default:
      reg.queueAdd(meta.id, input.text)
      delivered = live ? 'queued' : 'sent'
  }
  const now = reg.get(meta.id) ?? meta
  return {
    ok: true,
    session: meta.id,
    delivered,
    status: collapseStatus(now.status),
    queued: reg.queueList(meta.id).length
  }
}

export interface SessionDetail extends SessionRow {
  cwd: string
  createdAt: string
  planPath: string | null
  prompts: PendingPrompt[]
  queue: { id: string; text: string }[]
  tasks: SessionMeta['tasks']
  activity: string | null
  goal: string | null
  /** The newest final assistant text, cut short: what the thread last said. */
  lastSaid: string | null
  /** The newest error, when the thread failed. */
  error: string | null
}

export async function getSession(
  ctx: FacadeContext,
  input: z.infer<typeof GetSessionInput>
): Promise<SessionDetail> {
  const reg = ctx.registry
  const meta = sessionOf(reg, input.session)
  const rows = reg.lastEvents(meta.id, PENDING_SCAN_ROWS)
  const prompts = meta.status === 'waiting' ? pendingPrompts(meta.id, rows) : []
  const entries = renderRows(rows)
  const lastSaid =
    [...entries]
      .reverse()
      .find((e) => e.text.startsWith('assistant: '))
      ?.text.slice('assistant: '.length) ?? null
  const error =
    meta.status === 'error'
      ? ((
          [...rows].reverse().find((r) => r.event.type === 'error')?.event as
            { message?: string } | undefined
        )?.message ?? null)
      : null
  return {
    ...rowOf(ctx, meta, prompts),
    cwd: meta.cwd,
    createdAt: iso(meta.createdAt),
    planPath: meta.planPath,
    prompts,
    queue: reg
      .queueList(meta.id)
      .map((m) => ({ id: m.id, text: cut(oneLine(m.text), FACE_CHARS) })),
    tasks: meta.tasks ?? null,
    activity: meta.activity ?? null,
    goal: meta.goal?.condition ?? null,
    lastSaid: lastSaid ? cut(lastSaid, 600) : null,
    error: error ? cut(oneLine(error), 600) : null
  }
}

export async function getTranscript(
  ctx: FacadeContext,
  input: z.infer<typeof GetTranscriptInput>
): Promise<{
  session: string
  status: FacadeStatus
  text: string
  firstSeq: number | null
  lastSeq: number | null
  moreBefore: boolean
  moreAfter: boolean
  reset: boolean
}> {
  const reg = ctx.registry
  const meta = sessionOf(reg, input.session)
  const page =
    input.after !== undefined && input.before === undefined
      ? eventsPage(reg, { sessionId: meta.id, afterSeq: input.after })
      : eventsPage(reg, {
          sessionId: meta.id,
          tail: input.limit ?? TRANSCRIPT_BLOCKS_DEFAULT,
          beforeSeq: input.before
        })
  const rendered = renderPage(renderRows(page.rows), input.chars ?? TRANSCRIPT_CHARS_DEFAULT)
  return {
    session: meta.id,
    status: collapseStatus(meta.status),
    text: rendered.text,
    firstSeq: rendered.firstSeq,
    lastSeq: rendered.lastSeq,
    moreBefore:
      page.moreBefore ||
      rendered.truncated ||
      (page.rows.length > 0 && rendered.firstSeq !== null && rendered.firstSeq > page.rows[0].seq),
    moreAfter: page.moreAfter,
    reset: page.reset
  }
}

export async function listPending(
  ctx: FacadeContext,
  input: z.infer<typeof ListPendingInput>
): Promise<{ pending: (PendingPrompt & { title: string; canRespond: boolean; how: string })[] }> {
  const reg = ctx.registry
  const metas = input.session
    ? [sessionOf(reg, input.session)]
    : reg.list({ archived: false }).filter((m) => !m.parentId && m.status === 'waiting')
  const approve = allows(capsOf(ctx.principal), 'approve')
  const pending = metas.flatMap((meta) =>
    promptsOf(reg, meta).map((p) => {
      const canRespond = p.kind !== 'permission' || approve
      return {
        ...p,
        title: meta.title,
        canRespond,
        how:
          p.kind === 'question'
            ? `respond(session, requestId, answers: [[...]]) — one array of chosen labels per question`
            : canRespond
              ? `respond(session, requestId, allow: true|false)`
              : `This key cannot answer permission prompts (needs approve). Tell the user to answer it in temp-code.`
      }
    })
  )
  return { pending }
}

export async function respond(
  ctx: FacadeContext,
  input: z.infer<typeof RespondInput>
): Promise<{
  ok: true
  session: string
  requestId: string
  kind: PendingPrompt['kind']
  status: FacadeStatus
}> {
  const reg = ctx.registry
  const meta = sessionOf(reg, input.session)
  const prompt = pendingPrompts(meta.id, reg.lastEvents(meta.id, PENDING_SCAN_ROWS)).find(
    (p) => p.requestId === input.requestId
  )
  if (!prompt)
    throw new FacadeError(
      'not_found',
      `no pending prompt "${input.requestId}" on session ${meta.id}. list_pending shows the current ones.`
    )
  if (prompt.kind === 'question') {
    const answers = input.answers ?? (input.answer !== undefined ? [[input.answer]] : null)
    if (!answers)
      throw new FacadeError(
        'invalid',
        `prompt ${prompt.requestId} is a question: pass answers (one array of chosen labels per question) or answer (for a single question).`
      )
    if (answers.length !== (prompt.questions?.length ?? 1))
      throw new FacadeError(
        'invalid',
        `prompt ${prompt.requestId} has ${prompt.questions?.length ?? 1} question(s); pass exactly that many answer arrays.`
      )
    await reg.answer(meta.id, prompt.requestId, answers)
  } else {
    if (input.allow === undefined)
      throw new FacadeError(
        'invalid',
        `prompt ${prompt.requestId} is a ${prompt.kind} prompt: pass allow: true or false.`
      )
    if (prompt.kind === 'permission' && !allows(capsOf(ctx.principal), 'approve')) {
      throw new FacadeError(
        'forbidden',
        `This key cannot approve permission prompts: that needs the approve capability, and bot (MCP) keys are capped at read and operate. Tell the user to answer it in temp-code — thread "${meta.title}" asks: ${prompt.summary}.`
      )
    }
    await reg.approve(meta.id, prompt.requestId, input.allow)
  }
  const now = reg.get(meta.id) ?? meta
  return {
    ok: true,
    session: meta.id,
    requestId: prompt.requestId,
    kind: prompt.kind,
    status: collapseStatus(now.status)
  }
}

export async function stopSession(
  ctx: FacadeContext,
  input: z.infer<typeof StopSessionInput>
): Promise<{ ok: true; session: string; status: FacadeStatus; state: SessionMeta['status'] }> {
  const reg = ctx.registry
  const meta = sessionOf(reg, input.session)
  await reg.stopRun(meta.id)
  const now = reg.get(meta.id) ?? meta
  return { ok: true, session: meta.id, status: collapseStatus(now.status), state: now.status }
}

export async function archiveSession(
  ctx: FacadeContext,
  input: z.infer<typeof ArchiveSessionInput>
): Promise<{ ok: true; session: string; archived: boolean }> {
  const reg = ctx.registry
  const meta = sessionOf(reg, input.session)
  const archived = input.archived ?? true
  await reg.setArchived(meta.id, archived)
  return { ok: true, session: meta.id, archived }
}

export async function getDiff(
  ctx: FacadeContext,
  input: z.infer<typeof GetDiffInput>
): Promise<{
  session: string
  cwd: string
  branch: string | null
  where: 'worktree' | 'checkout' | 'repo'
  files: FileChange[]
  totals: { files: number; adds: number; dels: number }
  diff?: string
  truncated?: boolean
}> {
  const reg = ctx.registry
  const meta = sessionOf(reg, input.session)
  const { project } = placeOf(reg, meta)
  const cwd = project?.cwd ?? meta.cwd
  const [branch, files] = await Promise.all([currentBranch(cwd), workingTreeChanges(cwd)])
  const out = {
    session: meta.id,
    cwd,
    branch: branch ?? project?.branch ?? null,
    where: (project ? (project.mode === 'worktree' ? 'worktree' : 'checkout') : 'repo') as
      'worktree' | 'checkout' | 'repo',
    files,
    totals: {
      files: files.length,
      adds: files.reduce((n, f) => n + f.adds, 0),
      dels: files.reduce((n, f) => n + f.dels, 0)
    }
  }
  if (!input.path) return out
  if (!files.some((f) => f.path === input.path))
    throw new FacadeError(
      'not_found',
      `"${input.path}" is not among the changed files; files lists them.`
    )
  const diff = await fileDiff(cwd, input.path)
  const max = input.chars ?? DIFF_CHARS_DEFAULT
  return diff.length > max
    ? { ...out, diff: `${diff.slice(0, max)}\n… [+${diff.length - max} chars]`, truncated: true }
    : { ...out, diff }
}

// ── the table ────────────────────────────────────────────────────────

export interface FacadeTool {
  name: string
  description: string
  input: z.ZodObject
  /** The capability the call needs; `respond` on a permission prompt checks approve itself. */
  needs: Capability
  run: (ctx: FacadeContext, input: never) => Promise<unknown>
}

const def = <S extends z.ZodObject>(
  name: string,
  needs: Capability,
  description: string,
  input: S,
  run: (ctx: FacadeContext, input: z.infer<S>) => Promise<unknown>
): FacadeTool => ({
  name,
  needs,
  description,
  input,
  run: run as FacadeTool['run']
})

export const FACADE_TOOLS: readonly FacadeTool[] = [
  def(
    'list_projects',
    'read',
    'The repos temp-code knows and the projects (branches or worktrees) inside each. Use a repo name with start_session.',
    ListProjectsInput,
    listProjects
  ),
  def(
    'list_sessions',
    'read',
    'Sessions (threads), working ones first: id, title, repo, project, branch, model, status (working | waiting | failed | done), pending prompt kind, queued messages, last activity. Paged by cursor.',
    ListSessionsInput,
    listSessions
  ),
  def(
    'start_session',
    'operate',
    'Start a session in a repo with a first prompt. Pick "claude" or "codex" (or a model id), optionally a branch (its own worktree) or an existing project. Returns the new session row; it is working right away.',
    StartSessionInput,
    startSession
  ),
  def(
    'send_message',
    'operate',
    'Send a message to a session: queued behind the current turn (default, sent at once when idle), steered into the running turn (now), or after stopping the current turn (interrupt).',
    SendMessageInput,
    sendMessage
  ),
  def(
    'get_session',
    'read',
    'One session in detail: the row plus its pending prompts, queue, task progress, activity, what it last said and the error when it failed.',
    GetSessionInput,
    getSession
  ),
  def(
    'get_transcript',
    'read',
    'A page of the transcript as lines: "#seq user: …", "#seq assistant: …", "#seq tool Bash: …", "#seq result: …", "#seq PERMISSION id: …", "#seq QUESTION id: …". Newest blocks by default (about a turn); page older with before=firstSeq, newer with after=lastSeq.',
    GetTranscriptInput,
    getTranscript
  ),
  def(
    'list_pending',
    'read',
    'Prompts waiting on a human: permission requests, plan approvals and questions, with the request ids respond takes and whether this key may answer each.',
    ListPendingInput,
    listPending
  ),
  def(
    'respond',
    'operate',
    'Answer a pending prompt: allow/deny a plan prompt, or answer a question. Permission prompts need the approve capability, which bot keys lack: the error says so and names the prompt to relay to the user.',
    RespondInput,
    respond
  ),
  def(
    'stop_session',
    'operate',
    'Stop the running turn (and every live subagent) of a session. The session stays and can take a new message.',
    StopSessionInput,
    stopSession
  ),
  def(
    'archive_session',
    'operate',
    'Archive a session (stops it first); archived: false restores it.',
    ArchiveSessionInput,
    archiveSession
  ),
  def(
    'get_diff',
    'read',
    'What the session changed in its working tree and on which branch: changed files with added/deleted line counts; with path, the unified diff of that file (bounded).',
    GetDiffInput,
    getDiff
  )
]

export const facadeTool = (name: string): FacadeTool | undefined =>
  FACADE_TOOLS.find((t) => t.name === name)

/** Parse, gate and run one operation. Throws FacadeError (or ZodError for a bad shape). */
export async function callFacade(
  ctx: FacadeContext,
  name: string,
  rawInput: unknown
): Promise<unknown> {
  const tool = facadeTool(name)
  if (!tool) throw new FacadeError('not_found', `unknown tool "${name}"`)
  if (!allows(capsOf(ctx.principal), tool.needs)) {
    throw new FacadeError(
      'forbidden',
      `${name} needs the ${tool.needs} capability; this key has ${capsOf(ctx.principal).join(', ')}.`
    )
  }
  const input = tool.input.parse(rawInput ?? {})
  return tool.run(ctx, input as never)
}
