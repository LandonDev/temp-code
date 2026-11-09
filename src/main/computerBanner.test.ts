import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {}, nativeTheme: {} }))
import { bannerWindowOptions, createComputerBanner } from './computerBanner'

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())
function setup(ready = Promise.resolve()) {
  const calls: { name: string; args: unknown[] }[] = []
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args })
  }
  let updated = () => {}
  class Window {
    constructor(opts: unknown) {
      record('construct', opts)
    }
    loadURL = vi.fn((url: string) => {
      record('load', url)
      return ready
    })
    webContents = {
      executeJavaScript: vi.fn(async (code: string) => {
        record('script', code)
        return code.includes("'esc', true") ? 320 : 240
      })
    }
    setAlwaysOnTop = (...args: unknown[]) => record('top', ...args)
    setVisibleOnAllWorkspaces = (...args: unknown[]) => record('spaces', ...args)
    setIgnoreMouseEvents = (...args: unknown[]) => record('ignore', ...args)
    setBounds = (...args: unknown[]) => record('bounds', ...args)
    showInactive = () => record('inactive')
    show = () => record('show')
    focus = () => record('focus')
    hide = () => record('hide')
    isDestroyed = () => false
  }
  const nativeTheme = {
    shouldUseDarkColors: true,
    on: vi.fn((_event: string, fn: () => void) => {
      updated = fn
      return nativeTheme
    })
  }
  const screen = {
    getCursorScreenPoint: vi.fn(() => ({ x: 2000, y: 20 })),
    getDisplayNearestPoint: vi.fn(
      () => ({ workArea: { x: 1600, y: 25, width: 1200, height: 900 } }) as Electron.Display
    )
  }
  const banner = createComputerBanner({ BrowserWindow: Window, screen, nativeTheme })
  return { banner, calls, screen, nativeTheme, update: () => updated() }
}
describe('computer banner window', () => {
  it('starts hidden, non-focusing, transparent and locked in place', () => {
    expect(bannerWindowOptions()).toMatchObject({
      show: false,
      type: 'panel',
      frame: false,
      transparent: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      fullscreenable: false,
      height: 32,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
  })
  it('loads the page and ignores clicks before showing inactive on the pointer’s display', async () => {
    let load!: () => void
    const s = setup(
      new Promise<void>((r) => {
        load = r
      })
    )
    expect(s.calls).toEqual([])
    s.banner.show({ esc: false })
    await flush()
    expect(s.calls.map((c) => c.name)).toEqual(['construct', 'top', 'spaces', 'ignore', 'load'])
    expect(s.calls.find((c) => c.name === 'top')?.args).toEqual([true, 'screen-saver'])
    expect(s.calls.find((c) => c.name === 'spaces')?.args).toEqual([
      true,
      { visibleOnFullScreen: true }
    ])
    expect(s.calls.find((c) => c.name === 'ignore')?.args).toEqual([true])
    load()
    await flush()
    expect(s.screen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: 2000, y: 20 })
    expect(s.calls.slice(-2)).toEqual([
      { name: 'bounds', args: [{ x: 2080, y: 33, width: 240, height: 32 }] },
      { name: 'inactive', args: [] }
    ])
    expect(s.calls.some((c) => ['show', 'focus'].includes(c.name))).toBe(false)
  })
  it('updates Esc and theme, keeps one window and fades before hiding', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.banner.show({ esc: false })
    await flush()
    s.banner.show({ esc: true })
    await flush()
    expect(s.calls.filter((c) => c.name === 'script').at(-1)?.args[0]).toContain("'esc', true")
    expect(s.calls.filter((c) => c.name === 'bounds').at(-1)?.args[0]).toMatchObject({
      width: 320,
      x: 2040
    })
    s.nativeTheme.shouldUseDarkColors = false
    s.update()
    await flush()
    expect(s.calls.filter((c) => c.name === 'script').at(-1)?.args[0]).toContain(
      "'theme-light', true"
    )
    s.banner.hide()
    await flush()
    expect(s.calls.some((c) => c.name === 'hide')).toBe(false)
    await vi.advanceTimersByTimeAsync(119)
    expect(s.calls.some((c) => c.name === 'hide')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.calls.at(-1)?.name).toBe('hide')
    s.banner.show({ esc: false })
    await flush()
    expect(s.calls.filter((c) => c.name === 'construct')).toHaveLength(1)
    expect(s.calls.filter((c) => c.name === 'inactive')).toHaveLength(2)
    expect(s.calls.some((c) => ['show', 'focus'].includes(c.name))).toBe(false)
  })
  it('does not show after a hide during page load and cancels an interrupted fade', async () => {
    vi.useFakeTimers()
    let load!: () => void
    const s = setup(
      new Promise<void>((r) => {
        load = r
      })
    )
    s.banner.show({ esc: true })
    s.banner.hide()
    load()
    await flush()
    await vi.advanceTimersByTimeAsync(120)
    expect(s.calls.some((c) => c.name === 'inactive')).toBe(false)
    s.banner.show({ esc: true })
    await flush()
    s.banner.hide()
    await flush()
    s.banner.show({ esc: false })
    await flush()
    await vi.advanceTimersByTimeAsync(120)
    expect(s.calls.filter((c) => c.name === 'hide')).toHaveLength(1)
  })
})
