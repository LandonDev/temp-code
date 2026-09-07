import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import {
  askBoxOptions,
  messageBoxOptions,
  openDialogOptions,
  openDialogResult,
  type AskOptions,
  type MessageOptions,
  type OpenOptions
} from './dialog-options'
import { beginQuit, showAllWindows } from './windows'

function parentOf(event: { sender: Electron.WebContents }): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function defaultCwd(): string {
  try {
    const cwd = process.cwd()
    if (cwd) return cwd
  } catch {
    // a deleted working directory throws here
  }
  return homedir() || '~'
}

/** Dev-only: the CDP exit test cannot drive a native sheet, so it can
 *  queue the answer the next open dialog would return. */
let nextPick: string[] | null = null
export function queueNextPick(paths: string[]): void {
  nextPick = paths
}

export function registerDialogs(): void {
  ipcMain.handle('dialog:open', async (e, options: OpenOptions = {}) => {
    if (nextPick) {
      const paths = nextPick
      nextPick = null
      return openDialogResult(false, paths, options)
    }
    const parent = parentOf(e)
    const opts = openDialogOptions(options)
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
    return openDialogResult(res.canceled, res.filePaths, options)
  })

  ipcMain.handle('dialog:ask', async (e, text: string, options: AskOptions = {}) => {
    const parent = parentOf(e)
    const opts = askBoxOptions(text, options)
    const res = parent
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts)
    return res.response === 0
  })

  ipcMain.handle('dialog:message', async (e, text: string, options: MessageOptions = {}) => {
    const parent = parentOf(e)
    const opts = messageBoxOptions(text, options)
    if (parent) await dialog.showMessageBox(parent, opts)
    else await dialog.showMessageBox(opts)
  })

  ipcMain.handle('shell:open-url', async (_e, url: string) => {
    await shell.openExternal(String(url))
  })

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:home-dir', () => homedir() || process.env.HOME || '~')
  ipcMain.handle('app:default-cwd', () => defaultCwd())

  // The renderer has finished asking the user; the next `before-quit` must
  // go straight through instead of bouncing back for another confirmation.
  ipcMain.handle('app:confirm-quit', () => {
    beginQuit()
    showAllWindows()
    app.quit()
  })
}
