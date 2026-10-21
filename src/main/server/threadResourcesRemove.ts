import { basename, dirname } from 'node:path'
import type { ThreadResource } from '@shared/contract-resources'

/**
 * How one ledger row is removed on its host (docs/box.md "Thread
 * resources"). Every step is an argv run by the host (`ResourceRunner`:
 * this host's own spawn, or the Mac bridge's runner as the thread), and
 * nothing is run that does not name the row's own identifier:
 *   worktree    git worktree remove --force <path> from the repo's main
 *               working tree, then git branch -D <branch> only when the
 *               branch the command created has no commits ahead of its
 *               upstream (or, with no upstream, none that no remote has);
 *               otherwise the branch stays and the note says so.
 *   simulator   xcrun simctl shutdown <udid> (its failure is nothing), then
 *               xcrun simctl delete <udid>.
 *   devInstance rm -rf <userData dir>, never the installed app's dir.
 * A resource already gone is a removal with a note, not a failure.
 */

export interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}
export type ResourceRunner = (argv: string[], cwd: string) => Promise<RunResult>

export interface RemovalOutcome {
  note: string | null
}

const trimmed = (r: RunResult): string => (r.stderr || r.stdout).trim().split('\n')[0] ?? ''

/** The installed app's data dirs: a dev instance is never one of these. */
export const PROTECTED_USER_DATA = new Set(['TempCode', 'temp-code'])

export async function removeResource(row: ThreadResource, run: ResourceRunner): Promise<RemovalOutcome> {
  switch (row.kind) {
    case 'worktree':
      return removeWorktree(row, run)
    case 'simulator':
      return removeSimulator(row, run)
    case 'devInstance':
      return removeDevInstance(row, run)
  }
}

async function exists(path: string, run: ResourceRunner): Promise<boolean> {
  return (await run(['test', '-e', path], dirname(path))).exitCode === 0
}

async function removeWorktree(row: ThreadResource, run: ResourceRunner): Promise<RemovalOutcome> {
  const path = row.identifier
  const common = await run(['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], dirname(path))
  if (common.exitCode !== 0) {
    if (!(await exists(path, run))) return { note: 'was already gone' }
    throw new Error(`not a git worktree: ${trimmed(common) || path}`)
  }
  const commonDir = common.stdout.trim()
  // The main working tree is the parent of its .git; a bare common dir is run from itself.
  const main = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir
  const removed = await run(['git', 'worktree', 'remove', '--force', path], main)
  if (removed.exitCode !== 0) throw new Error(`git worktree remove: ${trimmed(removed) || 'failed'}`)
  if (!row.branch) return { note: null }
  const branch = row.branch
  const has = await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], main)
  if (has.exitCode !== 0) return { note: `branch ${branch} was already gone` }
  let ahead = await run(['git', 'rev-list', '--count', `${branch}@{upstream}..${branch}`], main)
  let measure = 'ahead of its upstream'
  if (ahead.exitCode !== 0) {
    // No upstream: what no remote has.
    ahead = await run(['git', 'rev-list', '--count', branch, '--not', '--remotes'], main)
    measure = 'on no remote'
    if (ahead.exitCode !== 0) return { note: `branch ${branch} kept: could not count its commits (${trimmed(ahead)})` }
  }
  const n = Number.parseInt(ahead.stdout.trim(), 10)
  if (!Number.isFinite(n)) return { note: `branch ${branch} kept: could not count its commits` }
  if (n > 0) return { note: `branch ${branch} kept: ${n} commit${n === 1 ? '' : 's'} ${measure}` }
  const del = await run(['git', 'branch', '-D', branch], main)
  if (del.exitCode !== 0) return { note: `branch ${branch} kept: ${trimmed(del) || 'git branch -D failed'}` }
  return { note: `branch ${branch} deleted` }
}

async function removeSimulator(row: ThreadResource, run: ResourceRunner): Promise<RemovalOutcome> {
  const udid = row.identifier
  await run(['xcrun', 'simctl', 'shutdown', udid], '/')
  const del = await run(['xcrun', 'simctl', 'delete', udid], '/')
  if (del.exitCode === 0) return { note: null }
  if (/Invalid device|could not be found|No devices/i.test(del.stderr + del.stdout)) return { note: 'was already gone' }
  throw new Error(`simctl delete: ${trimmed(del) || 'failed'}`)
}

/** A dir the ledger may delete: absolute, deep enough, and never the installed app's. */
export function devInstanceDirAllowed(dir: string): boolean {
  if (!dir.startsWith('/')) return false
  const parts = dir.split('/').filter(Boolean)
  if (parts.length < 3) return false
  return !PROTECTED_USER_DATA.has(basename(dir))
}

async function removeDevInstance(row: ThreadResource, run: ResourceRunner): Promise<RemovalOutcome> {
  const dir = row.identifier
  if (!devInstanceDirAllowed(dir)) throw new Error(`refused: ${dir} is not a dev instance dir this ledger may delete`)
  if (!(await exists(dir, run))) return { note: 'was already gone' }
  const rm = await run(['rm', '-rf', '--', dir], dirname(dir))
  if (rm.exitCode !== 0) throw new Error(`rm: ${trimmed(rm) || 'failed'}`)
  return { note: null }
}
