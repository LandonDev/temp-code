import type { AgentEvent, EventRow } from '@shared/events'

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

export type Block =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'thinking'; text: string; streaming: boolean }
  | {
      id: string
      kind: 'tool'
      callId: string
      name: string
      input: unknown
      output?: string
      isError?: boolean
      /** activity events from a subagent running under this call */
      subCount: number
    }
  | { id: string; kind: 'error'; text: string }
  | {
      id: string
      kind: 'approval'
      requestId: string
      toolName: string
      input: unknown
      title?: string
      resolved: boolean
      allow?: boolean
      auto?: boolean
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
}

export function emptyFold(): FoldState {
  return { blocks: [], byKey: new Map(), byCall: new Map(), byRequest: new Map(), nextId: 1 }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function push(s: FoldState, block: DistributiveOmit<Block, 'id'>): number {
  const id = String(s.nextId++)
  s.blocks.push({ ...block, id } as Block)
  return s.blocks.length - 1
}

function foldText(
  s: FoldState,
  kind: 'assistant' | 'thinking',
  e: { text: string; delta: boolean; msgId?: string; blockIndex?: number }
): void {
  const key = e.msgId !== undefined && e.blockIndex !== undefined ? `${e.msgId}:${e.blockIndex}` : null
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
    const newIdx = push(s, { kind, text: e.text, streaming: e.delta })
    if (key) s.byKey.set(key, newIdx)
    return
  }
  const cur = s.blocks[idx] as Extract<Block, { kind: 'assistant' | 'thinking' }>
  s.blocks[idx] = e.delta
    ? { ...cur, text: cur.text + e.text }
    : { ...cur, text: e.text, streaming: false }
}

/** Fold one event into the state. Mutates the state; changed block objects
 *  are replaced (never mutated) so memoized rows re-render correctly. */
export function foldEvent(s: FoldState, e: AgentEvent): void {
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
    case 'user-text':
      push(s, { kind: 'user', text: e.text })
      break
    case 'assistant-text':
      foldText(s, 'assistant', e)
      break
    case 'thinking':
      foldText(s, 'thinking', e)
      break
    case 'tool-call': {
      const existing = s.byCall.get(e.callId)
      if (existing !== undefined) {
        // Early "tool started" chip being replaced with the full input.
        const b = s.blocks[existing] as Extract<Block, { kind: 'tool' }>
        s.blocks[existing] = { ...b, name: e.name, input: e.input ?? b.input }
      } else {
        s.byCall.set(e.callId, push(s, { kind: 'tool', callId: e.callId, name: e.name, input: e.input, subCount: 0 }))
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
  for (const r of rows) foldEvent(s, r.event)
  return s
}
