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

/** Create a project worktree off the workspace repo. Returns {cwd, branch}. */
export async function addProjectWorktree(
  repoPath: string,
  name: string
): Promise<{ cwd: string; branch: string }> {
  const base = join(homedir(), '.temp-code', 'worktrees')
  mkdirSync(base, { recursive: true })
  let slug = slugify(name)
  let dir = join(base, slug)
  let branch = `tc/${slug}`
  // Dodge collisions with an existing worktree/branch of the same name.
  for (let n = 2; n < 20; n++) {
    try {
      await execFileP('git', ['-C', repoPath, 'worktree', 'add', dir, '-b', branch])
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
      changes.set(target, cur ? { ...cur, status: 'renamed' } : { path: target, adds: 0, dels: 0, status: 'renamed' })
    }
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export async function fileDiff(dir: string, path: string): Promise<string> {
  if (!(await isGitRepo(dir))) return ''
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', dir, 'diff', 'HEAD', '--', path],
      { maxBuffer: 4 * 1024 * 1024 }
    )
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
