import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { CATALOG } from '@shared/catalog'
import type { SendPhase } from '../sendSpans'
import type { DriverCtx, DriverHandle } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn()
}))
vi.mock('./binaries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./binaries')>()),
  resolveClaude: async () => ({ path: null })
}))
vi.mock('../endpoint', () => ({ routedEndpointFor: async () => ({ url: null }) }))

const { claudeDriver, cacheNote, claudeExtraArgs, handleMessage, metaClaudeEnv, newStreamState, noteSend, phaseAfterInit, THINKING_DISPLAY } = await import('./claude')

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

it('a Meta row runs the CLI in token mode with every alias pinned to Meta; an Anthropic row adds nothing', () => {
  expect(metaClaudeEnv({ provider: 'claude', model: 'muse-wonder-1.0' })).toEqual({
    ANTHROPIC_AUTH_TOKEN: 'routed',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'muse-spark-1.3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'muse-spark-1.3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'muse-wonder-1.0',
    CLAUDE_CODE_SUBAGENT_MODEL: 'muse-wonder-1.0',
    ENABLE_TOOL_SEARCH: 'true'
  })
  expect(metaClaudeEnv({ provider: 'claude', model: 'muse-spark-1.3' }).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('muse-spark-1.3')
  expect(metaClaudeEnv({ provider: 'claude', model: 'claude-opus-5-5' })).toEqual({})
  // The key itself never appears: `routed` is the placeholder the gateway replaces.
  expect(JSON.stringify(metaClaudeEnv({ provider: 'claude', model: 'muse-wonder-1.0' }))).not.toMatch(/LLM_/)
  // The ladder the CLI takes: minimal is not on it, so a Meta row under claude never lists it.
  for (const model of CATALOG.claude.models.filter((m) => m.vendor === 'meta')) expect(model.reasoning).not.toContain('minimal')
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

// Capture the SDK callbacks; closing its input ends the fake stream on dispose.
const handles: DriverHandle[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose()
})

async function startDriver() {
  vi.mocked(query).mockImplementation(({ prompt }) => (async function* () {
    if (typeof prompt !== 'string') for await (const _message of prompt) { /* No CLI output. */ }
  })() as ReturnType<typeof query>)
  const handle = await claudeDriver.start({
    ...ctx,
    session: { id: 'claude-replies', provider: 'claude', cwd: '/repo', model: 'claude-opus-5-5', reasoning: 'high', permission: 'safe', context1m: false, nativeId: null } as SessionMeta
  })
  handles.push(handle)
  return { handle, options: vi.mocked(query).mock.calls.at(-1)![0].options! }
}

it.each([
  ['The person is away. Decide yourself.', 'The person is away. Decide yourself.'],
  [undefined, 'Denied in temp-code']
])('a denied approval sends the reason %s or the default message to Claude', async (reason, message) => {
  const { handle, options } = await startDriver()
  const pending = options.canUseTool!('Bash', { command: 'rm -rf build' }, {
    requestId: 'approval-1', toolUseID: 'call-1', signal: new AbortController().signal
  })
  expect(handle.approve!('unknown', false, reason)).toBe(false)
  expect(handle.approve!('approval-1', false, reason)).toBe(true)
  await expect(pending).resolves.toEqual({ behavior: 'deny', message })
  expect(handle.approve!('approval-1', false, reason)).toBe(false)
})

it("an allow from the host (Away answering for the person) runs the tool", async () => {
  const { handle, options } = await startDriver()
  const pending = options.canUseTool!('Bash', { command: 'rm -rf build' }, {
    requestId: 'approval-1', toolUseID: 'call-1', signal: new AbortController().signal
  })
  expect(handle.approve!('approval-1', true)).toBe(true)
  await expect(pending).resolves.toMatchObject({ behavior: 'allow' })
})

it('a question sends free text to Claude through updatedInput.answers', async () => {
  const { handle, options } = await startDriver()
  const hook = options.hooks!.PreToolUse!.find((entry) => entry.matcher === 'AskUserQuestion')!.hooks[0]
  const toolInput = { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] }
  const pending = hook({
    hook_event_name: 'PreToolUse', session_id: 'native-1', transcript_path: '/fake/transcript', cwd: '/repo',
    tool_name: 'AskUserQuestion', tool_input: toolInput, tool_use_id: 'call-q'
  }, 'call-q', { signal: new AbortController().signal })
  const request = events.find((event) => event.type === 'question-request')!
  const text = 'The person is away. Decide yourself.'
  expect(handle.answer!(request.requestId, [[text]])).toBe(true)
  await expect(pending).resolves.toEqual({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...toolInput, answers: { 'Which one?': text } }
    }
  })
  expect(handle.answer!(request.requestId, [[text]])).toBe(false)
})
