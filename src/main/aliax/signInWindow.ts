import { BrowserWindow, screen, type Rectangle, type WebPreferences } from 'electron'
import { NO_ANSWER, UNREACHABLE } from '@shared/signInWords'

/**
 * The "Sign in to Claude" window, one factory for adding an account and for
 * a one-year token that needs a sign-in. Nothing of ours is drawn inside it:
 * it appears only once claude.ai has painted, sits centred over the app
 * window it was opened from and above it, and a page that never loads
 * becomes one line for the app's sign-in dialog instead of a blank window.
 */
export const SIGN_IN_WINDOW = {
  title: 'Sign in to Claude',
  width: 520,
  height: 760,
  autoHideMenuBar: true,
  minimizable: false,
  fullscreenable: false
} as const

/** A dead network, not a slow sign-in: the count stops at the first paint. */
export const FIRST_PAINT_TIMEOUT_MS = 30_000


/** Chromium's ERR_ABORTED: a navigation replaced by the next hop. */
const ERR_ABORTED = -3

/** The line a main-frame load failure becomes; null keeps waiting. */
export function failureLine(errorCode: number): string | null {
  return errorCode === ERR_ABORTED ? null : UNREACHABLE
}

type Rect = { x: number; y: number; width: number; height: number }

/** Centred on the parent (the work area without one), kept inside the work area. */
export function placeOver(
  parent: Rect | null,
  size: { width: number; height: number },
  workArea: Rect
): { x: number; y: number } {
  const around = parent ?? workArea
  const clamp = (v: number, lo: number, span: number): number => Math.round(Math.max(lo, Math.min(v, lo + span)))
  return {
    x: clamp(around.x + (around.width - size.width) / 2, workArea.x, Math.max(0, workArea.width - size.width)),
    y: clamp(around.y + (around.height - size.height) / 2, workArea.y, Math.max(0, workArea.height - size.height))
  }
}

/** The app window a sign-in opens over; index.ts sets it to windows.ts's targetWindow. */
let parentWindow: () => BrowserWindow | null = () => BrowserWindow.getFocusedWindow()

export function setSignInParent(find: () => BrowserWindow | null): void {
  parentWindow = find
}

export interface SignInWindow {
  win: BrowserWindow
  /** Settles with a line on the first main-frame failure, or with no first paint in time. */
  failed: Promise<string>
}

/** A visible sign-in window, shown on its first paint. Load the URL yourself. */
export function openSignInWindow(input: { partition: string; webPreferences?: WebPreferences }): SignInWindow {
  const found = parentWindow()
  const parent = found && !found.isDestroyed() ? found : null
  const parentBounds: Rectangle | null = parent ? parent.getBounds() : null
  const workArea = (parentBounds ? screen.getDisplayMatching(parentBounds) : screen.getPrimaryDisplay()).workArea
  const win = new BrowserWindow({
    ...SIGN_IN_WINDOW,
    ...placeOver(parentBounds, SIGN_IN_WINDOW, workArea),
    show: false,
    ...(parent ? { parent } : {}),
    webPreferences: { partition: input.partition, nodeIntegration: false, contextIsolation: true, ...input.webPreferences }
  })
  const failed = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(NO_ANSWER), FIRST_PAINT_TIMEOUT_MS)
    win.once('ready-to-show', () => {
      clearTimeout(timer)
      if (!win.isDestroyed()) win.show()
    })
    win.once('closed', () => clearTimeout(timer))
    win.webContents.on('did-fail-load', (_e, code: number, description: string, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return
      const line = failureLine(code)
      if (!line) return
      console.log(`[sign-in] ${url} failed to load: ${code} ${description}`)
      clearTimeout(timer)
      resolve(line)
    })
  })
  return { win, failed }
}
