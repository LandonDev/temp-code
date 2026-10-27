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
  expect(registry.get(id)?.activity).toBe('Rate limited · retry 3 in 32 s')
  emit(id, { type: 'phase', phase: null })
  expect(registry.get(id)?.activity).toBe('Thinking')
  expect(pushed).toEqual(['Starting the CLI', 'Initializing', 'Rate limited · retry 3 in 32 s', 'Thinking'])
  expect(types(id)).not.toContain('phase')
})

it('phaseLine words every phase', () => {
  expect(phaseLine({ type: 'phase', phase: 'waiting-provider' })).toBe('Waiting for the provider')
  expect(phaseLine({ type: 'phase', phase: 'retrying' })).toBe('Retrying')
  expect(phaseLine({ type: 'phase', phase: 'retrying', retry: { attempt: 2, delayMs: 0, reason: 'of 5' } })).toBe('Reconnecting · retry 2 of 5')
  expect(phaseLine({ type: 'phase', phase: 'retrying', retry: { attempt: 1, delayMs: 5_000, reason: 'HTTP 529' } })).toBe('Provider overloaded · retry 1 in 5 s')
  expect(phaseLine({ type: 'phase', phase: 'retrying', retry: { attempt: 1, delayMs: 2_000, reason: 'no response' } })).toBe('Retrying · retry 1 in 2 s')
  expect(phaseLine({ type: 'phase', phase: null })).toBeNull()
})

it('a request out at the provider past the threshold reads Waiting for the provider with its seconds, and clears when it ends', async () => {
  const id = await live()
  vi.useFakeTimers()
  const t0 = Date.now()
  registry.providerRequest(id, 7, t0)
  expect(registry.get(id)?.activity).toBe('Thinking')
  vi.setSystemTime(t0 + PROVIDER_WAIT_MS + 10_000)
  expect(registry.get(id)?.activity).toBe('Waiting for the provider · 25 s')
  // A finer phase wins over the wait.
  emit(id, { type: 'phase', phase: 'retrying', retry: { attempt: 1, delayMs: 1_000, reason: 'HTTP 429' } })
  expect(registry.get(id)?.activity).toBe('Rate limited · retry 1 in 1 s')
  emit(id, { type: 'phase', phase: null })
  expect(registry.get(id)?.activity).toBe('Waiting for the provider · 25 s')
  // The ticker re-pushes the row so the seconds move.
  const pushed: (string | null | undefined)[] = []
  registry.onMeta((m) => {
    if (m.id === id) pushed.push(m.activity)
  })
  vi.setSystemTime(t0 + PROVIDER_WAIT_MS + 20_000)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(pushed.at(-1)).toBe('Waiting for the provider · 40 s')
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
