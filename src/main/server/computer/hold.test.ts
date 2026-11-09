import { afterEach, describe, expect, it, vi } from 'vitest'
import { ESCAPE_WATCH, type ComputerNotification } from '@shared/computer/protocol'
import { ComputerRpcError } from './connection'
import { SessionHolds, HOLD_LINGER_MS, handleComputerProofHold } from './hold'
import { computerHarness } from './runHarness'
import type { ComputerService } from './service'
import type { ComputerSessions } from './sessions'
import { ManualClock, settle } from './testFake'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
function setup() {
  const clock = new ManualClock(),
    show = vi.fn(),
    hide = vi.fn(),
    stop = vi.fn(async () => true),
    log = vi.fn()
  let receive: (n: ComputerNotification) => void = () => {}
  let epoch: (e: string) => void = () => {}
  const request = vi.fn(async (_method: string, _params: unknown) => ({}))
  const service = {
    request,
    onNotification: (fn: typeof receive) => {
      receive = fn
      return vi.fn()
    },
    onEpoch: (fn: typeof epoch) => {
      epoch = fn
      return vi.fn()
    }
  } as unknown as ComputerService
  const holds = new SessionHolds({
    service,
    sessions: { stop } as unknown as ComputerSessions,
    banner: () => ({ show, hide }),
    clock,
    log
  })
  cleanups.push(() => holds.close())
  return {
    clock,
    show,
    hide,
    stop,
    request,
    holds,
    log,
    receive: (n: ComputerNotification) => receive(n),
    epoch: () => epoch('new')
  }
}

describe('SessionHolds', () => {
  it('shows Esc only after the watch answers and renews the lease while held', async () => {
    const s = setup()
    let answer!: (value: {}) => void
    s.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answer = r
        })
    )
    s.holds.holder('t1')
    expect(s.show.mock.calls).toEqual([[{ esc: false }]])
    expect(s.request).toHaveBeenCalledWith('escape.watch', {
      on: true,
      leaseMs: ESCAPE_WATCH.leaseMs
    })
    answer({})
    await settle()
    expect(s.show).toHaveBeenLastCalledWith({ esc: true })
    expect(s.holds.current()).toEqual({ thread: 't1', since: s.clock.now() })
    await s.clock.advance(ESCAPE_WATCH.renewMs * 3)
    expect(s.request).toHaveBeenCalledTimes(4)
    expect(s.hide).not.toHaveBeenCalled()
  })
  it('lingers on release and a new holder keeps the hold and its age', async () => {
    const s = setup()
    s.holds.holder('t1')
    await settle()
    const since = s.holds.current()!.since
    s.holds.holder(null)
    await s.clock.advance(HOLD_LINGER_MS - 1)
    expect(s.hide).not.toHaveBeenCalled()
    s.holds.holder('t2')
    await s.clock.advance(HOLD_LINGER_MS)
    expect(s.holds.current()).toEqual({ thread: 't2', since })
    expect(s.request).toHaveBeenCalledTimes(1)
    s.holds.holder(null)
    await s.clock.advance(HOLD_LINGER_MS)
    expect(s.holds.current()).toBeNull()
    expect(s.hide).toHaveBeenCalledTimes(1)
    expect(s.request).toHaveBeenLastCalledWith('escape.watch', { on: false })
  })
  it('stops the current thread and hides at once when Escape arrives', async () => {
    const s = setup()
    s.holds.holder('t1')
    await settle()
    s.holds.holder('t2')
    s.holds.holder(null)
    s.receive({ method: 'escape/pressed', params: { at: s.clock.now() } })
    expect(s.stop).toHaveBeenCalledWith('t2')
    expect(s.hide).toHaveBeenCalledTimes(1)
    expect(s.holds.current()).toBeNull()
    await s.clock.advance(ESCAPE_WATCH.renewMs * 2)
    expect(s.request).toHaveBeenCalledTimes(2)
    s.receive({ method: 'escape/pressed', params: { at: s.clock.now() } })
    expect(s.stop).toHaveBeenCalledTimes(1)
  })
  it('takes Escape while the watch answer is still in flight', async () => {
    const s = setup()
    let answer!: (value: {}) => void
    s.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answer = r
        })
    )
    s.holds.holder('t1')
    s.receive({ method: 'escape/pressed', params: { at: s.clock.now() } })
    expect(s.stop).toHaveBeenCalledWith('t1')
    expect(s.hide).toHaveBeenCalledOnce()
    answer({})
    await settle()
    expect(s.show).not.toHaveBeenCalledWith({ esc: true })
  })
  it('logs method-not-found once, never promises Esc, and tries again in a new epoch', async () => {
    const s = setup()
    s.request.mockRejectedValue(new ComputerRpcError(-32601, 'unknown method'))
    s.holds.holder('t1')
    await settle()
    expect(s.show).toHaveBeenLastCalledWith({ esc: false })
    expect(s.log).toHaveBeenCalledTimes(1)
    await s.clock.advance(ESCAPE_WATCH.renewMs * 2)
    expect(s.request).toHaveBeenCalledTimes(1)
    s.holds.holder(null)
    await s.clock.advance(HOLD_LINGER_MS)
    s.holds.holder('t2')
    await settle()
    expect(s.log).toHaveBeenCalledTimes(1)
    s.request.mockResolvedValue({})
    s.epoch()
    await settle()
    expect(s.show).toHaveBeenLastCalledWith({ esc: true })
  })
  it('drops a late watch reply after release or close', async () => {
    const s = setup()
    let answer!: (value: {}) => void
    s.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answer = r
        })
    )
    s.holds.holder('t1')
    s.holds.holder(null)
    await s.clock.advance(HOLD_LINGER_MS)
    answer({})
    await settle()
    expect(s.show).not.toHaveBeenCalledWith({ esc: true })
    s.holds.close()
    s.holds.holder('t1')
    expect(s.holds.current()).toBeNull()
  })
  it('retries a failed lease and removes Esc until the watch works', async () => {
    const s = setup()
    s.holds.holder('t1')
    await settle()
    s.request.mockRejectedValueOnce(new Error('service crashed'))
    await s.clock.advance(ESCAPE_WATCH.renewMs)
    expect(s.show).toHaveBeenLastCalledWith({ esc: false })
    await s.clock.advance(ESCAPE_WATCH.renewMs)
    expect(s.show).toHaveBeenLastCalledWith({ esc: true })
  })
  it('gates the proof request and holds for no thread', async () => {
    const s = setup()
    const req = { id: 'p', method: 'computer.proofHold', params: { on: true } } as const
    expect(() => handleComputerProofHold(req, s.holds, {})).toThrow(
      'only available in a proof instance'
    )
    expect(s.holds.current()).toBeNull()
    expect(() => handleComputerProofHold(req, null, { TEMP_CODE_E2E_STATUS: '1' })).toThrow(
      'not available here'
    )
    expect(handleComputerProofHold(req, s.holds, { TEMP_CODE_E2E_STATUS: '1' })).toEqual({
      handled: true,
      result: null
    })
    await settle()
    expect(s.holds.current()?.thread).toBeNull()
    s.receive({ method: 'escape/pressed', params: { at: s.clock.now() } })
    expect(s.stop).not.toHaveBeenCalled()
    expect(s.hide).toHaveBeenCalledOnce()
    handleComputerProofHold(req, s.holds, { TEMP_CODE_E2E_STATUS: '1' })
    await settle()
    handleComputerProofHold({ ...req, params: { on: false } }, s.holds, {
      TEMP_CODE_E2E_STATUS: '1'
    })
    await s.clock.advance(HOLD_LINGER_MS)
    expect(s.holds.current()).toBeNull()
  })
  it('watches and takes Escape through the real fake service without a duplicate first lease', async () => {
    const h = computerHarness({ env: { FAKE_ESCAPE_PRESS_MS: '40' } })
    cleanups.push(() => h.close())
    const clock = new ManualClock(),
      show = vi.fn(),
      hide = vi.fn()
    const stop = vi.spyOn(h.sessions, 'stop')
    const holds = new SessionHolds({
      service: h.service,
      sessions: h.sessions,
      banner: () => ({ show, hide }),
      clock
    })
    cleanups.push(() => holds.close())
    holds.holder('t1')
    await vi.waitFor(() => expect(hide).toHaveBeenCalledOnce())
    expect(stop).toHaveBeenCalledWith('t1')
    expect(show).toHaveBeenCalledWith({ esc: true })
    expect(h.requests().filter((r) => r.method === 'escape.watch' && r.params.on)).toHaveLength(1)
  })
})
