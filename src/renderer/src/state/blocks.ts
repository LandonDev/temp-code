import type { AgentEvent, Attachment, EventRow } from '@shared/events'

/** One structured question from a question-request event. */
export type QuestionSpec = Extract<AgentEvent, { type: 'question-request' }>['questions'][number]

/**
 * Incremental transcript folding — the store folds each event into blocks
 * as it arrives, so render never refolds the whole log (docs/PLAN.md M3).
 *
 * Text/thinking blocks are keyed by (msgId, blockIndex) when the driver
 * provides them (claude does), so an authoritative final replaces exactly
 * the block its deltas built — a turn that goes text → tool → text keeps
 * both texts. Without keys, deltas append to the last streaming block of
 * the same kind (codex/cursor for now).
 *
 * Events with parentCallId belong to an in-harness subagent; they count
 * as activity on the owning tool block instead of appearing inline.
 */

type BlockKind =
  | {
      kind: 'user'
      text: string
      attachments?: Attachment[]
      /** optimistic echo not yet confirmed by the server — renders at 65% */
      pending?: boolean
      /** when the work this message started settled (its section's timer) */
      doneTs?: number
    }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | {
      kind: 'thinking'
      text: string
      streaming: boolean
      /** wall-clock ms the model spent thinking ("Thought for 12s") */
      startedAt?: number
      thoughtMs?: number
    }
  | {
      kind: 'tool'
      callId: string
      name: string
      input: unknown
      /** input is a streaming preview, still growing */
      partialInput?: boolean
      output?: string
      isError?: boolean
      /** wall clock when the result landed — with ts, the tool's duration */
      doneTs?: number
      /** humanized face for addon calls (Codex appContext): app + action */
      display?: { app?: string; action?: string }
      /** activity events from a subagent running under this call */
      subCount: number
    }
  | { kind: 'error'; text: string }
  | {
      kind: 'approval'
      requestId: string
      toolName: string
      input: unknown
      title?: string
      resolved: boolean
      allow?: boolean
      auto?: boolean
    }
  | {
      kind: 'compaction'
      phase: 'start' | 'done' | 'failed'
      trigger?: 'auto' | 'manual'
      preTokens?: number
      postTokens?: number
      durationMs?: number
      error?: string
    }
  | {
      kind: 'question'
      requestId: string
      questions: QuestionSpec[]
      resolved: boolean
      /** chosen labels per question; null once resolved = dismissed */
      answers?: string[][] | null
    }

/** `todo` = index of the todo that was in_progress when the block was born
 *  (-1 before the first todo list) — how the implementation view groups. */
export type Block = BlockKind & { id: string; todo: number; ts?: number }

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface FoldState {
  blocks: Block[]
  /** msgId:blockIndex → index into blocks */
  byKey: Map<string, number>
  /** callId → index into blocks */
  byCall: Map<string, number>
  /** approval requestId → index into blocks */
  byRequest: Map<string, number>
  nextId: number
  /** cumulative session cost, from the latest turn-complete */
  costUsd?: number
  /** latest todo list (TodoWrite / update_plan / TaskCreate+TaskUpdate) */
  todos: TodoItem[]
  activeTodo: number
  /** SDK task tools are stateful: taskId → todo index… */
  taskIds: Map<string, number>
  /** …and a TaskCreate learns its id from its RESULT (callId → index). */
  taskByCall: Map<string, number>
  /** task calls already folded into the todo model (re-delivery guard) */
  taskSeen: Set<string>
  /** indexes of optimistic user blocks awaiting their server echo */
  pendingUsers: number[]
}

export function emptyFold(): FoldState {
  return {
    blocks: [],
    byKey: new Map(),
    byCall: new Map(),
    byRequest: new Map(),
    nextId: 1,
    todos: [],
    activeTodo: -1,
    taskIds: new Map(),
    taskByCall: new Map(),
    taskSeen: new Set(),
    pendingUsers: []
  }
}

/** Show the user's message the instant they hit send — the server echoes
 *  the authoritative user-text event a round-trip later; foldEvent then
 *  claims this block instead of appending a duplicate. */
export function foldOptimisticUser(s: FoldState, text: string, attachments?: Attachment[]): void {
  s.pendingUsers.push(push(s, { kind: 'user', text, attachments, pending: true }, Date.now()))
}

function push(s: FoldState, block: BlockKind, ts?: number): number {
  const id = String(s.nextId++)
  s.blocks.push({ ...block, id, todo: s.activeTodo, ts })
  return s.blocks.length - 1
}

/** Normalize the two harness plan tools into one shape. */
function todosFrom(name: string, input: unknown): TodoItem[] | null {
  const obj = input as { todos?: unknown; plan?: unknown } | null
  const raw = name === 'TodoWrite' ? obj?.todos : name === 'update_plan' ? obj?.plan : null
  if (!Array.isArray(raw)) return null
  return raw.flatMap((t) => {
    const item = t as { content?: string; step?: string; status?: string }
    const content = item.content ?? item.step
    if (!content) return []
    const status =
      item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending'
    return [{ content, status }]
  })
}

function foldText(
  s: FoldState,
  kind: 'assistant' | 'thinking',
  e: { text: string; delta: boolean; msgId?: string; blockIndex?: number },
  ts?: number
): void {
  const key =
    e.msgId !== undefined && e.blockIndex !== undefined ? `${e.msgId}:${e.blockIndex}` : null
  let idx: number | undefined
  if (key) {
    idx = s.byKey.get(key)
  } else {
    // Legacy path: append to the last streaming block of the same kind.
    const last = s.blocks.length - 1
    const lastBlock = s.blocks[last]
    if (lastBlock?.kind === kind && lastBlock.streaming) idx = last
  }

  if (idx === undefined) {
    const newIdx = push(
      s,
      {
        kind,
        text: e.text,
        streaming: e.delta,
        ...(kind === 'thinking' ? { startedAt: ts } : {})
      },
      ts
    )
    if (key) s.byKey.set(key, newIdx)
    return
  }
  const cur = s.blocks[idx] as Extract<Block, { kind: 'assistant' | 'thinking' }>
  const thoughtMs =
    !e.delta && cur.kind === 'thinking' && cur.startedAt !== undefined && ts !== undefined
      ? Math.max(0, ts - cur.startedAt)
      : undefined
  s.blocks[idx] = e.delta
    ? { ...cur, text: cur.text + e.text }
    : { ...cur, text: e.text, streaming: false, ...(thoughtMs !== undefined ? { thoughtMs } : {}) }
}

/** Fold one event into the state. Mutates the state; changed block objects
 *  are replaced (never mutated) so memoized rows re-render correctly. */
export function foldEvent(s: FoldState, e: AgentEvent, ts?: number): void {
  // Subagent activity: count it on the owning tool block, don't inline it.
  if ('parentCallId' in e && e.parentCallId) {
    const idx = s.byCall.get(e.parentCallId)
    if (idx !== undefined) {
      const b = s.blocks[idx] as Extract<Block, { kind: 'tool' }>
      // Only count "step" events, not every delta or input preview.
      if ((e.type === 'tool-call' && !e.partial) || (e.type === 'assistant-text' && !e.delta)) {
        s.blocks[idx] = { ...b, subCount: b.subCount + 1 }
      }
    }
    return
  }

  switch (e.type) {
    case 'user-text': {
      const pending = s.pendingUsers.shift()
      if (pending !== undefined && s.blocks[pending]?.kind === 'user') {
        const b = s.blocks[pending] as Extract<Block, { kind: 'user' }>
        s.blocks[pending] = {
          ...b,
          text: e.text,
          attachments: e.attachments,
          pending: undefined,
          ts: ts ?? b.ts
        }
      } else {
        push(s, { kind: 'user', text: e.text, attachments: e.attachments }, ts)
      }
      break
    }
    case 'assistant-text':
      foldText(s, 'assistant', e, ts)
      break
    case 'thinking':
      foldText(s, 'thinking', e, ts)
      break
    case 'tool-call': {
      // Plan-tool calls update the todo model; blocks born after this
      // belong to the newly in_progress todo. Previews wait — a half-built
      // todo list shouldn't flash through the implementation view.
      const todos = e.partial ? null : todosFrom(e.name, e.input)
      if (todos) {
        s.todos = todos
        const active = todos.findIndex((t) => t.status === 'in_progress')
        s.activeTodo = active !== -1 ? active : s.activeTodo
      }
      // SDK task tools (claude's TodoWrite replacement). Guarded by its own
      // seen-set: the streamed partial preview registers the callId in
      // byCall long before the final input arrives, and re-delivered events
      // must not duplicate todos either.
      if (!e.partial && !s.taskSeen.has(e.callId)) {
        // Mark seen only on consumption — the driver's early announcement
        // for the same callId can arrive without input.
        if (e.name === 'TaskCreate') {
          const subject = (e.input as { subject?: string } | null)?.subject
          if (subject) {
            s.taskSeen.add(e.callId)
            s.todos = [...s.todos, { content: subject, status: 'pending' }]
            s.taskByCall.set(e.callId, s.todos.length - 1)
          }
        } else if (e.name === 'TaskUpdate') {
          const i = e.input as { taskId?: unknown; status?: string } | null
          const idx = s.taskIds.get(String(i?.taskId))
          const status = i?.status
          if (
            idx !== undefined &&
            idx < s.todos.length &&
            (status === 'pending' || status === 'in_progress' || status === 'completed')
          ) {
            s.taskSeen.add(e.callId)
            s.todos = s.todos.map((t, n) => (n === idx ? { ...t, status } : t))
            if (status === 'in_progress') s.activeTodo = idx
          }
        }
      }
      const existing = s.byCall.get(e.callId)
      if (existing !== undefined) {
        // Streaming preview or the final input replacing the early chip.
        const b = s.blocks[existing] as Extract<Block, { kind: 'tool' }>
        const next = {
          ...b,
          name: e.name,
          input: e.input ?? b.input,
          display: e.display ?? b.display
        }
        if (e.partial) next.partialInput = true
        else delete next.partialInput
        s.blocks[existing] = next
      } else {
        const idx = push(
          s,
          {
            kind: 'tool',
            callId: e.callId,
            name: e.name,
            input: e.input,
            display: e.display,
            subCount: 0
          },
          ts
        )
        if (e.partial) (s.blocks[idx] as Extract<Block, { kind: 'tool' }>).partialInput = true
        s.byCall.set(e.callId, idx)
      }
      break
    }
    case 'tool-result': {
      // A TaskCreate result names the task's id ("Task #3 created …").
      const created = s.taskByCall.get(e.callId)
      if (created !== undefined) {
        s.taskByCall.delete(e.callId)
        const m = /#(\d+)/.exec(e.output)
        if (m) s.taskIds.set(m[1], created)
      }
      const idx = s.byCall.get(e.callId)
      if (idx !== undefined) {
        const b = s.blocks[idx] as Extract<Block, { kind: 'tool' }>
        s.blocks[idx] = { ...b, output: e.output, isError: e.isError, doneTs: ts }
      }
      break
    }
    case 'approval-request':
      s.byRequest.set(
        e.requestId,
        push(s, {
          kind: 'approval',
          requestId: e.requestId,
          toolName: e.toolName,
          input: e.input,
          title: e.title,
          resolved: false
        })
      )
      break
    case 'approval-resolved': {
      const idx = s.byRequest.get(e.requestId)
      if (idx !== undefined) {
        const b = s.blocks[idx] as Extract<Block, { kind: 'approval' }>
        s.blocks[idx] = { ...b, resolved: true, allow: e.allow, auto: e.auto }
      }
      break
    }
    case 'compaction': {
      // start opens a card; done/failed settle the open one in place.
      if (e.phase === 'start') {
        push(s, { kind: 'compaction', phase: 'start' }, ts)
        break
      }
      const ix = s.blocks.findLastIndex((b) => b.kind === 'compaction' && b.phase === 'start')
      const settled = {
        kind: 'compaction' as const,
        phase: e.phase,
        trigger: e.trigger,
        preTokens: e.preTokens,
        postTokens: e.postTokens,
        durationMs: e.durationMs,
        error: e.error
      }
      if (ix >= 0) {
        s.blocks[ix] = { ...s.blocks[ix], ...settled }
      } else {
        push(s, settled, ts)
      }
      break
    }
    case 'question-request':
      if (!s.byRequest.has(e.requestId)) {
        s.byRequest.set(
          e.requestId,
          push(
            s,
            {
              kind: 'question',
              requestId: e.requestId,
              questions: e.questions,
              resolved: false
            },
            ts
          )
        )
      }
      break
    case 'question-resolved': {
      const idx = s.byRequest.get(e.requestId)
      if (idx !== undefined && s.blocks[idx]?.kind === 'question') {
        const b = s.blocks[idx] as Extract<Block, { kind: 'question' }>
        s.blocks[idx] = { ...b, resolved: true, answers: e.answers }
      }
      break
    }
    case 'turn-complete':
      if (e.costUsd !== undefined) s.costUsd = e.costUsd
      // The turn ending settles every streaming block — an interrupt can
      // beat the per-item finals, and a "Thinking" shimmer must never
      // outlive the turn it belongs to.
      for (let i = 0; i < s.blocks.length; i++) {
        const b = s.blocks[i]
        if ((b.kind === 'assistant' || b.kind === 'thinking') && b.streaming) {
          s.blocks[i] = { ...b, streaming: false }
        }
        // The turn end also closes every open section (steered messages
        // share the end), giving each user message its own timer.
        if (b.kind === 'user' && b.doneTs === undefined) {
          s.blocks[i] = { ...s.blocks[i], doneTs: ts } as (typeof s.blocks)[number]
        }
      }
      break
    case 'error':
      push(s, { kind: 'error', text: e.message })
      break
    // status / agent-spawned drive the sidebar, not the transcript
  }
}

export function foldAll(rows: EventRow[]): FoldState {
  const s = emptyFold()
  for (const r of rows) foldEvent(s, r.event, r.ts)
  return s
}
