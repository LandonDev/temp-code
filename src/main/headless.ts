import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Headless: the main process as an agent host with no desktop. The server,
 * the gateway, the fixed-port listener and html preview's hidden window all
 * run as usual; the user window, the menu, the dock and the updater do not.
 * TEMP_CODE_HEADLESS=1 asks for it and 0 forbids it; a Linux process with
 * no display server gets it on its own, since no window could open there.
 */
export function isHeadless(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (env.TEMP_CODE_HEADLESS === '1') return true
  if (env.TEMP_CODE_HEADLESS === '0') return false
  return noDisplay(env, platform)
}

/** Linux with neither an X nor a Wayland display to attach to. */
export function noDisplay(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

/**
 * Whether the last window closing ends the app: never on macOS (the dock
 * keeps it), never headless (the only windows are html preview's hidden
 * ones), and never before the first user window has opened: the origin
 * migration's hidden helper (originMigration.ts) closes before
 * openSavedWindows runs, and on Linux that once quit the app at boot.
 */
export function quitsOnAllClosed(
  opts: { headless: boolean; userWindowsOpened: boolean },
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'darwin' && !opts.headless && opts.userWindowsOpened
}

export const LOCAL_PORT_FILE = 'server.json'

/**
 * A headless host has no renderer to hand the local port to over IPC, so it
 * publishes the port here for an operator on the box (scripts/box/
 * tc-local.mjs). The file is private to the user: that socket is the
 * implicit admin, the same trust the renderer's socket has.
 */
export function publishLocalPort(userData: string, port: number): string {
  const path = join(userData, LOCAL_PORT_FILE)
  writeFileSync(path, `${JSON.stringify({ port, pid: process.pid })}\n`, { mode: 0o600 })
  return path
}

export function unpublishLocalPort(userData: string): void {
  try {
    unlinkSync(join(userData, LOCAL_PORT_FILE))
  } catch {
    /* never written */
  }
}
