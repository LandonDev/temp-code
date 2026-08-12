import type { AgentEvent, Attachment, EventRow } from '@shared/events'

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
  | { kind: 'user'; text: string; attachments?: Attachment[] }
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
      output?: string
      isError?: boolean
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

/** `todo` = index of the todo that was in_progress when the block was born
 *  (-1 before the first todo list) — how the implementation view groups. */
export type Block = BlockKind & { id: string; todo: number }

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
  /** latest todo list (TodoWrite / update_plan), for implementation threads */
  todos: TodoItem[]
  activeTodo: number
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
    pendingUsers: []
  }
}

/** Show the user's message the instant they hit send — the server echoes
 *  the authoritative user-text event a round-trip later; foldEvent then
 *  claims this block instead of appending a duplicate. */
export function foldOptimisticUser(s: FoldState, text: string, attachments?: Attachment[]): void {
  s.pendingUsers.push(push(s, { kind: 'user', text, attachments }))
}

function push(s: FoldState, block: BlockKind): number {
  const id = String(s.nextId++)
  s.blocks.push({ ...block, id, todo: s.activeTodo })
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
    const newIdx = push(s, {
      kind,
      text: e.text,
      streaming: e.delta,
      ...(kind === 'thinking' ? { startedAt: ts } : {})
    })
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
      // Only count "step" events, not every delta.
      if (e.type === 'tool-call' || (e.type === 'assistant-text' && !e.delta)) {
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
        s.blocks[pending] = { ...b, text: e.text, attachments: e.attachments }
      } else {
        push(s, { kind: 'user', text: e.text, attachments: e.attachments })
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
      // belong to the newly in_progress todo.
      const todos = todosFrom(e.name, e.input)
      if (todos) {
        s.todos = todos
        const active = todos.findIndex((t) => t.status === 'in_progress')
        s.activeTodo = active !== -1 ? active : s.activeTodo
      }
      const existing = s.byCall.get(e.callId)
      if (existing !== undefined) {
        // Early "tool started" chip being replaced with the full input.
        const b = s.blocks[existing] as Extract<Block, { kind: 'tool' }>
        s.blocks[existing] = { ...b, name: e.name, input: e.input ?? b.input }
      } else {
        s.byCall.set(
          e.callId,
          push(s, { kind: 'tool', callId: e.callId, name: e.name, input: e.input, subCount: 0 })
        )
      }
      break
    }
    case 'tool-result': {
      const idx = s.byCall.get(e.callId)
      if (idx !== undefined) {
        const b = s.blocks[idx] as Extract<Block, { kind: 'tool' }>
        s.blocks[idx] = { ...b, output: e.output, isError: e.isError }
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
    case 'turn-complete':
      if (e.costUsd !== undefined) s.costUsd = e.costUsd
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
