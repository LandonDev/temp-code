import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_PORT_FILE, isHeadless, noDisplay, publishLocalPort, unpublishLocalPort } from './headless'

describe('isHeadless', () => {
  it('follows TEMP_CODE_HEADLESS on every platform', () => {
    expect(isHeadless({ TEMP_CODE_HEADLESS: '1' }, 'darwin')).toBe(true)
    expect(isHeadless({ TEMP_CODE_HEADLESS: '1', DISPLAY: ':99' }, 'linux')).toBe(true)
    expect(isHeadless({ TEMP_CODE_HEADLESS: '0' }, 'linux')).toBe(false)
  })
  it('is off by default wherever a window can open', () => {
    expect(isHeadless({}, 'darwin')).toBe(false)
    expect(isHeadless({}, 'win32')).toBe(false)
    expect(isHeadless({ DISPLAY: ':99' }, 'linux')).toBe(false)
    expect(isHeadless({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false)
  })
  it('is on for a Linux process with no display server', () => {
    expect(isHeadless({}, 'linux')).toBe(true)
    expect(noDisplay({}, 'linux')).toBe(true)
    expect(noDisplay({}, 'darwin')).toBe(false)
  })
})

describe('publishLocalPort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-headless-'))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('writes a private file naming the port and pid, and removes it again', () => {
    const path = publishLocalPort(dir, 43210)
    expect(path).toBe(join(dir, LOCAL_PORT_FILE))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ port: 43210, pid: process.pid })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    unpublishLocalPort(dir)
    expect(() => statSync(path)).toThrow()
    unpublishLocalPort(dir)
  })
})
