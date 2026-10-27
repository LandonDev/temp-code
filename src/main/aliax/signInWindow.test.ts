import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { FakeWindow, made } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events')
  const made: InstanceType<typeof FakeWindow>[] = []
  class FakeWindow extends EventEmitter {
    options: Record<string, unknown>
    shown = false
    destroyed = false
    webContents = new EventEmitter()
    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      made.push(this)
    }
    show(): void {
      this.shown = true
    }
    destroy(): void {
      this.destroyed = true
      this.emit('closed')
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
  }
  return { FakeWindow, made }
})
type FakeWindow = InstanceType<typeof FakeWindow>

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(FakeWindow, { getFocusedWindow: () => null }),
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
  }
}))

import { failureLine, FIRST_PAINT_TIMEOUT_MS, NO_ANSWER, openSignInWindow, placeOver, UNREACHABLE } from './signInWindow'

/** Settles to the line, or 'pending' when nothing has settled yet. */
async function state(failed: Promise<string>): Promise<string> {
  return Promise.race([failed, new Promise<string>((r) => setTimeout(() => r('pending'), 0))])
}

describe('openSignInWindow', () => {
  beforeEach(() => {
    made.length = 0
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => vi.useRealTimers())

  const fail = (win: FakeWindow, code: number, isMainFrame: boolean): void => {
    win.webContents.emit('did-fail-load', {}, code, 'ERR', 'https://claude.ai/oauth/authorize', isMainFrame)
  }

  it('opens hidden and shows on its first paint, not before', () => {
    const { win } = openSignInWindow({ partition: 'p' })
    const fake = win as unknown as FakeWindow
    expect(fake.options.show).toBe(false)
    expect(fake.options.title).toBe('Sign in to Claude')
    expect(fake.shown).toBe(false)
    fake.emit('ready-to-show')
    expect(fake.shown).toBe(true)
  })

  it('turns a main-frame failure into the line', async () => {
    const { win, failed } = openSignInWindow({ partition: 'p' })
    fail(win as unknown as FakeWindow, -105, true)
    vi.useRealTimers()
    expect(await state(failed)).toBe(UNREACHABLE)
  })

  it('keeps waiting through a redirect hop and a subframe failure', async () => {
    const { win, failed } = openSignInWindow({ partition: 'p' })
    const fake = win as unknown as FakeWindow
    fail(fake, -3, true)
    fail(fake, -105, false)
    fake.emit('ready-to-show')
    vi.useRealTimers()
    expect(await state(failed)).toBe('pending')
  })

  it("says claude.ai didn't answer with no paint in 30 s", async () => {
    const { failed } = openSignInWindow({ partition: 'p' })
    vi.advanceTimersByTime(FIRST_PAINT_TIMEOUT_MS)
    vi.useRealTimers()
    expect(await state(failed)).toBe(NO_ANSWER)
  })

  it('stops counting at the first paint', async () => {
    const { win, failed } = openSignInWindow({ partition: 'p' })
    ;(win as unknown as FakeWindow).emit('ready-to-show')
    vi.advanceTimersByTime(FIRST_PAINT_TIMEOUT_MS * 2)
    vi.useRealTimers()
    expect(await state(failed)).toBe('pending')
  })
})

describe('failureLine', () => {
  it('ignores ERR_ABORTED and words every other code the same', () => {
    expect(failureLine(-3)).toBeNull()
    expect(failureLine(-105)).toBe(UNREACHABLE)
    expect(failureLine(-102)).toBe(UNREACHABLE)
  })
})

describe('placeOver', () => {
  const work = { x: 0, y: 25, width: 1440, height: 875 }
  it('centres on the parent', () => {
    expect(placeOver({ x: 200, y: 100, width: 1000, height: 800 }, { width: 520, height: 760 }, work)).toEqual({ x: 440, y: 120 })
  })
  it('clamps to the work area', () => {
    expect(placeOver({ x: 1200, y: 600, width: 600, height: 400 }, { width: 520, height: 760 }, work)).toEqual({ x: 920, y: 140 })
    expect(placeOver({ x: -500, y: 0, width: 300, height: 200 }, { width: 520, height: 760 }, work)).toEqual({ x: 0, y: 25 })
  })
  it('centres on the work area with no parent', () => {
    expect(placeOver(null, { width: 520, height: 760 }, work)).toEqual({ x: 460, y: 83 })
  })
})
