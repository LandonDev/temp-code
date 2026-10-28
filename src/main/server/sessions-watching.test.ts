import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry, watchLine } from './sessions'
import type { DriverCtx } from './drivers/types'
import type { AgentEvent, BackgroundTask, BackgroundWork } from '../../shared/events'

/**
 * The 'watching' status through the registry: a fake claude driver whose
 * emit the test holds, so it can play the driver's status events by hand.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
/** The driver's word that its process is gone with no turn open. */
const gones = new Map<string, () => void>()
const sends = new Map<string, string[]>()
const disposed: string[] = []
const stopped: string[] = []
/** Handles whose process died: send throws, alive says no; a fresh start clears it. */
const dead = new Set<string>()
const spawns = new Map<string, number>()
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        const id = ctx.session.id
        emits.set(id, ctx.emit)
        gones.set(id, ctx.harnessGone!)
        spawns.set(id, (spawns.get(id) ?? 0) + 1)
        dead.delete(id)
        return {
          send: async (text: string) => {
            if (dead.has(id)) throw new Error('harness gone')
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          alive: () => !dead.has(id),
          interrupt: () => {},
          stopTask: async (taskId: string) => {
            stopped.push(`${id}:${taskId}`)
          },
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
  gones.clear()
  sends.clear()
  disposed.length = 0
  stopped.length = 0
  dead.clear()
  spawns.clear()
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
  expect(registry.get(id)?.activity).toBe('Waiting on 2 background tasks')
  emit(id, { type: 'status', status: 'idle' })
  expect(registry.get(id)).toMatchObject({ status: 'idle', activity: null })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(disposed).toEqual([id])
})

const task = (label: string, kind: BackgroundTask['kind'] = 'shell'): BackgroundTask => ({
  id: label,
  label,
  kind,
  startedAt: 0
})
const work = (over: Partial<BackgroundWork>): BackgroundWork => ({
  tasks: [],
  agents: [],
  batch: null,
  watchingSince: null,
  ...over
})

it('watchLine names one task, counts the rest, and clips the line', () => {
  expect(watchLine(undefined)).toBe('Waiting on background work')
  expect(watchLine(work({}))).toBe('Waiting on background work')
  expect(watchLine(work({ tasks: [task('x')] }))).toBe('Waiting on x')
  expect(watchLine(work({ tasks: [task('a'), task('b')] }))).toBe('Waiting on 2 commands')
  expect(watchLine(work({ agents: ['c1', 'c2', 'c3'], tasks: [task('m', 'monitor')] }))).toBe(
    'Waiting on 3 subagents, a monitor'
  )
  expect(watchLine(work({ batch: { out: 2, total: 3 } }))).toBe('Waiting on 2 batch threads')
  expect(watchLine(work({ batch: { out: 0, total: 3 } }))).toBe("Waiting on the batch's steps")
  const long = watchLine(work({ tasks: [task('y'.repeat(200))] }))
  expect(long.length).toBe(120)
  expect(long.endsWith('…')).toBe(true)
})

it('the meta carries the structured tasks and the watching stretch', async () => {
  const id = await live()
  const items: BackgroundTask[] = [{ id: 't1', label: 'serve the app', kind: 'shell', startedAt: 5, command: 'bun run dev', callId: 'c1' }]
  emit(id, { type: 'background-tasks', tasks: ['serve the app'], items })
  expect(registry.get(id)?.background).toMatchObject({ tasks: items, agents: [], batch: null, watchingSince: null })
  const before = Date.now()
  emit(id, { type: 'status', status: 'watching' })
  const since = registry.get(id)?.background?.watchingSince
  expect(since).toBeGreaterThanOrEqual(before)
  // Watching again (a repeat status) keeps the stretch's start.
  emit(id, { type: 'status', status: 'watching' })
  expect(registry.get(id)?.background?.watchingSince).toBe(since)
  // A wake ends the stretch.
  emit(id, { type: 'status', status: 'running' })
  expect(registry.get(id)?.background?.watchingSince).toBeNull()
  emit(id, { type: 'background-tasks', tasks: [], items: [] })
  emit(id, { type: 'status', status: 'idle' })
  expect(registry.get(id)?.background).toBeNull()
})

it("a parent's background lists its live child", async () => {
  const parent = await live()
  const child = await live(parent)
  expect(registry.get(parent)?.background?.agents).toEqual([child])
  emit(child, { type: 'status', status: 'idle' })
  await settle()
  expect(registry.get(parent)?.background ?? null).toBeNull()
})

it("a master's batch counts the children still out, and a child settling re-pushes the master", async () => {
  const master = await registry.create({ cwd: root, provider: 'claude' })
  store.updateSession(master.id, { status: 'watching' })
  registry.setMaster(master.id, true)
  const kids: string[] = []
  for (let i = 0; i < 3; i++) {
    const k = await registry.create({ cwd: root, provider: 'claude', masterId: master.id })
    kids.push(k.id)
  }
  await registry.send(kids[0], 'go')
  await registry.send(kids[1], 'go')
  await settle()
  store.updateSession(kids[2], { status: 'idle' })
  expect(registry.get(master.id)).toMatchObject({
    background: { batch: { out: 2, total: 3 } },
    activity: 'Waiting on 2 batch threads'
  })
  const pushed: string[] = []
  registry.onMeta((m) => {
    if (m.id === master.id) pushed.push(m.activity ?? '')
  })
  emit(kids[0], { type: 'status', status: 'idle' })
  expect(pushed.at(-1)).toBe('Waiting on a batch thread')
})

it('stopTask reaches the live handle, and refuses without one', async () => {
  const id = await live()
  await registry.stopTask(id, 't1')
  expect(stopped).toEqual([`${id}:t1`])
  await expect(registry.stopTask('nope', 't1')).rejects.toThrow('no live harness')
})

it('a persisted watching row resets to idle at boot', async () => {
  const s = await registry.create({ cwd: root, provider: 'claude' })
  store.updateSession(s.id, { status: 'watching' })
  registry.resetStaleStatuses()
  expect(registry.get(s.id)?.status).toBe('idle')
  expect(types(s.id)).toContain('status:idle')
})

it('running → watching reports to a dormant parent once, saying what the child waits on; watching → idle adds no report', async () => {
  const parent = await registry.create({ cwd: root, provider: 'claude' })
  const child = await live(parent.id)
  emit(child, { type: 'background-tasks', tasks: ['poll CI'], items: [task('poll CI', 'monitor')] })
  emit(child, { type: 'status', status: 'watching' })
  await settle()
  expect(types(parent.id).filter((t) => t === 'agent-report')).toHaveLength(1)
  expect(sends.get(parent.id)?.[0]).toContain('settled with status watching')
  expect(sends.get(parent.id)?.[0]).toContain('it is watching poll CI')
  emit(child, { type: 'background-tasks', tasks: [], items: [] })
  emit(child, { type: 'status', status: 'idle' })
  await settle()
  expect(types(parent.id).filter((t) => t === 'agent-report')).toHaveLength(1)
  expect(sends.get(parent.id)).toHaveLength(1)
})

it('a message queued while running drains as a turn when the thread settles into watching', async () => {
  const id = await live()
  const added = registry.queueAdd(id, 'and then this')
  expect(added.kind).toBe('queued')
  expect(registry.queueList(id)).toHaveLength(1)
  expect(sends.get(id)).toEqual(['go'])
  emit(id, { type: 'background-tasks', tasks: ['serve the app'] })
  emit(id, { type: 'status', status: 'watching' })
  await settle()
  expect(registry.queueList(id)).toEqual([])
  expect(sends.get(id)?.at(-1)).toBe('and then this')
  expect(registry.get(id)?.status).toBe('running')
})

it('a message queued into a watching thread goes in at once', async () => {
  const id = await live()
  emit(id, { type: 'background-tasks', tasks: ['serve the app'] })
  emit(id, { type: 'status', status: 'watching' })
  registry.queueAdd(id, 'now please')
  await settle()
  expect(registry.queueList(id)).toEqual([])
  expect(sends.get(id)?.at(-1)).toBe('now please')
})

it('a steer into a dead handle boots a fresh harness and delivers the message once', async () => {
  const id = await live()
  dead.add(id)
  const added = registry.queueAdd(id, 'are you there', { steer: true })
  expect(added.kind).toBe('steered')
  await settle()
  await settle()
  expect(spawns.get(id)).toBe(2)
  expect(sends.get(id)?.filter((t) => t.includes('are you there'))).toEqual(['are you there'])
  const rows = registry.eventsAfter(id, 0).filter((r) => r.event.type === 'user-text' && (r.event as { text: string }).text === 'are you there')
  expect(rows).toHaveLength(1)
  expect(registry.get(id)?.status).toBe('running')
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

it('Kill background tasks drops a watching handle and lands idle', async () => {
  const id = await live()
  emit(id, { type: 'background-tasks', tasks: ['a monitor'] })
  emit(id, { type: 'status', status: 'watching' })
  await registry.killBackground(id)
  expect(disposed).toEqual([id])
  expect(registry.get(id)).toMatchObject({ status: 'idle', activity: null })
  expect(types(id).at(-1)).toBe('status:idle')
})

it('Kill background tasks leaves a running turn alone and reaches a watching child', async () => {
  const parent = await live()
  const child = await live(parent)
  emit(child, { type: 'status', status: 'watching' })
  await registry.killBackground(parent)
  expect(disposed).toEqual([child])
  expect(registry.get(parent)?.status).toBe('running')
  expect(registry.get(child)?.status).toBe('idle')
})

/** The driver's process died with no turn open (drivers/claude.ts
 *  settleStreamEnd): the tasks list is emptied, then the registry is told. */
const harnessDied = (id: string): void => {
  dead.add(id)
  emit(id, { type: 'background-tasks', tasks: [], items: [] })
  gones.get(id)!()
}

it("a thread watching its own task whose harness dies settles idle at the driver's word: no error row, no failure, its Activity emptied", async () => {
  const id = await live()
  emit(id, { type: 'background-tasks', tasks: ['bun test --watch'] })
  emit(id, { type: 'status', status: 'watching' })
  harnessDied(id)
  await settle()
  expect(registry.get(id)).toMatchObject({ status: 'idle', activity: null, failure: null })
  expect(registry.get(id)?.background ?? null).toBeNull()
  expect(types(id).at(-1)).toBe('status:idle')
  expect(types(id)).not.toContain('error')
  expect(disposed).toEqual([id])
  expect(registry.liveIds().has(id)).toBe(false)
})

it('a harness killed mid-turn still lands on error, the host reading it as the harness crashing', async () => {
  const id = await live()
  dead.add(id)
  emit(id, { type: 'error', message: 'Claude Code process terminated by signal SIGKILL' })
  emit(id, { type: 'status', status: 'error' })
  expect(registry.get(id)?.status).toBe('error')
  expect(registry.get(id)?.failure?.kind).toBe('harness_crashed')
})

it('a harness that dies between turns only loses its handle: the row stays idle with no new row', async () => {
  const id = await live()
  emit(id, { type: 'status', status: 'idle' })
  const before = types(id)
  dead.add(id)
  gones.get(id)!()
  await settle()
  expect(types(id)).toEqual(before)
  expect(registry.get(id)?.status).toBe('idle')
  expect(disposed).toEqual([id])
  expect(registry.liveIds().has(id)).toBe(false)
})

it("the driver's word is ignored while a live handle stands behind the row", async () => {
  const id = await live()
  emit(id, { type: 'background-tasks', tasks: ['bun test --watch'] })
  emit(id, { type: 'status', status: 'watching' })
  expect(registry.settleGoneHarness(id)).toBe(false)
  expect(registry.get(id)?.status).toBe('watching')
  expect(disposed).toEqual([])
})

/** The working clock (busySince): a turn from a settled row counts from its
 *  own start; a stretch holds through steers and queue drains. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
const statusRow = (id: string, status: string, nth = -1): number => {
  const rows = registry.eventsAfter(id, 0).filter((r) => r.event.type === 'status' && r.event.status === status)
  return rows.at(nth)!.ts
}

it('a turn after a failure counts from its own start', async () => {
  const id = await live()
  const first = registry.get(id)!.busySince
  emit(id, { type: 'error', message: 'boom' })
  emit(id, { type: 'status', status: 'error' })
  await tick()
  await registry.send(id, 'again')
  expect(registry.get(id)!.busySince).toBe(statusRow(id, 'starting'))
  expect(registry.get(id)!.busySince).toBeGreaterThan(first!)
})

it('a wake-up from a watch counts from its own start', async () => {
  const id = await live()
  const first = registry.get(id)!.busySince
  emit(id, { type: 'background-tasks', tasks: ['a monitor'] })
  emit(id, { type: 'status', status: 'watching' })
  expect(registry.get(id)!.busySince).toBe(first)
  await tick()
  emit(id, { type: 'status', status: 'running' })
  expect(registry.get(id)!.busySince).toBe(statusRow(id, 'running'))
  expect(registry.get(id)!.busySince).toBeGreaterThan(first!)
})

it('a steer keeps the stretch, and so does a message queued behind the turn that drains at its idle', async () => {
  const id = await live()
  const first = registry.get(id)!.busySince
  await tick()
  emit(id, { type: 'status', status: 'running' })
  expect(registry.get(id)!.busySince).toBe(first)
  expect(registry.queueAdd(id, 'next').kind).toBe('queued')
  await tick()
  emit(id, { type: 'status', status: 'idle' })
  await settle()
  expect(sends.get(id)).toEqual(['go', 'next'])
  expect(registry.get(id)).toMatchObject({ status: 'running', busySince: first })
})
