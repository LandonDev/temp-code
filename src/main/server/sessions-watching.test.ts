import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry, watchLine } from './sessions'
import type { DriverCtx } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/**
 * The 'watching' status through the registry: a fake claude driver whose
 * emit the test holds, so it can play the driver's status events by hand.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()
const disposed: string[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        const id = ctx.session.id
        emits.set(id, ctx.emit)
        return {
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
          dispose: async () => {
            disposed.push(id)
          }
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
  root = await mkdtemp(join(tmpdir(), 'tc-watching-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  emits.clear()
  sends.clear()
  disposed.length = 0
})
afterEach(async () => {
  vi.useRealTimers()
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
const emit = (id: string, e: AgentEvent): void => emits.get(id)!(e)
const types = (id: string): string[] =>
  registry
    .eventsAfter(id, 0)
    .map((r) => `${r.event.type}${r.event.type === 'status' ? ':' + r.event.status : ''}`)

/** A session with a live handle, mid-turn (the fake send stamps running). */
async function live(parentId?: string): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude', parentId })
  await registry.send(s.id, 'go')
  await settle()
  return s.id
}

it('watching shows the tasks it waits on and keeps its handle through the sweep', async () => {
  const id = await live()
  vi.useFakeTimers()
  emit(id, { type: 'background-tasks', tasks: ['upload the build'] })
  emit(id, { type: 'status', status: 'watching' })
  expect(registry.get(id)).toMatchObject({ status: 'watching', activity: 'Waiting on upload the build' })
  registry.startIdleSweep(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(disposed).toEqual([])
  emit(id, { type: 'background-tasks', tasks: ['upload the build', 'poll CI'] })
  expect(registry.get(id)?.activity).toBe('Waiting on 2 tasks: upload the build, poll CI')
  emit(id, { type: 'status', status: 'idle' })
  expect(registry.get(id)).toMatchObject({ status: 'idle', activity: null })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(disposed).toEqual([id])
})

it('watchLine names one task, counts several, and clips the line', () => {
  expect(watchLine(undefined)).toBe('Waiting on background work')
  expect(watchLine(['x'])).toBe('Waiting on x')
  expect(watchLine(['a', 'b'])).toBe('Waiting on 2 tasks: a, b')
  const long = watchLine(['y'.repeat(200)])
  expect(long.length).toBe(120)
  expect(long.endsWith('…')).toBe(true)
})

it('a persisted watching row resets to idle at boot', async () => {
  const s = await registry.create({ cwd: root, provider: 'claude' })
  store.updateSession(s.id, { status: 'watching' })
  registry.resetStaleStatuses()
  expect(registry.get(s.id)?.status).toBe('idle')
  expect(types(s.id)).toContain('status:idle')
})

it('a child going running → watching sends no parent report; watching → idle does', async () => {
  const parent = await registry.create({ cwd: root, provider: 'claude' })
  const child = await live(parent.id)
  emit(child, { type: 'status', status: 'watching' })
  await settle()
  expect(types(parent.id)).not.toContain('agent-report')
  expect(sends.get(parent.id)).toBeUndefined()
  emit(child, { type: 'status', status: 'idle' })
  await settle()
  expect(types(parent.id)).toContain('agent-report')
  expect(sends.get(parent.id)?.[0]).toContain('<subagent-report>')
})

it('a watching parent takes a report at once', async () => {
  const parent = await live()
  emit(parent, { type: 'status', status: 'watching' })
  registry.deliverAgentReport(parent, { text: 'R1', agentId: 'c1', title: 'one', status: 'idle' })
  await settle()
  expect(sends.get(parent)).toEqual(['go', 'R1'])
  expect(types(parent).filter((t) => t === 'agent-report')).toHaveLength(1)
})

it('reports parked behind a busy parent coalesce into one wake turn', async () => {
  const parent = await live()
  registry.deliverAgentReport(parent, { text: 'R1', agentId: 'c1', title: 'one', status: 'idle' })
  registry.deliverAgentReport(parent, { text: 'R2', agentId: 'c2', title: 'two', status: 'error' })
  await settle()
  expect(sends.get(parent)).toEqual(['go'])
  emit(parent, { type: 'status', status: 'idle' })
  await settle()
  expect(sends.get(parent)).toEqual(['go', 'R1\n\nR2'])
  const reports = registry
    .eventsAfter(parent, 0)
    .map((r) => r.event)
    .filter((e) => e.type === 'agent-report')
  expect(reports).toMatchObject([
    { agentId: 'c1', title: 'one', status: 'idle' },
    { agentId: 'c2', title: 'two', status: 'error' }
  ])
})

it('Stop on a watching thread drops the handle and lands idle', async () => {
  const id = await live()
  emit(id, { type: 'background-tasks', tasks: ['a monitor'] })
  emit(id, { type: 'status', status: 'watching' })
  await registry.interrupt(id)
  expect(disposed).toEqual([id])
  expect(registry.get(id)).toMatchObject({ status: 'idle', activity: null })
  expect(types(id).at(-1)).toBe('status:idle')
})
