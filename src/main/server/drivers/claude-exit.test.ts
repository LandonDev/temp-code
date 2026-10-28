import { beforeEach, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))
const { aliveOf, handleMessage, newStreamState, settleStreamEnd } = await import('./claude')

/**
 * The stream's end (drivers/claude.ts settleStreamEnd): what the driver
 * emits when the CLI process is gone, by what was open at the time. The
 * drain loop calls it at its end and in its catch; the SDK throws
 * "Claude Code process terminated by signal SIGKILL" into the catch when
 * the process is killed.
 */
let events: AgentEvent[]
let gone: number
let ctx: DriverCtx
let state: ReturnType<typeof newStreamState>
beforeEach(() => {
  events = []
  gone = 0
  ctx = {
    session: { context1m: false } as SessionMeta,
    emit: (e) => events.push(e),
    setNativeId: () => {},
    requestApproval: async () => false,
    harnessGone: () => {
      gone += 1
    }
  }
  state = newStreamState()
})

const killed = new Error('Claude Code process terminated by signal SIGKILL')
const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage
/** A turn that ended with one live task: the thread watches it. */
const watchOne = (): void => {
  state.working = true
  handleMessage(ctx, state, msg({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', description: 'bun test --watch', task_type: 'local_bash' }] }))
  handleMessage(ctx, state, msg({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }))
  expect(state.watching).toBe(true)
  expect(state.working).toBe(false)
  events.length = 0
}

it('killed while watching with no turn open: the tasks are emptied and the registry is told, no error row', () => {
  watchOne()
  settleStreamEnd(ctx, state, killed)
  expect(events).toEqual([{ type: 'background-tasks', tasks: [], items: [] }])
  expect(gone).toBe(1)
  expect(state.watching).toBe(false)
})

it('killed mid-turn: the error with the words and an error status, the registry not told', () => {
  state.working = true
  settleStreamEnd(ctx, state, killed)
  expect(events).toEqual([
    { type: 'error', message: 'Claude Code process terminated by signal SIGKILL' },
    { type: 'status', status: 'error' }
  ])
  expect(gone).toBe(0)
  expect(state.working).toBe(false)
})

it('a quiet end mid-turn reads as the stream ending, then idle', () => {
  state.working = true
  settleStreamEnd(ctx, state)
  expect(events).toEqual([
    { type: 'error', message: 'harness stream ended mid-turn' },
    { type: 'status', status: 'idle' }
  ])
  expect(gone).toBe(0)
})

it('a context without the callback idles a watching thread itself', () => {
  ctx.harnessGone = undefined
  watchOne()
  settleStreamEnd(ctx, state, killed)
  expect(events).toEqual([
    { type: 'background-tasks', tasks: [], items: [] },
    { type: 'status', status: 'idle' }
  ])
})

it('killed between turns with nothing open: the registry is told and no row is written', () => {
  settleStreamEnd(ctx, state, killed)
  expect(events).toEqual([])
  expect(gone).toBe(1)
})

it("a result the CLI ended itself carries its first error line; one without reads the subtype alone", () => {
  state.working = true
  handleMessage(ctx, state, msg({ type: 'result', subtype: 'error_during_execution', errors: ['  ', 'Invalid tool input\nsecond line'], total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }))
  expect(events).toEqual([
    { type: 'error', message: 'turn ended: error_during_execution: Invalid tool input' },
    { type: 'status', status: 'idle' }
  ])
  events.length = 0
  state.working = true
  handleMessage(ctx, state, msg({ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }))
  expect(events[0]).toEqual({ type: 'error', message: 'turn ended: error_max_turns' })
})

it('aliveOf reads a signal from outside as the process gone', () => {
  expect(aliveOf(false, { exitCode: null, signalCode: 'SIGKILL', killed: false })).toBe(false)
  expect(aliveOf(false, { exitCode: null, signalCode: null, killed: false })).toBe(true)
})
