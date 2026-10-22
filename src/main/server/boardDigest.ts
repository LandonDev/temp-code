import type { BatchBoard, BatchState, BoardDigest, BoardTodo } from '@shared/contract-batch'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import { stateLine } from '@shared/notes'
import type { Store } from './db'
import type { SessionRegistry } from './sessions'

/**
 * A master's board in one answer (`batch.board`, contract-batch.ts): the
 * children on this host, a digest per child, the batch's state. A digest
 * is what a row shows beyond the meta, read from what this host already
 * keeps: the task list from the registry's task fold, the State line from
 * the notes mirror, the failure from the meta, and two lines this module
 * folds itself from the rows as they are appended (`registry.onEvent`):
 * the child's last words and the question it waits on. A child first seen
 * here reads those two from its newest rows once, on the reader worker.
 *
 * While a socket watches the master (boardWatch.ts), a child whose digest
 * may have moved (a row, a meta push, a notes edit) is looked at again at
 * most every BOARD_PUSH_MS, and a digest that changed goes out as one
 * `board` push. The board never loads a transcript, polls a context or
 * reads a notes file.
 */

/** How often at most one child's digest is looked at again while its master is watched. */
export const BOARD_PUSH_MS = 250
/** How many of a child's newest rows the first read looks through for its last words and an open question. */
export const BOARD_TAIL_ROWS = 400
/** The row types the tail read keeps (the rest cannot move the two lines). */
export const BOARD_TAIL_TYPES = ['assistant-text', 'question-request', 'question-resolved'] as const

export interface BoardPush {
  masterId: string
  sessionId: string
  digest: BoardDigest
}

export interface BoardDigestsDeps {
  /** The master's unarchived root threads here, decorated, oldest first (registry.batchChildren). */
  children(masterId: string): SessionMeta[]
  /** One thread's decorated meta (registry.get): the flush reads only the children that moved. */
  meta(sessionId: string): SessionMeta | null
  /** The master of a root batch thread here; null for anything else (the registry's index, no read). */
  masterOf(sessionId: string): string | null
  /** The thread's current task list from the registry's fold; null before one. */
  todos(sessionId: string): readonly { status: string; name: string }[] | null
  /** The notes mirror's text (the session_notes row), never the file. */
  notesText(sessionId: string): string | null
  /** The newest rows of BOARD_TAIL_TYPES within the last BOARD_TAIL_ROWS, oldest first, read off the loop. */
  readTail(sessionId: string): Promise<EventRow[]>
  /** Whether any socket watches the master now. */
  watched(masterId: string): boolean
  onEvent?(listener: (row: EventRow) => void): () => void
  onMeta?(listener: (meta: SessionMeta) => void): () => void
  onNotes?(listener: (sessionId: string, text: string) => void): () => void
  pushEveryMs?: number
}

/** The two lines folded from the rows, and the seq they stand at. */
interface Lines {
  seq: number
  last?: string
  /** unresolved question requests, oldest first: requestId → the first question */
  questions: Map<string, string>
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''

const TODO_STATUS = new Set<BoardTodo['status']>(['pending', 'in_progress', 'completed'])

/** Fold one row into the lines; true when it moved them. */
export function foldLines(lines: Lines, event: AgentEvent, seq: number): boolean {
  if (seq <= lines.seq) return false
  lines.seq = seq
  if ('parentCallId' in event && event.parentCallId) return false
  switch (event.type) {
    case 'assistant-text': {
      if (event.delta) return false
      const line = firstLine(event.text)
      if (!line || line === lines.last) return false
      lines.last = line
      return true
    }
    case 'question-request':
      lines.questions.set(event.requestId, firstLine(event.questions[0]?.question ?? ''))
      return true
    case 'question-resolved':
      return lines.questions.delete(event.requestId)
    default:
      return false
  }
}

const isStreamed = (event: AgentEvent): boolean =>
  (event.type === 'assistant-text' && event.delta) || (event.type === 'tool-call' && !!event.partial) || event.type === 'thinking'

export class BoardDigests {
  private readonly lines = new Map<string, Lines>()
  /** first reads in flight, with the rows appended meanwhile */
  private readonly reading = new Map<string, { done: Promise<void>; live: EventRow[] }>()
  private readonly states = new Map<string, string | null>()
  /** the digest last pushed per child (JSON), so an unchanged one is never sent */
  private readonly sent = new Map<string, string>()
  /** children to look at again: sessionId → its master */
  private readonly dirty = new Map<string, string>()
  private readonly listeners = new Set<(push: BoardPush) => void>()
  private readonly pushEveryMs: number
  private timer: NodeJS.Timeout | null = null
  private detach: (() => void) | null = null

  constructor(private readonly deps: BoardDigestsDeps) {
    this.pushEveryMs = deps.pushEveryMs ?? BOARD_PUSH_MS
  }

  onPush(listener: (push: BoardPush) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Follow the registry: rows fold into the lines, and a watched master's child that moved is looked at again. */
  attach(): () => void {
    if (this.detach) return this.detach
    const offs = [
      this.deps.onEvent?.((row) => this.onRow(row)),
      this.deps.onMeta?.((meta) => {
        if (meta.masterId && !meta.parentId) this.touch(meta.id, meta.masterId)
      }),
      this.deps.onNotes?.((sessionId, text) => {
        if (!this.states.has(sessionId) && !this.deps.masterOf(sessionId)) return
        this.states.set(sessionId, stateLine(text))
        const master = this.deps.masterOf(sessionId)
        if (master) this.touch(sessionId, master)
      })
    ]
    this.detach = () => {
      for (const off of offs) off?.()
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.detach = null
    }
    return this.detach
  }

  /** The board: the children here, their digests, the batch's state. */
  async board(masterId: string, state: BatchState): Promise<BatchBoard> {
    await Promise.all(this.deps.children(masterId).map((c) => this.ensureLines(c.id)))
    // Read again after the reads: a child may have joined, left or moved meanwhile.
    const children = this.deps.children(masterId)
    const digests: Record<string, BoardDigest> = {}
    for (const child of children) digests[child.id] = this.digest(child)
    return { children, digests, state }
  }

  /** One child's digest as the board shows it now. */
  digest(meta: SessionMeta): BoardDigest {
    const out: BoardDigest = {}
    const todos = this.deps.todos(meta.id)
    if (todos?.length) {
      out.todos = todos.map((t) => ({
        content: t.name,
        status: TODO_STATUS.has(t.status as BoardTodo['status']) ? (t.status as BoardTodo['status']) : 'pending'
      }))
    }
    const lines = this.lines.get(meta.id)
    if (lines?.last) out.last = lines.last
    const state = this.stateOf(meta.id)
    if (state) out.state = state
    if (meta.status === 'waiting' && lines?.questions.size) {
      const question = [...lines.questions.values()].at(-1)
      if (question) out.question = question
    }
    if (meta.failure?.summary) out.failure = meta.failure.summary
    return out
  }

  /** Look at every child waiting now and push the digests that changed (tests call it to skip the wait). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const due = [...this.dirty]
    this.dirty.clear()
    for (const [sessionId, masterId] of due) {
      if (!this.deps.watched(masterId)) continue
      const meta = this.deps.meta(sessionId)
      if (!meta || meta.masterId !== masterId || meta.parentId || meta.archived) continue
      const digest = this.digest(meta)
      const json = JSON.stringify(digest)
      if (this.sent.get(sessionId) === json) continue
      this.sent.set(sessionId, json)
      for (const l of this.listeners) l({ masterId, sessionId, digest })
    }
  }

  /** A child left the host (deleted, moved): its lines go. */
  forget(sessionIds: readonly string[]): void {
    for (const id of sessionIds) {
      this.lines.delete(id)
      this.states.delete(id)
      this.sent.delete(id)
      this.dirty.delete(id)
    }
  }

  private onRow(row: EventRow): void {
    const reading = this.reading.get(row.sessionId)
    if (reading) reading.live.push(row)
    else {
      const lines = this.lines.get(row.sessionId)
      if (lines) foldLines(lines, row.event, row.seq)
    }
    if (isStreamed(row.event)) return
    const master = this.deps.masterOf(row.sessionId)
    if (!master || !this.deps.watched(master)) return
    if (this.lines.has(row.sessionId)) this.touch(row.sessionId, master)
    // A read in flight, or a child that joined while its master was on
    // screen (its tail is read now, this row with it): looked at once it is in.
    else void this.ensureLines(row.sessionId).then(() => this.touch(row.sessionId, master))
  }

  private touch(sessionId: string, masterId: string): void {
    if (!this.deps.watched(masterId)) return
    this.dirty.set(sessionId, masterId)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.pushEveryMs)
    this.timer.unref?.()
  }

  private stateOf(sessionId: string): string | null {
    if (!this.states.has(sessionId)) this.states.set(sessionId, stateLine(this.deps.notesText(sessionId) ?? ''))
    return this.states.get(sessionId) ?? null
  }

  /** The two lines for a child, read from its newest rows the first time. */
  private ensureLines(sessionId: string): Promise<void> {
    if (this.lines.has(sessionId)) return Promise.resolve()
    const pending = this.reading.get(sessionId)
    if (pending) return pending.done
    const live: EventRow[] = []
    const done = this.deps
      .readTail(sessionId)
      .catch(() => [] as EventRow[])
      .then((rows) => {
        const lines: Lines = { seq: 0, questions: new Map() }
        for (const row of rows) foldLines(lines, row.event, row.seq)
        for (const row of live) foldLines(lines, row.event, row.seq)
        this.lines.set(sessionId, lines)
        this.reading.delete(sessionId)
      })
    this.reading.set(sessionId, { done, live })
    return done
  }
}

/** The digests over this host's registry and store, as server/index.ts
 *  wires them (the proof scripts use the same). Call `attach()` to follow. */
export function hostBoardDigests(
  registry: Pick<SessionRegistry, 'batchChildren' | 'get' | 'batchMasterOf' | 'todoListOf' | 'onEvent' | 'onMeta' | 'notes'>,
  store: Pick<Store, 'getSessionNotes' | 'readRows' | 'lastSeq'>,
  watched: (masterId: string) => boolean
): BoardDigests {
  return new BoardDigests({
    children: (masterId) => registry.batchChildren(masterId),
    meta: (sessionId) => registry.get(sessionId),
    masterOf: (sessionId) => registry.batchMasterOf(sessionId),
    todos: (sessionId) => registry.todoListOf(sessionId),
    notesText: (sessionId) => store.getSessionNotes(sessionId)?.text ?? null,
    readTail: (sessionId) =>
      store.readRows(sessionId, {
        afterSeq: Math.max(0, store.lastSeq(sessionId) - BOARD_TAIL_ROWS),
        limit: BOARD_TAIL_ROWS,
        whereSql: `json_extract(payload, '$.type') IN (${BOARD_TAIL_TYPES.map((t) => `'${t}'`).join(', ')})`
      }),
    watched,
    onEvent: (listener) => registry.onEvent(listener),
    onMeta: (listener) => registry.onMeta(listener),
    onNotes: (listener) => registry.notes.onChange((sessionId, doc) => listener(sessionId, doc.text))
  })
}
