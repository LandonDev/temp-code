import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FileChange } from '@shared/domain'

const execFileP = promisify(execFile)

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

/**
 * Create a project worktree off the workspace repo. Returns {cwd, branch}.
 * baseRef picks the new branch's fork point (default: repo HEAD);
 * existingBranch adopts a branch instead of creating tc/<slug> — "open my
 * PR branch as a project".
 */
export async function addProjectWorktree(
  repoPath: string,
  name: string,
  opts: { baseRef?: string; existingBranch?: string } = {}
): Promise<{ cwd: string; branch: string }> {
  const base = join(homedir(), '.temp-code', 'worktrees')
  mkdirSync(base, { recursive: true })
  let slug = slugify(name)
  let dir = join(base, slug)
  if (opts.existingBranch) {
    // A remote pick (origin/foo) checks out a local tracking branch `foo`.
    const local = opts.existingBranch.replace(/^origin\//, '')
    for (let n = 2; n < 20; n++) {
      try {
        await execFileP('git', ['-C', repoPath, 'worktree', 'add', dir, local])
        return { cwd: dir, branch: local }
      } catch (err) {
        const msg = String(err)
        if (!msg.includes('already exists')) throw err
        slug = `${slugify(name)}-${n}`
        dir = join(base, slug)
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
export async function log(
  dir: string,
  limit: number
): Promise<{ sha: string; subject: string; authoredAt: number }[]> {
  if (!(await isGitRepo(dir))) return []
  try {
    const { stdout } = await execFileP('git', [
      '-C',
      dir,
      'log',
      `-${Math.max(1, Math.min(limit, 100))}`,
      '--format=%H%x00%s%x00%at'
    ])
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, at] = line.split('\0')
        return { sha, subject, authoredAt: Number(at) * 1000 }
      })
  } catch {
    return [] // fresh repo with no commits yet
  }
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

/** `git show HEAD:<path>` — the diff surface's left side. Null when the
 *  path is new (untracked/added): the diff renders against empty. */
export async function showHead(dir: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'show', `HEAD:${path}`], {
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
