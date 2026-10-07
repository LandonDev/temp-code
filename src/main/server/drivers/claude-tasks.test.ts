import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HookInput, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))

const { handleMessage, newStreamState, permittedWebTools, stopHookFor } = await import('./claude')

/**
 * Background work over the SDK stream: the task level and edges, the Stop
 * hook's crons, and the wake turn — driven straight through handleMessage
 * with a capturing ctx, no CLI.
 */

let events: AgentEvent[]
let nativeIds: string[]
let ctx: DriverCtx
let state: ReturnType<typeof newStreamState>

beforeEach(() => {
  events = []
  nativeIds = []
  ctx = {
    session: { context1m: false } as SessionMeta,
    emit: (e) => events.push(e),
    setNativeId: (id) => nativeIds.push(id),
    requestApproval: async () => false
  }
  state = newStreamState()
})
afterEach(() => vi.useRealTimers())

const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage
const level = (tasks: { task_id: string; description: string; ambient?: boolean }[]): SDKMessage =>
  msg({ type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map((t) => ({ task_type: 'local_bash', ...t })) })
const notification = (task_id: string, status = 'completed', ambient?: boolean): SDKMessage =>
  msg({ type: 'system', subtype: 'task_notification', task_id, status, summary: 'done', output_file: '/tmp/x', ambient })
const result = (): SDKMessage =>
  msg({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })
const assistant = (content: unknown[] = []): SDKMessage =>
  msg({ type: 'assistant', message: { id: 'm1', model: 'claude', content, usage: {} }, parent_tool_use_id: null })
const stopInput = (
  crons: { schedule: string; recurring: boolean }[],
  tasks?: { id: string; description: string; status?: string }[]
): HookInput =>
  ({
    hook_event_name: 'Stop',
    session_crons: crons.map((c, i) => ({ id: String(i), prompt: 'p', ...c })),
    ...(tasks ? { background_tasks: tasks.map((t) => ({ type: 'shell', status: 'running', ...t })) } : {})
  }) as HookInput
const started = (task_id: string, description: string, is_backgrounded?: boolean): SDKMessage =>
  msg({ type: 'system', subtype: 'task_started', task_id, description, is_backgrounded })

const statuses = (): string[] => events.flatMap((e) => (e.type === 'status' ? [e.status] : []))
const taskLists = (): string[][] => events.flatMap((e) => (e.type === 'background-tasks' ? [e.tasks] : []))

/** A sent turn: the driver's send() sets working before the stream replies. */
const startTurn = (): void => {
  state.working = true
}

it('a turn that ends with a live task settles to watching, not idle', () => {
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 't1', description: 'upload the build' }]))
  expect(taskLists()).toEqual([['upload the build']])
  expect(statuses()).toEqual([])
  handleMessage(ctx, state, result())
  expect(statuses()).toEqual(['watching'])
  expect(state.working).toBe(false)
  expect(state.watching).toBe(true)
})

it('ambient tasks are invisible: no task list, and the turn settles idle', () => {
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 'a1', description: 'housekeeping', ambient: true }]))
  handleMessage(ctx, state, notification('a1', 'completed', true))
  handleMessage(ctx, state, result())
  expect(taskLists()).toEqual([])
  expect(events.some((e) => e.type === 'background-task')).toBe(false)
  expect(statuses()).toEqual(['idle'])
})

it('the wake turn: empty level, named notification, running on the first assistant message, idle at its result', () => {
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 't1', description: 'poll CI' }]))
  handleMessage(ctx, state, result())
  events.length = 0
  // The CLI wakes: level without the task, then the edge, then the turn.
  handleMessage(ctx, state, level([]))
  expect(taskLists()).toEqual([[]])
  expect(statuses()).toEqual([])
  handleMessage(ctx, state, notification('t1', 'completed'))
  expect(events).toContainEqual({ type: 'background-task', taskId: 't1', description: 'poll CI', status: 'completed' })
  handleMessage(ctx, state, assistant())
  expect(statuses()).toEqual(['running'])
  expect(state.working).toBe(true)
  handleMessage(ctx, state, result())
  expect(statuses()).toEqual(['running', 'idle'])
  expect(state.watching).toBe(false)
})

it('a lazy init while idle also opens the wake turn and records the native id', () => {
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 't1', description: 'poll CI' }]))
  handleMessage(ctx, state, result())
  events.length = 0
  handleMessage(ctx, state, msg({ type: 'system', subtype: 'init', session_id: 'n1' }))
  expect(statuses()).toEqual(['running'])
  expect(nativeIds).toEqual(['n1'])
})

it('an empty level with no wake turn settles idle after the grace', () => {
  vi.useFakeTimers()
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 't1', description: 'a monitor' }]))
  handleMessage(ctx, state, result())
  handleMessage(ctx, state, level([]))
  expect(statuses()).toEqual(['watching'])
  vi.advanceTimersByTime(4_999)
  expect(statuses()).toEqual(['watching'])
  vi.advanceTimersByTime(1)
  expect(statuses()).toEqual(['watching', 'idle'])
  expect(state.watching).toBe(false)
})

it('a wake turn inside the grace cancels the settle', () => {
  vi.useFakeTimers()
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 't1', description: 'a monitor' }]))
  handleMessage(ctx, state, result())
  handleMessage(ctx, state, level([]))
  handleMessage(ctx, state, assistant())
  vi.advanceTimersByTime(10_000)
  expect(statuses()).toEqual(['watching', 'running'])
})

it('a task named by task_started is labelled even when the level never listed it', () => {
  startTurn()
  handleMessage(ctx, state, msg({ type: 'system', subtype: 'task_started', task_id: 't9', description: 'gradle build' }))
  handleMessage(ctx, state, notification('t9', 'failed'))
  expect(events).toContainEqual({ type: 'background-task', taskId: 't9', description: 'gradle build', status: 'failed' })
  handleMessage(ctx, state, notification('zz', 'stopped'))
  expect(events).toContainEqual({ type: 'background-task', taskId: 'zz', description: 'background task', status: 'stopped' })
})

it('a session cron from the Stop hook keeps the thread watching and names the wake-up', async () => {
  const hook = stopHookFor(ctx, state)
  startTurn()
  await hook(stopInput([{ schedule: '0 9 * * *', recurring: true }]))
  expect(taskLists()).toEqual([['scheduled wake-up (0 9 * * *)']])
  handleMessage(ctx, state, result())
  expect(statuses()).toEqual(['watching'])
  // Its next turn ends with the cron gone: idle.
  handleMessage(ctx, state, assistant())
  await hook(stopInput([]))
  handleMessage(ctx, state, result())
  expect(taskLists()).toEqual([['scheduled wake-up (0 9 * * *)'], []])
  expect(statuses()).toEqual(['watching', 'running', 'idle'])
})

it('a Stop hook that lands after the result applies the transition itself', async () => {
  const hook = stopHookFor(ctx, state)
  startTurn()
  handleMessage(ctx, state, result())
  expect(statuses()).toEqual(['idle'])
  await hook(stopInput([{ schedule: '30 14 3 10 *', recurring: false }]))
  expect(statuses()).toEqual(['idle', 'watching'])
  expect(taskLists()).toEqual([['one-shot wake-up (30 14 3 10 *)']])
})

it('tasks and crons share the header list', async () => {
  const hook = stopHookFor(ctx, state)
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 't1', description: 'upload' }]))
  await hook(stopInput([{ schedule: '*/5 * * * *', recurring: true }]))
  expect(taskLists().at(-1)).toEqual(['upload', 'scheduled wake-up (*/5 * * * *)'])
})

// ── the level is not the only truth ──────────────────────────────────
// Seen live: the CLI stopped sending background_tasks_changed mid-session
// while tasks kept starting and reporting, so two ids from the last level
// held a finished thread in 'watching' for hours.

it('the Stop hook in-flight list replaces a stale level', async () => {
  const hook = stopHookFor(ctx, state)
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 'a', description: 'A' }, { task_id: 'b', description: 'B' }]))
  await hook(stopInput([], []))
  handleMessage(ctx, state, result())
  expect(taskLists()).toEqual([['A', 'B'], []])
  expect(statuses()).toEqual(['idle'])
  // And the other way: the hook names a task the level never listed.
  startTurn()
  await hook(stopInput([], [{ id: 'c', description: 'C' }, { id: 'd', description: 'D', status: 'completed' }]))
  handleMessage(ctx, state, result())
  expect(taskLists().at(-1)).toEqual(['C'])
  expect(statuses()).toEqual(['idle', 'watching'])
})

it('a Stop hook without a task list leaves the level alone', async () => {
  const hook = stopHookFor(ctx, state)
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 'a', description: 'A' }]))
  await hook(stopInput([]))
  handleMessage(ctx, state, result())
  expect(statuses()).toEqual(['watching'])
})

it('a notification or a terminal task_updated retires its task without a new level', () => {
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 'a', description: 'A' }, { task_id: 'b', description: 'B' }]))
  handleMessage(ctx, state, notification('a', 'completed'))
  expect(taskLists().at(-1)).toEqual(['B'])
  handleMessage(ctx, state, msg({ type: 'system', subtype: 'task_updated', task_id: 'b', patch: { status: 'killed' } }))
  expect(taskLists().at(-1)).toEqual([])
  handleMessage(ctx, state, result())
  expect(statuses()).toEqual(['idle'])
})

it('a foreground command moved to the background by its timeout never holds the thread', async () => {
  const hook = stopHookFor(ctx, state)
  startTurn()
  handleMessage(ctx, state, started('t', 'grep the scheduler', false))
  handleMessage(ctx, state, started('m', 'poll CI', true))
  handleMessage(ctx, state, level([{ task_id: 't', description: 'grep the scheduler' }, { task_id: 'm', description: 'poll CI' }]))
  expect(taskLists()).toEqual([['poll CI']])
  await hook(stopInput([], [{ id: 't', description: 'grep the scheduler' }]))
  handleMessage(ctx, state, result())
  expect(taskLists().at(-1)).toEqual([])
  expect(statuses()).toEqual(['idle'])
  // It still gets its transcript row if it ever reports.
  handleMessage(ctx, state, notification('t', 'completed'))
  expect(events).toContainEqual({ type: 'background-task', taskId: 't', description: 'grep the scheduler', status: 'completed' })
})

it('an ambient task in the Stop hook list is ignored too', async () => {
  const hook = stopHookFor(ctx, state)
  startTurn()
  handleMessage(ctx, state, msg({ type: 'system', subtype: 'task_started', task_id: 'h', description: 'housekeeping', ambient: true }))
  await hook(stopInput([], [{ id: 'h', description: 'housekeeping' }]))
  handleMessage(ctx, state, result())
  expect(taskLists()).toEqual([])
  expect(statuses()).toEqual(['idle'])
  handleMessage(ctx, state, notification('h', 'completed'))
  expect(events.some((e) => e.type === 'background-task')).toBe(false)
})

// ── the forgotten-task check ──────────────────────────────────────────

const MIN = 60_000
let checks: string[]
const armChecks = (): void => {
  checks = []
  state.sendCheck = (t) => checks.push(t)
  vi.useFakeTimers({ now: 1_000_000 })
}
const userTurn = (): void => {
  startTurn()
  handleMessage(ctx, state, assistant())
  handleMessage(ctx, state, result())
}

it('an old task a whole turn never used gets one check; the stopped answer retires it', () => {
  armChecks()
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 'zomb', description: 'Rerun PR 3 and wait' }]))
  handleMessage(ctx, state, result())
  expect(statuses()).toEqual(['watching'])
  expect(checks).toEqual([])
  vi.advanceTimersByTime(11 * MIN)
  userTurn()
  expect(checks).toHaveLength(1)
  expect(checks[0]).toContain('zomb — Rerun PR 3 and wait (started 11 min ago)')
  expect(checks[0]).toContain('TaskStop')
  expect(events.at(-1)).toEqual({ type: 'status', status: 'running', detail: 'Checking background tasks' })
  expect(state.working).toBe(true)
  // The model stops it; the CLI's stopped notification retires the task.
  handleMessage(ctx, state, assistant())
  handleMessage(ctx, state, notification('zomb', 'stopped'))
  expect(events).toContainEqual({ type: 'background-task', taskId: 'zomb', description: 'Rerun PR 3 and wait', status: 'stopped' })
  handleMessage(ctx, state, result())
  expect(statuses().at(-1)).toBe('idle')
  expect(checks).toHaveLength(1)
})

it('a young task, or one the turn touched, is never questioned', () => {
  armChecks()
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 'ci', description: 'wait for CI' }]))
  handleMessage(ctx, state, result())
  vi.advanceTimersByTime(5 * MIN)
  userTurn()
  expect(checks).toEqual([])
  vi.advanceTimersByTime(10 * MIN)
  startTurn()
  handleMessage(ctx, state, assistant([{ type: 'tool_use', id: 'tu1', name: 'TaskOutput', input: { task_id: 'ci' } }]))
  handleMessage(ctx, state, result())
  expect(checks).toEqual([])
  expect(statuses().at(-1)).toBe('watching')
})

it('a task the model kept is asked about again only after half an hour', () => {
  armChecks()
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 'srv', description: 'dev server' }]))
  handleMessage(ctx, state, result())
  vi.advanceTimersByTime(11 * MIN)
  userTurn()
  expect(checks).toHaveLength(1)
  // The check turn: the model keeps it.
  handleMessage(ctx, state, assistant())
  handleMessage(ctx, state, result())
  expect(statuses().at(-1)).toBe('watching')
  expect(checks).toHaveLength(1)
  vi.advanceTimersByTime(10 * MIN)
  userTurn()
  expect(checks).toHaveLength(1)
  vi.advanceTimersByTime(25 * MIN)
  userTurn()
  expect(checks).toHaveLength(2)
})

it('no check without a sender or while nothing is watched', () => {
  vi.useFakeTimers({ now: 1_000_000 })
  startTurn()
  handleMessage(ctx, state, level([{ task_id: 'a', description: 'A' }]))
  handleMessage(ctx, state, result())
  vi.advanceTimersByTime(11 * MIN)
  userTurn()
  expect(statuses().at(-1)).toBe('watching')
  expect(state.working).toBe(false)
})

it('web tools run without a prompt under Auto-edits only', () => {
  expect(permittedWebTools('edits')).toEqual(['WebSearch', 'WebFetch'])
  expect(permittedWebTools('safe')).toEqual([])
  expect(permittedWebTools('auto')).toEqual([])
})
