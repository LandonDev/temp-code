import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { BootResumer } from './resumeAfterBoot'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/**
 * The thread scheduler (scheduler.ts) on a real registry with a fake
 * claude driver: `after` (the one reason to queue), the stored first
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

describe('no running cap', () => {
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
