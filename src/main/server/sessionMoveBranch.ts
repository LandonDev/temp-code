import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  SESSION_MOVE_BLOB_CHUNK,
  SESSION_MOVE_BUNDLE_CAP,
  SESSION_MOVE_PATCH_CAP,
  type SessionMoveBlob,
  type SessionMoveBlobFrame,
  type SessionMoveBranch,
  type SessionMoveBranchLanding,
  type SessionMoveBranchPlan,
  type SessionMovePreview
} from '@shared/contract-session-move'
import { ensureLocalExclude } from './git'
import { execFileBudgeted } from './spawnBudget'

/**
 * The branch travels with the thread (docs/box.md "Moving a thread between
 * hosts", "The branch travels too"). sessionMove.ts moves the rows and the
 * files; this file moves the git side, in two halves that a test can run
 * against two temp repositories with no network:
 *
 *  - the source (`inspectBranch`, `prepareBranch`): the cwd's checked-out
 *    branch and commit, whether the cwd is a linked worktree of the project,
 *    the repo's default branch, and the uncommitted changes. The commits go
 *    through `origin` when the repo has one and `git push -u origin <branch>`
 *    lands, else as a `git bundle` over the link, made once the receiver has
 *    named the commits it already holds (so a bundle carries the difference,
 *    never the history). The uncommitted changes cross as one patch:
 *    `git diff --binary HEAD` plus a `--no-index` diff of every untracked
 *    file, nothing staged, stashed or reset on the source.
 *  - the receiver (`planBranchLanding`, `landBranch`, `undoBranchLanding`):
 *    decides where the branch goes before any part lands (a worktree under
 *    <project>/.claude/worktrees/<branch>, the project checkout itself when
 *    the source was on the branch directly and the project here is clean on
 *    its default branch, or a checkout that already has the branch), then
 *    fetches or unbundles, checks the branch out at the same commit, applies
 *    the patch with `git apply --3way`, and keeps a patch that does not apply
 *    at <cwd>/.temp-code/moved-changes.patch. An abort removes only what
 *    the move made.
 */

const COMMIT = /^[0-9a-f]{40}$/
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

export interface GitRunner {
  (cwd: string, args: string[], opts?: { timeoutMs?: number; maxBuffer?: number; ok?: number[] }): Promise<{ stdout: string; code: number }>
}

/** `git -C <cwd> …`; a non-zero exit is an error unless listed in `ok`. */
export const runGit: GitRunner = async (cwd, args, opts = {}) => {
  try {
    const { stdout } = await execFileBudgeted('git', ['-C', cwd, ...args], {
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    })
    return { stdout, code: 0 }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    const code = typeof e.code === 'number' ? e.code : -1
    if (opts.ok?.includes(code)) return { stdout: String(e.stdout ?? ''), code }
    const detail = String(e.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('hint:'))
      .slice(-2)
      .join(' ')
    throw new Error(`git ${args[0]}${args[1] ? ` ${args[1]}` : ''}: ${detail || e.message || `exit ${code}`}`)
  }
}

const tryGit = async (git: GitRunner, cwd: string, args: string[], opts?: Parameters<GitRunner>[2]): Promise<string | null> => {
  try {
    return (await git(cwd, args, opts)).stdout
  } catch {
    return null
  }
}

/** The dir name a branch's worktree gets: ios/home → ios-home. */
export const worktreeSlug = (branch: string): string =>
  branch
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'branch'

const same = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

// ── the source ───────────────────────────────────────────────────────────

export interface BranchInspection {
  /** null: detached HEAD. */
  branch: string | null
  head: string
  defaultBranch: string | null
  /** The cwd is a linked worktree (its git dir is not the common dir). */
  worktree: boolean
  /** The main checkout (the project) this cwd belongs to. */
  mainCheckout: string
  hasOrigin: boolean
  /** Tracked changes and untracked files (porcelain paths, renames by their new name). */
  dirty: string[]
}

async function defaultBranchOf(git: GitRunner, cwd: string): Promise<string | null> {
  const head = await tryGit(git, cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  if (head?.trim()) return head.trim().replace(/^origin\//, '')
  for (const name of ['main', 'master']) if ((await tryGit(git, cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])) !== null) return name
  return null
}

/** `git status --porcelain -z`: the paths, renames by their new name. A nested repository (a worktree under the tree, listed as `dir/`) is not a file and is left out. */
export function parsePorcelain(z: string): string[] {
  const out: string[] = []
  const parts = z.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') i++ // the old name follows
    if (path.endsWith('/')) continue
    out.push(path)
  }
  return out
}

/** What the thread's cwd is on, git-wise; null when it is not a git checkout (or has no commit yet). */
export async function inspectBranch(cwd: string, git: GitRunner = runGit): Promise<BranchInspection | null> {
  if (!existsSync(cwd)) return null
  const inside = await tryGit(git, cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside?.trim() !== 'true') return null
  const head = (await tryGit(git, cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim()
  if (!head || !COMMIT.test(head)) return null
  const ref = (await tryGit(git, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? 'HEAD'
  const branch = ref && ref !== 'HEAD' ? ref : null
  const gitDir = (await tryGit(git, cwd, ['rev-parse', '--absolute-git-dir']))?.trim() ?? ''
  const common = (await tryGit(git, cwd, ['rev-parse', '--git-common-dir']))?.trim() ?? ''
  const commonAbs = common ? (isAbsolute(common) ? common : resolve(cwd, common)) : gitDir
  const worktree = !!gitDir && !!commonAbs && !same(gitDir, commonAbs)
  // The main checkout is the common dir's parent (a `.git` dir), as `git worktree list` lists it first.
  const list = (await tryGit(git, cwd, ['worktree', 'list', '--porcelain'])) ?? ''
  const first = list.split('\n').find((l) => l.startsWith('worktree '))
  const mainCheckout = first ? first.slice('worktree '.length) : worktree ? dirname(commonAbs) : cwd
  const hasOrigin = (await tryGit(git, cwd, ['remote', 'get-url', 'origin'])) !== null
  const status = (await tryGit(git, cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], { maxBuffer: 64 * 1024 * 1024 })) ?? ''
  return { branch, head, defaultBranch: await defaultBranchOf(git, cwd), worktree, mainCheckout, hasOrigin, dirty: parsePorcelain(status) }
}

/** What the move confirm says. */
export async function previewBranch(cwd: string, git: GitRunner = runGit): Promise<SessionMovePreview> {
  const i = await inspectBranch(cwd, git)
  if (!i) return { branch: null, detached: false, worktree: false, dirty: 0, origin: false }
  return { branch: i.branch, detached: i.branch === null, worktree: i.worktree, dirty: i.dirty.length, origin: i.hasOrigin }
}

const DIRTY_CAP = 500

const mib = (n: number): string => `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`

const blobOf = (path: string): SessionMoveBlob => {
  const data = readFileSync(path)
  return { size: data.length, sha256: sha256(data), chunks: Math.max(1, Math.ceil(data.length / SESSION_MOVE_BLOB_CHUNK)) }
}

/** The patch of the uncommitted changes: tracked changes against HEAD, then every untracked file as a new file. Nothing on the source changes. */
export async function writePatch(cwd: string, untracked: readonly string[], out: string, git: GitRunner = runGit): Promise<number> {
  const big = { maxBuffer: SESSION_MOVE_PATCH_CAP + 1024 * 1024, timeoutMs: 120_000 }
  const parts: string[] = []
  const tracked = await git(cwd, ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD', '--'], big)
  if (tracked.stdout) parts.push(tracked.stdout)
  for (const rel of untracked) {
    // Exit 1 is "they differ", the normal answer for a new file.
    const r = await git(cwd, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', rel], { ...big, ok: [1] })
    if (r.stdout) parts.push(r.stdout)
  }
  const patch = parts.join('')
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
  writeFileSync(out, patch, { mode: 0o600 })
  return Buffer.byteLength(patch)
}

export interface PreparedBranch {
  inspection: BranchInspection
  /** The manifest's entry. `transport` is 'bundle' until `bundle()` finds nothing to send. */
  descriptor: SessionMoveBranch
  patchPath: string | null
  bundlePath: string | null
  bundle: SessionMoveBlob | null
  /** For a 'bundle' transport: build it once the receiver named what it holds. Answers null (and sets transport 'none') when it already holds the head. */
  makeBundle(have: readonly string[]): Promise<SessionMoveBlob | null>
  /** Switch to a bundle after the receiver could not fetch from origin. */
  fallBackToBundle(why: string): void
  frame(moveId: string, blob: 'bundle' | 'patch', chunk: number): SessionMoveBlobFrame
  dispose(): void
}

/** Read chunk `chunk` of a blob file. */
function readChunk(path: string, chunk: number, size: number): Buffer {
  const start = chunk * SESSION_MOVE_BLOB_CHUNK
  const len = Math.max(0, Math.min(SESSION_MOVE_BLOB_CHUNK, size - start))
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got)
      if (n === 0) break
      got += n
    }
  } finally {
    closeSync(fd)
  }
  return buf
}

/**
 * The source's branch step, before the manifest goes: inspect, push to origin
 * (when there is one), write the patch. `staging` is a private dir the blobs
 * are written into; `dispose()` removes it.
 */
export async function prepareBranch(
  cwd: string,
  staging: string,
  opts: { git?: GitRunner; push?: boolean; pushTimeoutMs?: number } = {}
): Promise<PreparedBranch | null> {
  const git = opts.git ?? runGit
  const inspection = await inspectBranch(cwd, git)
  if (!inspection) return null
  mkdirSync(staging, { recursive: true, mode: 0o700 })

  let transport: SessionMoveBranch['transport'] = 'bundle'
  let pushError: string | null = null
  if (inspection.branch && inspection.hasOrigin && opts.push !== false) {
    try {
      await git(cwd, ['push', '-u', 'origin', `${inspection.branch}:${inspection.branch}`], { timeoutMs: opts.pushTimeoutMs ?? 120_000 })
      transport = 'origin'
    } catch (err) {
      pushError = (err as Error).message.slice(0, 400)
    }
  } else if (inspection.branch && !inspection.hasOrigin) pushError = 'the repo has no origin'
  else if (!inspection.branch) pushError = 'HEAD is detached'

  let patch: SessionMoveBlob | null = null
  let patchPath: string | null = null
  let patchSkipped: string | null = null
  if (inspection.dirty.length) {
    // Untracked files are the `??` entries; `writePatch` diffs each against /dev/null.
    const status = (await tryGit(git, cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], { maxBuffer: 64 * 1024 * 1024 })) ?? ''
    const untrackedOnly = parsePorcelain(status.split('\0').filter((e) => e.startsWith('?? ')).join('\0') + '\0')
    const out = join(staging, 'changes.patch')
    try {
      const size = await writePatch(cwd, untrackedOnly, out, git)
      if (size > SESSION_MOVE_PATCH_CAP) {
        patchSkipped = `the uncommitted changes are ${mib(size)}, over the ${mib(SESSION_MOVE_PATCH_CAP)} a move carries`
        rmSync(out, { force: true })
      } else if (size > 0) {
        patch = blobOf(out)
        patchPath = out
      }
    } catch (err) {
      patchSkipped = `the patch could not be made: ${(err as Error).message}`.slice(0, 400)
      rmSync(out, { force: true })
    }
  }

  const descriptor: SessionMoveBranch = {
    branch: inspection.branch,
    head: inspection.head,
    defaultBranch: inspection.defaultBranch,
    worktree: inspection.worktree,
    mainCheckout: inspection.mainCheckout,
    transport,
    pushError,
    dirty: inspection.dirty.slice(0, DIRTY_CAP),
    dirtyMore: Math.max(0, inspection.dirty.length - DIRTY_CAP),
    patch,
    patchSkipped
  }

  const prepared: PreparedBranch = {
    inspection,
    descriptor,
    patchPath,
    bundlePath: null,
    bundle: null,
    async makeBundle(have) {
      if (have.includes(inspection.head)) {
        prepared.descriptor = { ...prepared.descriptor, transport: 'none' }
        return null
      }
      // Only commits this repo knows can be left out.
      const known: string[] = []
      for (const sha of have) if (COMMIT.test(sha) && (await tryGit(git, cwd, ['cat-file', '-e', `${sha}^{commit}`])) !== null) known.push(sha)
      const out = join(staging, 'branch.bundle')
      const ref = inspection.branch ? `refs/heads/${inspection.branch}` : 'HEAD'
      try {
        await git(cwd, ['bundle', 'create', out, ref, ...known.map((s) => `^${s}`)], { timeoutMs: 300_000 })
      } catch (err) {
        if (/empty bundle/i.test((err as Error).message)) {
          prepared.descriptor = { ...prepared.descriptor, transport: 'none' }
          return null
        }
        throw err
      }
      const size = statSync(out).size
      if (size > SESSION_MOVE_BUNDLE_CAP) {
        rmSync(out, { force: true })
        throw new Error(`the branch's commits are ${mib(size)} as a bundle, over the ${mib(SESSION_MOVE_BUNDLE_CAP)} a move carries; push the branch to origin first`)
      }
      prepared.bundlePath = out
      prepared.bundle = blobOf(out)
      prepared.descriptor = { ...prepared.descriptor, transport: 'bundle' }
      return prepared.bundle
    },
    fallBackToBundle(why) {
      prepared.descriptor = { ...prepared.descriptor, transport: 'bundle', pushError: why.slice(0, 400) }
    },
    frame(moveId, blob, chunk) {
      const path = blob === 'bundle' ? prepared.bundlePath : prepared.patchPath
      const meta = blob === 'bundle' ? prepared.bundle : prepared.descriptor.patch
      if (!path || !meta) throw new Error(`no ${blob} to send`)
      if (chunk < 0 || chunk >= meta.chunks) throw new Error(`no chunk ${chunk} of the ${blob}`)
      return { moveId, blob, chunk, chunks: meta.chunks, size: meta.size, sha256: meta.sha256, dataBase64: readChunk(path, chunk, meta.size).toString('base64') }
    },
    dispose() {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  return prepared
}

// ── the receiver ─────────────────────────────────────────────────────────

/** Chunks of a blob as they land, in `dir`; `finish()` checks and answers the whole file. */
export class BlobLanding {
  private readonly got = new Set<number>()
  private meta: { size: number; sha256: string; chunks: number } | null = null
  constructor(
    private readonly dir: string,
    readonly blob: 'bundle' | 'patch'
  ) {}

  take(frame: SessionMoveBlobFrame): void {
    const expected = Math.max(1, Math.ceil(frame.size / SESSION_MOVE_BLOB_CHUNK))
    if (frame.chunks !== expected || frame.chunk >= frame.chunks) throw new Error(`session.import.branch.chunk: ${this.blob} chunk out of range`)
    if (this.meta && (this.meta.size !== frame.size || this.meta.sha256 !== frame.sha256)) throw new Error(`session.import.branch.chunk: the ${this.blob} changed under the move`)
    this.meta = { size: frame.size, sha256: frame.sha256, chunks: frame.chunks }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(this.dir, String(frame.chunk)), Buffer.from(frame.dataBase64, 'base64'), { mode: 0o600 })
    this.got.add(frame.chunk)
  }

  get complete(): boolean {
    return !!this.meta && this.got.size === this.meta.chunks
  }

  /** The whole blob, checked against what the sender declared. */
  finish(declared: SessionMoveBlob): string {
    if (!this.meta || !this.complete) throw new Error(`session.import.branch.commit: the ${this.blob} is incomplete`)
    if (this.meta.size !== declared.size || this.meta.sha256 !== declared.sha256) throw new Error(`session.import.branch.commit: the ${this.blob} is not what was declared`)
    const data = Buffer.concat(Array.from({ length: this.meta.chunks }, (_, c) => readFileSync(join(this.dir, String(c)))))
    if (data.length !== declared.size || sha256(data) !== declared.sha256) throw new Error(`session.import.branch.commit: the ${this.blob} does not match its hash`)
    const out = join(this.dir, this.blob === 'bundle' ? 'branch.bundle' : 'changes.patch')
    writeFileSync(out, data, { mode: 0o600 })
    return out
  }
}

/** Every checkout of the repo at `projectCwd`: path and branch (null when detached), the main one first. */
async function checkoutsOf(git: GitRunner, projectCwd: string): Promise<{ dir: string; branch: string | null; head: string | null }[]> {
  const out: { dir: string; branch: string | null; head: string | null }[] = []
  const list = (await tryGit(git, projectCwd, ['worktree', 'list', '--porcelain'])) ?? ''
  let cur: { dir: string; branch: string | null; head: string | null } | null = null
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur)
      cur = { dir: line.slice('worktree '.length), branch: null, head: null }
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (cur && line.startsWith('branch refs/heads/')) cur.branch = line.slice('branch refs/heads/'.length)
  }
  if (cur) out.push(cur)
  return out
}

const isClean = async (git: GitRunner, dir: string): Promise<boolean> => ((await tryGit(git, dir, ['status', '--porcelain', '-z'], { maxBuffer: 64 * 1024 * 1024 })) ?? 'x').length === 0

/**
 * Where the branch lands here, decided before any part crosses; null when
 * `projectCwd` is not a git checkout (the thread lands there without a
 * branch, as before). `have` names the commits this host holds so a bundle
 * leaves them out.
 */
export async function planBranchLanding(projectCwd: string, b: SessionMoveBranch, git: GitRunner = runGit): Promise<SessionMoveBranchPlan | null> {
  const inside = await tryGit(git, projectCwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside?.trim() !== 'true') return null
  const have = new Set<string>()
  const add = (s: string | null): void => {
    const t = s?.trim()
    if (t && COMMIT.test(t)) have.add(t)
  }
  const mine = await defaultBranchOf(git, projectCwd)
  add(await tryGit(git, projectCwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']))
  if (mine) add(await tryGit(git, projectCwd, ['rev-parse', '--verify', '-q', `refs/heads/${mine}^{commit}`]))
  if (b.branch) {
    add(await tryGit(git, projectCwd, ['rev-parse', '--verify', '-q', `refs/heads/${b.branch}^{commit}`]))
    add(await tryGit(git, projectCwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${b.branch}^{commit}`]))
  }
  if ((await tryGit(git, projectCwd, ['cat-file', '-e', `${b.head}^{commit}`])) !== null) have.add(b.head)

  const checkouts = await checkoutsOf(git, projectCwd)
  const main = checkouts[0]
  const base = { project: projectCwd, have: [...have].slice(0, 16) }
  if (b.branch) {
    const holder = checkouts.find((c) => c.branch === b.branch && existsSync(c.dir))
    if (holder) return { ...base, mode: 'reuse', cwd: holder.dir, why: null }
  }
  const onDefault = !!main && !!main.branch && (main.branch === mine || main.branch === b.branch)
  const clean = await isClean(git, projectCwd)
  if (!b.worktree && b.branch && onDefault && clean) return { ...base, mode: 'checkout', cwd: projectCwd, why: null }
  const name = b.branch ? worktreeSlug(b.branch) : b.head.slice(0, 12)
  let cwd = join(projectCwd, '.claude', 'worktrees', name)
  // A dir of that name that is not a checkout of this repo (a leftover): the next free one.
  for (let n = 2; existsSync(cwd) && !checkouts.some((c) => same(c.dir, cwd)); n++) cwd = join(projectCwd, '.claude', 'worktrees', `${name}-${n}`)
  const why = b.worktree
    ? null
    : !b.branch
      ? 'HEAD was detached on the source'
      : !clean
        ? `${basename(projectCwd)} has uncommitted changes here`
        : `${basename(projectCwd)} is on ${main?.branch ?? 'a detached HEAD'} here, not ${mine ?? b.branch}`
  return { ...base, mode: 'worktree', cwd, why }
}

export interface LandBranchInput {
  projectCwd: string
  plan: SessionMoveBranchPlan
  branch: SessionMoveBranch
  transport: 'origin' | 'bundle' | 'none'
  bundlePath: string | null
  patchPath: string | null
  git?: GitRunner
  log?: (line: string) => void
}

/** The fetch could not bring the commit from origin: the source may try a bundle. */
export class BranchFetchFailed extends Error {}

const short = (sha: string): string => sha.slice(0, 10)

/** Fast-forward `dir`'s checked-out branch to `head`; false when it cannot. */
async function fastForward(git: GitRunner, dir: string, head: string): Promise<boolean> {
  const at = async (): Promise<string | undefined> => (await tryGit(git, dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim()
  if ((await at()) === head) return true
  if ((await tryGit(git, dir, ['merge', '--ff-only', '-q', head])) === null) return false
  // "Already up to date" when `head` is an ancestor: the checkout is ahead of the source, not at its commit.
  return (await at()) === head
}

/**
 * The receiver's branch step: fetch or unbundle, check out at the source's
 * commit where the plan says, apply the patch. Throws (and leaves nothing of
 * its own behind) when the commit cannot be brought here.
 */
export async function landBranch(input: LandBranchInput): Promise<SessionMoveBranchLanding> {
  const git = input.git ?? runGit
  const { projectCwd, plan, branch: b } = input
  const log = input.log ?? (() => {})
  const notes: string[] = []

  // 1. The commit.
  const haveIt = async (): Promise<boolean> => (await tryGit(git, projectCwd, ['cat-file', '-e', `${b.head}^{commit}`])) !== null
  if (!(await haveIt())) {
    if (input.transport === 'origin') {
      if (!b.branch) throw new BranchFetchFailed('origin carries no detached commit')
      try {
        await git(projectCwd, ['fetch', '--no-tags', 'origin', `+refs/heads/${b.branch}:refs/remotes/origin/${b.branch}`], { timeoutMs: 300_000 })
      } catch (err) {
        throw new BranchFetchFailed(`fetch from origin: ${(err as Error).message}`)
      }
      if (!(await haveIt())) throw new BranchFetchFailed(`origin/${b.branch} does not reach ${short(b.head)}`)
    } else if (input.transport === 'bundle') {
      if (!input.bundlePath) throw new Error('the branch step has no bundle')
      await git(projectCwd, ['bundle', 'verify', input.bundlePath], { timeoutMs: 300_000 })
      const ref = b.branch ? `refs/heads/${b.branch}` : 'HEAD'
      await git(projectCwd, ['fetch', '--no-tags', input.bundlePath, ref], { timeoutMs: 300_000 })
      if (!(await haveIt())) throw new Error(`the bundle does not reach ${short(b.head)}`)
    } else throw new Error(`this host does not hold ${short(b.head)} and nothing carried it`)
  }

  // 2. The checkout.
  let mode: SessionMoveBranchLanding['mode'] = plan.mode
  let cwd = plan.cwd
  let created = false
  const trackOrigin = async (dir: string): Promise<void> => {
    if (input.transport === 'origin' && b.branch) await tryGit(git, dir, ['branch', `--set-upstream-to=origin/${b.branch}`, b.branch])
  }
  const localBranch = async (): Promise<boolean> => !!b.branch && (await tryGit(git, projectCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${b.branch}`])) !== null
  const detachedWorktree = async (why: string): Promise<void> => {
    const name = b.branch ? worktreeSlug(b.branch) : b.head.slice(0, 12)
    let dir = join(projectCwd, '.claude', 'worktrees', name)
    for (let n = 2; existsSync(dir); n++) dir = join(projectCwd, '.claude', 'worktrees', `${name}-${n}`)
    mkdirSync(dirname(dir), { recursive: true })
    await git(projectCwd, ['worktree', 'add', '-q', '--detach', dir, b.head])
    mode = 'detached'
    cwd = dir
    created = true
    notes.push(why)
  }
  const previous = (await tryGit(git, projectCwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? null

  if (plan.mode === 'reuse') {
    if (!existsSync(cwd)) throw new Error(`${cwd} is gone`)
    if (await isClean(git, cwd)) {
      if (!(await fastForward(git, cwd, b.head))) notes.push(`${b.branch} here has commits of its own; the thread is on it at ${short((await tryGit(git, cwd, ['rev-parse', 'HEAD']))?.trim() ?? '')}, not ${short(b.head)}`)
    } else notes.push(`${b.branch} is checked out here with uncommitted changes; it stays at its own commit`)
  } else if (plan.mode === 'checkout') {
    const current = previous
    if (current === b.branch) {
      if (!(await fastForward(git, projectCwd, b.head))) await detachedWorktree(`${b.branch} here has commits of its own, so the thread runs on a detached checkout at ${short(b.head)}`)
    } else if (await localBranch()) {
      await git(projectCwd, ['checkout', '-q', b.branch!])
      if (!(await fastForward(git, projectCwd, b.head))) {
        if (current) await tryGit(git, projectCwd, ['checkout', '-q', current])
        await detachedWorktree(`${b.branch} here has commits of its own, so the thread runs on a detached checkout at ${short(b.head)}`)
      }
    } else {
      await git(projectCwd, ['checkout', '-q', '-b', b.branch!, b.head])
      await trackOrigin(projectCwd)
    }
  } else {
    mkdirSync(dirname(cwd), { recursive: true })
    await tryGit(git, projectCwd, ['worktree', 'prune'])
    if (!b.branch) {
      await git(projectCwd, ['worktree', 'add', '-q', '--detach', cwd, b.head])
      mode = 'detached'
      created = true
    } else if (await localBranch()) {
      await git(projectCwd, ['worktree', 'add', '-q', cwd, b.branch])
      created = true
      if (!(await fastForward(git, cwd, b.head))) {
        await tryGit(git, projectCwd, ['worktree', 'remove', '--force', cwd])
        created = false
        await detachedWorktree(`${b.branch} here has commits of its own, so the thread runs on a detached checkout at ${short(b.head)}`)
      }
    } else {
      await git(projectCwd, ['worktree', 'add', '-q', '-b', b.branch, cwd, b.head])
      created = true
      await trackOrigin(projectCwd)
    }
  }
  log(`branch ${b.branch ?? short(b.head)} landed at ${cwd} (${mode}${created ? ', made' : ''})`)

  // 3. The patch.
  let patch: SessionMoveBranchLanding['patch'] = 'none'
  let patchPath: string | null = null
  if (input.patchPath && b.patch) {
    const cleanBefore = await isClean(git, cwd)
    const applied = await applyPatch(git, cwd, input.patchPath, cleanBefore)
    if (applied === 'applied') patch = 'applied'
    else {
      patchPath = join(cwd, '.temp-code', 'moved-changes.patch')
      mkdirSync(dirname(patchPath), { recursive: true })
      writeFileSync(patchPath, readFileSync(input.patchPath))
      await ensureLocalExclude(cwd)
      patch = 'kept'
      notes.push(`the uncommitted changes did not apply (${applied}); the patch is at ${patchPath}`)
    }
  }
  return { branch: b.branch, head: b.head, mode, cwd, created, patch, patchPath, note: notes.length ? notes.join('. ') : null }
}

/** `git apply`, atomic first, then `--3way` on a clean tree; 'applied' or the reason. A failure leaves the tree as it was. */
async function applyPatch(git: GitRunner, cwd: string, patchPath: string, clean: boolean): Promise<'applied' | string> {
  const big = { maxBuffer: SESSION_MOVE_PATCH_CAP + 1024 * 1024, timeoutMs: 300_000 }
  try {
    await git(cwd, ['apply', '--check', patchPath], big)
    await git(cwd, ['apply', patchPath], big)
    return 'applied'
  } catch (err) {
    const why = (err as Error).message
    if (!clean) return why
    // Nothing of the receiver's is in this tree: a 3-way attempt may still land it, and a failed one is undone.
    try {
      await git(cwd, ['apply', '--3way', patchPath], big)
      return 'applied'
    } catch (err3) {
      await tryGit(git, cwd, ['reset', '-q', '--hard'])
      const summary = (await tryGit(git, cwd, ['apply', '--summary', patchPath], big)) ?? ''
      for (const line of summary.split('\n')) {
        const m = /^ create mode \d+ (.+)$/.exec(line)
        if (m) rmSync(join(cwd, m[1]), { force: true })
      }
      return (err3 as Error).message || why
    }
  }
}

/** An aborted move: a worktree the move made goes; a checkout it switched goes back when the tree is clean. */
export async function undoBranchLanding(projectCwd: string, landing: SessionMoveBranchLanding, previousBranch: string | null, git: GitRunner = runGit): Promise<void> {
  if (landing.created && existsSync(landing.cwd)) {
    await tryGit(git, projectCwd, ['worktree', 'remove', '--force', landing.cwd])
    rmSync(landing.cwd, { recursive: true, force: true })
    await tryGit(git, projectCwd, ['worktree', 'prune'])
  } else if (landing.mode === 'checkout' && previousBranch && previousBranch !== landing.branch) {
    // The applied patch is the thread's work: it stays; only a clean checkout goes back.
    if (await isClean(git, projectCwd)) await tryGit(git, projectCwd, ['checkout', '-q', previousBranch])
  }
}
