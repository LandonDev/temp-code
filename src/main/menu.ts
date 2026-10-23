import { app, BrowserWindow, globalShortcut, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { MENU_TREE, type MenuNode } from './menu-tree'
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
  if (node.kind === 'role') return { role: node.role as MenuItemConstructorOptions['role'] }
  return {
    id: node.id,
    label: node.label,
    ...(node.accelerator ? { accelerator: node.accelerator } : {}),
    click: () => dispatch(node.id)
  }
}

export function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = MENU_TREE.map((section) => ({
    label: section.label,
    ...(section.role ? { role: section.role } : {}),
    submenu: section.items.map(toItem)
  }))
  return Menu.buildFromTemplate(template)
}

let installed: Menu | null = null

export function registerMenu(): void {
  installed = buildMenu()
  Menu.setApplicationMenu(installed)
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
