import { describe, expect, it } from 'vitest'
import { CRASH_WINDOW_MS, StderrTail, erroredEntryHolds, expiredBuildMessage } from './lspHealth'

describe('expiredBuildMessage', () => {
  it('reads the engine expiry line out of its stderr', () => {
    const stderr = 'WARN: something\nThis build of intellij-server has expired (2026-09-01). Please download a newer one.\n'
    expect(expiredBuildMessage(stderr)).toBe(
      'This build of intellij-server has expired (2026-09-01). Please download a newer one.'
    )
  })

  it('is null for ordinary chatter', () => {
    expect(expiredBuildMessage('Starting server\nindexing 12%\n')).toBeNull()
    expect(expiredBuildMessage('')).toBeNull()
  })
})

describe('StderrTail', () => {
  it('keeps the end of a long stream so the exit message survives', () => {
    const tail = new StderrTail()
    tail.push('x'.repeat(20_000))
    tail.push(Buffer.from('\nThis build of intellij-server has expired\n'))
    expect(tail.read().length).toBeLessThanOrEqual(8 * 1024)
    expect(expiredBuildMessage(tail.read())).toBe('This build of intellij-server has expired')
  })
})

describe('erroredEntryHolds', () => {
  it('holds inside the crash window and lets go after it', () => {
    expect(erroredEntryHolds(undefined, 1_000)).toBe(false)
    expect(erroredEntryHolds(1_000, 1_000 + CRASH_WINDOW_MS - 1)).toBe(true)
    expect(erroredEntryHolds(1_000, 1_000 + CRASH_WINDOW_MS)).toBe(false)
  })
})
