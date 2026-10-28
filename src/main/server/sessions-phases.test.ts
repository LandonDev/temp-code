import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { phaseLine, PROVIDER_WAIT_MS, SessionRegistry } from './sessions'
import { FIRST_OUTPUT_GAVE_UP, FIRST_OUTPUT_SILENCE } from './drivers/silence'
import type { DriverCtx } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/**
 * What a turn says while it waits (plan S3): a phase event is the row's
 * activity and never a transcript row; a request out at the provider past
 * the threshold reads so; the first-output watchdog's silence re-queues
 * the message once and fails the turn the second time.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()
const dead = new Set<string>()
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        const id = ctx.session.id
        emits.set(id, ctx.emit)
        dead.delete(id)
        return {
          send: async (text: string) => {
            if (dead.has(id)) throw new Error('harness gone')
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
          alive: () => !dead.has(id),
          dispose: async () => {}
        }
      }
    }
  }
}))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-phases-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  emits.clear()
  sends.clear()
  dead.clear()
})
afterEach(async () => {
  vi.useRealTimers()
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const emit = (id: string, e: AgentEvent): void => emits.get(id)!(e)
const types = (id: string): string[] => registry.eventsAfter(id, 0).map((r) => r.event.type)
async function live(): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude' })
  await registry.send(s.id, 'go')
  await settle()
  return s.id
}

it('a phase event is activity on the meta and never a transcript row; the first content clears it back to Thinking', async () => {
  const id = await live()
  expect(registry.get(id)?.activity).toBe('Thinking')
  const pushed: (string | null | undefined)[] = []
  registry.onMeta((m) => {
    if (m.id === id) pushed.push(m.activity)
  })
  emit(id, { type: 'phase', phase: 'cli-starting' })
  expect(registry.get(id)).toMatchObject({ activity: 'Starting the CLI', activityKind: 'think' })
  emit(id, { type: 'phase', phase: 'initializing' })
  expect(registry.get(id)?.activity).toBe('Initializing')
  emit(id, { type: 'phase', phase: 'retrying', retry: { attempt: 3, delayMs: 32_000, reason: 'HTTP 429' } })
  expect(registry.get(id)?.activity).toBe('Rate limited, retry 3 in 32 s')
  emit(id, { type: 'phase', phase: null })
  expect(registry.get(id)?.activity).toBe('Thinking')
  expect(pushed).toEqual(['Starting the CLI', 'Initializing', 'Rate limited, retry 3 in 32 s', 'Thinking'])
  expect(types(id)).not.toContain('phase')
})

it("an eager cold handle's phase is kept until the send, which reads Starting the CLI until init, then Thinking; a repeated running keeps it", async () => {
  const s = await registry.create({ cwd: root, provider: 'claude' })
  await settle()
  // The eager boot spawned cold: its phase lands on an idle row and shows nothing yet.
  emit(s.id, { type: 'phase', phase: 'cli-starting' })
  expect(registry.get(s.id)?.activity ?? null).toBeNull()
  await registry.send(s.id, 'go')
  await settle()
  expect(registry.get(s.id)?.status).toBe('running')
  expect(registry.get(s.id)?.activity).toBe('Starting the CLI')
  emit(s.id, { type: 'status', status: 'running' })
  expect(registry.get(s.id)?.activity).toBe('Starting the CLI')
  emit(s.id, { type: 'phase', phase: null })
  expect(registry.get(s.id)?.activity).toBe('Thinking')
  emit(s.id, { type: 'status', status: 'running' })
  expect(registry.get(s.id)?.activity).toBe('Thinking')
})

it('a live handle reads Initializing after the send, kept through a repeated running and dropped by a settle', async () => {
  const id = await live()
  emit(id, { type: 'phase', phase: 'initializing' })
  expect(registry.get(id)?.activity).toBe('Initializing')
  emit(id, { type: 'status', status: 'running' })
  expect(registry.get(id)?.activity).toBe('Initializing')
  emit(id, { type: 'status', status: 'idle' })
  emit(id, { type: 'status', status: 'running' })
  expect(registry.get(id)?.activity).toBe('Thinking')
})

it('phaseLine words every phase', () => {
  expect(phaseLine({ type: 'phase', phase: 'waiting-provider' })).toBe('Waiting for the provider')
  expect(phaseLine({ type: 'phase', phase: 'retrying' })).toBe('Retrying')
  expect(phaseLine({ type: 'phase', phase: 'retrying', retry: { attempt: 2, delayMs: 0, reason: 'of 5' } })).toBe('Reconnecting, retry 2 of 5')
  expect(phaseLine({ type: 'phase', phase: 'retrying', retry: { attempt: 1, delayMs: 5_000, reason: 'HTTP 529' } })).toBe('Provider overloaded, retry 1 in 5 s')
  expect(phaseLine({ type: 'phase', phase: 'retrying', retry: { attempt: 1, delayMs: 2_000, reason: 'no response' } })).toBe('Retrying, retry 1 in 2 s')
  expect(phaseLine({ type: 'phase', phase: null })).toBeNull()
})

it('a request out at the provider past the threshold reads Waiting for the provider with its seconds, and clears when it ends', async () => {
  const id = await live()
  vi.useFakeTimers()
  const t0 = Date.now()
  registry.providerRequest(id, 7, t0)
  expect(registry.get(id)?.activity).toBe('Thinking')
  vi.setSystemTime(t0 + PROVIDER_WAIT_MS + 10_000)
  expect(registry.get(id)?.activity).toBe('Waiting for the provider, 25 s')
  // A finer phase wins over the wait.
  emit(id, { type: 'phase', phase: 'retrying', retry: { attempt: 1, delayMs: 1_000, reason: 'HTTP 429' } })
  expect(registry.get(id)?.activity).toBe('Rate limited, retry 1 in 1 s')
  emit(id, { type: 'phase', phase: null })
  expect(registry.get(id)?.activity).toBe('Waiting for the provider, 25 s')
  // The ticker re-pushes the row so the seconds move.
  const pushed: (string | null | undefined)[] = []
  registry.onMeta((m) => {
    if (m.id === id) pushed.push(m.activity)
  })
  vi.setSystemTime(t0 + PROVIDER_WAIT_MS + 20_000)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(pushed.at(-1)).toBe('Waiting for the provider, 40 s')
  registry.providerRequest(id, 7, null)
  expect(registry.get(id)?.activity).toBe('Thinking')
  // A tool call's own activity is never replaced by the wait.
  registry.providerRequest(id, 8, t0)
  emit(id, { type: 'tool-call', callId: 'c1', name: 'Read', input: { file_path: '/a/b.ts' } })
  expect(registry.get(id)?.activity).toBe('Reading b.ts')
})

it('a first-output silence re-queues the message once into a fresh harness; a second silence on it leaves the row errored', async () => {
  const id = await live()
  expect(sends.get(id)).toEqual(['go'])
  // The watchdog: the error, the idle, and the process put down.
  dead.add(id)
  emit(id, { type: 'error', message: FIRST_OUTPUT_SILENCE })
  emit(id, { type: 'status', status: 'idle' })
  await settle(60)
  // The message went again, into a fresh handle, with no second user row.
  expect(sends.get(id)).toEqual(['go', 'go'])
  expect(types(id).filter((t) => t === 'user-text')).toHaveLength(1)
  expect(registry.get(id)?.status).toBe('running')
  // Silent again on the same message: errored, with the row that says why.
  dead.add(id)
  emit(id, { type: 'error', message: FIRST_OUTPUT_SILENCE })
  emit(id, { type: 'status', status: 'idle' })
  await settle(60)
  expect(sends.get(id)).toEqual(['go', 'go'])
  expect(registry.get(id)?.status).toBe('error')
  expect(registry.get(id)?.failure?.kind).toBe('harness_crashed')
  const errors = registry.eventsAfter(id, 0).flatMap((r) => (r.event.type === 'error' ? [r.event.message] : []))
  expect(errors.at(-1)).toBe(FIRST_OUTPUT_GAVE_UP)
})

it('describeTool words every tool the strip can meet; an unknown name is humanized, never raw', async () => {
  const id = await live()
  const say = (name: string, input: unknown = {}): string | null | undefined => {
    emit(id, { type: 'tool-call', callId: `c-${name}`, name, input })
    return registry.get(id)?.activity
  }
  const table: [string, string][] = [
    ['TaskCreate', 'Creating a task'],
    ['TaskUpdate', 'Updating tasks'],
    ['TaskList', 'Listing tasks'],
    ['TaskGet', 'Reading a task'],
    ['TaskStop', 'Stopping a task'],
    ['mcp__app__update_notes', 'Updating notes'],
    ['mcp__app__plan_complete', 'Completing the plan'],
    ['mcp__app__merge_branch', 'Landing the branch'],
    ['ReportFindings', 'Reporting findings'],
    ['mcp__app__batch_rules', 'Setting batch rules'],
    ['mcp__app__batch_gate', 'Running the gate'],
    ['mcp__app__adopt_thread', 'Adding a thread'],
    ['mcp__app__app_start_thread', 'Starting a thread'],
    ['mcp__app__app_read_thread', 'Reading a thread'],
    ['mcp__app__app_list_threads', 'Listing threads'],
    ['mcp__orchestrator__spawn_agent', 'Spawning an agent'],
    ['mcp__orchestrator__wait_for_agent', 'Waiting for an agent'],
    ['mcp__orchestrator__check_agent', 'Checking an agent'],
    ['mcp__orchestrator__send_to_agent', 'Messaging an agent'],
    ['mcp__orchestrator__answer_agent', 'Answering an agent'],
    ['mcp__orchestrator__interrupt_agent', 'Interrupting an agent'],
    ['mcp__orchestrator__list_agents', 'Listing agents'],
    ['Monitor', 'Monitoring'],
    ['CronCreate', 'Scheduling a wake-up'],
    ['EnterPlanMode', 'Planning'],
    ['ScheduleWakeup', 'Scheduling a wake-up'],
    ['ExitPlanMode', 'Finishing the plan'],
    ['Workflow', 'Running a workflow'],
    ['ToolSearch', 'Finding tools'],
    ['mcp__cosmic-admin__file_read', 'Using cosmic-admin'],
    ['ListMcpResourcesTool', 'Using list mcp resources tool'],
    ['some_other_tool', 'Using some other tool']
  ]
  for (const [name, words] of table) expect(say(name), name).toBe(words)
  expect(say('Skill', { skill: 'impeccable' })).toBe('Using skill impeccable')
  expect(say('Skill', {})).toBe('Using a skill')
})
