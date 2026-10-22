import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { commitsSince, isBookkeeping, nothingLine, nothingToRelease } from './releaseCheck'

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A scratch repo at release-5: release.json n=5, package.json 1.0.5, tagged. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-release-check-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'master')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ n: 5, notes: 'x', ts: 1 }, null, 2) + '\n')
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.5",\n  "private": true\n}\n')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'release: v5 — x')
  git('tag', 'release-5')
  const commit = (subject: string, files: Record<string, string>) => {
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body)
    git('add', '.')
    git('commit', '-q', '-m', subject)
  }
  return { dir, git, commit }
}

describe('releaseCheck', () => {
  it('bookkeeping is a "release: vN" commit touching release.json and package.json only', () => {
    expect(isBookkeeping({ subject: 'release: v6 — notes', files: ['release.json', 'package.json'] })).toBe(true)
    expect(isBookkeeping({ subject: 'release: v6 — notes', files: ['release.json', 'package.json', 'a.ts'] })).toBe(false)
    expect(isBookkeeping({ subject: 'release notes for the docs', files: ['package.json'] })).toBe(false)
    expect(isBookkeeping({ subject: 'release: v6', files: [] })).toBe(false)
    expect(nothingToRelease([])).toBe(true)
    expect(nothingLine('release-288')).toBe('nothing to release since release-288 (package.json 1.0.288)')
  })

  it('HEAD at the tag, or only bookkeeping after it, is nothing; a real commit or a merge is something; no tag is unknown', () => {
    const r = repo()
    expect(commitsSince('release-5', r.dir, env)).toEqual([])
    expect(nothingToRelease(commitsSince('release-5', r.dir, env)!)).toBe(true)
    r.commit('release: v6 — x', { 'release.json': '{"n":6}\n', 'package.json': '{"version":"1.0.6"}\n' })
    expect(nothingToRelease(commitsSince('release-5', r.dir, env)!)).toBe(true)
    r.commit('Fix the thing', { 'a.ts': 'export const a = 2\n' })
    const since = commitsSince('release-5', r.dir, env)!
    expect(since.map((c) => c.subject)).toEqual(['release: v6 — x', 'Fix the thing'])
    expect(since[1].files).toEqual(['a.ts'])
    expect(nothingToRelease(since)).toBe(false)
    expect(commitsSince('release-99', r.dir, env)).toBeNull()

    const m = repo()
    m.git('checkout', '-q', '-b', 'side')
    m.commit('side work', { 'b.ts': 'export const b = 1\n' })
    m.git('checkout', '-q', 'master')
    m.git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side')
    // The merged-in commit is listed; the merge itself counts as something too.
    expect(nothingToRelease(commitsSince('release-5', m.dir, env)!)).toBe(false)
  })

  // The script end to end where nothing is new: it exits 0, says so, and
  // leaves release.json, package.json, HEAD and the tags as they were.
  const bun = spawnSync('bun', ['--version'], { env }).status === 0
  it.runIf(bun)('release.ts with nothing new since release-N is a no-op that exits 0', () => {
    const r = repo()
    r.commit('release: v6 — x', { 'release.json': JSON.stringify({ n: 6, notes: 'x', ts: 1 }, null, 2) + '\n', 'package.json': '{\n  "name": "x",\n  "version": "1.0.6",\n  "private": true\n}\n' })
    r.git('tag', 'release-6')
    const head = r.git('rev-parse', 'HEAD').trim()
    const out = spawnSync('bun', [resolve(__dirname, 'release.ts'), 'notes'], { cwd: r.dir, env, encoding: 'utf8' })
    expect(out.status).toBe(0)
    expect(out.stdout.trim()).toBe('nothing to release since release-6 (package.json 1.0.6)')
    expect(r.git('rev-parse', 'HEAD').trim()).toBe(head)
    expect(r.git('tag', '--list').trim().split('\n')).toEqual(['release-5', 'release-6'])
    expect(JSON.parse(readFileSync(join(r.dir, 'release.json'), 'utf8')).n).toBe(6)
  })
})
