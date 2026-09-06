import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { MENU_TREE, type MenuNode } from './menu-tree'
import { createWindow } from './windows'

/** Custom items go to whichever window the user is looking at. */
function dispatch(id: string): void {
  if (id === 'new_window') {
    createWindow()
    return
  }
  if (id === 'quit') {
    app.quit()
    return
  }
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return
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
}

/** Dev-only: lets the exit test exercise menu wiring without a keyboard. */
export function clickMenuItem(id: string): boolean {
  const item = (installed ?? Menu.getApplicationMenu())?.getMenuItemById(id)
  if (!item) return false
  item.click()
  return true
}
