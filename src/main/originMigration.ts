import { BrowserWindow } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_HOST, APP_SCHEME } from './appScheme'
import { bootMark } from './server/boot'

/**
 * One-time move of the renderer's localStorage from the `file://` origin to
 * `tempcode-app://renderer` (appScheme.ts). Only a page on an origin can read
 * or write its storage and main has no API for it, so two hidden windows do
 * it: one on a blank file:// page under out/renderer reads every entry, one
 * on the app scheme writes the keys the new origin does not have yet. A
 * marker in userData means it ran (also when there was nothing to copy, and
 * after a failure): one attempt, never one per boot.
 */
export const MIGRATION_MARKER = 'localstorage-migrated'

export function migrationMarker(userData: string): string {
  return join(userData, MIGRATION_MARKER)
}

export function readScript(): string {
  return 'JSON.stringify(Object.entries(localStorage))'
}

/** Sets only keys absent on the new origin; answers how many it set. */
export function writeScript(entries: Array<[string, string]>): string {
  return `(() => {
  const entries = ${JSON.stringify(entries)};
  let n = 0;
  for (const [k, v] of entries) {
    if (localStorage.getItem(k) === null) { localStorage.setItem(k, v); n++; }
  }
  return n;
})()`
}

async function runIn<T>(url: string, script: string): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadURL(url)
    return (await win.webContents.executeJavaScript(script, true)) as T
  } finally {
    win.destroy()
  }
}

export async function migrateLocalStorage(opts: {
  rendererDir: string
  userData: string
}): Promise<void> {
  const marker = migrationMarker(opts.userData)
  if (existsSync(marker)) return
  try {
    const raw = await runIn<string>(
      pathToFileURL(join(opts.rendererDir, 'migrate.html')).toString(),
      readScript()
    )
    const entries = JSON.parse(raw) as Array<[string, string]>
    let written = 0
    if (entries.length > 0) {
      written = await runIn<number>(
        `${APP_SCHEME}://${APP_HOST}/migrate.html`,
        writeScript(entries)
      )
    }
    bootMark('localstorage-migrated', `${entries.length} keys (${written} written)`)
  } catch (e) {
    console.error('[boot] localstorage migration failed:', (e as Error).message)
  }
  try {
    writeFileSync(marker, `${new Date().toISOString()}\n`)
  } catch {
    // unwritable userData: the app has bigger problems than a repeat copy
  }
}
