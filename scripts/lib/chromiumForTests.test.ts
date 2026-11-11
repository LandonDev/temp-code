import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chromiumForTests,
  hasChromeProfile,
  scratchChromiumPids,
  stopScratchChromium
} from './chromiumForTests'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chromium-discovery-'))
  dirs.push(dir)
  return dir
}
const app = (dir: string) => {
  const path = join(dir, 'Google Chrome for Testing.app')
  mkdirSync(join(path, 'Contents/MacOS'), { recursive: true })
  writeFileSync(join(path, 'Contents/MacOS/Google Chrome for Testing'), '')
  return path
}

describe('Chrome for Testing discovery', () => {
  it('uses the explicit bundle, with no fallback for a bad override', () => {
    const cache = temp(),
      override = app(temp())
    app(join(cache, 'chromium-100', 'chrome-mac-arm64'))
    expect(chromiumForTests({ override, cache })).toBe(override)
    expect(chromiumForTests({ override: '/absent/Chrome.app', cache })).toBeNull()
  })
  it('finds both Playwright layouts and takes the newest revision', () => {
    const cache = temp()
    app(join(cache, 'chromium-99', 'chrome-mac'))
    const newest = app(join(cache, 'chromium-101', 'chrome-mac-arm64'))
    expect(chromiumForTests({ override: '', cache })).toBe(newest)
    expect(chromiumForTests({ override: '', cache: '/absent/cache' })).toBeNull()
    expect(chromiumForTests({ override: '', cache: temp() })).toBeNull()
  })
})

describe('scratch browser cleanup', () => {
  it('matches the whole profile argument and rejects ambiguous paths', () => {
    expect(hasChromeProfile('chrome --user-data-dir=/tmp/ours --type=renderer', '/tmp/ours')).toBe(
      true
    )
    expect(
      hasChromeProfile(
        'chrome --user-data-dir=/tmp/our profile --type=renderer',
        '/tmp/our profile'
      )
    ).toBe(false)
    for (const command of [
      'chrome --user-data-dir=/tmp/ours-extra',
      'chrome /tmp/ours',
      'chrome --other=--user-data-dir=/tmp/ours'
    ])
      expect(hasChromeProfile(command, '/tmp/ours')).toBe(false)
  })
  it('selects only the recorded browser and its marked children, never a second instance', () => {
    const rows = [
      { pid: 10, command: 'Chrome --user-data-dir=/tmp/ours' },
      { pid: 11, command: 'Helper --user-data-dir=/tmp/ours --type=renderer' },
      { pid: 12, command: 'Helper --type=gpu' },
      { pid: 20, command: 'Chrome --user-data-dir=/tmp/theirs' },
      { pid: 21, command: 'Helper --user-data-dir=/tmp/theirs' },
      { pid: 30, command: 'Chrome --user-data-dir=/tmp/ours' },
      { pid: 31, command: 'Helper --user-data-dir=/tmp/ours-extra' }
    ].map((r) => ({ ...r, environment: [] }))
    const parents = new Map([
      [10, 1],
      [11, 10],
      [12, 10],
      [20, 1],
      [21, 20],
      [30, 1],
      [31, 10]
    ])
    const select = () => scratchChromiumPids(rows, 10, '/tmp/ours', (p) => parents.get(p) ?? null)
    expect(select()).toEqual([11, 10])
    // A PID whose command changed between TERM and KILL must no longer qualify.
    rows[1].command = 'some other program'
    expect(select()).toEqual([10])
    expect(scratchChromiumPids(rows, 0, '/tmp/ours', () => null)).toEqual([])
  })
  it('stops a parent cycle without selecting an unrelated process', () => {
    expect(
      scratchChromiumPids(
        [{ pid: 5, command: 'chrome --user-data-dir=/tmp/p', environment: [] }],
        10,
        '/tmp/p',
        () => 5
      )
    ).toEqual([])
  })
})

describe('scratch browser signals', () => {
  it('checks the profile again for KILL and handles a child orphaned by TERM', () => {
    const rows = [
      { pid: 10, command: 'Chrome --user-data-dir=/tmp/ours', environment: [] },
      { pid: 11, command: 'Helper --user-data-dir=/tmp/ours', environment: [] },
      { pid: 12, command: 'Helper --user-data-dir=/tmp/ours', environment: [] },
      { pid: 20, command: 'Chrome --user-data-dir=/tmp/theirs', environment: [] }
    ]
    const signals: [number, string][] = []
    let orphaned = false
    const stopped = stopScratchChromium(10, '/tmp/ours', {
      processes: () => rows,
      ppidOf: (pid) => (pid === 11 || pid === 12 ? (orphaned ? 1 : 10) : 1),
      signal(pid, signal) {
        signals.push([pid, signal])
        if (signal === 'SIGKILL' || pid === 10)
          rows.splice(
            rows.findIndex((row) => row.pid === pid),
            1
          )
      },
      wait() {
        orphaned = true
        const changed = rows.find((row) => row.pid === 12)
        if (changed) changed.command = 'unrelated program'
      }
    })
    expect(signals).toEqual([
      [11, 'SIGTERM'],
      [12, 'SIGTERM'],
      [10, 'SIGTERM'],
      [11, 'SIGKILL']
    ])
    expect(stopped).toEqual([11, 12, 10])
    expect(rows.find((row) => row.pid === 20)?.command).toContain('/tmp/theirs')
  })
})
