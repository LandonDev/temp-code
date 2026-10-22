import { describe, expect, it } from 'vitest'
import {
  APP_STILL_RUNNING,
  DID_NOT_INSTALL,
  NEVER_INSTALLED,
  SIGNATURE_FAILED,
  WAITING_FOR_QUIT,
  bundleIdentifier,
  bundleShortVersion,
  compareVersions,
  describeInstallFailure,
  feedFallback,
  judgeAttempt,
  parseAttempt,
  serializeAttempt,
  shipItLinesSince,
  stagedBundlePath,
  stalePaths,
  updaterCacheDirName,
  RELEASE_FEED
} from './updateInstall'

// The real log of the failed 1.0.205 install (2026-10-10), two attempts.
const LOG = [
  '2026-10-10 02:17:40.324 ShipIt[46546:5749534] Detected this as an install request',
  '2026-10-10 02:17:40.639 ShipIt[46546:5749540] Beginning installation',
  '2026-10-10 02:17:49.745 ShipIt[46546:5749540] Installation error: Error Domain=SQRLCodeSignatureErrorDomain Code=-1 "Code signature at URL file:///var/folders/T/dev.landon.tempcode.ShipIt.6MXTFbJu/TempCode.app did not pass validation" UserInfo={...}',
  '2026-10-10 02:17:49.745 ShipIt[46546:5749540] ShipIt quitting',
  '2026-10-10 22:05:01.726 ShipIt[34118:308621] Detected this as an install request',
  '2026-10-10 22:05:01.925 ShipIt[34118:308628] Resuming installation attempt 2',
  '2026-10-10 22:05:10.477 ShipIt[34118:308629] Aborting update attempt because there are 1 running instances of the target app',
  '2026-10-10 22:05:10.478 ShipIt[34118:309611] Installation cancelled: Error Domain=SQRLInstallerErrorDomain Code=-9 "App Still Running Error" UserInfo={...}',
  '2026-10-10 22:05:10.478 ShipIt[34118:309611] ShipIt quitting'
].join('\n')

const at = (h: number, m: number): number => new Date(2026, 9, 10, h, m, 0).getTime()

describe('install attempt record', () => {
  it('round-trips and rejects junk', () => {
    expect(parseAttempt(serializeAttempt('1.0.205', 123))).toEqual({ version: '1.0.205', at: 123 })
    expect(parseAttempt(null)).toBeNull()
    expect(parseAttempt('nope')).toBeNull()
    expect(parseAttempt('{"version":"","at":1}')).toBeNull()
    expect(parseAttempt('{"version":"1.0.1"}')).toBeNull()
  })

  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.0.205', '1.0.200')).toBe(1)
    expect(compareVersions('1.0.99', '1.0.100')).toBe(-1)
    expect(compareVersions('1.0.205', '1.0.205')).toBe(0)
    expect(compareVersions('1.0.205', '1.0.205.1')).toBe(-1)
  })
})

describe('ShipIt log reading', () => {
  it('keeps the lines written since the hand-over, with a minute of slack', () => {
    expect(shipItLinesSince(LOG, at(22, 4)).length).toBe(5)
    expect(shipItLinesSince(LOG, at(22, 5))).toHaveLength(5)
    expect(shipItLinesSince(LOG, at(2, 17))).toHaveLength(9)
    expect(shipItLinesSince(LOG, at(23, 0))).toEqual([])
    expect(shipItLinesSince('garbage\nno timestamp', 0)).toEqual([])
  })

  it('names the failure in one line', () => {
    expect(describeInstallFailure(shipItLinesSince(LOG, at(2, 17)))).toBe(SIGNATURE_FAILED)
    expect(describeInstallFailure(shipItLinesSince(LOG, at(22, 4)))).toBe(APP_STILL_RUNNING)
    expect(describeInstallFailure([])).toBe(NEVER_INSTALLED)
    // ShipIt launched and is waiting for every instance to quit (first attempt).
    expect(describeInstallFailure(['2026-10-10 23:06:13.433 ShipIt[88575:659500] Detected this as an install request'])).toBe(WAITING_FOR_QUIT)
    expect(
      describeInstallFailure([
        '2026-10-10 23:06:13.433 ShipIt[88575:659500] Detected this as an install request',
        '2026-10-10 23:08:18.521 ShipIt[88575:659503] Beginning installation'
      ])
    ).toBe(DID_NOT_INSTALL)
    expect(describeInstallFailure(['2026-10-10 22:05:01.726 ShipIt[1:1] Installation error: something else'])).toBe(DID_NOT_INSTALL)
  })

  it('judges the attempt against the running version', () => {
    expect(judgeAttempt({ version: '1.0.205', at: at(2, 17) }, '1.0.200', LOG)).toEqual({
      version: '1.0.205',
      reason: SIGNATURE_FAILED
    })
    expect(judgeAttempt({ version: '1.0.205', at: at(22, 4) }, '1.0.200', LOG)).toEqual({
      version: '1.0.205',
      reason: APP_STILL_RUNNING
    })
    // The install happened: nothing to report.
    expect(judgeAttempt({ version: '1.0.205', at: at(2, 17) }, '1.0.205', LOG)).toBeNull()
    expect(judgeAttempt({ version: '1.0.205', at: at(2, 17) }, '1.0.206', LOG)).toBeNull()
    expect(judgeAttempt(null, '1.0.200', LOG)).toBeNull()
    // The app quit but ShipIt never wrote a line: it never ran.
    expect(judgeAttempt({ version: '1.0.207', at: at(23, 30) }, '1.0.200', LOG)).toEqual({
      version: '1.0.207',
      reason: NEVER_INSTALLED
    })
  })
})

describe('bundle metadata', () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
    <key>CFBundleIdentifier</key>
    <string>dev.landon.tempcode</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.205</string>
</dict></plist>`
  it('reads the identifier and version out of Info.plist', () => {
    expect(bundleIdentifier(plist)).toBe('dev.landon.tempcode')
    expect(bundleShortVersion(plist)).toBe('1.0.205')
    expect(bundleIdentifier('<plist/>')).toBeNull()
  })

  it('reads the cache dir name out of app-update.yml', () => {
    expect(updaterCacheDirName('owner: LandonDev\nrepo: temp-code\nprovider: github\nupdaterCacheDirName: temp-code-updater\n')).toBe(
      'temp-code-updater'
    )
    expect(updaterCacheDirName('provider: generic\n')).toBeNull()
  })

  it('reads the staged bundle out of ShipItState.plist', () => {
    const xml = `<dict><key>updateBundleURL</key>
<string>file:///Users/landon/Library/Caches/dev.landon.tempcode.ShipIt/update.mchjM6S/TempCode.app/</string></dict>`
    expect(stagedBundlePath(xml)).toBe('/Users/landon/Library/Caches/dev.landon.tempcode.ShipIt/update.mchjM6S/TempCode.app')
    expect(stagedBundlePath('<dict/>')).toBeNull()
  })
})

describe('stalePaths', () => {
  it('names the download, its differential base, and the Squirrel state and stagings', () => {
    expect(
      stalePaths(
        '/Users/l/Library/Caches',
        'temp-code-updater',
        'dev.landon.tempcode',
        ['ShipItState.plist', 'ShipIt_stderr.log', 'update.mchjM6S'],
        true
      )
    ).toEqual([
      '/Users/l/Library/Caches/temp-code-updater/pending',
      '/Users/l/Library/Caches/temp-code-updater/update.zip',
      '/Users/l/Library/Caches/dev.landon.tempcode.ShipIt/ShipItState.plist',
      '/Users/l/Library/Caches/dev.landon.tempcode.ShipIt/update.mchjM6S'
    ])
    expect(stalePaths('/c', 'temp-code-updater', 'dev.landon.tempcode', ['update.a'], false)).toEqual([
      '/c/dev.landon.tempcode.ShipIt/ShipItState.plist',
      '/c/dev.landon.tempcode.ShipIt/update.a'
    ])
  })
})

describe('feedFallback', () => {
  it('leaves a bundle with app-update.yml to electron-updater', () => {
    expect(feedFallback(true)).toBeNull()
  })
  it('names the public repo for a bundle shipped without the file', () => {
    expect(feedFallback(false)).toEqual({ provider: 'github', owner: 'LandonDev', repo: 'temp-code' })
    expect(feedFallback(false)).toBe(RELEASE_FEED)
  })
})
