import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { MENU_TREE, type MenuNode } from './menu-tree'
import { createWindow } from './windows'

/** Only set while a dev-only synthetic click runs: a menu can be clicked
 *  from CDP while the app is not frontmost, when nothing is focused. */
let debugTarget: BrowserWindow | null = null

/** Custom items go to whichever window the user is looking at; New Window
 *  too, so it runs through the renderer's command map like the key does.
 *  Only with no window to ask (all closed, app still in the dock) does
 *  main open one itself. */
function dispatch(id: string): void {
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

/** The renderer's word on each checkbox item (its setting lives there). */
const checked = new Map<string, boolean>()

function toItem(node: MenuNode): MenuItemConstructorOptions {
  if (node.kind === 'separator') return { type: 'separator' }
  if (node.kind === 'role') return { role: node.role as MenuItemConstructorOptions['role'] }
  return {
    id: node.id,
    label: node.label,
    ...(node.accelerator ? { accelerator: node.accelerator } : {}),
    ...(node.checkbox ? { type: 'checkbox' as const, checked: checked.get(node.id) ?? false } : {}),
    click: () => dispatch(node.id)
  }
}

/** A checkbox item follows the renderer's setting (`menu:set-checked`). */
export function setMenuChecked(id: string, value: boolean): void {
  checked.set(id, value)
  const item = (installed ?? Menu.getApplicationMenu())?.getMenuItemById(id)
  if (item && item.type === 'checkbox') item.checked = value
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
