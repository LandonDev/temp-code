import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionMoveBlobFrame, SessionMoveBranch } from '@shared/contract-session-move'
import {
  BlobLanding,
  inspectBranch,
  landBranch,
  parsePorcelain,
  planBranchLanding,
  prepareBranch,
  previewBranch,
  undoBranchLanding,
  worktreeSlug,
  writePatch,
  BranchFetchFailed
} from './sessionMoveBranch'

let T: string
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=master', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
/** `git status --porcelain` lines, untrimmed. */
const status = (cwd: string): string[] => spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort()
const put = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}
/** A repo with two commits on master. */
function repo(name: string): string {
  const dir = join(T, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'master')
  put(join(dir, 'README.md'), 'shop\n')
  put(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  put(join(dir, 'src', 'b.ts'), 'export const b = 2\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'second')
  return dir
}
/** A clone of `src` (so both sides share history), as the receiver's project. */
function cloneOf(src: string, name: string): string {
  const dir = join(T, name)
  git(T, 'clone', '-q', src, dir)
  for (const ref of git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin').split('\n')) {
    const name = ref.replace(/^origin\//, '')
    if (name && name !== 'HEAD' && spawnSync('git', ['-C', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status !== 0) git(dir, 'branch', '-q', name, ref)
  }
  git(dir, 'remote', 'remove', 'origin')
  return dir
}
/** Commits on a feature branch in `dir`, checked out there. */
function feature(dir: string, branch = 'ios/home'): string {
  git(dir, 'checkout', '-q', '-b', branch)
  put(join(dir, 'src', 'home.ts'), 'export const home = true\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'home screen')
  return git(dir, 'rev-parse', 'HEAD')
}
const dirty = (dir: string): void => {
  put(join(dir, 'src', 'a.ts'), 'export const a = 42\n')
  put(join(dir, 'notes.md'), 'untracked notes\n')
}

beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'tc-move-branch-')))
})
afterEach(() => {
  rmSync(T, { recursive: true, force: true })
})

describe('parsePorcelain', () => {
  it('reads paths, renames by their new name', () => {
    expect(parsePorcelain(' M src/a.ts\0?? notes.md\0R  new.ts\0old.ts\0')).toEqual(['src/a.ts', 'notes.md', 'new.ts'])
    expect(parsePorcelain('')).toEqual([])
    expect(parsePorcelain('?? .claude/worktrees/ios-home/\0?? x.ts\0')).toEqual(['x.ts'])
  })
})

describe('worktreeSlug', () => {
  it('flattens the branch into one dir name', () => {
    expect(worktreeSlug('ios/home')).toBe('ios-home')
    expect(worktreeSlug('feature/a b!')).toBe('feature-a-b')
    expect(worktreeSlug('/')).toBe('branch')
  })
})

describe('inspectBranch', () => {
  it('names the branch, the commit, the default branch and the dirty files of a project checkout', async () => {
    const mac = repo('mac')
    const head = feature(mac)
    dirty(mac)
    const i = await inspectBranch(mac)
    expect(i).toMatchObject({ branch: 'ios/home', head, defaultBranch: 'master', worktree: false, hasOrigin: false, mainCheckout: mac })
    expect(i!.dirty.sort()).toEqual(['notes.md', 'src/a.ts'])
  })

  it('sees a linked worktree and its main checkout; the main checkout does not count the worktree as a dirty file', async () => {
    const mac = repo('mac')
    const wt = join(mac, '.claude', 'worktrees', 'ios-home')
    mkdirSync(dirname(wt), { recursive: true })
    git(mac, 'worktree', 'add', '-q', '-b', 'ios/home', wt)
    const i = await inspectBranch(wt)
    expect(i).toMatchObject({ branch: 'ios/home', worktree: true, mainCheckout: mac, dirty: [] })
    expect((await inspectBranch(mac))!.dirty).toEqual([])
    put(join(mac, 'notes.md'), 'n\n')
    const p = await prepareBranch(mac, join(T, 'staging'))
    expect(p!.descriptor.dirty).toEqual(['notes.md'])
    expect(p!.descriptor.patch).not.toBeNull()
  })

  it('answers null outside a repo and a null branch when detached', async () => {
    expect(await inspectBranch(join(T, 'nowhere'))).toBeNull()
    const plain = join(T, 'plain')
    mkdirSync(plain)
    expect(await inspectBranch(plain)).toBeNull()
    const mac = repo('mac')
    git(mac, 'checkout', '-q', 'HEAD~1')
    expect(await inspectBranch(mac)).toMatchObject({ branch: null, worktree: false })
  })

  it('previewBranch counts the files the confirm names', async () => {
    const mac = repo('mac')
    feature(mac)
    dirty(mac)
    expect(await previewBranch(mac)).toEqual({ branch: 'ios/home', detached: false, worktree: false, dirty: 2, origin: false })
    expect(await previewBranch(join(T, 'nowhere'))).toEqual({ branch: null, detached: false, worktree: false, dirty: 0, origin: false })
  })
})

describe('writePatch', () => {
  it('carries tracked changes and untracked files, and leaves the source as it was', async () => {
    const mac = repo('mac')
    dirty(mac)
    const out = join(T, 'staging', 'changes.patch')
    const size = await writePatch(mac, ['notes.md'], out)
    const patch = readFileSync(out, 'utf8')
    expect(size).toBe(Buffer.byteLength(patch))
    expect(patch).toContain('-export const a = 1')
    expect(patch).toContain('+export const a = 42')
    expect(patch).toContain('new file mode')
    expect(patch).toContain('+untracked notes')
    expect(status(mac)).toEqual([' M src/a.ts', '?? notes.md'])
    // It applies to a clean clone.
    const other = cloneOf(mac, 'other')
    git(other, 'apply', out)
    expect(readFileSync(join(other, 'notes.md'), 'utf8')).toBe('untracked notes\n')
    expect(readFileSync(join(other, 'src', 'a.ts'), 'utf8')).toBe('export const a = 42\n')
  })
})

describe('prepareBranch: push, else bundle', () => {
  it('pushes to origin when there is one and says so', async () => {
    const mac = repo('mac')
    const bare = join(T, 'origin.git')
    git(T, 'init', '-q', '--bare', bare)
    git(mac, 'remote', 'add', 'origin', bare)
    const head = feature(mac)
    const p = await prepareBranch(mac, join(T, 'staging'))
    expect(p!.descriptor).toMatchObject({ branch: 'ios/home', head, transport: 'origin', pushError: null, patch: null, dirty: [] })
    expect(git(bare, 'rev-parse', 'refs/heads/ios/home')).toBe(head)
    expect(git(mac, 'rev-parse', '--abbrev-ref', 'ios/home@{upstream}')).toBe('origin/ios/home')
  })

  it('falls back to a bundle when the push fails, and the bundle carries only what the receiver lacks', async () => {
    const mac = repo('mac')
    git(mac, 'remote', 'add', 'origin', join(T, 'missing.git'))
    const base = git(mac, 'rev-parse', 'HEAD')
    const head = feature(mac)
    const p = await prepareBranch(mac, join(T, 'staging'), { pushTimeoutMs: 20_000 })
    expect(p!.descriptor.transport).toBe('bundle')
    expect(p!.descriptor.pushError).toMatch(/git push/)
    const blob = await p!.makeBundle([base, 'f'.repeat(40)])
    expect(blob).not.toBeNull()
    expect(blob!.chunks).toBe(1)
    const heads = git(T, 'bundle', 'list-heads', p!.bundlePath!)
    expect(heads).toContain(`${head} refs/heads/ios/home`)
    // One commit in it: the receiver's base is excluded.
    const box = cloneOf(mac, 'box')
    git(box, 'checkout', '-q', 'master')
    git(box, 'fetch', '-q', p!.bundlePath!, 'refs/heads/ios/home')
    expect(git(box, 'rev-list', '--count', `${base}..${head}`)).toBe('1')
    const f = p!.frame('m1', 'bundle', 0)
    expect(f).toMatchObject({ moveId: 'm1', blob: 'bundle', chunk: 0, chunks: 1, size: blob!.size, sha256: blob!.sha256 })
    expect(() => p!.frame('m1', 'bundle', 1)).toThrow(/no chunk/)
    expect(() => p!.frame('m1', 'patch', 0)).toThrow(/no patch/)
    p!.dispose()
    expect(existsSync(join(T, 'staging'))).toBe(false)
  })

  it('bundles when the repo has no origin, and sends nothing when the receiver already holds the commit', async () => {
    const mac = repo('mac')
    const head = feature(mac)
    const p = await prepareBranch(mac, join(T, 'staging'))
    expect(p!.descriptor).toMatchObject({ transport: 'bundle', pushError: 'the repo has no origin' })
    expect(await p!.makeBundle([head])).toBeNull()
    expect(p!.descriptor.transport).toBe('none')
  })

  it('writes the patch of a dirty tree, in chunks, and nothing when the tree is clean', async () => {
    const mac = repo('mac')
    feature(mac)
    dirty(mac)
    put(join(mac, 'big.bin'), 'x'.repeat(2 * 1024 * 1024 + 100))
    const p = await prepareBranch(mac, join(T, 'staging'))
    expect(p!.descriptor.dirty.sort()).toEqual(['big.bin', 'notes.md', 'src/a.ts'])
    expect(p!.descriptor.patch!.chunks).toBe(2)
    const frames = [p!.frame('m', 'patch', 0), p!.frame('m', 'patch', 1)]
    expect(Buffer.from(frames[0].dataBase64, 'base64').length).toBe(2 * 1024 * 1024)
    expect(status(mac).length).toBe(3)
    const clean = repo('clean')
    const q = await prepareBranch(clean, join(T, 'staging2'))
    expect(q!.descriptor.patch).toBeNull()
    expect(q!.patchPath).toBeNull()
  })

  it('answers null for a cwd that is not a checkout', async () => {
    const plain = join(T, 'plain')
    mkdirSync(plain)
    expect(await prepareBranch(plain, join(T, 'staging'))).toBeNull()
  })
})

const desc = (over: Partial<SessionMoveBranch> & { head: string }): SessionMoveBranch => ({
  branch: 'ios/home',
  defaultBranch: 'master',
  worktree: false,
  mainCheckout: '/src/shop',
  transport: 'bundle',
  pushError: null,
  dirty: [],
  dirtyMore: 0,
  patch: null,
  patchSkipped: null,
  ...over
})

describe('planBranchLanding: checkout, worktree or reuse', () => {
  it('checks the branch out in the project when the source was on it directly and the project here is clean on its default branch', async () => {
    const mac = repo('mac')
    const head = feature(mac)
    const box = cloneOf(mac, 'box')
    git(box, 'checkout', '-q', 'master')
    const plan = await planBranchLanding(box, desc({ head }))
    expect(plan).toMatchObject({ mode: 'checkout', cwd: box, project: box, why: null })
    expect(plan!.have).toContain(git(box, 'rev-parse', 'master'))
    expect(plan!.have).toContain(head) // the clone has it already
  })

  it('uses a worktree when the source was in one, when the project here is dirty, or when it is on another branch, and says why', async () => {
    const mac = repo('mac')
    const head = feature(mac)
    const box = cloneOf(mac, 'box')
    git(box, 'checkout', '-q', 'master')
    expect(await planBranchLanding(box, desc({ head, worktree: true }))).toMatchObject({ mode: 'worktree', cwd: join(box, '.claude', 'worktrees', 'ios-home'), why: null })
    put(join(box, 'README.md'), 'changed\n')
    expect(await planBranchLanding(box, desc({ head }))).toMatchObject({ mode: 'worktree', why: 'box has uncommitted changes here' })
    git(box, 'checkout', '-q', '.')
    git(box, 'checkout', '-q', '-b', 'other')
    expect(await planBranchLanding(box, desc({ head }))).toMatchObject({ mode: 'worktree', why: 'box is on other here, not master' })
    // A leftover dir of that name that is not a checkout: the next name.
    mkdirSync(join(box, '.claude', 'worktrees', 'ios-home'), { recursive: true })
    expect((await planBranchLanding(box, desc({ head })))!.cwd).toBe(join(box, '.claude', 'worktrees', 'ios-home-2'))
  })

  it('reuses a checkout here that already has the branch, and answers null outside a repo', async () => {
    const mac = repo('mac')
    const head = feature(mac)
    const box = cloneOf(mac, 'box')
    git(box, 'checkout', '-q', 'master')
    const wt = join(box, '.claude', 'worktrees', 'ios-home')
    mkdirSync(dirname(wt), { recursive: true })
    git(box, 'worktree', 'add', '-q', wt, 'ios/home')
    expect(await planBranchLanding(box, desc({ head }))).toMatchObject({ mode: 'reuse', cwd: wt })
    const plain = join(T, 'plain')
    mkdirSync(plain)
    expect(await planBranchLanding(plain, desc({ head }))).toBeNull()
  })

  it('a detached source lands in a detached worktree named by the commit', async () => {
    const mac = repo('mac')
    const head = feature(mac)
    const box = cloneOf(mac, 'box')
    git(box, 'checkout', '-q', 'master')
    expect(await planBranchLanding(box, desc({ head, branch: null }))).toMatchObject({ mode: 'worktree', cwd: join(box, '.claude', 'worktrees', head.slice(0, 12)), why: 'HEAD was detached on the source' })
  })
})

/** The source's blobs crossing into a BlobLanding, frame by frame. */
function cross(p: NonNullable<Awaited<ReturnType<typeof prepareBranch>>>, blob: 'bundle' | 'patch', dir: string): string {
  const meta = blob === 'bundle' ? p.bundle! : p.descriptor.patch!
  const landing = new BlobLanding(dir, blob)
  for (let c = 0; c < meta.chunks; c++) landing.take(JSON.parse(JSON.stringify(p.frame('m', blob, c))) as SessionMoveBlobFrame)
  expect(landing.complete).toBe(true)
  return landing.finish(meta)
}

describe('landBranch: the round trip', () => {
  it('a bundle plus a patch: the branch at the same commit in a worktree, the changes applied, the source untouched', async () => {
    const mac = repo('mac')
    const base = git(mac, 'rev-parse', 'HEAD')
    const box = cloneOf(mac, 'box') // before the branch exists: the bundle must carry it
    const head = feature(mac)
    dirty(mac)
    const p = (await prepareBranch(mac, join(T, 'staging')))!
    const plan = (await planBranchLanding(box, { ...p.descriptor, worktree: true }))!
    expect(plan.have).toEqual(expect.arrayContaining([base]))
    expect(plan.have).not.toContain(head)
    await p.makeBundle(plan.have)
    const bundlePath = cross(p, 'bundle', join(T, 'land', 'bundle'))
    const patchPath = cross(p, 'patch', join(T, 'land', 'patch'))
    const landing = await landBranch({ projectCwd: box, plan, branch: { ...p.descriptor, worktree: true }, transport: 'bundle', bundlePath, patchPath })
    expect(landing).toMatchObject({ branch: 'ios/home', head, mode: 'worktree', cwd: plan.cwd, created: true, patch: 'applied', patchPath: null, note: null })
    expect(git(plan.cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(plan.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ios/home')
    expect(readFileSync(join(plan.cwd, 'src', 'a.ts'), 'utf8')).toBe('export const a = 42\n')
    expect(readFileSync(join(plan.cwd, 'notes.md'), 'utf8')).toBe('untracked notes\n')
    expect(status(plan.cwd)).toEqual([' M src/a.ts', '?? notes.md'])
    // The source still has its branch and its changes.
    expect(git(mac, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ios/home')
    expect(status(mac)).toEqual([' M src/a.ts', '?? notes.md'])
    // An abort removes the worktree the move made, and only that.
    await undoBranchLanding(box, landing, 'master')
    expect(existsSync(plan.cwd)).toBe(false)
    expect(git(box, 'worktree', 'list')).not.toContain('ios-home')
    expect(git(box, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master')
  })

  it('origin: the receiver fetches what the source pushed, and checks the branch out in the project when it may', async () => {
    const mac = repo('mac')
    const bare = join(T, 'origin.git')
    git(T, 'init', '-q', '--bare', bare)
    git(mac, 'remote', 'add', 'origin', bare)
    git(mac, 'push', '-q', '-u', 'origin', 'master')
    const box = join(T, 'box')
    git(T, 'clone', '-q', bare, box)
    const head = feature(mac)
    const p = (await prepareBranch(mac, join(T, 'staging')))!
    expect(p.descriptor.transport).toBe('origin')
    const plan = (await planBranchLanding(box, p.descriptor))!
    expect(plan.mode).toBe('checkout')
    const landing = await landBranch({ projectCwd: box, plan, branch: p.descriptor, transport: 'origin', bundlePath: null, patchPath: null })
    expect(landing).toMatchObject({ mode: 'checkout', cwd: box, created: false, patch: 'none' })
    expect(git(box, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(box, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ios/home')
    expect(git(box, 'rev-parse', '--abbrev-ref', 'ios/home@{upstream}')).toBe('origin/ios/home')
    await undoBranchLanding(box, landing, 'master')
    expect(git(box, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master')
  })

  it('a fetch from origin that cannot bring the commit is a BranchFetchFailed, so the source can bundle instead', async () => {
    const mac = repo('mac')
    const box = cloneOf(mac, 'box')
    const head = feature(mac)
    git(box, 'remote', 'add', 'origin', join(T, 'missing.git'))
    const plan = (await planBranchLanding(box, desc({ head, transport: 'origin' })))!
    await expect(landBranch({ projectCwd: box, plan, branch: desc({ head, transport: 'origin' }), transport: 'origin', bundlePath: null, patchPath: null })).rejects.toBeInstanceOf(BranchFetchFailed)
    expect(git(box, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master')
  })

  it('a branch that is ahead here lands detached at the source commit; a patch that does not apply on a tree with changes of its own is kept', async () => {
    const mac = repo('mac')
    const head = feature(mac)
    put(join(mac, 'src', 'a.ts'), 'export const a = 42\n')
    put(join(mac, 'notes.md'), 'untracked notes\n')
    const box = cloneOf(mac, 'box')
    git(box, 'checkout', '-q', 'master')
    // The receiver's branch holds an extra commit of its own on the same file.
    git(box, 'checkout', '-q', 'ios/home')
    put(join(box, 'src', 'a.ts'), 'export const a = "theirs"\n')
    git(box, 'add', '.')
    git(box, 'commit', '-q', '-m', 'conflicting')
    git(box, 'checkout', '-q', 'master')
    const p = (await prepareBranch(mac, join(T, 'staging')))!
    const plan = (await planBranchLanding(box, { ...p.descriptor, worktree: true }))!
    expect(plan.mode).toBe('worktree')
    const patchPath = cross(p, 'patch', join(T, 'land', 'patch'))
    const landing = await landBranch({ projectCwd: box, plan, branch: { ...p.descriptor, worktree: true }, transport: 'none', bundlePath: null, patchPath })
    // The branch here had a commit of its own: a detached checkout at the source's commit.
    expect(landing.mode).toBe('detached')
    expect(landing.created).toBe(true)
    expect(landing.note).toMatch(/commits of its own/)
    expect(git(landing.cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(box, 'rev-parse', 'ios/home')).not.toBe(head) // their branch is left alone
    // At the source's commit a.ts is as the source had it, so the patch applies there.
    expect(landing.patch).toBe('applied')
    // The same patch again on top of the applied one cannot apply, and the tree is not the move's to reset.
    const again = await landBranch({ projectCwd: box, plan: { ...plan, mode: 'reuse', cwd: landing.cwd }, branch: { ...p.descriptor, branch: null, worktree: true }, transport: 'none', bundlePath: null, patchPath })
    expect(again.patch).toBe('kept')
    expect(again.patchPath).toBe(join(landing.cwd, '.temp-code', 'moved-changes.patch'))
    expect(readFileSync(again.patchPath!, 'utf8')).toBe(readFileSync(patchPath, 'utf8'))
    expect(again.note).toMatch(/did not apply/)
  })

  it('a conflicting patch on a clean tree is undone, kept, and the created files are gone', async () => {
    const mac = repo('mac')
    const head = feature(mac)
    put(join(mac, 'src', 'a.ts'), 'export const a = 42\n')
    put(join(mac, 'notes.md'), 'untracked notes\n')
    const box = cloneOf(mac, 'box')
    git(box, 'checkout', '-q', 'master')
    // The receiver's copy of the branch has rewritten a.ts, so the patch's context is gone there.
    put(join(box, 'src', 'a.ts'), 'completely different\n')
    git(box, 'commit', '-q', '-am', 'rewrite a')
    git(box, 'branch', '-q', '-f', 'ios/home', 'master')
    const theirs = git(box, 'rev-parse', 'master')
    const p = (await prepareBranch(mac, join(T, 'staging')))!
    const patchPath = cross(p, 'patch', join(T, 'land', 'patch'))
    // Land on the receiver's own tip (a 'reuse'-free worktree at their commit), so the patch has no context.
    const plan = { mode: 'worktree' as const, cwd: join(box, '.claude', 'worktrees', 'ios-home'), project: box, have: [theirs], why: null }
    const landing = await landBranch({ projectCwd: box, plan, branch: { ...p.descriptor, head: theirs, worktree: true }, transport: 'none', bundlePath: null, patchPath })
    expect(landing.patch).toBe('kept')
    expect(existsSync(join(landing.cwd, 'notes.md'))).toBe(false)
    expect(readFileSync(join(landing.cwd, 'src', 'a.ts'), 'utf8')).toBe('completely different\n')
    expect(status(landing.cwd)).toEqual([]) // .temp-code/ is excluded locally
    expect(existsSync(landing.patchPath!)).toBe(true)
    expect(landing.note).toMatch(/moved-changes\.patch/)
    void head
  })
})
