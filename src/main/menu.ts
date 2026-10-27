import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { EMPTY_MENU_STATE, MENU_TREE, resolveMenu, sameMenuState, type MenuNode, type MenuState } from '../shared/menuTree'
import { createWindow } from './windows'
import { hostProfileRunning, profileHost } from './server/doctorProfile'

/** Only set while a dev-only synthetic click runs: a menu can be clicked
 *  from CDP while the app is not frontmost, when nothing is focused. */
let debugTarget: BrowserWindow | null = null

/** Custom items go to whichever window the user is looking at; New Window
 *  too, so it runs through the renderer's command map like the key does.
 *  Only with no window to ask (all closed, app still in the dock) does
 *  main open one itself. */
function dispatch(id: string): void {
  if (id === 'profile_host') {
    if (hostProfileRunning()) return
    void profileHost({ seconds: 10 }).then(({ path }) => shell.showItemInFolder(path)).catch((error) => {
      console.error(`[doctor] ${String(error).replace(/[\r\n]+/g, ' ')}`)
    })
    return
  }
  if (id === 'show_logs') {
    // The directory the server writes its logs and profiles to.
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    void shell.openPath(dir)
    return
  }
  if (id === 'quit') {
    app.quit()
    return
  }
  const win = BrowserWindow.getFocusedWindow() ?? debugTarget
  if (!win || win.isDestroyed()) {
    if (id === 'new_window') createWindow()
    return
  }
  win.webContents.send('native:menu', id)
}

function toItem(node: MenuNode): MenuItemConstructorOptions {
  if (node.kind === 'separator') return { type: 'separator' }
  if (node.kind === 'submenu') return { label: node.label, submenu: node.items.map(toItem) }
  if (node.kind === 'role') {
    return {
      role: node.role as MenuItemConstructorOptions['role'],
      ...(node.label ? { label: node.label } : {}),
      ...(node.accelerator ? { accelerator: node.accelerator } : {})
    }
  }
  return {
    id: node.id,
    label: node.label,
    ...(node.accelerator ? { accelerator: node.accelerator } : {}),
    // The page owns the key (a focused terminal keeps ⌃` for the shell); the item only shows it.
    ...(node.pageKey ? { registerAccelerator: false } : {}),
    ...(node.enabled === false ? { enabled: false } : {}),
    click: () => dispatch(node.id)
  }
}

export function buildMenu(state: MenuState = EMPTY_MENU_STATE): Menu {
  const template: MenuItemConstructorOptions[] = resolveMenu(MENU_TREE, state).map((section) => ({
    label: section.label,
    ...(section.role ? { role: section.role } : {}),
    submenu: section.items.map(toItem)
  }))
  return Menu.buildFromTemplate(template)
}

let installed: Menu | null = null
let applied: MenuState = EMPTY_MENU_STATE

/** Each window's last word over `menu:state`, by webContents id. */
const states = new Map<number, MenuState>()

/** Electron cannot relabel a built item: a new state is a new menu, built only when it differs. */
function apply(state: MenuState): void {
  if (installed && sameMenuState(state, applied)) return
  applied = state
  installed = buildMenu(state)
  Menu.setApplicationMenu(installed)
}

/** The focused window's state, or every row enabled and every toggle Show with none. */
export function applyFocusedMenu(): void {
  const win = BrowserWindow.getFocusedWindow()
  apply((win && !win.isDestroyed() && states.get(win.webContents.id)) || EMPTY_MENU_STATE)
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** A window said what it shows; it reaches the menu now if that window is the focused one,
 *  else when it is next focused. */
export function receiveMenuState(contents: WebContents, raw: unknown): void {
  const value = (raw ?? {}) as Partial<MenuState>
  if (!states.has(contents.id)) {
    const id = contents.id
    contents.once('destroyed', () => {
      states.delete(id)
      applyFocusedMenu()
    })
  }
  states.set(contents.id, { open: strings(value.open), disabled: strings(value.disabled) })
  if (BrowserWindow.getFocusedWindow()?.webContents === contents) applyFocusedMenu()
}

export function registerMenu(): void {
  apply(EMPTY_MENU_STATE)
  ipcMain.on('menu:state', (event, state: unknown) => receiveMenuState(event.sender, state))
  app.on('browser-window-focus', applyFocusedMenu)
  if (process.platform === 'darwin') registerZoomKeys()
}

/** On macOS 26 AppKit swallows ⌘− (and can ⌘0) before the menu, Chromium or
 *  the page sees it, while ⌘= gets through. A shortcut held only while one of
 *  our windows is focused sits above that layer; it runs the same command
 *  the menu item does, and the renderer's debounce absorbs a second route. */
const ZOOM_KEYS: Record<string, string> = { 'CmdOrCtrl+-': 'zoom_out', 'CmdOrCtrl+0': 'zoom_reset' }

function registerZoomKeys(): void {
  const hold = (): void => {
    for (const [key, id] of Object.entries(ZOOM_KEYS)) {
      if (!globalShortcut.isRegistered(key)) globalShortcut.register(key, () => dispatch(id))
    }
  }
  const release = (): void => {
    for (const key of Object.keys(ZOOM_KEYS)) globalShortcut.unregister(key)
  }
  app.on('browser-window-focus', hold)
  // Moving between our own windows blurs one before focusing the next.
  app.on('browser-window-blur', () => setImmediate(() => {
    if (!BrowserWindow.getFocusedWindow()) release()
  }))
  app.on('will-quit', release)
  if (BrowserWindow.getFocusedWindow()) hold()
}

/** Dev-only: lets the exit test exercise menu wiring without a keyboard. */
export function clickMenuItem(id: string, target?: BrowserWindow | null): boolean {
  const item = (installed ?? Menu.getApplicationMenu())?.getMenuItemById(id)
  if (!item) return false
  debugTarget = target ?? null
  try {
    item.click()
  } finally {
    debugTarget = null
  }
  return true
}
