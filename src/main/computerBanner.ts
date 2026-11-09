import { BrowserWindow, screen, nativeTheme, type BrowserWindowConstructorOptions } from 'electron'
import type { ComputerBannerHooks } from './server/computer/hold'
import { BANNER_TOKENS, computerBannerPage } from './computerBannerPage'

export function bannerWindowOptions(): BrowserWindowConstructorOptions {
  return {
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
    width: 400,
    height: 32,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  }
}
interface BannerWindow {
  loadURL(url: string): Promise<unknown>
  webContents: { executeJavaScript(code: string): Promise<unknown> }
  setAlwaysOnTop(on: boolean, level: 'screen-saver'): void
  setVisibleOnAllWorkspaces(on: boolean, options: { visibleOnFullScreen: boolean }): void
  setIgnoreMouseEvents(on: boolean): void
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  showInactive(): void
  hide(): void
  isDestroyed(): boolean
}
export interface ComputerBannerDeps {
  BrowserWindow?: new (opts: BrowserWindowConstructorOptions) => BannerWindow
  screen?: Pick<typeof screen, 'getDisplayNearestPoint' | 'getCursorScreenPoint'>
  nativeTheme?: {
    shouldUseDarkColors: boolean
    on(event: 'updated', listener: () => void): unknown
  }
}
export function createComputerBanner(deps: ComputerBannerDeps = {}): ComputerBannerHooks {
  const Window = deps.BrowserWindow ?? BrowserWindow
  const displays = deps.screen ?? screen
  const theme = deps.nativeTheme ?? nativeTheme
  let window: BannerWindow | null = null
  let loaded: Promise<unknown> = Promise.resolve()
  let visible = false
  let desired = false
  let esc = false
  let version = 0
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let workArea: Electron.Rectangle | null = null
  const update = async (): Promise<void> => {
    const own = ++version
    const win = window
    await loaded
    if (!win || win.isDestroyed() || !desired || own !== version) return
    const width = await win.webContents.executeJavaScript(
      `(() => { const h = document.documentElement; h.classList.toggle('theme-light', ${!theme.shouldUseDarkColors}); h.classList.toggle('esc', ${esc}); h.classList.remove('hidden'); return Math.ceil(document.getElementById('pill').getBoundingClientRect().width); })()`
    )
    if (win.isDestroyed() || !desired || own !== version) return
    if (workArea) {
      const size = typeof width === 'number' && width > 0 ? Math.min(width, workArea.width) : 400
      win.setBounds({
        x: Math.round(workArea.x + (workArea.width - size) / 2),
        y: workArea.y + 8,
        width: size,
        height: 32
      })
    }
    if (!visible) {
      win.showInactive()
      visible = true
    }
  }
  theme.on('updated', () => {
    if (desired) void update().catch(() => undefined)
  })
  return {
    show(opts) {
      const first = !desired
      desired = true
      esc = opts.esc
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = null
      if (first)
        workArea = displays.getDisplayNearestPoint(displays.getCursorScreenPoint()).workArea
      if (!window || window.isDestroyed()) {
        visible = false
        window = new Window(bannerWindowOptions())
        window.setAlwaysOnTop(true, 'screen-saver')
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        window.setIgnoreMouseEvents(true)
        loaded = window.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(computerBannerPage())}`
        )
      }
      void update().catch(() => undefined)
    },
    hide() {
      if (!desired) return
      desired = false
      const own = ++version
      const win = window
      if (!win || win.isDestroyed()) return
      void loaded
        .then(async () => {
          if (desired || win.isDestroyed() || own !== version) return
          await win.webContents.executeJavaScript(
            "document.documentElement.classList.add('hidden')"
          )
          if (desired || win.isDestroyed() || own !== version) return
          hideTimer = setTimeout(() => {
            hideTimer = null
            if (!desired && !win.isDestroyed()) {
              win.hide()
              visible = false
            }
          }, parseInt(BANNER_TOKENS.shared['dur-fast']))
        })
        .catch(() => undefined)
    }
  }
}
