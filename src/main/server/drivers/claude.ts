import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'
import type { Attachment, PermissionPolicy } from '@shared/events'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import { parsePartialJson } from './partial-json'
import { ORCHESTRATOR_PROMPT, ORCHESTRATOR_TOOLS, orchestratorMcp } from '../orchestration'
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
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: a.mime as 'image/png',
              data: readFileSync(a.path).toString('base64')
            }
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
}

/** How often a growing tool input is re-parsed and forwarded to the UI. */
const PARTIAL_INPUT_EVERY_MS = 100

function handleMessage(ctx: DriverCtx, state: StreamState, msg: SDKMessage): void {
  const { emit } = ctx
  switch (msg.type) {
    case 'system':
      // The CLI boots lazily on the first send, so init arrives mid-turn —
      // record the native id but leave the running status alone.
      if (msg.subtype === 'init') ctx.setNativeId(msg.session_id)
      break
    case 'stream_event': {
      const ev = msg.event
      const lane = msg.parent_tool_use_id ?? ''
      const parentCallId = msg.parent_tool_use_id ?? undefined
      if (ev.type === 'message_start') {
        state.currentMsgId.set(lane, ev.message.id)
      } else if (ev.type === 'content_block_start') {
        if (ev.content_block.type === 'tool_use') {
          // Early visibility: the chip appears while input is still streaming.
          emit({
            type: 'tool-call',
            callId: ev.content_block.id,
            name: ev.content_block.name,
            input: undefined,
            parentCallId
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
            emit({
              type: 'tool-call',
              callId: t.callId,
              name: t.name,
              input: JSON.parse(t.json.trim() || '{}'),
              parentCallId
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
                  parentCallId
                })
              }
            }
          }
        }
      }
      break
    }
    case 'assistant': {
      const parentCallId = msg.parent_tool_use_id ?? undefined
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
            parentCallId
          })
        }
      })
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
    const state: StreamState = { currentMsgId: new Map(), toolInput: new Map() }
    const pendingApprovals = new Map<string, (allow: boolean, auto?: boolean) => void>()

    // Approval flow (docs/PLAN.md M4): the harness asks, we emit an
    // approval-request event, the user answers through session.approve.
    const canUseTool: CanUseTool = (toolName, toolInput, opts) => {
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

    const options: Options = {
      model: session.model,
      cwd: session.cwd,
      // The SDK ladder tops out at max; 'ultra' is codex-only (a session
      // switched off sol mid-ultra clamps rather than erroring).
      effort: session.reasoning === 'ultra' ? 'max' : session.reasoning,
      includePartialMessages: true,
      permissionMode: PERMISSION_MODE[session.permission],
      ...(session.permission === 'auto' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool,
      ...(session.nativeId ? { resume: session.nativeId } : {}),
      // Any claude session typed 'orchestrator' can spawn cross-provider
      // subagents (docs/PLAN.md M6). The orchestrator is not special —
      // just this toolset plus a router rubric.
      ...(session.agentType === 'orchestrator'
        ? {
            mcpServers: { orchestrator: orchestratorMcp(session) },
            allowedTools: ORCHESTRATOR_TOOLS,
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: ORCHESTRATOR_PROMPT
            }
          }
        : {})
    }

    const q = query({ prompt: input, options })

    // Drain the harness stream for the life of the session.
    void (async () => {
      try {
        for await (const msg of q) handleMessage(ctx, state, msg)
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        emit({ type: 'status', status: 'error' })
      }
    })()

    return {
      async send(text: string, attachments?: Attachment[]): Promise<void> {
        emit({ type: 'status', status: 'running' })
        // The harness only runs a LEADING /command natively; mid-message
        // and additional skill references get expanded server-side.
        input.push(await expandSlashRefs('claude', session.cwd, text), attachments)
      },
      interrupt(): void {
        void q.interrupt()
      },
      approve(requestId: string, allow: boolean): void {
        pendingApprovals.get(requestId)?.(allow)
      },
      async dispose(): Promise<void> {
        for (const finish of [...pendingApprovals.values()]) finish(false, true)
        input.close()
      }
    }
  }
}
