import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { nanoid } from 'nanoid'
import { glob } from 'tinyglobby'
import type { ServerPush } from '@shared/contract'
import {
  splitGlobs,
  type BuildConfig,
  type BuildOutput,
  type BuildRun,
  type BuildTarget,
  type EffectiveBuild,
  type RemoteStatus
} from '@shared/build'
import { harnessEnv } from './drivers/binaries'
import { branches, checkouts, currentBranch } from './git'

const execFileP = promisify(execFile)

/**
 * The Build rail's engine: one build per project at a time, run in the
 * project checkout through the login shell (that is where mvn/java live),
 * log streamed in ~50 ms batches, a ring buffer for replay, and the files
 * the build produced resolved afterwards (configured globs, else paths
 * the log mentions).
 */

const LOG_CAP = 3000
const BATCH_MS = 50
const KILL_GRACE_MS = 5000

/** What a checkout's build tooling implies when nothing is configured. */
export async function detectBuild(cwd: string): Promise<BuildConfig | null> {
  const has = (name: string): boolean => existsSync(join(cwd, name))
  if (has('mvnw') || has('pom.xml')) {
    return {
      command: `${has('mvnw') ? './mvnw' : 'mvn'} -B -DskipTests package`,
      outputs: 'target/*.jar,!target/original-*.jar'
    }
  }
  if (has('gradlew') || has('build.gradle') || has('build.gradle.kts')) {
    return {
      command: `${has('gradlew') ? './gradlew' : 'gradle'} build`,
      outputs: 'build/libs/*.jar'
    }
  }
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
      }
      if (pkg.scripts?.build) return { command: 'bun run build', outputs: '' }
    } catch {
      // unreadable package.json — nothing to detect
    }
  }
  return null
}

// ── build targets: build another branch without touching the project ──

/** The project's own branch first, then the repo's other checkouts, then
 *  local branches no checkout holds. */
export async function buildTargets(project: {
  cwd: string
  branch: string | null
}): Promise<BuildTarget[]> {
  const own = project.branch ?? (await currentBranch(project.cwd))
  const out: BuildTarget[] = own ? [{ branch: own, cwd: project.cwd, kind: 'project' }] : []
  const held = new Set<string>(own ? [own] : [])
  for (const c of await checkouts(project.cwd)) {
    if (!c.branch || held.has(c.branch)) continue
    held.add(c.branch)
    out.push({ branch: c.branch, cwd: c.dir, kind: 'checkout' })
  }
  const { locals } = await branches(project.cwd).catch(() => ({ locals: [] as string[] }))
  for (const b of locals) if (!held.has(b)) out.push({ branch: b, cwd: null, kind: 'branch' })
  return out
}

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60)

/** Where a build of `branch` runs: the project checkout for its own
 *  branch, the checkout holding the branch, else an app-managed detached
 *  worktree under ~/.temp-code/builds (re-pointed at the branch each time). */
export async function resolveBuildDir(
  project: { cwd: string; branch: string | null },
  branch: string | undefined
): Promise<{ cwd: string; branch: string | null }> {
  const own = project.branch ?? (await currentBranch(project.cwd))
  if (!branch || branch === own) return { cwd: project.cwd, branch: own }
  const holder = (await checkouts(project.cwd)).find((c) => c.branch === branch)
  if (holder) return { cwd: holder.dir, branch }
  const { locals } = await branches(project.cwd)
  if (!locals.includes(branch)) throw new Error(`${branch} is not a local branch`)
  const root = join(homedir(), '.temp-code', 'builds')
  mkdirSync(root, { recursive: true })
  // Named after the repo (its common git dir's parent), not this worktree.
  const { stdout: common } = await execFileP('git', ['-C', project.cwd, 'rev-parse', '--git-common-dir'])
  const repoRoot = resolve(project.cwd, common.trim(), '..')
  const dir = join(root, `${slug(basename(repoRoot))}-${slug(branch)}`)
  const registered = (await checkouts(project.cwd)).some((c) => c.dir === dir)
  try {
    if (registered && existsSync(dir)) {
      await execFileP('git', ['-C', dir, 'checkout', '--detach', '--force', branch])
    } else {
      await execFileP('git', ['-C', project.cwd, 'worktree', 'prune'])
      await execFileP('git', ['-C', project.cwd, 'worktree', 'add', '--detach', dir, branch])
    }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error((e.stderr || e.message || String(err)).trim())
  }
  return { cwd: dir, branch }
}

// ── origin sync for the selected build branch ────────────────────────

const quietGit = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }

const revOf = (dir: string, ref: string): Promise<string | null> =>
  execFileP('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref]).then(
    (r) => r.stdout.trim() || null,
    () => null
  )

/** Local branch vs origin/<branch>: counts from the last fetch, and a
 *  cheap ls-remote to learn whether origin has moved since. */
export async function remoteStatus(
  project: { cwd: string; branch: string | null },
  branch?: string
): Promise<RemoteStatus | null> {
  const b = branch ?? project.branch ?? (await currentBranch(project.cwd))
  if (!b) return null
  const dir = project.cwd
  const local = await revOf(dir, `refs/heads/${b}`)
  if (!local) return null
  const fetched = await revOf(dir, `refs/remotes/origin/${b}`)
  let ahead = 0
  let behind = 0
  if (fetched) {
    const { stdout } = await execFileP('git', [
      '-C',
      dir,
      'rev-list',
      '--left-right',
      '--count',
      `refs/remotes/origin/${b}...refs/heads/${b}`
    ])
    ;[behind, ahead] = stdout.trim().split(/\s+/).map(Number)
  }
  let remote: string | null | undefined
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', dir, 'ls-remote', '--heads', 'origin', `refs/heads/${b}`],
      { env: quietGit, timeout: 8000 }
    )
    remote = stdout.trim().split(/\s+/)[0] || null
  } catch {
    remote = undefined // unreachable: counts stand, staleness unknown
  }
  return {
    branch: b,
    upstream: !!fetched || !!remote,
    ahead,
    behind,
    stale: remote === undefined ? null : remote !== null && remote !== fetched
  }
}

export interface SyncProgress {
  line: string
  percent: number | null
}

/** Fetch origin/<branch> with progress, then fast-forward the local
 *  branch — in the checkout holding it (this project's, or another), or
 *  by moving the ref when nothing holds it. Diverged branches fetch but
 *  are not moved; the thrown message says so. */
export async function pullBranch(
  project: { cwd: string; branch: string | null },
  branch: string | undefined,
  onProgress: (p: SyncProgress) => void
): Promise<RemoteStatus | null> {
  const b = branch ?? project.branch ?? (await currentBranch(project.cwd))
  if (!b) throw new Error('no branch checked out')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', project.cwd, 'fetch', '--progress', '--no-tags', 'origin', b], {
      env: quietGit,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let tail = ''
    let last = ''
    let timer: NodeJS.Timeout | null = null
    let pending: SyncProgress | null = null
    const emit = (line: string): void => {
      const m = /(\d{1,3})%/.exec(line)
      pending = { line, percent: m ? Number(m[1]) : null }
      timer ??= setTimeout(() => {
        timer = null
        if (pending) onProgress(pending)
        pending = null
      }, 80)
    }
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const parts = chunk.split(/[\r\n]/)
      for (const part of parts) {
        const line = part.trim()
        if (!line) continue
        last = line
        tail = `${tail}${line}\n`.slice(-2000)
        emit(line)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (pending) onProgress(pending)
      if (code === 0) resolve()
      else reject(new Error(last || tail.trim() || `git fetch exited ${code}`))
    })
  })
  onProgress({ line: 'Updating branch', percent: null })
  const fetched = await revOf(project.cwd, `refs/remotes/origin/${b}`)
  if (!fetched) throw new Error(`origin has no branch ${b}`)
  const local = await revOf(project.cwd, `refs/heads/${b}`)
  if (local !== fetched) {
    const holder = (await checkouts(project.cwd)).find((c) => c.branch === b)
    try {
      if (holder) {
        await execFileP('git', ['-C', holder.dir, 'merge', '--ff-only', `refs/remotes/origin/${b}`], {
          env: quietGit
        })
      } else {
        await execFileP('git', [
          '-C',
          project.cwd,
          'merge-base',
          '--is-ancestor',
          `refs/heads/${b}`,
          `refs/remotes/origin/${b}`
        ])
        await execFileP('git', ['-C', project.cwd, 'branch', '-f', b, `refs/remotes/origin/${b}`])
      }
    } catch (err) {
      const e = err as { stderr?: string }
      const status = await remoteStatus(project, b)
      const diverged = status && status.ahead > 0
      throw new Error(
        diverged
          ? `Fetched, but ${b} has ${status.ahead} local commit${status.ahead === 1 ? '' : 's'} not on origin — update it from the Branch tab`
          : (e.stderr || String(err)).trim()
      )
    }
  }
  return remoteStatus(project, b)
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const ARTIFACT =
  /[^\s"'`()[\]<>,;]+\.(?:jar|war|ear|zip|tar\.gz|tgz|dmg|pkg|exe|msi|apk|aar|whl|deb|rpm)(?![\w.])/g

/** Artifact-looking paths the log mentions, as checkout-relative paths. */
export function scanLog(lines: string[], cwd: string): string[] {
  const found = new Set<string>()
  for (const line of lines) {
    for (const token of line.match(ARTIFACT) ?? []) {
      const rel = relative(cwd, resolve(cwd, token))
      if (!rel.startsWith('..') && !rel.startsWith('/')) found.add(rel)
    }
  }
  return [...found]
}

/** Files a run produced: glob matches (or log mentions), fresh ones first. */
export async function resolveOutputs(
  cwd: string,
  outputs: string,
  lines: string[],
  startedAt: number
): Promise<BuildOutput[]> {
  const { include, exclude } = splitGlobs(outputs)
  let paths: string[] = []
  try {
    paths = include.length
      ? await glob(include, { cwd, ignore: exclude, onlyFiles: true })
      : scanLog(lines, cwd)
  } catch {
    // a bad glob yields no outputs rather than a failed build
  }
  const rows = await Promise.all(
    paths.map(async (path): Promise<BuildOutput | null> => {
      const abs = resolve(cwd, path)
      const st = await stat(abs).catch(() => null)
      if (!st?.isFile()) return null
      return {
        path,
        abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
        fresh: st.mtimeMs >= startedAt - 1000
      }
    })
  )
  return rows
    .filter((r): r is BuildOutput => r !== null)
    .sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.mtimeMs - a.mtimeMs)
    .slice(0, 20)
}

type BuildPush = Extract<ServerPush, { push: 'build' }>

interface Slot {
  run: BuildRun
  cwd: string
  outputs: string
  lines: string[]
  child: ChildProcess | null
  pending: string[]
  timer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
  cancelling: boolean
}

export class BuildRunner {
  private slots = new Map<string, Slot>()
  private listeners = new Set<(push: BuildPush) => void>()

  onPush(listener: (push: BuildPush) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Last run + buffered log for a project (panel replay). */
  status(projectId: string): { run: BuildRun | null; lines: string[] } {
    const slot = this.slots.get(projectId)
    return slot ? { run: slot.run, lines: slot.lines.slice() } : { run: null, lines: [] }
  }

  isRunning(projectId: string): boolean {
    return this.slots.get(projectId)?.run.status === 'running'
  }

  async run(
    projectId: string,
    cwd: string,
    build: EffectiveBuild,
    branch: string | null = null
  ): Promise<BuildRun> {
    if (this.isRunning(projectId)) throw new Error('a build is already running')
    const slot: Slot = {
      run: {
        id: nanoid(10),
        status: 'running',
        command: build.command,
        cwd,
        branch,
        startedAt: Date.now(),
        outputs: []
      },
      cwd,
      outputs: build.outputs,
      lines: [],
      child: null,
      pending: [],
      timer: null,
      killTimer: null,
      cancelling: false
    }
    this.slots.set(projectId, slot)
    this.emit(projectId, slot, [])
    const env = { ...(await harnessEnv()), NO_COLOR: '1', TERM: 'dumb' }
    const child = spawn('/bin/zsh', ['-lc', build.command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    slot.child = child
    const feed = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      let rest = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop() ?? ''
        this.pushLines(projectId, slot, parts)
      })
      stream.on('end', () => {
        if (rest) this.pushLines(projectId, slot, [rest])
      })
    }
    feed(child.stdout)
    feed(child.stderr)
    child.on('error', (err) => {
      this.pushLines(projectId, slot, [err.message])
      void this.finish(projectId, slot, 'failed', null)
    })
    child.on('close', (code) => {
      void this.finish(projectId, slot, slot.cancelling ? 'cancelled' : code === 0 ? 'ok' : 'failed', code)
    })
    return slot.run
  }

  /** SIGTERM the whole process group (shell + mvn/java), SIGKILL after 5 s. */
  cancel(projectId: string): void {
    const slot = this.slots.get(projectId)
    const pid = slot?.child?.pid
    if (!slot || slot.run.status !== 'running' || !pid) return
    slot.cancelling = true
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig)
      } catch {
        slot.child?.kill(sig)
      }
    }
    signal('SIGTERM')
    slot.killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
  }

  disposeAll(): void {
    for (const projectId of this.slots.keys()) this.cancel(projectId)
  }

  private pushLines(projectId: string, slot: Slot, raw: string[]): void {
    const lines = raw.map((l) => l.replace(ANSI, '').replace(/\r$/, ''))
    slot.lines.push(...lines)
    if (slot.lines.length > LOG_CAP) slot.lines.splice(0, slot.lines.length - LOG_CAP)
    slot.pending.push(...lines)
    slot.timer ??= setTimeout(() => this.flush(projectId, slot), BATCH_MS)
  }

  private flush(projectId: string, slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
    if (!slot.pending.length) return
    const lines = slot.pending
    slot.pending = []
    this.emit(projectId, slot, lines)
  }

  private async finish(
    projectId: string,
    slot: Slot,
    status: BuildRun['status'],
    code: number | null
  ): Promise<void> {
    if (slot.run.status !== 'running') return
    if (slot.killTimer) clearTimeout(slot.killTimer)
    slot.killTimer = null
    slot.child = null
    this.flush(projectId, slot)
    const outputs =
      status === 'cancelled'
        ? []
        : await resolveOutputs(slot.cwd, slot.outputs, slot.lines, slot.run.startedAt)
    slot.run = { ...slot.run, status, endedAt: Date.now(), exitCode: code ?? undefined, outputs }
    this.emit(projectId, slot, [])
  }

  private emit(projectId: string, slot: Slot, lines: string[]): void {
    const push: BuildPush = { push: 'build', projectId, run: slot.run, lines }
    for (const l of this.listeners) l(push)
  }
}
