import { beforeEach, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { CATALOG } from '@shared/catalog'
import type { SendPhase } from '../sendSpans'
import type { DriverCtx } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))

const { cacheNote, claudeExtraArgs, handleMessage, newStreamState, noteSend, phaseAfterInit, THINKING_DISPLAY } = await import('./claude')

/**
 * The first response: thinking streams as a summary, the wait before it is
 * named (waiting-provider from init to the model's message_start), and the
 * send span marks `model` with the cache's word. Driven through
 * handleMessage with a capturing ctx, no CLI.
 */

let events: AgentEvent[]
let marks: { phase: SendPhase; note?: string }[]
let ctx: DriverCtx
let state: ReturnType<typeof newStreamState>

beforeEach(() => {
  events = []
  marks = []
  ctx = {
    session: { context1m: false } as SessionMeta,
    emit: (e) => events.push(e),
    setNativeId: () => {},
    requestApproval: async () => false,
    mark: (phase, note) => marks.push({ phase, ...(note ? { note } : {}) })
  }
  state = newStreamState()
})

const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage
const init = (): SDKMessage => msg({ type: 'system', subtype: 'init', session_id: 'n1' })
const stream = (event: Record<string, unknown>, lane: string | null = null): SDKMessage =>
  msg({ type: 'stream_event', parent_tool_use_id: lane, event })
const messageStart = (usage: Record<string, number>, lane: string | null = null): SDKMessage =>
  stream({ type: 'message_start', message: { id: 'm1', usage } }, lane)
const thinking = (text: string): SDKMessage =>
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } })
const phases = (): unknown[] => events.flatMap((e) => (e.type === 'phase' ? [e.phase] : []))
const sendTurn = (): void => {
  state.working = true
  noteSend(state)
}

it('every catalog model is spawned with summarized thinking, beside its settings', () => {
  expect(THINKING_DISPLAY).toBe('summarized')
  for (const model of CATALOG.claude.models) {
    for (const context1m of [false, true]) {
      const args = claudeExtraArgs({ model: model.id, context1m })
      expect(args['thinking-display']).toBe('summarized')
      expect(JSON.parse(args.settings).autoCompactEnabled).toBe(!context1m)
    }
  }
})

it('a thinking delta clears an open phase and is the first content', () => {
  sendTurn()
  state.phase = 'retrying'
  handleMessage(ctx, state, thinking('Weighing the two options'))
  expect(phases()).toEqual([null])
  expect(state.phase).toBeNull()
  expect(marks.map((m) => m.phase)).toContain('first-content')
  expect(events).toContainEqual(expect.objectContaining({ type: 'thinking', text: 'Weighing the two options', delta: true }))
})

it("after the CLI's init a sent message waits for the provider until the model's message_start", () => {
  sendTurn()
  state.phase = 'cli-starting'
  handleMessage(ctx, state, init())
  expect(phases()).toEqual(['waiting-provider'])
  // A subagent's lane is not the model taking this turn's request.
  handleMessage(ctx, state, messageStart({ input_tokens: 10 }, 'call-1'))
  expect(state.phase).toBe('waiting-provider')
  handleMessage(ctx, state, messageStart({ input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 90_000 }))
  expect(phases()).toEqual(['waiting-provider', null])
  expect(marks).toContainEqual({ phase: 'model', note: 'hit' })
})

it("an eager boot's init with nothing sent names no wait", () => {
  state.phase = 'cli-starting'
  handleMessage(ctx, state, init())
  expect(phases()).toEqual([null])
  expect(phaseAfterInit(state)).toBeNull()
})

it("a retry in flight at init keeps the retry's words", () => {
  sendTurn()
  state.phase = 'retrying'
  handleMessage(ctx, state, init())
  expect(phases()).toEqual([])
  expect(state.phase).toBe('retrying')
})

it("the model mark is the top lane's alone, with the cache's word", () => {
  sendTurn()
  handleMessage(ctx, state, messageStart({ input_tokens: 9 }, 'call-1'))
  expect(marks.filter((m) => m.phase === 'model')).toEqual([])
  handleMessage(ctx, state, messageStart({ input_tokens: 2_000, cache_creation_input_tokens: 86_000, cache_read_input_tokens: 4_000 }))
  expect(marks.filter((m) => m.phase === 'model')).toEqual([{ phase: 'model', note: 'miss 88k' }])
})

it('cacheNote: hit when the read covers the prompt, miss with the uncached thousands, nothing without usage', () => {
  expect(cacheNote({ input_tokens: 5, cache_read_input_tokens: 40_000 })).toBe('hit')
  expect(cacheNote({ input_tokens: 400, cache_creation_input_tokens: 151_600 })).toBe('miss 152k')
  expect(cacheNote({ input_tokens: 0 })).toBeUndefined()
  expect(cacheNote(undefined)).toBeUndefined()
})
