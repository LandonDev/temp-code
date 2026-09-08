import { app, BrowserWindow, ipcMain, Menu, shell, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { killPtysForOwner } from './pty'

/**
 * The window registry. Every window has a *slot*: a stable id that names
 * its bounds in `window-state.json` and its workspace snapshot in the
 * server's settings KV (`workspace.getSnapshot { window }`). The renderer
 * learns its slot from preload (`--tc-window-slot=` in argv), so a window
 * restores the tab set it had, not whichever window saved last. Launch
 * opens one window per saved slot; the first ever is `main`.
 *
 * Close and quit follow the donor: a renderer that subscribed to
 * close-requested answers with hide (busy) or destroy (idle, after it
 * persisted). Closing the last window keeps the app in the dock on macOS
 * and keeps its slot, so the dock click brings the same tabs back; closing
 * one of several drops that slot and its snapshot. Quit asks the focused
 * window first (dialog when busy, then persist, then `confirm_quit`); main
 * then asks every other window to persist, waits briefly, and exits.
 */

/** Donor chrome: inset traffic lights and a floor the layout still fits in. */
const TRAFFIC_LIGHT = { x: 12, y: 13 }
const MIN_WIDTH = 800
const MIN_HEIGHT = 520
export const MAIN_SLOT = 'main'
const CASCADE = 24
const PERSIST_TIMEOUT_MS = 2_000

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface StateFile {
  windows: Record<string, WindowState>
  focused?: string
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800, maximized: false }

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function readWindowState(raw: Partial<WindowState>): WindowState {
  return {
    x: typeof raw.x === 'number' ? raw.x : undefined,
    y: typeof raw.y === 'number' ? raw.y : undefined,
    width: Math.max(MIN_WIDTH, Number(raw.width) || DEFAULT_STATE.width),
    height: Math.max(MIN_HEIGHT, Number(raw.height) || DEFAULT_STATE.height),
    maximized: raw.maximized === true
  }
}

let stateFile: StateFile | null = null

/** The file before M12 held one window's bounds; that window is `main`. */
function loadStateFile(): StateFile {
  if (stateFile) return stateFile
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, unknown>
    const windows: Record<string, WindowState> = {}
    if (raw.windows && typeof raw.windows === 'object') {
      for (const [slot, state] of Object.entries(raw.windows as Record<string, unknown>)) {
        if (state && typeof state === 'object') windows[slot] = readWindowState(state as never)
      }
    } else if (typeof raw.width === 'number') {
      windows[MAIN_SLOT] = readWindowState(raw as never)
    }
    stateFile = { windows, focused: typeof raw.focused === 'string' ? raw.focused : undefined }
  } catch {
    stateFile = { windows: {} }
  }
  return stateFile
}

let saveTimer: NodeJS.Timeout | null = null
function saveStateSoon(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveStateNow()
  }, 400)
  saveTimer.unref()
}

function saveStateNow(): void {
  const file = loadStateFile()
  for (const { win, slot } of windows.values()) {
    if (win.isDestroyed()) continue
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    file.windows[slot] = { ...bounds, maximized: win.isMaximized() }
  }
  const focused = entryOf(targetWindow())
  if (focused) file.focused = focused.slot
  try {
    writeFileSync(statePath(), JSON.stringify(file))
  } catch {
    // a missing userData dir is not worth crashing over
  }
}

// ── Registry ─────────────────────────────────────────────────────────────

interface Entry {
  win: BrowserWindow
  slot: string
}

/** Live windows by webContents id. */
const windows = new Map<number, Entry>()
/** The window the user last had in front; pushes go here when nothing is focused. */
let lastFocusedId: number | null = null
/** Windows whose renderer asked to handle its own close. The old renderer
 *  never subscribes, so its window still closes the normal way. */
const closeSubscribers = new Set<number>()
/** Set for the one close that `window:destroy` performs itself. */
const destroying = new Set<number>()
/** Renderers that want the last word before the app exits. */
const quitSubscribers = new Set<number>()
/** Unread counts per window; the dock shows their sum. */
const badges = new Map<number, number>()
let lastBadgeTotal = 0
/** Called when a slot is gone for good so its snapshot goes with it. */
let dropSnapshot: (slot: string) => void = () => {}

/** One staged payload: `from` staged it, `to` is the window that may take it. */
let transfer: { payload: unknown; from: number; to: number | null } | null = null

function entryOf(win: BrowserWindow | null | undefined): Entry | null {
  return win ? (windows.get(win.webContents.id) ?? null) : null
}

function windowOf(event: { sender: Electron.WebContents }): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function alive(id: number | null): BrowserWindow | null {
  if (id === null) return null
  const win = windows.get(id)?.win
  return win && !win.isDestroyed() ? win : null
}

/** Where window-scoped pushes go: the focused window, else the one the
 *  user had in front last (an appshot hotkey fires while another app is
 *  frontmost, so nothing is focused then), else any live window. */
export function targetWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ??
    alive(lastFocusedId) ??
    [...windows.values()].map((e) => e.win).find((w) => !w.isDestroyed()) ??
    null
  )
}

export function slotOf(win: BrowserWindow): string | null {
  return entryOf(win)?.slot ?? null
}

function newSlot(): string {
  return `w-${randomUUID().slice(0, 8)}`
}

function releaseTransferFor(id: number): void {
  if (transfer && transfer.to === id) transfer = null
}

/** Bounds for a window with no saved state: a step down and right from the
 *  one in front, so a new window does not hide the old one exactly. */
function cascadeFrom(win: BrowserWindow | null): WindowState {
  if (!win || win.isDestroyed()) return { ...DEFAULT_STATE }
  const b = win.getBounds()
  return { x: b.x + CASCADE, y: b.y + CASCADE, width: b.width, height: b.height, maximized: false }
}

export function createWindow(opts: { slot?: string; from?: number } = {}): BrowserWindow {
  const slot = opts.slot ?? newSlot()
  const state = loadStateFile().windows[slot] ?? cascadeFrom(targetWindow())
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
      sandbox: false,
      additionalArguments: [`--tc-window-slot=${slot}`]
    }
  })
  const id = win.webContents.id
  windows.set(id, { win, slot })
  loadStateFile().windows[slot] = state

  if (state.maximized) win.maximize()

  win.on('ready-to-show', () => win.show())
  win.on('focus', () => {
    lastFocusedId = id
    saveStateSoon()
  })
  win.on('resize', () => {
    saveStateSoon()
    if (!win.isDestroyed()) win.webContents.send('window:resized')
  })
  win.on('move', saveStateSoon)
  win.on('maximize', saveStateSoon)
  win.on('unmaximize', saveStateSoon)

  win.on('close', (e) => {
    if (destroying.delete(id) || quitting) return
    if (!closeSubscribers.has(id)) return
    // The renderer owns this decision (unsaved work, hide-instead-of-close);
    // it answers with `window:hide` or `window:destroy`.
    e.preventDefault()
    win.webContents.send('window:close-requested')
  })

  win.on('closed', () => {
    windows.delete(id)
    closeSubscribers.delete(id)
    quitSubscribers.delete(id)
    badges.delete(id)
    releaseTransferFor(id)
    killPtysForOwner(id)
    applyBadge(false)
    if (lastFocusedId === id) lastFocusedId = null
    // One of several closed: that layout is gone by the user's choice. The
    // last one keeps its slot so the dock click (or the next launch) brings
    // the same tabs back. Quit keeps every slot.
    if (!quitting && windows.size > 0) {
      delete loadStateFile().windows[slot]
      dropSnapshot(slot)
    }
    if (!quitting) saveStateNow()
  })

  // A destination that never boots must not hold the payload for the next
  // window that happens to be created.
  win.webContents.on('did-fail-load', () => releaseTransferFor(id))
  win.webContents.on('render-process-gone', () => releaseTransferFor(id))

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (transfer && transfer.to === null && (opts.from === undefined || transfer.from === opts.from)) {
    transfer.to = id
  }

  return win
}

/** Launch: one window per saved slot, the last-focused one in front. */
export function openSavedWindows(): void {
  const file = loadStateFile()
  const slots = Object.keys(file.windows)
  if (slots.length === 0) slots.push(MAIN_SLOT)
  const focused = file.focused && slots.includes(file.focused) ? file.focused : slots[0]
  for (const slot of slots) if (slot !== focused) createWindow({ slot })
  createWindow({ slot: focused })
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

// ── Quit ─────────────────────────────────────────────────────────────────

export function hasQuitSubscriber(): boolean {
  return [...quitSubscribers].some((id) => alive(id) !== null)
}

/** Ask the window in front to confirm; it answers with `app:confirm-quit`. */
export function requestQuit(): void {
  const win = targetWindow()
  if (!win) return
  win.show()
  win.webContents.send('app:quit-requested')
}

/** True once the user has confirmed; keeps `before-quit` from asking twice. */
let quitting = false

export function isQuitting(): boolean {
  return quitting
}

/** The persist acks main is waiting on, by webContents id. */
const persistWaiters = new Map<number, () => void>()

/** Every other window persists its own slot before the app exits. Only the
 *  focused one had the dialog; these just write. A renderer that does not
 *  answer inside the cap does not hold the quit. */
function persistOthers(except: number): Promise<void> {
  const waits: Promise<void>[] = []
  for (const id of quitSubscribers) {
    if (id === except) continue
    const win = alive(id)
    if (!win) continue
    waits.push(
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, PERSIST_TIMEOUT_MS)
        timer.unref()
        function done(): void {
          clearTimeout(timer)
          persistWaiters.delete(id)
          resolve()
        }
        persistWaiters.set(id, done)
        win.webContents.send('window:persist-requested')
      })
    )
  }
  return Promise.all(waits).then(() => undefined)
}

/** The renderer has finished asking the user and persisted; the next
 *  `before-quit` goes straight through instead of bouncing back. */
export async function confirmQuit(from: number): Promise<void> {
  if (quitting) return
  quitting = true
  await persistOthers(from)
  saveStateNow()
  showAllWindows()
  app.quit()
}

export function showAllWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isVisible()) w.show()
}

// ── IPC ──────────────────────────────────────────────────────────────────

export function registerWindows(hooks: { dropSnapshot?: (slot: string) => void } = {}): void {
  if (hooks.dropSnapshot) dropSnapshot = hooks.dropSnapshot

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
  ipcMain.on('window:persisted', (e: IpcMainEvent) => {
    persistWaiters.get(e.sender.id)?.()
  })
  ipcMain.handle('app:confirm-quit', (e) => confirmQuit(e.sender.id))

  ipcMain.handle('window:hide', (e) => windowOf(e)?.hide())
  ipcMain.handle('window:destroy', (e) => {
    const win = windowOf(e)
    if (!win) return
    destroying.add(win.webContents.id)
    win.destroy()
  })

  ipcMain.handle('window:new', (e) => {
    createWindow({ from: e.sender.id })
  })

  ipcMain.handle('window:stage-transfer', (e, payload: unknown) => {
    if (typeof payload === 'string' && payload.trim() === '') {
      throw new Error('empty window transfer payload')
    }
    transfer = { payload, from: e.sender.id, to: null }
  })
  ipcMain.handle('window:take-transfer', (e) => {
    if (!transfer || transfer.to !== e.sender.id) return null
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

/** The donor's dock menu has one item. */
export function registerDock(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setMenu(
    Menu.buildFromTemplate([{ label: 'New Window', click: () => void createWindow() }])
  )
}

/** Clicking the dock icon should bring back a hidden window before it makes
 *  a new one. With none left, the kept slot comes back with its tabs. */
export function activateWindows(): void {
  const all = BrowserWindow.getAllWindows()
  const hidden = all.filter((w) => !w.isVisible())
  if (hidden.length > 0) {
    for (const w of hidden) {
      if (w.isMinimized()) w.restore()
      w.show()
    }
    hidden[0].focus()
    return
  }
  if (all.length === 0) openSavedWindows()
  else (targetWindow() ?? all[0]).focus()
}

/** Dev-only: what the exit test needs to tell windows apart over CDP. */
export function describeWindows(): {
  id: number
  slot: string
  title: string
  focused: boolean
  visible: boolean
  target: boolean
}[] {
  const target = targetWindow()
  return [...windows.values()]
    .filter(({ win }) => !win.isDestroyed())
    .map(({ win, slot }) => ({
      id: win.webContents.id,
      slot,
      title: win.getTitle(),
      focused: win.isFocused(),
      visible: win.isVisible(),
      target: win === target
    }))
}
