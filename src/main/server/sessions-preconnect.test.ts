import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { FOCUS_BOOT_EVERY_MS, SessionRegistry } from './sessions'
import type { DriverCtx } from './drivers/types'

/**
 * Boot on focus (plan Stability 3, A3): the person's pointer or keystroke in
 * an idle thread's composer boots its harness ahead of the send, within the
 * host's bounds (idle with no harness, not paused, queued, archived or
 * moving, once per 30 s per thread, under the cap with nothing queued); and
 * a draft's composer opens the socket the router would pick for it.
 */
const starts: string[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        starts.push(ctx.session.id)
        return {
          send: async () => ctx.emit({ type: 'status', status: 'running' }),
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
let cap: number
let preconnects: [string, string | null][]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-preconnect-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  cap = 100
  registry.admission = { cap: () => cap, memoryLow: () => false }
  registry.reclaimGraceMs = 0
  preconnects = []
  registry.preconnect = (provider, account) => preconnects.push([provider, account])
  starts.length = 0
})
afterEach(async () => {
  vi.useRealTimers()
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** An idle thread whose harness was put down (the idle sweep, reclaimIdle). */
async function down(): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude' })
  await settle()
  registry.reclaimIdle(100)
  expect(registry.liveIds().has(s.id)).toBe(false)
  starts.length = 0
  return s.id
}

it('a focus with boot brings an idle thread with no harness up, and its next send reads live with boot=focus', async () => {
  const id = await down()
  expect(registry.preconnectIdle(id, { boot: true })).toBe(true)
  await settle()
  expect(starts).toEqual([id])
  expect(registry.liveIds().has(id)).toBe(true)
  // Idle as before: nothing on the transcript.
  expect(registry.get(id)?.status).toBe('idle')
  expect(registry.eventsAfter(id, 0).map((r) => r.event.type)).not.toContain('status')
  const lines: string[] = []
  ;(registry as unknown as { spans: { options: { write: (l: string) => void } } }).spans.options.write = (l) => lines.push(l)
  await registry.send(id, 'go')
  await settle()
  ;(registry as unknown as { spans: { flush: (id: string) => void } }).spans.flush(id)
  expect(lines.join('\n')).toMatch(/handle=\d+\(live boot=focus\)/)
  expect(starts).toEqual([id])
})

it('a focus without boot opens the socket and boots nothing', async () => {
  const id = await down()
  expect(registry.preconnectIdle(id)).toBe(true)
  await settle()
  expect(starts).toEqual([])
  expect(preconnects.length).toBeGreaterThan(0)
})

it('boots at most once per thread in 30 s', async () => {
  const id = await down()
  vi.useFakeTimers({ toFake: ['Date'] })
  registry.focusBoot(registry.get(id)!)
  await settle()
  registry.reclaimIdle(100)
  expect(registry.focusBoot(registry.get(id)!)).toBe(false)
  vi.setSystemTime(Date.now() + FOCUS_BOOT_EVERY_MS)
  expect(registry.focusBoot(registry.get(id)!)).toBe(true)
  await settle()
  expect(starts).toEqual([id, id])
})

it('nothing boots for a thread with a harness, a paused, queued or archived one', async () => {
  const live = await registry.create({ cwd: root, provider: 'claude' })
  await settle()
  expect(registry.focusBoot(registry.get(live.id)!)).toBe(false)
  const id = await down()
  const meta = registry.get(id)!
  for (const status of ['paused', 'queued', 'running', 'error'] as const) {
    expect(registry.focusBoot({ ...meta, status })).toBe(false)
  }
  expect(registry.focusBoot({ ...meta, archived: true })).toBe(false)
  await settle()
  expect(starts).toEqual([])
})

it('ten threads focused in a row at the cap boot none', async () => {
  const ids: string[] = []
  for (let i = 0; i < 10; i++) ids.push(await down())
  // One live harness holds the one slot.
  cap = 1
  await registry.create({ cwd: root, provider: 'claude' })
  await settle()
  starts.length = 0
  for (const id of ids) registry.preconnectIdle(id, { boot: true })
  await settle()
  expect(starts).toEqual([])
})

it('nothing boots while a thread waits in the queue, even under the cap', async () => {
  const id = await down()
  const queue = registry.scheduler as unknown as { reg: { queued: () => unknown[] } }
  const real = queue.reg.queued
  queue.reg.queued = () => [{ id: 'waiting' }]
  try {
    expect(registry.focusBoot(registry.get(id)!)).toBe(false)
  } finally {
    queue.reg.queued = real
  }
  expect(registry.focusBoot(registry.get(id)!)).toBe(true)
})

it("a focus-booted harness is an ordinary idle one: reclaimIdle puts it down", async () => {
  const id = await down()
  registry.focusBoot(registry.get(id)!)
  await settle()
  expect(registry.liveIds().has(id)).toBe(true)
  expect(registry.reclaimIdle(1).freed).toBe(1)
  expect(registry.liveIds().has(id)).toBe(false)
})

it("a draft's focus opens the socket for the router's pick of its project and creates nothing", async () => {
  store.insertWorkspace({ id: 'w', name: 'w', path: root, git: false, createdAt: 1 })
  store.insertProject({ id: 'p', workspaceId: 'w', name: 'p', mode: 'local', branch: null, cwd: root, archived: false, createdAt: 1 })
  const project = store.getProject('p')!
  const before = store.listSessions().length
  expect(registry.preconnectDraft({ provider: 'claude', model: 'claude-haiku-5-5', projectId: project.id })).toBe(true)
  expect(preconnects).toEqual([['claude', null]])
  expect(registry.preconnectDraft({ provider: 'cursor', model: 'x', projectId: project.id })).toBe(false)
  expect(() => registry.preconnectDraft({ provider: 'claude', model: 'm', projectId: 'nope' })).toThrow('unknown project')
  expect(store.listSessions().length).toBe(before)
})
