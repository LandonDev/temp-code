import type { ChildProcess } from 'node:child_process'
import {
  query,
  type CanUseTool,
  type HookInput,
  type HookJSONOutput,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess
} from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'
import { access, open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import type { Attachment, BackgroundTask, BackgroundTaskKind, PermissionPolicy } from '@shared/events'
import { limitField } from '../limitText'
import { currentLag } from '../stalls'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import { FIRST_OUTPUT_SILENCE } from './silence'
import { parsePartialJson } from './partial-json'
import { toolDisplay } from './display'
import {
  chatSpawnPrompt,
  implementerSpawnPrompt,
  planningSpawnPrompt,
  projectPlanSpawnPrompt,
  researchSpawnPrompt,
  ORCHESTRATOR_TOOLS,
  isMasterSession,
  orchestratorMcp,
  orchestratorPrompt,
  researchWriteRoots,
  rulesFor
} from '../orchestration'
import { APP_TOOLS, appToolsMcp } from '../apptools'
import { withMacTools } from '../macTools'
import { expandSlashRefs } from '../slash'
import { resolveClaude } from './binaries'
import { routedEndpointFor } from '../endpoint'
import { gateway } from '../gateway'
import { spawnOrAdoptClaude } from './claudeWarm'
import { claudeFastFor, noteClaudeInit } from './claudeTiers'
import { unwrapBashCommand, wrapBashCommand } from '../processGuard'

// Dev override: a small window (e.g. 45_000 → compaction arms at ~12k)
// makes a real compaction reachable in one short thread for UI work.
/** The editing tools an orchestrator without self-edit, or a master, loses. */
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
const AUTO_COMPACT_WINDOW = Number(process.env.TEMP_CODE_AUTO_COMPACT_WINDOW) || 190_000

/**
 * Claude driver — the Claude Code harness as a library. The SDK spawns the
 * official CLI over pipes and runs under the user's own `claude` login
 * (Agent SDK subscription credit). We never touch credentials.
 *
 * Uses streaming-input mode: one long-lived query() per session, send()
 * pushes user messages into its input iterable.
 *
 * Mapping verified against the live stream (scripts/sdk-dump.ts):
 *  - deltas carry (msgId, blockIndex) from message_start/content_block_*
 *    so folding replaces the right block across multi-message turns
 *  - tool calls surface early at content_block_start, replaced with full
 *    input by the final assistant message (same callId)
 *  - parent_tool_use_id (in-harness Task subagents) rides along as
 *    parentCallId; the UI nests that output under the Task chip
 *  - result.total_cost_usd/usage are cumulative for the whole session —
 *    the UI shows the latest, never sums
 */

/** Longest image side the API accepts without rejection (2000px limit). */
const MAX_IMAGE_EDGE = 1568

/** Unbounded async queue bridging send() calls into query()'s input iterable. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = []
  private waiters: ((v: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(text: string, attachments: Attachment[] = []): void {
    // Images become native content blocks; other files ride along as path
    // references the harness reads itself.
    type Content = SDKUserMessage['message']['content']
    const content: Exclude<Content, string> = []
    const refs: string[] = []
    for (const a of attachments) {
      if (a.kind === 'image' && a.mime) {
        try {
          // Oversized images (>2000px on a side) get rejected by the API and
          // have wedged the CLI at result time — downscale before sending.
          let data: string
          let mediaType = a.mime
          const img = nativeImage.createFromPath(a.path)
          const size = img.isEmpty() ? { width: 0, height: 0 } : img.getSize()
          if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE) {
            const s = MAX_IMAGE_EDGE / Math.max(size.width, size.height)
            data = img
              .resize({
                width: Math.round(size.width * s),
                height: Math.round(size.height * s)
              })
              .toJPEG(85)
              .toString('base64')
            mediaType = 'image/jpeg'
          } else {
            data = readFileSync(a.path).toString('base64')
          }
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType as 'image/png', data }
          })
        } catch {
          refs.push(a.path)
        }
      } else {
        refs.push(a.path)
      }
    }
    const full = refs.length
      ? `${text}\n\n${refs.map((p) => `Attached file: ${p}`).join('\n')}`
      : text
    content.push({ type: 'text', text: full })
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: ''
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: msg, done: false })
    else this.buffer.push(msg)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const buffered = this.buffer.shift()
        if (buffered) return Promise.resolve({ value: buffered, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

/** Per-session mutable stream state (current message id per subagent lane). */
interface StreamState {
  /** key: parent_tool_use_id ?? '' → current API message id in that lane */
  currentMsgId: Map<string, string>
  /** key: `${lane}:${blockIndex}` → tool input JSON accumulating from deltas */
  toolInput: Map<string, { callId: string; name: string; json: string; lastEmit: number }>
  /** a turn is in flight (send happened, no result yet) — lets the drain
   *  loop settle the status if the stream dies without one */
  working: boolean
  /** set when a top-lane assistant message finished with NO tool calls —
   *  the only thing left is the result, so prolonged silence after this
   *  means the CLI wedged (seen with oversized image attachments). Any
   *  other message disarms it; tool execution is never mistaken for a
   *  wedge because its assistant message carries tool_use blocks. */
  armedAt: number | null
  /** one stdin nudge per armed stretch */
  nudged: boolean
  /** the API refused the transcript ("Prompt is too long") — the drain
   *  loop compacts in place once the turn settles so the next send fits */
  overflowed: boolean
  /** last live context footprint forwarded (dedupes context events) */
  contextTokens: number
  /** one recovery compact per overflow; a compact that lands re-arms */
  compactRecoveryTried: boolean
  /** live non-ambient background tasks, id → what is known of it: the
   *  last background_tasks_changed level (replace semantics) */
  tasks: Map<string, TaskInfo>
  /** every non-ambient task id → what was ever seen of it (task_started,
   *  the level, the Stop hook), so a task_notification can be named after
   *  the level already dropped the task and a later level keeps the call
   *  id and command an earlier source gave; deleted on notification */
  known: Map<string, TaskInfo>
  /** ids the CLI flagged ambient (housekeeping): never user-visible */
  ambient: Set<string>
  /** ids that started in the FOREGROUND (a blocking Bash) and were moved
   *  to the background by the tool timeout. The model did not choose to
   *  wait on those, and the CLI's own bookkeeping for them is unreliable
   *  (most never report; one was listed live for hours after its process
   *  died), so they never hold the thread in 'watching'. */
  foreground: Set<string>
  /** when each live task was first seen (the forgotten-task check) */
  since: Map<string, number>
  /** tasks this turn referred to (a tool input naming the id: TaskOutput,
   *  TaskStop, a Read of its output file) */
  touched: Set<string>
  /** when each task was last put to the model by the check */
  checked: Map<string, number>
  /** pushes a driver-initiated turn into the harness input (null in tests) */
  sendCheck: ((text: string) => void) | null
  /** session crons (CronCreate, ScheduleWakeup, /loop) from the last Stop
   *  hook input — they never appear in the task level */
  crons: { id: string; label: string }[]
  /** the turn's phase before its first content (events.ts `phase`), null between */
  phase: 'cli-starting' | 'initializing' | 'waiting-provider' | 'retrying' | null
  /** system/init has arrived once (the first send boots the CLI lazily) */
  initialized: boolean
  /** when the last message was pushed and the CLI has not spoken since (the first-output watchdog) */
  sentAt: number | null
  /** armed when the task set empties while idle: settles idle unless a
   *  wake turn starts first */
  settleTimer: NodeJS.Timeout | null
  /** the last status this driver emitted was 'watching' */
  watching: boolean
}

export function newStreamState(): StreamState {
  return {
    currentMsgId: new Map(),
    toolInput: new Map(),
    working: false,
    armedAt: null,
    nudged: false,
    overflowed: false,
    compactRecoveryTried: false,
    contextTokens: 0,
    tasks: new Map(),
    known: new Map(),
    ambient: new Set(),
    foreground: new Set(),
    since: new Map(),
    touched: new Set(),
    checked: new Map(),
    sendCheck: null,
    crons: [],
    settleTimer: null,
    watching: false,
    phase: null,
    initialized: false,
    sentAt: null
  }
}

/** The phase a turn is in before its first content (events.ts `phase`): emitted only when it changes. */
export function setPhase(ctx: DriverCtx, state: StreamState, phase: StreamState['phase'], extra: { detail?: string; retry?: { attempt: number; delayMs: number; reason?: string } } = {}): void {
  if (state.phase === phase && !extra.retry) return
  state.phase = phase
  ctx.emit({ type: 'phase', phase, ...extra })
}

/** A message was pushed `FIRST_OUTPUT_MS` ago and the CLI has said nothing since. */
export const FIRST_OUTPUT_MS = 60_000
export function firstOutputOverdue(state: Pick<StreamState, 'sentAt'>, now: number): boolean {
  return state.sentAt !== null && now - state.sentAt >= FIRST_OUTPUT_MS
}

/** Whether the handle's process is still there: not recovered or ended, and
 *  the CLI not exited, killed from here or ended by a signal from outside
 *  (a SIGKILL from another process leaves `exitCode` null and sets
 *  `signalCode`). */
export function aliveOf(dead: boolean, cli: { exitCode: number | null; signalCode?: string | null; killed: boolean } | null): boolean {
  if (dead) return false
  return cli === null || (cli.exitCode === null && !cli.signalCode && !cli.killed)
}

/** How often a watching thread's forgotten tasks are checked without a turn. */
export const FORGOTTEN_CHECK_MS = 10 * 60 * 1000

/** The forgotten-task check on a timer while the thread watches: a CLI
 *  that lists dead processes for hours is asked about them without a turn
 *  of its own. Returns the stop. */
export function startForgottenTimer(ctx: DriverCtx, state: StreamState, everyMs = FORGOTTEN_CHECK_MS): () => void {
  const timer = setInterval(() => {
    if (state.watching && !state.working) checkForgottenTasks(ctx, state)
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** What the driver knows of one background task. */
export interface TaskInfo {
  description: string
  kind: BackgroundTaskKind
  command?: string
  callId?: string
}

// ── background work ───────────────────────────────────────────────────
// A thread whose turn ended with a run_in_background Bash, a Monitor, a
// CI poll or a cron still live is not done: the CLI wakes itself when the
// work lands. The driver reports that stretch as status 'watching' (the
// registry keeps the process alive through it) and settles idle only when
// the live set empties.

/** After an empty task level while idle, how long to wait for the CLI's
 *  own wake turn before settling idle (covers a task stopped by hand). */
const SETTLE_AFTER_MS = 5_000

/** A task's kind from the level's raw `task_type` (local_bash,
 *  local_agent, …) or the Stop hook's friendly `type` (shell, subagent, …). */
export function kindOf(type: string | undefined): BackgroundTaskKind {
  if (!type) return 'other'
  if (/bash|shell/i.test(type)) return 'shell'
  if (/agent/i.test(type)) return 'agent'
  if (/monitor/i.test(type)) return 'monitor'
  if (/workflow/i.test(type)) return 'workflow'
  return 'other'
}

/** Everything the thread is waiting on, structured (tasks, then crons). */
function liveItems(state: StreamState): BackgroundTask[] {
  const now = Date.now()
  const items: BackgroundTask[] = []
  for (const [id, t] of state.tasks) {
    items.push({
      id,
      label: t.description,
      kind: t.kind,
      startedAt: state.since.get(id) ?? now,
      ...(t.command ? { command: t.command } : {}),
      ...(t.callId ? { callId: t.callId } : {})
    })
  }
  for (const c of state.crons) {
    items.push({ id: c.id, label: c.label, kind: 'cron', startedAt: state.since.get(c.id) ?? now })
  }
  return items
}

/** The live set as one comparable string: what liveSetChanged re-emits on. */
function liveKey(state: StreamState): string {
  return JSON.stringify(liveItems(state))
}

function clearSettle(state: StreamState): void {
  if (state.settleTimer) clearTimeout(state.settleTimer)
  state.settleTimer = null
}

function emitWatching(ctx: DriverCtx, state: StreamState): void {
  clearSettle(state)
  state.watching = true
  ctx.emit({ type: 'status', status: 'watching' })
}

/** The turn is over: watch when work is still live, else idle. */
function settleTurn(ctx: DriverCtx, state: StreamState): void {
  if (state.tasks.size + state.crons.length > 0) {
    emitWatching(ctx, state)
  } else {
    clearSettle(state)
    state.watching = false
    ctx.emit({ type: 'status', status: 'idle' })
  }
}

/** The harness stream is over: the process died, the SDK dropped it, or it
 *  threw (`err`). A turn still open never gets its result, so it ends as an
 *  error: idle after a quiet end, error after a throw (the registry reads
 *  it as the harness crashing mid-turn, which it did). With only a watch
 *  open the tasks died with the process: the list is emptied and the
 *  registry is told the harness is gone (`harnessGone`), which settles the
 *  row by its rule (idle for a thread's own work, stopped with Resume for a
 *  master its batch keeps); a context without the callback idles here. With
 *  nothing open the registry is told too, so the dead handle is dropped and
 *  the next send boots fresh, and no row is written: the thread was between
 *  turns, and the words of a mid-turn death would be false. */
export function settleStreamEnd(ctx: DriverCtx, state: StreamState, err?: unknown): void {
  const midTurn = state.working
  const watched = state.watching
  state.working = false
  state.watching = false
  clearSettle(state)
  if (midTurn) {
    if (err === undefined) {
      ctx.emit({ type: 'error', message: 'harness stream ended mid-turn' })
      ctx.emit({ type: 'status', status: 'idle' })
    } else {
      ctx.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      ctx.emit({ type: 'status', status: 'error' })
    }
    return
  }
  if (watched) ctx.emit({ type: 'background-tasks', tasks: [], items: [] })
  if (ctx.harnessGone) ctx.harnessGone()
  else if (watched) ctx.emit({ type: 'status', status: 'idle' })
}

/** A turn the CLI started on its own (a background task or cron woke it):
 *  flip to running so the spinner, busy clock and overdue watchdog behave
 *  as for a sent turn. */
function wakeTurn(ctx: DriverCtx, state: StreamState): void {
  clearSettle(state)
  state.working = true
  state.watching = false
  ctx.emit({ type: 'status', status: 'running' })
}

/** The live set changed (task level, cron list, or what is known of a
 *  task). Publishes the new items and, while idle, moves between watching
 *  and idle. `before` is liveKey() from before the change. */
function liveSetChanged(ctx: DriverCtx, state: StreamState, before: string): void {
  const items = liveItems(state)
  if (JSON.stringify(items) !== before) {
    ctx.emit({ type: 'background-tasks', tasks: items.map((i) => i.label), items })
  }
  if (state.working) return
  if (items.length > 0) {
    if (!state.watching) emitWatching(ctx, state)
  } else if (state.watching) {
    clearSettle(state)
    state.settleTimer = setTimeout(() => {
      state.settleTimer = null
      if (state.working || !state.watching) return
      state.watching = false
      ctx.emit({ type: 'status', status: 'idle' })
    }, SETTLE_AFTER_MS)
  }
}

/** A task ended (edge message): drop it whatever the last level said. */
function retireTask(ctx: DriverCtx, state: StreamState, id: string): void {
  state.known.delete(id)
  state.since.delete(id)
  state.checked.delete(id)
  if (!state.tasks.has(id)) return
  const before = liveKey(state)
  state.tasks.delete(id)
  liveSetChanged(ctx, state, before)
}

/** Whether a task may hold the thread in 'watching'. */
function holdsThread(state: StreamState, id: string): boolean {
  return !state.ambient.has(id) && !state.foreground.has(id)
}

/** What a source says of one task; absent fields keep what was known. */
interface TaskReport {
  id: string
  description: string
  type?: string
  command?: string
}

const GENERIC_TASK = 'background task'
/** The label of a task: the model's description as written; without one,
 *  the command's first line cut to 60 characters; else the generic words. */
export function taskLabel(description: string | undefined, command: string | undefined): string {
  const given = description?.trim()
  if (given && given !== GENERIC_TASK) return given
  const line = command?.trim().split('\n')[0]?.trim()
  return line ? line.slice(0, 60) : GENERIC_TASK
}

/** Merge a report into what was known of the task. The command is the one
 *  the model wrote: the Stop hook reports it as the shell ran it, with the
 *  process guard's marks exported in front (wrapBashCommand), which are
 *  nothing a person should read. */
function learn(state: StreamState, r: { id: string } & Partial<TaskInfo> & { type?: string }): TaskInfo {
  const prev = state.known.get(r.id)
  const kind = r.type ? kindOf(r.type) : r.kind
  const raw = r.command ?? prev?.command
  const command = raw === undefined ? undefined : unwrapBashCommand(raw)
  const info: TaskInfo = {
    description: taskLabel(r.description ?? prev?.description, command),
    kind: kind && kind !== 'other' ? kind : (prev?.kind ?? kind ?? 'other'),
    ...(command ? { command } : {}),
    ...((r.callId ?? prev?.callId) ? { callId: r.callId ?? prev?.callId } : {})
  }
  state.known.set(r.id, info)
  return info
}

/** Replace the live set (level semantics) from any source. */
function replaceTasks(state: StreamState, tasks: TaskReport[]): void {
  const now = Date.now()
  state.tasks = new Map(
    tasks.filter((t) => holdsThread(state, t.id)).map((t) => [t.id, learn(state, t)])
  )
  for (const id of state.tasks.keys()) if (!state.since.has(id)) state.since.set(id, now)
}

// ── the forgotten-task check ──────────────────────────────────────────
// A background shell the model started and moved on from (a polling loop
// in a deleted worktree, a grep the tool timeout backgrounded) holds the
// thread in 'watching' for as long as the CLI lists it — and the CLI has
// listed dead processes for hours. Nobody but the model knows whether a
// task still matters, so once a task is old and a whole turn went by
// without touching it, the driver asks: one short hidden turn in which
// the model stops what it no longer needs (TaskStop → the stopped
// notification retires it here) or says it is still waiting.

/** A task younger than this is never questioned (a normal CI wait). */
const CHECK_AFTER_MS = 10 * 60 * 1000
/** A task the model kept is asked about again no sooner than this. */
const RECHECK_MS = 30 * 60 * 1000

function ago(ms: number): string {
  const min = Math.round(ms / 60_000)
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`
}

/** Called once the turn settled: question the old, untouched tasks. */
export function checkForgottenTasks(ctx: DriverCtx, state: StreamState): void {
  const touched = new Set(state.touched)
  state.touched.clear()
  if (!state.watching || !state.sendCheck) return
  const now = Date.now()
  // Session crons are tasks here too: one that fires for hours after its
  // job is done is as forgotten as a dead process.
  const live: (readonly [string, string])[] = [
    ...[...state.tasks].map(([id, t]) => [id, t.description] as const),
    // The Stop hook stores a cron as `cron:<id>` already (its clock is keyed the same way).
    ...state.crons.map((c) => [c.id, c.label] as const)
  ]
  const stale = live.filter(([id]) => {
    const last = state.checked.get(id)
    return (
      now - (state.since.get(id) ?? now) >= CHECK_AFTER_MS &&
      !touched.has(id) &&
      (last === undefined || now - last >= RECHECK_MS)
    )
  })
  if (stale.length === 0) return
  for (const [id] of stale) state.checked.set(id, now)
  clearSettle(state)
  state.working = true
  state.watching = false
  ctx.emit({ type: 'status', status: 'running', detail: 'Checking background tasks' })
  const lines = stale.map(
    ([id, description]) => `- ${id} — ${description} (started ${ago(now - (state.since.get(id) ?? now))})`
  )
  state.sendCheck(
    `<background-check>\nThese background tasks are still registered for this session, but this turn did not use them:\n${lines.join('\n')}\nFor each one: if you no longer need it, or it has already done its job, stop it now with TaskStop. If you still need it running, or are still waiting for it to report back, say so in one short line. Do nothing else and start no new work.\n</background-check>`
  )
}

/** The Stop hook lands before the result message and carries the CLI's
 *  own answer to "done, or waiting on background work": the in-flight
 *  task list and the session crons (which never appear in the task
 *  level). The task list is authoritative here — the level message has
 *  been seen to stop arriving mid-session while tasks kept coming and
 *  going, which left stale ids holding threads in 'watching' for hours.
 *  Should a CLI run the hook after the result, the transition is applied
 *  here instead. */
export function stopHookFor(
  ctx: DriverCtx,
  state: StreamState
): (input: HookInput) => Promise<HookJSONOutput> {
  return async (input) => {
    if (input.hook_event_name !== 'Stop') return { continue: true }
    const before = liveKey(state)
    if (Array.isArray(input.background_tasks)) {
      replaceTasks(
        state,
        input.background_tasks
          .filter((t) => t.status === 'running' || t.status === 'pending')
          .map((t) => ({ id: t.id, description: t.description, type: t.type, command: t.command }))
      )
    }
    const now = Date.now()
    for (const c of input.session_crons ?? []) if (c.id && !state.since.has(`cron:${c.id}`)) state.since.set(`cron:${c.id}`, Date.now())
    state.crons = (input.session_crons ?? []).map((c) => ({
      id: `cron:${c.id}`,
      label: `${c.recurring ? 'scheduled' : 'one-shot'} wake-up (${c.schedule})`
    }))
    const cronIds = new Set(state.crons.map((c) => c.id))
    for (const id of [...state.since.keys()]) if (id.startsWith('cron:') && !cronIds.has(id)) state.since.delete(id)
    for (const id of cronIds) if (!state.since.has(id)) state.since.set(id, now)
    liveSetChanged(ctx, state, before)
    return { continue: true }
  }
}

/** How often a growing tool input is re-parsed and forwarded to the UI. */
const PARTIAL_INPUT_EVERY_MS = 100

/** What the conversation occupies in the window right now: everything the
 *  API just read (prompt + cache) plus what it wrote. */
function footprintOf(usage: {
  input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  output_tokens?: number | null
}): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  )
}

export function handleMessage(ctx: DriverCtx, state: StreamState, msg: SDKMessage): void {
  const { emit } = ctx
  // A turn arriving while none is open is the CLI waking itself (a
  // background task or cron landed): init only ever arrives lazily — on
  // the first send, mid-turn, or at a self-wake.
  if (
    !state.working &&
    (msg.type === 'assistant' ||
      msg.type === 'stream_event' ||
      (msg.type === 'system' && msg.subtype === 'init'))
  ) {
    wakeTurn(ctx, state)
  }
  // Live context accounting, straight off the stream: each TOP-LANE API
  // message reports what the request occupied (subagent lanes have their
  // own windows and must not bleed in). Forwarded the moment it moves so
  // the meter never shows last turn's number during this one.
  const liveContext = (usage: Parameters<typeof footprintOf>[0]): void => {
    const tokens = footprintOf(usage)
    if (tokens > 0 && tokens !== state.contextTokens) {
      state.contextTokens = tokens
      emit({
        type: 'context',
        tokens,
        window: ctx.session.context1m ? 1_000_000 : 200_000
      })
    }
  }
  // Every message is a sign of life; only a completed tool-free assistant
  // message re-arms the overdue-result watch below.
  state.armedAt = null
  state.nudged = false
  state.sentAt = null
  ctx.mark?.('first-message')
  switch (msg.type) {
    case 'system':
      // The CLI boots lazily on the first send, so init arrives mid-turn —
      // record the native id but leave the running status alone.
      if (msg.subtype === 'init') {
        ctx.setNativeId(msg.session_id)
        ctx.mark?.('init')
        state.initialized = true
        if (state.phase === 'cli-starting' || state.phase === 'initializing') setPhase(ctx, state, null)
      } else if ((msg as { subtype: string }).subtype === 'api_retry') {
        // The CLI retries a refused request itself (a 429, a 5xx, a
        // timeout): the strip says so instead of "Thinking" for a minute.
        const r = msg as unknown as { attempt: number; max_retries?: number; retry_delay_ms: number; error_status?: number | null; error?: string }
        setPhase(ctx, state, 'retrying', {
          retry: { attempt: r.attempt, delayMs: r.retry_delay_ms, reason: r.error_status != null ? `HTTP ${r.error_status}` : 'no response' }
        })
      }
      // Compaction lifecycle: status 'compacting' opens the distinct UI,
      // the boundary closes it with the numbers, a failed result closes
      // it with the error.
      else if (msg.subtype === 'status') {
        if (msg.status === 'compacting') {
          emit({ type: 'compaction', phase: 'start' })
        } else if (msg.compact_result === 'failed') {
          emit({ type: 'compaction', phase: 'failed', error: msg.compact_error })
        }
      } else if (msg.subtype === 'compact_boundary') {
        state.compactRecoveryTried = false
        emit({
          type: 'compaction',
          phase: 'done',
          trigger: msg.compact_metadata.trigger,
          preTokens: msg.compact_metadata.pre_tokens,
          postTokens: msg.compact_metadata.post_tokens,
          durationMs: msg.compact_metadata.duration_ms
        })
        // The squeeze is the one context change with no API usage report —
        // drop the meter at the boundary instead of waiting for the next reply.
        const post = msg.compact_metadata.post_tokens
        if (post !== undefined && post > 0) {
          state.contextTokens = post
          emit({
            type: 'context',
            tokens: post,
            window: ctx.session.context1m ? 1_000_000 : 200_000
          })
        }
      } else if (msg.subtype === 'background_tasks_changed') {
        // The level signal: the whole live set, ambient housekeeping
        // excluded. Names are remembered so a later notification can be
        // labelled after the level dropped its task. Not the only source:
        // the Stop hook re-reads the set at every turn end (see
        // stopHookFor) and the edges below retire tasks one by one.
        const before = liveKey(state)
        for (const t of msg.tasks) if (t.ambient) state.ambient.add(t.task_id)
        replaceTasks(
          state,
          msg.tasks.map((t) => ({ id: t.task_id, description: t.description, type: t.task_type }))
        )
        liveSetChanged(ctx, state, before)
      } else if (msg.subtype === 'task_started') {
        if (msg.ambient) state.ambient.add(msg.task_id)
        else {
          if (msg.is_backgrounded === false) state.foreground.add(msg.task_id)
          const before = liveKey(state)
          const info = learn(state, {
            id: msg.task_id,
            description: msg.description,
            type: msg.task_type,
            callId: msg.tool_use_id
          })
          // The level usually precedes this edge: carry the call id onto the live row.
          if (state.tasks.has(msg.task_id)) {
            state.tasks.set(msg.task_id, info)
            liveSetChanged(ctx, state, before)
          }
        }
      } else if (msg.subtype === 'task_notification') {
        // One settled task — the transcript's record of why the thread
        // woke. The wake turn itself shows what the model made of it.
        if (!msg.ambient && !state.ambient.has(msg.task_id)) {
          emit({
            type: 'background-task',
            taskId: msg.task_id,
            description: state.known.get(msg.task_id)?.description ?? 'background task',
            status: msg.status
          })
        }
        retireTask(ctx, state, msg.task_id)
      } else if (msg.subtype === 'task_updated') {
        const st = msg.patch.status
        if (st === 'completed' || st === 'failed' || st === 'killed') retireTask(ctx, state, msg.task_id)
      }
      // task_progress: chatter.
      break
    case 'stream_event': {
      const ev = msg.event
      const lane = msg.parent_tool_use_id ?? ''
      const parentCallId = msg.parent_tool_use_id ?? undefined
      if (ev.type === 'message_start') {
        state.currentMsgId.set(lane, ev.message.id)
        if (!lane) liveContext(ev.message.usage)
      } else if (ev.type === 'content_block_start') {
        if (ev.content_block.type === 'tool_use') {
          ctx.mark?.('first-content')
          if (state.phase) setPhase(ctx, state, null)
          // Early visibility: the chip appears while input is still streaming.
          emit({
            type: 'tool-call',
            callId: ev.content_block.id,
            name: ev.content_block.name,
            input: undefined,
            parentCallId,
            display: toolDisplay(ev.content_block.name, undefined)
          })
          state.toolInput.set(`${lane}:${ev.index}`, {
            callId: ev.content_block.id,
            name: ev.content_block.name,
            json: '',
            lastEmit: 0
          })
        }
      } else if (ev.type === 'content_block_stop') {
        // The input is complete here — forward it without waiting for the
        // assistant message (that only lands when the whole turn's message
        // finishes, which can be long after this tool's input is done).
        const key = `${lane}:${ev.index}`
        const t = state.toolInput.get(key)
        if (t) {
          state.toolInput.delete(key)
          try {
            const input = JSON.parse(t.json.trim() || '{}')
            emit({
              type: 'tool-call',
              callId: t.callId,
              name: t.name,
              input,
              parentCallId,
              display: toolDisplay(t.name, input)
            })
          } catch {
            // Unparseable — the final assistant message will deliver it.
          }
        }
      } else if (ev.type === 'content_block_delta') {
        const msgId = state.currentMsgId.get(lane)
        const blockIndex = ev.index
        if (ev.delta.type === 'text_delta') {
          ctx.mark?.('first-content')
          if (state.phase) setPhase(ctx, state, null)
          emit({
            type: 'assistant-text',
            text: ev.delta.text,
            delta: true,
            msgId,
            blockIndex,
            parentCallId
          })
        } else if (ev.delta.type === 'thinking_delta') {
          ctx.mark?.('first-content')
          emit({
            type: 'thinking',
            text: ev.delta.thinking,
            delta: true,
            msgId,
            blockIndex,
            parentCallId
          })
        } else if (ev.delta.type === 'input_json_delta') {
          // Live tool input: re-parse the partial JSON as it grows so the
          // UI can show the file being edited and count changes in flight.
          // NOTE: in streaming-input mode the CLI delivers most of these in
          // a burst just before the block completes (verified 2.1.232; the
          // one-shot -p mode streams them live) — so today this mostly buys
          // an early file name + a running count just ahead of completion,
          // and it springs fully live if the CLI ever stops buffering.
          const t = state.toolInput.get(`${lane}:${blockIndex}`)
          if (t) {
            t.json += ev.delta.partial_json
            const now = Date.now()
            if (now - t.lastEmit >= PARTIAL_INPUT_EVERY_MS) {
              const parsed = parsePartialJson(t.json)
              if (parsed !== undefined) {
                t.lastEmit = now
                emit({
                  type: 'tool-call',
                  callId: t.callId,
                  name: t.name,
                  input: parsed,
                  partial: true,
                  parentCallId,
                  display: toolDisplay(t.name, parsed)
                })
              }
            }
          }
        }
      }
      break
    }
    case 'assistant': {
      ctx.mark?.('first-content')
      if (state.phase) setPhase(ctx, state, null)
      // Synthetic messages are the CLI dressing an API refusal up as
      // assistant text. Report them as the errors they are — rendering
      // "Prompt is too long" as if the model said it confused everyone.
      if (msg.message.model === '<synthetic>') {
        const text = msg.message.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join(' ')
          .trim()
        if (/prompt is too long/i.test(text)) {
          state.overflowed = true
          emit({
            type: 'error',
            message: 'the conversation outgrew its context window — compacting to make room'
          })
        } else if (text) {
          emit({ type: 'error', message: text, ...limitField('claude', text) })
        }
        break
      }
      const parentCallId = msg.parent_tool_use_id ?? undefined
      if (!parentCallId) liveContext(msg.message.usage)
      const msgId = msg.message.id
      msg.message.content.forEach((block, blockIndex) => {
        if (block.type === 'text') {
          emit({
            type: 'assistant-text',
            text: block.text,
            delta: false,
            msgId,
            blockIndex,
            parentCallId
          })
        } else if (block.type === 'thinking') {
          emit({
            type: 'thinking',
            text: block.thinking,
            delta: false,
            msgId,
            blockIndex,
            parentCallId
          })
        } else if (block.type === 'tool_use') {
          emit({
            type: 'tool-call',
            callId: block.id,
            name: block.name,
            input: block.input,
            parentCallId,
            display: toolDisplay(block.name, block.input)
          })
          // A tool input naming a live task (TaskOutput, TaskStop, a Read
          // of tasks/<id>.output) is the model still using it.
          if (state.tasks.size > 0) {
            const json = JSON.stringify(block.input)
            for (const id of state.tasks.keys()) if (json.includes(id)) state.touched.add(id)
          }
        }
      })
      // A top-lane assistant message with no tool calls is the turn's last
      // word — nothing follows but the result. Start the overdue clock.
      if (!parentCallId && !msg.message.content.some((b) => b.type === 'tool_use')) {
        state.armedAt = Date.now()
      }
      break
    }
    case 'user': {
      // Carries tool results the harness fed back to the model.
      const parentCallId = msg.parent_tool_use_id ?? undefined
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (typeof block === 'object' && block.type === 'tool_result') {
            const text =
              typeof block.content === 'string'
                ? block.content
                : (block.content ?? [])
                    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
                    .join('\n')
            emit({
              type: 'tool-result',
              callId: block.tool_use_id,
              output: text,
              isError: block.is_error ?? false,
              parentCallId
            })
          }
        }
      }
      break
    }
    case 'result':
      state.toolInput.clear()
      state.working = false
      if (msg.subtype === 'success') {
        emit({
          type: 'turn-complete',
          costUsd: msg.total_cost_usd,
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens
        })
      } else {
        // Includes interrupts and the CLI's own limits: the session stays
        // usable, so this is an error event but an idle status. The CLI's
        // first error line rides along, so the host's verdict can name the
        // cause (failureKind.ts: a death keeps its own kind, a stop is
        // stamped by the registry and never classified).
        const line = msg.errors?.find((e) => e.trim())?.split('\n')[0]?.trim()
        emit({ type: 'error', message: line ? `turn ended: ${msg.subtype}: ${line}` : `turn ended: ${msg.subtype}` })
      }
      settleTurn(ctx, state)
      checkForgottenTasks(ctx, state)
      break
  }
}

/**
 * Goal observation — tails the CLI's session transcript JSONL.
 *
 * The CLI never forwards its active_goal state over the SDK stream in
 * normal mode (emission is gated on CLAUDE_CODE_REMOTE, which changes far
 * too much else to be usable). What it does do — and itself relies on for
 * resume — is record every goal transition as an `attachment` entry of
 * type `goal_status` in ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl.
 * Shapes verified live (scripts/probe-goal-claude.ts):
 *   set      {met:false, sentinel:true, condition}
 *   check    {met:false, condition, reason}         — mid-turn, hook not passed
 *   met      {met:true,  condition, reason, iterations, durationMs, tokens}
 *   cleared  {met:true,  sentinel:true, condition}
 *   failed   {met:false, failed:true, condition, reason, ...} — judged
 *            impossible; the CLI removes the goal
 * Polled every 2 s (GOAL_POLL_MS) with a byte offset so each entry is read
 * once, through fs.promises, one look at a time, and skipped while the
 * loop is busy: the next look reads what this one would have.
 */
export interface GoalWatch {
  /** (Re)attach to the transcript once the native session id is known. */
  arm: (sessionId: string) => void
  close: () => void
}

/** The CLI's answer to a resume id its transcript store does not hold: the
 *  thread's history moved here from another machine (the Mac → box move
 *  carried the database, not ~/.claude/projects), or the store was purged.
 *  It arrives as the error result's `errors` text and again as the SDK's
 *  thrown "Claude Code returned an error result: …" when the process exits. */
export const LOST_NATIVE_SESSION = /No conversation found with session ID/i

/** How much transcript tail to scan when attaching to a resumed session. */
const GOAL_TAIL_BYTES = 256 * 1024
/** How often a live thread's transcript is looked at. */
export const GOAL_POLL_MS = 2_000
/** A loop this busy (the last second's mean delay) skips a look. */
export const GOAL_SKIP_LAG_MS = 50

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

export function goalWatcher(
  ctx: Pick<DriverCtx, 'emit' | 'session'>,
  opts: { root?: string; everyMs?: number } = {}
): GoalWatch {
  const { emit } = ctx
  // A resumed session's history is already folded into SessionMeta — seed
  // from it and only surface entries written after this driver started
  // (fresh sessions read from byte 0 to catch the first set sentinel).
  const resumedId = ctx.session.nativeId
  const armedAt = Date.now()
  let active: string | null = ctx.session.goal?.condition ?? null
  let iterations = ctx.session.goal?.iterations ?? 0
  let watching: string | null = null
  let file: string | null = null
  let offset = 0
  let partial = ''
  let timer: NodeJS.Timeout | null = null
  /** The session id `file` belongs to, and whether a look is in flight. */
  let attachedTo: string | null = null
  let looking = false
  let closed = false

  const translate = (a: {
    met?: boolean
    sentinel?: boolean
    failed?: boolean
    condition?: string
    reason?: string
    iterations?: number
  }): void => {
    const condition = typeof a.condition === 'string' ? a.condition : (active ?? '')
    if (a.sentinel) {
      if (a.met) {
        // `/goal clear` — the hook was removed without the condition passing.
        emit({ type: 'goal', phase: 'cleared', condition })
        active = null
      } else {
        emit({ type: 'goal', phase: active ? 'updated' : 'set', condition })
        active = condition
      }
      iterations = 0
    } else if (a.met) {
      emit({
        type: 'goal',
        phase: 'met',
        condition,
        iterations: a.iterations ?? iterations,
        reason: a.reason
      })
      active = null
      iterations = 0
    } else if (a.failed) {
      emit({
        type: 'goal',
        phase: 'cleared',
        condition,
        iterations: a.iterations ?? iterations,
        reason: a.reason
      })
      active = null
      iterations = 0
    } else {
      // A check that didn't pass — the turn continues. These entries carry
      // no running count, so it's kept here.
      iterations += 1
      emit({ type: 'goal', phase: 'updated', condition, iterations, reason: a.reason })
    }
  }

  const drain = async (): Promise<void> => {
    if (!file) return
    let chunk: string
    let size: number
    try {
      size = (await stat(file)).size
      if (size <= offset) return
      const handle = await open(file, 'r')
      try {
        const buf = Buffer.alloc(size - offset)
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
        chunk = buf.toString('utf8', 0, bytesRead)
        size = offset + bytesRead
      } finally {
        await handle.close()
      }
    } catch {
      return
    }
    // Closed while the read was out: the thread's harness is gone.
    if (closed) return
    offset = size
    partial += chunk
    const lines = partial.split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.includes('"goal_status"')) continue
      try {
        const entry = JSON.parse(line) as {
          type?: string
          timestamp?: string
          attachment?: {
            type?: string
            met?: boolean
            sentinel?: boolean
            failed?: boolean
            condition?: string
            reason?: string
            iterations?: number
          }
        }
        if (entry.type !== 'attachment' || entry.attachment?.type !== 'goal_status') continue
        // On resume, tail-scanned history predates this driver — the fold
        // already carries it; re-emitting would duplicate rows.
        if (resumedId && entry.timestamp && Date.parse(entry.timestamp) < armedAt) continue
        translate(entry.attachment)
      } catch {
        // torn write or the tail-scan's partial first line — skip
      }
    }
  }

  const locate = async (sessionId: string): Promise<string | null> => {
    const root = opts.root ?? join(homedir(), '.claude', 'projects')
    // The CLI's project-dir slug rule, read out of the 2.1.233 binary.
    const slug = ctx.session.cwd.replace(/[^a-zA-Z0-9-_]/g, '-')
    const direct = join(root, slug, `${sessionId}.jsonl`)
    if (await exists(direct)) return direct
    // Survive slug-rule drift: the session id is globally unique.
    try {
      for (const name of await readdir(root)) {
        const p = join(root, name, `${sessionId}.jsonl`)
        if (await exists(p)) return p
      }
    } catch {
      // projects dir missing — nothing to tail yet
    }
    return null
  }

  const attach = async (): Promise<void> => {
    const id = watching
    if (!id) return
    const found = await locate(id)
    if (!found || watching !== id) return
    let start = 0
    if (id === resumedId) {
      // Skip deep history but keep the recent tail in view — a goal set in
      // the moments between resume and attach still lands (the timestamp
      // filter in drain() drops anything older than this driver).
      try {
        start = Math.max(0, (await stat(found)).size - GOAL_TAIL_BYTES)
      } catch {
        start = 0
      }
    }
    if (watching !== id) return
    file = found
    attachedTo = id
    partial = ''
    offset = start
  }

  const look = async (): Promise<void> => {
    if (!watching) return
    if (attachedTo !== watching) await attach()
    if (attachedTo === watching) await drain()
  }

  /** One look at a time, none while the loop is busy. */
  const tick = (): void => {
    if (looking || currentLag().meanMs >= GOAL_SKIP_LAG_MS) return
    looking = true
    void look().finally(() => {
      looking = false
    })
  }

  return {
    arm(sessionId: string): void {
      if (watching === sessionId) return
      watching = sessionId
      tick()
      timer ??= setInterval(tick, opts.everyMs ?? GOAL_POLL_MS)
    },
    close(): void {
      closed = true
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}

const PERMISSION_MODE: Record<PermissionPolicy, PermissionMode> = {
  safe: 'default',
  edits: 'acceptEdits',
  auto: 'bypassPermissions'
}

/** Unanswered approvals deny themselves after this long. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** Web tools the session may use without a prompt. Under Auto-edits the
 *  web is read-only research, so it runs free like an edit (a child's
 *  unanswered prompt otherwise denies itself and stalls the research);
 *  Safe keeps asking, Full access never asked. */
export function permittedWebTools(permission: PermissionPolicy): string[] {
  return permission === 'edits' ? ['WebSearch', 'WebFetch'] : []
}

export const claudeDriver: HarnessDriver = {
  id: 'claude',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx
    const input = new InputQueue()
    const state = newStreamState()
    state.sendCheck = (text) => {
      if (!dead && !disposed) input.push(text)
    }
    const pendingApprovals = new Map<string, (allow: boolean, auto?: boolean) => void>()
    const pendingQuestions = new Map<string, (answers: string[][] | null) => void>()

    // AskUserQuestion is a question, not a permission — it must reach the
    // user in EVERY permission mode. canUseTool is skipped entirely under
    // bypassPermissions, so this rides a PreToolUse hook instead (hooks
    // always fire) and hands the answers back via updatedInput.answers
    // (question text → chosen label; multi-select comma-joined), the shape
    // the harness's own permission component uses.
    const askUserQuestionHook = async (
      hookInput: unknown,
      toolUseID: string | undefined,
      { signal }: { signal: AbortSignal }
    ): Promise<HookJSONOutput> => {
      const toolInput = (hookInput as { tool_input?: unknown }).tool_input as {
        questions?: {
          question?: string
          header?: string
          multiSelect?: boolean
          options?: { label?: string; description?: string }[]
        }[]
      } | null
      const questions = (toolInput?.questions ?? []).flatMap((q) =>
        q.question
          ? [
              {
                question: q.question,
                header: q.header,
                multiSelect: q.multiSelect === true,
                allowFreeform: true,
                options: (q.options ?? []).flatMap((o) =>
                  o.label ? [{ label: o.label, description: o.description }] : []
                )
              }
            ]
          : []
      )
      if (questions.length === 0) return { continue: true }

      const requestId = `q-${toolUseID ?? Math.random().toString(36).slice(2)}`
      emit({ type: 'question-request', requestId, questions, callId: toolUseID })
      emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
      const answers = await new Promise<string[][] | null>((resolve) => {
        const finish = (a: string[][] | null): void => {
          if (pendingQuestions.delete(requestId)) resolve(a)
        }
        pendingQuestions.set(requestId, finish)
        signal.addEventListener('abort', () => finish(null), { once: true })
      })
      emit({ type: 'question-resolved', requestId, answers })
      emit({ type: 'status', status: 'running' })

      if (!answers) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'The user dismissed the question — continue with your best judgment.'
          }
        }
      }
      const answersMap: Record<string, string> = {}
      questions.forEach((q, i) => {
        const chosen = answers[i] ?? []
        if (chosen.length) answersMap[q.question] = chosen.join(', ')
      })
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...(toolInput ?? {}), answers: answersMap }
        }
      }
    }

    // Every Bash call of a thread in full access runs marked for the host's
    // process guard (processGuard.ts): the thread and the call exported into
    // the call's shell, so the host can end its processes when the call
    // ends, sweep its orphans and cap its memory. A PreToolUse hook with
    // updatedInput and no decision: the permission flow runs on the marked
    // command as it would have on the plain one. A prompting thread's rules
    // match the command as written, so it carries no call mark.
    const guardHook = async (hookInput: unknown, toolUseID: string | undefined): Promise<HookJSONOutput> => {
      const input = (hookInput as { tool_input?: unknown }).tool_input
      if (!toolUseID || !input || typeof input !== 'object') return { continue: true }
      const command = (input as { command?: unknown }).command
      if (typeof command !== 'string' || !command) return { continue: true }
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { ...(input as Record<string, unknown>), command: wrapBashCommand(command, toolUseID, session.id) }
        }
      }
    }
    /** A Bash call's input as the model wrote it: the approval card never shows the guard's marks. */
    const shownInput = (toolName: string, input: unknown): unknown => {
      if (toolName !== 'Bash' || !input || typeof input !== 'object') return input
      const o = input as Record<string, unknown>
      return typeof o.command === 'string' ? { ...o, command: unwrapBashCommand(o.command) } : input
    }

    // The undo baseline is taken off the send path (sessions.ts
    // armBaseline), so the first tool that can write waits for it here:
    // the snapshot must never freeze the agent's own edit as "before". A
    // PreToolUse hook, not canUseTool, because hooks fire in every
    // permission mode. Resolves at once when nothing is in flight.
    const baselineHook = async (): Promise<HookJSONOutput> => {
      await ctx.awaitBaseline?.().catch(() => undefined)
      return { continue: true }
    }

    // A shell call that opened a dev server: the host forwards it to the Mac
    // and the result's tail names the Mac's URL (threadPorts.ts, portTail.ts).
    const bashTailHook = async (hookInput: unknown): Promise<HookJSONOutput> => {
      const i = hookInput as { tool_use_id?: string; tool_response?: unknown }
      if (!ctx.toolResultTail || !i.tool_use_id) return { continue: true }
      const r = i.tool_response
      const output = typeof r === 'string' ? r : r && typeof r === 'object' ? [(r as { stdout?: unknown }).stdout, (r as { stderr?: unknown }).stderr].filter((x) => typeof x === 'string').join('\n') : ''
      const tail = await ctx.toolResultTail(i.tool_use_id, output).catch(() => null)
      return tail ? { continue: true, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: tail } } : { continue: true }
    }

    // Approval flow (docs/PLAN.md M4): the harness asks, we emit an
    // approval-request event, the user answers through session.approve.
    const canUseTool: CanUseTool = (toolName, toolInput, opts) => {
      // Questions are handled by the PreToolUse hook above; if the
      // permission system still asks, wave it through — never render a
      // question as an Allow/Deny card.
      if (toolName === 'AskUserQuestion') return Promise.resolve({ behavior: 'allow' })
      const { requestId } = opts
      emit({
        type: 'approval-request',
        requestId,
        toolName,
        input: shownInput(toolName, toolInput),
        title: opts.title,
        callId: opts.toolUseID
      })
      emit({ type: 'status', status: 'waiting', detail: 'awaiting approval' })
      return new Promise((resolve) => {
        const finish = (allow: boolean, auto = false): void => {
          if (!pendingApprovals.delete(requestId)) return
          clearTimeout(timer)
          emit({ type: 'approval-resolved', requestId, allow, auto })
          emit({ type: 'status', status: 'running' })
          resolve(
            allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied in temp-code' }
          )
        }
        const timer = setTimeout(() => finish(false, true), APPROVAL_TIMEOUT_MS)
        pendingApprovals.set(requestId, finish)
        opts.signal.addEventListener('abort', () => finish(false, true), { once: true })
      })
    }

    // Lets the watchdog put a wedged CLI down for real — closing the input
    // iterable alone won't end a process that stopped listening.
    const abort = new AbortController()

    // Goal state lives in the CLI's transcript file, not the SDK stream —
    // arm the tail as soon as init reveals the session id.
    const goalWatch = goalWatcher(ctx)
    const watchedCtx: DriverCtx = {
      ...ctx,
      setNativeId: (id) => {
        ctx.setNativeId(id)
        goalWatch.arm(id)
      }
    }

    // The SDK's bundled CLI is pinned at build time, and the API rejects
    // CLIs too old for newly launched models. When a standalone `claude`
    // install is newer, spawn that one instead (Settings → provider row
    // updates it in place); the bundled CLI stays the fallback.
    const claudeCli = await resolveClaude()
    // Provider traffic goes through Aliax's shim or our own gateway, which
    // swap in this thread's account's token and read the limit headers.
    const { url: endpoint } = await routedEndpointFor('claude', { thread: session.id, route: ctx.route ?? null, model: session.model })

    const writeRoots = researchWriteRoots(session)
    const webTools = permittedWebTools(session.permission)
    // A project's master thread (CLAUDE.md "Master threads") steers its
    // batch and never edits code itself, whatever the conduct rules say.
    const master = isMasterSession(session)
    const options: Options = {
      abortController: abort,
      ...(claudeCli.path ? { pathToClaudeCodeExecutable: claudeCli.path } : {}),
      // CLI ≥ 2.1.25x hides TodoWrite/TaskCreate/TaskUpdate on Opus ≥ 4.8,
      // Sonnet ≥ 5 and Fable ≥ 5 (a growthbook-gated experiment, off by
      // default). The task board, tab tallies and the orchestrator's
      // supervision all fold those tool calls, so a thread without them is
      // invisible — the CLI's own env override switches them back on.
      env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', ...(endpoint ? { ANTHROPIC_BASE_URL: endpoint } : {}) },
      // 1M rides the CLI's `[1m]` model suffix — the same lever as Claude
      // Code's own 1M picker: it sets the client-side window to 1M and the
      // CLI adds the API-side signaling itself. The `betas` Option is a
      // trap here: the CLI drops user-supplied betas on subscription auth
      // ("API key users only"), so a beta-based request silently fell back
      // to a 200k window and overflowed at ~180k.
      model: session.context1m ? `${session.model}[1m]` : session.model,
      cwd: session.cwd,
      // The SDK ladder tops out at max; 'ultra' is codex-only (a session
      // switched off sol mid-ultra clamps rather than erroring).
      effort: session.reasoning === 'ultra' ? 'max' : session.reasoning,
      includePartialMessages: true,
      permissionMode: PERMISSION_MODE[session.permission],
      ...(session.permission === 'auto' ? { allowDangerouslySkipPermissions: true } : {}),
      // A research tree in a worktree project writes its report and angle
      // files at the workspace root, outside this cwd.
      ...(writeRoots.length ? { additionalDirectories: writeRoots } : {}),
      canUseTool,
      hooks: {
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: [askUserQuestionHook] },
          { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [baselineHook] },
          ...(session.permission === 'auto' ? [{ matcher: 'Bash', hooks: [guardHook] }] : [])
        ],
        PostToolUse: [{ matcher: 'Bash', hooks: [bashTailHook] }],
        // Session crons only surface here (see stopHookFor).
        Stop: [{ hooks: [stopHookFor(watchedCtx, state)] }]
      },
      // Claude settings keys (not Options) ride a per-session --settings
      // override: fast mode, and the context mode — Standard keeps the
      // thread under 200k via the CLI's own auto-compact (also dodging the
      // 2x long-context pricing above 200k input); 1M turns auto-compact
      // off and rides the full native window.
      //
      // The compact window is 190k, NOT 200k: the CLI arms compaction at
      // window − 33k, and without the 1M beta the API hard-rejects a
      // request at 200k − max_tokens (≈168k) with "Prompt is too long".
      // A 200k setting put the compact trigger (167k) a hair under the
      // rejection wall — one long turn sailed past both and bricked the
      // thread. 190k arms compaction at ~157k, 11k under the wall: a turn
      // that grows past that gets one visible overflow error and the
      // driver's own /compact recovery, not a bricked thread. It was 180k
      // (trigger 147k); the extra 10k is ~7% fewer compactions, each one
      // a ~150k summarization pass plus a full cache rewrite.
      extraArgs: {
        settings: JSON.stringify({
          ...(claudeFastFor(session, session.model) ? { fastMode: true } : {}),
          autoCompactEnabled: !session.context1m,
          ...(session.context1m ? {} : { autoCompactWindow: AUTO_COMPACT_WINDOW })
        })
      },
      ...(session.nativeId ? { resume: session.nativeId } : {}),
      // App tools (docs/PLAN-2.md M10): every claude session can list/read
      // sibling threads and start new ones. Orchestrators additionally get
      // the spawn/supervise toolset (docs/PLAN.md M6) + router rubric.
      ...(session.agentType === 'orchestrator'
        ? (() => {
            // The user's conduct rules are enforced, not suggested: an
            // orchestrator that may not edit or shell simply loses those
            // tools. (Prompt text explains the denial to the model.)
            const conduct = rulesFor(session).conduct
            const denied = [
              // Native subagent lanes are invisible — the fleet is the only
              // sanctioned way to run subagents. The SDK renamed the tool
              // Task → Agent in the Fable-era CLI; deny both spellings.
              'Task',
              'Agent',
              ...(conduct.selfEdit && !master ? [] : EDIT_TOOLS),
              ...(conduct.selfShell ? [] : ['Bash'])
            ]
            return {
              mcpServers: {
                orchestrator: orchestratorMcp(session),
                app: appToolsMcp(session)
              },
              allowedTools: [...ORCHESTRATOR_TOOLS, ...APP_TOOLS, ...webTools],
              disallowedTools: denied,
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: orchestratorPrompt(session)
              }
            }
          })()
        : session.threadType === 'implementation' ||
            session.threadType === 'chat' ||
            session.threadType === 'planning' ||
            session.threadType === 'project-plan' ||
            session.threadType === 'research'
          ? {
              // Implementation, chat, planning AND research threads spawn
              // subagents through the same toolset — never by shelling out
              // to another model's CLI, and never invisibly through the
              // built-in Task tool. Every delegation grows the fleet panel.
              mcpServers: {
                orchestrator: orchestratorMcp(session),
                app: appToolsMcp(session)
              },
              allowedTools: [...ORCHESTRATOR_TOOLS, ...APP_TOOLS, ...webTools],
              // Native subagent lanes are invisible to the user — the whole
              // point of spawn_agent is a visible, steerable session. The
              // tool is Task in older CLIs, Agent in the Fable era. A
              // project's master never edits code itself: its batch does.
              disallowedTools: ['Task', 'Agent', ...(master ? EDIT_TOOLS : [])],
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append:
                  session.threadType === 'chat'
                    ? chatSpawnPrompt(session)
                    : session.threadType === 'planning'
                      ? planningSpawnPrompt(session)
                      : session.threadType === 'project-plan'
                        ? projectPlanSpawnPrompt(session)
                        : session.threadType === 'research'
                        ? researchSpawnPrompt(session)
                        : implementerSpawnPrompt(session)
              }
            }
          : {
              mcpServers: { app: appToolsMcp(session) },
              allowedTools: [...APP_TOOLS, ...webTools]
            })
    }

    // The Mac bridge's tools, when this thread (or its parent) may reach a Mac (macTools.ts).
    withMacTools(options, session)
    // Every CLI spawn goes through the warm pool (claudeWarm.ts): a fresh
    // thread whose traffic our own gateway routes (the owner's, or no shim)
    // adopts the warm process of the SDK's exact spec when one waits, and
    // its cold spawn is otherwise the shape to keep warm. A resumed thread
    // (`--resume` in its argv) and a thread the shim routes elsewhere spawn
    // cold and warm nothing.
    const gw = gateway()
    // The CLI process behind this handle, for its pid (admission.ts samples its RSS).
    let cli: ChildProcess | null = null
    const own = gw?.url('claude')
    const warmable = !session.nativeId && !!gw && !!endpoint && !!own && (gw.status().owner || endpoint.startsWith(own))
    options.spawnClaudeCodeProcess = (spawnOpts) => {
      const spawned = spawnOrAdoptClaude(
        { command: spawnOpts.command, args: spawnOpts.args, cwd: spawnOpts.cwd, env: spawnOpts.env },
        (spawnOpts as { signal?: AbortSignal }).signal,
        { thread: session.id, scope: ctx.route ? { thread: session.id, ...ctx.route, model: session.model } : null, warmable }
      )
      cli = spawned.proc
      // The send's phase line says whether the process was adopted warm or spawned cold.
      ctx.mark?.('handle', spawned.warmId ? 'warm' : 'cold')
      if (!spawned.warmId) setPhase(ctx, state, 'cli-starting')
      return cli as unknown as SpawnedProcess
    }
    const q = query({ prompt: input, options })

    // Overdue-result watchdog. The CLI has been seen going silent AFTER the
    // reply fully streamed — result never sent, process alive at 0% CPU
    // (both observed wedges carried oversized image attachments). Once the
    // final tool-free assistant message lands, the result is due within
    // moments: after 45s of silence, nudge the CLI's stdin with a benign
    // control request (that has shaken a queued result loose before); after
    // 90s, settle the thread ourselves and put the process down — the next
    // send resumes the conversation in a fresh one.
    const NUDGE_AFTER_MS = 45_000
    const RECOVER_AFTER_MS = 90_000
    const watchdog = setInterval(() => {
      if (disposed) return
      // A message pushed with nothing back at all for FIRST_OUTPUT_MS: the
      // CLI took the text and went silent. Settle, put the process down;
      // the registry re-queues the message once into a fresh harness.
      if (firstOutputOverdue(state, Date.now())) {
        state.working = false
        state.watching = false
        state.sentAt = null
        state.armedAt = null
        emit({ type: 'error', message: FIRST_OUTPUT_SILENCE })
        emit({ type: 'status', status: 'idle' })
        abort.abort()
        return
      }
      if (!state.working || state.armedAt === null) return
      const quiet = Date.now() - state.armedAt
      if (quiet >= RECOVER_AFTER_MS) {
        state.working = false
        state.watching = false
        state.armedAt = null
        emit({ type: 'error', message: 'the harness never reported the turn done — recovered' })
        emit({ type: 'status', status: 'idle' })
        abort.abort()
      } else if (quiet >= NUDGE_AFTER_MS && !state.nudged) {
        state.nudged = true
        void q.getContextUsage().catch(() => {})
      }
    }, 5_000)

    // While the thread watches, its forgotten tasks are checked on a timer,
    // not only at a turn's end.
    const stopForgotten = startForgottenTimer(watchedCtx, state)

    // A recovered or ended harness can't take another message — send()
    // reports it so the registry boots a fresh process (resume carries the
    // conversation over).
    let dead = false
    abort.signal.addEventListener('abort', () => {
      dead = true
    })

    // Set by dispose(): the registry has moved on (continue-run boots a
    // replacement handle). The dying process's stream still winds down
    // after that — anything it emits now would land AFTER the new
    // handle's 'running' and flip the session back to error/idle while
    // the resumed turn is streaming. A disposed handle stays mute.
    let disposed = false

    // The resume id names a transcript this host does not have. Tell the
    // registry: it forgets the id and reboots fresh with the thread's own
    // transcript as context once this turn has settled. Once per handle.
    let nativeLost = false
    const markNativeLost = (): void => {
      if (nativeLost || !session.nativeId) return
      nativeLost = true
      emit({
        type: 'error',
        message: `this host has no transcript for the thread's native session ${session.nativeId}; a fresh one starts with the thread's own history as context`
      })
      ctx.nativeSessionLost?.()
    }

    // Drain the harness stream for the life of the session.
    void (async () => {
      try {
        for await (const msg of q) {
          if (disposed) continue
          handleMessage(watchedCtx, state, msg)
          if (msg.type === 'system' && msg.subtype === 'init') noteClaudeInit(q)
          if (
            msg.type === 'result' &&
            msg.subtype === 'error_during_execution' &&
            msg.errors?.some((text) => LOST_NATIVE_SESSION.test(text))
          ) {
            markNativeLost()
          }
          // Overflow self-heal: the API refused the transcript ("Prompt is
          // too long" — seen when a Standard-mode thread outruns compaction
          // in a single turn). Once the turn settles, compact in place so
          // the next send fits. One try per overflow; without it the CLI's
          // context estimate stays poisoned by the zero-usage synthetic
          // message and the thread is bricked for good.
          if (state.overflowed && !state.working) {
            state.overflowed = false
            if (!state.compactRecoveryTried) {
              state.compactRecoveryTried = true
              state.working = true
              emit({ type: 'status', status: 'running' })
              input.push('/compact')
            }
          }
        }
        // Stream over without a dispose: the process died, or the SDK
        // dropped it. A turn still open shows "working" for ever unless it
        // is settled here; a watch's tasks died with the process; the
        // registry hears the harness is gone either way (settleStreamEnd).
        // `dead` first: the registry reads alive() to tell this handle from
        // a replacement, and finally has not run yet.
        if (!disposed) {
          dead = true
          settleStreamEnd(watchedCtx, state)
        }
      } catch (err) {
        // A watchdog abort already settled the status — swallow its throw.
        if (disposed || abort.signal.aborted) return
        dead = true
        // emit persists to SQLite; if THAT is what threw (a locked
        // database), a bare retry here would kill the drain loop entirely
        // and freeze the thread on "Working…" with nothing logged.
        try {
          settleStreamEnd(watchedCtx, state, err)
          if (err instanceof Error && LOST_NATIVE_SESSION.test(err.message)) markNativeLost()
        } catch {
          setTimeout(() => {
            try {
              emit({ type: 'status', status: 'error' })
            } catch {
              // the log has bigger problems; the boot reset will settle it
            }
          }, 5_000)
        }
      } finally {
        dead = true
        clearInterval(watchdog)
        stopForgotten()
        goalWatch.close()
      }
    })()

    return {
      async send(text: string, attachments?: Attachment[]): Promise<void> {
        if (dead) throw new Error('harness gone')
        state.working = true
        emit({ type: 'status', status: 'running' })
        // The harness only runs a LEADING /command natively; mid-message
        // and additional skill references get expanded server-side.
        input.push(await expandSlashRefs('claude', session.cwd, text), attachments)
        state.sentAt = Date.now()
        // Until the CLI's init has come once, the wait is its boot.
        if (!state.initialized && state.phase !== 'cli-starting') setPhase(ctx, state, 'initializing')
      },
      interrupt(): void {
        void q.interrupt()
      },
      async stopTask(taskId: string): Promise<void> {
        if (dead) throw new Error('harness gone')
        // The CLI's stopped notification retires the task (retireTask).
        await q.stopTask(taskId)
      },
      approve(requestId: string, allow: boolean): boolean {
        const finish = pendingApprovals.get(requestId)
        finish?.(allow)
        return !!finish
      },
      answer(requestId: string, answers: string[][] | null): boolean {
        const finish = pendingQuestions.get(requestId)
        finish?.(answers)
        return !!finish
      },
      async setGoal(condition: string): Promise<void> {
        if (dead) throw new Error('harness gone')
        // `/goal` runs as a full turn — the CLI injects a start-working
        // prompt and the model begins immediately. Confirmation lands in
        // the transcript as a goal_status entry, never here.
        state.working = true
        emit({ type: 'status', status: 'running' })
        input.push(`/goal ${condition.replace(/\s+/g, ' ').trim()}`)
      },
      async clearGoal(): Promise<void> {
        if (dead) throw new Error('harness gone')
        state.working = true
        emit({ type: 'status', status: 'running' })
        input.push('/goal clear')
      },
      async compact(): Promise<void> {
        if (dead) throw new Error('harness gone')
        // `/compact` runs as a turn of its own: compaction events mark its
        // start and end, and the result message settles the status.
        state.working = true
        emit({ type: 'status', status: 'running' })
        input.push('/compact')
      },
      async contextUsage(): Promise<unknown> {
        // The /context breakdown, straight from the harness — except the
        // window size, which reflects the SESSION'S MODE, not the SDK's
        // stale model table: Standard auto-compacts near 200k, 1M rides
        // the full native window. Trigger, meter, and driver all answer
        // from the same session field.
        const usage = (await q.getContextUsage()) as {
          totalTokens: number
          maxTokens: number
          percentage: number
        }
        const target = session.context1m ? 1_000_000 : 200_000
        if (usage.maxTokens !== target) {
          usage.maxTokens = target
          usage.percentage = (usage.totalTokens / target) * 100
        }
        return usage
      },
      alive(): boolean {
        return aliveOf(dead, cli)
      },
      pid(): number | null {
        return cli && cli.exitCode === null && !cli.killed ? (cli.pid ?? null) : null
      },
      async dispose(): Promise<void> {
        disposed = true
        clearSettle(state)
        for (const finish of [...pendingApprovals.values()]) finish(false, true)
        for (const finish of [...pendingQuestions.values()]) finish(null)
        input.close()
      }
    }
  }
}
