import { app, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import release from '../../release.json'
import {
  bundleIdentifier,
  bundleShortVersion,
  compareVersions,
  judgeAttempt,
  parseAttempt,
  serializeAttempt,
  stagedBundlePath,
  stalePaths,
  updaterCacheDirName,
  type InstallFailure
} from './updateInstall'
import { armQuit, cancelQuit, confirmQuit, hasQuitSubscriber, requestQuit, targetWindow } from './windows'

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
  /** A release this app handed to Squirrel's installer that did not land:
   *  found at boot, shown until the user retries (updateInstall.ts). */
  installFailure?: InstallFailure
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
 * Restart into the downloaded release, down the same path as Cmd-Q: the
 * window in front asks about busy sessions once and persists its layout,
 * and its `app:confirm-quit` then ends in quitAndInstall instead of
 * app.quit(). With no renderer to ask, the quit confirms itself. Either way
 * the gate is open before Electron starts closing windows, so the close
 * handler lets them go and before-quit runs its cleanup once; a declined
 * dialog disarms and leaves the release waiting. quitAndInstall used to be
 * called cold here, and the close handler asked the renderer, which hid
 * the window on a busy session and left Squirrel waiting forever.
 */
function restartToInstall(): void {
  if (status.latest) recordAttempt(status.latest)
  armQuit(
    () => autoUpdater.quitAndInstall(),
    () => forgetAttempt()
  )
  if (hasQuitSubscriber()) requestQuit()
  else void confirmQuit(-1)
}

function startDownload(): UpdateStatus {
  setStatus({ phase: 'downloading', percent: 0, error: undefined, installFailure: undefined })
  autoUpdater.downloadUpdate().catch((err: Error) => setStatus({ phase: 'error', error: err.message }))
  return status
}

/**
 * One button walks available → downloading → restart. Download starts only
 * when the user asks — an unrequested background download would fight the
 * agents for bandwidth for an update the user may not want yet. After a
 * failed install the same button retries from nothing: the rejected download
 * and Squirrel's staged copy are removed first and the zip is fetched whole,
 * not assembled from the differential base.
 */
async function apply(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  if (status.phase === 'ready') {
    restartToInstall()
    return status
  }
  if (status.installFailure || (status.phase === 'error' && status.latest)) {
    clearStaleUpdate()
    autoUpdater.disableDifferentialDownload = true
    setStatus({ installFailure: undefined, error: undefined })
    // downloadUpdate needs a check from this process behind it.
    if (!status.checked || !status.latest) await check()
    return status.latest ? startDownload() : status
  }
  if (status.phase === 'idle' && status.latest) return startDownload()
  return status
}

// ── Installs that did not land ───────────────────────────────────────────────
// ShipIt runs after the app has quit; no event of ours sees it fail. The app
// writes what it handed over, and the next boot reads Squirrel's log.

const attemptFile = (): string => join(app.getPath('userData'), 'update-attempt.json')

function recordAttempt(version: string): void {
  try {
    writeFileSync(attemptFile(), serializeAttempt(version, Date.now()))
  } catch {
    /* a missing record only costs the failure notice */
  }
}

function forgetAttempt(): void {
  try {
    unlinkSync(attemptFile())
  } catch {
    /* none */
  }
}

/** before-quit: a downloaded release installs on this quit, with or without a relaunch. */
export function noteInstallOnQuit(): void {
  if (app.isPackaged && status.phase === 'ready' && status.latest) recordAttempt(status.latest)
}

const cachesDir = (): string => join(homedir(), 'Library', 'Caches')

/** Our CFBundleIdentifier, from the bundle's Info.plist (electron-builder.yml appId). */
function bundleId(): string {
  try {
    return bundleIdentifier(readFileSync(join(dirname(process.execPath), '..', 'Info.plist'), 'utf8')) ?? 'dev.landon.tempcode'
  } catch {
    return 'dev.landon.tempcode'
  }
}

/** electron-updater's cache directory name: app-update.yml's, or the harness one. */
function cacheDirName(): string {
  if (process.env.TEMP_CODE_UPDATE_FEED && process.env.TEMP_CODE_USER_DATA) return HARNESS_CACHE_DIR_NAME
  try {
    return updaterCacheDirName(readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')) ?? 'temp-code-updater'
  } catch {
    return 'temp-code-updater'
  }
}

const shipItDir = (): string => join(cachesDir(), `${bundleId()}.ShipIt`)

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** The bundle ShipItState.plist still points at, if any: its version and
 *  when Squirrel last wrote the state (the hand-over time). */
function stagedUpdate(): { version: string; at: number } | null {
  const state = join(shipItDir(), 'ShipItState.plist')
  if (!existsSync(state)) return null
  try {
    const xml = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', state], { encoding: 'utf8' })
    const bundle = stagedBundlePath(xml)
    const version = bundle ? bundleShortVersion(readText(join(bundle, 'Contents', 'Info.plist'))) : null
    return version ? { version, at: statSync(state).mtimeMs } : null
  } catch {
    return null
  }
}

/**
 * At boot: did the last hand-over install? The record wins; without one
 * (an older build wrote none) a staged bundle newer than us in Squirrel's
 * state means the same thing. A staged bundle no newer than us is left
 * over from an install that happened and is removed.
 */
function detectFailedInstall(): InstallFailure | null {
  const current = app.getVersion()
  const log = readText(join(shipItDir(), 'ShipIt_stderr.log'))
  const attempt = parseAttempt(readText(attemptFile()) || null)
  if (attempt) {
    const failure = judgeAttempt(attempt, current, log)
    if (!failure) forgetAttempt()
    return failure
  }
  const staged = stagedUpdate()
  if (!staged) return null
  if (compareVersions(staged.version, current) > 0) return judgeAttempt(staged, current, log)
  clearStaleUpdate(false)
  return null
}

/**
 * Remove Squirrel's hand-over (and, for a retry, the rejected download) so
 * the next attempt starts clean. The launchd job goes first: a ShipIt from
 * the last hand-over may still be alive, waiting for this very app to quit,
 * and launchd would respawn it every two seconds once its state file is gone
 * ("Could not read update request"); removing the job ends both. Squirrel
 * submits a fresh job at the next hand-over.
 */
function clearStaleUpdate(download = true): void {
  const shipIt = shipItDir()
  try {
    execFileSync('launchctl', ['remove', `${bundleId()}.ShipIt`], { stdio: 'ignore' })
  } catch {
    /* no job */
  }
  let entries: string[] = []
  try {
    entries = readdirSync(shipIt)
  } catch {
    /* no Squirrel state */
  }
  for (const path of stalePaths(cachesDir(), cacheDirName(), bundleId(), entries, download)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* best effort; the download overwrites what it can */
    }
  }
}

/**
 * Test feed. An isolated packaged copy (TEMP_CODE_USER_DATA set, see
 * scripts/e2e-updater.ts) reads TEMP_CODE_UPDATE_FEED, a generic-provider URL
 * serving latest-mac.yml and the zip. electron-updater takes the provider and
 * its cache directory name from one yml, so the override writes its own under
 * userData and points `updateConfigPath` there: the copy's downloads land in
 * `~/Library/Caches/temp-code-harness-updater`, never in the installed app's
 * `temp-code-updater` cache. Refused without an isolated userData: a feed
 * override on the real instance would be a way to install anything.
 */
export const HARNESS_CACHE_DIR_NAME = 'temp-code-harness-updater'

export function harnessFeedConfig(feed: string): string {
  return `provider: generic\nurl: ${feed}\nupdaterCacheDirName: ${HARNESS_CACHE_DIR_NAME}\n`
}

function applyFeedOverride(): void {
  const feed = process.env.TEMP_CODE_UPDATE_FEED
  if (!feed || !process.env.TEMP_CODE_USER_DATA) return
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'app-update.yml')
  writeFileSync(file, harnessFeedConfig(feed))
  autoUpdater.updateConfigPath = file
}

export function registerUpdates(): void {
  if (app.isPackaged) {
    applyFeedOverride()
    const failure = detectFailedInstall()
    if (failure) status = { ...status, installFailure: failure, latest: failure.version }
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
      // after the user has asked for the update. In 'ready' the error comes
      // from Squirrel (its own fetch, or a restart it could not start): the
      // gate may already be open for a quit that is not going to happen.
      if (status.phase === 'downloading' || status.phase === 'ready') {
        cancelQuit()
        setStatus({ phase: 'error', error: err.message })
      }
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
