import { join } from 'path'

/**
 * What the updater keeps across the restart that installs a release, and
 * how it reads Squirrel's side of the story afterwards. Pure: update.ts
 * does the file system work.
 *
 * ShipIt (Squirrel.Mac's installer) runs after the app has quit, so neither
 * electron-updater nor our 'error' handler ever sees it fail. The app writes
 * `update-attempt.json` ({version, at}) in userData when it hands over to
 * ShipIt; the next boot compares the attempted version with the one running
 * and, if the install did not happen, reads the tail of
 * `~/Library/Caches/<bundleId>.ShipIt/ShipIt_stderr.log` for the reason.
 */

export interface InstallAttempt {
  version: string
  /** Epoch ms when the app handed over to ShipIt. */
  at: number
}

export function serializeAttempt(version: string, at: number): string {
  return JSON.stringify({ version, at })
}

export function parseAttempt(text: string | null | undefined): InstallAttempt | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as { version?: unknown; at?: unknown }
    if (typeof raw.version !== 'string' || !raw.version.trim() || typeof raw.at !== 'number') return null
    return { version: raw.version.trim(), at: raw.at }
  } catch {
    return null
  }
}

/** Dotted integer versions (1.0.N): negative, zero or positive like a comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10) || 0)
  const pb = b.split('.').map((p) => parseInt(p, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** ShipIt prefixes every line with local time, `2026-10-10 02:17:40.324 ShipIt[pid] …`. */
const LINE_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) /

export function shipItLinesSince(log: string, since: number): string[] {
  const out: string[] = []
  for (const line of log.split('\n')) {
    const m = LINE_TIME.exec(line)
    if (!m) continue
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime()
    // A minute of slack: the record is written before ShipIt starts, but
    // clocks and log buffering are not exact.
    if (t >= since - 60_000) out.push(line)
  }
  return out
}

export const SIGNATURE_FAILED = 'The downloaded update failed its signature check.'
export const APP_STILL_RUNNING = 'The app was still running when the update tried to install.'
export const TOO_MANY_ATTEMPTS = 'The update was tried too many times.'
export const NEVER_INSTALLED = 'The update never installed.'
export const WAITING_FOR_QUIT = 'The update is waiting for the app to quit.'
export const DID_NOT_INSTALL = 'The update did not install.'

/**
 * One line for the user, from ShipIt's log lines since the hand-over. On a
 * first attempt ShipIt waits for every instance of the app to quit before it
 * begins (it logs only "Detected this as an install request" meanwhile), so
 * an app relaunched during that wait sees a hand-over with no outcome yet.
 */
export function describeInstallFailure(lines: string[]): string {
  const text = lines.join('\n')
  if (/did not pass validation|SQRLCodeSignatureErrorDomain/.test(text)) return SIGNATURE_FAILED
  if (/App Still Running/.test(text)) return APP_STILL_RUNNING
  if (/Too many attempts/.test(text)) return TOO_MANY_ATTEMPTS
  if (lines.length === 0) return NEVER_INSTALLED
  if (/Detected this as an install request/.test(text) && !/Beginning installation|Installation error|Installation cancelled|Installation completed/.test(text)) {
    return WAITING_FOR_QUIT
  }
  return DID_NOT_INSTALL
}

export interface InstallFailure {
  version: string
  reason: string
}

/** The attempt record against the running version: null when the install
 *  happened (or nothing was attempted), the failure otherwise. */
export function judgeAttempt(
  attempt: InstallAttempt | null,
  running: string,
  shipItLog: string
): InstallFailure | null {
  if (!attempt || compareVersions(attempt.version, running) <= 0) return null
  return { version: attempt.version, reason: describeInstallFailure(shipItLinesSince(shipItLog, attempt.at)) }
}

/** CFBundleIdentifier out of an XML Info.plist. */
export function bundleIdentifier(infoPlist: string): string | null {
  const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(infoPlist)
  return m ? m[1].trim() : null
}

/** CFBundleShortVersionString out of an XML Info.plist. */
export function bundleShortVersion(infoPlist: string): string | null {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(infoPlist)
  return m ? m[1].trim() : null
}

/** `updaterCacheDirName` out of electron-builder's app-update.yml. */
export function updaterCacheDirName(appUpdateYml: string): string | null {
  const m = /^updaterCacheDirName:\s*(.+?)\s*$/m.exec(appUpdateYml)
  return m ? m[1] : null
}

/** The staged bundle an XML ShipItState.plist points at, as a path. */
export function stagedBundlePath(shipItStateXml: string): string | null {
  const m = /<key>updateBundleURL<\/key>\s*<string>file:\/\/([^<]+)<\/string>/.exec(shipItStateXml)
  if (!m) return null
  return decodeURIComponent(m[1]).replace(/\/+$/, '')
}

/**
 * What a retry removes so the next download starts from nothing: Squirrel's
 * hand-over state and staged copies (`ShipItState.plist`, `update.*`) and,
 * with `download`, the electron-updater download (`pending/`) and its
 * differential base (`update.zip`). ShipIt's logs stay. A boot that finds a
 * staging older than itself clears only the Squirrel side: the download
 * cache is electron-updater's to manage and the base saves the next fetch.
 */
export function stalePaths(
  cachesDir: string,
  cacheDirName: string,
  bundleId: string,
  shipItEntries: string[],
  download: boolean
): string[] {
  const updater = join(cachesDir, cacheDirName)
  const shipIt = join(cachesDir, `${bundleId}.ShipIt`)
  return [
    ...(download ? [join(updater, 'pending'), join(updater, 'update.zip')] : []),
    join(shipIt, 'ShipItState.plist'),
    ...shipItEntries.filter((e) => e.startsWith('update.')).map((e) => join(shipIt, e))
  ]
}
