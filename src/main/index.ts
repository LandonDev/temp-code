import { app, shell, dialog, net, BrowserWindow, ipcMain } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { registerUpdates } from './update'
import { configureAliax } from './aliax'
import { registerAppshots } from './appshots'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { startServer, type RunningServer } from './server'
import { mayClaimShim, releaseGateway } from './server/gateway'
import { killTrackedChildren } from './server/spawnBudget'
import { pagesRoot, registerAssetProtocol, registerAssetScheme } from './assets'
import { htmlPreviewer } from './htmlPreview'
import { setHtmlPreviewer, setHtmlRenderRoot } from './server/htmlRender'
import { killAllPtys, listPtys, ptyFlowCounters, registerPty } from './pty'
import { clickMenuItem, registerMenu } from './menu'
import { queueNextPick, registerDialogs } from './dialogs'
import {
  activateWindows,
  createWindow,
  describeWindows,
  hasQuitSubscriber,
  isQuitting,
  openSavedWindows,
  registerDock,
  registerWindows,
  requestQuit
} from './windows'

let server: RunningServer | null = null

// Deliberately NOT raising the fd soft limit: Chromium's 8192 default is
// the containment wall that keeps a runaway fd consumer an app problem
// instead of a machine problem. The v70 raise let per-file watchers starve
// the system file/vnode tables — network down, reboot required. Watchers
// are one-fd-per-tree now (treewatch.ts); if the app ever nears 8192
// again, find the leak, don't raise the wall.

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

// Privileged scheme registration only takes effect before the app is ready.
registerAssetScheme()

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
  registerAssetProtocol()
  // Agent HTML pages: stored under userData, previewed in the hidden window.
  setHtmlRenderRoot(pagesRoot())
  setHtmlPreviewer(htmlPreviewer)
  configureAliax()
  server = await startServer(join(app.getPath('userData'), 'temp-code.db'), {
    appPath: app.getAppPath(),
    claimShim: mayClaimShim({ isPackaged: app.isPackaged })
  })
  registerUpdates()
  registerPty()
  const { store } = server
  registerWindows({ dropSnapshot: (slot) => store.dropWorkspaceSnapshot(slot) })
  registerDialogs()
  registerMenu()
  registerDock()
  if (!app.isPackaged) registerDebug()
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

  openSavedWindows()

  app.on('activate', function () {
    activateWindows()
  })
})

/** Dev-only hooks so the CDP exit test can drive things a page cannot. */
function registerDebug(): void {
  ipcMain.handle('debug:menu-click', (e, id: string) =>
    clickMenuItem(String(id), BrowserWindow.fromWebContents(e.sender))
  )
  ipcMain.handle('debug:dock-badge', () => (app.dock ? app.dock.getBadge() : null))
  ipcMain.handle('debug:window-title', (e) => BrowserWindow.fromWebContents(e.sender)?.getTitle())
  ipcMain.handle('debug:pty-flow', () => ptyFlowCounters())
  ipcMain.handle('debug:windows', () => describeWindows())
  ipcMain.handle('debug:ptys', () => listPtys())
  ipcMain.handle('debug:next-pick', (_e, paths: string[]) => queueNextPick(paths.map(String)))
  // The old renderer's CSP forbids tempcode-asset:, so the scheme is
  // exercised from main instead.
  ipcMain.handle('debug:asset-fetch', async (_e, url: string) => {
    try {
      const res = await net.fetch(String(url))
      return { status: res.status, body: (await res.text()).slice(0, 200) }
    } catch (e) {
      return { status: 0, body: `threw ${(e as Error).message}` }
    }
  })
}

// macOS keeps the app in the dock after the last window closes (the donor
// does too); the kept slot comes back on the dock click. Elsewhere the last
// window is the app.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (e) => {
  // A renderer that asked for the last word gets it once; after
  // `app:confirm-quit` the gate is open and we shut down for real.
  if (!isQuitting() && hasQuitSubscriber()) {
    e.preventDefault()
    requestQuit()
    return
  }
  // The server outlives every window and dies only here, with the PTYs
  // and every helper process it started.
  // The shim marker goes back to Aliax first: the async close may not finish.
  releaseGateway()
  killAllPtys()
  void server?.close()
  killTrackedChildren()
})

// Nothing of ours outlives the main process: a signal or a plain exit
// takes the helpers (git, gh, language servers) with it. Children stay in
// our process group, so a group kill from outside gets them as well.
process.on('exit', () => {
  releaseGateway()
  killTrackedChildren()
})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    releaseGateway()
    killAllPtys()
    killTrackedChildren()
    process.exit(0)
  })
}
