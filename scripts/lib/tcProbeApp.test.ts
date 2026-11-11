import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { STEAL_PLIST_KEYS, STEAL_PROBE_BUNDLE_ID, ScreenWatch, binarySpellings, guiLaunchEnvironment, probePlist, stealDocName } from './tcProbeApp'

describe('binarySpellings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-probe-spell-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('adds /private before /tmp, the way Launch Services starts an app there', () => {
    const bin = '/tmp/tc-preview-proof/TC Probe.app/Contents/MacOS/TC Probe'
    expect(binarySpellings(bin)).toEqual([bin, `/private${bin}`])
  })

  it('drops /private from a /private/tmp path, so either spelling matches', () => {
    const bin = '/private/tmp/tc-computer-ui/TC Probe.app/Contents/MacOS/TC Probe'
    expect(binarySpellings(bin)).toEqual([bin, '/tmp/tc-computer-ui/TC Probe.app/Contents/MacOS/TC Probe'])
  })

  it('adds the real path of a binary reached through a link', () => {
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    const spellings = binarySpellings(join(dir, 'link'))
    expect(spellings[0]).toBe(join(dir, 'link'))
    expect(spellings).toContain(realpathSync(join(dir, 'real')))
  })

  it('leaves any other path as it is', () => {
    expect(binarySpellings('/Users/me/probe/TC Probe')).toEqual(['/Users/me/probe/TC Probe'])
  })
})

describe('stealDocName', () => {
  it('names a tcprobe document of its own for every try', () => {
    expect(stealDocName(42, 0)).toBe('probe-42-0.tcprobe')
    expect(new Set([0, 1, 2, 3].map((n) => stealDocName(42, n))).size).toBe(4)
  })
})

describe('probePlist', () => {
  it('writes the plain probe as it always did', () => {
    expect(probePlist('TC Probe', 'dev.landon.tempcode.computer-probe', '')).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.landon.tempcode.computer-probe</string>
  <key>CFBundleName</key><string>TC Probe</string>
  <key>CFBundleExecutable</key><string>TC Probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`)
  })

  it('gives the stealer its key and the tcprobe document type it owns', () => {
    const plist = probePlist('TC Probe Steal', STEAL_PROBE_BUNDLE_ID, STEAL_PLIST_KEYS)
    expect(plist).toContain('<key>CFBundleIdentifier</key><string>dev.landon.tempcode.computer-probe-steal</string>')
    expect(plist).toContain('<key>CFBundleExecutable</key><string>TC Probe Steal</string>')
    expect(plist).toContain('<key>TCProbeSteal</key><true/>')
    expect(plist).toContain('<key>LSHandlerRank</key><string>Owner</string>')
    expect(plist).toContain('<key>CFBundleTypeRole</key><string>Viewer</string>')
    expect(plist).toContain('<array><string>tcprobe</string></array>')
    expect(plist.trimEnd().endsWith('</dict>\n</plist>')).toBe(true)
  })
})

describe('guiLaunchEnvironment', () => {
  it('leaves out the guard marks a thread shell carries, and keeps the rest', () => {
    const runner = { PATH: '/usr/bin', TEMP_CODE_COMPUTER_PROOF: '1', TEMP_CODE_THREAD: 't1', TEMP_CODE_CALL: 'c1', TEMP_CODE_INSTANCE: 'i1', CLAUDE_PID: '7', ANTHROPIC_BASE_URL: 'http://127.0.0.1/~t=t1' }
    expect(guiLaunchEnvironment(runner)).toEqual({ PATH: '/usr/bin', TEMP_CODE_COMPUTER_PROOF: '1' })
    expect(runner.TEMP_CODE_THREAD).toBe('t1')
  })
})

describe('ScreenWatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-screen-watch-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const fakeProbe = (reply: string): string => {
    const path = join(dir, `probe-${Math.random().toString(36).slice(2)}`)
    writeFileSync(path, `#!/bin/sh\necho '${reply}'\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('reads the probe through parseMacScreen: an unlocked screen passes, a locked one stops the watch', () => {
    const open = new ScreenWatch()
    open.start(fakeProbe('{"locked":false,"asleep":false}'), 60_000)
    expect(() => open.check()).not.toThrow()
    open.stop()
    const locked = new ScreenWatch()
    expect(() => locked.start(fakeProbe('{"locked":true,"asleep":false}'), 60_000)).toThrow(/the Mac locked/)
    locked.stop()
  })
})
