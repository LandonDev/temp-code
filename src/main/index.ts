import { app, shell, dialog, BrowserWindow, ipcMain } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { registerUpdates } from './update'
import { registerAppshots } from './appshots'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startServer, type RunningServer } from './server'

let server: RunningServer | null = null

// Live-diff watchers cost one kqueue fd per watched file on macOS (chokidar
// 4+ has no FSEvents backend), so two ~4k-file worktrees running at once sit
// at Chromium's 8192-fd default and every spawn() after that fails EBADF —
// new threads and projects can't start. Raise the soft limit to the OS hard
// limit (Electron clamps).
if (process.platform !== 'win32') {
  process.setFdLimit(1_048_576)
}

// Parallel dev instances (worktrees) get their own userData + database so
// they never contend with the primary checkout's running app.
if (process.env.TEMP_CODE_USER_DATA) {
  app.setPath('userData', process.env.TEMP_CODE_USER_DATA)
}
if (process.env.TEMP_CODE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.TEMP_CODE_DEBUG_PORT)
}

// Two hard walls against sharing a database. A dev instance without its own
// userData would open the installed app's database — a second SQLite writer
// there stalls the running app's event writes mid-turn (threads freeze on
// "Working…") and its boot-time status reset scribbles over live sessions.
// So: dev builds REQUIRE the env override, and any userData accepts only
// one instance, ever (the lock is per userData dir).
if (!app.isPackaged && !process.env.TEMP_CODE_USER_DATA) {
  console.error(
    'refusing to run: dev instances must set TEMP_CODE_USER_DATA ' +
      "(see CLAUDE.md) — this would open the installed app's database"
  )
  app.exit(1)
}
if (!app.requestSingleInstanceLock()) {
  console.error('refusing to run: another instance already owns this userData directory')
  app.exit(1)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Zeron glass: real window vibrancy under the shell; the renderer tints
    // it #080808/80% and keeps the content panel opaque.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const }
      : {}),
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#060606',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.landon.temp-code')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // The packaged app's userData follows its product name (TempCode); the
  // years of dev-mode data live under the old package-name dir. First
  // packaged boot copies the database over so nothing is lost.
  if (app.isPackaged && !process.env.TEMP_CODE_USER_DATA) {
    const dbPath = join(app.getPath('userData'), 'temp-code.db')
    const oldDir = join(homedir(), 'Library', 'Application Support', 'temp-code')
    if (!existsSync(dbPath) && existsSync(join(oldDir, 'temp-code.db'))) {
      mkdirSync(app.getPath('userData'), { recursive: true })
      for (const f of ['temp-code.db', 'temp-code.db-wal', 'temp-code.db-shm']) {
        if (existsSync(join(oldDir, f)))
          copyFileSync(join(oldDir, f), join(app.getPath('userData'), f))
      }
    }
  }
  server = await startServer(join(app.getPath('userData'), 'temp-code.db'))
  registerUpdates()
  if (process.platform === 'darwin') registerAppshots(server, createWindow)
  ipcMain.handle('server-port', () => server?.port ?? null)
  ipcMain.handle('pick-directory', async (_e, defaultPath?: string) => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || homedir()
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('reveal-in-finder', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  void server?.close()
})
