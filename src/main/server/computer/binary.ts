import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isHeadless } from '../../headless'

/**
 * Where `tc-computer` lives and whether computer use may run on this host
 * (docs/computer-protocol.md "The host"). The Service shell's electron.vite
 * step builds it into resources/native, beside the appshot helper; the dev
 * tree's background build may still be running, so availability is asked
 * again at every spawn and every harness start.
 */

/** TEMP_CODE_COMPUTER_BIN, else resources/native/tc-computer next to out/main. */
export function computerBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEMP_CODE_COMPUTER_BIN || join(__dirname, '../../resources/native/tc-computer')
}

export interface AvailabilityProbe {
  platform?: NodeJS.Platform
  headless?: boolean
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

/** Why computer use is off on this host, or null when it may run. */
export function computerUnavailable(opts: AvailabilityProbe = {}): string | null {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  if (platform !== 'darwin') return 'computer use runs on a Mac'
  // A proof's isolated Mac instance runs headless and still serves computer use: tc-computer touches AppKit itself.
  const proofHeadless = env.TEMP_CODE_COMPUTER === '1' && !!env.TEMP_CODE_USER_DATA
  if ((opts.headless ?? isHeadless(env, platform)) && !proofHeadless) return 'this host runs without a screen'
  if (env.TEMP_CODE_COMPUTER === '0') return 'turned off'
  if (!(opts.exists ?? existsSync)(computerBinaryPath(env))) return 'tc-computer is not built'
  return null
}
