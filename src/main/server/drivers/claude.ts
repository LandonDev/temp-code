import {
  query,
  type CanUseTool,
  type HookJSONOutput,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import type { Attachment, PermissionPolicy } from '@shared/events'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import { parsePartialJson } from './partial-json'
import { toolDisplay } from './display'
import {
  chatSpawnPrompt,
  implementerSpawnPrompt,
  planningSpawnPrompt,
  ORCHESTRATOR_TOOLS,
  orchestratorMcp,
  orchestratorPrompt,
  rulesFor
} from '../orchestration'
import { APP_TOOLS, appToolsMcp } from '../apptools'
import { expandSlashRefs } from '../slash'

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

function handleMessage(ctx: DriverCtx, state: StreamState, msg: SDKMessage): void {
  const { emit } = ctx
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
  switch (msg.type) {
    case 'system':
      // The CLI boots lazily on the first send, so init arrives mid-turn —
      // record the native id but leave the running status alone.
      if (msg.subtype === 'init') ctx.setNativeId(msg.session_id)
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
      }
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
          emit({
            type: 'assistant-text',
            text: ev.delta.text,
            delta: true,
            msgId,
            blockIndex,
            parentCallId
          })
        } else if (ev.delta.type === 'thinking_delta') {
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
          emit({ type: 'error', message: text })
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
        // Includes interrupts and max-turn stops — the session stays usable,
        // so this is an error event but an idle status.
        emit({ type: 'error', message: `turn ended: ${msg.subtype}` })
      }
      emit({ type: 'status', status: 'idle' })
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
 * Polled at 1s with a byte offset so each entry is read once.
 */
interface GoalWatch {
  /** (Re)attach to the transcript once the native session id is known. */
  arm: (sessionId: string) => void
  close: () => void
}

/** How much transcript tail to scan when attaching to a resumed session. */
const GOAL_TAIL_BYTES = 256 * 1024

function goalWatcher(ctx: DriverCtx): GoalWatch {
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

  const drain = (): void => {
    if (!file) return
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (size <= offset) return
    let chunk: string
    try {
      const fd = openSync(file, 'r')
      try {
        const buf = Buffer.alloc(size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        chunk = buf.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return
    }
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

  const locate = (sessionId: string): string | null => {
    const root = join(homedir(), '.claude', 'projects')
    // The CLI's project-dir slug rule, read out of the 2.1.233 binary.
    const slug = ctx.session.cwd.replace(/[^a-zA-Z0-9-_]/g, '-')
    const direct = join(root, slug, `${sessionId}.jsonl`)
    if (existsSync(direct)) return direct
    // Survive slug-rule drift: the session id is globally unique.
    try {
      for (const name of readdirSync(root)) {
        const p = join(root, name, `${sessionId}.jsonl`)
        if (existsSync(p)) return p
      }
    } catch {
      // projects dir missing — nothing to tail yet
    }
    return null
  }

  const attach = (): void => {
    if (!watching) return
    file = locate(watching)
    if (!file) return
    partial = ''
    offset = 0
    if (watching === resumedId) {
      // Skip deep history but keep the recent tail in view — a goal set in
      // the moments between resume and attach still lands (the timestamp
      // filter in drain() drops anything older than this driver).
      try {
        offset = Math.max(0, statSync(file).size - GOAL_TAIL_BYTES)
      } catch {
        offset = 0
      }
    }
  }

  return {
    arm(sessionId: string): void {
      if (watching === sessionId) return
      watching = sessionId
      attach()
      timer ??= setInterval(() => {
        if (!file) attach()
        drain()
      }, 1000)
    },
    close(): void {
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

export const claudeDriver: HarnessDriver = {
  id: 'claude',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx
    const input = new InputQueue()
    const state: StreamState = {
      currentMsgId: new Map(),
      toolInput: new Map(),
      working: false,
      armedAt: null,
      nudged: false,
      overflowed: false,
      compactRecoveryTried: false,
      contextTokens: 0
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
        input: toolInput,
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

    const options: Options = {
      abortController: abort,
      model: session.model,
      cwd: session.cwd,
      // The SDK ladder tops out at max; 'ultra' is codex-only (a session
      // switched off sol mid-ultra clamps rather than erroring).
      effort: session.reasoning === 'ultra' ? 'max' : session.reasoning,
      includePartialMessages: true,
      permissionMode: PERMISSION_MODE[session.permission],
      ...(session.permission === 'auto' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool,
      hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [askUserQuestionHook] }] },
      // Claude settings keys (not Options) ride a per-session --settings
      // override: fast mode, and the context mode — Standard keeps the
      // thread under 200k via the CLI's own auto-compact (also dodging the
      // 2x long-context pricing above 200k input); 1M turns auto-compact
      // off and rides the full native window.
      //
      // The compact window is 180k, NOT 200k: the CLI arms compaction at
      // window − 33k, and without the 1M beta the API hard-rejects a
      // request at 200k − max_tokens (≈168k) with "Prompt is too long".
      // A 200k setting put the compact trigger (167k) a hair under the
      // rejection wall — one long turn sailed past both and bricked the
      // thread. 180k arms compaction at ~147k, real headroom.
      extraArgs: {
        settings: JSON.stringify({
          ...(session.fast ? { fastMode: true } : {}),
          autoCompactEnabled: !session.context1m,
          ...(session.context1m ? {} : { autoCompactWindow: 180_000 })
        })
      },
      ...(session.context1m ? { betas: ['context-1m-2025-08-07' as const] } : {}),
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
              ...(conduct.selfEdit ? [] : ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']),
              ...(conduct.selfShell ? [] : ['Bash'])
            ]
            return {
              mcpServers: {
                orchestrator: orchestratorMcp(session),
                app: appToolsMcp(session)
              },
              allowedTools: [...ORCHESTRATOR_TOOLS, ...APP_TOOLS],
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
            session.threadType === 'planning'
          ? {
              // Implementation, chat AND planning threads spawn subagents
              // through the same toolset — never by shelling out to another
              // model's CLI, and never invisibly through the built-in Task
              // tool. Every thread that delegates grows the fleet panel.
              mcpServers: {
                orchestrator: orchestratorMcp(session),
                app: appToolsMcp(session)
              },
              allowedTools: [...ORCHESTRATOR_TOOLS, ...APP_TOOLS],
              // Native subagent lanes are invisible to the user — the whole
              // point of spawn_agent is a visible, steerable session. The
              // tool is Task in older CLIs, Agent in the Fable era.
              disallowedTools: ['Task', 'Agent'],
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append:
                  session.threadType === 'chat'
                    ? chatSpawnPrompt(session)
                    : session.threadType === 'planning'
                      ? planningSpawnPrompt(session)
                      : implementerSpawnPrompt(session)
              }
            }
          : {
              mcpServers: { app: appToolsMcp(session) },
              allowedTools: APP_TOOLS
            })
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
      if (disposed || !state.working || state.armedAt === null) return
      const quiet = Date.now() - state.armedAt
      if (quiet >= RECOVER_AFTER_MS) {
        state.working = false
        state.armedAt = null
        emit({ type: 'error', message: 'the harness never reported the turn done — recovered' })
        emit({ type: 'status', status: 'idle' })
        abort.abort()
      } else if (quiet >= NUDGE_AFTER_MS && !state.nudged) {
        state.nudged = true
        void q.getContextUsage().catch(() => {})
      }
    }, 5_000)

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

    // Drain the harness stream for the life of the session.
    void (async () => {
      try {
        for await (const msg of q) {
          if (disposed) continue
          handleMessage(watchedCtx, state, msg)
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
        // Stream over with a turn still open: the result message is never
        // coming (process died, or the SDK dropped it). Settle the status
        // or the thread shows "working" forever.
        if (state.working && !disposed) {
          state.working = false
          emit({ type: 'error', message: 'harness stream ended mid-turn' })
          emit({ type: 'status', status: 'idle' })
        }
      } catch (err) {
        // A watchdog abort already settled the status — swallow its throw.
        if (disposed || abort.signal.aborted) return
        state.working = false
        // emit persists to SQLite; if THAT is what threw (a locked
        // database), a bare retry here would kill the drain loop entirely
        // and freeze the thread on "Working…" with nothing logged.
        try {
          emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
          emit({ type: 'status', status: 'error' })
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
      },
      interrupt(): void {
        void q.interrupt()
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
      async dispose(): Promise<void> {
        disposed = true
        for (const finish of [...pendingApprovals.values()]) finish(false, true)
        for (const finish of [...pendingQuestions.values()]) finish(null)
        input.close()
      }
    }
  }
}
