import { afterEach, expect, it, vi } from 'vitest'
import { waitForBridgeProofCall } from './computerBridgeProof'

afterEach(() => vi.useRealTimers())

it('keeps waiting through a load hold longer than the harness grace, then returns the real answer', async () => {
  vi.useFakeTimers()
  let finish!: (value: string) => void
  const log = vi.fn()
  const waiting = waitForBridgeProofCall(new Promise<string>((resolve) => { finish = resolve }), {
    standing: async () => 'load 38.3 of 32, 1st in line', log
  })
  let ended = false
  void waiting.then(() => { ended = true })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(ended).toBe(false)
  expect(log).toHaveBeenCalledExactlyOnceWith('waiting for the Mac: load 38.3 of 32, 1st in line')
  finish('window "TC Probe"')
  await expect(waiting).resolves.toBe('window "TC Probe"')
  expect(vi.getTimerCount()).toBe(0)
})

it('fails within the bound with the last standing, so finally can end the held call', async () => {
  vi.useFakeTimers()
  const waiting = waitForBridgeProofCall(new Promise(() => {}), {
    standing: async () => 'computer cap, 1st in line', log: vi.fn(), timeoutMs: 3_000
  })
  const failed = expect(waiting).rejects.toThrow('within 3 s: computer cap, 1st in line')
  await vi.advanceTimersByTimeAsync(3_000)
  await failed
  expect(vi.getTimerCount()).toBe(0)
})

it('returns a refusal as is and drops its timers', async () => {
  vi.useFakeTimers()
  await expect(waitForBridgeProofCall(Promise.reject(new Error('offline')), {
    standing: vi.fn(), log: vi.fn()
  })).rejects.toThrow('offline')
  expect(vi.getTimerCount()).toBe(0)
})
