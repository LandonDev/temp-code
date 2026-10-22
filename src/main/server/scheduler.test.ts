import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { BootResumer } from './resumeAfterBoot'
import { PASS_GAP_MS, ThreadScheduler, type SchedulerRegistry } from './scheduler'
import { setLagForTests } from './stalls'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { AgentEvent, SessionMeta } from '../../shared/events'

/**
 * The thread scheduler (scheduler.ts) on a real registry with a fake
 * claude driver: `after`, the running cap (admission.ts: the cap in admit
 * and in the pass with its reservation, Start now past it, the focused
 * exemption, a settle freeing a slot oldest first), the stored first
 * message, the activity lines, the boot order and the batch's Stop on a
 * queued row.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()
const boots: string[] = []
const failBoots = new Set<string>()

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        const id = ctx.session.id
        boots.push(id)
        if (failBoots.has(id)) throw new Error('boot refused')
        emits.set(id, ctx.emit)
        return {
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
          alive: () => true,
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
  root = await mkdtemp(join(tmpdir(), 'tc-scheduler-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  emits.clear()
  sends.clear()
  boots.length = 0
  failBoots.clear()
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const status = (id: string): string | undefined => store.getSession(id)?.status
const line = (id: string): string | null | undefined => registry.get(id)?.activity

/** A root that opted into the queue, its first message sent. */
async function queued(text: string, extra: { after?: string; masterId?: string; title?: string } = {}): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude', queue: true, ...extra })
  await registry.send(s.id, text)
  await settle()
  return s.id
}
const idle = (id: string): void => emits.get(id)!({ type: 'status', status: 'idle' })

describe('no cap configured', () => {
  it('five queued roots all start at once, each with the message its create stored', async () => {
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) ids.push(await queued(`task ${i}`, { title: `T${i}` }))
    expect(ids.map(status)).toEqual(['running', 'running', 'running', 'running', 'running'])
    expect(ids.map((id) => sends.get(id))).toEqual(ids.map((_, i) => [`task ${i + 1}`]))
    expect(ids.map(line).filter((l) => l?.startsWith("Queued"))).toEqual([])
  })

  it("a master's child with no after starts at once too", async () => {
    const master = await queued('master')
    const child = await queued('child', { masterId: master })
    expect(status(child)).toBe('running')
  })

  it('the stored first message carries the preamble stamp a held-back boot keeps', async () => {
    const ws = await registry.createWorkspace(root, 'ws')
    registry.setWorkspacePreamble(ws.id, 'Rules here.', true)
    const project = await registry.createProject(ws.id, 'P', 'local')
    const sibling = await registry.create({ cwd: root, provider: 'claude', title: 'Sibling' })
    const s = await registry.create({ cwd: root, provider: 'claude', projectId: project.id, queue: true, after: sibling.id })
    await registry.send(s.id, 'do it')
    await settle()
    expect(status(s.id)).toBe('queued')
    const rows = registry.eventsAfter(s.id, 0)
    const user = rows.find((r) => r.event.type === 'user-text')
    expect(user?.event).toMatchObject({ type: 'user-text', text: 'do it' })
    expect(rows.filter((r) => r.event.type === 'user-text')).toHaveLength(1)
    expect(store.firstUserPreamble(s.id)).toEqual((user?.event as { preamble?: unknown }).preamble ?? null)
    await registry.startQueued(s.id)
    await settle()
    expect(registry.eventsAfter(s.id, 0).filter((r) => r.event.type === 'user-text')).toHaveLength(1)
    expect(sends.get(s.id)).toHaveLength(1)
    expect(sends.get(s.id)![0]).toContain('do it')
  })
})

describe('after', () => {
  it('a pass reads the queued roots off the index: a burst of meta changes never lists the table', async () => {
    const sibling = await registry.create({ cwd: root, provider: 'claude', title: 'Sibling' })
    const waiter = await queued('wait', { after: sibling.id })
    const lists = vi.spyOn(store, 'listSessions')
    await registry.send(sibling.id, 'go')
    for (let i = 0; i < 200; i++) registry.append(sibling.id, { type: 'context', tokens: 100 + i, window: 1000 })
    await settle()
    expect(status(waiter)).toBe('queued')
    idle(sibling.id)
    await settle()
    expect(status(waiter)).toBe('running')
    expect(lists).not.toHaveBeenCalled()
  })

  it('holds until the sibling is idle after a turn, then starts', async () => {
    const sibling = await registry.create({ cwd: root, provider: 'claude', title: 'Sibling' })
    const waiter = await queued('wait', { after: sibling.id })
    // The sibling has not run: a fresh idle thread is not a settled one.
    expect(status(waiter)).toBe('queued')
    expect(line(waiter)).toBe('Queued · waiting for Sibling')
    await registry.send(sibling.id, 'go')
    await settle()
    expect(status(waiter)).toBe('queued')
    idle(sibling.id)
    await settle()
    expect(status(waiter)).toBe('running')
  })

  it('an errored sibling keeps the waiter queued and the line says why; archiving it releases', async () => {
    const sibling = await registry.create({ cwd: root, provider: 'claude', title: 'Broken' })
    await registry.send(sibling.id, 'go')
    await settle()
    const waiter = await queued('wait', { after: sibling.id })
    emits.get(sibling.id)!({ type: 'status', status: 'error' })
    await settle()
    expect(status(waiter)).toBe('queued')
    expect(line(waiter)).toBe('Queued · waiting for Broken (errored)')
    await registry.setArchived(sibling.id, true)
    await settle()
    expect(status(waiter)).toBe('running')
  })

  it('a deleted sibling releases the waiter', async () => {
    const sibling = await registry.create({ cwd: root, provider: 'claude', title: 'Gone' })
    const waiter = await queued('wait', { after: sibling.id })
    await registry.delete(sibling.id)
    await settle()
    expect(status(waiter)).toBe('running')
  })

  it('Start now starts a queued thread past its after', async () => {
    const sibling = await queued('busy')
    const waiter = await queued('wait', { after: sibling })
    expect(status(waiter)).toBe('queued')
    expect(await registry.startQueued(waiter)).toBe(true)
    await settle()
    expect(status(waiter)).toBe('running')
    expect(await registry.startQueued(waiter)).toBe(false)
  })
})

describe('boot', () => {
  it('runs the resumer first: nothing queued starts until the boot resume is done', async () => {
    let release!: () => void
    const resume = new Promise<void>((r) => {
      release = r
    })
    registry.scheduler.holdUntil(resume)
    const a = await queued('a')
    expect(status(a)).toBe('queued')
    expect(line(a)).toBe('Queued')
    release()
    await settle()
    expect(status(a)).toBe('running')
  })

  it('a queued thread survives a restart: the first user row is the message it starts with', async () => {
    const busy = await queued('busy')
    const held = await queued('held', { title: 'Held', after: busy })
    expect(status(held)).toBe('queued')
    // A new registry over the same store: the in-memory queue is gone.
    await registry.disposeAll()
    registry = new SessionRegistry(store)
    registry.scheduler.holdUntil(new BootResumer({ store, registry }).run())
    await settle()
    expect(status(held)).toBe('queued')
    idle(busy)
    emits.get(busy)?.({ type: 'status', status: 'idle' })
    store.updateSession(busy, { status: 'idle' })
    await registry.scheduler.tick()
    await settle()
    expect(status(held)).toBe('running')
    expect(sends.get(held)).toEqual(['held'])
    expect(registry.eventsAfter(held, 0).filter((r) => r.event.type === 'user-text')).toHaveLength(1)
  })
})

describe('the batch', () => {
  it('Stop on a queued root removes it from the queue (archives it)', async () => {
    const busy = await queued('busy')
    const q = await queued('later', { after: busy })
    const result = await registry.batch('stop', [q])
    expect(result.succeeded).toEqual([q])
    expect(store.getSession(q)?.archived).toBe(true)
    expect(sends.has(q)).toBe(false)
  })
})

describe('the running cap', () => {
  let cap = Number.POSITIVE_INFINITY
  const capAt = (n: number, graceMs = 0): void => {
    cap = n
    registry.admission = { cap: () => cap, memoryLow: () => false }
    registry.reclaimGraceMs = graceMs
  }
  /** A thread created and sent like the composer does: no queue flag. */
  async function plain(text: string, extra: { title?: string } = {}): Promise<string> {
    const s = await registry.create({ cwd: root, provider: 'claude', ...extra })
    await registry.send(s.id, text)
    await settle()
    return s.id
  }

  it('holds every start past the cap, with no harness booted for the queued one', async () => {
    capAt(2)
    const ids = [await plain('a'), await plain('b'), await plain('c')]
    expect(ids.map(status)).toEqual(['running', 'running', 'queued'])
    expect(boots).not.toContain(ids[2])
    expect(line(ids[2]!)).toBe('Queued · 2 of 2 running')
    expect(registry.scheduler.counts()).toEqual({ running: 2, queued: 1 })
  })

  it('a settle frees a slot, oldest first', async () => {
    capAt(1)
    const a = await plain('a')
    const b = await plain('b')
    const c = await plain('c')
    expect([a, b, c].map(status)).toEqual(['running', 'queued', 'queued'])
    idle(a)
    await settle()
    // The idle harness gave its slot up; the oldest queued thread took it.
    expect(registry.liveIds().has(a)).toBe(false)
    expect([b, c].map(status)).toEqual(['running', 'queued'])
    expect(sends.get(b)).toEqual(['b'])
    expect(line(c)).toBe('Queued · 1 of 1 running')
    idle(b)
    await settle()
    expect(status(c)).toBe('running')
    expect(sends.get(c)).toEqual(['c'])
  })

  it('Start now starts one thread past the cap', async () => {
    capAt(1)
    await plain('a')
    const b = await plain('b')
    expect(status(b)).toBe('queued')
    expect(await registry.startQueued(b)).toBe(true)
    await settle()
    expect(status(b)).toBe('running')
    expect(registry.scheduler.counts().running).toBe(2)
  })

  it('a focused thread is admitted past the cap, up to two', async () => {
    capAt(1)
    await plain('busy')
    const focused = new Set<string>()
    registry.scheduler.focused = (id) => focused.has(id)
    const ids: string[] = []
    for (const text of ['one', 'two', 'three']) {
      const s = await registry.create({ cwd: root, provider: 'claude' })
      focused.add(s.id)
      await registry.send(s.id, text)
      await settle()
      ids.push(s.id)
    }
    expect(ids.map(status)).toEqual(['running', 'running', 'queued'])
  })

  it('after and the cap: the sibling settling meets after, the slot frees once its harness is put down', async () => {
    capAt(1, 60_000)
    const sibling = await plain('go', { title: 'Sibling' })
    const waiter = await queued('wait', { after: sibling })
    expect(line(waiter)).toBe('Queued · waiting for Sibling')
    idle(sibling)
    await settle()
    // After is met; the idle sibling still holds the one slot inside its grace.
    expect(status(waiter)).toBe('queued')
    expect(line(waiter)).toBe('Queued · 1 of 1 running')
    registry.reclaimGraceMs = 0
    await registry.scheduler.tick()
    await settle()
    expect(status(waiter)).toBe('running')
  })

  it('a send on an idle thread whose harness is gone takes a slot through the same admit', async () => {
    capAt(1)
    const a = await plain('a')
    idle(a)
    const b = await plain('b')
    // a's idle harness gave b its slot.
    expect(status(b)).toBe('running')
    expect(registry.liveIds().has(a)).toBe(false)
    await registry.send(a, 'again')
    await settle()
    expect(status(a)).toBe('queued')
    expect(line(a)).toBe('Queued · 1 of 1 running')
    idle(b)
    await settle()
    expect(status(a)).toBe('running')
    expect(sends.get(a)?.at(-1)).toBe('again')
    expect(registry.eventsAfter(a, 0).filter((r) => r.event.type === 'user-text')).toHaveLength(2)
  })

  it('a waiting or watching thread keeps its slot; an idle one with anything queued keeps its harness', async () => {
    capAt(1)
    const a = await plain('a')
    emits.get(a)!({ type: 'status', status: 'watching' })
    const b = await plain('b')
    await settle()
    expect(status(b)).toBe('queued')
    expect(registry.reclaimIdle(5)).toEqual({ freed: 0, nextAt: null })
  })
})

describe('the scheduler alone', () => {
  /** A fake registry whose starts never finish: the reservation is all that counts them. */
  function fakeRegistry(rows: SessionMeta[]) {
    const started: string[] = []
    const reg: SchedulerRegistry = {
      session: (id) => rows.find((s) => s.id === id) ?? null,
      queued: () => rows.filter((s) => s.status === 'queued' && !s.archived),
      liveIds: () => new Set(rows.filter((s) => s.status === 'running').map((s) => s.id)),
      hasUserText: () => true,
      startQueued: (id) => {
        started.push(id)
        return new Promise<boolean>(() => {})
      },
      setQueuedLine: () => {},
      onMeta: () => () => {},
      onRemoved: () => () => {},
      cap: () => 2
    }
    return { reg, started }
  }
  const row = (id: string, createdAt: number, status: SessionMeta['status'] = 'queued'): SessionMeta =>
    ({ id, createdAt, status, archived: false, parentId: null, after: null, title: id }) as unknown as SessionMeta

  it('a pass reserves the slots of the starts it picks: passes in a row never start past the cap', async () => {
    const { reg, started } = fakeRegistry([row('e', 5), row('a', 1), row('c', 3), row('b', 2), row('d', 4)])
    const scheduler = new ThreadScheduler(reg)
    await scheduler.tick()
    await scheduler.tick()
    await scheduler.tick()
    expect(started).toEqual(['a', 'b'])
    expect(scheduler.counts()).toEqual({ running: 2, queued: 5 })
    expect(scheduler.lineOf('c')).toBe('Queued · 2 of 2 running')
  })

  it('while the loop lags, a storm of changes is one pass per 250 ms, each after a quiet moment', async () => {
    vi.useFakeTimers()
    const { reg } = fakeRegistry([row('a', 1)])
    let passes = 0
    const queued = reg.queued
    reg.queued = () => {
      passes++
      return queued()
    }
    const scheduler = new ThreadScheduler(reg)
    try {
      setLagForTests({ meanMs: 10, maxMs: 30, ewmaMs: 20 })
      scheduler.schedule()
      await vi.advanceTimersByTimeAsync(0)
      expect(passes).toBe(1)
      setLagForTests({ meanMs: 70, maxMs: 300, ewmaMs: 60 })
      for (let i = 0; i < 40; i++) {
        scheduler.schedule()
        await vi.advanceTimersByTimeAsync(10)
      }
      // 400 ms of changes on a lagging loop: the passes wait on the idle bound, never one per change.
      expect(passes).toBe(1)
      setLagForTests({ meanMs: 20, maxMs: 60, ewmaMs: 40 })
      await vi.advanceTimersByTimeAsync(50)
      expect(passes).toBe(2)
      setLagForTests({ meanMs: 70, maxMs: 300, ewmaMs: 60 })
      scheduler.schedule()
      await vi.advanceTimersByTimeAsync(0)
      expect(passes).toBe(2)
      setLagForTests({ meanMs: 20, maxMs: 60, ewmaMs: 40 })
      await vi.advanceTimersByTimeAsync(PASS_GAP_MS - 60)
      expect(passes).toBe(2)
      await vi.advanceTimersByTimeAsync(60)
      expect(passes).toBe(3)
    } finally {
      setLagForTests(null)
      vi.useRealTimers()
      scheduler.dispose()
    }
  })

  it('threads created in the same millisecond start in the order they were queued', async () => {
    const rows = [row('z', 7), row('m', 7), row('a', 7)]
    const { reg, started } = fakeRegistry(rows)
    const scheduler = new ThreadScheduler(reg)
    for (const id of ['z', 'm', 'a']) scheduler.noteQueued(id)
    await scheduler.tick()
    expect(started).toEqual(['z', 'm'])
  })

  it('a queued subagent waits on the cap like a root', async () => {
    const child = { ...row('child', 1), parentId: 'p' } as SessionMeta
    const { reg, started } = fakeRegistry([row('x', 0, 'running'), row('y', 0, 'running'), child])
    const scheduler = new ThreadScheduler(reg)
    await scheduler.tick()
    expect(started).toEqual([])
    expect(scheduler.admit(child)).toBe('queue')
  })

  it('a scheduler the server has not wired focuses nothing', () => {
    const scheduler = new ThreadScheduler(fakeRegistry([]).reg)
    expect(scheduler.focused('anything')).toBe(false)
  })

  it('under the memory floor nothing new starts and the line says why', async () => {
    const { reg, started } = fakeRegistry([row('a', 1)])
    const scheduler = new ThreadScheduler({ ...reg, memoryLow: () => true })
    await scheduler.tick()
    expect(started).toEqual([])
    expect(scheduler.lineOf('a')).toBe('Queued · waiting for memory')
  })
})
