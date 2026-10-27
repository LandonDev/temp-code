import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { aboutPanelOptions, buildInfo, bundledBuildSha, checkoutRootOf, checkoutSha, COPYRIGHT, readBuildSha } from './buildInfo'
import release from '../../release.json'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const dirs: string[] = []
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tc-build-info-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('bundledBuildSha', () => {
  it('reads tempcodeBuild.sha from the bundled package.json', () => {
    const d = scratch()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '1.0.1', tempcodeBuild: { sha: ` ${A} ` } }))
    expect(bundledBuildSha(d)).toBe(A)
  })
  it('is null without the block, with a malformed sha, or without a package.json', () => {
    const d = scratch()
    expect(bundledBuildSha(d)).toBeNull()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '1.0.1' }))
    expect(bundledBuildSha(d)).toBeNull()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ tempcodeBuild: { sha: 'abc' } }))
    expect(bundledBuildSha(d)).toBeNull()
    writeFileSync(join(d, 'package.json'), '{not json')
    expect(bundledBuildSha(d)).toBeNull()
  })
})

describe('checkoutSha', () => {
  it('reads a detached HEAD (the box runs one)', () => {
    const d = scratch()
    mkdirSync(join(d, '.git'))
    writeFileSync(join(d, '.git', 'HEAD'), `${A}\n`)
    expect(checkoutSha(d)).toBe(A)
  })
  it('follows a symbolic ref to a loose ref, then packed-refs', () => {
    const d = scratch()
    mkdirSync(join(d, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/master\n')
    writeFileSync(join(d, '.git', 'refs', 'heads', 'master'), `${A}\n`)
    expect(checkoutSha(d)).toBe(A)
    rmSync(join(d, '.git', 'refs', 'heads', 'master'))
    writeFileSync(join(d, '.git', 'packed-refs'), `# pack-refs with: peeled\n${B} refs/heads/master\n${A} refs/heads/other\n`)
    expect(checkoutSha(d)).toBe(B)
  })
  it('follows a worktree gitdir file into the main repo for refs', () => {
    const repo = scratch()
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'feature'), `${B}\n`)
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature\n')
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    const wt = scratch()
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`)
    expect(checkoutSha(wt)).toBe(B)
  })
  it('is null for a plain directory or a dangling ref', () => {
    const d = scratch()
    expect(checkoutSha(d)).toBeNull()
    mkdirSync(join(d, '.git'))
    writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n')
    expect(checkoutSha(d)).toBeNull()
  })
})

describe('buildInfo', () => {
  it('prefers the bundled sha over the checkout, and reads release.json', () => {
    const d = scratch()
    mkdirSync(join(d, '.git'))
    writeFileSync(join(d, '.git', 'HEAD'), `${A}\n`)
    expect(readBuildSha(d)).toBe(A)
    writeFileSync(join(d, 'package.json'), JSON.stringify({ tempcodeBuild: { sha: B } }))
    expect(readBuildSha(d)).toBe(B)
    const info = buildInfo(d)
    expect(info).toEqual({ release: release.n, version: `1.0.${release.n}`, sha: B })
    expect(buildInfo().sha).toBeNull()
  })
})

describe('aboutPanelOptions', () => {
  it('reads the version with its short commit and the copyright', () => {
    expect(aboutPanelOptions({ release: 412, version: '1.0.412', sha: A })).toEqual({
      applicationName: 'TempCode',
      applicationVersion: '1.0.412',
      version: 'aaaaaaa',
      copyright: 'Copyright © 2026 Landon Hale',
      credits: ''
    })
  })
  it('leaves the build field empty when the build has no commit, never the version twice', () => {
    const options = aboutPanelOptions({ release: 412, version: '1.0.412', sha: null })
    expect(options.version).toBe('')
    expect(options.applicationVersion).toBe('1.0.412')
  })
  it("says what electron-builder.yml's copyright says", () => {
    const yml = readFileSync(join(checkoutRootOf(__dirname), 'electron-builder.yml'), 'utf8')
    expect(yml.match(/^copyright:\s*(.+?)\s*$/m)?.[1]).toBe(COPYRIGHT)
  })
})
