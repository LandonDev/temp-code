import { app, net } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { configure, isLive, readMarker, type Role } from 'aliax-core'

/** Aliax's own userData: the vault, settings and usage cache both apps share. */
export const ALIAX_DATA_DIR = join(app.getPath('appData'), 'aliax')

export const aliaxInstalled = (): boolean => existsSync(join(ALIAX_DATA_DIR, 'profiles.json'))

/** Owner only while this very process holds the gateway marker. */
export function gatewayRole(): Role {
  const m = readMarker()
  return isLive(m) && m.owner === 'temp-code' && m.pid === process.pid ? 'owner' : 'standby'
}

/**
 * Point aliax-core at Aliax's data. Secrets open with the same Keychain item
 * Electron's safeStorage made for Aliax, so the first read prompts once for
 * "aliax Safe Storage"; a denied prompt leaves the vault locked, never broken.
 */
export function configureAliax(): void {
  configure({
    dataDir: ALIAX_DATA_DIR,
    fetch: (input, init) => net.fetch(input, init),
    secrets: { mode: 'chromiumKey', keychainItem: 'aliax Safe Storage' },
    appName: 'temp-code',
    role: gatewayRole
  })
}
