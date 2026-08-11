import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'

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

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
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
}

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
        }
      } else if (ev.type === 'content_block_delta') {
        const msgId = state.currentMsgId.get(lane)
        const blockIndex = ev.index
        if (ev.delta.type === 'text_delta') {
          emit({ type: 'assistant-text', text: ev.delta.text, delta: true, msgId, blockIndex, parentCallId })
        } else if (ev.delta.type === 'thinking_delta') {
          emit({ type: 'thinking', text: ev.delta.thinking, delta: true, msgId, blockIndex, parentCallId })
        }
      }
      break
    }
    case 'assistant': {
      const parentCallId = msg.parent_tool_use_id ?? undefined
      const msgId = msg.message.id
      msg.message.content.forEach((block, blockIndex) => {
        if (block.type === 'text') {
          emit({ type: 'assistant-text', text: block.text, delta: false, msgId, blockIndex, parentCallId })
        } else if (block.type === 'thinking') {
          emit({ type: 'thinking', text: block.thinking, delta: false, msgId, blockIndex, parentCallId })
        } else if (block.type === 'tool_use') {
          emit({ type: 'tool-call', callId: block.id, name: block.name, input: block.input, parentCallId })
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

export const claudeDriver: HarnessDriver = {
  id: 'claude',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx
    const input = new InputQueue()
    const state: StreamState = { currentMsgId: new Map() }

    const options: Options = {
      model: session.model,
      cwd: session.cwd,
      effort: session.reasoning,
      includePartialMessages: true,
      // Bare-basics stance: edits auto-accepted, everything else falls back
      // to permission rules. The real approval flow (canUseTool → UI approval
      // card) is Milestone 4 in docs/PLAN.md.
      permissionMode: 'acceptEdits',
      ...(session.nativeId ? { resume: session.nativeId } : {})
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
      async send(text: string): Promise<void> {
        emit({ type: 'user-text', text })
        emit({ type: 'status', status: 'running' })
        input.push(text)
      },
      interrupt(): void {
        void q.interrupt()
      },
      async dispose(): Promise<void> {
        input.close()
      }
    }
  }
}
