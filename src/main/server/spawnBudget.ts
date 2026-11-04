import { spawn as nodeSpawn, type ChildProcess, type ExecFileException, type ExecFileOptions, type SpawnOptions } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import { BrokerChild, brokerError, ExecBroker, type BrokerOutcome } from './execBroker'
import type { BrokerSpawnOptions } from './execBrokerWire'

/**
 * One budget for every helper process the server starts: git, gh, unzip,
 * java probes, shell PATH lookups. At most `concurrency` run at once; the
 * rest wait in line, and each gets a timeout so a hung one cannot hold a
 * slot for good. Twenty-four projects times three gh calls at once was a
 * fork storm that took the machine down; this is the wall against the next
 * one. Harness drivers and PTYs have their own lifecycles and stay outside.
 *
 * None of them forks from this process: every budgeted helper (and the
 * off-budget `ps`, `ss` and `lsof` reads of the guard and the sweeps) is
 * started by the exec broker (execBroker.ts), a small process of its own,
 * because a fork of a 700 MB main process stalls its loop for 50-70 ms on
 * the box (docs/box.md "The exec broker"). Long-lived children with their
 * own stdio protocol (`spawnTracked`: a language server) and the harnesses
 * themselves still fork here.
 *
 * Every child also lands in a registry, budgeted or not, so the app can
 * kill them all on quit. Children are never `detached`: the broker's die
 * with it, and this process's stay in its group.
 */

export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_TIMEOUT_MS = 60_000
/** node's own `execFile` default. */
const DEFAULT_MAX_BUFFER = 1024 * 1024

type Waiter = () => void

export class ChildBudget {
  private active = 0
  private readonly queue: Waiter[] = []

  constructor(readonly concurrency: number = DEFAULT_CONCURRENCY) {}

  get running(): number {
    return this.active
  }

  get waiting(): number {
    return this.queue.length
  }

  /** Waits for a slot; the returned function gives it back, once. */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.active += 1
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.active -= 1
          this.queue.shift()?.()
        })
      }
      if (this.active < this.concurrency) grant()
      else this.queue.push(grant)
    })
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await work()
    } finally {
      release()
    }
  }
}

export const childBudget = new ChildBudget()

/**
 * One-shot model calls (tool summaries, titles, commit text): each boots a
 * whole CLI, and a transcript opening can ask for hundreds at once. Two at
 * a time, on their own lane so they never crowd out git.
 */
export const oneShotBudget = new ChildBudget(2)

/**
 * The review panels' `checkpoint.status` diffs and each turn's settle diff
 * (checkpointTurns.ts). Twenty open panels in a 49k-file checkout once held
 * all four shared slots for twenty minutes while the sends' `ensure` and
 * the turns' captures queued behind them; on their own lane a review diff
 * can only ever slow another review diff.
 */
export const statusBudget = new ChildBudget(2)

const budgetScope = new AsyncLocalStorage<ChildBudget>()

/** Run `fn` with every budgeted child it starts (however deep) taking a
 *  slot from `budget` instead of the shared one. */
export function withBudget<T>(budget: ChildBudget, fn: () => Promise<T>): Promise<T> {
  return budgetScope.run(budget, fn)
}

/** The budget the current async context spends from. */
export function currentBudget(): ChildBudget {
  return budgetScope.getStore() ?? childBudget
}

/** The one broker every helper goes through; startServer moves it into its own process (`install`). */
export const execBroker = new ExecBroker()

/** What the registry needs of a child, whichever process started it: node's ChildProcess and the broker's child both have it. */
export interface TrackedChild {
  exitCode: number | null
  signalCode: string | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: () => void): unknown
  once(event: 'exit', listener: () => void): unknown
}

const children = new Set<TrackedChild>()

type SpawnListener = (file: string, args: readonly string[]) => void
const spawnListeners = new Set<SpawnListener>()

/** Hear every helper the budget starts, as it starts (a proof counts git children with it). */
export function onBudgetedSpawn(listener: SpawnListener): () => void {
  spawnListeners.add(listener)
  return () => spawnListeners.delete(listener)
}

function announce(file: string, args: readonly string[]): void {
  for (const listener of spawnListeners) listener(file, args)
}

/** Remember a child until it exits so quit can kill whatever is left. */
export function trackChild<T extends TrackedChild | undefined>(child: T): T {
  if (!child || typeof child.on !== 'function') return child
  if (child.exitCode !== null || child.signalCode !== null) return child
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

export function trackedChildren(): number {
  return children.size
}

/** Kill every live helper. Synchronous on purpose: it runs from `exit` too. */
export function killTrackedChildren(signal: NodeJS.Signals = 'SIGKILL'): number {
  let killed = 0
  for (const child of [...children]) {
    try {
      if (child.kill(signal)) killed += 1
    } catch {
      // Already gone.
    }
    children.delete(child)
  }
  return killed
}

export type ExecResult<T = string> = { stdout: T; stderr: T }
export type ExecOptions = ExecFileOptions & { encoding?: BufferEncoding | 'buffer' | null }

/** The broker's options from `execFile`'s: cwd, env, timeout (the default when unset), killSignal, maxBuffer. `detached` and `shell` are dropped. */
function brokerOptions(options: ExecOptions | SpawnOptions, stdin: boolean, buffered: boolean): BrokerSpawnOptions {
  const o = options as ExecOptions & { killSignal?: NodeJS.Signals | number }
  const cwd = typeof o.cwd === 'string' ? o.cwd : o.cwd ? fileURLToPath(o.cwd) : undefined
  return {
    ...(cwd ? { cwd } : {}),
    ...(o.env ? { env: o.env as Record<string, string | undefined> } : {}),
    timeout: o.timeout ?? DEFAULT_TIMEOUT_MS,
    ...(typeof o.killSignal === 'string' ? { killSignal: o.killSignal } : {}),
    ...(buffered ? { maxBuffer: o.maxBuffer ?? DEFAULT_MAX_BUFFER } : {}),
    stdin
  }
}

const decode = (bytes: Uint8Array | undefined, encoding: ExecOptions['encoding']): string | Buffer => {
  const buf = Buffer.from(bytes ?? new Uint8Array())
  return encoding === 'buffer' || encoding === null ? buf : buf.toString(encoding ?? 'utf8')
}

/** One buffered run through the broker, resolving and rejecting as `promisify(execFile)` does. */
function execNow(file: string, args: readonly string[], options: ExecOptions): { child: BrokerChild; result: Promise<ExecResult<string | Buffer>> } {
  const encoding = options.encoding === undefined ? 'utf8' : options.encoding
  let child!: BrokerChild
  const result = new Promise<ExecResult<string | Buffer>>((resolve, reject) => {
    announce(file, args)
    child = execBroker.run(file, args, 'exec', brokerOptions(options, false, true), (outcome) => {
      const stdout = decode(outcome.stdout, encoding)
      const stderr = decode(outcome.stderr, encoding)
      if (outcome.error) reject(Object.assign(brokerError(outcome.error, [file, ...args].join(' ')), { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
    trackChild(child)
  })
  return { child, result }
}

/**
 * `promisify(execFile)` behind the budget: same resolve/reject shape (the
 * error carries `stdout`/`stderr`), utf8 unless the caller says otherwise,
 * and a default timeout. `detached` is dropped: helpers stay in our group.
 */
export function execFileBudgeted(
  file: string,
  args: readonly string[],
  options: ExecOptions & { encoding: 'buffer' }
): Promise<ExecResult<Buffer>>
export function execFileBudgeted(
  file: string,
  args: readonly string[],
  options?: ExecOptions
): Promise<ExecResult<string>>
export function execFileBudgeted(
  file: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<ExecResult<string | Buffer>> {
  return currentBudget().run(() => execNow(file, args, options).result)
}

/**
 * `execFileBudgeted` with no slot: the guard's `ps`, the sweeps' `ss` and
 * `lsof`, admission's memory read. They run every few seconds, must never
 * wait behind four git diffs, and still fork from the broker, not here.
 */
export function execFileOffBudget(
  file: string,
  args: readonly string[],
  options: ExecOptions & { encoding: 'buffer' }
): Promise<ExecResult<Buffer>>
export function execFileOffBudget(
  file: string,
  args: readonly string[],
  options?: ExecOptions
): Promise<ExecResult<string>>
export function execFileOffBudget(
  file: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<ExecResult<string | Buffer>> {
  return execNow(file, args, options).result
}

/**
 * `execFile` for callers that need the child (stdin, the pid) but still one
 * slot each. The callback is the slot's end; the child is tracked.
 */
export function execFileChildBudgeted(
  file: string,
  args: readonly string[],
  options: ExecOptions,
  callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void
): Promise<BrokerChild> {
  return new Promise((resolveChild) => {
    void currentBudget().run(
      () =>
        new Promise<void>((done) => {
          const encoding = options.encoding === undefined ? 'utf8' : options.encoding
          announce(file, args)
          const child = execBroker.run(file, args, 'exec', brokerOptions(options, true, true), (outcome: BrokerOutcome) => {
            done()
            const stdout = decode(outcome.stdout, encoding)
            const stderr = decode(outcome.stderr, encoding)
            callback(outcome.error ? (brokerError(outcome.error, [file, ...args].join(' ')) as ExecFileException) : null, stdout, stderr)
          })
          trackChild(child)
          resolveChild(child)
        })
    )
  })
}

/** A spawned helper, its output streamed, that holds a slot until it exits (git fetch with progress). */
export async function spawnBudgeted(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {}
): Promise<BrokerChild> {
  const release = await currentBudget().acquire()
  announce(command, args)
  const stdin = Array.isArray(options.stdio) ? options.stdio[0] === 'pipe' : options.stdio === 'pipe'
  const child = execBroker.run(command, args, 'spawn', { ...brokerOptions(options, stdin, false), timeout: options.timeout ?? 0 }, () => release())
  trackChild(child)
  return child
}

/**
 * A long-lived child (language server, index warm-up) that must die with the
 * app but should not hold one of the few helper slots. The one helper that
 * still forks from this process: it speaks a protocol over its stdio.
 */
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {}
): ChildProcess {
  return trackChild(nodeSpawn(command, [...args], options))
}
