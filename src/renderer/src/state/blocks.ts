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
      /** run settings stamped on the event by the server (newer logs only)
       *  — the board's pass history reads them off the round's opener */
      model?: string
      reasoning?: string
      context1m?: boolean
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
      /** connector wants reauthentication — url opens the fix */
      reauth?: { app: string; url: string }
      /** activity events from a subagent running under this call */
      subCount: number
    }
  | {
      kind: 'error'
      text: string
      /** settled by a Continue — the chip no longer renders */
      cleared?: boolean
    }
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
      /** goal lifecycle marker — slim system row, same family as settled
       *  compaction dividers; met is the completion moment */
      kind: 'goal'
      phase: 'set' | 'updated' | 'met' | 'cleared'
      condition: string
      iterations?: number
      reason?: string
      byModel?: boolean
    }
  | {
      kind: 'question'
      requestId: string
      questions: QuestionSpec[]
      resolved: boolean
      /** chosen labels per question; null once resolved = dismissed */
      answers?: string[][] | null
    }
  | {
      /** completed-turn pass marker — everything after it (until the pass's
       *  own turn-complete) carries the pass flag and renders highlighted */
      kind: 'pass'
      actions: string[]
    }
  | {
      /** a subagent's settle report went straight to the harness — this
       *  quiet marker is all the chat shows of it */
      kind: 'report'
      agentId: string
      title: string
      status: string
    }

/** `todo` = index of the todo that was in_progress when the block was born
 *  (-1 before the first todo list) — how the implementation view groups.
 *  `round` = which user request this block answers: a user message sent
 *  AFTER the previous turn completed starts a new round (steering messages
 *  mid-turn do not). Rounds keep follow-ups from bleeding into the old
 *  board — tasks, spans and token marks all scope to their round. */
export type Block = BlockKind & {
  id: string
  todo: number
  round: number
  ts?: number
  /** born during a completed-turn pass — renders set apart from turn work */
  pass?: boolean
}

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
  /** cumulative token snapshots keyed to the task active when they landed
   *  (M25) — per-task deltas derive from boundary pairs, never guesses */
  usageMarks: { round: number; todo: number; input?: number; output?: number }[]
  /** current round (0-based) — bumps when a user message opens a new turn */
  round: number
  /** a turn is open (user spoke, no turn-complete yet) — steering messages
   *  land inside it instead of starting a round */
  turnOpen: boolean
  sawUser: boolean
  /** inside a completed-turn pass — blocks born now get the pass flag */
  inPass: boolean
  /** todo list of each finished round, by round index — the follow-up
   *  archive the board renders as history */
  pastTodos: TodoItem[][]
  /** cumulative session cost when each round archived — per-pass cost is
   *  the difference between neighbors */
  pastCosts: (number | undefined)[]
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
    pendingUsers: [],
    usageMarks: [],
    round: 0,
    turnOpen: false,
    sawUser: false,
    inPass: false,
    pastTodos: [],
    pastCosts: []
  }
}

/** A user message arriving on a CLOSED turn starts a new round: the old
 *  board's todos archive, the active-task pointer resets (so the idle gap
 *  and the new turn's early work never bill to the last old task). A turn
 *  that died without its end events (app crash, kill) must not swallow the
 *  next request — long silence since the last block reads as a dead turn,
 *  not an open one. */
const STALE_TURN_MS = 10 * 60_000
/** How long an unfinished pass stays "warm" — a message within this window
 *  resumes it; after that it reads as abandoned and a new pass begins. */
const RESUME_WINDOW_MS = 30 * 60_000

function beginTurn(s: FoldState, ts?: number, newPass?: boolean): void {
  const lastTs = s.blocks.findLast((b) => b.ts !== undefined)?.ts
  const stale =
    s.turnOpen && lastTs !== undefined && ts !== undefined && ts - lastTs > STALE_TURN_MS
  // Explicit beats inferred: sends stamped with newPass (the board's pass
  // button, or its absence) decide directly — typing under the banner
  // keeps working in the current pass. Unstamped (legacy) sends fall back
  // to the inferred rules: a pass only ends when its WORK did — an
  // unfinished task list means the next message resumes this pass (a
  // continue after a stop or an error) while the pass is warm; colder
  // unfinished work reads as abandoned.
  const unfinished = s.todos.length > 0 && s.todos.some((t) => t.status !== 'completed')
  const gap = lastTs !== undefined && ts !== undefined ? ts - lastTs : 0
  const resuming = unfinished && gap <= RESUME_WINDOW_MS
  const wantNew =
    newPass !== undefined ? newPass && (!s.turnOpen || stale) : (!s.turnOpen || stale) && !resuming
  if (wantNew && s.sawUser) {
    s.pastTodos = [...s.pastTodos, s.todos]
    s.pastCosts = [...s.pastCosts, s.costUsd]
    s.todos = []
    s.activeTodo = -1
    s.round++
  }
  s.turnOpen = true
  s.sawUser = true
}

/** Show the user's message the instant they hit send — the server echoes
 *  the authoritative user-text event a round-trip later; foldEvent then
 *  claims this block instead of appending a duplicate. */
export function foldOptimisticUser(
  s: FoldState,
  text: string,
  attachments?: Attachment[],
  newPass?: boolean
): void {
  beginTurn(s, Date.now(), newPass)
  s.pendingUsers.push(push(s, { kind: 'user', text, attachments, pending: true }, Date.now()))
}

function push(s: FoldState, block: BlockKind, ts?: number): number {
  const id = String(s.nextId++)
  s.blocks.push({
    ...block,
    id,
    todo: s.activeTodo,
    round: s.round,
    ts,
    ...(s.inPass ? { pass: true } : {})
  })
  return s.blocks.length - 1
}

/** Normalize the two harness plan tools into one shape. Some models
 *  stringify the array — parse that too rather than dropping the list. */
function todosFrom(name: string, input: unknown): TodoItem[] | null {
  const obj = input as { todos?: unknown; plan?: unknown } | null
  let raw = name === 'TodoWrite' ? obj?.todos : name === 'update_plan' ? obj?.plan : null
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
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
      // Run settings stamped by the server (newer logs) ride the event.
      const stamp = e as {
        model?: string
        reasoning?: string
        context1m?: boolean
        newPass?: boolean
      }
      const meta = {
        model: stamp.model,
        reasoning: stamp.reasoning,
        context1m: stamp.context1m
      }
      const pending = s.pendingUsers.shift()
      if (pending !== undefined && s.blocks[pending]?.kind === 'user') {
        // The optimistic push already ran beginTurn — just claim the block.
        const b = s.blocks[pending] as Extract<Block, { kind: 'user' }>
        s.blocks[pending] = {
          ...b,
          text: e.text,
          attachments: e.attachments,
          pending: undefined,
          ts: ts ?? b.ts,
          ...meta
        }
      } else {
        beginTurn(s, ts, stamp.newPass)
        push(s, { kind: 'user', text: e.text, attachments: e.attachments, ...meta }, ts)
      }
      break
    }
    case 'status':
      // Logged end-of-turn signals close the turn even when the
      // turn-complete event itself was lost (crash between the two).
      if (e.status === 'idle' || e.status === 'error') {
        s.turnOpen = false
        s.inPass = false
      }
      break
    case 'turn-pass':
      // The completed-turn pass opens here; blocks fold as pass work
      // until its turn-complete (or a status end) closes it.
      push(s, { kind: 'pass', actions: e.actions }, ts)
      s.inPass = true
      break
    case 'agent-report':
      push(s, { kind: 'report', agentId: e.agentId, title: e.title, status: e.status }, ts)
      break
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
        s.blocks[idx] = { ...b, output: e.output, isError: e.isError, doneTs: ts, reauth: e.reauth }
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
    case 'goal':
      // Every phase appends its own row — the log reads as history:
      // set, the end-of-turn checks, then met/cleared.
      push(
        s,
        {
          kind: 'goal',
          phase: e.phase,
          condition: e.condition,
          iterations: e.iterations,
          reason: e.reason,
          byModel: e.byModel
        },
        ts
      )
      break
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
    case 'usage': {
      // Cumulative counter snapshot — one mark per (round, task), latest wins.
      const mark = {
        round: s.round,
        todo: s.activeTodo,
        input: e.inputTokens,
        output: e.outputTokens
      }
      const last = s.usageMarks.at(-1)
      if (last && last.todo === s.activeTodo && last.round === s.round) {
        s.usageMarks[s.usageMarks.length - 1] = mark
      } else s.usageMarks.push(mark)
      break
    }
    case 'turn-complete':
      s.turnOpen = false
      s.inPass = false
      if (e.costUsd !== undefined) s.costUsd = e.costUsd
      if (e.inputTokens !== undefined || e.outputTokens !== undefined) {
        const mark = {
          round: s.round,
          todo: s.activeTodo,
          input: e.inputTokens,
          output: e.outputTokens
        }
        const last = s.usageMarks.at(-1)
        if (last && last.todo === s.activeTodo && last.round === s.round) {
          s.usageMarks[s.usageMarks.length - 1] = mark
        } else s.usageMarks.push(mark)
      }
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
    case 'errors-cleared':
      // Continue settled every error shown so far — the chips disappear.
      for (let i = 0; i < s.blocks.length; i++) {
        const b = s.blocks[i]
        if (b.kind === 'error' && !b.cleared) s.blocks[i] = { ...b, cleared: true }
      }
      break
    // status / agent-spawned drive the sidebar, not the transcript
  }
}

export function foldAll(rows: EventRow[]): FoldState {
  const s = emptyFold()
  for (const r of rows) foldEvent(s, r.event, r.ts)
  return s
}
