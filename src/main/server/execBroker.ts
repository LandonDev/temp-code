import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { runExecBrokerChild } from './execBrokerChild'
import { brokerPair, type BrokerError, type BrokerPort, type BrokerSpawnOptions, type ChildMessage, type MainMessage } from './execBrokerWire'

/**
 * Main's side of the exec broker: every helper child the server runs (git,
 * gh, ps, ss, lsof, unzip, the java probes) is started by a small process of
 * its own over one port, never by a fork of main (execBrokerWire.ts has why).
 * `ExecBroker.run` hands back a `BrokerChild`, the subset of a ChildProcess
 * the callers use (pid, exit, kill, stdin, streamed stdout/stderr), and the
 * budget (spawnBudget.ts) tracks it like any child.
 *
 * Without a spawner (tests, the in-process proofs, a host with no Electron)
 * the broker's logic runs in this process over a synchronous pair: the same
 * code, the same semantics, a fork of main. `install(spawner)` moves it into
 * the utility process (src/main/execBrokerSpawn.ts). A child that exits is
 * respawned and the asks it held fail with EBROKER (callers retry or report,
 * as for any child that died); three exits in a minute and the broker runs
 * in this process from there on, with one log line, as the gateway does.
 */

export type BrokerMainPort = BrokerPort<ChildMessage, MainMessage>

export interface ExecBrokerLink {
  wire: BrokerMainPort
  kill(): void
  onExit(fn: (code: number | null) => void): void
}
export type SpawnExecBroker = () => ExecBrokerLink

export const EXIT_WINDOW_MS = 60_000
export const EXITS_BEFORE_FALLBACK = 3
const READY_TIMEOUT_MS = 15_000

export type BrokerMode = 'exec' | 'spawn'
export type BrokerOutcome = Extract<ChildMessage, { t: 'done' }>
type Settle = (outcome: BrokerOutcome) => void

interface LinkState {
  link: ExecBrokerLink
  calls: Map<number, BrokerChild>
  ready: boolean
  pid: number | null
  timer: NodeJS.Timeout | null
}

/** The error a failed ask carries, shaped as `execFile`'s: `code`, `signal`, `killed`, `cmd` and both streams. */
export type BrokerExecError = Error & BrokerError & { cmd: string }

export function brokerError(e: BrokerError, cmd: string): BrokerExecError {
  const { message, ...fields } = e
  return Object.assign(new Error(message), fields, { cmd })
}

/**
 * A child the broker runs, as its caller sees it: node's ChildProcess
 * surface the server uses. `stdin` is a pipe when asked for; `stdout` and
 * `stderr` stream in `spawn` mode and are null in `exec` mode (the settle
 * carries the whole output). Emits `spawn` (pid known), `exit` and `close`;
 * `error` only in spawn mode and only to a listener, as a spawn failure in
 * exec mode reaches the settle instead.
 */
export class BrokerChild extends EventEmitter {
  pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  readonly stdin: Writable | null
  readonly stdout: PassThrough | null
  readonly stderr: PassThrough | null
  private id = 0
  private link: LinkState | null = null
  private pendingKill: NodeJS.Signals | null = null
  private readonly pendingStdin: (Uint8Array | null)[] = []

  constructor(
    readonly file: string,
    readonly args: readonly string[],
    readonly mode: BrokerMode,
    private readonly opts: BrokerSpawnOptions,
    private readonly settle: Settle
  ) {
    super()
    this.stdin = opts.stdin
      ? new Writable({
          write: (chunk: Buffer, _enc, cb) => {
            this.sendStdin(new Uint8Array(chunk))
            cb()
          },
          final: (cb) => {
            this.sendStdin(null)
            cb()
          }
        })
      : null
    this.stdout = mode === 'spawn' ? new PassThrough() : null
    this.stderr = mode === 'spawn' ? new PassThrough() : null
  }

  get exited(): boolean {
    return this.exitCode !== null || this.signalCode !== null
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exited) return false
    this.killed = true
    if (this.link) this.link.link.wire.post({ t: 'kill', id: this.id, signal })
    else this.pendingKill = signal
    return true
  }

  private sendStdin(chunk: Uint8Array | null): void {
    if (this.exited) return
    if (this.link) this.link.link.wire.post({ t: 'stdin', id: this.id, chunk })
    else this.pendingStdin.push(chunk)
  }

  /** @internal The broker's link took the ask: it goes out now, with anything written or asked for meanwhile. */
  attach(link: LinkState, id: number): void {
    this.link = link
    this.id = id
    link.calls.set(id, this)
    link.link.wire.post({ t: this.mode, id, file: this.file, args: [...this.args], opts: this.opts })
    for (const chunk of this.pendingStdin.splice(0)) link.link.wire.post({ t: 'stdin', id, chunk })
    if (this.pendingKill) link.link.wire.post({ t: 'kill', id, signal: this.pendingKill })
  }

  /** @internal */
  started(pid: number | undefined): void {
    this.pid = pid
    if (pid !== undefined) this.emit('spawn')
  }

  /** @internal */
  out(fd: 1 | 2, chunk: Uint8Array): void {
    ;(fd === 1 ? this.stdout : this.stderr)?.write(Buffer.from(chunk))
  }

  /** @internal */
  done(outcome: BrokerOutcome): void {
    if (this.exited) return
    this.exitCode = outcome.code
    this.signalCode = outcome.signal
    this.link?.calls.delete(this.id)
    this.stdout?.end()
    this.stderr?.end()
    this.stdin?.destroy()
    this.settle(outcome)
    if (this.mode === 'spawn' && outcome.error && this.pid === undefined && this.listenerCount('error') > 0) {
      this.emit('error', brokerError(outcome.error, [this.file, ...this.args].join(' ')))
    }
    this.emit('exit', outcome.code, outcome.signal)
    this.emit('close', outcome.code, outcome.signal)
  }

  /** @internal The broker process died under it. */
  brokerGone(): void {
    this.done({ t: 'done', id: this.id, code: null, signal: 'SIGKILL', error: { message: 'the exec broker exited', code: 'EBROKER', signal: 'SIGKILL', killed: false } })
  }
}

export interface ExecBrokerOptions {
  now?: () => number
  log?: (line: string) => void
  readyTimeoutMs?: number
}

export class ExecBroker {
  private child: LinkState | null = null
  private local: LinkState | null = null
  private spawner: SpawnExecBroker | null = null
  private fellBack = false
  private exits: number[] = []
  private restarts = 0
  private nextId = 1
  private waiters: (() => void)[] = []
  private stopped = false
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly options: ExecBrokerOptions = {}) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.warn(line))
  }

  /** Run helpers from a process of their own from here on (startServer, with the Electron spawner). */
  install(spawner: SpawnExecBroker): void {
    this.spawner = spawner
    this.fellBack = false
    this.stopped = false
    this.exits = []
    this.spawn()
  }

  /** Where helpers fork from: the broker process (that pid, respawned `restarts` times) or this process. */
  status(): { mode: 'child' | 'in-process'; pid: number; restarts: number } {
    const child = this.spawner && !this.fellBack ? this.child : null
    return child ? { mode: 'child', pid: child.pid ?? 0, restarts: this.restarts } : { mode: 'in-process', pid: process.pid, restarts: this.restarts }
  }

  /** End the broker process; what it still ran dies with it. */
  stop(): void {
    this.stopped = true
    const child = this.child
    this.child = null
    if (child) {
      if (child.timer) clearTimeout(child.timer)
      for (const c of child.calls.values()) c.brokerGone()
      child.link.kill()
    }
  }

  /**
   * Start `file` with `args`: `exec` buffers both streams into the settle,
   * `spawn` streams them on the child. Returns at once; the ask goes out
   * when a link is ready (the broker coming up holds it, never drops it).
   */
  run(file: string, args: readonly string[], mode: BrokerMode, opts: BrokerSpawnOptions, settle: Settle): BrokerChild {
    const child = new BrokerChild(file, args, mode, opts, settle)
    const go = (): void => {
      const link = this.route()
      if (!link) {
        this.waiters.push(go)
        return
      }
      child.attach(link, this.nextId++)
    }
    go()
    return child
  }

  private route(): LinkState | null {
    if (this.spawner && !this.fellBack && !this.stopped) return this.child?.ready ? this.child : null
    return (this.local ??= this.makeLocal())
  }

  private makeLocal(): LinkState {
    const [main, child] = brokerPair<MainMessage, ChildMessage>()
    const state: LinkState = { link: { wire: main, kill: () => main.close(), onExit: () => {} }, calls: new Map(), ready: false, pid: process.pid, timer: null }
    main.onMessage((m) => this.fromChild(state, m))
    runExecBrokerChild(child, { watchMainMs: 0 })
    return state
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  private fromChild(state: LinkState, m: ChildMessage): void {
    switch (m.t) {
      case 'ready':
        state.ready = true
        state.pid = m.pid
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
        this.wake()
        return
      case 'started':
        state.calls.get(m.id)?.started(m.pid)
        return
      case 'out':
        state.calls.get(m.id)?.out(m.fd, m.chunk)
        return
      case 'done':
        state.calls.get(m.id)?.done(m)
        return
    }
  }

  private spawn(): void {
    let link: ExecBrokerLink
    try {
      link = this.spawner!()
    } catch (e) {
      this.childGone(null, `could not start (${(e as Error).message})`)
      return
    }
    const state: LinkState = { link, calls: new Map(), ready: false, pid: null, timer: null }
    this.child = state
    link.wire.onMessage((m) => this.fromChild(state, m))
    link.wire.onClose(() => this.childGone(state, 'closed its port'))
    link.onExit((code) => this.childGone(state, `exited (${code ?? 'killed'})`))
    const readyMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS
    state.timer = setTimeout(() => {
      if (state.ready) return
      this.childGone(state, `did not start in ${readyMs} ms`)
      link.kill()
    }, readyMs)
    state.timer.unref?.()
  }

  private childGone(state: LinkState | null, why: string): void {
    let pid: number | null = null
    if (state) {
      if (this.child !== state) return
      this.child = null
      pid = state.pid
      if (state.timer) clearTimeout(state.timer)
      try {
        state.link.wire.close()
      } catch {
        // already closed
      }
      for (const c of [...state.calls.values()]) c.brokerGone()
      state.calls.clear()
    }
    if (this.stopped) return
    const now = this.now()
    this.exits = [...this.exits.filter((t) => now - t < EXIT_WINDOW_MS), now]
    if (this.exits.length >= EXITS_BEFORE_FALLBACK) {
      this.fellBack = true
      this.log(`[exec] the exec broker ${why}, ${this.exits.length} times in a minute: helpers run from the main process from here on`)
      this.wake()
      return
    }
    this.restarts++
    this.log(`[exec] the exec broker${pid ? ` ${pid}` : ''} ${why}; respawning`)
    this.spawn()
  }
}
