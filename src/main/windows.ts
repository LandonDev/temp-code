import { app, BrowserWindow, ipcMain, Menu, shell, type IpcMainEvent } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { killPtysForOwner } from './pty'

/** Donor chrome: inset traffic lights and a floor the layout still fits in. */
const TRAFFIC_LIGHT = { x: 12, y: 13 }
const MIN_WIDTH = 800
const MIN_HEIGHT = 520

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800, maximized: false }

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadState(): WindowState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>
    return {
      x: typeof raw.x === 'number' ? raw.x : undefined,
      y: typeof raw.y === 'number' ? raw.y : undefined,
      width: Math.max(MIN_WIDTH, Number(raw.width) || DEFAULT_STATE.width),
      height: Math.max(MIN_HEIGHT, Number(raw.height) || DEFAULT_STATE.height),
      maximized: raw.maximized === true
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

let saveTimer: NodeJS.Timeout | null = null
function saveStateSoon(win: BrowserWindow): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (win.isDestroyed()) return
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = { ...bounds, maximized: win.isMaximized() }
    try {
      writeFileSync(statePath(), JSON.stringify(state))
    } catch {
      // a missing userData dir is not worth crashing over
    }
  }, 400)
  saveTimer.unref()
}

/** Windows whose renderer asked to handle its own close. The old renderer
 *  never subscribes, so its window still closes the normal way. */
const closeSubscribers = new Set<number>()
/** Set for the one close that `window:destroy` performs itself. */
const destroying = new Set<number>()
/** Unread counts per window; the dock shows their sum. */
const badges = new Map<number, number>()
let lastBadgeTotal = 0

/** One staged payload, handed to exactly one destination window. */
let transfer: { payload: unknown; forWebContents: number | null } | null = null

function windowOf(event: { sender: Electron.WebContents }): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function createWindow(): BrowserWindow {
  const state = loadState()
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: TRAFFIC_LIGHT, visualEffectState: 'active' as const }
      : {}),
    // Opaque until the renderer has painted once. Vibrancy behind an empty
    // window shows the desktop through it, which reads as a broken launch;
    // `window:enable-glass` swaps it in after the first frame.
    backgroundColor: '#171717',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (state.maximized) win.maximize()

  win.on('ready-to-show', () => win.show())
  win.on('resize', () => {
    saveStateSoon(win)
    if (!win.isDestroyed()) win.webContents.send('window:resized')
  })
  win.on('move', () => saveStateSoon(win))
  win.on('maximize', () => saveStateSoon(win))
  win.on('unmaximize', () => saveStateSoon(win))

  win.on('close', (e) => {
    const id = win.webContents.id
    if (destroying.delete(id)) return
    if (!closeSubscribers.has(id)) return
    // The renderer owns this decision (unsaved work, hide-instead-of-close);
    // it answers with `window:hide` or `window:destroy`.
    e.preventDefault()
    win.webContents.send('window:close-requested')
  })

  win.on('closed', () => {
    const id = win.webContents.id
    closeSubscribers.delete(id)
    quitSubscribers.delete(id)
    badges.delete(id)
    killPtysForOwner(id)
    applyBadge(false)
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (transfer && transfer.forWebContents === null) transfer.forWebContents = win.webContents.id

  return win
}

function applyBadge(allowBounce: boolean): void {
  if (process.platform !== 'darwin' || !app.dock) return
  let total = 0
  for (const n of badges.values()) total += n
  app.dock.setBadge(total <= 0 ? '' : total > 99 ? '99+' : String(total))
  const active = BrowserWindow.getAllWindows().some((w) => w.isFocused())
  if (allowBounce && total > lastBadgeTotal && !active) app.dock.bounce('informational')
  lastBadgeTotal = total
}

/** Renderers that want the last word before the app exits. */
const quitSubscribers = new Set<number>()

export function hasQuitSubscriber(): boolean {
  return [...quitSubscribers].some((id) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === id)
    return win !== undefined && !win.isDestroyed()
  })
}

/** Ask a renderer to confirm; it answers with `app:confirm-quit`. */
export function requestQuit(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  win.show()
  win.webContents.send('app:quit-requested')
}

/** True once the user has confirmed; keeps `before-quit` from asking twice. */
let quitting = false

export function isQuitting(): boolean {
  return quitting
}

export function beginQuit(): void {
  quitting = true
}

export function showAllWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isVisible()) w.show()
}

export function registerWindows(): void {
  ipcMain.handle('window:minimize', (e) => windowOf(e)?.minimize())
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = windowOf(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', (e) => windowOf(e)?.close())
  ipcMain.handle('window:is-maximized', (e) => windowOf(e)?.isMaximized() ?? false)
  ipcMain.handle('window:is-focused', (e) => windowOf(e)?.isFocused() ?? false)
  ipcMain.handle('window:set-title', (e, title: string) => windowOf(e)?.setTitle(String(title)))

  ipcMain.on('window:close-subscribe', (e: IpcMainEvent) => {
    closeSubscribers.add(e.sender.id)
  })

  ipcMain.on('app:quit-subscribe', (e: IpcMainEvent) => {
    quitSubscribers.add(e.sender.id)
  })

  ipcMain.handle('window:hide', (e) => windowOf(e)?.hide())
  ipcMain.handle('window:destroy', (e) => {
    const win = windowOf(e)
    if (!win) return
    destroying.add(win.webContents.id)
    win.destroy()
  })

  ipcMain.handle('window:new', () => {
    createWindow()
  })

  ipcMain.handle('window:stage-transfer', (_e, payload: unknown) => {
    transfer = { payload, forWebContents: null }
  })
  ipcMain.handle('window:take-transfer', (e) => {
    if (!transfer || transfer.forWebContents !== e.sender.id) return null
    const { payload } = transfer
    transfer = null
    return payload
  })

  ipcMain.handle('window:buttons-visible', (e, visible: boolean) => {
    if (process.platform !== 'darwin') return
    windowOf(e)?.setWindowButtonVisibility(visible !== false)
  })

  ipcMain.handle('window:enable-glass', (e) => {
    if (process.platform !== 'darwin') return
    const win = windowOf(e)
    if (!win) return
    win.setBackgroundColor('#00000000')
    win.setVibrancy('under-window')
  })

  ipcMain.handle('window:set-zoom', (e, factor: number) => {
    const f = Number(factor)
    if (!Number.isFinite(f) || f <= 0) return
    e.sender.setZoomFactor(f)
  })

  ipcMain.handle('app:dock-badge', (e, count: number) => {
    const n = Math.max(0, Math.trunc(Number(count) || 0))
    badges.set(e.sender.id, n)
    applyBadge(true)
  })
}

export function registerDock(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setMenu(
    Menu.buildFromTemplate([{ label: 'New Window', click: () => void createWindow() }])
  )
}

/** Clicking the dock icon should bring back a hidden window before it makes
 *  a new one. */
export function activateWindows(): void {
  const windows = BrowserWindow.getAllWindows()
  const hidden = windows.filter((w) => !w.isVisible())
  if (hidden.length > 0) {
    for (const w of hidden) w.show()
    return
  }
  if (windows.length === 0) createWindow()
  else windows[0].focus()
}
