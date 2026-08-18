import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { modelInfo, type Reasoning } from '@shared/catalog'
import type { Attachment, PermissionPolicy } from '@shared/events'
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

/**
 * Cursor weighs every command against its own config file, and `-p` has
 * nowhere to ask — so anything the config doesn't list comes back
 * rejected, which is how a thread set to full access got refused `git`.
 * Each policy names cursor's own equivalent instead of leaving it to a
 * file the app doesn't own.
 */
const PERMISSION_ARGS: Record<PermissionPolicy, string[]> = {
  safe: ['--mode', 'plan'],
  edits: ['--force', '--sandbox', 'enabled'],
  auto: ['--force', '--sandbox', 'disabled']
}

/** readToolCall → Read, shellToolCall → Shell, ... */
function toolName(toolCall: Record<string, unknown>): { key: string; name: string } {
  const key = Object.keys(toolCall).find((k) => k.endsWith('ToolCall')) ?? 'unknownToolCall'
  const base = key.slice(0, -'ToolCall'.length)
  return { key, name: base.charAt(0).toUpperCase() + base.slice(1) }
}

/** TODO_STATUS_IN_PROGRESS → in_progress. Anything unrecognized is pending. */
function todoStatus(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/^TODO_STATUS_/, '')
    .toLowerCase()
  return s === 'in_progress' || s === 'completed' || s === 'cancelled' ? s : 'pending'
}

/**
 * Cursor's todo list, held for the session. Its updateTodos call sends the
 * whole list when merge is false and ONLY the changed items when it is
 * true — so a driver that just forwarded the call would show a
 * three-task list collapsing to the one task that moved. Keeping the list
 * here and replaying all of it is what lets the app fold cursor's todos
 * with everyone else's.
 */
class CursorTodos {
  private order: string[] = []
  private byId = new Map<string, { content: string; status: string }>()

  /** Returns the full list in TodoWrite's shape, or null if there is none. */
  apply(args: unknown): { content: string; status: string }[] | null {
    const a = args as { todos?: unknown; merge?: unknown } | null
    if (!Array.isArray(a?.todos)) return null
    if (a.merge !== true) {
      this.order = []
      this.byId.clear()
    }
    for (const raw of a.todos) {
      const t = raw as { id?: unknown; content?: unknown; status?: unknown }
      const id = String(t?.id ?? '')
      const content = String(t?.content ?? '')
      if (!id || !content) continue
      if (!this.byId.has(id)) this.order.push(id)
      this.byId.set(id, { content, status: todoStatus(t?.status) })
    }
    return this.order.flatMap((id) => {
      const t = this.byId.get(id)
      return t ? [t] : []
    })
  }
}

/**
 * Cursor writes files with one editToolCall for both new files and
 * changes, carrying the pending text as `streamContent` and, once it
 * lands, a real unified diff. Renaming it to apply_patch hands the app the
 * same shape codex's patches arrive in, so the file card, its diffstat and
 * the changes view all work without knowing cursor exists.
 */
function editAsPatch(
  args: unknown,
  result: Record<string, unknown> | null
): { path: string; diff: string; kind: { type: string } }[] | null {
  const a = args as { path?: unknown; streamContent?: unknown } | null
  const path = String(a?.path ?? '')
  if (!path) return null
  const ok = (result?.success ?? null) as {
    diffString?: unknown
    beforeFullFileContent?: unknown
    afterFullFileContent?: unknown
  } | null
  // A new file carries its whole content, a change carries a unified diff —
  // the two shapes apply_patch already reads for kind add and update.
  const body = (text: unknown): string => String(text ?? '').replace(/\n$/, '')
  if (!ok) {
    // Still writing: show the file with the text so far. The finished call
    // replaces this with what really changed.
    return [{ path, diff: body(a?.streamContent), kind: { type: 'add' } }]
  }
  return ok.beforeFullFileContent === undefined
    ? [{ path, diff: body(ok.afterFullFileContent), kind: { type: 'add' } }]
    : [{ path, diff: body(ok.diffString), kind: { type: 'update' } }]
}

/**
 * Cursor sends its whole command parse tree with every shell call —
 * hundreds of lines the transcript would store and the raw view would
 * show. Only the fields the run card reads survive.
 */
function shellInput(args: unknown): Record<string, unknown> {
  const a = (args ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = { command: String(a.command ?? '') }
  if (a.description) out.description = String(a.description)
  if (a.workingDirectory) out.workingDirectory = String(a.workingDirectory)
  if (a.isBackground === true) out.isBackground = true
  return out
}

/**
 * A shell result should read like a terminal, not like JSON: the output
 * as it came, and a closing line for a non-zero exit or a refusal.
 */
function shellResult(result: Record<string, unknown>): { text: string; isError: boolean } | null {
  const no = result.rejected as { command?: unknown } | undefined
  if (no)
    return {
      text: `cursor would not run \`${String(no.command ?? '')}\` — this thread's access does not cover it.`,
      isError: true
    }
  const r = (result.success ?? result.failure) as Record<string, unknown> | undefined
  if (!r) return null
  const body = String(
    r.interleavedOutput ?? `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`
  ).trimEnd()
  const failed = result.failure !== undefined
  const code = Number(r.exitCode ?? 0)
  return { text: failed && code !== 0 ? `${body}\n(exit ${code})`.trim() : body, isError: failed }
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
    // The todo list belongs to the cursor session, not to one turn — a
    // resumed thread keeps updating the list it built earlier.
    const todos = new CursorTodos()
    let turnSeq = 0
    // A stand-down is not a failure: interrupt kills cursor-agent with SIGINT,
    // which exits 130 with no result. Without this the orchestrator's own
    // interrupt_agent painted every stopped child red.
    let stoodDown = false
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
        ...PERMISSION_ARGS[session.permission],
        '--output-format',
        'stream-json',
        ...(session.model ? ['--model', cursorModelArg(session.model, session.reasoning)] : []),
        ...(session.nativeId ? ['--resume', session.nativeId] : []),
        text
      ]
      const p = spawn(binPath, args, { cwd: session.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      proc = p
      stoodDown = false

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
            const done = msg.subtype === 'completed'
            const result = inner.result ?? {}

            // Cursor's two file-shaped calls get renamed to the ones the app
            // already knows, so the todo fold, the file cards and the changes
            // view all read them without knowing cursor exists. Everything
            // else passes through under its own name.
            const list = key === 'updateTodosToolCall' ? todos.apply(inner.args) : null
            const patch =
              key === 'editToolCall' ? editAsPatch(inner.args, done ? result : null) : null
            if (list) emit({ type: 'tool-call', callId, name: 'TodoWrite', input: { todos: list } })
            else if (patch)
              emit({ type: 'tool-call', callId, name: 'apply_patch', input: patch, partial: !done })
            else if (!done)
              emit({
                type: 'tool-call',
                callId,
                name,
                input: key === 'shellToolCall' ? shellInput(inner.args) : inner.args
              })

            if (done) {
              const shell = key === 'shellToolCall' ? shellResult(result) : null
              if (shell) {
                emit({ type: 'tool-result', callId, output: shell.text, isError: shell.isError })
                break
              }
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
        if (code !== 0 && !sawResult && !stoodDown) {
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
        stoodDown = true
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
