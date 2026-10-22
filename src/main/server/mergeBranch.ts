import { execFileBudgeted } from './spawnBudget'

/**
 * The git side of merge_branch (mergeReview.ts runs the review around it):
 * what a branch brings to the project branch, and the fast-forward that
 * lands it. Every call names the repo checkout it runs in; nothing here
 * reads the registry.
 */

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileBudgeted('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}
const gitOk = async (cwd: string, args: string[]): Promise<boolean> => {
  try {
    await git(cwd, args)
    return true
  } catch {
    return false
  }
}

/** The branch a checkout is on, null when detached or not a repo. */
export async function branchOf(cwd: string): Promise<string | null> {
  try {
    const out = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return out && out !== 'HEAD' ? out : null
  } catch {
    return null
  }
}

/** The repo's default branch: origin/HEAD's target, else master or main,
 *  whichever exists locally. */
export async function defaultBranchOf(cwd: string): Promise<string | null> {
  try {
    const ref = (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    const name = ref.replace(/^origin\//, '')
    if (name) return name
  } catch {
    /* no origin/HEAD */
  }
  for (const name of ['master', 'main']) {
    if (await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name
  }
  return null
}

/** The worktree where `branch` is checked out, if any (the main checkout counts). */
export async function worktreeOf(cwd: string, branch: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['worktree', 'list', '--porcelain'])
    let path: string | null = null
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      else if (line === `branch refs/heads/${branch}` && path) return path
    }
  } catch {
    /* not a repo */
  }
  return null
}

export const DIFF_CAP_BYTES = 400_000
export const LOG_CAP_BYTES = 20_000

/** What the reviewer reads: the branch's diff against its merge-base with
 *  the target, the commits it adds, and the counts a card can show. */
export interface MergeBundle {
  cwd: string
  branch: string
  target: string
  /** the ref the diff is taken against: merge-base(target, branch), or
   *  origin/<target> when the branch IS the target (unpushed work) */
  base: string
  head: string
  diff: string
  diffTruncated: boolean
  commits: string
  files: string[]
  /** nothing to merge: the branch is already in the target */
  empty: boolean
}

export class MergeRefusal extends Error {}

/**
 * The bundle for a branch, refusing what cannot be reviewed or merged:
 * a missing branch, a target that is not a branch, a branch that is the
 * target with nothing unpushed.
 */
export async function buildMergeBundle(cwd: string, branch: string, target: string): Promise<MergeBundle> {
  if (!(await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))) {
    throw new MergeRefusal(`branch "${branch}" does not exist in ${cwd}`)
  }
  let base: string
  if (branch === target) {
    // Nothing to merge; the review covers what the push would carry.
    const upstream = `refs/remotes/origin/${target}`
    if (!(await gitOk(cwd, ['rev-parse', '--verify', '--quiet', upstream]))) {
      throw new MergeRefusal(`"${branch}" is the target branch and has no origin/${target} to compare against — nothing to review`)
    }
    base = (await git(cwd, ['merge-base', upstream, branch])).trim()
  } else {
    if (!(await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`]))) {
      throw new MergeRefusal(`target branch "${target}" does not exist in ${cwd}`)
    }
    base = (await git(cwd, ['merge-base', target, branch])).trim()
  }
  const head = (await git(cwd, ['rev-parse', branch])).trim()
  const empty = base === head
  const rawDiff = empty ? '' : await git(cwd, ['diff', '--no-color', '--no-ext-diff', `${base}..${branch}`])
  const diffTruncated = Buffer.byteLength(rawDiff) > DIFF_CAP_BYTES
  const diff = diffTruncated ? rawDiff.slice(0, DIFF_CAP_BYTES) + '\n[diff truncated]\n' : rawDiff
  const commits = empty
    ? ''
    : (await git(cwd, ['log', '--no-color', '--format=%h %s%n%b', `${base}..${branch}`])).slice(0, LOG_CAP_BYTES)
  const files = empty
    ? []
    : (await git(cwd, ['diff', '--name-only', `${base}..${branch}`]))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
  return { cwd, branch, target, base, head, diff, diffTruncated, commits, files, empty }
}

/** A ref's commit in the checkout. */
export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['rev-parse', ref])).trim()
}

/** Does the checkout have an `origin` remote (so a merge pushes)? */
export async function hasOrigin(cwd: string): Promise<boolean> {
  return gitOk(cwd, ['remote', 'get-url', 'origin'])
}

import type { MergeResult } from '@shared/review'
export type { MergeResult }

/**
 * Fast-forward `target` to `branch` in the checkout at cwd, then push when
 * asked. The checkout must be on the target with no changes to tracked
 * files (the thread's own commits are on the branch; a dirty target is a
 * sibling's work in progress, never ours to fold in). A branch that IS
 * the target only pushes.
 */
export async function fastForwardMerge(
  cwd: string,
  branch: string,
  target: string,
  push: boolean
): Promise<MergeResult> {
  const current = await branchOf(cwd)
  if (current !== target) {
    throw new MergeRefusal(`the checkout at ${cwd} is on ${current ?? 'a detached HEAD'}, not ${target}; check out ${target} there first`)
  }
  if (!(await gitOk(cwd, ['diff', '--quiet'])) || !(await gitOk(cwd, ['diff', '--cached', '--quiet']))) {
    throw new MergeRefusal(`the checkout at ${cwd} has uncommitted changes to tracked files; commit or discard them before merging`)
  }
  let merged = false
  if (branch !== target) {
    try {
      await git(cwd, ['merge', '--ff-only', branch])
    } catch (err) {
      const text = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
      throw new MergeRefusal(`git merge --ff-only ${branch} failed: ${text.trim() || 'not a fast-forward'}. Rebase ${branch} onto ${target} and merge again.`)
    }
    merged = true
  }
  let pushed = false
  if (push) {
    try {
      await git(cwd, ['push', 'origin', target])
    } catch (err) {
      const text = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
      throw new MergeRefusal(`${merged ? `merged ${branch} into ${target}, but ` : ''}git push origin ${target} failed: ${text.trim()}`)
    }
    pushed = true
  }
  const sha = (await git(cwd, ['rev-parse', target])).trim()
  return { sha, merged, pushed }
}

// ── across hosts (docs/box.md "Threads across hosts") ─────────────────

/** Push a branch to origin so another host can merge it from there (a held branch of a batch that lands all at once). */
export async function pushBranch(cwd: string, branch: string): Promise<void> {
  try {
    await git(cwd, ['push', '-u', 'origin', branch])
  } catch (err) {
    const text = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
    throw new MergeRefusal(`git push origin ${branch} failed: ${text.trim()}`)
  }
}

/**
 * Bring a checkout up to the project branch's origin head: `git fetch
 * origin`, then a fast-forward of `target` to `origin/<target>`. What a
 * master's host runs after a child on another host landed through that
 * host's merge_branch (which pushed), before the gate and release steps.
 * The checkout must be on the target with no changes to tracked files; a
 * target already at the origin head is a no-op.
 */
export async function fetchFastForward(cwd: string, target: string): Promise<MergeResult> {
  if (!(await hasOrigin(cwd))) return { sha: await revParse(cwd, target), merged: false, pushed: false }
  const current = await branchOf(cwd)
  if (current !== target) throw new MergeRefusal(`the checkout at ${cwd} is on ${current ?? 'a detached HEAD'}, not ${target}; check out ${target} there first`)
  if (!(await gitOk(cwd, ['diff', '--quiet'])) || !(await gitOk(cwd, ['diff', '--cached', '--quiet'])))
    throw new MergeRefusal(`the checkout at ${cwd} has uncommitted changes to tracked files; commit or discard them before merging`)
  try {
    await git(cwd, ['fetch', 'origin', target])
  } catch (err) {
    const text = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
    throw new MergeRefusal(`git fetch origin ${target} failed: ${text.trim()}`)
  }
  const before = await revParse(cwd, target)
  try {
    await git(cwd, ['merge', '--ff-only', `origin/${target}`])
  } catch (err) {
    const text = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
    throw new MergeRefusal(`git merge --ff-only origin/${target} failed: ${text.trim() || 'not a fast-forward'}`)
  }
  const sha = await revParse(cwd, target)
  return { sha, merged: sha !== before, pushed: false }
}

/**
 * Merge a branch another host pushed to origin: `git fetch origin <branch>`
 * then the same fast-forward as a local branch, from `origin/<branch>`.
 * The end of a batch that lands all at once merges its held remote
 * branches this way.
 */
export async function fastForwardFromOrigin(cwd: string, branch: string, target: string, push: boolean): Promise<MergeResult> {
  try {
    await git(cwd, ['fetch', 'origin', branch])
  } catch (err) {
    const text = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
    throw new MergeRefusal(`git fetch origin ${branch} failed: ${text.trim()}`)
  }
  return fastForwardMerge(cwd, `origin/${branch}`, target, push)
}
