import { nanoid } from 'nanoid'
import type { AgentEvent, ToolPreview } from '@shared/events'
import type { DriverCtx } from '../types'
import type { HarnessEvent } from './types'

/**
 * HarnessEvent → AgentEvent. One translator per driver handle; the driver
 * feeds every engine event to push() and calls settleTurn() when its turn
 * promise resolves (session.ended does the same). Per turn it mints one
 * msgId and hands out blockIndex values so a text → tool → text turn folds
 * into distinct blocks; tool events fan out to tool-call (+ tool-result on
 * a terminal status); approvals get string ids the driver maps back to the
 * engine's numbers through approvalNumber().
 */

export interface ToolFace {
  title?: string
  kind?: string
  preview?: ToolPreview
}

export interface TranslatorOptions {
  /** Name for a tool the engine only describes by title/kind. Default:
   *  ACP kind → claude-style name, then the preview kind, then the
   *  title's first word. */
  toolName?: (tool: ToolFace) => string | undefined
  /** Input for a tool the engine sends none for (fx synthesizes one from
   *  its mined preview). Default: {}. */
  toolInput?: (tool: ToolFace) => unknown
}

export interface Translator {
  /** Feed one engine event. */
  push: (event: HarnessEvent) => void
  /** Open a turn and emit status running. Optional: the first content
   *  event opens a turn too, without the status. */
  beginTurn: () => void
  /** Finalize open blocks, then turn-complete + status idle — once per
   *  turn; a no-op when no turn is open. */
  settleTurn: () => void
  /** The engine's numeric id behind a requestId the UI answered; undefined
   *  once resolved or when unknown. */
  approvalNumber: (requestId: string) => number | undefined
}

const KIND_NAMES: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Grep',
  execute: 'Bash',
  think: 'Think',
  fetch: 'WebFetch'
}
const PREVIEW_NAMES: Record<ToolPreview['kind'], string> = {
  read: 'Read',
  write: 'Edit',
  shell: 'Bash',
  search: 'Grep'
}
const TERMINAL = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled', 'interrupted'])

interface ToolRec extends ToolFace {
  name: string
  input: unknown
  done: boolean
}

interface Block {
  kind: 'text' | 'thinking'
  index: number
  text: string
}

export function createTranslator(ctx: DriverCtx, opts: TranslatorOptions = {}): Translator {
  const emit = (event: AgentEvent): void => ctx.emit(event)
  const scope = nanoid(6)
  let approvalSeq = 0
  const approvals = new Map<string, number>()
  const approvalIds = new Map<number, string>()

  let turnOpen = false
  let msgId = ''
  let nextBlock = 0
  let block: Block | null = null
  const tools = new Map<string, ToolRec>()

  const nameFor = (tool: ToolFace): string =>
    opts.toolName?.(tool) ??
    (tool.kind ? KIND_NAMES[tool.kind] : undefined) ??
    (tool.preview ? PREVIEW_NAMES[tool.preview.kind] : undefined) ??
    tool.title?.trim().split(/\s+/)[0] ??
    'tool'

  const ensureTurn = (): void => {
    if (turnOpen) return
    turnOpen = true
    msgId = `msg-${nanoid(8)}`
    nextBlock = 0
    block = null
    tools.clear()
  }

  const closeBlock = (): void => {
    if (!block) return
    emit({
      type: block.kind === 'text' ? 'assistant-text' : 'thinking',
      text: block.text,
      delta: false,
      msgId,
      blockIndex: block.index
    })
    block = null
  }

  const delta = (kind: Block['kind'], text: string): void => {
    ensureTurn()
    if (block?.kind !== kind) {
      closeBlock()
      block = { kind, index: nextBlock++, text: '' }
    }
    block!.text += text
    emit({ type: kind === 'text' ? 'assistant-text' : 'thinking', text, delta: true, msgId, blockIndex: block!.index })
  }

  const emitTool = (callId: string, rec: ToolRec): void => {
    emit({ type: 'tool-call', callId, name: rec.name, input: rec.input, preview: rec.preview })
  }

  const tool = (ev: Extract<HarnessEvent, { type: 'tool.started' | 'tool.updated' }>): void => {
    ensureTurn()
    closeBlock()
    const prev = tools.get(ev.callId)
    const face: ToolFace = {
      title: ev.title ?? prev?.title,
      kind: ev.kind ?? prev?.kind,
      preview: ev.preview ?? prev?.preview
    }
    const rec: ToolRec = {
      ...face,
      name: nameFor(face),
      input: ev.input ?? prev?.input ?? opts.toolInput?.(face) ?? {},
      done: prev?.done ?? false
    }
    tools.set(ev.callId, rec)
    emitTool(ev.callId, rec)
    if (rec.done || !ev.status || !TERMINAL.has(ev.status)) return
    rec.done = true
    emit({
      type: 'tool-result',
      callId: ev.callId,
      output: rec.preview?.output ?? (ev.type === 'tool.updated' ? ev.detail : undefined) ?? '',
      isError: ev.status !== 'completed'
    })
  }

  const push = (ev: HarnessEvent): void => {
    switch (ev.type) {
      case 'session.started':
        return
      case 'session.ended':
        settleTurn()
        return
      case 'session.error':
        emit({ type: 'error', message: ev.message })
        return
      case 'session.providerBound':
        ctx.session.nativeId = ev.providerSessionId
        ctx.setNativeId(ev.providerSessionId)
        return
      case 'status':
        ensureTurn()
        emit({ type: 'status', status: 'running', detail: ev.text })
        return
      case 'message.delta':
        delta('text', ev.text)
        return
      case 'reasoning.delta':
        delta('thinking', ev.text)
        return
      case 'message.completed':
        if (block?.kind === 'text') closeBlock()
        return
      case 'reasoning.completed':
        if (block?.kind === 'thinking') closeBlock()
        return
      case 'tool.started':
      case 'tool.updated':
        tool(ev)
        return
      case 'approval.requested': {
        ensureTurn()
        const requestId = `${scope}-${++approvalSeq}`
        approvals.set(requestId, ev.requestId)
        approvalIds.set(ev.requestId, requestId)
        const face: ToolFace = { title: ev.title, kind: ev.kind, preview: ev.preview }
        emit({
          type: 'approval-request',
          requestId,
          toolName: nameFor(face),
          input: tools.get(ev.callId ?? '')?.input ?? opts.toolInput?.(face) ?? ev.preview ?? {},
          title: ev.title,
          callId: ev.callId
        })
        emit({ type: 'status', status: 'waiting', detail: 'awaiting approval' })
        return
      }
      case 'approval.resolved': {
        const requestId = approvalIds.get(ev.requestId)
        if (!requestId) return
        approvalIds.delete(ev.requestId)
        approvals.delete(requestId)
        emit({
          type: 'approval-resolved',
          requestId,
          allow: ev.decision === 'allow',
          auto: ev.decision === 'cancelled' ? true : undefined
        })
        emit({ type: 'status', status: 'running' })
        return
      }
      case 'plan':
        emit({ type: 'plan', text: ev.text })
        return
      case 'context':
        if (typeof ev.used === 'number') emit({ type: 'context', tokens: ev.used, window: ev.window })
        return
      default: {
        const never: never = ev
        throw new Error(`unhandled harness event ${String((never as { type: string }).type)}`)
      }
    }
  }

  const beginTurn = (): void => {
    ensureTurn()
    emit({ type: 'status', status: 'running' })
  }

  const settleTurn = (): void => {
    if (!turnOpen) return
    closeBlock()
    turnOpen = false
    emit({ type: 'turn-complete' })
    emit({ type: 'status', status: 'idle' })
  }

  return { push, beginTurn, settleTurn, approvalNumber: (id) => approvals.get(id) }
}
