import { basename, dirname } from 'node:path'
import type { ThreadResource } from '@shared/contract-resources'
import { parseLsof, parseSs } from './threadPortsParse'

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
 *   port        kill -TERM <pid> only while that pid still listens on the
 *               port (ss on Linux, lsof on macOS), up to 3 s for it to go,
 *               then kill -KILL; another process on the port is never touched.
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
    case 'port':
      return removePort(row, run)
  }
}

/** The pids listening on a port on the runner's host: ss where it exists, else lsof. */
export async function listenersOn(port: number, run: ResourceRunner): Promise<Set<number>> {
  const ss = await run(['ss', '-ltnpH', `sport = :${port}`], '/').catch(() => null)
  if (ss && ss.exitCode === 0) return new Set(parseSs(ss.stdout).filter((l) => l.port === port).map((l) => l.pid))
  const lsof = await run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], '/').catch(() => null)
  return new Set(parseLsof(lsof?.stdout ?? '').filter((l) => l.port === port).map((l) => l.pid))
}

/** How long a SIGTERM gets before the SIGKILL, and how often the pid is checked meanwhile. */
export const PORT_TERM_GRACE_MS = 3_000
const PORT_POLL_MS = 150

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function removePort(row: ThreadResource, run: ResourceRunner): Promise<RemovalOutcome> {
  const port = Number(row.identifier)
  const pid = row.pid
  if (!pid || !Number.isInteger(port)) throw new Error(`refused: the row names no listening process`)
  if (!(await listenersOn(port, run)).has(pid)) return { note: 'was already gone' }
  await run(['kill', '-TERM', String(pid)], '/')
  for (let waited = 0; waited < PORT_TERM_GRACE_MS; waited += PORT_POLL_MS) {
    if ((await run(['kill', '-0', String(pid)], '/')).exitCode !== 0) return { note: null }
    await sleep(PORT_POLL_MS)
  }
  const killed = await run(['kill', '-KILL', String(pid)], '/')
  if (killed.exitCode !== 0 && (await run(['kill', '-0', String(pid)], '/')).exitCode === 0) throw new Error(`kill: ${trimmed(killed) || 'failed'}`)
  return { note: 'killed after 3 s' }
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
