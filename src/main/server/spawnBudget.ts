import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptions,
  type SpawnOptions
} from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * One budget for every helper process the server starts: git, gh, unzip,
 * java probes, shell PATH lookups. At most `concurrency` run at once; the
 * rest wait in line, and each gets a timeout so a hung one cannot hold a
 * slot for good. Twenty-four projects times three gh calls at once was a
 * fork storm that took the machine down; this is the wall against the next
 * one. Harness drivers and PTYs have their own lifecycles and stay outside.
 *
 * Every child also lands in a registry, budgeted or not, so the app can
 * kill them all on quit. Children are never `detached`: they stay in the
 * app's process group, so killing the group takes them too.
 */

export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_TIMEOUT_MS = 60_000

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

const children = new Set<ChildProcess>()

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
export function trackChild<T extends ChildProcess | undefined>(child: T): T {
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
  return currentBudget().run(
    () =>
      new Promise((resolve, reject) => {
        const { detached: _detached, ...rest } = options as ExecOptions & { detached?: boolean }
        const opts = { timeout: DEFAULT_TIMEOUT_MS, encoding: 'utf8', ...rest } as ExecOptions
        announce(file, args)
        const child = nodeExecFile(
          file,
          [...args],
          opts as ExecFileOptions,
          (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
            if (error) reject(Object.assign(error, { stdout, stderr }))
            else resolve({ stdout, stderr })
          }
        )
        trackChild(child)
      })
  )
}

/**
 * `execFile` for callers that need the ChildProcess (stdin, streaming) but
 * still one slot each. The callback is the slot's end; the child is tracked.
 */
export function execFileChildBudgeted(
  file: string,
  args: readonly string[],
  options: ExecOptions,
  callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void
): Promise<ChildProcess> {
  return new Promise((resolveChild) => {
    void currentBudget().run(
      () =>
        new Promise<void>((done) => {
          const { detached: _detached, ...rest } = options as ExecOptions & { detached?: boolean }
          const opts = { timeout: DEFAULT_TIMEOUT_MS, ...rest } as ExecFileOptions
          announce(file, args)
          const child = nodeExecFile(file, [...args], opts, (error, stdout, stderr) => {
            done()
            callback(error, stdout, stderr)
          })
          trackChild(child)
          resolveChild(child)
        })
    )
  })
}

/** A spawned helper that holds a slot until it exits (git fetch with progress). */
export async function spawnBudgeted(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {}
): Promise<ChildProcess> {
  const release = await currentBudget().acquire()
  const { detached: _detached, ...rest } = options
  announce(command, args)
  const child = nodeSpawn(command, [...args], rest)
  trackChild(child)
  child.once('exit', release)
  child.once('error', release)
  return child
}

/**
 * A long-lived child (language server, index warm-up) that must die with the
 * app but should not hold one of the few helper slots.
 */
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {}
): ChildProcess {
  return trackChild(nodeSpawn(command, [...args], options))
}
