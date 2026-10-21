import { readRemembers } from './macBridgeRules'
import type { MacDecideRemember } from '@shared/contract-macbridge-rules'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'
import {
  MAC_APPROVAL_WAIT_MS,
  MacRunArgsSchema,
  type MacBridgeOutcome,
  type MacBridgeRequest,
  type MacCallThread
} from '@shared/contract-macbridge'
import {
  MAC_JOB_IDLE_MS,
  MAC_JOB_MAX_PER_THREAD,
  MAC_JOB_OUTPUT_CAP,
  MAC_JOB_READ_MAX,
  MAC_JOB_WRITE_MAX,
  MacJobCloseArgsSchema,
  MacJobReadArgsSchema,
  MacJobSignalArgsSchema,
  MacJobWriteArgsSchema,
  type MacJobCloseResult,
  type MacJobEnd,
  type MacJobPeerMethod,
  type MacJobReadResult,
  type MacJobSignal,
  type MacJobSignalResult,
  type MacJobStartResult,
  type MacJobWriteResult,
  type MacJobsEndResult
} from '@shared/contract-macjobs'
import { realSpelling } from './fence'
import { KILL_GRACE_MS, scrubbedEnv, shellArgv } from './macRunner'
import { trackChild } from '../spawnBudget'

/**
 * Interactive jobs on the Mac (docs/box.md "The Mac bridge", "Interactive
 * jobs"): `mac.run` with `background: true` from a box thread. The approval
 * is mac.run's card (argv and cwd), marked interactive, with its own
 * per-thread "allow this exact command" memory; once allowed the job runs
 * through the login shell like any mac.run (scrubbed environment, its own
 * process group) but in a terminal (node-pty) with stdin open, and stays on
 * the Mac's card as running, with Stop. Writes, reads and signals need no
 * new prompt: the person allowed the job. A job is the thread's own: every
 * call names the (host, thread) that started it, and another thread's id
 * answers "no such job". At most MAC_JOB_MAX_PER_THREAD run per thread; a
 * job dies with its thread (`mac.jobsEnd` from the box), when the host's
 * policy drops below read+run, when the app quits, and after
 * MAC_JOB_IDLE_MS with no call on it. Output keeps rolling in a
 * MAC_JOB_OUTPUT_CAP buffer; a read answers the newest MAC_JOB_READ_MAX past
 * its offset.
 */

// ── the process: a terminal when node-pty loads, else piped stdio ─────

export interface JobProcess {
  readonly pid: number | undefined
  readonly pty: boolean
  write(data: Buffer): void
  /** A pipe ends; a terminal gets end-of-file (^D). */
  closeStdin(): void
  onData(cb: (chunk: Buffer) => void): void
  /** Once, after the last output. */
  onExit(cb: (exitCode: number | null, signal: string | null) => void): void
  /** Signal it some other way than its process group (a test's fake); absent, the group gets it. */
  kill?(signal: NodeJS.Signals): void
}

export type JobSpawner = (cmd: {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}) => JobProcess

const signalName = (n: number): string =>
  Object.entries(osConstants.signals).find(([, v]) => v === n)?.[0] ?? `SIG${n}`

/** stdin, stdout and stderr as pipes (stdout and stderr merged), in a process group of its own. */
export const pipeSpawner: JobSpawner = ({ file, args, cwd, env }) => {
  const child = trackChild(
    spawn(file, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  )
  const data: ((chunk: Buffer) => void)[] = []
  const exits: ((code: number | null, signal: string | null) => void)[] = []
  const emit = (chunk: Buffer): void => data.forEach((cb) => cb(chunk))
  child.stdout?.on('data', emit)
  child.stderr?.on('data', emit)
  child.stdin?.on('error', () => {
    /* the job closed its stdin first: a write after that is dropped */
  })
  let done = false
  const finish = (code: number | null, signal: string | null): void => {
    if (done) return
    done = true
    exits.forEach((cb) => cb(code, signal))
  }
  // Something the command left in its group holding the pipes open would keep 'close' away.
  child.on('exit', () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* the group is empty */
    }
  })
  child.on('error', (e) => {
    emit(Buffer.from(`${e.message}\n`))
    finish(null, null)
  })
  child.on('close', (code, signal) => finish(code, signal))
  return {
    pid: child.pid,
    pty: false,
    write: (buf) => void child.stdin?.write(buf),
    closeStdin: () => void child.stdin?.end(),
    onData: (cb) => void data.push(cb),
    onExit: (cb) => void exits.push(cb)
  }
}

type NodePty = typeof import('node-pty')

/** A terminal (node-pty, as the app's own terminal uses): what prompts that read /dev/tty need. */
export const ptySpawnerOf =
  (pty: NodePty): JobSpawner =>
  ({ file, args, cwd, env }) => {
    const p = pty.spawn(file, args, {
      name: 'xterm',
      cols: 120,
      rows: 40,
      cwd,
      env,
      encoding: null
    })
    return {
      pid: p.pid,
      pty: true,
      write: (buf) => p.write(buf),
      closeStdin: () => p.write('\x04'),
      onData: (cb) =>
        void p.onData((d) => cb(Buffer.isBuffer(d) ? d : Buffer.from(d as unknown as string))),
      // node-pty can deliver the last output just after the exit (pty.ts waits the same way).
      onExit: (cb) =>
        void p.onExit(({ exitCode, signal }) =>
          setTimeout(() => (signal ? cb(null, signalName(signal)) : cb(exitCode, null)), 20)
        )
    }
  }

let defaultSpawner: Promise<JobSpawner> | null = null
/** node-pty when it loads (it is the terminal's dependency), else pipes. */
export function loadDefaultSpawner(): Promise<JobSpawner> {
  defaultSpawner ??= import('node-pty').then(
    (m) => ptySpawnerOf(((m as { default?: NodePty }).default ?? m) as NodePty),
    () => pipeSpawner
  )
  return defaultSpawner
}

// ── output, pure ─────────────────────────────────────────────────────

/** Bytes a utf8 decode would cut at the end: a lead byte whose sequence is not complete yet. */
export function incompleteTail(buf: Buffer): number {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const b = buf[buf.length - back]
    if ((b & 0xc0) === 0x80) continue
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return need > back ? back : 0
  }
  return 0
}

/** Continuation bytes at the front (a read that starts mid-character skips them). */
export function continuationHead(buf: Buffer): number {
  let n = 0
  while (n < Math.min(3, buf.length) && (buf[n] & 0xc0) === 0x80) n++
  return n
}

/** A rolling byte buffer that knows the absolute offset of what it holds. */
export class RollingOutput {
  private chunks: Buffer[] = []
  private held = 0
  /** Every byte ever written. */
  total = 0
  constructor(private readonly cap: number = MAC_JOB_OUTPUT_CAP) {}

  get start(): number {
    return this.total - this.held
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return
    this.chunks.push(chunk)
    this.held += chunk.length
    this.total += chunk.length
    while (this.held > this.cap) {
      const over = this.held - this.cap
      const first = this.chunks[0]
      if (first.length <= over) {
        this.chunks.shift()
        this.held -= first.length
      } else {
        this.chunks[0] = first.subarray(over)
        this.held -= over
      }
    }
  }

  /** The newest `max` bytes past `after`, cut on utf8 boundaries (the tail only while more may come). */
  read(
    after: number,
    max: number,
    final: boolean
  ): { offset: number; nextOffset: number; data: Buffer; skipped: number } {
    const want = Math.min(Math.max(0, after), this.total)
    let from = Math.max(want, this.start, this.total - max)
    let data = this.slice(from, this.total)
    if (from > want) {
      const cut = continuationHead(data)
      data = data.subarray(cut)
      from += cut
    }
    if (!final) data = data.subarray(0, data.length - incompleteTail(data))
    return { offset: from, nextOffset: from + data.length, data, skipped: from - want }
  }

  private slice(from: number, to: number): Buffer {
    const out: Buffer[] = []
    let at = this.start
    for (const c of this.chunks) {
      const end = at + c.length
      if (end > from && at < to)
        out.push(c.subarray(Math.max(0, from - at), Math.min(c.length, to - at)))
      at = end
    }
    return Buffer.concat(out)
  }
}

// ── the registry ─────────────────────────────────────────────────────

/** What the bridge lends the registry: its card (ask, running, finish) and where it runs. */
export interface MacJobsDeps {
  /** Show mac.run's card; when remembered, it is allowed at once. */
  ask: (
    shape: Omit<MacBridgeRequest, 'id' | 'createdAt' | 'expiresAt' | 'status'>,
    until: number,
    remembered: boolean
  ) => {
    id: string
    answer: Promise<{ allow: boolean; remember: MacDecideRemember; outcome: MacBridgeOutcome }>
  }
  /** The card now shows the job running, with Stop. */
  running: (cardId: string, stop: () => void) => void
  finish: (cardId: string, outcome: MacBridgeOutcome) => void
  home: string
  shell?: string
  spawner?: JobSpawner
  idleMs?: number
  log: (line: string) => void
}

interface Job {
  id: string
  envId: string
  threadId: string
  cardId: string
  argv0: string
  proc: JobProcess
  out: RollingOutput
  running: boolean
  stdinOpen: boolean
  exitCode: number | null
  signal: string | null
  ended?: MacJobEnd
  startedAt: number
  idle: NodeJS.Timeout | null
  timeout: NodeJS.Timeout | null
  kill: NodeJS.Timeout | null
  waiters: Set<() => void>
}

const REPLY_MARGIN_MS = 3_000

export class MacJobs {
  private readonly jobs = new Map<string, Job>()
  private readonly remembered = new Map<string, Set<string>>()

  constructor(private readonly deps: MacJobsDeps) {}

  private threadKey = (envId: string, threadId: string): string => `${envId}\0${threadId}`

  /** The thread's jobs, oldest first. */
  private jobsOf(envId: string, threadId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.envId === envId && j.threadId === threadId)
  }

  runningCount(envId?: string, threadId?: string): number {
    return [...this.jobs.values()].filter(
      (j) => j.running && (!envId || j.envId === envId) && (!threadId || j.threadId === threadId)
    ).length
  }

  /** A job call from a box (macBridge.ts handle(), past the off check). */
  async handle(
    env: { id: string; name: string },
    thread: MacCallThread,
    method: MacJobPeerMethod,
    raw: unknown,
    ctx: { policy: string; deadlineAt: number; line: (decision: string) => void }
  ): Promise<unknown> {
    switch (method) {
      case 'mac.jobStart':
        if (ctx.policy === 'read') {
          ctx.line('refused (policy read)')
          throw new Error(
            "this host may read on the Mac but not run commands (the Mac's Settings → Remote access)"
          )
        }
        return this.start(env, thread, raw, ctx.deadlineAt, ctx.line)
      case 'mac.jobsEnd':
        return this.endThread(env.id, thread.id, 'thread-ended', ctx.line)
      case 'mac.jobWrite': {
        const args = MacJobWriteArgsSchema.parse(raw)
        return this.write(this.own(env.id, thread.id, args.jobId), args.dataBase64, ctx.line)
      }
      case 'mac.jobRead': {
        const args = MacJobReadArgsSchema.parse(raw)
        return this.read(
          this.own(env.id, thread.id, args.jobId),
          args.afterOffset ?? 0,
          args.waitMs ?? 0
        )
      }
      case 'mac.jobSignal': {
        const args = MacJobSignalArgsSchema.parse(raw)
        return this.signal(this.own(env.id, thread.id, args.jobId), args.signal, ctx.line)
      }
      case 'mac.jobClose': {
        const args = MacJobCloseArgsSchema.parse(raw)
        return this.close(this.own(env.id, thread.id, args.jobId), ctx.line)
      }
    }
  }

  private own(envId: string, threadId: string, jobId: string): Job {
    const job = this.jobs.get(jobId)
    if (!job || job.envId !== envId || job.threadId !== threadId)
      throw new Error(`no such job for this thread: ${jobId}`)
    this.touch(job)
    return job
  }

  private async start(
    env: { id: string; name: string },
    thread: MacCallThread,
    raw: unknown,
    deadlineAt: number,
    line: (decision: string) => void
  ): Promise<MacJobStartResult> {
    const args = MacRunArgsSchema.parse(raw)
    if (!args.argv === !args.command) throw new Error('mac.run takes argv or command, one of them')
    if (args.cwd !== undefined && !isAbsolute(args.cwd))
      throw new Error(`paths on the Mac must be absolute: ${args.cwd}`)
    const cwd = realSpelling(args.cwd ? resolve(args.cwd) : this.deps.home)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory())
      throw new Error(`no such folder on the Mac: ${cwd}`)
    if (this.runningCount(env.id, thread.id) >= MAC_JOB_MAX_PER_THREAD) {
      line('refused (job limit)')
      throw new Error(
        `this thread already has ${MAC_JOB_MAX_PER_THREAD} jobs running on the Mac: end one first (mac_job_signal)`
      )
    }
    const spec = { ...(args.argv ? { argv: args.argv } : { command: args.command }), cwd }
    const key = JSON.stringify([args.argv ?? null, args.argv ? null : (args.command ?? null), cwd])
    const memory = this.remembered.get(this.threadKey(env.id, thread.id)) ?? new Set<string>()
    const remembered = memory.has(key)
    const until = Math.min(Date.now() + MAC_APPROVAL_WAIT_MS, deadlineAt - REPLY_MARGIN_MS)
    if (until <= Date.now()) throw new Error('the call left no time to ask the Mac')
    const { id: cardId, answer } = this.deps.ask(
      {
        environmentId: env.id,
        hostName: env.name,
        sessionId: thread.id,
        threadTitle: String(thread.title ?? ''),
        kind: 'run',
        method: 'mac.run',
        ...spec,
        ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        interactive: true
      },
      until,
      remembered
    )
    const decision = await answer
    if (!decision.allow) {
      line(`job ${decision.outcome}`)
      throw new Error(
        decision.outcome === 'expired' ? 'nobody at the Mac answered in time' : 'denied at the Mac'
      )
    }
    // The limit again: another start may have been allowed while this one waited.
    if (this.runningCount(env.id, thread.id) >= MAC_JOB_MAX_PER_THREAD) {
      this.deps.finish(cardId, 'stopped')
      throw new Error(`this thread already has ${MAC_JOB_MAX_PER_THREAD} jobs running on the Mac`)
    }
    if (readRemembers(decision.remember)) {
      memory.add(key)
      this.remembered.set(this.threadKey(env.id, thread.id), memory)
    }
    const argv0 = basename(args.argv?.[0] ?? args.command?.split(/\s/)[0] ?? '')
    const [file, ...rest] = shellArgv(spec, this.deps.shell)
    let proc: JobProcess
    try {
      proc = (this.deps.spawner ?? (await loadDefaultSpawner()))({
        file,
        args: rest,
        cwd,
        env: scrubbedEnv()
      })
    } catch (err) {
      this.deps.finish(cardId, 'stopped')
      line(`job did not start (${err instanceof Error ? err.message : String(err)})`)
      throw new Error(
        `the job did not start on the Mac: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const job: Job = {
      id: `job_${randomBytes(9).toString('base64url')}`,
      envId: env.id,
      threadId: thread.id,
      cardId,
      argv0,
      proc,
      out: new RollingOutput(),
      running: true,
      stdinOpen: true,
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      idle: null,
      timeout: null,
      kill: null,
      waiters: new Set()
    }
    this.jobs.set(job.id, job)
    proc.onData((chunk) => {
      job.out.push(chunk)
      this.wake(job)
    })
    proc.onExit((code, signal) => this.exited(job, code, signal, line))
    if (args.timeoutMs) {
      job.timeout = setTimeout(() => this.end(job, 'timeout'), args.timeoutMs)
      job.timeout.unref()
    }
    this.touch(job)
    this.deps.running(cardId, () => this.end(job, 'stopped'))
    line(
      `job ${job.id} allowed (${remembered ? 'remembered' : readRemembers(decision.remember) ? 'asked, command remembered' : 'asked'}) argv0=${argv0}${proc.pty ? ' pty' : ''}`
    )
    return { jobId: job.id, pty: proc.pty }
  }

  private write(job: Job, dataBase64: string, line: (d: string) => void): MacJobWriteResult {
    if (!job.running) throw new Error(`job ${job.id} has ended`)
    if (!job.stdinOpen) throw new Error(`job ${job.id}: stdin is closed`)
    const data = Buffer.from(dataBase64, 'base64')
    if (data.length > MAC_JOB_WRITE_MAX)
      throw new Error(`too much for one write: ${data.length} bytes (at most ${MAC_JOB_WRITE_MAX})`)
    try {
      if (data.length) job.proc.write(data)
    } catch (err) {
      throw new Error(
        `job ${job.id}: the write failed (${err instanceof Error ? err.message : String(err)})`
      )
    }
    line(`job ${job.id} write ${data.length} B`)
    return { jobId: job.id, bytes: data.length }
  }

  private async read(job: Job, after: number, waitMs: number): Promise<MacJobReadResult> {
    if (waitMs > 0 && job.running && after >= job.out.total) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs)
        function done(): void {
          clearTimeout(timer)
          job.waiters.delete(done)
          resolve()
        }
        job.waiters.add(done)
      })
      this.touch(job)
    }
    const r = job.out.read(after, MAC_JOB_READ_MAX, !job.running)
    return {
      jobId: job.id,
      offset: r.offset,
      nextOffset: r.nextOffset,
      output: r.data.toString('utf8'),
      skipped: r.skipped,
      running: job.running,
      stdinOpen: job.stdinOpen,
      exitCode: job.exitCode,
      signal: job.signal,
      ...(job.ended ? { ended: job.ended } : {})
    }
  }

  private signal(job: Job, signal: MacJobSignal, line: (d: string) => void): MacJobSignalResult {
    if (job.running) this.group(job, `SIG${signal}` as NodeJS.Signals)
    line(`job ${job.id} signal ${signal}${job.running ? '' : ' (already ended)'}`)
    return { jobId: job.id, signal, running: job.running }
  }

  private close(job: Job, line: (d: string) => void): MacJobCloseResult {
    if (job.running && job.stdinOpen) job.proc.closeStdin()
    job.stdinOpen = false
    line(`job ${job.id} stdin closed`)
    return { jobId: job.id, stdinOpen: false }
  }

  private group(job: Job, sig: NodeJS.Signals): void {
    if (job.proc.kill) return job.proc.kill(sig)
    try {
      if (job.proc.pid) process.kill(-job.proc.pid, sig)
    } catch {
      try {
        if (job.proc.pid) process.kill(job.proc.pid, sig)
      } catch {
        /* gone */
      }
    }
  }

  /** The app ends a job: SIGTERM to the group, SIGKILL after the grace. */
  private end(job: Job, why: MacJobEnd): void {
    if (!job.running) return
    job.ended ??= why
    if (job.kill) return
    this.group(job, 'SIGTERM')
    job.kill = setTimeout(() => this.group(job, 'SIGKILL'), KILL_GRACE_MS)
    job.kill.unref()
  }

  private exited(
    job: Job,
    code: number | null,
    signal: string | null,
    line: (d: string) => void
  ): void {
    if (!job.running) return
    job.running = false
    job.stdinOpen = false
    job.exitCode = code
    job.signal = signal
    for (const t of [job.timeout, job.kill]) if (t) clearTimeout(t)
    job.timeout = job.kill = null
    // The shell is gone; anything it left in the group goes with it.
    try {
      if (job.proc.pid) process.kill(-job.proc.pid, 'SIGKILL')
    } catch {
      /* the group is empty */
    }
    this.deps.finish(job.cardId, job.ended || signal ? 'stopped' : 'done')
    line(`job ${job.id} ran: exit ${code ?? signal}${job.ended ? `, ended (${job.ended})` : ''}`)
    this.wake(job)
    this.prune(job.envId, job.threadId)
    if (this.jobs.has(job.id)) this.touch(job)
  }

  /** Keep at most MAC_JOB_MAX_PER_THREAD ended jobs per thread, for their last reads. */
  private prune(envId: string, threadId: string): void {
    const ended = this.jobsOf(envId, threadId).filter((j) => !j.running)
    for (const j of ended.slice(0, Math.max(0, ended.length - MAC_JOB_MAX_PER_THREAD))) this.drop(j)
  }

  private wake(job: Job): void {
    for (const w of [...job.waiters]) w()
  }

  /** Any call on a job restarts its idle clock; a running job past it is ended, an ended one forgotten. */
  private touch(job: Job): void {
    if (job.idle) clearTimeout(job.idle)
    job.idle = setTimeout(() => {
      job.idle = null
      if (job.running) {
        this.deps.log(`job ${job.id}: idle for ${Math.round(this.idleMs / 60_000)} min, ending it`)
        this.end(job, 'idle')
        this.touch(job)
      } else this.drop(job)
    }, this.idleMs)
    job.idle.unref()
  }

  private get idleMs(): number {
    return this.deps.idleMs ?? MAC_JOB_IDLE_MS
  }

  private drop(job: Job): void {
    if (job.idle) clearTimeout(job.idle)
    this.wake(job)
    this.jobs.delete(job.id)
  }

  /** Every job of one thread goes now (the thread ended on the box). */
  endThread(
    envId: string,
    threadId: string,
    why: MacJobEnd,
    line: (d: string) => void = this.deps.log
  ): MacJobsEndResult {
    const jobs = this.jobsOf(envId, threadId)
    let ended = 0
    for (const j of jobs) {
      if (j.running) {
        ended++
        this.end(j, why)
      }
      // Forgotten as soon as it is gone: nobody will read a dead thread's job.
      if (!j.running) this.drop(j)
      else j.proc.onExit(() => this.drop(j))
    }
    this.remembered.delete(this.threadKey(envId, threadId))
    if (jobs.length) line(`${ended} job(s) ended (${why})`)
    return { ended }
  }

  /** Every job of one host goes (its policy no longer allows commands). */
  endHost(envId: string, why: MacJobEnd = 'stopped'): number {
    const threads = new Set(
      [...this.jobs.values()].filter((j) => j.envId === envId).map((j) => j.threadId)
    )
    let n = 0
    for (const t of threads) n += this.endThread(envId, t, why).ended
    return n
  }

  /** The app is quitting: everything goes. */
  closeAll(): void {
    for (const j of [...this.jobs.values()]) {
      this.end(j, 'stopped')
      if (j.running) this.group(j, 'SIGKILL')
      this.drop(j)
    }
    this.remembered.clear()
  }
}
