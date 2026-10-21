import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { BootResumer } from './resumeAfterBoot'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { AgentEvent } from '../../shared/events'
import { DEFAULT_MAX_RUNNING, ordinal, parseMaxRunning } from '../../shared/threadCap'

/**
 * The thread scheduler (scheduler.ts) on a real registry with a fake
 * claude driver: the host's running cap, `after`, the stored first
 * message, the activity lines, Start now, the boot order and the batch's
 * Stop on a queued row.
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

describe('the running cap', () => {
  it('cap 2 with five queued roots starts two; a settle starts the third, oldest first', async () => {
    registry.setMaxRunning(2)
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) ids.push(await queued(`task ${i}`, { title: `T${i}` }))
    expect(ids.map(status)).toEqual(['running', 'running', 'queued', 'queued', 'queued'])
    expect(ids.filter((id) => sends.has(id))).toEqual(ids.slice(0, 2))
    expect(line(ids[2])).toBe('Queued · 1st in line')
    expect(line(ids[3])).toBe('Queued · 2nd in line')
    expect(line(ids[4])).toBe('Queued · 3rd in line')
    idle(ids[0])
    await settle()
    expect(status(ids[2])).toBe('running')
    expect(ids.filter((id) => sends.has(id))).toEqual(ids.slice(0, 3))
    // The started thread's message is the one its create stored, sent once.
    expect(sends.get(ids[2])).toEqual(['task 3'])
    expect(line(ids[3])).toBe('Queued · 1st in line')
    expect(registry.queueList(ids[2])).toEqual([])
  })

  it('a thread that did not opt in starts at once over the cap; a master child always queues', async () => {
    registry.setMaxRunning(1)
    const first = await queued('one')
    expect(status(first)).toBe('running')
    const plain = await registry.create({ cwd: root, provider: 'claude' })
    await registry.send(plain.id, 'go')
    await settle()
    expect(status(plain.id)).toBe('running')
    const child = await queued('child', { masterId: first })
    expect(status(child)).toBe('queued')
  })

  it('subagents never count against the cap, and never queue', async () => {
    registry.setMaxRunning(1)
    const parent = await queued('parent')
    const sub = await registry.create({ cwd: root, provider: 'claude', parentId: parent, queue: true })
    await registry.send(sub.id, 'sub task')
    await settle()
    expect(status(sub.id)).toBe("running")
    expect(registry.scheduler.runningCount()).toBe(1)
    const next = await queued('next')
    expect(status(next)).toBe('queued')
  })

  it('0 means unlimited, and raising the cap starts queued threads at once', async () => {
    registry.setMaxRunning(1)
    const a = await queued('a')
    const b = await queued('b')
    const c = await queued('c')
    expect([a, b, c].map(status)).toEqual(['running', 'queued', 'queued'])
    registry.setMaxRunning(0)
    await settle()
    expect([a, b, c].map(status)).toEqual(['running', 'running', 'running'])
  })

  it('the stored first message carries the preamble stamp a held-back boot keeps', async () => {
    registry.setMaxRunning(0)
    const ws = await registry.createWorkspace(root, 'ws')
    registry.setWorkspacePreamble(ws.id, 'Rules here.', true)
    const project = await registry.createProject(ws.id, 'P', 'local')
    registry.setMaxRunning(1)
    await queued('hold a slot')
    const s = await registry.create({ cwd: root, provider: 'claude', projectId: project.id, queue: true })
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
  it('holds until the sibling is idle after a turn, then starts', async () => {
    registry.setMaxRunning(0)
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
    registry.setMaxRunning(0)
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
    registry.setMaxRunning(0)
    const sibling = await registry.create({ cwd: root, provider: 'claude', title: 'Gone' })
    const waiter = await queued('wait', { after: sibling.id })
    await registry.delete(sibling.id)
    await settle()
    expect(status(waiter)).toBe('running')
  })

  it('Start now starts a queued thread past the cap and its after', async () => {
    registry.setMaxRunning(1)
    const sibling = await queued('busy')
    const waiter = await queued('wait', { after: sibling })
    expect(status(waiter)).toBe('queued')
    expect(await registry.startQueued(waiter)).toBe(true)
    await settle()
    expect(status(waiter)).toBe('running')
    expect(registry.scheduler.runningCount()).toBe(2)
    expect(await registry.startQueued(waiter)).toBe(false)
  })
})

describe('boot', () => {
  it('runs the resumer first: nothing queued starts until the boot resume is done', async () => {
    registry.setMaxRunning(1)
    let release!: () => void
    const resume = new Promise<void>((r) => {
      release = r
    })
    registry.scheduler.holdUntil(resume)
    const a = await queued('a')
    expect(status(a)).toBe('queued')
    expect(line(a)).toBe('Queued · 1st in line')
    release()
    await settle()
    expect(status(a)).toBe('running')
  })

  it('a queued thread survives a restart: the first user row is the message it starts with', async () => {
    registry.setMaxRunning(1)
    const busy = await queued('busy')
    const held = await queued('held', { title: 'Held' })
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

describe('the batch and the setting', () => {
  it('Stop on a queued root removes it from the queue (archives it)', async () => {
    registry.setMaxRunning(1)
    await queued('busy')
    const q = await queued('later')
    const result = await registry.batch('stop', [q])
    expect(result.succeeded).toEqual([q])
    expect(store.getSession(q)?.archived).toBe(true)
    expect(sends.has(q)).toBe(false)
  })

  it('threads.maxRunning round-trips through the settings table with the default when unset', () => {
    expect(registry.getMaxRunning()).toBe(DEFAULT_MAX_RUNNING)
    registry.setMaxRunning(7)
    expect(store.getSetting('threads.maxRunning')).toBe('7')
    expect(registry.getMaxRunning()).toBe(7)
    expect(parseMaxRunning('junk')).toBe(DEFAULT_MAX_RUNNING)
    expect(parseMaxRunning('0')).toBe(0)
    expect(ordinal(1)).toBe('1st')
    expect(ordinal(11)).toBe('11th')
    expect(ordinal(22)).toBe('22nd')
  })
})
