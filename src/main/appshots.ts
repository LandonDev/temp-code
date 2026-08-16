import { app, ipcMain, BrowserWindow } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nanoid } from 'nanoid'
import type { Attachment } from '@shared/events'
import type { RunningServer } from './server'

const exec = promisify(execFile)

/**
 * Appshots (M10): a Swift helper (resources/native/appshot-helper) watches
 * for a bare double-⌘ tap anywhere on macOS. On the tap we shoot the
 * frontmost window of whatever app the user is in — screenshot + its
 * accessibility text — and hand the result to the renderer as one appshot
 * attachment. The helper runs as our child, so TCC prompts and grants
 * attribute to this app.
 */

const HELPER = join(__dirname, '../../resources/native/appshot-helper')
const ATTACH_DIR = join(homedir(), '.temp-code', 'attachments')
const CAPTURE_TIMEOUT_MS = 20_000

interface CaptureResult {
  appName: string
  windowTitle: string
  text: string
  thin: boolean
  error?: string
}

export interface AppshotPermissions {
  available: boolean
  screen: boolean
  ax: boolean
}

let monitor: ChildProcess | null = null
let backoffMs = 1_000
let capturing = false
let promptedThisBoot = false
/** Appshots that fired before any renderer was listening (fresh window). */
const queue: Attachment[] = []
const ready = new Set<number>()

function available(): boolean {
  return process.platform === 'darwin' && existsSync(HELPER)
}

/** Armed in prod always; in dev only when TEMP_CODE_APPSHOTS=1, so a dev
 *  instance never double-fires next to the installed app. */
function armed(): boolean {
  return available() && (app.isPackaged || process.env.TEMP_CODE_APPSHOTS === '1')
}

async function permissions(prompt: boolean): Promise<AppshotPermissions> {
  if (!available()) return { available: false, screen: false, ax: false }
  try {
    const { stdout } = await exec(HELPER, prompt ? ['permissions', '--prompt'] : ['permissions'])
    const parsed = JSON.parse(stdout)
    return { available: true, screen: !!parsed.screen, ax: !!parsed.ax }
  } catch {
    return { available: false, screen: false, ax: false }
  }
}

/** Every temp-code window must be excluded from the pick — the installed
 *  app's and any dev instance's — so a capture over us shoots the window
 *  behind. pgrep over-matches (agent shells in the repo); harmless, they
 *  own no windows. */
async function excludePids(): Promise<string> {
  const pids = new Set<number>([process.pid])
  for (const args of [
    ['-x', 'TempCode'],
    ['-f', 'temp-code']
  ]) {
    try {
      const { stdout } = await exec('pgrep', args)
      for (const line of stdout.split('\n')) {
        const pid = Number(line.trim())
        if (pid) pids.add(pid)
      }
    } catch {
      // pgrep exits 1 on no match
    }
  }
  return [...pids].join(',')
}

function sendToRenderer(channel: string, payload: unknown): void {
  const wins = BrowserWindow.getAllWindows()
  const listening = wins.filter((w) => ready.has(w.webContents.id))
  if (channel === 'appshot' && listening.length === 0) {
    queue.push(payload as Attachment)
  } else {
    for (const w of listening) w.webContents.send(channel, payload)
  }
}

async function capture(createWindow: () => void): Promise<void> {
  mkdirSync(ATTACH_DIR, { recursive: true })
  const base = join(ATTACH_DIR, `${nanoid(8)}-appshot`)
  const png = `${base}.png`
  let result: CaptureResult
  try {
    const { stdout } = await exec(
      HELPER,
      ['capture', '--exclude-pids', await excludePids(), '--out', png],
      { timeout: CAPTURE_TIMEOUT_MS }
    )
    result = JSON.parse(stdout)
  } catch (err) {
    // The helper's one-line JSON error ends up in stdout even on exit 1.
    const stdout = (err as { stdout?: string }).stdout ?? ''
    let code = 'capture-failed'
    try {
      code = JSON.parse(stdout).error ?? code
    } catch {
      /* not JSON — keep generic */
    }
    if (code === 'screen-permission' && !promptedThisBoot) {
      promptedThisBoot = true
      void permissions(true)
    }
    sendToRenderer('appshot-error', { code })
    return
  }
  let textPath: string | undefined
  if (!result.thin && result.text) {
    textPath = `${base}.md`
    await writeFile(textPath, result.text)
  }
  const attachment: Attachment = {
    kind: 'appshot',
    path: png,
    name: result.windowTitle ? `${result.appName} — ${result.windowTitle}` : result.appName,
    mime: 'image/png',
    textPath
  }
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  sendToRenderer('appshot', attachment)
  const win = BrowserWindow.getAllWindows()[0]
  if (win?.isMinimized()) win.restore()
  win?.show()
  app.focus({ steal: true })
}

function startMonitor(server: RunningServer, createWindow: () => void): void {
  const child = spawn(HELPER, ['monitor'], { stdio: ['ignore', 'pipe', 'ignore'] })
  monitor = child
  let buf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let event: { event?: string } = {}
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.event === 'ready') backoffMs = 1_000
      if (event.event !== 'hotkey') continue
      if (!server.registry.getAppshotSettings().enabled || capturing) continue
      capturing = true
      void capture(createWindow).finally(() => {
        capturing = false
      })
    }
  })
  child.on('exit', () => {
    if (monitor !== child) return // superseded or shut down
    monitor = null
    const wait = backoffMs
    backoffMs = Math.min(backoffMs * 2, 30_000)
    setTimeout(() => {
      if (monitor === null && !child.killed) return startMonitor(server, createWindow)
    }, wait).unref()
  })
}

export function registerAppshots(server: RunningServer, createWindow: () => void): void {
  ipcMain.handle('appshot-permissions', (_e, prompt?: boolean) => permissions(!!prompt))
  // The renderer announces its listeners are mounted; queued captures flush.
  ipcMain.on('appshot-ready', (e) => {
    ready.add(e.sender.id)
    e.sender.once('destroyed', () => ready.delete(e.sender.id))
    while (queue.length > 0) e.sender.send('appshot', queue.shift())
  })
  if (!armed()) return
  startMonitor(server, createWindow)
  app.on('will-quit', () => {
    const child = monitor
    monitor = null // stops the restart loop
    child?.kill()
  })
  // The monitor is deaf until Accessibility is granted — nothing can prompt
  // from a hotkey that never arrives. First boot with the feature on asks.
  void permissions(false).then((p) => {
    if (!p.screen || !p.ax) {
      const settings = server.registry.getAppshotSettings()
      if (settings.enabled && !server.registry.getAppshotPrompted()) {
        server.registry.markAppshotPrompted()
        void permissions(true)
      }
    }
  })
}
