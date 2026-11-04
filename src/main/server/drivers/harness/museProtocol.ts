import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Reasoning } from '@shared/catalog'
import type { Attachment, PermissionPolicy } from '@shared/events'
import type {
  ApprovalChoice,
  ApprovalRequestParams,
  Item,
  ItemDeltaParams,
  ReasoningEffort,
  SessionMcpServerConfig,
  SessionStartParams,
  TurnCompletedParams,
  TurnInputPart,
  UserInputAnswer,
  UserInputRequestParams
} from '@muse-code/sdk/dist/src/msp'
import type { HarnessEvent } from './types'

/**
 * The pure half of the Muse driver: our session facts → the Muse Session
 * Protocol's params, and its items → HarnessEvents (toAgentEvent.ts does
 * the rest). No process, no connection; every mapping has a test on the
 * spike's recorded frames (fixtures/muse).
 */

/** The permission profiles `permissionProfile/list` serves (1.4.14) and
 *  the approval mode each policy rides on: safe asks for everything the
 *  policy leaves open, edits for what the profile marks restricted (the
 *  CLI's own default), auto nothing (no sandbox, no prompts). */
export const PROFILE: Record<PermissionPolicy, string> = {
  safe: ':ask-me',
  edits: ':ask-me',
  auto: ':unrestricted'
}
export const APPROVAL_MODE: Record<PermissionPolicy, NonNullable<SessionStartParams['approvalMode']>> = {
  safe: 'promptUnmatched',
  edits: 'onRequest',
  auto: 'allowAll'
}

export interface SessionFacts {
  cwd: string
  model: string
  permission: PermissionPolicy
  /** The app-tools bridge (apptools.ts bridgeMcpConfig), a stdio server the session gets through `config.mcpServers` (the `sessionMcp` grant). */
  bridge?: Record<string, unknown> | null
}

export function mcpServersOf(bridge: Record<string, unknown> | null | undefined): Record<string, SessionMcpServerConfig> | undefined {
  if (!bridge || typeof bridge.command !== 'string') return undefined
  return {
    app: {
      transport: 'stdio',
      command: bridge.command,
      args: Array.isArray(bridge.args) ? (bridge.args as string[]) : [],
      env: (bridge.env as Record<string, string> | undefined) ?? {},
      mode: 'optional'
    }
  }
}

/** `session/start` params less the command id the connection mints. */
export function sessionStartParams(facts: SessionFacts): Omit<SessionStartParams, 'commandId'> {
  const mcpServers = mcpServersOf(facts.bridge)
  return {
    workspaceRoot: facts.cwd,
    ...(facts.model ? { modelId: facts.model } : {}),
    permissionProfile: PROFILE[facts.permission],
    approvalMode: APPROVAL_MODE[facts.permission],
    ...(mcpServers ? { config: { mcpServers } } : {})
  }
}

/** `session/resume` params for a thread's own native id: the same profile
 *  and servers as a start, so a resumed thread works as it did. */
export function sessionResumeParams(nativeId: string, facts: SessionFacts): { sessionId: string; modelId?: string; permissionProfile: string; config?: { mcpServers: Record<string, SessionMcpServerConfig> } } {
  const mcpServers = mcpServersOf(facts.bridge)
  return {
    sessionId: nativeId,
    ...(facts.model ? { modelId: facts.model } : {}),
    permissionProfile: PROFILE[facts.permission],
    ...(mcpServers ? { config: { mcpServers } } : {})
  }
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** The turn's input parts: the text, images inline as base64 (what
 *  `TurnInputPart` carries natively), every other attachment named in the
 *  text as a path, as the pi and cursor drivers do. */
export async function turnInput(text: string, attachments: Attachment[] = []): Promise<TurnInputPart[]> {
  const parts: TurnInputPart[] = []
  const refs: string[] = []
  for (const a of attachments) {
    const mediaType = (a.mime ?? IMAGE_MIME_BY_EXT[extname(a.path).toLowerCase()] ?? '').toLowerCase()
    if (a.kind === 'image' && mediaType.startsWith('image/')) {
      try {
        const data = await readFile(a.path)
        parts.push({ type: 'image', mediaType, base64Data: data.toString('base64') })
        continue
      } catch {
        // unreadable: fall through to a path reference
      }
    }
    refs.push(a.path)
  }
  const body = refs.length ? `${text}\n\n${refs.map((p) => `Attached file: ${p}`).join('\n')}` : text
  return [{ type: 'text', text: body }, ...parts]
}

/** Our ladder is Muse's less `none` (refused by Meta's provider); a level
 *  the ladder lacks is not sent, so the session's own default applies. */
export function reasoningEffortOf(reasoning: Reasoning | undefined): ReasoningEffort | undefined {
  return reasoning
}

// ── items → harness events ──────────────────────────────────────────

const TOOL_STATUS: Record<string, string> = {
  inProgress: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  rejected: 'failed',
  timedOut: 'failed'
}

const KIND_TITLES: Record<string, string> = {
  subagent: 'Subagent',
  workflow: 'Workflow',
  hookRun: 'Hook',
  userShell: 'Shell',
  webSearch: 'Web search',
  sideChat: 'Side chat',
  reminderChild: 'Reminder',
  scheduledFire: 'Scheduled run',
  backgroundTerminalCompletion: 'Background task'
}

/** The shell command a tool item ran: `commandText`, else the `command`
 *  of its JSON `args` (1.4.14's `bash` tool carries it there). */
export function commandOf(item: Item): string | undefined {
  if (item.commandText) return item.commandText
  const args = parsedArgs(item)
  return typeof args?.command === 'string' ? args.command : undefined
}

function parsedArgs(item: Item): Record<string, unknown> | null {
  if (!item.args) return null
  try {
    const v = JSON.parse(item.args) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A tool row's title: the CLI's active label, else the tool name with its
 *  command, else the kind's word. */
export function toolTitle(item: Item): string {
  if (item.displayLabel?.active) return item.displayLabel.active
  if (item.kind === 'toolCall') {
    const tool = item.tool ?? 'tool'
    const command = commandOf(item)
    return command ? `${tool}: ${command}` : tool
  }
  return KIND_TITLES[item.kind] ?? item.kind
}

/** The tool's kind for the translator's name table: a shell call is
 *  `execute`, the rest keep the CLI's tool name as the title's first word. */
function toolKind(item: Item): string | undefined {
  if (item.kind === 'userShell' || item.tool === 'bash' || commandOf(item)) return 'execute'
  return undefined
}

export function toolInput(item: Item): unknown {
  const command = commandOf(item)
  if (command) return { command }
  const args = parsedArgs(item)
  if (args) return args
  if (item.args) return { args: item.args }
  if (item.objective) return { objective: item.objective }
  return {}
}

/** The shell tool's final `visibleOutput` is a JSON receipt (`output`,
 *  `exit_code`, `truncated`); mid-call it is the raw text. The row keeps
 *  the raw output: what the deltas carried, else the receipt's `output`. */
function receiptOf(item: Item): { output?: string; exit_code?: number } | null {
  if (!item.visibleOutput?.startsWith('{')) return null
  try {
    const v = JSON.parse(item.visibleOutput) as { output?: unknown; exit_code?: unknown }
    return { ...(typeof v.output === 'string' ? { output: v.output } : {}), ...(typeof v.exit_code === 'number' ? { exit_code: v.exit_code } : {}) }
  } catch {
    return null
  }
}

function toolDetail(item: Item, output: string): string | undefined {
  const receipt = receiptOf(item)
  const text = output || receipt?.output || item.visibleOutput || item.finalSummary || item.message || ''
  const code = typeof item.exitCode === 'number' ? item.exitCode : receipt?.exit_code
  const exit = typeof code === 'number' && code !== 0 ? `exit ${code}` : ''
  return [text, exit].filter(Boolean).join('\n') || undefined
}

export const TOOL_KINDS = new Set(['toolCall', 'userShell', 'subagent', 'workflow', 'hookRun', 'webSearch', 'sideChat', 'reminderChild', 'scheduledFire', 'backgroundTerminalCompletion'])

/**
 * One `item/started|updated|completed` → the harness events it means.
 * `output` is what the deltas accumulated for a tool row (the driver keeps
 * it per item id); a message or reasoning item only closes its block here,
 * its text having streamed through `foldDelta`.
 */
export function foldItem(phase: 'started' | 'updated' | 'completed', item: Item, output = ''): HarnessEvent[] {
  switch (item.kind) {
    case 'agentMessage':
      return phase === 'completed' ? [{ type: 'message.completed' }] : []
    case 'reasoning':
      return phase === 'completed' ? [{ type: 'reasoning.completed' }] : []
    case 'userMessage':
    case 'compaction':
    case 'damagedRange':
    case 'earlierHistory':
    case 'overdueNotice':
    case 'monitorFeed':
      return []
    default: {
      if (!TOOL_KINDS.has(item.kind)) return []
      const callId = item.callId ?? item.itemId
      const status = TOOL_STATUS[item.status] ?? 'running'
      const terminal = status !== 'running'
      if (phase === 'started' || !terminal) {
        return [{ type: 'tool.started', callId, title: toolTitle(item), kind: toolKind(item), input: toolInput(item) }]
      }
      return [{ type: 'tool.updated', callId, title: toolTitle(item), kind: toolKind(item), status, detail: toolDetail(item, output) }]
    }
  }
}

/** A delta's event: a message's `text` field streams as the answer, a
 *  reasoning item's `summary.N` as thinking; a tool's `output` is kept by
 *  the driver and folded at the terminal row (null here). */
export function foldDelta(kind: Item['kind'] | undefined, delta: ItemDeltaParams): HarnessEvent | null {
  if (kind === 'agentMessage' && (delta.field ?? 'text') === 'text') return { type: 'message.delta', text: delta.delta }
  if (kind === 'reasoning') return { type: 'reasoning.delta', text: delta.delta }
  return null
}

// ── approvals ──────────────────────────────────────────────────────

/** The server-minted choice for Allow or Deny: `approved` for allow; `denied`,
 *  else `abort`, for deny. Never a policy amendment or a session-wide grant:
 *  the person answered one card, not a rule. null when the request offers
 *  nothing usable (the SDK's default-deny then holds). */
export function approvalChoice(request: Pick<ApprovalRequestParams, 'availableChoices'>, allow: boolean): ApprovalChoice | null {
  const pick = (decision: string): ApprovalChoice | undefined => request.availableChoices.find((c) => c.decision === decision && c.scope === 'once') ?? request.availableChoices.find((c) => c.decision === decision)
  if (allow) return pick('approved') ?? null
  return pick('denied') ?? pick('abort') ?? null
}

/** The card's words for an approval: the subject's command or path, else the tool. */
export function approvalTitle(request: Pick<ApprovalRequestParams, 'subject' | 'toolName'>): string {
  const s = request.subject
  if (s.command) return s.command
  if (s.path) return `${s.kind}: ${s.path}`
  if (s.host) return `${s.kind}: ${s.host}${s.port ? `:${s.port}` : ''}`
  return s.toolName ?? request.toolName
}

// ── questions ──────────────────────────────────────────────────────

export interface QuestionShape {
  question: string
  header?: string
  multiSelect?: boolean
  allowFreeform?: boolean
  options: { label: string; description?: string }[]
}

export function questionsOf(request: Pick<UserInputRequestParams, 'questions'>): QuestionShape[] {
  return request.questions.map((q) => ({
    question: q.question,
    header: q.header || undefined,
    multiSelect: q.selection.mode === 'multiple' || (q.selection.maxSelections ?? 1) > 1,
    allowFreeform: true,
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }))
  }))
}

/** answers[i] are the labels (or the typed text) for questions[i]: a label
 *  the question offers is a selection, anything else the free text. */
export function answersOf(request: Pick<UserInputRequestParams, 'questions'>, answers: string[][]): UserInputAnswer[] {
  return request.questions.map((q, i) => {
    const given = answers[i] ?? []
    const labels = given.filter((a) => q.options.some((o) => o.label === a))
    const free = given.filter((a) => !q.options.some((o) => o.label === a))
    const multiple = q.selection.mode === 'multiple' || (q.selection.maxSelections ?? 1) > 1
    const answer: UserInputAnswer = { questionId: q.id }
    if (multiple && labels.length) answer.selectedLabels = labels
    else if (labels[0]) answer.selectedLabel = labels[0]
    if (free.length) answer.freeText = free.join('\n')
    return answer
  })
}

// ── the host's arguments ────────────────────────────────────────────

/** Extra `muse serve` arguments for a host that answered `initialize`: on a
 *  Linux host whose sandbox is unavailable (no usable bubblewrap) every shell
 *  call would be refused, so the host restarts without one; the thread's
 *  worktree and the process guard are the fence then. Nothing elsewhere. */
export function serveArgs(platform: NodeJS.Platform, init: { sandboxAvailability?: string }): string[] {
  return platform === 'linux' && init.sandboxAvailability === 'unavailable' ? ['--disable-sandbox'] : []
}

// ── the turn's end ──────────────────────────────────────────────────

/** The error row's words for a turn that failed. A quota stop names the
 *  window and when it lifts (failureKind reads `quota: tierLimit` as a rate
 *  limit; the driver adds the window); a missing login says what to run. */
export function turnError(params: Pick<TurnCompletedParams, 'error' | 'terminal'>): string | null {
  const err = params.error
  if (params.terminal === 'cancelled') return null
  if (!err) return params.terminal === 'failed' ? 'the turn failed' : null
  switch (err.kind) {
    case 'authRequired':
      return 'Muse Code is not logged in on this host: run `muse login` once, or route the thread to an account that is signed in'
    case 'modelError':
      if (err.quota) return `quota: ${err.quota.limitKind}, resets ${resetWords(err.quota.resetsAtMs)}${err.message ? ` (${err.message})` : ''}`
      return err.message || 'the model answered with an error'
    case 'configError':
      return `Muse Code config error: ${err.message}`
    case 'launchError':
    case 'workflowLaunchError':
      return `Muse Code could not launch the turn: ${err.message}`
    case 'stepLimit':
      return `turn ended: step limit${err.message ? `: ${err.message}` : ''}`
    default:
      if (err.quota) return `quota: ${err.quota.limitKind}, resets ${resetWords(err.quota.resetsAtMs)}`
      return err.message || `the turn failed (${err.kind})`
  }
}

export function resetWords(atMs: number, now = Date.now()): string {
  const mins = Math.max(1, Math.round((atMs - now) / 60_000))
  if (mins < 60) return `in ${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `in ${h} h${m ? ` ${m} min` : ''}`
}

/** Retry words for the strip: "retry 2 of 5 in 32 s (503)". */
export function retryWords(attempt: number, maxAttempts: number, delayMs: number, httpStatus?: number): string {
  const secs = Math.max(1, Math.round(delayMs / 1000))
  return `retry ${attempt} of ${maxAttempts} in ${secs} s${httpStatus ? ` (${httpStatus})` : ''}`
}
