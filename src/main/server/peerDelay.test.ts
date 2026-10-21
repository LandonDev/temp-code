import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { peerDelay, peerDelayMs } from './peerDelay'

describe('TEMP_CODE_PEER_DELAY_MS', () => {
  it('reads a positive integer and nothing else', () => {
    expect(peerDelayMs({})).toBe(0)
    expect(peerDelayMs({ TEMP_CODE_PEER_DELAY_MS: '' })).toBe(0)
    expect(peerDelayMs({ TEMP_CODE_PEER_DELAY_MS: 'soon' })).toBe(0)
    expect(peerDelayMs({ TEMP_CODE_PEER_DELAY_MS: '-5' })).toBe(0)
    expect(peerDelayMs({ TEMP_CODE_PEER_DELAY_MS: '2500.7' })).toBe(2500)
  })

  describe('peerDelay', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('holds a remote principal for the delay and never a local one', async () => {
      let remoteDone = false
      let localDone = false
      void peerDelay('remote', 1_000).then(() => {
        remoteDone = true
      })
      void peerDelay('local', 1_000).then(() => {
        localDone = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(localDone).toBe(true)
      expect(remoteDone).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(remoteDone).toBe(true)
    })

    it('a zero delay resolves at once for everyone', async () => {
      let done = false
      void peerDelay('remote', 0).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(true)
    })
  })
})
