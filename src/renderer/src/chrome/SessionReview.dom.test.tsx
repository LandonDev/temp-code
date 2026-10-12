// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { status, reviewListeners } = vi.hoisted(() => ({
  status: vi.fn(() => Promise.resolve({ files: [] })),
  reviewListeners: [] as ((id?: string) => void)[],
}))

vi.mock('../lib/checkpoint', () => ({
  sessionCheckpointStatus: status,
  keepSessionChanges: vi.fn(),
  undoSessionChanges: vi.fn(),
  subscribeReviewChanged: (l: (id?: string) => void) => {
    reviewListeners.push(l)
    return () => reviewListeners.splice(reviewListeners.indexOf(l), 1)
  },
}))
vi.mock('../lib/fs', async () => {
  const real = await vi.importActual<typeof import('../lib/gitChanged')>('../lib/gitChanged')
  return { basename: (p: string) => p.split('/').pop() ?? p, ...real }
})
vi.mock('../lib/fileIndex', () => ({ invalidateProjectFiles: vi.fn() }))
vi.mock('../lib/fileWatch', () => ({ invalidateWatchedFiles: vi.fn() }))

import { mountProbe } from '../test/renderProbe'
import { SessionReview, STATUS_DEBOUNCE_MS } from './SessionReview'

const strip = (busy: boolean) => (
  <SessionReview sessionId="s1" cwd="/w/one" busy={busy} onOpenDiff={() => undefined} />
)

describe('SessionReview status fetches', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    status.mockClear()
    reviewListeners.length = 0
  })

  it('a burst of settles and review nudges costs one status call', async () => {
    const probe = mountProbe(strip(false))
    expect(status).not.toHaveBeenCalled()
    // Three settles (busy flaps) and three review nudges inside the window.
    for (let i = 0; i < 3; i++) {
      probe.act(() => probe.rerender(strip(true)))
      probe.act(() => probe.rerender(strip(false)))
      probe.act(() => {
        for (const l of reviewListeners) l('s1')
      })
      await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS / 4))
    }
    expect(status).not.toHaveBeenCalled()
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(1)
    probe.unmount()
  })

  it('a nudge for another session does not fetch', async () => {
    const probe = mountProbe(strip(false))
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(1)
    probe.act(() => {
      for (const l of reviewListeners) l('other')
    })
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(1)
    probe.unmount()
  })
})
