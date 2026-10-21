import { app, shell, dialog, net, BrowserWindow, ipcMain } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { flushCompileCache, getCompileCacheDir } from 'node:module'
import { bootMark } from './server/boot'
import { noteInstallOnQuit, registerUpdates } from './update'
import { applyHarness, bakedHarness } from './harness'
import { configureAliax } from './aliax'
import { loadEnvironmentId } from './server/remote/environment'
import { aliaxCallCounts, registerAliaxPages } from './aliaxPages'
import { registerAppshots } from './appshots'
import { EditorLauncher, defaultEditorLaunchDeps, editorChoice, type EditorTarget } from './editorLaunch'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { startServer, type RunningServer } from './server'
import { listEnvironments } from './server/remote/environments'
import type { LaunchMirrorSnapshot, MirrorWrite } from '@shared/launchMirror'
import { mayClaimShim, releaseGateway } from './server/gateway'
import { killTrackedChildren } from './server/spawnBudget'
import { handleAssetRequest, pagesRoot, registerAssetProtocol, registerSchemes } from './assets'
import { registerAppProtocol } from './appScheme'
import { migrateLocalStorage } from './originMigration'
import { isHeadless, noDisplay, publishLocalPort, quitsOnAllClosed, unpublishLocalPort } from './headless'
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

// First statement of the bundle: everything before this mark is Electron's
// own init plus the compile of out/main/index.js (through boot.js). `start=`
// is the process start as an epoch, so renderer marks can be aligned to it.
bootMark(
  'index',
  `start=${Date.now() - Math.round(process.uptime() * 1000)} compile-cache=${getCompileCacheDir() ? 'on' : 'off'}`
)

let server: RunningServer | null = null

/** Node writes the compile cache (boot.ts) to disk only at its own exit, which
 *  Electron's quit never reaches: flush once boot has settled, and again in
 *  before-quit for modules required lazily since. No-ops when the cache is off. */
const FLUSH_AFTER_MS = 10_000

// Deliberately NOT raising the fd soft limit: Chromium's 8192 default is
// the containment wall that keeps a runaway fd consumer an app problem
// instead of a machine problem. The v70 raise let per-file watchers starve
// the system file/vnode tables — network down, reboot required. Watchers
// are one-fd-per-tree now (treewatch.ts); if the app ever nears 8192
// again, find the leak, don't raise the wall.

// Parallel dev instances (worktrees) get their own userData + database so
// they never contend with the primary checkout's running app. A packaged
// test build carries the same overrides in its package.json (harness.ts).
applyHarness(process.env, bakedHarness(app.getAppPath()))
if (process.env.TEMP_CODE_USER_DATA) {
  app.setPath('userData', process.env.TEMP_CODE_USER_DATA)
}
if (process.env.TEMP_CODE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.TEMP_CODE_DEBUG_PORT)
}
// An agent host with no desktop (headless.ts): no window, menu, dock or
// updater, and no GPU worth probing. Without any display server at all,
// Chromium's headless Ozone backend stands in for one so the hidden
// preview window can still paint.
const headless = isHeadless()
/** Set once openSavedWindows has run: before that, a hidden helper's going is not a quit. */
let userWindowsOpened = false
if (headless) {
  app.disableHardwareAcceleration()
  if (noDisplay()) app.commandLine.appendSwitch('ozone-platform', 'headless')
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
registerSchemes()

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.landon.temp-code')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // The packaged app's userData follows its product name (TempCode); the
  // years of dev-mode data live under the old package-name dir. First
  // packaged boot copies the database over so nothing is lost. The old dir
  // is a macOS path, so only a Mac looks.
  if (process.platform === 'darwin' && app.isPackaged && !process.env.TEMP_CODE_USER_DATA) {
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
  registerAppProtocol()
  // Agent HTML pages: stored under userData, previewed in the hidden window.
  setHtmlRenderRoot(pagesRoot())
  setHtmlPreviewer(htmlPreviewer)
  // The core compares every profile's owner to this id (aliax-core sync.ts).
  configureAliax(loadEnvironmentId(app.getPath('userData')))
  server = await startServer(join(app.getPath('userData'), 'temp-code.db'), {
    appPath: app.getAppPath(),
    claimShim: mayClaimShim({ isPackaged: app.isPackaged }),
    assets: handleAssetRequest,
    watchMaster: !headless
  })
  if (!headless) {
    registerUpdates()
    // Master's release.json again when a window comes forward after fifteen idle minutes (deployDrift.ts).
    const running = server
    app.on('browser-window-focus', () => running.masterRelease.focus())
  }
  registerAliaxPages(server)
  registerPty()
  const { store } = server
  registerWindows({ dropSnapshot: (slot) => store.dropWorkspaceSnapshot(slot) })
  registerDialogs()
  if (!headless) {
    registerMenu()
    registerDock()
  }
  if (!app.isPackaged) registerDebug()
  if (process.platform === 'darwin' && !headless) registerAppshots(server, createWindow)
  ipcMain.handle('server-port', () => server?.port ?? null)
  // The launch mirror (src/main/server/launchMirror.ts): the renderer paints
  // the rail from it before any socket is up, so the read is synchronous.
  ipcMain.on('launch-mirror:read', (e) => {
    const environments = listEnvironments(store).map((row) => ({
      id: row.id,
      name: row.name,
      routes: row.routes.map((r) => ({ url: r.url, kind: r.kind })),
      ...(row.keyId !== undefined ? { keyId: row.keyId } : {})
    }))
    const hosts = server!.launchMirror.read(['local', ...environments.map((row) => row.id)])
    e.returnValue = { environments, hosts } satisfies LaunchMirrorSnapshot
  })
  ipcMain.on('launch-mirror:write', (_e, write: MirrorWrite) => {
    try {
      server!.launchMirror.write(write)
    } catch (err) {
      console.error('[launch-mirror] write failed', err)
    }
  })
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
  // The user's editor (editorLaunch.ts): only where a window can be, so a
  // headless box answers null and the renderer hides the item.
  const editorLauncher = headless ? null : new EditorLauncher(defaultEditorLaunchDeps(server.store))
  ipcMain.handle('editor-config', () => editorLauncher?.config() ?? null)
  ipcMain.handle('editor-set', (_e, choice: unknown) => {
    editorLauncher?.setChoice(editorChoice(typeof choice === 'string' ? choice : null))
    editorLauncher?.refresh()
  })
  ipcMain.handle('editor-open', (_e, target: EditorTarget) => {
    if (!editorLauncher) throw new Error('No editor on this host')
    if (typeof target?.path !== 'string' || !target.path) throw new Error('A path is needed')
    return editorLauncher.open({
      path: target.path,
      line: typeof target.line === 'number' ? target.line : undefined,
      column: typeof target.column === 'number' ? target.column : undefined
    })
  })

  if (headless) {
    // No window: the local socket's port goes to a file for an operator on
    // the host (scripts/box/tc-local.mjs); the renderer would get it over IPC.
    const file = publishLocalPort(app.getPath('userData'), server.port)
    console.log(`[headless] serving on 127.0.0.1:${server.port} (${file}); remote port ${server.remote?.port ?? 'off'}`)
  } else {
    // Before the first window reads localStorage on the app scheme: the
    // file:// origin's entries move over once (originMigration.ts).
    await migrateLocalStorage({
      rendererDir: join(__dirname, '../renderer'),
      userData: app.getPath('userData')
    })
    openSavedWindows()
    userWindowsOpened = true
  }
  setTimeout(() => flushCompileCache(), FLUSH_AFTER_MS).unref()

  app.on('activate', function () {
    if (!headless) activateWindows()
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
  ipcMain.handle('debug:aliax-calls', () => aliaxCallCounts())
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
// window is the app. A headless host has no window to speak of: the only
// ones it ever opens are html preview's hidden ones, and their going is
// not a quit.
app.on('window-all-closed', () => {
  if (quitsOnAllClosed({ headless, userWindowsOpened })) {
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
  flushCompileCache()
  // A downloaded release installs on this quit (Squirrel does that on its
  // own); remember it so the next boot can tell whether it landed.
  noteInstallOnQuit()
  // Threads mid-turn are remembered before their harnesses go: the next
  // boot resumes them (server/resumeAfterBoot.ts).
  recordResumeAfterBoot()
  // The server outlives every window and dies only here, with the PTYs
  // and every helper process it started.
  // The shim marker goes back to Aliax first: the async close may not finish.
  releaseGateway()
  if (headless) unpublishLocalPort(app.getPath('userData'))
  killAllPtys()
  void server?.close()
  killTrackedChildren()
})

/** The threads mid-turn right now, written for the next boot to resume
 *  (sessions.ts recordForResume). Synchronous: both callers exit at once.
 *  Never throws — a failed record must not keep the process from quitting. */
function recordResumeAfterBoot(): void {
  try {
    const ids = server?.registry.recordForResume() ?? []
    if (ids.length) console.log(`[resume] ${ids.length} thread(s) mid-turn recorded for the next boot`)
  } catch (error) {
    console.error('[resume] could not record threads mid-turn:', error)
  }
}

// Nothing of ours outlives the main process: a signal or a plain exit
// takes the helpers (git, gh, language servers) with it. Children stay in
// our process group, so a group kill from outside gets them as well.
process.on('exit', () => {
  releaseGateway()
  killTrackedChildren()
})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    recordResumeAfterBoot()
    releaseGateway()
    killAllPtys()
    killTrackedChildren()
    process.exit(0)
  })
}
