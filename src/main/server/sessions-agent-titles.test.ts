import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { BUILT_IN_DRIVERS } from './drivers'
import type { DriverCtx, DriverHandle } from './drivers/types'
import * as stalls from './stalls'
import type { TurnPass } from '@shared/turnpass'
import type { PlanFlowRegistry } from './planFlow'

/**
 * A subagent's title and the wait's words through the registry: the title
 * a spawn without one gets from its task, and the status line of a turn a
 * wait_for_agent holds on its agents.
 */
const titles: { text: string; resolve: (title: string | null) => void; reject: (error: Error) => void }[] = []
const contexts = new Map<string, DriverCtx>()
vi.mock('./drivers/title', () => ({
  generateTitle: (text: string) => new Promise<string | null>((resolve, reject) => titles.push({ text, resolve, reject }))
}))
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        contexts.set(ctx.session.id, ctx)
        return {
          send: async () => ctx.emit({ type: 'status', status: 'running' }),
          alive: () => true,
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
let dbClosed: boolean
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-agent-titles-'))
  db = openDb(join(root, 'test.db'))
  dbClosed = false
  store = new Store(db)
  registry = new SessionRegistry(store)
  titles.length = 0
  contexts.clear()
})
afterEach(async () => {
  await registry.close()
  closeDb()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

function closeDb(): void {
  if (dbClosed) return
  db.close()
  dbClosed = true
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function child(title: string, parentId?: string): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude', title, ...(parentId ? { parentId } : {}) })
  return s.id
}

it('titleFromTask replaces the first line with the written title', async () => {
  const id = await child('Audit the gateway')
  registry.titleFromTask(id, 'Audit the gateway\nevery forward path')
  expect(titles.map((t) => t.text)).toEqual(['Audit the gateway\nevery forward path'])
  expect(registry.get(id)?.title).toBe('Audit the gateway')
  titles[0].resolve('Gateway deadline audit')
  await settle()
  expect(registry.get(id)?.title).toBe('Gateway deadline audit')
})

it('a rename before the title lands wins', async () => {
  const id = await child('Audit the gateway')
  registry.titleFromTask(id, 'Audit the gateway')
  await registry.rename(id, 'My own name')
  titles[0].resolve('Gateway deadline audit')
  await settle()
  expect(registry.get(id)?.title).toBe('My own name')
})

it('no title back keeps the first line', async () => {
  const id = await child('Audit the gateway')
  registry.titleFromTask(id, 'Audit the gateway')
  titles[0].resolve(null)
  await settle()
  expect(registry.get(id)?.title).toBe('Audit the gateway')
})

it('disposeAll keeps a title in flight and lets the next send boot a fresh harness', async () => {
  const id = await child('Audit the gateway')
  await registry.send(id, 'go')
  const previous = contexts.get(id)!
  const handle = (registry as unknown as { handles: Map<string, DriverHandle> }).handles.get(id)!
  const dispose = vi.spyOn(handle, 'dispose')
  registry.titleFromTask(id, 'Audit the gateway')
  await registry.disposeAll()
  expect(dispose).toHaveBeenCalledTimes(1)
  titles[0].resolve('Gateway deadline audit')
  await settle()
  expect(registry.get(id)?.title).toBe('Gateway deadline audit')
  await registry.send(id, 'carry on')
  expect(contexts.get(id)).not.toBe(previous)
  expect(registry.get(id)?.status).toBe('running')
})

it('disposeAll keeps a title waiting for the first turn to finish after a restart', async () => {
  const session = await registry.startWith({ cwd: root, provider: 'claude' }, 'Audit the gateway')
  expect(titles).toHaveLength(0)
  await registry.disposeAll()
  await registry.send(session.id, 'carry on')
  contexts.get(session.id)!.emit({ type: 'turn-complete' })
  expect(titles.map((title) => title.text)).toEqual(['Audit the gateway'])
  titles[0].resolve('Gateway deadline audit')
  await settle()
  expect(registry.get(session.id)?.title).toBe('Gateway deadline audit')
})

it.each(['task', 'first turn'])('a %s title that resolves after close never reads or updates the store', async (source) => {
  let id: string
  if (source === 'task') {
    id = await child('Audit the gateway')
    registry.titleFromTask(id, 'Audit the gateway')
  } else {
    const session = await registry.startWith({ cwd: root, provider: 'claude' }, 'Audit the gateway')
    id = session.id
    registry.append(id, { type: 'turn-complete' })
  }
  expect(titles).toHaveLength(1)
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const update = vi.spyOn(store, 'updateSession')
  const meta = vi.fn()
  registry.onMeta(meta)
  titles[0].resolve('Gateway deadline audit')
  await settle()
  expect(read).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
  expect(meta).not.toHaveBeenCalled()
  expect(() => registry.titleFromTask(id, 'Another title')).not.toThrow()
  expect(read).not.toHaveBeenCalled()
})

it('close blocks a title before driver teardown finishes', async () => {
  const id = await child('Audit the gateway')
  await registry.send(id, 'go')
  const stopped = deferred<void>()
  const handle = (registry as unknown as { handles: Map<string, DriverHandle> }).handles.get(id)!
  vi.spyOn(handle, 'dispose').mockReturnValue(stopped.promise)
  registry.titleFromTask(id, 'Audit the gateway')
  const closing = registry.close()
  const read = vi.spyOn(store, 'getSession')
  const update = vi.spyOn(store, 'updateSession')
  titles[0].resolve('Gateway deadline audit')
  await settle()
  stopped.resolve()
  await closing
  expect(read).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it.each(['generation', 'update'])('a title %s failure logs once and never rejects without a handler', async (failure) => {
  const id = await child('Audit the gateway')
  registry.titleFromTask(id, 'Audit the gateway')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  if (failure === 'generation') titles[0].reject(new Error('title failed'))
  else {
    vi.spyOn(store, 'updateSession').mockImplementationOnce(() => { throw new Error('title failed') })
    titles[0].resolve('Gateway deadline audit')
  }
  await settle()
  expect(warn).toHaveBeenCalledExactlyOnceWith(`[sessions] title for ${id} failed: title failed`)
  expect(registry.get(id)?.title).toBe('Audit the gateway')
})

it('a title promise that rejects after close is still handled', async () => {
  const id = await child('Audit the gateway')
  registry.titleFromTask(id, 'Audit the gateway')
  await registry.close()
  closeDb()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  titles[0].reject(new Error('late failure'))
  await settle()
  expect(warn).toHaveBeenCalledExactlyOnceWith(`[sessions] title for ${id} failed: late failure`)
})

it('close clears titles waiting for their first turn and ignores late driver callbacks', async () => {
  const session = await registry.startWith({ cwd: root, provider: 'claude' }, 'Audit the gateway')
  const pending = (registry as unknown as { pendingTitles: Map<string, unknown> }).pendingTitles
  expect(pending.size).toBe(1)
  const ctx = contexts.get(session.id)!
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const update = vi.spyOn(store, 'updateSession')
  expect(pending.size).toBe(0)
  ctx.emit({ type: 'turn-complete' })
  ctx.emit({ type: 'steer', steerId: 'late', state: 'sent' })
  ctx.observeUsage?.([])
  ctx.observeLimit?.('5h', Date.now())
  ctx.setNativeId('late-native-id')
  ctx.nativeSessionLost?.()
  ctx.harnessGone?.()
  ctx.mark?.('first-content')
  await expect(ctx.requestApproval!({ toolName: 'shell', input: {} })).resolves.toBe(false)
  await ctx.awaitBaseline?.()
  expect(read).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
  expect(titles).toHaveLength(0)
})

it('a driver that finishes booting after close is disposed without touching the store', async () => {
  const boot = deferred<DriverHandle>()
  vi.spyOn(BUILT_IN_DRIVERS.claude, 'start').mockReturnValueOnce(boot.promise)
  await child('Audit the gateway')
  await settle()
  expect(BUILT_IN_DRIVERS.claude.start).toHaveBeenCalledTimes(1)
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const update = vi.spyOn(store, 'updateSession')
  const dispose = vi.fn(async () => {})
  boot.resolve({ send: async () => {}, interrupt: () => {}, dispose })
  await settle()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(read).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it('reports arriving or waiting on a reboot when close starts leave the store alone', async () => {
  const id = await child('Parent')
  await settle()
  const reboot = deferred<void>()
  const internals = registry as unknown as { rebootIfStale: (id: string) => Promise<void> }
  vi.spyOn(internals, 'rebootIfStale').mockReturnValueOnce(reboot.promise)
  const report = { agentId: 'child', title: 'Review', status: 'done' as const, text: 'Review complete' }
  registry.deliverAgentReport(id, report)
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const update = vi.spyOn(store, 'updateSession')
  reboot.resolve()
  registry.deliverAgentReport(id, report)
  registry.masterIdle(id)
  expect(registry.sweepLiveness()).toEqual([])
  registry.commitFolds([])
  await settle()
  expect(read).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it('a fold warm-up that finishes after close never lands its row', async () => {
  const id = await child('Audit the gateway')
  await settle()
  await registry.close()
  registry = new SessionRegistry(store)
  const row = store.appendEvent(id, { type: 'user-text', text: 'go' })
  const rows = deferred<Awaited<ReturnType<Store['readRows']>>>()
  vi.spyOn(store, 'readRows').mockReturnValueOnce(rows.promise)
  const internals = registry as unknown as { todoFoldOf: (id: string) => unknown }
  internals.todoFoldOf(id)
  const warming = registry.whenFoldWarm(id)
  expect(store.readRows).toHaveBeenCalledTimes(1)
  await registry.close()
  closeDb()
  const put = vi.spyOn(store, 'putFold')
  const read = vi.spyOn(store, 'getSession')
  rows.resolve([row])
  await warming
  expect(put).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('an account refresh stops between slices when close starts', async () => {
  await child('One')
  await child('Two')
  await settle()
  const pause = deferred<void>()
  vi.spyOn(stalls, 'yieldUntilIdle').mockReturnValueOnce(pause.promise)
  const refresh = vi.spyOn(registry, 'refreshAccount')
  const internals = registry as unknown as { expectAccountsSliced: (match: () => boolean, slice: number) => Promise<void> }
  const refreshing = internals.expectAccountsSliced(() => true, 1)
  expect(refresh).toHaveBeenCalledTimes(1)
  await registry.close()
  closeDb()
  pause.resolve()
  await refreshing
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('a failover that resolves after close never changes the account or schedules a continue', async () => {
  const id = await child('Audit the gateway')
  await settle()
  const switched = deferred<{ from: string; to: string } | null>()
  const failover = vi.fn(() => switched.promise)
  registry.limits = { routeFor: () => ({ route: null, current: null }), failover }
  registry.append(id, { type: 'error', message: 'Usage limit', limit: { window: '5h' } })
  expect(failover).toHaveBeenCalledTimes(1)
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const update = vi.spyOn(store, 'updateSession')
  const resume = vi.spyOn(registry, 'continueRun')
  switched.resolve({ from: 'a', to: 'b' })
  await settle()
  expect(read).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
})

it('disposeAll keeps the limit-continue and provider-wait timers until close cancels them', async () => {
  const id = await child('Audit the gateway')
  await settle()
  registry.limits = {
    routeFor: () => ({ route: null, current: null }),
    failover: async () => ({ from: 'a', to: 'b' })
  }
  registry.append(id, { type: 'error', message: 'Usage limit', limit: { window: '5h' } })
  registry.providerRequest(id, 1, Date.now())
  await settle()
  const timers = registry as unknown as {
    limitContinues: Map<string, { timer: ReturnType<typeof setTimeout> }>
    providerTicker: ReturnType<typeof setInterval> | null
  }
  expect(timers.limitContinues.size).toBe(1)
  expect(timers.providerTicker).not.toBeNull()
  const timeout = [...timers.limitContinues.values()][0].timer
  const interval = timers.providerTicker!
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
  const clearTicker = vi.spyOn(globalThis, 'clearInterval')
  await registry.disposeAll()
  expect(clearTimer).not.toHaveBeenCalledWith(timeout)
  expect(clearTicker).not.toHaveBeenCalledWith(interval)
  expect(timers.limitContinues.size).toBe(1)
  expect(timers.providerTicker).toBe(interval)
  await registry.close()
  expect(clearTimer).toHaveBeenCalledWith(timeout)
  expect(clearTicker).toHaveBeenCalledWith(interval)
  expect(timers.limitContinues.size).toBe(0)
  expect(timers.providerTicker).toBeNull()
})

it.each(['resolve', 'reject'])('a steer that settles by %s after close does not write a stamp or requeue', async (result) => {
  const id = await child('Audit the gateway')
  await registry.send(id, 'go')
  const handle = (registry as unknown as { handles: Map<string, DriverHandle> }).handles.get(id)!
  const sent = deferred<void>()
  vi.spyOn(handle, 'send').mockReturnValueOnce(sent.promise)
  const internals = registry as unknown as { steerLive: (id: string, text: string) => boolean }
  expect(internals.steerLive(id, 'more work')).toBe(true)
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const append = vi.spyOn(store, 'appendEvent')
  const requeue = vi.spyOn(registry, 'queueAdd')
  if (result === 'resolve') sent.resolve()
  else sent.reject(new Error('harness gone'))
  await settle()
  expect(read).not.toHaveBeenCalled()
  expect(append).not.toHaveBeenCalled()
  expect(requeue).not.toHaveBeenCalled()
})

it.each(['notes', 'turn pass'])('a %s reminder waiting on a reboot stops after close', async (kind) => {
  const id = await child('Audit the gateway')
  await settle()
  const reboot = deferred<void>()
  const internals = registry as unknown as {
    rebootIfStale: (id: string) => Promise<void>
    runNotesReminder: (id: string) => Promise<void>
    runTurnPass: (id: string, pass: TurnPass) => Promise<void>
  }
  vi.spyOn(internals, 'rebootIfStale').mockReturnValueOnce(reboot.promise)
  const reminding = kind === 'notes'
    ? internals.runNotesReminder(id)
    : internals.runTurnPass(id, { verify: true, build: false, commit: 'off' })
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const append = vi.spyOn(store, 'appendEvent')
  reboot.resolve()
  await reminding
  expect(read).not.toHaveBeenCalled()
  expect(append).not.toHaveBeenCalled()
})

it('native-session recovery stops after its pending wait when close starts', async () => {
  const id = await child('Audit the gateway')
  await registry.send(id, 'go')
  contexts.get(id)!.nativeSessionLost?.()
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const update = vi.spyOn(store, 'updateSession')
  await new Promise((resolve) => setTimeout(resolve, 275))
  expect(read).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it('plan settlement callbacks captured before close cannot use the store after close', async () => {
  const id = await child('Plan')
  await settle()
  const flow = (registry as unknown as { planFlow: () => PlanFlowRegistry }).planFlow()
  await registry.close()
  closeDb()
  expect(flow.get(id)).toBeNull()
  expect(flow.listSessions()).toEqual([])
  expect(flow.getSetting('plans')).toBeNull()
  expect(() => flow.setSetting('plans', 'late')).not.toThrow()
  expect(flow.patch(id, { implementationId: 'late-build' })).toBeNull()
  flow.append(id, { type: 'status', status: 'idle' })
  await expect(flow.setArchived(id, true)).resolves.toBeUndefined()
  await expect(flow.startWith({ cwd: root, provider: 'claude' }, 'Late build')).rejects.toThrow('stopped while booting')
})

it.each(['resolve', 'reject'])('startWith avoids its final store read when send ends by %s after close', async (result) => {
  const sent = deferred<void>()
  vi.spyOn(registry, 'send').mockReturnValueOnce(sent.promise)
  const starting = registry.startWith({ cwd: root, provider: 'claude' }, 'Audit the gateway')
  await settle()
  expect(registry.send).toHaveBeenCalledTimes(1)
  await registry.close()
  closeDb()
  const read = vi.spyOn(store, 'getSession')
  const update = vi.spyOn(store, 'updateSession')
  if (result === 'resolve') sent.resolve()
  else sent.reject(new Error('send failed'))
  await expect(starting).rejects.toThrow(result === 'resolve' ? 'stopped while booting' : 'send failed')
  expect(read).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it('a turn held by a wait says the agents it waits on, by title, until the wait releases', async () => {
  const parent = await child('Parent')
  await registry.send(parent, 'go')
  await settle()
  const a = await child('Review the payment flow', parent)
  const b = await child('Audit the gateway', parent)
  expect(registry.get(parent)?.statusDetail).not.toMatch(/^Waiting on/)

  registry.setAwaiting(parent, [a], true)
  expect(registry.get(parent)?.statusDetail).toBe('Waiting on Review the payment flow')
  expect(registry.get(parent)?.activity).toBe('Waiting on Review the payment flow')

  registry.setAwaiting(parent, [b], true)
  expect(registry.get(parent)?.statusDetail).toBe('Waiting on 2 subagents')

  registry.setAwaiting(parent, [a, b], false)
  expect(registry.get(parent)?.statusDetail ?? '').not.toMatch(/^Waiting on/)
})

it('a thread created with a title keeps it through its first message and turn', async () => {
  const named = await registry.startWith({ cwd: root, provider: 'claude', threadType: 'chat', title: 'Gateway audit' }, 'Look at every forward path')
  registry.append(named.id, { type: 'turn-complete' })
  await settle()
  expect(registry.get(named.id)?.title).toBe('Gateway audit')
  expect(titles).toEqual([])
  // Without one the message names it, then the written title replaces that.
  const plain = await registry.startWith({ cwd: root, provider: 'claude', threadType: 'chat' }, 'Look at every forward path')
  expect(registry.get(plain.id)?.title).toBe('Look at every forward path')
  registry.append(plain.id, { type: 'turn-complete' })
  expect(titles.map((t) => t.text)).toEqual(['Look at every forward path'])
})
