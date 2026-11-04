/**
 * What main and the exec broker say to each other (execBroker.ts in main,
 * execBrokerChild.ts in the broker's process). Main never forks a helper
 * itself: a fork copies the parent's page tables, and from a 700 MB main
 * process with 3,600 mappings that is 50-70 ms of stalled event loop per
 * child on the box, dozens of times a minute (docs/box.md "The exec
 * broker"). The broker is a small process whose forks cost 2-3 ms. Every
 * message crosses by structured clone, so it is plain data: bytes as
 * Uint8Array, errors as their fields.
 */

/** The options a helper child is started with; what `execFile` and `spawn` honour, flattened. */
export interface BrokerSpawnOptions {
  cwd?: string
  /** The whole environment; absent, the broker's own (main's at its start). */
  env?: Record<string, string | undefined>
  /** Kill with `killSignal` after this long. */
  timeout?: number
  killSignal?: NodeJS.Signals
  /** Buffered mode only: past this many bytes on a stream, the child is killed and the ask fails. */
  maxBuffer?: number
  /** Main will write the child's stdin (a pipe); else it reads EOF at once. */
  stdin?: boolean
}

export type MainMessage =
  /** Run and buffer: one `done` with both streams whole. */
  | { t: 'exec'; id: number; file: string; args: string[]; opts: BrokerSpawnOptions }
  /** Run and stream: `out` per chunk, then `done`. */
  | { t: 'spawn'; id: number; file: string; args: string[]; opts: BrokerSpawnOptions }
  /** A chunk for the child's stdin; null ends it. */
  | { t: 'stdin'; id: number; chunk: Uint8Array | null }
  | { t: 'kill'; id: number; signal: NodeJS.Signals }

/** A failure, as `execFile`'s error carries it: the exit, the signal, our own kill, or a spawn error's errno fields. */
export interface BrokerError {
  message: string
  code?: string | number | null
  signal?: NodeJS.Signals | null
  killed?: boolean
  errno?: number
  syscall?: string
  path?: string
}

export type ChildMessage =
  | { t: 'ready'; pid: number }
  /** The child is running (node's `spawn` event); pid undefined when it never started. */
  | { t: 'started'; id: number; pid: number | undefined }
  | { t: 'out'; id: number; fd: 1 | 2; chunk: Uint8Array }
  | { t: 'done'; id: number; code: number | null; signal: NodeJS.Signals | null; stdout?: Uint8Array; stderr?: Uint8Array; error?: BrokerError }

/** One end of the link, whatever carries it: Electron's MessagePortMain, or a pair in one process. */
export interface BrokerPort<In, Out> {
  post(message: Out): void
  onMessage(fn: (message: In) => void): void
  onClose(fn: () => void): void
  close(): void
}

/** Electron's MessagePortMain as the adapter needs it: a message arrives as `{ data }`. */
export interface BrokerPortLike {
  postMessage(message: unknown): void
  on(event: 'message', fn: (e: { data: unknown }) => void): unknown
  on(event: 'close', fn: () => void): unknown
  start(): void
  close(): void
}

export function brokerPort<In, Out>(port: BrokerPortLike): BrokerPort<In, Out> {
  const wire: BrokerPort<In, Out> = {
    post: (message) => port.postMessage(message),
    onMessage: (fn) => void port.on('message', (e) => fn(e.data as In)),
    onClose: (fn) => void port.on('close', fn),
    close: () => port.close()
  }
  port.start()
  return wire
}

/**
 * Two ends in one process, delivered synchronously (a kill sent from an
 * `exit` handler still lands) and held until the other end listens. The
 * in-process broker (tests, the proofs, the fallback after the child died
 * three times in a minute) runs over this.
 */
export function brokerPair<A, B>(): [BrokerPort<B, A>, BrokerPort<A, B>] {
  class End<In, Out> implements BrokerPort<In, Out> {
    peer!: End<Out, In>
    private handler: ((m: In) => void) | null = null
    private closeFn: (() => void) | null = null
    private readonly held: In[] = []
    private open = true
    post(m: Out): void {
      if (this.open) this.peer.deliver(m)
    }
    onMessage(fn: (m: In) => void): void {
      this.handler = fn
      for (const m of this.held.splice(0)) fn(m)
    }
    onClose(fn: () => void): void {
      this.closeFn = fn
    }
    close(): void {
      if (!this.open) return
      this.open = false
      this.peer.closed()
    }
    deliver(m: In): void {
      if (!this.open) return
      if (this.handler) this.handler(m)
      else this.held.push(m)
    }
    closed(): void {
      if (!this.open) return
      this.open = false
      this.closeFn?.()
    }
  }
  const a = new End<B, A>()
  const b = new End<A, B>()
  a.peer = b
  b.peer = a
  return [a, b]
}
