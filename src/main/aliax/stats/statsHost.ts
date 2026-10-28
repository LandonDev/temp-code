import { emptyBundle, type StatsBundle } from '@shared/aliaxStats'
import type { IndexProgress } from './indexer'
import type { StatsReply, StatsRequest } from './statsWire'

/** A worker thread as the host drives it (node's Worker; a fake in tests). */
export interface WorkerLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  terminate(): Promise<unknown> | unknown
  unref?(): void
}

export interface StatsHostOptions {
  spawn: () => WorkerLike
  log?: (line: string) => void
}

/** How many times a worker that died is started again before Stats reads unavailable. */
export const STATS_WORKER_RESTARTS = 1

/**
 * Main's side of the stats worker (CLAUDE.md "Stats off the loop"): starts
 * it, mirrors its progress, asks it for the bundle (one ask in flight, every
 * caller meanwhile sharing it), forwards the usage samples and app events,
 * and starts it again once when it dies. A worker that cannot run leaves
 * Stats `unavailable`: the last bundle it gave, else an empty one, with the
 * reason on it; nothing of the stats ever runs on the host's loop.
 */
export class StatsHost {
  private worker: WorkerLike | null = null
  private restarts = 0
  private unavailable: string | null = null
  private ready = false
  private stopped = false
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>()
  private lastBundle: StatsBundle | null = null
  private bundleInFlight: Promise<StatsBundle> | null = null
  private last: IndexProgress = { running: false, filesDone: 0, filesTotal: 0, rows: 0 }
  private readonly log: (line: string) => void

  constructor(private readonly opts: StatsHostOptions) {
    this.log = opts.log ?? ((line) => console.log(line))
    this.start()
  }

  private start(): void {
    let worker: WorkerLike
    try {
      worker = this.opts.spawn()
    } catch (error) {
      this.down(`could not start: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.worker = worker
    // Each handler is this worker's own: a crash emits error and then exit,
    // and the exit of a worker already replaced must not put its replacement down.
    worker.on('message', (message) => {
      if (this.worker === worker) this.onMessage(message as StatsReply)
    })
    worker.on('error', (error) => this.ended(worker, `crashed: ${error.message}`))
    worker.on('exit', (code) => this.ended(worker, `exited (${code})`))
    worker.unref?.()
  }

  /** The worker is gone: its waiters hear why, and it starts again once. */
  private ended(worker: WorkerLike, why: string): void {
    if (this.stopped || this.worker !== worker) return
    this.worker = null
    this.ready = false
    for (const p of this.pending.values()) p.reject(new Error(why))
    this.pending.clear()
    if (this.restarts < STATS_WORKER_RESTARTS) {
      this.restarts++
      this.log(`[stats] worker ${why}; starting it again`)
      this.start()
    } else this.down(why)
  }

  private down(why: string): void {
    this.unavailable = why
    this.worker = null
    this.ready = false
    this.log(`[stats] worker ${why}; Stats reads unavailable`)
  }

  private onMessage(message: StatsReply): void {
    switch (message.type) {
      case 'ready':
        this.ready = true
        return
      case 'progress':
        this.last = message.progress
        return
      case 'index':
        this.last = message.progress
        this.answer(message.id, message.progress)
        return
      case 'bundle':
        this.lastBundle = message.bundle
        this.answer(message.id, message.bundle)
        return
      case 'error': {
        if (message.id === undefined) {
          this.log(`[stats] worker: ${message.message}`)
          return
        }
        const p = this.pending.get(message.id)
        this.pending.delete(message.id)
        p?.reject(new Error(message.message))
        return
      }
    }
  }

  private answer(id: number, value: unknown): void {
    const p = this.pending.get(id)
    this.pending.delete(id)
    p?.resolve(value as never)
  }

  private ask<T>(request: Omit<Extract<StatsRequest, { id: number }>, 'id'>): Promise<T> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error(this.unavailable ?? 'the stats worker is down'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject })
      worker.postMessage({ ...request, id })
    })
  }

  /** Index everything new; the worker joins a pass already running. */
  index(): Promise<IndexProgress> {
    return this.ask<IndexProgress>({ type: 'index' })
  }

  reindex(): Promise<IndexProgress> {
    return this.ask<IndexProgress>({ type: 'reindex' })
  }

  /** The page's bundle: one ask in flight at a time, every caller meanwhile
   *  sharing it; a worker gone answers the last bundle it gave, else an
   *  empty one, saying why. */
  bundle(): Promise<StatsBundle> {
    if (!this.worker) return Promise.resolve(this.fallback())
    return (this.bundleInFlight ??= this.ask<StatsBundle>({ type: 'bundle' })
      .catch((error: unknown) => this.fallback(error instanceof Error ? error.message : undefined))
      .finally(() => {
        this.bundleInFlight = null
      }))
  }

  /** The last bundle the worker gave, else an empty one, saying why this one could not be asked for. */
  private fallback(why?: string): StatsBundle {
    const unavailable = why ?? this.unavailable ?? 'the stats worker is down'
    return { ...(this.lastBundle ?? emptyBundle()), unavailable }
  }

  /** A live usage reading for the store; nothing waits on it. */
  sample(service: string, account: string, label: string, usedPercent: number, resetsAt?: number, periodMs?: number): void {
    this.worker?.postMessage({ type: 'sample', service, account, label, usedPercent, resetsAt, periodMs } satisfies StatsRequest)
  }

  appEvent(kind: string, service?: string, account?: string, detail?: string): void {
    this.worker?.postMessage({ type: 'appEvent', kind, service, account, detail } satisfies StatsRequest)
  }

  progress(): IndexProgress {
    return { ...this.last }
  }

  status(): { ready: boolean; restarts: number; unavailable: string | null } {
    return { ready: this.ready, restarts: this.restarts, unavailable: this.unavailable }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
  }
}
