// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { status, pushListeners, keep, undo, confirm, toastError } = vi.hoisted(() => ({
  status: vi.fn(() => Promise.resolve({ files: [] as unknown[] })),
  pushListeners: [] as ((sessionId: string) => void)[],
  keep: vi.fn(),
  undo: vi.fn(),
  confirm: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('../lib/checkpoint', () => ({
  sessionCheckpointStatus: status,
  keepSessionChanges: keep,
  undoSessionChanges: undo,
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
vi.mock('./ConfirmDialog', () => ({ confirmAction: confirm }))
vi.mock('./toastSync', () => ({ loadToast: () => Promise.resolve({ error: toastError }) }))
vi.mock('../lib/fileIndex', () => ({ invalidateProjectFiles: vi.fn() }))
vi.mock('../lib/fileWatch', () => ({ invalidateWatchedFiles: vi.fn() }))

import { mountProbe } from '../test/renderProbe'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionReview, SessionReviewView, STATUS_DEBOUNCE_MS } from './SessionReview'

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

  it("a burst of git-changed signals in the thread's checkout costs one status call", async () => {
    const { notifyGitChanged } = await vi.importActual<typeof import('../lib/gitChanged')>('../lib/gitChanged')
    status.mockImplementation(() => Promise.resolve({ files: [{ path: '/w/one/a.ts', relative: 'a.ts', status: 'M', additions: 1, deletions: 0 }] }))
    const probe = mountProbe(strip(false))
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) {
      probe.act(() => notifyGitChanged('/w/one'))
      await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS / 4))
    }
    expect(status).toHaveBeenCalledTimes(1)
    await probe.act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    expect(status).toHaveBeenCalledTimes(2)
    status.mockImplementation(() => Promise.resolve({ files: [] }))
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

const file = (relative: string, additions: number, deletions: number) => ({
  path: `/w/one/${relative}`,
  relative,
  status: 'M',
  additions,
  deletions,
})
const view = (files: ReturnType<typeof file>[], over: Partial<Parameters<typeof SessionReviewView>[0]> = {}) => (
  <SessionReviewView
    files={files}
    busy={false}
    acting={null}
    onReview={() => undefined}
    onUndo={() => undefined}
    onKeep={() => undefined}
    {...over}
  />
)
const three = [file('src/a.ts', 30, 9), file('src/b.ts', 12, 0), file('docs/c.md', 4, 3)]

describe('SessionReview strip', () => {
  afterEach(() => {
    cleanup()
    status.mockReset()
    status.mockImplementation(() => Promise.resolve({ files: [] }))
  })

  it('one file shows its name and counts, and opens that file’s diff', async () => {
    vi.useFakeTimers()
    status.mockImplementation(() => Promise.resolve({ files: [file('src/chrome/SessionReview.tsx', 46, 12)] }))
    const onOpenDiff = vi.fn()
    render(<SessionReview sessionId="s1" cwd="/w/one" onOpenDiff={onOpenDiff} />)
    await act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    vi.useRealTimers()
    const summary = screen.getByRole('button', { name: 'Review changes: SessionReview.tsx' })
    expect(summary.textContent).toContain('SessionReview.tsx')
    expect(summary.textContent).toContain('+46')
    expect(summary.textContent).toContain('−12')
    fireEvent.click(summary)
    expect(onOpenDiff).toHaveBeenCalledWith('/w/one/src/chrome/SessionReview.tsx')
  })

  it('several files show a count and summed counts, no names, no list, no Review button', () => {
    const onReview = vi.fn()
    const { container } = render(view(three, { onReview }))
    const summary = screen.getByRole('button', { name: /^Review changes/ })
    expect(summary.getAttribute('aria-label')).toBe('Review changes: 3 files')
    expect(summary.textContent).toContain('3 files')
    expect(summary.textContent).toContain('+46')
    expect(summary.textContent).toContain('−12')
    expect(container.textContent).not.toContain('a.ts')
    expect(container.querySelector('ul, li')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([expect.any(String), 'Undo', 'Keep'])
    fireEvent.click(summary)
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(onReview.mock.calls[0]).toEqual([])
  })

  it('a zero side of the counts is left out', () => {
    render(view([file('src/new.ts', 18, 0)]))
    const summary = screen.getByRole('button', { name: /^Review changes/ })
    expect(summary.textContent).toContain('+18')
    expect(summary.textContent).not.toContain('−')
  })

  it('a working thread disables Undo and Keep and leaves the summary enabled', () => {
    render(view(three, { busy: true }))
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /^Review changes/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('carries no title attributes of its own', () => {
    for (const files of [three, [file('src/a.ts', 1, 1)]]) {
      const { container } = render(view(files))
      // The file icon pack titles its own glyph; it sits in an aria-hidden,
      // pointer-events-none wrapper, so no tooltip ever shows.
      const titled = [...container.querySelectorAll('[title]')].filter((el) => !el.closest('[aria-hidden]'))
      expect(titled).toEqual([])
      cleanup()
    }
  })

  it('renders nothing with no changes', () => {
    const { container } = render(view([]))
    expect(container.innerHTML).toBe('')
  })
})

describe('SessionReview Undo and Keep', () => {
  const files = [file('src/a.ts', 30, 9), file('src/b.ts', 12, 0), file('docs/c.md', 4, 3)]
  const mounted = async (wrap = false) => {
    vi.useFakeTimers()
    status.mockImplementation(() => Promise.resolve({ files }))
    const strip = <SessionReview sessionId="s1" cwd="/w/one" onOpenDiff={() => undefined} />
    const utils = render(
      wrap ? (
        <div data-composer>
          {strip}
          <textarea data-composer-input />
        </div>
      ) : (
        strip
      ),
    )
    await act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    vi.useRealTimers()
    return utils
  }
  afterEach(() => {
    cleanup()
    for (const fn of [keep, undo, confirm, toastError]) fn.mockReset()
    status.mockReset()
    status.mockImplementation(() => Promise.resolve({ files: [] }))
  })

  it('Undo asks first, and a no calls nothing', async () => {
    await mounted()
    confirm.mockResolvedValue(false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Undo' })))
    expect(confirm).toHaveBeenCalledWith({
      title: 'Undo 3 files?',
      body: 'They go back to before this thread changed them.',
      action: 'Undo',
      danger: true,
    })
    expect(undo).not.toHaveBeenCalled()
  })

  it('a yes undoes the thread’s changes, naming the thread only', async () => {
    await mounted()
    confirm.mockResolvedValue(true)
    undo.mockResolvedValue({ files: [] })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Undo' })))
    expect(undo).toHaveBeenCalledTimes(1)
    expect(undo.mock.calls[0]).toEqual(['local', 's1'])
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('one file names it in the question', async () => {
    vi.useFakeTimers()
    status.mockImplementation(() => Promise.resolve({ files: [file('src/chrome/SessionReview.tsx', 1, 1)] }))
    render(<SessionReview sessionId="s1" cwd="/w/one" onOpenDiff={() => undefined} />)
    await act(() => vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS))
    vi.useRealTimers()
    confirm.mockResolvedValue(false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Undo' })))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Undo SessionReview.tsx?', body: 'It goes back to before this thread changed it.' }),
    )
  })

  it('Keep keeps at once, with no question', async () => {
    await mounted()
    keep.mockResolvedValue({ files: [] })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Keep' })))
    expect(confirm).not.toHaveBeenCalled()
    expect(keep.mock.calls).toEqual([['local', 's1']])
  })

  it('while one runs both are disabled and the pressed one is busy', async () => {
    await mounted()
    let settle: (v: unknown) => void = () => undefined
    keep.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Keep' })))
    const keepButton = screen.getByRole('button', { name: 'Keep' }) as HTMLButtonElement
    const undoButton = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement
    expect(keepButton.disabled).toBe(true)
    expect(undoButton.disabled).toBe(true)
    expect(keepButton.getAttribute('aria-busy')).toBe('true')
    expect(undoButton.getAttribute('aria-busy')).toBeNull()
    await act(async () => settle({ files }))
    expect((screen.getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('a failed undo says so and reads the status again', async () => {
    await mounted()
    confirm.mockResolvedValue(true)
    undo.mockRejectedValue(new Error('git refused'))
    const before = status.mock.calls.length
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Undo' })))
    await act(async () => undefined)
    expect(toastError).toHaveBeenCalledWith('Undo failed', { description: 'git refused' })
    expect(status.mock.calls.length).toBe(before + 1)
  })

  it('a keyboard Keep that empties the strip leaves focus in the composer', async () => {
    const { container } = await mounted(true)
    keep.mockResolvedValue({ files: [] })
    const keepButton = screen.getByRole('button', { name: 'Keep' })
    keepButton.focus()
    expect(document.activeElement).toBe(keepButton)
    await act(async () => fireEvent.click(keepButton))
    expect(document.activeElement).toBe(container.querySelector('[data-composer-input]'))
  })
})
