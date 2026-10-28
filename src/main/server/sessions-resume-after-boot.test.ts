import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/**
 * Surviving a host restart: the shutdown record of threads mid-turn, the
 * boot resume that boots each one again (in series, four at a time, paused
 * ones left alone), and the liveness sweep that flips a running thread with
 * no harness behind it to `stopped`. A fake claude driver whose boots the
 * test can hold open stands in for the harness.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()
const boots: string[] = []
const disposed: string[] = []
/** Boots the test holds: start() waits until the test releases the id. */
const held = new Map<string, () => void>()
let holdBoots = false
let alive = true
const failBoots = new Set<string>()

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        const id = ctx.session.id
        boots.push(id)
        if (failBoots.has(id)) throw new Error('boot refused')
        if (holdBoots) await new Promise<void>((release) => held.set(id, release))
        emits.set(id, ctx.emit)
        return {
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
          alive: () => alive,
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
  root = await mkdtemp(join(tmpdir(), 'tc-resume-boot-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  emits.clear()
  sends.clear()
  held.clear()
  boots.length = 0
  disposed.length = 0
  holdBoots = false
  alive = true
  failBoots.clear()
})
afterEach(async () => {
  vi.useRealTimers()
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

/** A session with a live handle, mid-turn (the fake send stamps running). */
async function live(parentId?: string): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude', parentId })
  await registry.send(s.id, 'go')
  await settle()
  return s.id
}

// ── the shutdown record ──────────────────────────────────────────────────

it('the ledger holds a thread while a harness works its turn, and lets go when the turn settles', async () => {
  const id = await live()
  const userSeq = registry.eventsAfter(id, 0).find((row) => row.event.type === 'user-text')!.seq
  expect(store.listResumeAfterBoot()).toMatchObject([{ sessionId: id, lastUserSeq: userSeq, shutdownAt: null }])
  emits.get(id)!({ type: 'status', status: 'idle' })
  expect(store.listResumeAfterBoot()).toEqual([])
  // A pause by the user clears it too; Continue writes it again.
  await registry.send(id, 'more')
  await settle()
  expect(store.listResumeAfterBoot()).toHaveLength(1)
  await registry.pauseRun(id)
  expect(store.listResumeAfterBoot()).toEqual([])
  await registry.resumePausedRun(id)
  expect(store.listResumeAfterBoot()).toHaveLength(1)
  // Deleting the thread takes its row.
  await registry.delete(id)
  expect(store.listResumeAfterBoot()).toEqual([])
})

it('the shutdown record stamps every running thread with a harness behind it, and nothing else', async () => {
  const running = await live()
  const paused = await live()
  await registry.pauseRun(paused)
  const idle = (await registry.create({ cwd: root, provider: 'claude' })).id
  // Running on the row, but no harness behind it (create warms one; restart
  // drops it): nothing to cut, so nothing to resume.
  const orphan = (await registry.create({ cwd: root, provider: 'claude' })).id
  await registry.restart(orphan)
  store.updateSession(orphan, { status: 'running' })

  const recorded = registry.recordForResume(1_000)
  expect(recorded).toEqual([running])
  const userSeq = registry
    .eventsAfter(running, 0)
    .find((row) => row.event.type === 'user-text')!.seq
  expect(store.listResumeAfterBoot()).toEqual([
    { sessionId: running, recordedAt: 1_000, lastUserSeq: userSeq, shutdownAt: 1_000 }
  ])
  expect(store.getSession(paused)?.status).toBe('paused')
  expect(store.getSession(idle)?.status).toBe('idle')
})

it('records a thread still queued for a boot resume, so a second restart keeps it', async () => {
  const queued = (await registry.create({ cwd: root, provider: 'claude' })).id
  await registry.restart(queued)
  store.updateSession(queued, { status: 'running' })
  registry.resumePending.add(queued)
  expect(registry.recordForResume(5)).toEqual([queued])
  expect(store.listResumeAfterBoot()).toEqual([{ sessionId: queued, recordedAt: 5, lastUserSeq: null, shutdownAt: 5 }])
})

it('a second record of the same thread keeps one row with the newer time', async () => {
  const id = await live()
  registry.recordForResume(1)
  registry.recordForResume(2)
  expect(store.listResumeAfterBoot().map((r) => [r.sessionId, r.recordedAt])).toEqual([[id, 2]])
})

// ── the boot resume ──────────────────────────────────────────────────────

import { BootResumer } from './resumeAfterBoot'

/** Peak number of boots held open at once while the resumer ran. */
async function drainHeld(expectTotal: number): Promise<{ peak: number; order: string[] }> {
  let peak = 0
  const order: string[] = []
  while (order.length < expectTotal) {
    await settle()
    peak = Math.max(peak, held.size)
    const [id, release] = [...held.entries()][0] ?? []
    if (!id || !release) continue
    held.delete(id)
    order.push(id)
    release()
  }
  return { peak, order }
}

it('resumes recorded threads four at a time, children first, with the restart nudge, and clears the rows', async () => {
  const parent = await live()
  const children = [await live(parent), await live(parent)]
  const roots = [await live(), await live(), await live()]
  const paused = await live()
  await registry.pauseRun(paused)
  // The paused thread was recorded by an earlier process's rules; today's never records it.
  registry.recordForResume(10)
  store.recordResumeAfterBoot([{ sessionId: paused, recordedAt: 10, lastUserSeq: null, shutdownAt: 10 }])
  store.recordResumeAfterBoot([{ sessionId: 'gone-thread', recordedAt: 10, lastUserSeq: null, shutdownAt: 10 }])
  // A new process: no handles, rows still say running.
  await registry.disposeAll()
  registry = new SessionRegistry(store)
  registry.resetStaleStatuses()
  for (const id of [parent, ...children, ...roots]) expect(store.getSession(id)?.status).toBe('running')
  boots.length = 0
  sends.clear()
  holdBoots = true
  const notices: { count: number; at: number }[] = []
  const resumer = new BootResumer({ store, registry, gapMs: 0, now: () => 777, log: () => {} })
  resumer.onDone((n) => notices.push(n))
  const run = resumer.run()
  await settle()
  // Four are booting (their `starting` promise covers them); the two still
  // queued stay exempt from the liveness sweep and re-recordable.
  expect(registry.resumePending.size).toBe(2)
  const { peak, order } = await drainHeld(6)
  const result = await run
  expect(peak).toBe(4)
  expect(order.slice(0, 2).sort()).toEqual(children.sort())
  expect(result.resumed.sort()).toEqual([parent, ...children, ...roots].sort())
  expect(result.skipped.sort()).toEqual([paused, 'gone-thread'].sort())
  expect(result.failed).toEqual([])
  expect(result.at).toBe(777)
  // Mid-turn again: each resumed thread holds a fresh row of its own, with no shutdown stamp.
  const ledger = store.listResumeAfterBoot()
  expect(ledger.map((r) => r.sessionId).sort()).toEqual([parent, ...children, ...roots].sort())
  expect(ledger.every((r) => r.shutdownAt === null)).toBe(true)
  expect(registry.resumePending.size).toBe(0)
  expect(store.getSession(paused)?.status).toBe('paused')
  for (const id of [parent, ...children, ...roots]) {
    expect(store.getSession(id)?.status).toBe('running')
    const sent = sends.get(id) ?? []
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(`The host restarted during your turn at ${new Date(10).toISOString()}; continue where you left off.`)
    expect(sent[0]).toMatch(/^<host-restarted>\n/)
    const rows = registry.eventsAfter(id, 0)
    const last = rows[rows.length - 1]!.event
    expect(last).toMatchObject({ type: 'status', status: 'running' })
    expect(rows.some((r) => r.event.type === 'status' && r.event.detail?.startsWith('Resumed after the host restarted at '))).toBe(true)
  }
  expect(notices).toEqual([{ count: 6, at: 777 }])
  expect(resumer.notice).toEqual({ count: 6, at: 777 })
  // A second run is the first one.
  expect(await resumer.run()).toBe(result)
})

it('a boot with nothing recorded resumes nothing and announces nothing', async () => {
  const notices: unknown[] = []
  const resumer = new BootResumer({ store, registry, gapMs: 0, log: () => {} })
  resumer.onDone((n) => notices.push(n))
  const result = await resumer.run()
  expect(result).toMatchObject({ resumed: [], skipped: [], failed: [] })
  expect(notices).toEqual([])
  expect(resumer.notice).toBeNull()
})

it('a harness that will not boot leaves the thread in error, counted as failed, and the others still resume', async () => {
  const good = await live()
  const bad = await live()
  registry.recordForResume(20)
  await registry.disposeAll()
  failBoots.add(bad)
  registry = new SessionRegistry(store)
  sends.clear()
  const resumer = new BootResumer({ store, registry, gapMs: 0, log: () => {} })
  const result = await resumer.run()
  expect(result.resumed).toEqual([good])
  expect(result.failed).toEqual([bad])
  expect(store.getSession(bad)?.status).toBe('error')
  expect(store.getSession(good)?.status).toBe('running')
  expect(resumer.notice).toEqual({ count: 1, at: result.at })
  expect(store.listResumeAfterBoot().map((r) => r.sessionId)).toEqual([good])
})

it('a row with no shutdown stamp (the process died without its handler) is nudged with the boot time', async () => {
  const id = await live()
  await registry.disposeAll()
  registry = new SessionRegistry(store)
  expect(store.listResumeAfterBoot()).toMatchObject([{ sessionId: id, shutdownAt: null }])
  sends.clear()
  const resumer = new BootResumer({ store, registry, gapMs: 0, now: () => 4_000, log: () => {} })
  const result = await resumer.run()
  expect(result.resumed).toEqual([id])
  expect(sends.get(id)?.[0]).toContain(`restarted during your turn at ${new Date(4_000).toISOString()}`)
})

it('resumeStopped carries the working clock across: a stopped thread resumes with its frozen time', async () => {
  const id = await live()
  await registry.disposeAll()
  registry = new SessionRegistry(store)
  store.updateSession(id, { status: 'stopped', busySince: null, frozenActiveElapsed: 90_000 })
  const before = Date.now()
  expect(await registry.resumeStopped(id)).toBe(true)
  const meta = store.getSession(id)!
  expect(meta.status).toBe('running')
  expect(meta.frozenActiveElapsed).toBeNull()
  expect(before - (meta.busySince ?? 0)).toBeGreaterThanOrEqual(89_000)
  expect((sends.get(id) ?? []).at(-1)).toContain('The harness behind your turn was gone and has been started again')
})

it('resumeStopped leaves a paused thread paused', async () => {
  const id = await live()
  await registry.pauseRun(id)
  sends.clear()
  expect(await registry.resumeStopped(id)).toBe(false)
  expect(store.getSession(id)?.status).toBe('paused')
  expect(sends.get(id)).toBeUndefined()
})

// ── liveness: running with no harness → stopped ─────────────────────────

import { HARNESS_GONE_GRACE_MS } from './sessions'

it('a running thread with no harness flips to stopped once the grace is up, and keeps its working time', async () => {
  const id = await live()
  await registry.disposeAll()
  registry = new SessionRegistry(store)
  store.updateSession(id, { status: 'running', busySince: 1_000_000 - 30_000 })
  // First sighting starts the clock; nothing flips yet.
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, 1_000_000)).toEqual([])
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, 1_000_000 + HARNESS_GONE_GRACE_MS - 1)).toEqual([])
  expect(store.getSession(id)?.status).toBe('running')
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, 1_000_000 + HARNESS_GONE_GRACE_MS)).toEqual([id])
  const meta = store.getSession(id)!
  expect(meta.status).toBe('stopped')
  expect(meta.busySince).toBeNull()
  expect(meta.frozenActiveElapsed).toBe(30_000 + HARNESS_GONE_GRACE_MS)
  const rows = registry.eventsAfter(id, 0)
  expect(rows.at(-1)!.event).toMatchObject({ type: 'status', status: 'stopped', detail: 'The harness behind this turn is gone' })
  // Settled: a later sweep has nothing to say about it.
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, 2_000_000)).toEqual([])
})

it('a thread whose harness is alive, is booting, or waits for the boot resume never flips', async () => {
  const withHandle = await live()
  const queued = await live()
  await registry.restart(queued)
  store.updateSession(queued, { status: 'running' })
  registry.resumePending.add(queued)
  const booting = (await registry.create({ cwd: root, provider: 'claude' })).id
  await registry.restart(booting)
  store.updateSession(booting, { status: 'idle' })
  // The boot the send starts is held open: a `starting` promise, no handle yet.
  holdBoots = true
  const bootP = registry.send(booting, 'go')
  await settle()
  const far = Date.now() + 10 * HARNESS_GONE_GRACE_MS
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, Date.now())).toEqual([])
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, far)).toEqual([])
  for (const id of [withHandle, queued]) expect(store.getSession(id)?.status).toBe('running')
  expect(store.getSession(booting)?.status).toBe('starting')
  held.get(booting)?.()
  await bootP
})

it('a handle whose process is gone counts as no harness', async () => {
  const id = await live()
  alive = false
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, 5_000_000)).toEqual([])
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, 5_000_000 + HARNESS_GONE_GRACE_MS)).toEqual([id])
  expect(store.getSession(id)?.status).toBe('stopped')
  expect(disposed).toContain(id)
})

it('a paused thread is never a liveness candidate', async () => {
  const id = await live()
  await registry.pauseRun(id)
  await registry.disposeAll()
  registry = new SessionRegistry(store)
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, 1)).toEqual([])
  expect(registry.sweepLiveness(HARNESS_GONE_GRACE_MS, 1 + 10 * HARNESS_GONE_GRACE_MS)).toEqual([])
  expect(store.getSession(id)?.status).toBe('paused')
})

it('the sweep runs on its timer', async () => {
  const id = await live()
  await registry.disposeAll()
  registry = new SessionRegistry(store)
  store.updateSession(id, { status: 'running' })
  vi.useFakeTimers()
  registry.startLivenessSweep(20_000, 5_000)
  vi.advanceTimersByTime(5_000)
  expect(store.getSession(id)?.status).toBe('running')
  vi.advanceTimersByTime(25_000)
  expect(store.getSession(id)?.status).toBe('stopped')
})

it('Resume on a stopped thread boots a fresh harness and the thread runs again', async () => {
  const id = await live()
  await registry.disposeAll()
  registry = new SessionRegistry(store)
  store.updateSession(id, { status: 'running' })
  registry.sweepLiveness(0, 1)
  registry.sweepLiveness(0, 2)
  expect(store.getSession(id)?.status).toBe('stopped')
  sends.clear()
  expect(await registry.resumeStopped(id)).toBe(true)
  expect(store.getSession(id)?.status).toBe('running')
  expect(sends.get(id)?.[0]).toContain('<host-restarted>')
  // Alive again: the sweep leaves it alone.
  expect(registry.sweepLiveness(0, 3)).toEqual([])
  expect(registry.sweepLiveness(0, 4)).toEqual([])
})

it('resumes up to the running cap and leaves the rest queued with their nudge, started oldest first as slots free', async () => {
  const ids = [await live(), await live(), await live(), await live()]
  registry.recordForResume(10)
  await registry.disposeAll()
  registry = new SessionRegistry(store)
  registry.resetStaleStatuses()
  registry.admission = { cap: () => 2, memoryLow: () => false }
  registry.reclaimGraceMs = 0
  sends.clear()
  const resumer = new BootResumer({ store, registry, gapMs: 0, now: () => 777, log: () => {} })
  registry.scheduler.holdUntil(resumer.run())
  const result = await resumer.run()
  await settle()
  expect(result.resumed).toHaveLength(2)
  expect(result.queued).toHaveLength(2)
  expect(resumer.notice).toEqual({ count: 2, at: 777 })
  for (const id of result.queued) {
    expect(store.getSession(id)?.status).toBe('queued')
    expect(registry.get(id)?.activity).toBe('Queued  2 of 2 running')
    expect(sends.has(id)).toBe(false)
  }
  // The queued ones keep their ledger rows: another restart now resumes them all the same.
  expect(store.listResumeAfterBoot().map((r) => r.sessionId).sort()).toEqual([...ids].sort())
  // A resumed thread settles: its slot goes to the oldest queued one, resumed with the restart's nudge.
  const [first, second] = [...result.queued].sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
  emits.get(result.resumed[0]!)!({ type: 'status', status: 'idle' })
  await settle()
  expect(store.getSession(first!)?.status).toBe('running')
  expect(store.getSession(second!)?.status).toBe('queued')
  expect(sends.get(first!)).toHaveLength(1)
  expect(sends.get(first!)![0]).toContain(`The host restarted during your turn at ${new Date(10).toISOString()}`)
  // No user row was added for the resume: the transcript keeps the one message.
  expect(registry.eventsAfter(first!, 0).filter((r) => r.event.type === 'user-text')).toHaveLength(1)
})
