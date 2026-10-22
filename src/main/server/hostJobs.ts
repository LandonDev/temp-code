import { spawn, execFile, type ChildProcess } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import {
  DEPLOY_REF,
  type DeployStatus,
  type HostJob,
  type HostJobStatus,
  type HostLogPush,
  type PublishStatus
} from '@shared/contract-host'
import { PhaseTracker, formatDuration } from '@shared/releasePhases'
import { updatePhaseLine, type SelfUpdateOutcome } from '../updateTrigger'
import { loginShell } from './loginShell'
import { trackChild } from './spawnBudget'

/**
 * Deploy and publish from the app (docs/box.md "Updating" → "Deploy from
 * the app"; CLAUDE.md "Releases"). Two jobs that used to be typed into a
 * terminal, each still pressed by the user, each a log the renderer tails:
 *
 *  - DeployTrigger, the box's side of "Deploy master to the box". The app
 *    runs as agents and box-update must run as root, so it never runs
 *    anything: it drops the ref into the root-owned trigger directory
 *    (`/run/temp-code/deploy/request`, stage 87), where
 *    temp-code-deploy.path starts deploy-runner as root, and reads what the
 *    runner leaves there: `ref`, `log` (box-update's output) and `exit`
 *    (last, with the status). The phase comes from those files alone, so
 *    it survives this process restarting into the new build mid-deploy: a
 *    `request` is pending, a `log` without `exit` is running, an `exit` is
 *    done, and nothing (the directory is tmpfs) is idle since boot. A
 *    request nobody picks up within PICKUP_MS means the path unit is not
 *    watching: the trigger is not installed, and the refusal names the one
 *    command to run.
 *  - Publisher, the Mac's side of "Publish Mac release": `bun
 *    scripts/release.ts "<notes>"` then `bun run release:publish` through
 *    the login shell in the checkout `release.checkout` names, in a process
 *    group Stop can kill. It refuses what the scripts refuse (a dirty tree,
 *    a branch other than master, a version the feed already serves) before
 *    starting, and their own refusals come through as the log's last lines.
 *    The publish peer uses train: false to publish HEAD without cutting another release.
 *    The script prints one `phase ✓ name 12s` line per phase (releasePhases.ts);
 *    when it exits green the Publisher adds the `update` phase itself: the
 *    installed app this runs in fetches what it just published (update.ts
 *    selfUpdate) and the log says `phase ✓ update 31s` once the zip is ready
 *    for the restart click, then the job is done.
 *
 * HostLog is the one shape both feed: the text so far (capped), the status,
 * and the sockets that asked for it with `host.log`.
 */

export const DEPLOY_DIR_DEFAULT = '/run/temp-code/deploy'
export const RELEASE_CHECKOUT_KEY = 'release.checkout'
export const RELEASE_CHECKOUT_DEFAULT = '~/IdeaProjects/temp-code'
/** The one-time command the refusal names when the trigger is not installed (from the Mac checkout). */
export const DEPLOY_INSTALL_HINT = 'bash scripts/box/apply.sh --from 87 --through 87'
export const DEPLOY_NOT_INSTALLED = `Deploy from the app is not installed on this host; run \`${DEPLOY_INSTALL_HINT}\` from the Mac checkout once`
/** A request still unread after this long: the path unit is not watching. */
export const PICKUP_MS = 15_000
const POLL_MS = 400
const LOG_CAP = 512 * 1024
const KILL_GRACE_MS = 5_000
const RELEASE_REPO_FEED = 'https://github.com/LandonDev/temp-code/releases/latest/download/latest-mac.yml'

// ── the log ─────────────────────────────────────────────────────────────

export class HostLog {
  private text = ''
  private subscribers = new Map<number, (push: HostLogPush) => void>()
  status: HostJobStatus

  constructor(readonly job: HostJob, stoppable: boolean) {
    this.status = { job, phase: 'idle', target: null, startedAt: null, finishedAt: null, exit: null, stoppable }
  }

  snapshot(): { text: string; status: HostJobStatus } {
    return { text: this.text, status: this.status }
  }

  /** A new run: drop the text, keep the subscribers. */
  reset(status: HostJobStatus): void {
    this.text = ''
    this.status = status
    this.emit({ push: 'host-log', job: this.job, reset: true, status })
  }

  append(chunk: string): void {
    if (!chunk) return
    this.text += chunk
    if (this.text.length > LOG_CAP) {
      const cut = this.text.indexOf('\n', this.text.length - LOG_CAP)
      this.text = this.text.slice(cut === -1 ? this.text.length - LOG_CAP : cut + 1)
    }
    this.emit({ push: 'host-log', job: this.job, append: chunk, status: this.status })
  }

  setStatus(status: HostJobStatus): void {
    this.status = status
    this.emit({ push: 'host-log', job: this.job, status })
  }

  subscribe(connection: number, send: (push: HostLogPush) => void): () => void {
    this.subscribers.set(connection, send)
    return () => {
      if (this.subscribers.get(connection) === send) this.subscribers.delete(connection)
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }

  private emit(push: HostLogPush): void {
    for (const send of this.subscribers.values()) send(push)
  }
}

// ── the box: the trigger directory ──────────────────────────────────────

export interface DeployTriggerOptions {
  /** The trigger directory; TEMP_CODE_DEPLOY_DIR points a proof at a scratch one. */
  dir?: string
  /** This host's version (its package.json), for the confirm's "from". */
  version: string
  installHint?: string
  pollMs?: number
  pickupMs?: number
  now?: () => number
}

const mtimeMs = (path: string): number | null => {
  try {
    return Math.round(statSync(path).mtimeMs)
  } catch {
    return null
  }
}

export class DeployTrigger {
  readonly log = new HostLog('deploy', false)
  private readonly dir: string
  private readonly installHint: string
  private readonly pollMs: number
  private readonly pickupMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private offset = 0
  /** The ref this process dropped, until the runner's `ref` file says it. */
  private requested: { ref: string; at: number } | null = null

  constructor(opts: DeployTriggerOptions) {
    this.dir = opts.dir ?? process.env.TEMP_CODE_DEPLOY_DIR ?? DEPLOY_DIR_DEFAULT
    this.installHint = opts.installHint ?? DEPLOY_INSTALL_HINT
    this.pollMs = opts.pollMs ?? POLL_MS
    this.pickupMs = opts.pickupMs ?? PICKUP_MS
    this.now = opts.now ?? Date.now
    this.version = opts.version
    this.sync()
  }

  private readonly version: string
  private file(name: 'request' | 'log' | 'exit' | 'ref'): string {
    return join(this.dir, name)
  }

  installed(): boolean {
    try {
      accessSync(this.dir, constants.W_OK | constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  /** The job's status as the files say it, after a read of what the runner left. */
  status(): DeployStatus {
    this.sync()
    return { ...this.log.status, job: 'deploy', installed: this.installed(), installHint: this.installHint, version: this.version }
  }

  async deploy(ref: string): Promise<DeployStatus> {
    if (!DEPLOY_REF.test(ref)) throw new Error(`refused ref '${ref}': master or a v1.0.N tag only`)
    if (!this.installed()) throw new Error(DEPLOY_NOT_INSTALLED)
    this.sync()
    const phase = this.log.status.phase
    if (phase === 'pending' || phase === 'running')
      throw new Error(`a deploy of ${this.log.status.target ?? 'the box'} is in progress; wait for it to finish`)
    const at = this.now()
    const tmp = join(this.dir, `.request.${process.pid}.tmp`)
    writeFileSync(tmp, `${ref}\n`, { mode: 0o644 })
    renameSync(tmp, this.file('request'))
    this.requested = { ref, at }
    this.offset = 0
    this.log.reset({ job: 'deploy', phase: 'pending', target: ref, startedAt: at, finishedAt: null, exit: null, stoppable: false })
    this.log.append(`== deploy ${ref} requested; waiting for the trigger\n`)
    this.watch()
    return this.status()
  }

  /** This socket hears the job from now on; the snapshot to answer with is `log.snapshot()` after this. */
  subscribe(connection: number, send: (push: HostLogPush) => void): () => void {
    this.sync()
    const off = this.log.subscribe(connection, send)
    if (this.log.status.phase === 'pending' || this.log.status.phase === 'running') this.watch()
    return off
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private watch(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sync(), this.pollMs)
    this.timer.unref?.()
  }

  private unwatch(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Read the directory and bring the log and status up to it. */
  sync(): void {
    const request = this.file('request')
    const prev = this.log.status
    if (existsSync(request)) {
      const at = this.requested?.at ?? mtimeMs(request) ?? this.now()
      const ref = this.requested?.ref ?? readFileSync(request, 'utf8').trim()
      if (this.now() - at > this.pickupMs) {
        // Nobody read it: the path unit is not watching. The request is ours to withdraw.
        try {
          unlinkSync(request)
        } catch {
          // root may have taken it between the check and now
        }
        this.requested = null
        this.log.append(`ERROR: ${DEPLOY_NOT_INSTALLED}\n`)
        this.log.setStatus({ ...prev, phase: 'done', target: ref, startedAt: at, finishedAt: this.now(), exit: null })
        this.unwatch()
        return
      }
      if (prev.phase !== 'pending' || prev.target !== ref)
        this.log.setStatus({ job: 'deploy', phase: 'pending', target: ref, startedAt: at, finishedAt: null, exit: null, stoppable: false })
      return
    }
    const logPath = this.file('log')
    let size: number
    let fd: number
    try {
      fd = openSync(logPath, 'r')
    } catch {
      // No log and no request: nothing since boot, or the runner has not
      // opened it yet (a request it just took), or a withdrawn request.
      if (prev.phase !== 'pending') this.unwatch()
      return
    }
    try {
      size = fstatSync(fd).size
      if (size < this.offset || (prev.phase !== 'running' && prev.phase !== 'pending' && this.offset === 0 && this.log.snapshot().text)) {
        // The runner started over (a run this process did not request).
        this.offset = 0
        this.log.reset({ ...prev, phase: 'running', finishedAt: null, exit: null })
      }
      if (size > this.offset) {
        const buf = Buffer.alloc(size - this.offset)
        const n = readSync(fd, buf, 0, buf.length, this.offset)
        this.offset += n
        this.log.append(buf.toString('utf8', 0, n))
      }
    } finally {
      closeSync(fd)
    }
    const refFile = this.file('ref')
    const target = (() => {
      try {
        return readFileSync(refFile, 'utf8').trim() || this.requested?.ref || prev.target
      } catch {
        return this.requested?.ref ?? prev.target
      }
    })()
    const startedAt = this.requested?.at ?? mtimeMs(refFile) ?? prev.startedAt
    const exitPath = this.file('exit')
    let exit: number | null = null
    let finished = false
    try {
      const raw = readFileSync(exitPath, 'utf8').trim()
      finished = true
      exit = /^\d+$/.test(raw) ? Number(raw) : null
    } catch {
      finished = false
    }
    if (finished) {
      const finishedAt = mtimeMs(exitPath) ?? this.now()
      if (prev.phase !== 'done' || prev.exit !== exit)
        this.log.setStatus({ job: 'deploy', phase: 'done', target, startedAt, finishedAt, exit, stoppable: false })
      this.requested = null
      this.unwatch()
      return
    }
    if (prev.phase !== 'running' || prev.target !== target)
      this.log.setStatus({ job: 'deploy', phase: 'running', target, startedAt, finishedAt: null, exit: null, stoppable: false })
    if (this.log.subscriberCount > 0 || this.requested) this.watch()
  }
}

// ── the Mac: the release scripts ────────────────────────────────────────

export interface PublisherDeps {
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  shell?: string
  home?: string
  env?: NodeJS.ProcessEnv
  /** `git <args>` in the checkout → stdout. The default runs the binary the login shell finds. */
  git?: (args: string[], cwd: string) => Promise<string>
  /** The version the GitHub feed serves now, or null when unreachable; the scripts check too. */
  feedVersion?: () => Promise<string | null>
  /** The scripts as a child in a process group of its own; stdout and stderr piped. */
  spawnScripts?: (opts: { cwd: string; notes: string; shell: string; env: NodeJS.ProcessEnv; train: boolean }) => ChildProcess
  /** This app's own updater (update.ts selfUpdate): fetch the version just published; absent on a headless host. */
  selfUpdate?: (version: string) => Promise<SelfUpdateOutcome>
  now?: () => number
}

/** The main-process environment the scripts get: PATH from the login shell (-l), nothing of Electron's or the post-commit hook's. */
export function scriptsEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(src)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('npm_') || key.startsWith('GIT_') || key.startsWith('TEMP_CODE_')) continue
    if (key === 'NODE_ENV' || key === 'NODE_ENV_ELECTRON_VITE' || key === 'NODE') continue
    env[key] = value
  }
  env.TERM = 'dumb'
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** The first clause of a commit subject, for the notes field: up to its first ": ", else about 100 characters. */
export function subjectClause(subject: string): string {
  const line = subject.split('\n')[0]?.trim() ?? ''
  const colon = line.indexOf(': ')
  const head = colon > 10 ? line.slice(0, colon) : line
  if (head.length <= 100) return head
  const cut = head.lastIndexOf(' ', 100)
  return `${head.slice(0, cut > 40 ? cut : 100)}…`
}

/** The notes the field is prefilled with: the clauses, newest first, within one line. */
export function notesFrom(subjects: string[]): string {
  const out: string[] = []
  let length = 0
  for (const subject of subjects) {
    if (/^release: v\d+/.test(subject)) continue
    const clause = subjectClause(subject)
    if (!clause) continue
    if (length + clause.length > 500 && out.length) break
    out.push(clause)
    length += clause.length + 2
  }
  return out.join('; ')
}

const versionOf = (packageJson: string): string | null => {
  try {
    const v = (JSON.parse(packageJson) as { version?: unknown }).version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}
const releaseNumber = (version: string | null): number | null => {
  const m = version?.match(/^1\.0\.(\d+)$/)
  return m ? Number(m[1]) : null
}

export class Publisher {
  readonly log = new HostLog('publish', true)
  private child: ChildProcess | null = null
  private readonly deps: Required<Pick<PublisherDeps, 'shell' | 'home' | 'env' | 'git' | 'feedVersion' | 'spawnScripts' | 'now'>> & PublisherDeps

  constructor(deps: PublisherDeps) {
    const shell = deps.shell ?? loginShell()
    this.deps = {
      ...deps,
      shell,
      home: deps.home ?? homedir(),
      env: deps.env ?? scriptsEnv(),
      git: deps.git ?? ((args, cwd) => gitThroughShell(shell, args, cwd, deps.env ?? scriptsEnv())),
      feedVersion: deps.feedVersion ?? fetchFeedVersion,
      spawnScripts: deps.spawnScripts ?? spawnReleaseScripts,
      now: deps.now ?? Date.now
    }
  }

  checkout(): string {
    const raw = this.deps.store.getSetting(RELEASE_CHECKOUT_KEY)?.trim() || RELEASE_CHECKOUT_DEFAULT
    return expandHome(raw, this.deps.home)
  }

  /** Use the same login-shell git as the publish checks. */
  git(args: string[], cwd: string = this.checkout()): Promise<string> {
    return this.deps.git(args, cwd)
  }

  setCheckout(value: string): void {
    const trimmed = value.trim()
    this.deps.store.setSetting(RELEASE_CHECKOUT_KEY, trimmed && trimmed !== RELEASE_CHECKOUT_DEFAULT ? trimmed : null)
  }

  async status(): Promise<PublishStatus> {
    const checkout = this.checkout()
    const base: PublishStatus = {
      ...this.log.status,
      job: 'publish',
      checkout,
      readable: false,
      branch: null,
      dirty: false,
      version: null,
      masterVersion: null,
      publishedVersion: null,
      commits: [],
      notes: '',
      refusal: null
    }
    if (!existsSync(join(checkout, '.git')) && !existsSync(join(checkout, 'package.json'))) {
      return { ...base, refusal: `${checkout} is not a checkout of temp-code` }
    }
    const git = (args: string[]): Promise<string> => this.deps.git(args, checkout)
    try {
      const [porcelain, branch, head, lastTag] = await Promise.all([
        git(['status', '--porcelain']),
        git(['rev-parse', '--abbrev-ref', 'HEAD']),
        git(['show', 'HEAD:package.json']),
        git(['describe', '--tags', '--match', 'v1.0.*', '--abbrev=0']).catch(() => '')
      ])
      const dirty = porcelain.split('\n').some((l) => l && !l.startsWith('??'))
      const version = versionOf(head)
      const master = await git(['show', 'origin/master:package.json']).catch(() => head)
      const publishedVersion = lastTag.trim().replace(/^v/, '') || null
      const subjects = lastTag.trim()
        ? (await git(['log', '--format=%s', `${lastTag.trim()}..HEAD`]).catch(() => '')).split('\n').filter(Boolean)
        : (await git(['log', '--format=%s', '-n', '20']).catch(() => '')).split('\n').filter(Boolean)
      const status: PublishStatus = {
        ...base,
        readable: true,
        branch: branch.trim() || null,
        dirty,
        version,
        masterVersion: versionOf(master) ?? version,
        publishedVersion,
        commits: subjects.filter((s) => !/^release: v\d+/.test(s)).map(subjectClause),
        notes: notesFrom(subjects)
      }
      status.refusal = this.refusalFor(status)
      return status
    } catch (err) {
      return { ...base, refusal: `cannot read ${checkout}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  private refusalFor(status: PublishStatus): string | null {
    if (this.log.status.phase === 'running') return 'a publish is already running'
    if (status.dirty) return 'the tree has uncommitted changes; commit first'
    if (status.branch !== 'master') return `the checkout is on ${status.branch ?? 'no branch'}, not master`
    const n = releaseNumber(status.version)
    const published = releaseNumber(status.publishedVersion)
    if (n !== null && published !== null && published > n) return `v${status.publishedVersion} is already published past v${status.version}`
    return null
  }

  async publish(notes: string, { train = true }: { train?: boolean } = {}): Promise<PublishStatus> {
    const status = await this.status()
    if (status.refusal) throw new Error(status.refusal)
    const trimmed = notes.trim()
    if (!trimmed) throw new Error('release notes are empty')
    const feed = await this.deps.feedVersion().catch(() => null)
    // The button cuts the next release; a peer publishes the release already at HEAD.
    let next: number | null = releaseNumber(status.version)
    if (train) {
      try {
        next = (JSON.parse(readFileSync(join(status.checkout, 'release.json'), 'utf8')) as { n: number }).n + 1
      } catch {
        next = null
      }
    }
    const feedN = releaseNumber(feed)
    if (feedN !== null && next !== null && feedN >= next) throw new Error(`v1.0.${feedN} is already published; the feed serves it`)
    const at = this.deps.now()
    const target = next !== null ? `v1.0.${next}` : null
    const child = this.deps.spawnScripts({ cwd: status.checkout, notes: trimmed, shell: this.deps.shell, env: this.deps.env, train })
    this.child = child
    this.log.reset({ job: 'publish', phase: 'running', target, startedAt: at, finishedAt: null, exit: null, stoppable: true })
    this.log.append(`== release ${target ?? ''} from ${status.checkout}\n`)
    child.stdout?.on('data', (chunk: Buffer | string) => this.log.append(String(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => this.log.append(String(chunk)))
    child.once('error', (err) => this.log.append(`ERROR: ${err.message}\n`))
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      const exit = code ?? (signal ? 128 + 15 : 1)
      this.log.append(signal ? `== stopped (${signal})\n` : `== exited ${exit}\n`)
      const finish = (): void => this.log.setStatus({ ...this.log.status, phase: 'done', finishedAt: this.deps.now(), exit })
      const version = exit === 0 ? this.publishedVersion() : null
      if (version && this.deps.selfUpdate) void this.update(version).finally(finish)
      else finish()
    })
    return this.status()
  }

  /** The version the script's total line names, else the job's target. */
  private publishedVersion(): string | null {
    const tracker = new PhaseTracker()
    for (const line of this.log.snapshot().text.split(/\r?\n/)) tracker.feed(line)
    return tracker.version ?? this.log.status.target?.replace(/^v/, '') ?? null
  }

  /** The `update` phase: this app fetches what it just published, and the log says how it went. */
  private async update(version: string): Promise<void> {
    const started = this.deps.now()
    this.log.append('phase › update\n')
    let outcome: SelfUpdateOutcome
    try {
      outcome = await this.deps.selfUpdate!(version)
    } catch (err) {
      this.log.append(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
      outcome = 'error'
    }
    this.log.append(`${updatePhaseLine(outcome, this.deps.now() - started, formatDuration)}\n`)
  }

  subscribe(connection: number, send: (push: HostLogPush) => void): () => void {
    return this.log.subscribe(connection, send)
  }

  /** Kill the scripts' process group: SIGTERM, then SIGKILL after a grace. */
  stop(): void {
    const child = this.child
    if (!child?.pid) return
    this.log.append('== stop requested\n')
    const pid = child.pid
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          // already gone
        }
      }
    }
    signal('SIGTERM')
    const hard = setTimeout(() => {
      if (this.child === child) signal('SIGKILL')
    }, KILL_GRACE_MS)
    hard.unref?.()
  }

  dispose(): void {
    this.stop()
  }
}

function gitThroughShell(shell: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(shell, ['-lc', 'exec git "$@"', 'git', ...args], { cwd, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()))
      else resolve(String(stdout))
    })
  })
}

async function fetchFeedVersion(): Promise<string | null> {
  try {
    const res = await fetch(RELEASE_REPO_FEED, { redirect: 'follow', signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const m = (await res.text()).match(/^version:\s*(\S+)/m)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/** Cut then publish by default; peers publish the release already cut on the box. */
export function releaseCommand({ train = true }: { train?: boolean } = {}): string {
  if (!train) return 'bun run release:publish'
  return 'bun scripts/release.ts "$TC_RELEASE_NOTES" && bun run release:publish'
}

function spawnReleaseScripts(opts: { cwd: string; notes: string; shell: string; env: NodeJS.ProcessEnv; train: boolean }): ChildProcess {
  return trackChild(
    spawn(opts.shell, ['-lc', releaseCommand({ train: opts.train })], {
      cwd: opts.cwd,
      env: { ...opts.env, TC_RELEASE_NOTES: opts.notes },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  )
}

// ── the dispatch ────────────────────────────────────────────────────────

export interface HostJobs {
  deploy: DeployTrigger
  publish: Publisher
}

export interface HostCaller {
  connection: number
  send: (push: HostLogPush) => void
  /** Registers what the socket's close must undo. */
  onClose: (off: () => void) => void
}

type Handled = { handled: true; result: unknown } | { handled: false }

export async function handleHost(req: ClientRequest, jobs: HostJobs, caller: HostCaller): Promise<Handled> {
  const done = (result: unknown): Handled => ({ handled: true, result })
  switch (req.method) {
    case 'host.deployStatus':
      return done(jobs.deploy.status())
    case 'host.deploy':
      return done(await jobs.deploy.deploy(req.params.ref))
    case 'host.publishStatus':
      return done(await jobs.publish.status())
    case 'host.publish':
      return done(await jobs.publish.publish(req.params.notes))
    case 'host.publishStop':
      jobs.publish.stop()
      return done(await jobs.publish.status())
    case 'host.releaseCheckout.set':
      jobs.publish.setCheckout(req.params.checkout)
      return done(await jobs.publish.status())
    case 'host.log': {
      const job = req.params.job === 'deploy' ? jobs.deploy : jobs.publish
      caller.onClose(job.subscribe(caller.connection, caller.send))
      return done(job.log.snapshot())
    }
    default:
      return { handled: false }
  }
}
