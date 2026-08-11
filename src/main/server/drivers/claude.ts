import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'

/**
 * Claude driver — the Claude Code harness as a library. The SDK spawns the
 * official CLI over pipes and runs under the user's own `claude` login
 * (Agent SDK subscription credit). We never touch credentials.
 *
 * Uses streaming-input mode: one long-lived query() per session, send()
 * pushes user messages into its input iterable.
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

function handleMessage(ctx: DriverCtx, msg: SDKMessage): void {
  const { emit } = ctx
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        ctx.setNativeId(msg.session_id)
        emit({ type: 'status', status: 'idle' })
      }
      break
    case 'stream_event': {
      const ev = msg.event
      if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') {
          emit({ type: 'assistant-text', text: ev.delta.text, delta: true })
        } else if (ev.delta.type === 'thinking_delta') {
          emit({ type: 'thinking', text: ev.delta.thinking, delta: true })
        }
      }
      break
    }
    case 'assistant':
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          emit({ type: 'assistant-text', text: block.text, delta: false })
        } else if (block.type === 'thinking') {
          emit({ type: 'thinking', text: block.thinking, delta: false })
        } else if (block.type === 'tool_use') {
          emit({ type: 'tool-call', callId: block.id, name: block.name, input: block.input })
        }
      }
      break
    case 'user':
      // Carries tool results the harness fed back to the model.
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
              isError: block.is_error ?? false
            })
          }
        }
      }
      break
    case 'result':
      if (msg.subtype === 'success') {
        emit({
          type: 'turn-complete',
          costUsd: msg.total_cost_usd,
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens
        })
      } else {
        emit({ type: 'error', message: `turn failed: ${msg.subtype}` })
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
        for await (const msg of q) handleMessage(ctx, msg)
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
