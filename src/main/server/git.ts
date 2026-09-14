import { execFileBudgeted as execFileP } from './spawnBudget'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { CommitInfo, CompareResult, FileChange, MergeResult } from '@shared/domain'


export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileP('git', ['-C', dir, 'rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'project'

/** Whether `branch` exists as a local branch or on any remote. */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const local = branch.replace(/^origin\//, '')
  for (const ref of [`refs/heads/${local}`, `refs/remotes/origin/${local}`]) {
    try {
      await execFileP('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', ref])
      return true
    } catch {
      // keep looking
    }
  }
  return false
}

/** Every checkout of `dir`'s repo (main checkout first): its path and the
 *  branch it holds (null when detached). */
export async function checkouts(dir: string): Promise<{ dir: string; branch: string | null }[]> {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'worktree', 'list', '--porcelain'])
    const all: { dir: string; branch: string | null }[] = []
    let cur: { dir: string; branch: string | null } | null = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) all.push(cur)
        cur = { dir: line.slice(9), branch: null }
      } else if (cur && line.startsWith('branch refs/heads/')) {
        cur.branch = line.slice('branch refs/heads/'.length)
      }
    }
    if (cur) all.push(cur)
    return all
  } catch {
    return []
  }
}

/** The worktree (if any) that has `branch` checked out. */
async function worktreeOf(repoPath: string, branch: string): Promise<string | null> {
  return (await checkouts(repoPath)).find((c) => c.branch === branch)?.dir ?? null
}

/**
 * Worktrees of `dir`'s repo that nothing accounts for: not a known dir
 * (project checkouts, workspace paths), not app-managed (everything the
 * app creates lives under ~/.temp-code/worktrees). These are what a
 * skill's own git flow leaves behind mid-turn.
 */
export async function strayWorktrees(
  dir: string,
  knownDirs: string[]
): Promise<{ dir: string; branch: string | null }[]> {
  const canon = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const known = new Set(knownDirs.map(canon))
  const managedRoots = ['worktrees', 'builds'].map(
    (d) => canon(join(homedir(), '.temp-code', d)) + sep
  )
  return (await checkouts(dir)).filter((w) => {
    const c = canon(w.dir)
    return !known.has(c) && !managedRoots.some((root) => c.startsWith(root))
  })
}

/**
 * Create a project worktree off the workspace repo. Returns {cwd, branch}.
 * opts.branch is the branch the worktree targets: adopted when it exists
 * (locally or on origin), created from opts.baseRef (default: repo HEAD)
 * when it doesn't. No branch given → auto tc/<slug> from baseRef.
 */
export async function addProjectWorktree(
  repoPath: string,
  name: string,
  opts: { branch?: string; baseRef?: string } = {}
): Promise<{ cwd: string; branch: string }> {
  const base = join(homedir(), '.temp-code', 'worktrees')
  mkdirSync(base, { recursive: true })
  // Registrations whose directory is gone would fail every add below.
  await execFileP('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {})
  let slug = slugify(name)
  let dir = join(base, slug)
  if (opts.branch) {
    // A remote pick (origin/foo) checks out a local tracking branch `foo`.
    const branch = opts.branch.replace(/^origin\//, '')
    const exists = await branchExists(repoPath, branch)
    if (exists) {
      // Already checked out somewhere (e.g. a deleted project's leftover
      // worktree) — reuse that checkout; a second one is impossible anyway.
      const current = await worktreeOf(repoPath, branch)
      if (current) return { cwd: current, branch }
    }
    const args = exists ? [dir, branch] : [dir, '-b', branch, ...(opts.baseRef ? [opts.baseRef] : [])]
    for (let n = 2; n < 20; n++) {
      try {
        await execFileP('git', ['-C', repoPath, 'worktree', 'add', ...args])
        return { cwd: dir, branch }
      } catch (err) {
        const msg = String(err)
        if (msg.includes(`branch named '${branch}' already exists`)) {
          // A previous attempt created the branch before failing on its
          // directory (git makes the branch first) — adopt it instead of
          // burning every retry on the same -b failure.
          args.splice(1, args.length - 1, branch)
        } else if (msg.includes('already exists')) {
          slug = `${slugify(name)}-${n}`
          dir = join(base, slug)
          args[0] = dir
        } else {
          throw err
        }
      }
    }
    throw new Error('could not allocate a worktree directory')
  }
  let branch = `tc/${slug}`
  // Dodge collisions with an existing worktree/branch of the same name.
  for (let n = 2; n < 20; n++) {
    try {
      await execFileP('git', [
        '-C',
        repoPath,
        'worktree',
        'add',
        dir,
        '-b',
        branch,
        ...(opts.baseRef ? [opts.baseRef] : [])
      ])
      return { cwd: dir, branch }
    } catch (err) {
      const msg = String(err)
      if (!msg.includes('already exists')) throw err
      slug = `${slugify(name)}-${n}`
      dir = join(base, slug)
      branch = `tc/${slug}`
    }
  }
  throw new Error('could not allocate a worktree name')
}

/** git's stderr beats "exit 1" in a dialog. */
const surfacing = (err: unknown): Error => {
  const e = err as { stderr?: string; message?: string }
  return new Error((e.stderr || e.message || String(err)).trim())
}

/** Switch a project checkout to another branch: an existing name checks
 *  out (a remote pick gets a local tracking branch), a new one is created
 *  from `baseRef` (default: current HEAD). Uncommitted changes ride along
 *  when git allows it; a conflict or a branch another worktree holds
 *  fails with git's own message. Returns the local branch name. */
export async function switchBranch(
  dir: string,
  branch: string,
  opts: { baseRef?: string } = {}
): Promise<string> {
  const local = branch.replace(/^origin\//, '')
  const exists = await branchExists(dir, local)
  const args = exists
    ? ['checkout', local]
    : ['checkout', '-b', local, ...(opts.baseRef ? [opts.baseRef] : [])]
  try {
    await execFileP('git', ['-C', dir, ...args])
  } catch (err) {
    throw surfacing(err)
  }
  return local
}

/** Remove a project worktree from disk and git's registry. Each teardown
 *  step treats "already gone" as done — a retry after a partial cleanup
 *  must sail through the steps that succeeded the first time. */
export async function removeWorktree(repoPath: string, dir: string): Promise<void> {
  try {
    await execFileP('git', ['-C', repoPath, 'worktree', 'remove', '--force', dir])
  } catch (err) {
    const msg = String(err)
    if (msg.includes('is not a working tree')) return // already removed
    // Folder already gone by hand — drop the stale registration instead.
    if (!msg.includes('No such file')) throw surfacing(err)
    await execFileP('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {})
  }
}

export async function deleteLocalBranch(repoPath: string, branch: string): Promise<void> {
  await execFileP('git', ['-C', repoPath, 'branch', '-D', branch]).catch((err) => {
    if (String(err).includes('not found')) return
    throw surfacing(err)
  })
}

export async function deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
  await execFileP('git', ['-C', repoPath, 'push', 'origin', '--delete', branch], {
    maxBuffer: 4 * 1024 * 1024
  }).catch((err) => {
    // Never pushed (or already deleted) — the desired state holds.
    if (String(err).includes('remote ref does not exist')) return
    throw surfacing(err)
  })
}

/** App-managed files (plan docs) — never user-facing "changes". */
const isAppPath = (path: string): boolean => path.startsWith('.temp-code/')

/** Ignore `.temp-code/` locally (info/exclude — never touches the tracked
 *  .gitignore). Worktrees share the common git dir, so one write covers all. */
export async function ensureLocalExclude(dir: string): Promise<void> {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--git-common-dir'])
    const excludePath = join(
      stdout.trim().startsWith('/') ? stdout.trim() : join(dir, stdout.trim()),
      'info',
      'exclude'
    )
    const { readFile, writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(excludePath, '..'), { recursive: true })
    const current = await readFile(excludePath, 'utf8').catch(() => '')
    if (!current.includes('.temp-code/')) {
      await writeFile(
        excludePath,
        `${current}${current.endsWith('\n') || !current ? '' : '\n'}.temp-code/\n`
      )
    }
  } catch {
    // not a repo — nothing to exclude
  }
}

/** Changed files vs HEAD, plus untracked — what the Changes rail shows. */
export async function workingTreeChanges(dir: string): Promise<FileChange[]> {
  if (!(await isGitRepo(dir))) return []
  const changes = new Map<string, FileChange>()
  const { stdout: numstat } = await execFileP('git', ['-C', dir, 'diff', 'HEAD', '--numstat'])
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    changes.set(m[3], {
      path: m[3],
      adds: m[1] === '-' ? 0 : Number(m[1]),
      dels: m[2] === '-' ? 0 : Number(m[2]),
      status: 'modified'
    })
  }
  const { stdout: status } = await execFileP('git', ['-C', dir, 'status', '--porcelain'])
  for (const line of status.split('\n')) {
    if (!line) continue
    const code = line.slice(0, 2)
    const path = line.slice(3).replace(/^"|"$/g, '')
    if (code === '??') {
      changes.set(path, { path, adds: 0, dels: 0, status: 'untracked' })
    } else if (code.includes('D')) {
      const cur = changes.get(path)
      if (cur) changes.set(path, { ...cur, status: 'deleted' })
    } else if (code.includes('A')) {
      const cur = changes.get(path)
      if (cur) changes.set(path, { ...cur, status: 'added' })
    } else if (code.startsWith('R')) {
      const target = path.split(' -> ').pop() ?? path
      const cur = changes.get(target)
      changes.set(
        target,
        cur ? { ...cur, status: 'renamed' } : { path: target, adds: 0, dels: 0, status: 'renamed' }
      )
    }
  }
  return [...changes.values()]
    .filter((c) => !isAppPath(c.path))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** Every tracked + untracked-but-not-ignored path (@-mention autocomplete). */
export async function listFiles(dir: string, cap = 5000): Promise<string[]> {
  if (!(await isGitRepo(dir))) return []
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 8 * 1024 * 1024 }
    )
    return stdout
      .split('\n')
      .filter((p) => p && !isAppPath(p))
      .slice(0, cap)
  } catch {
    return []
  }
}

// ── commit & push (docs/PLAN-3.md M12) ───────────────────────────────
// Always `git -C <project cwd>`: a worktree project is a checkout of its
// own branch, so nothing here can touch the user's other checkouts.
// Identity, hooks, and signing come from the user's normal git config;
// errors surface verbatim — no retry magic.

/** Stage the given paths (or everything) and commit. */
export async function commit(
  dir: string,
  message: string,
  paths?: string[]
): Promise<{ sha: string; summary: string }> {
  if (paths && paths.length) {
    // -A limited to pathspecs stages edits, adds, AND deletions of just
    // those paths — the checkbox list is the commit.
    await execFileP('git', ['-C', dir, 'add', '-A', '--', ...paths])
    await execFileP('git', ['-C', dir, 'commit', '-m', message, '--', ...paths])
  } else {
    await execFileP('git', ['-C', dir, 'add', '-A'])
    await execFileP('git', ['-C', dir, 'commit', '-m', message])
  }
  const { stdout } = await execFileP('git', ['-C', dir, 'log', '-1', '--format=%H%x00%s'])
  const [sha, summary] = stdout.trim().split('\0')
  return { sha, summary }
}

/** Push the project branch, or the same work onto a different remote branch. */
export async function push(
  dir: string,
  targetBranch?: string
): Promise<{ remote: string; branch: string }> {
  const branch = await currentBranch(dir)
  if (!branch || branch === 'HEAD') throw new Error('no branch checked out')
  const refspec = targetBranch ? `HEAD:${targetBranch}` : branch
  const args = targetBranch
    ? ['-C', dir, 'push', 'origin', refspec]
    : ['-C', dir, 'push', '-u', 'origin', refspec]
  try {
    await execFileP('git', args, { maxBuffer: 4 * 1024 * 1024 })
  } catch (err) {
    // git writes rejection detail to stderr — surface it, not "exit 1".
    const e = err as { stderr?: string; message?: string }
    throw new Error((e.stderr || e.message || String(err)).trim())
  }
  return { remote: 'origin', branch: targetBranch ?? branch }
}

/** Recent commits on the checked-out branch — the rail's history list. */
export async function log(dir: string, limit: number): Promise<CommitInfo[]> {
  if (!(await isGitRepo(dir))) return []
  return logRange(dir, [], limit).catch(() => []) // fresh repo with no commits yet
}

async function logRange(dir: string, range: string[], limit: number): Promise<CommitInfo[]> {
  const { stdout } = await execFileP('git', [
    '-C',
    dir,
    'log',
    `-${Math.max(1, Math.min(limit, 100))}`,
    '--format=%H%x00%s%x00%at',
    ...range
  ])
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, at] = line.split('\0')
      return { sha, subject, authoredAt: Number(at) * 1000 }
    })
}

/** Local + remote branch names (pickers), current checkout marked. */
export async function branches(
  dir: string
): Promise<{ locals: string[]; remotes: string[]; current: string | null }> {
  const { stdout: loc } = await execFileP('git', [
    '-C',
    dir,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads'
  ])
  const { stdout: rem } = await execFileP('git', [
    '-C',
    dir,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes'
  ])
  return {
    locals: loc.split('\n').filter(Boolean),
    remotes: rem.split('\n').filter((b) => b && !b.endsWith('/HEAD')),
    current: await currentBranch(dir)
  }
}

/** Commits ahead of the upstream (the `↑n` next to the branch name). */
export async function aheadCount(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP('git', [
      '-C',
      dir,
      'rev-list',
      '--count',
      '@{upstream}..HEAD'
    ])
    return Number(stdout.trim())
  } catch {
    return null // no upstream yet — the whole branch is unpushed
  }
}

/** `git show <ref>:<path>` — the diff surface's left side. Null when the
 *  path is absent there (untracked/added): the diff renders against empty. */
export async function showRef(dir: string, path: string, ref = 'HEAD'): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'show', `${ref}:${path}`], {
      maxBuffer: 8 * 1024 * 1024
    })
    return stdout
  } catch {
    return null
  }
}

export async function fileDiff(dir: string, path: string): Promise<string> {
  if (!(await isGitRepo(dir))) return ''
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'diff', 'HEAD', '--', path], {
      maxBuffer: 4 * 1024 * 1024
    })
    if (stdout.trim()) return stdout
    // Untracked file: synthesize an all-adds diff.
    const { stdout: untracked } = await execFileP(
      'git',
      ['-C', dir, 'diff', '--no-index', '--', '/dev/null', path],
      { maxBuffer: 4 * 1024 * 1024 }
    ).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }))
    return untracked
  } catch {
    return ''
  }
}

/** Last editor of a line range + how many others touched it (Code Vision).
 *  Uncommitted lines blame as "you". Untracked/error → null. */
export async function blameRange(
  dir: string,
  path: string,
  startLine: number,
  endLine: number
): Promise<{ author: string | null; others: number }> {
  try {
    const { stdout } = await execFileP('git', [
      '-C',
      dir,
      'blame',
      '-L',
      `${startLine},${endLine}`,
      '--line-porcelain',
      '--',
      path
    ])
    const authors = new Map<string, number>() // author → latest time
    let author: string | null = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('author ')) author = line.slice(7).trim()
      else if (line.startsWith('author-time ') && author) {
        const t = Number(line.slice(12))
        const name = author === 'Not Committed Yet' ? 'you' : author
        authors.set(name, Math.max(authors.get(name) ?? 0, t))
        author = null
      }
    }
    if (authors.size === 0) return { author: null, others: 0 }
    const latest = [...authors.entries()].sort((a, b) => b[1] - a[1])[0][0]
    return { author: latest, others: authors.size - 1 }
  } catch {
    return { author: null, others: 0 }
  }
}

// ── branch compare & merge (Branch rail) ─────────────────────────────
// Compare the project checkout against a target branch, bring the target
// in (merge/rebase), or land the branch on the target. Conflicts never
// leave a half-merged tree: the operation aborts and reports the files.

/** Never let git open an editor or prompt for credentials under the app. */
const quietGit = { GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' }
const gitOpts = { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...quietGit } }

const rev = async (dir: string, ref: string): Promise<string> =>
  (await execFileP('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))
    .stdout.trim()

async function refExists(dir: string, ref: string): Promise<boolean> {
  return rev(dir, ref).then(
    () => true,
    () => false
  )
}

/** The branch a compare defaults to: origin's HEAD, else main/master (a
 *  local head first, else its origin ref), else the first other local branch. */
export async function defaultTarget(dir: string): Promise<string> {
  const current = await currentBranch(dir)
  const candidates: string[] = []
  try {
    const { stdout } = await execFileP('git', [
      '-C',
      dir,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD'
    ])
    candidates.push(stdout.trim().replace(/^origin\//, ''))
  } catch {
    // no origin/HEAD
  }
  candidates.push('main', 'master')
  for (const name of candidates) {
    if (!name || name === current) continue
    if (await refExists(dir, `refs/heads/${name}`)) return name
    if (await refExists(dir, `refs/remotes/origin/${name}`)) return `origin/${name}`
  }
  const { locals } = await branches(dir)
  return locals.find((b) => b !== current) ?? 'main'
}

/** Tracked changes present (staged or not)? Untracked files don't count —
 *  git refuses on its own when a merge would overwrite one. */
export async function isClean(dir: string): Promise<boolean> {
  const { stdout } = await execFileP('git', [
    '-C',
    dir,
    'status',
    '--porcelain',
    '--untracked-files=no'
  ])
  return stdout.split('\n').every((l) => !l || isAppPath(l.slice(3).replace(/^"|"$/g, '')))
}

/** Files that differ between two commits (this branch vs its merge base). */
async function diffFiles(dir: string, from: string, to: string): Promise<FileChange[]> {
  const out = new Map<string, FileChange>()
  const { stdout: numstat } = await execFileP(
    'git',
    ['-C', dir, 'diff', '--numstat', '-M', from, to],
    gitOpts
  )
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    // renames print as "old => new" or "{a => b}/rest"; keep the new name
    const path = m[3].includes(' => ')
      ? m[3].replace(/\{([^}]*) => ([^}]*)\}/, '$2').replace(/^.* => /, '')
      : m[3]
    out.set(path, {
      path,
      adds: m[1] === '-' ? 0 : Number(m[1]),
      dels: m[2] === '-' ? 0 : Number(m[2]),
      status: 'modified'
    })
  }
  const { stdout: names } = await execFileP(
    'git',
    ['-C', dir, 'diff', '--name-status', '-M', from, to],
    gitOpts
  )
  for (const line of names.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const code = parts[0][0]
    const path = parts[parts.length - 1]
    const cur = out.get(path) ?? { path, adds: 0, dels: 0, status: 'modified' as const }
    const status: FileChange['status'] =
      code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified'
    out.set(path, { ...cur, status })
  }
  return [...out.values()]
    .filter((c) => !isAppPath(c.path))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** This checkout vs `target` (default: defaultTarget). Unknown target throws. */
export async function compare(dir: string, target?: string): Promise<CompareResult> {
  const t = target ?? (await defaultTarget(dir))
  if (!(await refExists(dir, t))) throw new Error(`unknown branch: ${t}`)
  let mergeBase: string
  try {
    mergeBase = (await execFileP('git', ['-C', dir, 'merge-base', t, 'HEAD'])).stdout.trim()
  } catch (err) {
    throw surfacing(err)
  }
  const { stdout: counts } = await execFileP('git', [
    '-C',
    dir,
    'rev-list',
    '--left-right',
    '--count',
    `${t}...HEAD`
  ])
  const [behind, ahead] = counts.trim().split(/\s+/).map(Number)
  const [ours, theirs, files] = await Promise.all([
    logRange(dir, [`${t}..HEAD`], 50),
    logRange(dir, [`HEAD..${t}`], 50),
    diffFiles(dir, mergeBase, 'HEAD')
  ])
  return { target: t, mergeBase, ahead, behind, ours, theirs, files }
}

async function conflictedFiles(dir: string): Promise<string[]> {
  const { stdout } = await execFileP('git', [
    '-C',
    dir,
    'diff',
    '--name-only',
    '--diff-filter=U'
  ]).catch(() => ({ stdout: '' }))
  return stdout.split('\n').filter(Boolean)
}

/** Run a merge/rebase in `dir`; on failure abort it and report conflicts,
 *  or rethrow git's message when nothing conflicted (a real error). */
async function runOrAbort(
  dir: string,
  mode: 'merge' | 'rebase',
  args: string[]
): Promise<MergeResult | null> {
  try {
    await execFileP('git', ['-C', dir, mode, ...args], gitOpts)
    return null
  } catch (err) {
    const conflicts = await conflictedFiles(dir)
    await execFileP('git', ['-C', dir, mode, '--abort'], gitOpts).catch(() => {})
    if (conflicts.length) return { ok: false, conflicts }
    throw surfacing(err)
  }
}

const isMergeCommit = (dir: string): Promise<boolean> => refExists(dir, 'HEAD^2')

/** Bring `target` into this checkout by merge or rebase. */
export async function mergeFrom(
  dir: string,
  target: string,
  mode: 'merge' | 'rebase'
): Promise<MergeResult> {
  if (!(await refExists(dir, target))) throw new Error(`unknown branch: ${target}`)
  if (!(await isClean(dir))) throw new Error('Commit or stash your changes first')
  const failed = await runOrAbort(dir, mode, mode === 'merge' ? ['--no-edit', target] : [target])
  if (failed) return failed
  const sha = await rev(dir, 'HEAD')
  return { ok: true, sha, fastForward: mode === 'merge' && !(await isMergeCommit(dir)) }
}

/** merge-tree's conflicted-file section (--name-only): after the tree
 *  line, one path per line up to the first blank line. */
function parseMergeTreeConflicts(stdout: string): string[] {
  const lines = stdout.split('\n').slice(1)
  const end = lines.indexOf('')
  const files = (end === -1 ? lines : lines.slice(0, end)).filter(Boolean)
  return files.length ? [...new Set(files)] : ['conflicts (details in git)']
}

/** Land this branch on local branch `target`. When a checkout holds the
 *  target the merge runs there (it must be clean); otherwise the merge
 *  happens with merge-tree and the ref moves without touching any tree. */
export async function mergeInto(dir: string, target: string): Promise<MergeResult> {
  const source = await currentBranch(dir)
  if (!source || source === 'HEAD') throw new Error('no branch checked out')
  if (!(await refExists(dir, `refs/heads/${target}`)))
    throw new Error(`${target} is not a local branch`)
  const holder = await worktreeOf(dir, target)
  if (holder) {
    if (!(await isClean(holder)))
      throw new Error(`${target} is checked out at ${holder} with uncommitted changes`)
    const failed = await runOrAbort(holder, 'merge', ['--no-edit', source])
    if (failed) return failed
    const sha = await rev(holder, 'HEAD')
    return { ok: true, sha, fastForward: !(await isMergeCommit(holder)), where: holder }
  }
  const head = await rev(dir, 'HEAD')
  const tip = await rev(dir, `refs/heads/${target}`)
  const { stdout: baseOut } = await execFileP('git', ['-C', dir, 'merge-base', target, 'HEAD'])
  const base = baseOut.trim()
  if (base === head) return { ok: true, sha: tip, fastForward: true } // nothing to land
  const moveRef = (sha: string): Promise<unknown> =>
    execFileP('git', ['-C', dir, 'update-ref', `refs/heads/${target}`, sha, tip], gitOpts)
  if (base === tip) {
    await moveRef(head).catch((err) => {
      throw surfacing(err)
    })
    return { ok: true, sha: head, fastForward: true }
  }
  let treeOut: string
  try {
    treeOut = (
      await execFileP(
        'git',
        ['-C', dir, 'merge-tree', '--write-tree', '--name-only', target, 'HEAD'],
        gitOpts
      )
    ).stdout
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    if (e.code === 1 && e.stdout) return { ok: false, conflicts: parseMergeTreeConflicts(e.stdout) }
    throw surfacing(err)
  }
  const tree = treeOut.split('\n')[0].trim()
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', dir, 'commit-tree', tree, '-p', tip, '-p', head, '-m', `Merge ${source} into ${target}`],
      gitOpts
    )
    const sha = stdout.trim()
    await moveRef(sha)
    return { ok: true, sha, fastForward: false }
  } catch (err) {
    throw surfacing(err)
  }
}
