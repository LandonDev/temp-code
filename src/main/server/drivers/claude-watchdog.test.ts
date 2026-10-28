import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverCtx } from './types'

vi.mock('electron', () => ({ nativeImage: { createFromPath: () => ({ isEmpty: () => true }) } }))
const { aliveOf, firstOutputOverdue, FIRST_OUTPUT_MS, newStreamState, startForgottenTimer } = await import('./claude')

/** The first-output watchdog's rule, the liveness read and the forgotten-task timer, as pure pieces. */
let events: AgentEvent[]
let ctx: DriverCtx
beforeEach(() => {
  events = []
  ctx = { session: { context1m: false } as SessionMeta, emit: (e) => events.push(e), setNativeId: () => {}, requestApproval: async () => false }
})
afterEach(() => vi.useRealTimers())

it('firstOutputOverdue: a message pushed FIRST_OUTPUT_MS ago with nothing back since', () => {
  expect(firstOutputOverdue({ sentAt: null }, 10_000_000)).toBe(false)
  expect(firstOutputOverdue({ sentAt: 10_000_000 - FIRST_OUTPUT_MS + 1 }, 10_000_000)).toBe(false)
  expect(firstOutputOverdue({ sentAt: 10_000_000 - FIRST_OUTPUT_MS }, 10_000_000)).toBe(true)
})

it('aliveOf reads the recovery flag and the process: exited or killed is dead, no process yet is alive', () => {
  expect(aliveOf(false, null)).toBe(true)
  expect(aliveOf(true, null)).toBe(false)
  expect(aliveOf(false, { exitCode: null, killed: false })).toBe(true)
  expect(aliveOf(false, { exitCode: 0, killed: false })).toBe(false)
  expect(aliveOf(false, { exitCode: null, killed: true })).toBe(false)
  expect(aliveOf(false, { exitCode: null, signalCode: 'SIGKILL', killed: false })).toBe(false)
})

it('the forgotten-task timer asks about a stale task while the thread watches, never while it works or idles', async () => {
  vi.useFakeTimers()
  const state = newStreamState()
  const sent: string[] = []
  state.sendCheck = (text) => sent.push(text)
  state.tasks.set('t1', { description: 'bun test --watch', kind: 'shell' })
  state.since.set('t1', Date.now() - 11 * 60_000)
  state.watching = true
  const stop = startForgottenTimer(ctx, state, 1_000)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('bun test --watch')
  // Asked once; a recheck waits half an hour.
  await vi.advanceTimersByTimeAsync(5_000)
  expect(sent).toHaveLength(1)
  // Working: the check waits for the turn's end.
  state.watching = false
  state.working = true
  state.checked.clear()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sent).toHaveLength(1)
  stop()
  state.working = false
  state.watching = true
  await vi.advanceTimersByTimeAsync(5_000)
  expect(sent).toHaveLength(1)
})
