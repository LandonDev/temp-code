import { beforeEach, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))

const { handleMessage, newStreamState, noteSend } = await import('./claude')

/**
 * The compaction lifecycle over the SDK stream: the CLI re-sends status
 * 'compacting' every 30 s while it compacts, and only the first is a start.
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
  noteSend(state)
})

const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage
const compacting = (): SDKMessage => msg({ type: 'system', subtype: 'status', status: 'compacting' })
const failed = (): SDKMessage => msg({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'too big' })
const boundary = (): SDKMessage =>
  msg({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 414_000, post_tokens: 3_600, duration_ms: 89_000 }
  })
const result = (): SDKMessage =>
  msg({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })

const phases = (): string[] => events.flatMap((e) => (e.type === 'compaction' ? [e.phase] : []))

it('three compacting statuses emit one start', () => {
  for (let i = 0; i < 3; i++) handleMessage(ctx, state, compacting())
  expect(phases()).toEqual(['start'])
})

it('the boundary emits done with the numbers', () => {
  handleMessage(ctx, state, compacting())
  handleMessage(ctx, state, compacting())
  handleMessage(ctx, state, boundary())
  expect(phases()).toEqual(['start', 'done'])
  expect(events.find((e) => e.type === 'compaction' && e.phase === 'done')).toMatchObject({
    trigger: 'auto',
    preTokens: 414_000,
    postTokens: 3_600,
    durationMs: 89_000
  })
})

it('a second compaction after done emits its own start', () => {
  handleMessage(ctx, state, compacting())
  handleMessage(ctx, state, boundary())
  handleMessage(ctx, state, compacting())
  handleMessage(ctx, state, compacting())
  expect(phases()).toEqual(['start', 'done', 'start'])
})

it('a failed result clears, so the next start emits', () => {
  handleMessage(ctx, state, compacting())
  handleMessage(ctx, state, failed())
  handleMessage(ctx, state, compacting())
  expect(phases()).toEqual(['start', 'failed', 'start'])
})

it('the turn ending with no boundary clears, so the next compaction starts fresh', () => {
  handleMessage(ctx, state, compacting())
  handleMessage(ctx, state, result())
  expect(state.compacting).toBe(false)
  state.working = true
  noteSend(state)
  handleMessage(ctx, state, compacting())
  expect(phases()).toEqual(['start', 'start'])
})
