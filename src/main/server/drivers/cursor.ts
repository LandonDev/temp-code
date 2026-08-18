import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { modelInfo, type Reasoning } from '@shared/catalog'
import type { Attachment } from '@shared/events'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import { harnessEnv, resolveBinary } from './binaries'
import { expandSlashRefs } from '../slash'

/**
 * Resolve a catalog family + effort to the concrete cursor model id.
 * `cursor-agent models` lists one id per (family, effort) permutation —
 * `cursor-grok-4.6-low`, `claude-opus-5-thinking-max`, … — so the ladder
 * joins as a suffix. One irregular: the bare `gpt-5.3-codex` IS its medium
 * tier (no `-medium` id exists). Families without an effort ladder (auto,
 * composer-2.5) and unknown ids pass through untouched.
 */
export function cursorModelArg(model: string, reasoning: Reasoning): string {
  const info = modelInfo('cursor', model)
  if (!info || info.reasoning.length === 0) return model
  const effort = info.reasoning.includes(reasoning)
    ? reasoning
    : (info.defaultReasoning ?? info.reasoning[0])
  if (model === 'gpt-5.3-codex' && effort === 'medium') return model
  return `${model}-${effort}`
}

/**
 * Cursor driver — `cursor-agent -p --trust --output-format stream-json`,
 * process-per-turn, resumed with `--resume <session_id>` (verified live
 * against cursor-agent 2026.08.11):
 *
 *   system/init {session_id, model} · thinking {subtype delta|completed}
 *   assistant {message.content[].text} — one whole message, and the
 *   closing one of a turn carries no model_call_id · tool_call {subtype
 *   started|completed, call_id, tool_call: {<kind>ToolCall: {args,
 *   result}}} · result {is_error, usage {inputTokens, outputTokens}}
 *
 * A dropped connection emits connection/reconnecting then retry/starting
 * with is_resume, and cursor-agent replays the turn from its last
 * checkpoint — the same messages arrive again. After three of those it
 * exits 1 with no result.
 */

/** readToolCall → Read, shellToolCall → Shell, ... */
function toolName(toolCall: Record<string, unknown>): { key: string; name: string } {
  const key = Object.keys(toolCall).find((k) => k.endsWith('ToolCall')) ?? 'unknownToolCall'
  const base = key.slice(0, -'ToolCall'.length)
  return { key, name: base.charAt(0).toUpperCase() + base.slice(1) }
}

export const cursorDriver: HarnessDriver = {
  id: 'cursor',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx

    const binPath = await resolveBinary('cursor-agent')
    if (!binPath)
      throw new Error(
        'cursor-agent not found on the login-shell PATH — install it, log in (`cursor-agent login`), and make sure its bin dir is exported from ~/.zprofile'
      )
    const env = await harnessEnv()

    let proc: ChildProcess | null = null
    let turnSeq = 0
    let disposed = false
    let contextTokens = 0

    const runTurn = (text: string): void => {
      const turn = ++turnSeq
      // Thinking streams as deltas, so it needs an accumulator for its
      // authoritative final. Assistant messages arrive whole — each one is
      // emitted once, settled, under its own key.
      const thinkingAcc = new Map<string, string>()
      const seen = new Set<string>()
      let thinkIdx = 0
      let msgIdx = 0
      let replaying = false
      const thinkKey = (): string => `think-${turn}-${thinkIdx}`

      const args = [
        '-p',
        '--trust',
        '--output-format',
        'stream-json',
        ...(session.model ? ['--model', cursorModelArg(session.model, session.reasoning)] : []),
        ...(session.nativeId ? ['--resume', session.nativeId] : []),
        text
      ]
      const p = spawn(binPath, args, { cwd: session.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      proc = p

      let sawResult = false
      createInterface({ input: p.stdout! }).on('line', (line) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init' && typeof msg.session_id === 'string' && !session.nativeId) {
              ctx.setNativeId(msg.session_id)
              session.nativeId = msg.session_id
            }
            break
          case 'thinking':
            if (msg.subtype === 'delta' && typeof msg.text === 'string') {
              const key = thinkKey()
              const prior = thinkingAcc.get(key)
              const full = (prior ?? '') + msg.text
              thinkingAcc.set(key, full)
              // After a rollback this block already holds what the first run
              // through put on screen. Its opening chunk replaces that; the
              // rest append as usual.
              const reopening = replaying && prior === undefined
              emit({
                type: 'thinking',
                text: reopening ? full : msg.text,
                delta: !reopening,
                msgId: key,
                blockIndex: 0
              })
            } else if (msg.subtype === 'completed') {
              const key = thinkKey()
              const full = thinkingAcc.get(key)
              if (full !== undefined) {
                emit({ type: 'thinking', text: full, delta: false, msgId: key, blockIndex: 0 })
              }
              // A turn holds several thinking blocks; each gets its own key
              // so the next one starts a block instead of growing this one.
              thinkIdx++
            }
            break
          case 'assistant': {
            const message = msg.message as
              { content?: { type?: string; text?: string }[] } | undefined
            const text = (message?.content ?? [])
              .filter((b) => b.type === 'text' && b.text)
              .map((b) => b.text)
              .join('')
            if (!text) break
            // When its connection drops, cursor-agent rolls the turn back to
            // a checkpoint and replays it, re-sending messages it already
            // streamed — and the closing message carries no model_call_id to
            // tell the copies apart. Keying by arrival and skipping text
            // already shown is what keeps one answer from arriving three
            // times.
            if (seen.has(text)) break
            seen.add(text)
            emit({
              type: 'assistant-text',
              text,
              delta: false,
              msgId: `msg-${turn}-${msgIdx++}`,
              blockIndex: 0
            })
            break
          }
          case 'retry':
            if (msg.subtype === 'starting') {
              // cursor-agent rewound to its checkpoint and is about to say
              // the turn over. Rewind the thinking blocks with it so the
              // replay rewrites them instead of stacking a second copy
              // underneath. Assistant messages need no rewind — repeated
              // text is dropped below, and text that changed belongs after
              // what already stands.
              thinkIdx = 0
              thinkingAcc.clear()
              replaying = true
            }
            break
          case 'tool_call': {
            const callId = String(msg.call_id ?? '')
            const tc = (msg.tool_call ?? {}) as Record<string, unknown>
            const { key, name } = toolName(tc)
            const inner = (tc[key] ?? {}) as { args?: unknown; result?: Record<string, unknown> }
            if (msg.subtype === 'started') {
              emit({ type: 'tool-call', callId, name, input: inner.args })
            } else if (msg.subtype === 'completed') {
              const result = inner.result ?? {}
              const isError = !('success' in result)
              const payload = ('success' in result ? result.success : result) ?? result
              emit({
                type: 'tool-result',
                callId,
                output: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
                isError
              })
            }
            break
          }
          case 'result': {
            sawResult = true
            if (msg.is_error) {
              emit({ type: 'error', message: String(msg.result ?? 'cursor-agent error') })
            }
            const usage = msg.usage as { inputTokens?: number; outputTokens?: number } | undefined
            contextTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
            if (contextTokens > 0) emit({ type: 'context', tokens: contextTokens })
            emit({
              type: 'turn-complete',
              inputTokens: usage?.inputTokens,
              outputTokens: usage?.outputTokens
            })
            break
          }
        }
      })

      let stderrTail = ''
      p.stderr!.on('data', (d) => {
        stderrTail = (stderrTail + String(d)).slice(-500)
      })

      p.on('exit', (code) => {
        if (proc === p) proc = null
        if (disposed) return
        if (code !== 0 && !sawResult) {
          // Died mid-turn: cursor-agent gives up after three replays of a
          // dropped stream. Whatever it said is already on the transcript —
          // every message was emitted settled, not as an open delta.
          const tail = stderrTail.trim()
          emit({
            type: 'error',
            message: /RetriableError|WritableIterable is closed/.test(tail)
              ? 'cursor-agent lost its connection to Cursor and gave up retrying. Send again to pick the thread back up.'
              : `cursor-agent exited (${code}): ${tail}`
          })
          emit({ type: 'status', status: 'error' })
        } else {
          emit({ type: 'status', status: 'idle' })
        }
      })
      p.on('error', (err) => {
        emit({ type: 'error', message: err.message })
        emit({ type: 'status', status: 'error' })
      })
    }

    return {
      async send(text: string, attachments: Attachment[] = []): Promise<void> {
        if (proc) throw new Error('cursor session is still running a turn')
        emit({ type: 'status', status: 'running' })
        // cursor-agent has no native attachment input — everything rides as
        // path references it can read itself.
        const refs = attachments.map((a) => a.path)
        const expanded = await expandSlashRefs('cursor', session.cwd, text)
        runTurn(
          refs.length
            ? `${expanded}\n\n${refs.map((p) => `Attached file: ${p}`).join('\n')}`
            : expanded
        )
      },
      interrupt(): void {
        proc?.kill('SIGINT')
      },
      async contextUsage(): Promise<unknown> {
        // cursor-agent reports no context window; used tokens only.
        if (!contextTokens) return null
        return {
          categories: [{ name: 'Conversation', tokens: contextTokens, color: '#7c86ff' }],
          totalTokens: contextTokens,
          maxTokens: 0,
          percentage: 0,
          model: session.model
        }
      },
      async dispose(): Promise<void> {
        disposed = true
        proc?.kill()
      }
    }
  }
}
