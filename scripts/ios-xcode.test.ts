import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'ios-xcode.sh')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A directory of fake Xcode bundles, each with the version.plist the picker reads. */
function apps(bundles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tc-xcodes-'))
  dirs.push(dir)
  for (const [name, version] of Object.entries(bundles)) {
    mkdirSync(join(dir, name, 'Contents', 'Developer'), { recursive: true })
    writeFileSync(join(dir, name, 'Contents', 'version.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`)
  }
  return dir
}

function pick(dir: string, env: Record<string, string> = {}) {
  const { DEVELOPER_DIR: _dropped, ...base } = process.env
  const r = spawnSync('sh', [script], { encoding: 'utf8', env: { ...base, TC_XCODE_APPS_DIR: dir, ...env } })
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

describe('scripts/ios-xcode.sh', () => {
  it('picks the highest version, not the last file name: 27.1 release over the 27.0 beta', () => {
    const dir = apps({ 'Xcode-beta.app': '27.0', 'Xcode.app': '27.1' })
    expect(pick(dir)).toEqual({ status: 0, out: join(dir, 'Xcode.app', 'Contents', 'Developer'), err: '' })
  })

  it('takes a newer beta over the release', () => {
    const dir = apps({ 'Xcode-27.2-beta.app': '27.2', 'Xcode.app': '27.1' })
    expect(pick(dir).out).toBe(join(dir, 'Xcode-27.2-beta.app', 'Contents', 'Developer'))
  })

  it('compares numerically: 27.10 beats 27.9', () => {
    const dir = apps({ 'Xcode.app': '27.9', 'Xcode-27.10.app': '27.10' })
    expect(pick(dir).out).toBe(join(dir, 'Xcode-27.10.app', 'Contents', 'Developer'))
  })

  it('breaks a tie toward the bundle without "beta" in its name', () => {
    const dir = apps({ 'Xcode-beta.app': '27.1', 'Xcode.app': '27.1' })
    expect(pick(dir).out).toBe(join(dir, 'Xcode.app', 'Contents', 'Developer'))
  })

  it('refuses a pick below TC_XCODE_MIN (default 27.1) with exit 2 naming every installed Xcode', () => {
    const dir = apps({ 'Xcode-beta.app': '27.0', 'Xcode.app': '26.4' })
    const r = pick(dir)
    expect(r.status).toBe(2)
    expect(r.out).toBe('')
    expect(r.err).toContain('Xcode-beta.app is Xcode 27.0, below the 27.1')
    expect(r.err).toContain('Xcode-beta.app 27.0')
    expect(r.err).toContain('Xcode.app 26.4')
  })

  it('TC_XCODE_MIN=0 admits any Xcode (the package runners)', () => {
    const dir = apps({ 'Xcode.app': '26.4' })
    expect(pick(dir, { TC_XCODE_MIN: '0' })).toMatchObject({ status: 0, out: join(dir, 'Xcode.app', 'Contents', 'Developer') })
  })

  it('TC_XCODE names the bundle and wins over the version rule, still under the minimum', () => {
    const dir = apps({ 'Xcode-beta.app': '27.3', 'Xcode.app': '27.1' })
    expect(pick(dir, { TC_XCODE: join(dir, 'Xcode.app') }).out).toBe(join(dir, 'Xcode.app', 'Contents', 'Developer'))
    expect(pick(dir, { TC_XCODE: join(dir, 'Xcode.app'), TC_XCODE_MIN: '27.2' }).status).toBe(2)
    expect(pick(dir, { TC_XCODE: join(dir, 'Nope.app') }).status).toBe(2)
  })

  it('DEVELOPER_DIR passes through untouched, over everything', () => {
    const dir = apps({ 'Xcode.app': '26.0' })
    expect(pick(dir, { DEVELOPER_DIR: '/x/Contents/Developer', TC_XCODE: join(dir, 'Xcode.app') })).toEqual({ status: 0, out: '/x/Contents/Developer', err: '' })
  })

  it('an empty directory is exit 2', () => {
    const dir = apps({})
    expect(pick(dir)).toMatchObject({ status: 2, out: '' })
  })
})
