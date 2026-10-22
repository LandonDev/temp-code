import { describe, expect, it } from 'vitest'
import { CHECK_EVERY_MS, decideFetch, updatePhaseLine } from './updateTrigger'

describe('decideFetch', () => {
  it('ignores a version no newer than the one running, or one that is not a version', () => {
    expect(decideFetch('1.0.283', '1.0.283', { phase: 'idle', latest: null })).toBe('current')
    expect(decideFetch('1.0.282', '1.0.283', { phase: 'idle', latest: null })).toBe('current')
    expect(decideFetch('1.0.9', '1.0.10', { phase: 'idle', latest: null })).toBe('current')
    expect(decideFetch('v1.0.284', '1.0.283', { phase: 'idle', latest: null })).toBe('current')
    expect(decideFetch('', '1.0.283', { phase: 'idle', latest: null })).toBe('current')
  })

  it('fetches a newer version unless it is already downloaded or downloading', () => {
    expect(decideFetch('1.0.284', '1.0.283', { phase: 'idle', latest: null })).toBe('fetch')
    expect(decideFetch('1.0.284', '1.0.283', { phase: 'idle', latest: '1.0.284' })).toBe('fetch')
    expect(decideFetch('1.0.284', '1.0.283', { phase: 'error', latest: '1.0.284' })).toBe('fetch')
    expect(decideFetch('1.0.284', '1.0.283', { phase: 'checking', latest: null })).toBe('fetch')
    expect(decideFetch('1.0.284', '1.0.283', { phase: 'downloading', latest: '1.0.284' })).toBe('already')
    expect(decideFetch('1.0.284', '1.0.283', { phase: 'ready', latest: '1.0.284' })).toBe('already')
    expect(decideFetch('1.0.284', '1.0.283', { phase: 'ready', latest: '1.0.285' })).toBe('already')
    // A download of an older release waiting for its restart: the newer one is fetched over it.
    expect(decideFetch('1.0.285', '1.0.283', { phase: 'ready', latest: '1.0.284' })).toBe('fetch')
  })

  it('polls every five minutes', () => {
    expect(CHECK_EVERY_MS).toBe(300_000)
  })
})

describe('updatePhaseLine', () => {
  const fmt = (ms: number): string => `${Math.round(ms / 1000)}s`
  it('spells the outcome the way the script spells its phases', () => {
    expect(updatePhaseLine('ready', 31_000, fmt)).toBe('phase ✓ update 31s')
    expect(updatePhaseLine('current', 0, fmt)).toBe('phase – update skipped (current)')
    expect(updatePhaseLine('unavailable', 0, fmt)).toBe('phase – update skipped (unavailable)')
    expect(updatePhaseLine('error', 5_000, fmt)).toBe('phase ✗ update 5s error')
    expect(updatePhaseLine('timeout', 240_000, fmt)).toBe('phase ✗ update 240s timeout')
  })
})
