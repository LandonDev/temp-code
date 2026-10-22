import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The gateway's public face: what the drivers, the server and the main
 * process import. The pieces live beside it:
 *   gatewayHost.ts     the gateway the app holds (marker, TLS, mirrors, the
 *                      utility process or the in-process fallback)
 *   gatewayCore.ts     the byte path, wherever it runs, and the ControlPlane it asks
 *   gatewayControl.ts  InProcessControl: aliax-core's own reads and the server's hooks
 *   gatewayChild.ts    the utility process's side (PortControl), gatewayWire.ts the protocol
 * `Gateway` is the host: in this process unless given a child to spawn.
 */
export {
  GatewayHost as Gateway,
  gateway,
  releaseGateway,
  startGateway,
  type GatewayChildLink,
  type GatewayOptions,
  type GatewayStatus,
  type SpawnGatewayChild
} from './gatewayHost'
export { HeldResponse, rebindWarmPath, rescope, scopedCodexPath, type ControlPlane, type RoutingHooks, type ScopedRequest } from './gatewayCore'
export { InProcessControl } from './gatewayControl'

/** Electron's appData for a platform, without importing electron (tests and scripts load this module). */
export function appDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  if (platform === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming')
  return env.XDG_CONFIG_HOME || join(home, '.config')
}

/** Where the installed app's userData lived before the product rename, and where `dev:prod` still runs. */
const prodUserData = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string =>
  join(appDataDir(platform, env), 'temp-code')

/**
 * Rule 2: only the app the user lives in may take the shim. The packaged app
 * and `dev:prod` always claim; a dev instance on its own userData claims only
 * with TEMP_CODE_CLAIM_SHIM=1, so a test run never hijacks live routing.
 */
export function mayClaimShim({
  isPackaged,
  env = process.env,
  platform = process.platform
}: {
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): boolean {
  const userData = env.TEMP_CODE_USER_DATA
  if (!userData) return isPackaged
  if (resolve(userData) === prodUserData(platform, env)) return true
  return env.TEMP_CODE_CLAIM_SHIM === '1'
}
