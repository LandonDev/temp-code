// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { status, pushListeners } = vi.hoisted(() => ({
  status: vi.fn(() => Promise.resolve({ files: [] })),
  pushListeners: [] as ((sessionId: string) => void)[],
}))

vi.mock('../lib/checkpoint', () => ({
  sessionCheckpointStatus: status,
  keepSessionChanges: vi.fn(),
  undoSessionChanges: vi.fn(),
  // The host's `checkpoint-changed` push, as lib/checkpoint hands it on.
  subscribeCheckpointChanged: (l: (sessionId: string) => void) => {
    pushListeners.push(l)
    return () => pushListeners.splice(pushListeners.indexOf(l), 1)
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

vi.mock('../lib/tcserver/store', () => ({ sessionStore: { environmentOf: (id: string) => id === 's1' ? 'local' : undefined } }))

const strip = (busy: boolean, cwd = '/w/one') => (
  <SessionReview sessionId="s1" cwd={cwd} busy={busy} onOpenDiff={() => undefined} />
)
const pushed = (sessionId: string) => {
  for (const l of pushListeners) l(sessionId)
}

describe('SessionReview status fetches', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    status.mockClear()
    pushListeners.length = 0
  })

  it('a burst of settles and checkpoint-changed pushes costs one status call', async () => {
    const probe = mountProbe(strip(false))
    expect(status).not.toHaveBeenCalled()
    // Three settles (busy flaps), each followed by the host's push, inside the window.
    for (let i = 0; i < 3; i++) {
      probe.act(() => probe.rerender(strip(true)))
      probe.act(() => probe.rerender(strip(false)))
      probe.act(() => pushed('s1'))
      await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS / 4))
    }
    expect(status).not.toHaveBeenCalled()
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith('local', 's1')
    probe.unmount()
  })

  it('a push for this thread reads the status again; one for another does not', async () => {
    const probe = mountProbe(strip(false))
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(1)
    probe.act(() => pushed('other'))
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(1)
    probe.act(() => pushed('s1'))
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(2)
    probe.unmount()
  })

  it('a busy strip ignores pushes until the turn ends', async () => {
    const probe = mountProbe(strip(true))
    probe.act(() => pushed('s1'))
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).not.toHaveBeenCalled()
    expect(pushListeners).toHaveLength(0)
    probe.unmount()
  })

  it('a new work cwd (branch or worktree left) reads the status again', async () => {
    const probe = mountProbe(strip(false))
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(1)
    probe.act(() => probe.rerender(strip(false, '/w/two')))
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(2)
    probe.unmount()
  })
})
