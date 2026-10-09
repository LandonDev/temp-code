import { app, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import release from '../../release.json'
import { targetWindow } from './windows'

const { autoUpdater } = electronUpdater

/**
 * Self-update through electron-updater's GitHub provider, the way Aliax
 * does it: the installed app polls the public temp-code repo's releases
 * (latest-mac.yml beside the signed, notarized zip), downloads only when the
 * user asks, and restarts into the new build on request. Every green commit
 * still tags `release-N` locally and bumps package.json to 1.0.N; only
 * `bun run release:publish` turns one of those into a GitHub release the
 * installed app can see. Dev instances report but never apply.
 */

const CHECK_EVERY_MS = 30 * 60 * 1000
const FOCUS_RECHECK_MS = 15 * 60 * 1000

export interface UpdateStatus {
  /** The version this build is running (package.json, 1.0.N). */
  current: string
  /** The feed's newest version, once checked and newer than `current`. */
  latest: string | null
  /** The release notes for `latest`, as plain text. */
  notes: string
  /** Dev-mode instances show state but can't apply. */
  canApply: boolean
  /** True once a check has completed; idle with no `latest` then means current. */
  checked: boolean
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  /** While downloading: whole percent. */
  percent?: number
  error?: string
}

let status: UpdateStatus = {
  current: app.getVersion(),
  latest: null,
  notes: '',
  canApply: app.isPackaged,
  checked: false,
  phase: 'idle'
}

/** Release notes arrive as the GitHub feed's HTML; the UI shows text. */
export function notesToText(notes: unknown): string {
  if (typeof notes !== 'string') {
    return Array.isArray(notes)
      ? notes.map((n) => notesToText((n as { note?: unknown }).note)).filter(Boolean).join('\n')
      : ''
  }
  return notes
    .replace(/<li>/gi, '- ')
    .replace(/<\/(p|li|ul|ol|h\d|div|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The notice goes to the window in front, as the donor scoped it; other
 *  windows read the same status when they ask. */
function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  targetWindow()?.webContents.send('update-status', status)
}

let lastCheck = 0
let checking: Promise<UpdateStatus> | null = null

async function check(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  if (status.phase === 'downloading' || status.phase === 'ready') return status
  if (checking) return checking
  lastCheck = Date.now()
  setStatus({ phase: 'checking', error: undefined })
  checking = autoUpdater
    .checkForUpdates()
    .then((result) => {
      // `update-available` already filled in latest/notes; a result with no
      // newer version means the feed answered and we are current.
      if (status.phase === 'checking') {
        setStatus({ phase: 'idle', checked: true, latest: result?.isUpdateAvailable ? status.latest : null })
      }
      return status
    })
    .catch((err: Error) => {
      setStatus({ phase: 'error', error: err.message })
      return status
    })
    .finally(() => {
      checking = null
    })
  return checking
}

/**
 * One button walks available → downloading → restart. Download starts only
 * when the user asks — an unrequested background download would fight the
 * agents for bandwidth for an update the user may not want yet.
 */
function apply(): UpdateStatus {
  if (!app.isPackaged) return status
  if (status.phase === 'ready') {
    // Restart into the downloaded build. before-quit cleanup runs as usual.
    setImmediate(() => autoUpdater.quitAndInstall())
    return status
  }
  if (status.phase === 'idle' && status.latest) {
    setStatus({ phase: 'downloading', percent: 0, error: undefined })
    autoUpdater.downloadUpdate().catch((err: Error) => setStatus({ phase: 'error', error: err.message }))
  }
  return status
}

export function registerUpdates(): void {
  if (app.isPackaged) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', (info) =>
      setStatus({ latest: info.version, notes: notesToText(info.releaseNotes) })
    )
    autoUpdater.on('update-not-available', () => setStatus({ latest: null, notes: '' }))
    autoUpdater.on('download-progress', (p) => setStatus({ phase: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => setStatus({ phase: 'ready', latest: info.version, percent: 100 }))
    autoUpdater.on('error', (err) => {
      // A failed background check is not worth a banner; only surface errors
      // after the user has asked for the update.
      if (status.phase === 'downloading') setStatus({ phase: 'error', error: err.message })
    })
    // Also look whenever a window comes forward: on the interval alone a
    // release published minutes after startup stayed invisible for half an
    // hour, exactly when someone went looking for it.
    app.on('browser-window-focus', () => {
      if (Date.now() - lastCheck > FOCUS_RECHECK_MS) void check()
    })
    setTimeout(() => void check(), 5_000)
    setInterval(() => void check(), CHECK_EVERY_MS)
  }
  ipcMain.handle('update-get', () => status)
  ipcMain.handle('update-check', () => check())
  ipcMain.handle('update-apply', () => apply())
  ipcMain.handle('update-bundled-release', () => release)
}
