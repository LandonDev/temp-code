import { beforeEach, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))

const { handleMessage, newStreamState, postToolUseHooks, returnWhispers, settleStreamEnd, whisperHookOutput, whisperInto } = await import('./claude')

/**
 * A host line (DriverHandle.whisper) reaches the model only inside the open
 * turn, through the next tool's PostToolUse additionalContext; it never
 * rides the input stream, where a line the CLI read after its result ran as
 * a turn of its own and kept a thread looping on update_notes. Whatever the
 * turn ended without reading goes back to the registry.
 */

let events: AgentEvent[]
let returned: string[][]
let ctx: DriverCtx
let state: ReturnType<typeof newStreamState>

beforeEach(() => {
  events = []
  returned = []
  ctx = {
    session: { context1m: false } as SessionMeta,
    emit: (e) => events.push(e),
    setNativeId: () => {},
    requestApproval: async () => false,
    returnWhispers: (texts) => returned.push(texts)
  }
  state = newStreamState()
  state.working = true
})

const result = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as SDKMessage

it("a line pushed mid-turn lands in the next tool's additionalContext, once", () => {
  expect(whisperInto(state, '<notes-reminder reason="context">x</notes-reminder>')).toBe(true)
  expect(whisperInto(state, '<dev-server>y</dev-server>')).toBe(true)
  expect(whisperHookOutput(state)).toEqual({
    continue: true,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '<notes-reminder reason="context">x</notes-reminder>\n\n<dev-server>y</dev-server>' }
  })
  expect(whisperHookOutput(state)).toEqual({ continue: true })
})

it('the whisper hook runs on every tool, an mcp__app__ tool too, and the dev-server tail stays on Bash', async () => {
  const bashTail = vi.fn(async () => ({ continue: true }))
  whisperInto(state, 'line')
  const hooks = postToolUseHooks(bashTail, async () => whisperHookOutput(state))
  expect(hooks).toHaveLength(2)
  expect(hooks[0].matcher).toBe('Bash')
  expect(hooks[0].hooks).toEqual([bashTail])
  // No matcher: the SDK runs it for mcp__app__update_notes as for Read.
  expect(hooks[1].matcher).toBeUndefined()
  const out = await hooks[1].hooks[0]({ tool_name: 'mcp__app__update_notes' })
  expect(out).toMatchObject({ hookSpecificOutput: { additionalContext: 'line' } })
})

it('with no turn open the driver refuses the line', () => {
  state.working = false
  expect(whisperInto(state, 'late')).toBe(false)
  expect(state.pendingWhispers).toEqual([])
})

it("a line pending at the turn's result comes back to the registry", () => {
  whisperInto(state, 'unread')
  handleMessage(ctx, state, result())
  expect(returned).toEqual([['unread']])
  expect(state.pendingWhispers).toEqual([])
  expect(events.some((e) => e.type === 'turn-complete')).toBe(true)
})

it('a line pending when the stream fails or ends comes back too', () => {
  whisperInto(state, 'a')
  settleStreamEnd(ctx, state, new Error('boom'))
  expect(returned).toEqual([['a']])
  state.working = true
  whisperInto(state, 'b')
  settleStreamEnd(ctx, state)
  expect(returned).toEqual([['a'], ['b']])
})

it('a dispose hands back what is pending, and nothing twice', () => {
  whisperInto(state, 'c')
  returnWhispers(ctx, state)
  returnWhispers(ctx, state)
  expect(returned).toEqual([['c']])
})
