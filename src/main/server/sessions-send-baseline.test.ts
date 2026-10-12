import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { CheckpointStore } from './checkpoint'
import type { DriverCtx } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/**
 * A send reaches the harness while the undo baseline is still being taken.
 * The fake driver records when send() was called; the fake checkpoint store
 * holds ensure() open until the test releases it.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, { text: string; at: number }[]>()
const ctxs = new Map<string, DriverCtx>()
const boot = { fail: false }
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        if (boot.fail) throw new Error('claude is not installed')
        const id = ctx.session.id
        emits.set(id, ctx.emit)
        ctxs.set(id, ctx)
        return {
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), { text, at: Date.now() }])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
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
let releaseEnsure: () => void = () => {}
let ensureCalls = 0
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-send-baseline-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  ensureCalls = 0
  registry.checkpoints = {
    ensure: () => {
      ensureCalls += 1
      return new Promise<void>((resolve) => {
        releaseEnsure = resolve
      })
    }
  } as unknown as CheckpointStore
  emits.clear()
  sends.clear()
  ctxs.clear()
  boot.fail = false
})
afterEach(async () => {
  releaseEnsure()
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const rows = (id: string) =>
  registry
    .eventsAfter(id, 0)
    .map((r) => ({ ts: r.ts, type: `${r.event.type}${r.event.type === 'status' ? ':' + r.event.status : ''}` }))

it('the message reaches the harness without waiting on the checkpoint baseline', async () => {
  const s = await registry.create({ cwd: root, provider: 'claude' })
  const before = Date.now()
  await registry.send(s.id, 'go')
  const after = Date.now()
  expect(ensureCalls).toBe(1)
  expect(sends.get(s.id)?.map((x) => x.text)).toEqual(['go'])
  // ensure is still open; the send did not wait for it.
  expect(after - before).toBeLessThan(500)

  // The user row and 'starting' precede the harness's own 'running'.
  const types = rows(s.id).map((r) => r.type)
  expect(types).toEqual(['user-text', 'status:starting', 'status:running'])
  // busySince anchors to the 'starting' row the send wrote, not the later running.
  const starting = rows(s.id).find((r) => r.type === 'status:starting')!
  expect(registry.get(s.id)?.busySince).toBe(starting.ts)
  expect(registry.get(s.id)?.status).toBe('running')

  // The driver's write gate waits on the baseline and releases with it.
  let landed = false
  void ctxs.get(s.id)!.awaitBaseline!().then(() => (landed = true))
  await new Promise((r) => setTimeout(r, 10))
  expect(landed).toBe(false)
  releaseEnsure()
  await new Promise((r) => setTimeout(r, 10))
  expect(landed).toBe(true)
  // Nothing in flight: the gate opens at once.
  await ctxs.get(s.id)!.awaitBaseline!()
})

it('a steer into a running turn keeps the running status and the original busySince', async () => {
  const s = await registry.create({ cwd: root, provider: 'claude' })
  await registry.send(s.id, 'first')
  const since = registry.get(s.id)?.busySince
  await new Promise((r) => setTimeout(r, 5))
  await registry.send(s.id, 'steer')
  const types = rows(s.id).map((r) => r.type)
  expect(types).toEqual(['user-text', 'status:starting', 'status:running', 'user-text', 'status:running'])
  expect(registry.get(s.id)?.busySince).toBe(since)
})

it('a harness that fails to boot leaves one user row; the retry does not echo it again', async () => {
  // create() boots the handle eagerly, so the failure must be armed first.
  boot.fail = true
  const s = await registry.create({ cwd: root, provider: 'claude' })
  await new Promise((r) => setTimeout(r, 10))
  await registry.send(s.id, 'hello there')
  expect(rows(s.id).filter((r) => r.type === 'user-text')).toHaveLength(1)
  expect(registry.get(s.id)?.status).toBe('error')
  const queued = registry.queueList(s.id)
  expect(queued.map((m) => m.text)).toEqual(['hello there'])

  boot.fail = false
  await registry.queueSteer(s.id, queued[0].id)
  expect(sends.get(s.id)?.map((x) => x.text)).toEqual(['hello there'])
  expect(rows(s.id).filter((r) => r.type === 'user-text')).toHaveLength(1)
  expect(registry.queueList(s.id)).toEqual([])
})

it('a send returns in under 100 ms while a 30 s ensure and a 30 s status are both in flight', async () => {
  // A checkpoint store whose chain is held: ensure() hangs (the baseline the
  // send arms), and a status() queued behind it hangs with it — the review
  // panel's request for this same session.
  let statusCalls = 0
  registry.checkpoints = {
    ensure: () => {
      ensureCalls += 1
      return new Promise<void>((resolve) => {
        releaseEnsure = resolve
      })
    },
    status: () => {
      statusCalls += 1
      return new Promise<never>(() => {})
    }
  } as unknown as CheckpointStore
  const s = await registry.create({ cwd: root, provider: 'claude' })
  await registry.send(s.id, 'first')
  // both in flight now: the armed baseline and a panel's status
  void registry.checkpoints.status(s.id, root)
  expect(ensureCalls).toBeGreaterThan(0)
  expect(statusCalls).toBe(1)
  const before = performance.now()
  await registry.send(s.id, 'second')
  const took = performance.now() - before
  expect(took).toBeLessThan(100)
  expect(sends.get(s.id)?.map((x) => x.text)).toEqual(['first', 'second'])
  expect(rows(s.id).filter((r) => r.type === 'user-text')).toHaveLength(2)
})
