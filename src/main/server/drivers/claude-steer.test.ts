import { beforeEach, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))

const { handleMessage, newStreamState } = await import('./claude')

/**
 * A steer's read signal: the CLI lists the client uuids a turn consumed
 * (`user_message_uuids`) on the frame after a mid-turn fold, and on the
 * first frames of the turn a late steer starts (probed on CLI 2.1.303).
 * Driven through handleMessage with a capturing ctx, no CLI.
 */

let events: AgentEvent[]
let ctx: DriverCtx
let state: ReturnType<typeof newStreamState>

beforeEach(() => {
  events = []
  ctx = {
    session: { context1m: false } as SessionMeta,
    emit: (e) => events.push(e),
    setNativeId: () => {},
    requestApproval: async () => false
  }
  state = newStreamState()
  state.working = true
})

const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage
const status = (uuids: string[]): SDKMessage => msg({ type: 'system', subtype: 'status', user_message_uuids: uuids })
const assistant = (uuid?: string, parent: string | null = null): SDKMessage =>
  msg({
    type: 'assistant',
    message: { id: 'm1', model: 'claude', content: [{ type: 'text', text: 'ok' }], usage: {} },
    parent_tool_use_id: parent,
    ...(uuid ? { user_message_uuid: uuid } : {})
  })
const result = (uuids: string[] = []): SDKMessage =>
  msg({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, user_message_uuids: uuids })
const steers = () => events.filter((e) => e.type === 'steer')

it('a steer folded into the running turn is received in-turn, once', () => {
  state.steers.set('s1', { afterResult: false })
  handleMessage(ctx, state, assistant('first'))
  expect(steers()).toEqual([])
  handleMessage(ctx, state, status(['first', 's1']))
  handleMessage(ctx, state, result(['first', 's1']))
  expect(steers()).toEqual([{ type: 'steer', steerId: 's1', state: 'received', how: 'in-turn' }])
  expect(state.steers.size).toBe(0)
})

it('a steer the turn ended without reading is received as the next turn', () => {
  state.steers.set('s1', { afterResult: false })
  handleMessage(ctx, state, result(['first']))
  expect(steers()).toEqual([])
  state.working = true
  handleMessage(ctx, state, status(['s1']))
  expect(steers()).toEqual([{ type: 'steer', steerId: 's1', state: 'received', how: 'next-turn' }])
})

it('the single user_message_uuid stamps too, from an older CLI', () => {
  state.steers.set('s1', { afterResult: false })
  handleMessage(ctx, state, assistant('s1'))
  expect(steers()).toEqual([{ type: 'steer', steerId: 's1', state: 'received', how: 'in-turn' }])
})

it('an unknown uuid, a subagent frame and a plain send never stamp', () => {
  handleMessage(ctx, state, status(['someone-else']))
  state.steers.set('s1', { afterResult: false })
  handleMessage(ctx, state, assistant('s1', 'toolu_parent'))
  handleMessage(ctx, state, status(['other']))
  expect(steers()).toEqual([])
  expect(state.steers.has('s1')).toBe(true)
})
