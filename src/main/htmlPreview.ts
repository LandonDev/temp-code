import { BrowserWindow, session } from 'electron'
import { ASSET_SCHEME } from '@shared/assets'
import {
  DEFAULT_TOKENS,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  type HtmlRenderAppearance
} from '@shared/htmlRender'
import { handleAssetRequest } from './assets'
import { holdPreviewPage } from './htmlPreviewPages'
import { allowRequest, PREVIEW_PAGE_PREFIX } from './htmlPreviewPolicy'
import type { ConsoleMessage, HtmlPreviewer, PreviewResult } from './server/htmlRender'

/**
 * The hidden window `html_preview` screenshots pages in and `html_render`
 * measures them with. One offscreen BrowserWindow on its own in-memory
 * partition, created on first use and dropped after a minute idle; one page
 * in it at a time. The page loads from the asset scheme's in-memory preview
 * map (never file: or data:), the partition's requests go through
 * htmlPreviewPolicy, permissions and popups are denied, and the main frame
 * is pinned to the page. What T3 does with a downloaded Chrome over CDP,
 * this does with the app's own engine, so measured heights match the
 * renderer exactly.
 */

const PARTITION = 'html-preview'
const VIEWPORT_HEIGHT = 800
const MAX_CAPTURE_HEIGHT = 4_000
const CAPTURE_TIMEOUT_MS = 20_000
const MEASURE_TIMEOUT_MS = 6_000
const IDLE_MS = 60_000
const MAX_WAITING = 4
const MAX_CONSOLE_MESSAGES = 20
const MAX_CONSOLE_TEXT_CHARS = 500
// Stack traces and load errors name the page this way instead of its URL.
const PAGE_NAME = 'page.html'

// Resolves after web fonts load and two frames paint, so late layout lands in the capture.
const SETTLE_EXPRESSION =
  'document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))'
// The root's scroll height never drops below the viewport, so a short page
// reports its own box height instead.
const MEASURE_EXPRESSION =
  '(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()'

// ── the window ───────────────────────────────────────────────────────

let win: BrowserWindow | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let sessionReady = false
let consoleSink: ((message: ConsoleMessage) => void) | null = null

function prepareSession(): void {
  if (sessionReady) return
  sessionReady = true
  const ses = session.fromPartition(PARTITION)
  // protocol.handle only covers the default session; this partition serves
  // the scheme itself, through the same handler.
  ses.protocol.handle(ASSET_SCHEME, handleAssetRequest)
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowRequest(details.url) })
  })
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
}

function window(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  prepareSession()
  win = new BrowserWindow({
    show: false,
    frame: false,
    width: 864,
    height: VIEWPORT_HEIGHT,
    webPreferences: {
      // What makes capturePage paint a window nobody shows.
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: PARTITION,
      backgroundThrottling: false
    }
  })
  const contents = win.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Only loadURL moves the main frame; a page cannot navigate itself away.
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('console-message', (event) => {
    // Electron's own dev-build CSP warning is not the page's output.
    if (!consoleSink || event.message.startsWith('%cElectron Security Warning')) return
    const level: ConsoleMessage['level'] =
      event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'log'
    const where =
      event.sourceId.startsWith(PREVIEW_PAGE_PREFIX) && event.lineNumber > 0
        ? ` (${PAGE_NAME}:${event.lineNumber})`
        : ''
    const text = event.message.replaceAll(/tempcode-asset:\/\/page\/preview\/[a-f0-9]+\.html/g, PAGE_NAME)
    consoleSink({ level, text: `${text}${where}` })
  })
  return win
}

function dropWindow(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(dropWindow, IDLE_MS)
}

// ── one page at a time ───────────────────────────────────────────────

let tail: Promise<unknown> = Promise.resolve()
let waiting = 0

function serial<T>(job: () => Promise<T>): Promise<T> {
  if (waiting >= MAX_WAITING) {
    return Promise.reject(new Error('The preview window is busy; try again in a moment.'))
  }
  waiting++
  const run = tail.then(job, job)
  tail = run.catch(() => undefined).finally(() => {
    waiting--
  })
  return run
}

async function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms)
  })
  try {
    return await Promise.race([work, expiry])
  } catch (err) {
    // A page that hangs its renderer would hang the next run too.
    dropWindow()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function cleanUp(): Promise<void> {
  if (!win || win.isDestroyed()) return
  try {
    await win.webContents.loadURL('about:blank')
    await session.fromPartition(PARTITION).clearStorageData()
  } catch {
    // a run that already dropped the window has nothing to clear
  }
}

const themeFragment = (appearance: HtmlRenderAppearance) =>
  htmlRenderThemeFragment(htmlRenderTheme(DEFAULT_TOKENS[appearance], appearance))

/** Loads the page at `width` and returns the settled content height. */
async function loadAt(url: string, width: number): Promise<number> {
  const w = window()
  w.setContentSize(width, VIEWPORT_HEIGHT)
  await w.webContents.loadURL(url)
  await w.webContents.executeJavaScript(SETTLE_EXPRESSION, true)
  const measured = await w.webContents.executeJavaScript(MEASURE_EXPRESSION, true)
  return Math.max(0, Math.ceil(Number(measured) || 0))
}

async function capture(width: number, height: number): Promise<string> {
  const w = window()
  w.setContentSize(width, height)
  await w.webContents.executeJavaScript(SETTLE_EXPRESSION, true)
  let image = await w.webContents.capturePage()
  const size = image.getSize()
  if (size.width !== width && size.width > 0) {
    image = image.resize({ width, height: Math.round((size.height * width) / size.width) })
  }
  return image.toPNG().toString('base64')
}

async function previewPage(input: {
  html: string
  width: number
  appearance: HtmlRenderAppearance
}): Promise<PreviewResult> {
  const messages: ConsoleMessage[] = []
  let omitted = 0
  consoleSink = (message) => {
    if (messages.length >= MAX_CONSOLE_MESSAGES) {
      omitted++
      return
    }
    messages.push({
      level: message.level,
      text:
        message.text.length > MAX_CONSOLE_TEXT_CHARS
          ? `${message.text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…`
          : message.text
    })
  }
  const page = holdPreviewPage(input.html)
  try {
    const url = `${page.url}${themeFragment(input.appearance)}`
    const contentHeight = await loadAt(url, input.width)
    const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT))
    const png = await capture(input.width, capturedHeight)
    const consoleMessages =
      omitted === 0
        ? messages
        : [
            ...messages,
            { level: 'warning' as const, text: `${omitted} more console messages were omitted.` }
          ]
    return { png, contentHeight, capturedHeight, consoleMessages }
  } finally {
    consoleSink = null
    page.release()
    await cleanUp()
    touch()
  }
}

/**
 * Content heights at each width, each from a fresh load, since pages often
 * lay themselves out from the width once at load.
 */
async function measurePage(
  html: string,
  widths: readonly number[]
): Promise<Array<readonly [number, number]>> {
  const page = holdPreviewPage(html)
  try {
    const url = `${page.url}${themeFragment('dark')}`
    const heights: Array<readonly [number, number]> = []
    for (const width of widths) heights.push([width, await loadAt(url, width)])
    return heights
  } finally {
    page.release()
    await cleanUp()
    touch()
  }
}

export const htmlPreviewer: HtmlPreviewer = {
  preview: (input) =>
    serial(() =>
      withTimeout(
        previewPage(input),
        CAPTURE_TIMEOUT_MS,
        `the page did not finish loading within ${CAPTURE_TIMEOUT_MS / 1000} seconds`
      )
    ),
  measure: (html, widths) =>
    serial(() =>
      withTimeout(
        measurePage(html, widths),
        MEASURE_TIMEOUT_MS,
        `measuring took longer than ${MEASURE_TIMEOUT_MS / 1000} seconds`
      )
    )
}
